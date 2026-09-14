/**
 * Participant eligibility, recurrence and correction semantics (roadmap V014).
 *
 * Pure functions. The recurrence rule in particular is deliberately a refusal
 * to decide: V003 §8 requires that recurrence after a confirmed resolution is
 * classified by a human, not inferred silently by the system.
 */

import type { IsoTimestamp, Uuid } from "@vision/contracts";
import type { Participant } from "./entities.ts";
import { isParticipantEligible } from "./session-policy.ts";

// ---------------------------------------------------------------------------
// Participant eligibility
// ---------------------------------------------------------------------------

export type EligibilityInput = {
  readonly participant: Participant;
  /** Whether the request arrived on a currently valid session. */
  readonly hasValidSession: boolean;
  /** Active consent purposes at the time of the action. */
  readonly grantedPurposes: readonly string[];
  /** The provider mode that established this identity. */
  readonly identityProviderMode: "simulated" | "real";
};

export type EligibilityVerdict =
  { readonly counted: true } | { readonly counted: false; readonly reason: string };

/**
 * Whether a participant's contribution counts toward corroboration.
 *
 * A simulated identity still counts *within the demonstration cohort* — that
 * is what makes the demo meaningful — but the provenance is recorded so no
 * surface can describe the count as verified real people (V002 row 13).
 */
export const evaluateParticipationEligibility = (input: EligibilityInput): EligibilityVerdict => {
  if (!isParticipantEligible(input.participant)) {
    return { counted: false, reason: "participant_tombstoned_by_deletion_request" };
  }
  if (!input.hasValidSession) {
    return { counted: false, reason: "no_valid_session_at_time_of_action" };
  }
  if (!input.grantedPurposes.includes("demo_processing")) {
    return { counted: false, reason: "demo_processing_consent_not_granted" };
  }
  return { counted: true };
};

/** Provenance recorded alongside a counted participation, for later audit. */
export const participationProvenance = (
  input: EligibilityInput,
  evidenceId: Uuid,
): Readonly<Record<string, string | boolean>> => ({
  identity_provider_mode: input.identityProviderMode,
  established_by_evidence: evidenceId,
  session_valid_at_action: input.hasValidSession,
  consent_included_demo_processing: input.grantedPurposes.includes("demo_processing"),
});

// ---------------------------------------------------------------------------
// Recurrence
// ---------------------------------------------------------------------------

export type RecurrenceInput = {
  readonly assetId: string;
  readonly priorIssueStatus: string;
  readonly priorConfirmedAt?: IsoTimestamp;
  readonly newObservedAt: IsoTimestamp;
  readonly sameCategory: boolean;
  readonly sameDefect: boolean;
};

export type RecurrenceClassification = {
  readonly isRecurrenceCandidate: boolean;
  /** Always true when it is a candidate: the system never decides this alone. */
  readonly requiresHumanDecision: boolean;
  readonly permittedTreatments: readonly ("reopening_of_prior_issue" | "new_issue_on_same_asset")[];
  readonly rationale: string;
};

export const classifyRecurrence = (input: RecurrenceInput): RecurrenceClassification => {
  const afterConfirmedResolution =
    input.priorIssueStatus === "resolution_confirmed" && input.priorConfirmedAt !== undefined;

  if (!afterConfirmedResolution) {
    return {
      isRecurrenceCandidate: false,
      requiresHumanDecision: false,
      permittedTreatments: [],
      rationale: "the prior issue on this asset is not in a confirmed-resolved state",
    };
  }
  if (!input.sameCategory) {
    return {
      isRecurrenceCandidate: false,
      requiresHumanDecision: false,
      permittedTreatments: [],
      rationale: "a different subsystem on the same asset is a distinct issue, not a recurrence",
    };
  }
  if (Date.parse(input.newObservedAt) <= Date.parse(input.priorConfirmedAt!)) {
    return {
      isRecurrenceCandidate: false,
      requiresHumanDecision: false,
      permittedTreatments: [],
      rationale: "the new observation predates the prior confirmation, so it is not a recurrence",
    };
  }

  return {
    isRecurrenceCandidate: true,
    // Deliberate: both treatments are defensible and the choice is a judgement
    // about the real world, not something the system can settle from data.
    requiresHumanDecision: true,
    permittedTreatments: ["reopening_of_prior_issue", "new_issue_on_same_asset"],
    rationale: input.sameDefect
      ? "the same defect recurred on the same asset after a confirmed resolution"
      : "the same subsystem failed again on the same asset after a confirmed resolution",
  };
};

// ---------------------------------------------------------------------------
// Correction semantics
// ---------------------------------------------------------------------------

export type EffectiveDatedRow = {
  readonly id: string;
  readonly effective_from: IsoTimestamp;
  readonly effective_to?: IsoTimestamp | null;
};

export type CorrectionPlan<T extends EffectiveDatedRow> = {
  /** The row to close, with the timestamp to close it at. */
  readonly close: { readonly id: string; readonly effective_to: IsoTimestamp };
  /** The successor row's provenance fields. */
  readonly successor: {
    readonly supersedes_id: string;
    readonly effective_from: IsoTimestamp;
    readonly correction_reason: string;
    readonly corrected_by_actor_id: Uuid;
  };
  readonly superseded: T;
};

export class CorrectionError extends Error {}

/**
 * Builds the close-and-supersede pair for a correction.
 *
 * Corrections never rewrite the superseded row's own facts: the old row is
 * closed and a successor is created, so the history of what was believed
 * remains reconstructable (V003 §8). Both writes belong to one transaction.
 */
export const planCorrection = <T extends EffectiveDatedRow>(
  active: readonly T[],
  at: IsoTimestamp,
  reason: string,
  actorId: Uuid,
): CorrectionPlan<T> => {
  const open = active.filter((row) => row.effective_to === undefined || row.effective_to === null);
  if (open.length === 0) {
    throw new CorrectionError("nothing to correct: no active row");
  }
  if (open.length > 1) {
    throw new CorrectionError(
      `invariant violated: ${String(open.length)} active rows where exactly one is permitted`,
    );
  }
  const current = open[0]!;
  if (Date.parse(at) <= Date.parse(current.effective_from)) {
    throw new CorrectionError("a correction cannot take effect before the row it supersedes");
  }
  if (reason.trim().length === 0) {
    throw new CorrectionError("a correction must record a reason");
  }

  return {
    close: { id: current.id, effective_to: at },
    successor: {
      supersedes_id: current.id,
      effective_from: at,
      correction_reason: reason,
      corrected_by_actor_id: actorId,
    },
    superseded: current,
  };
};
