/**
 * PostgreSQL implementations of the V009 identity and session ports.
 *
 * V009 deliberately shipped in-memory implementations because the schema did
 * not exist yet (V012) and neither did the local stack (V013). Both now do, and
 * V018 exposed why these are no longer optional: a submission row carries a
 * foreign key to `participant`, so a participant that exists only in process
 * memory cannot own a report. The in-memory versions remain useful for fast
 * unit tests; these are what the running API uses.
 *
 * Written against the same ports, so nothing in `IdentityService` or
 * `SessionService` changes — which is what those ports were for.
 */

import type {
  IdentityMapping,
  Participant,
  Session,
  SessionRevocationReason,
} from "@vision/domain";
import type { IsoTimestamp, Uuid } from "@vision/contracts";

import {
  OptimisticConcurrencyError,
  UniqueConstraintViolation,
  type IdentityMappingRepository,
  type ParticipantRepository,
  type SessionRepository,
} from "./ports.ts";
import type { Queryable } from "./outbox.ts";

const iso = (value: unknown): IsoTimestamp => new Date(String(value)).toISOString() as IsoTimestamp;

/** Postgres reports a unique violation as SQLSTATE 23505. */
const isUniqueViolation = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: string }).code === "23505";

const constraintName = (error: unknown, fallback: string): string =>
  typeof error === "object" && error !== null
    ? ((error as { constraint?: string }).constraint ?? fallback)
    : fallback;

export class PostgresParticipantRepository implements ParticipantRepository {
  private readonly db: Queryable;

  constructor(db: Queryable) {
    this.db = db;
  }

  async create(participant: Participant): Promise<Participant> {
    try {
      await this.db.query(
        `insert into participant (participant_id, created_at, tombstoned_at)
         values ($1, $2, $3)`,
        [participant.participant_id, participant.created_at, participant.tombstoned_at ?? null],
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new UniqueConstraintViolation(constraintName(error, "participant_pkey"));
      }
      throw error;
    }
    return participant;
  }

  async findById(participantId: Uuid): Promise<Participant | undefined> {
    const { rows } = await this.db.query(
      "select participant_id, created_at, tombstoned_at from participant where participant_id = $1",
      [participantId],
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    return {
      participant_id: String(row["participant_id"]) as Uuid,
      created_at: iso(row["created_at"]),
      ...(row["tombstoned_at"] === null ? {} : { tombstoned_at: iso(row["tombstoned_at"]) }),
    };
  }
}

export class PostgresIdentityMappingRepository implements IdentityMappingRepository {
  private readonly db: Queryable;

  constructor(db: Queryable) {
    this.db = db;
  }

  async create(mapping: IdentityMapping): Promise<IdentityMapping> {
    try {
      await this.db.query(
        `insert into identity_mapping (
           identity_mapping_id, participant_id, provider, provider_subject_hash,
           provider_mode, created_at, disabled_at, erased_at
         ) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          mapping.identity_mapping_id,
          mapping.participant_id,
          mapping.provider,
          mapping.provider_subject_hash,
          mapping.provider_mode,
          mapping.created_at,
          mapping.disabled_at ?? null,
          mapping.erased_at ?? null,
        ],
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new UniqueConstraintViolation(
          constraintName(error, "identity_mapping_provider_subject_uniq"),
        );
      }
      throw error;
    }
    return mapping;
  }

  async findByProviderSubject(
    provider: string,
    providerSubjectHash: string,
  ): Promise<IdentityMapping | undefined> {
    const { rows } = await this.db.query(
      `select identity_mapping_id, participant_id, provider, provider_subject_hash,
              provider_mode, created_at, disabled_at, erased_at
         from identity_mapping
        where provider = $1 and provider_subject_hash = $2`,
      [provider, providerSubjectHash],
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    return {
      identity_mapping_id: String(row["identity_mapping_id"]) as Uuid,
      participant_id: String(row["participant_id"]) as Uuid,
      provider: String(row["provider"]),
      provider_subject_hash: String(row["provider_subject_hash"]),
      provider_mode: String(row["provider_mode"]) === "real" ? "real" : "simulated",
      created_at: iso(row["created_at"]),
      ...(row["disabled_at"] === null ? {} : { disabled_at: iso(row["disabled_at"]) }),
      ...(row["erased_at"] === null ? {} : { erased_at: iso(row["erased_at"]) }),
    };
  }
}

const sessionFrom = (row: Record<string, unknown>): Session => ({
  session_id: String(row["session_id"]) as Uuid,
  participant_id: String(row["participant_id"]) as Uuid,
  token_hash: String(row["token_hash"]),
  issued_at: iso(row["issued_at"]),
  expires_at: iso(row["expires_at"]),
  ...(row["revoked_at"] === null ? {} : { revoked_at: iso(row["revoked_at"]) }),
  ...(row["revocation_reason"] === null
    ? {}
    : { revocation_reason: String(row["revocation_reason"]) as SessionRevocationReason }),
  current_version: Number(row["current_version"]),
});

export class PostgresSessionRepository implements SessionRepository {
  private readonly db: Queryable;

  constructor(db: Queryable) {
    this.db = db;
  }

  async create(session: Session): Promise<Session> {
    try {
      await this.db.query(
        `insert into app_session (
           session_id, participant_id, token_hash, issued_at, expires_at,
           revoked_at, revocation_reason, current_version
         ) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          session.session_id,
          session.participant_id,
          session.token_hash,
          session.issued_at,
          session.expires_at,
          session.revoked_at ?? null,
          session.revocation_reason ?? null,
          session.current_version,
        ],
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new UniqueConstraintViolation(constraintName(error, "app_session_pkey"));
      }
      throw error;
    }
    return session;
  }

  async findById(sessionId: Uuid): Promise<Session | undefined> {
    const { rows } = await this.db.query(
      `select session_id, participant_id, token_hash, issued_at, expires_at,
              revoked_at, revocation_reason, current_version
         from app_session where session_id = $1`,
      [sessionId],
    );
    const row = rows[0];
    return row === undefined ? undefined : sessionFrom(row);
  }

  /**
   * Compare-and-swap on `current_version`. A stale writer updates no rows and
   * gets `OptimisticConcurrencyError`, which is how concurrent revocation and
   * rotation stay safe (V009 §6a).
   */
  async update(session: Session, expectedVersion: number): Promise<Session> {
    const { rowCount } = await this.db.query(
      `update app_session
          set token_hash = $3, issued_at = $4, expires_at = $5, revoked_at = $6,
              revocation_reason = $7, current_version = $8
        where session_id = $1 and current_version = $2`,
      [
        session.session_id,
        expectedVersion,
        session.token_hash,
        session.issued_at,
        session.expires_at,
        session.revoked_at ?? null,
        session.revocation_reason ?? null,
        session.current_version,
      ],
    );

    if ((rowCount ?? 0) === 0) {
      const current = await this.findById(session.session_id);
      if (current === undefined) {
        throw new Error(`session not found: ${session.session_id}`);
      }
      throw new OptimisticConcurrencyError(session.session_id);
    }
    return session;
  }

  async findActiveByParticipant(participantId: Uuid): Promise<readonly Session[]> {
    const { rows } = await this.db.query(
      `select session_id, participant_id, token_hash, issued_at, expires_at,
              revoked_at, revocation_reason, current_version
         from app_session
        where participant_id = $1 and revoked_at is null`,
      [participantId],
    );
    return rows.map(sessionFrom);
  }
}
