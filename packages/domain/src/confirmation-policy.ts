/**
 * Category-specific resolution confirmation policy (roadmap V035).
 *
 * The rule this exists to enforce: **a repair claim is not a verified
 * resolution.** Someone saying they fixed something is a claim. Whether it
 * counts as resolved depends on who confirms it, how many, and — for some
 * categories — on whether anyone qualified could confirm it at all.
 *
 * Two deliberate asymmetries:
 *
 * **A dispute outweighs confirmations.** One person saying it is not fixed
 * stops the claim, however many said it was. The people living with a problem
 * are better placed to know than a count is, and treating agreement as a vote
 * would let a majority close something still broken for someone.
 *
 * **An unknown category falls back to the strictest rule, not the loosest.**
 * A missing configuration entry is a gap in the pack, and a gap must not make
 * closing an issue *easier*.
 *
 * The policy is data supplied by the caller. No category name appears in this
 * file (V001 Appendix G rule 7).
 */

export type ConfirmationRule = {
  /** How many qualifying confirmations are needed. */
  readonly requiredConfirmations: number;
  readonly citizenMayConfirm: boolean;
  /** Whether a reviewer may resolve a dispute in favour of the claim. */
  readonly reviewerMayOverride: boolean;
  /**
   * True where the repair is the kind a qualified person should inspect.
   * Never satisfied by this system — it is a statement of what is missing.
   */
  readonly requiresQualifiedInspection?: boolean;
};

/**
 * Applied when the pack has no rule for a category.
 *
 * Strict on purpose: two confirmations, no reviewer override. A gap in
 * configuration must not be a shortcut to closing an issue.
 */
export const DEFAULT_CONFIRMATION_RULE: ConfirmationRule = {
  requiredConfirmations: 2,
  citizenMayConfirm: true,
  reviewerMayOverride: false,
  requiresQualifiedInspection: true,
};

export type ConfirmationPolicyPack = {
  readonly version: string;
  readonly rules: Readonly<Record<string, ConfirmationRule>>;
};

export type ConfirmationRecord = {
  readonly actor: "participant" | "reviewer";
  readonly decision: "confirmed" | "disputed";
  /** Whether this participant's participation counts on the issue (V029). */
  readonly hasCountedParticipation?: boolean;
};

export type ConfirmationInput = {
  readonly category: string;
  readonly policy: ConfirmationPolicyPack;
  /** Completion evidence attached to the claim. Zero means the claim is incomplete. */
  readonly claimEvidenceCount: number;
  readonly confirmations: readonly ConfirmationRecord[];
};

export type ConfirmationStatus =
  "claim_incomplete" | "claimed_awaiting_confirmation" | "confirmed" | "disputed";

export type ConfirmationResult = {
  readonly status: ConfirmationStatus;
  /** True only for `confirmed`. Nothing else may be presented as a verified resolution. */
  readonly isVerifiedResolution: boolean;
  readonly resolvedByReviewer: boolean;
  readonly requiresQualifiedInspection: boolean;
  readonly appliedRule: ConfirmationRule;
  readonly policyVersion: string;
  readonly reason: string;
  readonly disclosures: readonly string[];
};

const NOT_A_CERTIFICATION =
  "a confirmed repair here means people agreed the problem looks fixed; it is not an inspection, not an engineer's certification, and not a guarantee the repair is permanent";

const NEEDS_QUALIFIED_INSPECTION =
  "this category is the kind a qualified person should inspect, and no such inspection has happened; photographs and agreement are not a substitute for one";

export const evaluateConfirmation = (input: ConfirmationInput): ConfirmationResult => {
  const configured = input.policy.rules[input.category];
  const rule = configured ?? DEFAULT_CONFIRMATION_RULE;
  const requiresQualifiedInspection = rule.requiresQualifiedInspection === true;

  const disclosures = [
    NOT_A_CERTIFICATION,
    ...(requiresQualifiedInspection ? [NEEDS_QUALIFIED_INSPECTION] : []),
  ];

  const base = {
    resolvedByReviewer: false,
    requiresQualifiedInspection,
    appliedRule: rule,
    policyVersion: input.policy.version,
    disclosures,
  };

  const fallbackNote =
    configured === undefined
      ? ` (no rule is configured for this category, so the strictest default was applied)`
      : "";

  if (input.claimEvidenceCount <= 0) {
    return {
      ...base,
      status: "claim_incomplete",
      isVerifiedResolution: false,
      reason: `the claim carries no completion evidence, so there is nothing for anyone to confirm${fallbackNote}`,
    };
  }

  const disputes = input.confirmations.filter((record) => record.decision === "disputed");
  const qualifying = input.confirmations.filter(
    (record) =>
      record.decision === "confirmed" &&
      (record.actor === "reviewer" ||
        (rule.citizenMayConfirm && record.hasCountedParticipation === true)),
  );
  const ignoredCitizen = input.confirmations.some(
    (record) =>
      record.decision === "confirmed" &&
      record.actor === "participant" &&
      record.hasCountedParticipation !== true,
  );

  if (disputes.length > 0) {
    const reviewerConfirmed = input.confirmations.some(
      (record) => record.actor === "reviewer" && record.decision === "confirmed",
    );
    if (reviewerConfirmed && rule.reviewerMayOverride) {
      return {
        ...base,
        status: "confirmed",
        isVerifiedResolution: true,
        resolvedByReviewer: true,
        reason: `a reviewer resolved the dispute in favour of the claim${fallbackNote}`,
      };
    }
    return {
      ...base,
      status: "disputed",
      isVerifiedResolution: false,
      reason: reviewerConfirmed
        ? `the claim is disputed and this category's policy says a reviewer may not override a dispute${fallbackNote}`
        : `the claim is disputed by someone with counted participation${fallbackNote}`,
    };
  }

  if (qualifying.length >= rule.requiredConfirmations) {
    return {
      ...base,
      status: "confirmed",
      isVerifiedResolution: true,
      reason: `${String(qualifying.length)} qualifying confirmation(s) met the required ${String(rule.requiredConfirmations)}${fallbackNote}`,
    };
  }

  return {
    ...base,
    status: "claimed_awaiting_confirmation",
    isVerifiedResolution: false,
    reason: ignoredCitizen
      ? `a confirmation was ignored because that participant's participation is not counted on this issue; ${String(qualifying.length)} of ${String(rule.requiredConfirmations)} required so far${fallbackNote}`
      : `this is a claim awaiting confirmation: ${String(qualifying.length)} of ${String(rule.requiredConfirmations)} required so far${fallbackNote}`,
  };
};
