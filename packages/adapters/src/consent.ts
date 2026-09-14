/**
 * Recording processing consent (closes a gap the V029 wiring exposed).
 *
 * Connecting V014's eligibility rules revealed that **nothing in the system
 * ever wrote a `consent_record`**. The rule requires `demo_processing`
 * consent, so with no record every contribution would be recorded-but-not-
 * counted and the demo would report zero contributors — correct by the rule,
 * and useless.
 *
 * V001's acceptance criteria do list versioned consent in the citizen flow, so
 * this was a missing piece rather than a change of policy. It belongs at
 * submission, which is where the citizen has just been shown the notice.
 *
 * Two rules the V003 contract sets and this enforces:
 *
 *  - an **optional** purpose is never inferred from a general grant, so the
 *    caller must list every purpose explicitly and the optional ones are
 *    refused unless named;
 *  - a grant is **append-only**: re-submitting with the same notice version
 *    reuses the existing record rather than writing a second one, because two
 *    grant rows would make "when did they agree?" ambiguous.
 */

import { randomUUID } from "node:crypto";

import type { Queryable } from "./outbox.ts";

export class ConsentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConsentError";
  }
}

/** The purposes the schema permits. Anything else is a caller error, not a new purpose. */
export const KNOWN_CONSENT_PURPOSES = [
  "demo_processing",
  "public_derivative",
  "gemini_classification",
  "gemini_voice_transcription",
] as const;

export type ConsentPurpose = (typeof KNOWN_CONSENT_PURPOSES)[number];

export type ConsentGrant = {
  readonly participantId: string;
  /** The exact notice the citizen was shown. A grant without one is unattributable. */
  readonly noticeVersion: string;
  readonly noticeLocale: string;
  readonly grantedPurposes: readonly string[];
};

export type ConsentResult = {
  readonly consentId: string;
  /** False when an active grant for this notice version already existed. */
  readonly created: boolean;
};

export const recordConsent = async (tx: Queryable, grant: ConsentGrant): Promise<ConsentResult> => {
  if (grant.noticeVersion.trim().length === 0 || grant.noticeLocale.trim().length === 0) {
    throw new ConsentError("a consent record must name the notice version and locale shown");
  }
  if (grant.grantedPurposes.length === 0) {
    throw new ConsentError("a consent record must grant at least one purpose");
  }
  const unknown = grant.grantedPurposes.filter(
    (purpose) => !(KNOWN_CONSENT_PURPOSES as readonly string[]).includes(purpose),
  );
  if (unknown.length > 0) {
    throw new ConsentError(
      `unknown consent purpose(s): ${unknown.join(", ")}; a new purpose is a notice change, not a parameter`,
    );
  }

  const existing = await tx.query(
    `select consent_id from consent_record
      where participant_id = $1 and notice_version = $2 and withdrawn_at is null
      order by granted_at desc limit 1`,
    [grant.participantId, grant.noticeVersion],
  );
  if (existing.rows[0] !== undefined) {
    return { consentId: String(existing.rows[0]["consent_id"]), created: false };
  }

  const consentId = randomUUID();
  await tx.query(
    `insert into consent_record
       (consent_id, participant_id, notice_version, notice_locale,
        granted_purposes, granted_at)
     values ($1,$2,$3,$4,$5::text[], now())`,
    [
      consentId,
      grant.participantId,
      grant.noticeVersion,
      grant.noticeLocale,
      [...grant.grantedPurposes],
    ],
  );
  return { consentId, created: true };
};

/** Active purposes for a participant, for the V014 eligibility evaluation. */
export const activeConsentPurposes = async (
  tx: Queryable,
  participantId: string,
): Promise<readonly string[]> => {
  const { rows } = await tx.query(
    `select granted_purposes from consent_record
      where participant_id = $1 and withdrawn_at is null
      order by granted_at desc limit 1`,
    [participantId],
  );
  return ((rows[0]?.["granted_purposes"] as string[] | null) ?? []).map(String);
};

/**
 * Withdraws consent.
 *
 * Sets only withdrawal metadata: the grant facts stay, because "they agreed
 * then and withdrew later" is the truth and an erased grant would make the
 * earlier processing look unauthorised (V003, V005 §8).
 */
export const withdrawConsent = async (
  tx: Queryable,
  options: { readonly consentId: string; readonly reason: string },
): Promise<{ readonly withdrawn: boolean }> => {
  if (options.reason.trim().length === 0) {
    throw new ConsentError("withdrawing consent requires a recorded reason");
  }
  const { rowCount } = await tx.query(
    `update consent_record
        set withdrawn_at = now(), withdrawal_reason = $2
      where consent_id = $1 and withdrawn_at is null`,
    [options.consentId, options.reason],
  );
  return { withdrawn: (rowCount ?? 0) > 0 };
};
