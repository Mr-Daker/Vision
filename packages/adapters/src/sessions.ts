/**
 * Session service (roadmap V009).
 *
 * Real application sessions: issuance, expiry, rotation, logout, and
 * revocation. Session state never touches the participant record, which is the
 * separation V003's `identity_session_separation` policy requires.
 *
 * The session credential is stored only as an HMAC hash. The cookie value is
 * `<session_id>.<token>`; the server looks the row up by id and then compares
 * the token hash in constant time.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { newUuid, nowIso, parseUuid, type IsoTimestamp, type Uuid } from "@vision/contracts";
import {
  isParticipantEligible,
  isSessionUsable,
  revokeSession,
  sessionState,
  type Participant,
  type Session,
  type SessionRevocationReason,
} from "@vision/domain";

import {
  OptimisticConcurrencyError,
  type ParticipantRepository,
  type SessionRepository,
} from "./ports.ts";

export type IssuedSession = {
  readonly session: Session;
  /** Opaque cookie value. Never stored, never logged (V005 §8). */
  readonly cookieValue: string;
};

export type SessionRejectionReason =
  | "malformed_cookie"
  | "session_not_found"
  | "session_expired"
  | "session_revoked"
  | "token_mismatch"
  | "participant_ineligible";

export type SessionValidation =
  | { readonly ok: true; readonly session: Session; readonly participant: Participant }
  | { readonly ok: false; readonly reason: SessionRejectionReason };

export type SessionServiceOptions = {
  readonly tokenHmacKey: string;
  readonly ttlSeconds: number;
};

export class SessionIssuanceError extends Error {
  constructor() {
    super("cannot issue a session for a missing or ineligible participant");
    this.name = "SessionIssuanceError";
  }
}

export class SessionService {
  private readonly tokenHmacKey: string;
  private readonly ttlSeconds: number;
  private readonly sessions: SessionRepository;
  private readonly participants: ParticipantRepository;
  private readonly clock: () => IsoTimestamp;

  constructor(
    sessions: SessionRepository,
    participants: ParticipantRepository,
    options: SessionServiceOptions,
    clock: () => IsoTimestamp = nowIso,
  ) {
    this.sessions = sessions;
    this.participants = participants;
    this.clock = clock;
    if (options.tokenHmacKey.length === 0) {
      throw new Error("SESSION_TOKEN_HMAC_KEY must be configured");
    }
    if (options.ttlSeconds <= 0) {
      throw new Error("SESSION_TTL_SECONDS must be positive");
    }
    this.tokenHmacKey = options.tokenHmacKey;
    this.ttlSeconds = options.ttlSeconds;
  }

  private hashToken(token: string): string {
    return createHmac("sha256", this.tokenHmacKey).update(token).digest("hex");
  }

  async issue(participantId: Uuid): Promise<IssuedSession> {
    const participant = await this.participants.findById(participantId);
    if (participant === undefined || !isParticipantEligible(participant)) {
      throw new SessionIssuanceError();
    }

    const issuedAt = this.clock();
    const expiresAt = new Date(
      Date.parse(issuedAt) + this.ttlSeconds * 1000,
    ).toISOString() as IsoTimestamp;

    const token = randomBytes(32).toString("base64url");
    const sessionId = newUuid();

    const session = await this.sessions.create({
      session_id: sessionId,
      participant_id: participantId,
      token_hash: this.hashToken(token),
      issued_at: issuedAt,
      expires_at: expiresAt,
      current_version: 1,
    });

    return { session, cookieValue: `${sessionId}.${token}` };
  }

  /**
   * Validates a cookie value. Every failure mode is a distinct reason so the
   * API can respond correctly without leaking which part failed to the client.
   */
  async validate(cookieValue: string | undefined): Promise<SessionValidation> {
    if (cookieValue === undefined) {
      return { ok: false, reason: "malformed_cookie" };
    }

    const separator = cookieValue.indexOf(".");
    if (separator <= 0 || separator === cookieValue.length - 1) {
      return { ok: false, reason: "malformed_cookie" };
    }

    const rawSessionId = cookieValue.slice(0, separator);
    const token = cookieValue.slice(separator + 1);

    const parsedId = parseUuid(rawSessionId, "session_id");
    if (!parsedId.ok) {
      return { ok: false, reason: "malformed_cookie" };
    }

    const session = await this.sessions.findById(parsedId.value);
    if (session === undefined) {
      return { ok: false, reason: "session_not_found" };
    }

    // Compare the token before reporting expiry/revocation, so an attacker
    // holding only a session id cannot probe session state.
    const presented = Buffer.from(this.hashToken(token), "utf8");
    const stored = Buffer.from(session.token_hash, "utf8");
    if (presented.length !== stored.length || !timingSafeEqual(presented, stored)) {
      return { ok: false, reason: "token_mismatch" };
    }

    const now = this.clock();
    if (!isSessionUsable(session, now)) {
      return {
        ok: false,
        reason: sessionState(session, now) === "revoked" ? "session_revoked" : "session_expired",
      };
    }

    const participant = await this.participants.findById(session.participant_id);
    if (participant === undefined || !isParticipantEligible(participant)) {
      return { ok: false, reason: "participant_ineligible" };
    }

    return { ok: true, session, participant };
  }

  /** Logout. Idempotent: revoking an already-revoked session is a no-op. */
  async revoke(sessionId: Uuid, reason: SessionRevocationReason): Promise<Session | undefined> {
    const session = await this.sessions.findById(sessionId);
    if (session === undefined) {
      return undefined;
    }
    const revoked = revokeSession(session, reason, this.clock());
    if (revoked === session) {
      return session;
    }
    try {
      return await this.sessions.update(revoked, session.current_version);
    } catch (error) {
      if (!(error instanceof OptimisticConcurrencyError)) {
        throw error;
      }

      // Another request won the compare-and-swap. Preserve its original
      // revocation timestamp/reason rather than treating an idempotent replay
      // as an internal failure.
      const current = await this.sessions.findById(sessionId);
      return current?.revoked_at === undefined ? undefined : current;
    }
  }

  /**
   * Rotation issues a new session and revokes the old one, so the previous
   * credential stops working immediately and its revocation stays in history.
   */
  async rotate(cookieValue: string | undefined): Promise<IssuedSession | undefined> {
    const validation = await this.validate(cookieValue);
    if (!validation.ok) {
      return undefined;
    }

    // Consume the old credential with an optimistic compare-and-swap before
    // issuing its replacement. If two rotations race, exactly one can revoke
    // the observed version and therefore exactly one can mint a new session.
    const revoked = revokeSession(validation.session, "logout", this.clock());
    try {
      await this.sessions.update(revoked, validation.session.current_version);
    } catch (error) {
      if (error instanceof OptimisticConcurrencyError) {
        return undefined;
      }
      throw error;
    }

    return this.issue(validation.session.participant_id);
  }

  async revokeAllForParticipant(
    participantId: Uuid,
    reason: SessionRevocationReason,
  ): Promise<number> {
    const active = await this.sessions.findActiveByParticipant(participantId);
    let revoked = 0;
    for (const session of active) {
      await this.revoke(session.session_id, reason);
      revoked += 1;
    }
    return revoked;
  }
}

// ---------------------------------------------------------------------------
// CSRF (double-submit) — used by the HTTP adapter in apps/api
// ---------------------------------------------------------------------------

/**
 * Issues a CSRF token for the double-submit pattern. Unlike the session token
 * this value is readable by the client, because the client must echo it back
 * in a request header.
 */
export const newCsrfToken = (): string => randomBytes(32).toString("base64url");

export const csrfTokenMatches = (
  cookieToken: string | undefined,
  headerToken: string | undefined,
): boolean => {
  if (cookieToken === undefined || headerToken === undefined) {
    return false;
  }
  const a = Buffer.from(cookieToken, "utf8");
  const b = Buffer.from(headerToken, "utf8");
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
};
