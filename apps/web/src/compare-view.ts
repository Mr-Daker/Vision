/**
 * Pure presentation rules for the V043 comparison view.
 *
 * The screen has to let a reviewer answer three questions, and each one is a
 * function here rather than a layout decision in the template:
 *
 *  - **why does this rank above that?** `factorComparison` puts two
 *    candidates' factors side by side and names the factors that actually
 *    separate them, so "why" is an answer rather than a table to squint at.
 *  - **which assumptions would I argue with?** `assumptionTone` marks the
 *    asserted and absent ones, because an assumptions list where everything
 *    looks equally solid is not an assumptions list.
 *  - **did the money do this?** `outcomeTone` never marks a recorded outcome
 *    as good or successful, and the attribution note is required alongside.
 *
 * One rule shapes the rest: **a position is always rendered as an interval.**
 * `positionText` has no branch that produces a single number, so a scenario
 * comparison cannot collapse into a leaderboard.
 */

export type Tone = "neutral" | "caution" | "absent";

export type FactorOutcomeView = {
  readonly factor: string;
  readonly status: "available" | "no_source_in_deployment" | "missing_for_this_candidate";
  readonly contribution: number | null;
  readonly appliedWeight: number;
  readonly explanation: string;
};

export type PlacementView = {
  readonly candidateId: string;
  readonly label: string;
  readonly bestRank: number | null;
  readonly worstRank: number | null;
  readonly stability: "robust" | "sensitive" | "unstable" | "not_ranked";
  readonly underWeighting: readonly {
    readonly weightingId: string;
    readonly rank: number | null;
  }[];
  readonly factors: readonly FactorOutcomeView[];
  readonly explanation: string;
};

export type PlacedOutcomeView = {
  readonly eventType: string;
  readonly description: string;
  readonly relation: "during" | "before" | "after" | "unknown";
  readonly explanation: string;
};

export type LinkedProjectView = {
  readonly projectId: string;
  readonly projectName: string;
  readonly status: string;
  readonly amount: number | null;
  readonly amountUnit: string | null;
  readonly sanctionedAt: string | null;
  readonly completedAt: string | null;
  readonly outcomes: readonly PlacedOutcomeView[];
  readonly attributionNote: string;
  readonly absenceNote: string;
};

export type ContextValueView = {
  readonly kind: string;
  readonly value: number | null;
  readonly unit: string;
  readonly missingIndicator: string | null;
  readonly lineage: string;
  readonly staleness: { readonly stale: boolean };
};

export type ComparisonCandidateView = {
  readonly candidateId: string;
  readonly label: string;
  readonly jurisdictionKey: string;
  readonly placement: PlacementView;
  readonly context: readonly ContextValueView[];
  readonly projects: readonly LinkedProjectView[];
  readonly projectRegisterUnsearched: boolean;
};

export type AssumptionView = {
  readonly id: string;
  readonly statement: string;
  readonly support: "evidenced" | "asserted" | "absent";
  readonly detail: string;
};

export type ComparisonPayload = {
  readonly policyVersion: string;
  readonly weightingIds: readonly string[];
  readonly asOf: string;
  readonly candidateCount: number;
  readonly exhaustive: boolean;
  readonly candidates: readonly ComparisonCandidateView[];
  readonly assumptions: readonly AssumptionView[];
  readonly disclosures: readonly string[];
  readonly unranked: readonly { readonly candidateId: string; readonly reason: string }[];
  readonly note: string;
};

// ---------------------------------------------------------------------------
// Positions are intervals
// ---------------------------------------------------------------------------

/**
 * A position, always as a range.
 *
 * There is no branch here that renders a single number, including when the
 * best and worst positions are the same — "3 to 3" says the weightings agreed,
 * where a bare "3" says the system knows. A scenario comparison built on this
 * cannot collapse into a leaderboard.
 */
export const positionText = (placement: PlacementView): string =>
  placement.bestRank === null || placement.worstRank === null
    ? "Not ranked"
    : `${String(placement.bestRank)} to ${String(placement.worstRank)}`;

export const STABILITY_TONES: Readonly<Record<PlacementView["stability"], Tone>> = {
  robust: "neutral",
  sensitive: "caution",
  unstable: "caution",
  not_ranked: "absent",
};

export const STABILITY_LABELS: Readonly<Record<PlacementView["stability"], string>> = {
  robust: "Barely moves between weightings",
  sensitive: "Moves noticeably between weightings",
  unstable: "Moves across much of the list between weightings",
  not_ranked: "Not placed — too few factors had data",
};

/** The position this candidate takes under one named weighting. */
export const rankUnder = (placement: PlacementView, weightingId: string): string => {
  const entry = placement.underWeighting.find((item) => item.weightingId === weightingId);
  return entry?.rank === null || entry === undefined ? "not ranked" : String(entry.rank);
};

// ---------------------------------------------------------------------------
// Why one ranks above another
// ---------------------------------------------------------------------------

export type FactorDifference = {
  readonly factor: string;
  readonly leftContribution: number | null;
  readonly rightContribution: number | null;
  readonly appliedWeight: number;
  /** Weighted difference, positive when the left candidate gains. */
  readonly weightedDifference: number;
  readonly separates: boolean;
  readonly explanation: string;
};

/**
 * What actually separates two candidates.
 *
 * Returns every factor, ordered by how much of the gap it accounts for, with
 * the ones that carry it marked. A comparison that lists factors in a fixed
 * order leaves the reviewer to do the subtraction, and the answer to "why does
 * this rank above that" is the subtraction.
 *
 * A factor either side is missing contributes nothing and says so, rather than
 * being scored as a difference of zero — those are different statements.
 */
export const factorComparison = (
  left: PlacementView,
  right: PlacementView,
): readonly FactorDifference[] => {
  const rightByFactor = new Map(right.factors.map((factor) => [factor.factor, factor]));
  const differences = left.factors.map((leftFactor) => {
    const rightFactor = rightByFactor.get(leftFactor.factor);
    const comparable =
      leftFactor.contribution !== null && (rightFactor?.contribution ?? null) !== null;
    const weightedDifference = comparable
      ? (leftFactor.contribution ?? 0) * leftFactor.appliedWeight -
        (rightFactor?.contribution ?? 0) * (rightFactor?.appliedWeight ?? 0)
      : 0;
    return {
      factor: leftFactor.factor,
      leftContribution: leftFactor.contribution,
      rightContribution: rightFactor?.contribution ?? null,
      appliedWeight: leftFactor.appliedWeight,
      weightedDifference: Math.round(weightedDifference * 1000) / 1000,
      separates: comparable && Math.abs(weightedDifference) >= 0.01,
      explanation: comparable
        ? leftFactor.explanation
        : "one of the two has no value for this factor, so it accounts for none of the difference between them — which is not the same as the two being equal on it",
    };
  });
  return [...differences].sort(
    (a, b) => Math.abs(b.weightedDifference) - Math.abs(a.weightedDifference),
  );
};

/** One sentence naming the factors that carry the gap, or saying none does. */
export const separationSummary = (
  left: PlacementView,
  right: PlacementView,
  differences: readonly FactorDifference[],
): string => {
  const carrying = differences.filter((difference) => difference.separates);
  if (carrying.length === 0) {
    return `Nothing separates ${left.label} and ${right.label} by more than a rounding margin. Their order here is not a finding about either of them.`;
  }
  const named = carrying
    .slice(0, 3)
    .map(
      (difference) =>
        `${difference.factor.replace(/_/g, " ")} (${difference.weightedDifference > 0 ? "+" : ""}${String(difference.weightedDifference)})`,
    )
    .join(", ");
  return `${left.label} sits above ${right.label} mainly on ${named}. Positive figures favour ${left.label}.`;
};

// ---------------------------------------------------------------------------
// Assumptions
// ---------------------------------------------------------------------------

export const ASSUMPTION_TONES: Readonly<Record<AssumptionView["support"], Tone>> = {
  evidenced: "neutral",
  asserted: "caution",
  absent: "absent",
};

export const ASSUMPTION_HEADINGS: Readonly<Record<AssumptionView["support"], string>> = {
  evidenced: "Backed by a loaded source",
  asserted: "Chosen by this deployment",
  absent: "No source exists",
};

/**
 * The assumptions a reviewer is most likely to want to argue with, first.
 *
 * Absent sources lead, then asserted choices, then the evidenced ones. A list
 * that opens with what is well supported invites the reader to stop there.
 */
export const assumptionsByScrutiny = (payload: ComparisonPayload): readonly AssumptionView[] => {
  const order: Record<AssumptionView["support"], number> = { absent: 0, asserted: 1, evidenced: 2 };
  return [...payload.assumptions].sort((a, b) => order[a.support] - order[b.support]);
};

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

export const OUTCOME_RELATION_LABELS: Readonly<Record<PlacedOutcomeView["relation"], string>> = {
  during: "Recorded while the project was running",
  before: "Recorded before the project was sanctioned",
  after: "Recorded after the project was completed",
  unknown: "Cannot be placed against the project's dates",
};

/**
 * How a recorded outcome is toned.
 *
 * Never "good". An event inside a project's dates is the one a reader is most
 * likely to read as a result, so it is toned as a caveat rather than as a
 * success, and the attribution note is rendered beside it.
 */
export const OUTCOME_TONES: Readonly<Record<PlacedOutcomeView["relation"], Tone>> = {
  during: "caution",
  before: "neutral",
  after: "neutral",
  unknown: "absent",
};

export const projectSummary = (project: LinkedProjectView): string => {
  const amount =
    project.amount === null
      ? "no amount recorded"
      : `${String(project.amount)} ${project.amountUnit ?? ""}`.trim();
  const dates =
    project.completedAt === null
      ? `sanctioned ${(project.sanctionedAt ?? "").slice(0, 10)}, no recorded completion`
      : `${(project.sanctionedAt ?? "").slice(0, 10)} to ${project.completedAt.slice(0, 10)}`;
  return `${project.projectName} — ${amount}, ${dates}, link ${project.status}`;
};

/**
 * What to say when the register has never been searched for a report.
 *
 * Distinct from having searched and found nothing (V041), and rendered as its
 * own sentence so the two cannot look alike.
 */
export const UNSEARCHED_REGISTER_NOTE =
  "The sanctioned-project register has not been searched for this report. That is not the same as having searched it and found nothing, and neither is evidence about whether this asset has been paid for.";
