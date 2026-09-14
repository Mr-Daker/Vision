/**
 * Pure session and participant policy (roadmap V009).
 *
 * These functions are deliberately free of storage, HTTP, and clock access so
 * the rules can be tested directly. `now` is always passed in, which is what
 * makes expiry testable without waiting.
 */

import type { IsoTimestamp } from "@vision/contracts";
import type { Participant, Session, SessionRevocationReason } from "./entities.ts";

export type SessionState = "active" | "expired" | "revoked";

/**
 * Revocation wins over expiry: a session revoked before its natural expiry is
 * reported as revoked, because the reason matters for audit (V005 §3).
 */
export const sessionState = (session: Session, now: IsoTimestamp): SessionState => {
  if (session.revoked_at !== undefined) {
    return "revoked";
  }
  return Date.parse(session.expires_at) <= Date.parse(now) ? "expired" : "active";
};

export const isSessionUsable = (session: Session, now: IsoTimestamp): boolean =>
  sessionState(session, now) === "active";

/**
 * A participant is eligible to act when it exists and has not been tombstoned
 * by a deletion request. Session state is intentionally not consulted here:
 * that is the caller's separate check, and conflating the two is the mistake
 * this split exists to prevent (V003 policy `identity_session_separation`).
 */
export const isParticipantEligible = (participant: Participant): boolean =>
  participant.tombstoned_at === undefined;

/**
 * Applies revocation to a session record. Returns the same object when the
 * session is already revoked, so repeated logout is idempotent and never
 * overwrites the original reason or timestamp.
 */
export const revokeSession = (
  session: Session,
  reason: SessionRevocationReason,
  now: IsoTimestamp,
): Session =>
  session.revoked_at !== undefined
    ? session
    : {
        ...session,
        revoked_at: now,
        revocation_reason: reason,
        current_version: session.current_version + 1,
      };

/**
 * Rotation issues a new session and revokes the old one. Rotation must never
 * be expressed as "mutate the token on the existing row", because the old
 * credential's revocation has to remain visible in history.
 */
export const rotationRevocationReason: SessionRevocationReason = "logout";
