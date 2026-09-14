/**
 * Domain entity shapes needed by the identity and session work (roadmap V009).
 *
 * This is the V009-relevant subset of the V003 domain contract, not the whole
 * dictionary. Submission, evidence, matching, issue and participation shapes
 * arrive with their own tasks (V012–V014) rather than being guessed here.
 *
 * Import direction (V006 §9): domain imports contracts only.
 */

import type { IsoTimestamp, Uuid } from "@vision/contracts";

/**
 * Stable pseudonymous application identity. Deliberately holds no provider
 * subject, no credential, and no session state (V003 Participant).
 */
export type Participant = {
  readonly participant_id: Uuid;
  readonly created_at: IsoTimestamp;
  readonly tombstoned_at?: IsoTimestamp;
};

export type SessionRevocationReason = "logout" | "admin_revocation" | "security_incident";

/**
 * One revocable login session. `token_hash` is the only representation of the
 * session credential that is ever stored (V003 Session, V005 §2).
 */
export type Session = {
  readonly session_id: Uuid;
  readonly participant_id: Uuid;
  readonly token_hash: string;
  readonly issued_at: IsoTimestamp;
  readonly expires_at: IsoTimestamp;
  readonly revoked_at?: IsoTimestamp;
  readonly revocation_reason?: SessionRevocationReason;
  readonly current_version: number;
};

/**
 * Restricted mapping from a provider subject to a participant. The raw provider
 * reference is never stored here — only a keyed hash — and this record never
 * leaves the identity service boundary (V003 IdentityMapping, V006 §4).
 */
export type IdentityMapping = {
  readonly identity_mapping_id: Uuid;
  readonly participant_id: Uuid;
  readonly provider: string;
  readonly provider_subject_hash: string;
  readonly provider_mode: "simulated" | "real";
  readonly created_at: IsoTimestamp;
  readonly disabled_at?: IsoTimestamp;
  readonly erased_at?: IsoTimestamp;
};
