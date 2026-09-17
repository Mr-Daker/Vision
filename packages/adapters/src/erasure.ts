/**
 * Acting on a deletion request (roadmap V044, V005 §8).
 *
 * What erasure removes and what it deliberately keeps are two separate
 * decisions, and getting the second one wrong is the more common mistake.
 *
 * **Removed**: everything that could identify the person or reconstruct what
 * they sent — the keyed identity digest, the precise location of every
 * submission, and the content of every piece of evidence they contributed,
 * including its object references, fingerprints, capture metadata and
 * transcripts. Their sessions are revoked so the account cannot be used again.
 *
 * **Kept**: the rows themselves, as tombstones, and every count they
 * contributed to. This is not a compromise. V029's unique-contribution counts
 * exist so that "fourteen people reported this" cannot be inflated; if erasure
 * deleted participation rows, every deletion request would quietly reduce a
 * public number and the count would stop meaning what it says. The tombstone
 * keeps the arithmetic honest while holding nothing about the person.
 *
 * **Not stored at all**: the requester's own words. The request records a
 * reason *code* from a closed list, never free text — a free-text field is
 * exactly where somebody types the phone number they want removed, and it
 * would land in an event payload the V044 audit then has to find.
 */

import { randomUUID } from "node:crypto";

import type { Queryable } from "./outbox.ts";

export class ErasureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ErasureError";
  }
}

/**
 * Why an erasure was requested.
 *
 * A closed list rather than free text, so nothing a person types about
 * themselves is stored in the record of their asking not to be stored.
 */
export type ErasureReasonCode =
  "participant_request" | "consent_withdrawn" | "demonstration_cleanup";

export const ERASURE_REASON_CODES: readonly ErasureReasonCode[] = [
  "participant_request",
  "consent_withdrawn",
  "demonstration_cleanup",
];

export type ErasureResult = {
  readonly participantId: string;
  readonly identityMappingsErased: number;
  readonly submissionsErased: number;
  readonly evidenceErased: number;
  readonly sessionsRevoked: number;
  /** Participation rows kept, so counts stay true. Never deleted. */
  readonly participationKept: number;
  readonly alreadyErased: boolean;
};

/**
 * Erases one participant's identifying and contributed content.
 *
 * Idempotent: a repeated request finds the tombstones already in place and
 * reports `alreadyErased` rather than failing. Somebody asking twice is asking
 * the same thing, and an error would read as a refusal.
 */
export const eraseParticipant = async (
  tx: Queryable,
  options: {
    readonly participantId: string;
    readonly reasonCode: ErasureReasonCode;
    readonly asOf: Date;
  },
): Promise<ErasureResult> => {
  if (!ERASURE_REASON_CODES.includes(options.reasonCode)) {
    throw new ErasureError(`'${options.reasonCode}' is not a recorded erasure reason`);
  }

  const { rows: existing } = await tx.query(
    "select participant_id, tombstoned_at from participant where participant_id = $1",
    [options.participantId],
  );
  if (existing[0] === undefined) throw new ErasureError("no such participant");
  const alreadyErased =
    existing[0]["tombstoned_at"] !== null && existing[0]["tombstoned_at"] !== undefined;

  const at = options.asOf.toISOString();
  await tx.query("begin");
  try {
    await tx.query(
      "update participant set tombstoned_at = coalesce(tombstoned_at, $2::timestamptz) where participant_id = $1",
      [options.participantId, at],
    );

    // The digest goes; the row stays as a non-content tombstone so a second
    // login with the same credential cannot silently create a new participant
    // beside the erased one.
    const identity = await tx.query(
      `update identity_mapping
          set provider_subject_hash = null, erased_at = coalesce(erased_at, $2::timestamptz),
              disabled_at = coalesce(disabled_at, $2::timestamptz)
        where participant_id = $1 and provider_subject_hash is not null
        returning identity_mapping_id`,
      [options.participantId, at],
    );

    // Evidence first: its rows reference submissions, and clearing content
    // before the submission's location keeps every intermediate state legal.
    const evidence = await tx.query(
      `update evidence_item e
          set privacy_state = 'erased', erased_at = $2::timestamptz,
              object_reference = null, content_text = null, fingerprint_hash = null,
              perceptual_hash = null, capture_metadata = null,
              transcript_text = null, transcript_provenance = null,
              derivative_reference = null,
              current_version = e.current_version + 1
        from submission s
       where s.submission_id = e.submission_id
         and s.participant_id = $1
         and e.privacy_state = 'active'
       returning e.evidence_id`,
      [options.participantId, at],
    );

    const submissions = await tx.query(
      `update submission
          set privacy_state = 'erased', erased_at = $2::timestamptz,
              observed_location = null, observed_accuracy_m = null,
              observed_location_source = null, language_hint = null,
              current_version = current_version + 1
        where participant_id = $1 and privacy_state = 'active'
        returning submission_id`,
      [options.participantId, at],
    );

    const sessions = await tx.query(
      `update app_session set revoked_at = coalesce(revoked_at, $2::timestamptz),
              revocation_reason = coalesce(revocation_reason, 'erasure')
        where participant_id = $1 and revoked_at is null
        returning session_id`,
      [options.participantId, at],
    );

    const participation = await tx.query(
      "select count(*)::int as n from issue_participation where participant_id = $1",
      [options.participantId],
    );

    // The record of the request. Counts only, and a reason code: a free-text
    // field here is where somebody types the number they want removed.
    const version = await tx.query(
      `select coalesce(max(aggregate_version), 0) + 1 as next from status_event
        where aggregate_type = 'participant' and aggregate_id = $1`,
      [options.participantId],
    );
    await tx.query(
      `insert into status_event
         (event_id, aggregate_type, aggregate_id, aggregate_version, event_type,
          actor_type, correlation_id, occurred_at, payload_schema_version, payload)
       values ($1,'participant',$2,$3,'participant_erased','citizen',$4,$5::timestamptz,
               '1.0.0',$6::jsonb)`,
      [
        randomUUID(),
        options.participantId,
        Number(version.rows[0]?.["next"] ?? 1),
        randomUUID(),
        at,
        JSON.stringify({
          reason_code: options.reasonCode,
          identity_mappings_erased: identity.rows.length,
          submissions_erased: submissions.rows.length,
          evidence_erased: evidence.rows.length,
          sessions_revoked: sessions.rows.length,
          participation_kept: Number(participation.rows[0]?.["n"] ?? 0),
          // Said in the record itself, because the record outlives this file.
          counts_preserved:
            "participation rows are kept so unique-contribution counts stay true; they hold no content",
        }),
      ],
    );

    await tx.query("commit");
    return {
      participantId: options.participantId,
      identityMappingsErased: identity.rows.length,
      submissionsErased: submissions.rows.length,
      evidenceErased: evidence.rows.length,
      sessionsRevoked: sessions.rows.length,
      participationKept: Number(participation.rows[0]?.["n"] ?? 0),
      alreadyErased,
    };
  } catch (error) {
    await tx.query("rollback").catch(() => undefined);
    throw error;
  }
};
