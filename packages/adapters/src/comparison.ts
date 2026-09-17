/**
 * The policy decision and investment comparison read model (roadmap V043).
 *
 * V042 produced an ordering and its sensitivity; V041 produced project links;
 * V040 produced context with lineage. This assembles them into the one payload
 * a reviewer needs to answer three questions, which are the V043 acceptance
 * clauses:
 *
 *  - **why does this rank above that?** — the per-factor contributions and
 *    applied weights for both, side by side, plus the position each takes
 *    under every weighting;
 *  - **which assumptions here would I argue with?** — every assumption the
 *    ordering rests on, labelled `evidenced`, `asserted` or `absent`, built
 *    from the policy rather than written out by hand so one cannot be quietly
 *    dropped;
 *  - **did the money do this?** — no, and the outcomes recorded around a
 *    linked project are shown with the events that fell *outside* its dates,
 *    because showing only the overlap is how an overlap looks like a mechanism.
 *
 * The policy version is carried on the payload and on every scenario, so
 * comparing weightings cannot be mistaken for comparing policies.
 */

import {
  ASSUMPTION_SUPPORT_LABELS,
  outcomeStatement,
  placeOutcomes,
  type Assumption,
  type PlacedOutcome,
  type PriorityOrdering,
  type PriorityPlacement,
  type ProjectWindow,
  type RecommendationPolicy,
  type RecordedOutcome,
} from "@vision/domain";

import { readContextForJurisdictions, type ContextValueRow } from "./context-import.ts";
import { orderCandidates, type CandidateGatherOptions } from "./prioritization.ts";
import { readProjectLinks, type ProjectLinkRow } from "./project-links.ts";
import type { Queryable } from "./outbox.ts";

export class ComparisonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComparisonError";
  }
}

export type LinkedProjectOutcomes = {
  readonly projectId: string;
  readonly projectName: string;
  readonly status: ProjectLinkRow["status"];
  readonly amount: number | null;
  readonly amountUnit: string | null;
  readonly sanctionedAt: string | null;
  readonly completedAt: string | null;
  readonly outcomes: readonly PlacedOutcome[];
  /** Always present. The only supported rendering of these outcomes. */
  readonly attributionNote: string;
  /** What a no-match does and does not mean, carried from V041. */
  readonly absenceNote: string;
};

export type ComparisonCandidate = {
  readonly candidateId: string;
  readonly label: string;
  readonly jurisdictionKey: string;
  readonly placement: PriorityPlacement;
  /** Context figures for this candidate's ward, each with its lineage (V040). */
  readonly context: readonly ContextValueRow[];
  readonly projects: readonly LinkedProjectOutcomes[];
  /** True when the register has never been searched for this report. */
  readonly projectRegisterUnsearched: boolean;
};

export type ComparisonView = {
  readonly policyVersion: string;
  readonly weightingIds: readonly string[];
  readonly asOf: string;
  readonly candidateCount: number;
  readonly exhaustive: boolean;
  readonly candidates: readonly ComparisonCandidate[];
  readonly assumptions: readonly Assumption[];
  readonly disclosures: readonly string[];
  readonly unranked: readonly { readonly candidateId: string; readonly reason: string }[];
};

/**
 * Every assumption the ordering rests on, labelled by what supports it.
 *
 * Derived from the policy rather than hand-written, so adding a weighting or
 * changing a reference point cannot leave a stale list behind. `asserted` is
 * not a criticism — a policy has to choose somewhere — it is the label that
 * lets a reviewer decide which of these they would argue with.
 */
export const assumptionsOf = (policy: RecommendationPolicy): readonly Assumption[] => [
  {
    id: "no-severity",
    statement: "Nothing in this ordering reflects how serious or dangerous any problem is.",
    support: "absent",
    detail:
      "No calibrated severity model has ever existed in this system. V046 is the task that would evaluate one, and until then severity is declared and empty rather than quietly omitted.",
  },
  {
    id: "no-accessibility",
    statement: "Nothing in this ordering reflects how reachable or usable any asset is.",
    support: "absent",
    detail:
      "No accessibility dataset has been imported; V040 loads population, enrolment, access and investment only.",
  },
  {
    id: "no-cost",
    statement: policy.budgetAssumption,
    support: "absent",
    detail:
      "Without cost, capacity or delivery-time information, an ordering cannot say what is affordable or what could be done first, only what the configured factors rank highest.",
  },
  {
    id: "equity-inversion",
    statement:
      "A ward recording fewer reports per head is treated as a reason to rank higher, not lower.",
    support: "asserted",
    detail:
      "Nothing measured here shows that low reporting means high need. The reasoning is that a quiet ward is at least as likely to be one where reporting is hard as one where nothing is wrong, and the opposite treatment would compound that. It is a choice, and it is the choice that most changes this ordering.",
  },
  {
    id: "existing-project-direction",
    statement: `A confirmed sanctioned project ${policy.existingProjectDirection}s a report.`,
    support: "asserted",
    detail: `This deployment chose to ${policy.existingProjectDirection} because ${policy.existingProjectRationale}`,
  },
  {
    id: "reference-points",
    statement: `Factors are scaled against fixed reference points: ${String(policy.references.persistenceReferenceDays)} days open, ${String(policy.references.populationReferenceCount)} residents, ${String(policy.references.equityReferenceRatePer1000)} reports per 1000, ${String(policy.references.alternativesReferenceCount)} nearby alternatives.`,
    support: "asserted",
    detail:
      "These numbers were chosen, not derived. They are absolute rather than relative to the other candidates, which keeps a report's factors from moving when an unrelated report is added — but the values themselves have no evidence behind them.",
  },
  {
    id: "context-synthetic",
    statement: "Every population, enrolment, access and investment figure behind this is invented.",
    support: "evidenced",
    detail:
      "The V040 import records a source, a licence and a vintage for each figure, and every one of them is team-created synthetic data (V004 §5). The lineage is real; what it points at is not a real place.",
  },
  {
    id: "weighting-plurality",
    statement: `Positions are shown across ${String(policy.weightings.length)} plausible weightings rather than one.`,
    support: "evidenced",
    detail: policy.weightings
      .map((weighting) => `${weighting.label}: ${weighting.rationale}`)
      .join("; "),
  },
];

const OUTCOME_EVENT_DESCRIPTIONS: Readonly<Record<string, string>> = {
  resolution_claimed: "department staff recorded a repair claim",
  resolution_confirmed: "participants agreed the problem looked fixed",
  resolution_disputed: "a participant disputed the repair claim",
  issue_reopened: "the report was reopened after a confirmation",
  disputed_work_returned: "a reviewer sent the disputed work back to the crew",
  work_planned: "work was recorded as planned",
  agency_ack_received: "the recipient acknowledged the report",
};

const recordedOutcomes = async (
  tx: Queryable,
  issueId: string,
): Promise<readonly RecordedOutcome[]> => {
  const { rows } = await tx.query(
    `select event_type, occurred_at from status_event
      where aggregate_type = 'canonical_issue' and aggregate_id = $1
        and event_type = any($2::text[])
      order by occurred_at asc`,
    [issueId, Object.keys(OUTCOME_EVENT_DESCRIPTIONS)],
  );
  return rows.map((row) => ({
    eventType: String(row["event_type"]),
    occurredAtMs:
      row["occurred_at"] === null || row["occurred_at"] === undefined
        ? null
        : new Date(String(row["occurred_at"])).getTime(),
    description: OUTCOME_EVENT_DESCRIPTIONS[String(row["event_type"])] ?? String(row["event_type"]),
  }));
};

/**
 * Assembles the comparison payload.
 *
 * `focus` narrows the candidate detail to a handful of reports so the payload
 * stays readable; the ordering itself is always computed over every candidate,
 * because a position among twelve is a different statement from a position
 * among two hundred.
 */
export const readComparisonView = async (
  tx: Queryable,
  options: CandidateGatherOptions & {
    readonly policy: RecommendationPolicy;
    /** How many top-placed candidates to assemble detail for. */
    readonly detailCount?: number;
  },
): Promise<ComparisonView> => {
  const result = await orderCandidates(tx, options);
  const ordering: PriorityOrdering = result.ordering;
  const detailCount = options.detailCount ?? 8;

  const context = await readContextForJurisdictions(tx, {
    jurisdictionIds: options.jurisdictionIds,
    asOf: options.asOf,
  });

  const wanted = ordering.placements.slice(0, detailCount);
  const links = await readProjectLinks(tx, {
    issueIds: wanted.map((placement) => placement.candidateId),
  });

  const candidates: ComparisonCandidate[] = [];
  for (const placement of wanted) {
    const { rows } = await tx.query(
      "select jurisdiction_id from canonical_issue where issue_id = $1",
      [placement.candidateId],
    );
    const jurisdictionKey =
      rows[0]?.["jurisdiction_id"] === null || rows[0]?.["jurisdiction_id"] === undefined
        ? "UNKNOWN"
        : String(rows[0]["jurisdiction_id"]);

    const mine = links.filter((link) => link.issueId === placement.candidateId);
    const outcomes = await recordedOutcomes(tx, placement.candidateId);

    const projects: LinkedProjectOutcomes[] = mine
      .filter((link) => link.projectId !== null && link.sanctionedAt !== null)
      .map((link) => {
        const window: ProjectWindow = {
          projectId: link.projectId ?? "",
          projectName: link.projectName ?? link.projectId ?? "",
          sanctionedAtMs: new Date(link.sanctionedAt ?? 0).getTime(),
          completedAtMs: link.completedAt === null ? null : new Date(link.completedAt).getTime(),
        };
        const placed = placeOutcomes(outcomes, window);
        return {
          projectId: window.projectId,
          projectName: window.projectName,
          status: link.status,
          amount: link.amount,
          amountUnit: link.amountUnit,
          sanctionedAt: link.sanctionedAt,
          completedAt: link.completedAt,
          outcomes: placed,
          attributionNote: outcomeStatement(placed, window),
          absenceNote: link.absenceNote,
        };
      });

    candidates.push({
      candidateId: placement.candidateId,
      label: placement.label,
      jurisdictionKey,
      placement,
      context: context.filter((value) => value.jurisdictionId === jurisdictionKey),
      projects,
      // An unsearched register is not an absence of projects (V041). Kept as
      // its own flag rather than inferred from an empty project list.
      projectRegisterUnsearched: mine.length === 0,
    });
  }

  return {
    policyVersion: ordering.policyVersion,
    weightingIds: ordering.weightingIds,
    asOf: result.asOf,
    candidateCount: result.candidateCount,
    exhaustive: result.exhaustive,
    candidates,
    assumptions: assumptionsOf(options.policy),
    disclosures: [
      ...ordering.disclosures,
      `Every label above uses these words: ${Object.values(ASSUMPTION_SUPPORT_LABELS).join("; ")}.`,
    ],
    unranked: ordering.unranked,
  };
};
