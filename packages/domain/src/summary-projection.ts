/**
 * Summary projection rules (roadmap V038).
 *
 * V037 defined what the numbers mean. This defines how an authoritative record
 * becomes a row in a summary table, and — more importantly — what that
 * projection is not allowed to do.
 *
 * The rule the whole design turns on: **a projection stores state, not
 * deltas.** Applying an event recomputes the affected issue's row from the
 * authoritative tables and overwrites it. It never adds one to a counter. That
 * is what makes the V038 acceptance clause "retries cannot increase counts"
 * structurally true rather than defended by dedup logic that has to be right
 * every time. Replaying the same event a hundred times writes the same row a
 * hundred times and the totals do not move.
 *
 * It is also what makes merges reversible for free. A separation closes the
 * alias edge; the next recompute sees an issue that is its own root again and
 * says so. Nothing has to remember to undo an increment that was applied
 * weeks ago.
 *
 * Pure: no clock, no storage. Every input is supplied.
 */

import type { AggregationSafety, BoundaryPart, Combination } from "./metric-semantics.ts";
import { combineValues } from "./metric-semantics.ts";
import type { IssueStatus } from "./transitions.ts";

/**
 * The buckets a summary cell counts.
 *
 * Coarser than `IssueStatus` on purpose. A district summary answers "how much
 * is waiting, how much is claimed but unanswered, how much is disputed, how
 * much held" — the six routing and acknowledgment states in between are
 * operational detail that belongs on a staff screen, not in a public roll-up
 * where each extra bucket is another number nobody can interpret.
 *
 * `unknown` is a first-class bucket rather than a silent omission. An issue
 * whose state could not be established is visible as such, because a reader
 * who cannot see it would read the remaining totals as complete.
 */
export type SummaryState = "open" | "claimed" | "disputed" | "confirmed" | "reopened" | "unknown";

export const SUMMARY_STATES: readonly SummaryState[] = [
  "open",
  "claimed",
  "disputed",
  "confirmed",
  "reopened",
  "unknown",
];

const STATE_OF: Readonly<Record<IssueStatus, SummaryState>> = {
  created: "open",
  routing_review: "open",
  routed_internal: "open",
  agency_ack_received: "open",
  work_planned: "open",
  resolution_claimed: "claimed",
  resolution_confirmed: "confirmed",
  resolution_disputed: "disputed",
  reopened: "reopened",
};

/**
 * The summary bucket for a lifecycle status.
 *
 * An absent status is `unknown`, never `open`. Guessing "probably still open"
 * would be the more useful-looking answer and the wrong one: it would put an
 * issue this system cannot describe into a backlog figure somebody is held to.
 */
export const summaryStateOf = (status: IssueStatus | string | null | undefined): SummaryState => {
  if (status === null || status === undefined) return "unknown";
  return STATE_OF[status as IssueStatus] ?? "unknown";
};

/**
 * `reopened` and `disputed` are open work, `confirmed` is not.
 *
 * Stated once here because three different places need the same answer and a
 * reopened issue quietly counted as closed is the single most damaging
 * rounding this system could make.
 */
export const isOpenState = (state: SummaryState): boolean =>
  state === "open" || state === "claimed" || state === "disputed" || state === "reopened";

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

/**
 * The key for an issue with no jurisdiction.
 *
 * A literal key rather than a null, so the uncovered area is a visible row in
 * the summary table instead of a row that quietly does not exist. Zero and
 * missing must not render the same (V037 M15).
 */
export const UNKNOWN_CELL_KEY = "UNKNOWN";

export const cellKey = (jurisdictionId: string | null | undefined): string =>
  jurisdictionId === null || jurisdictionId === undefined || jurisdictionId.length === 0
    ? UNKNOWN_CELL_KEY
    : jurisdictionId;

export type SummaryMeasure =
  | "issues"
  | "open"
  | "claimed"
  | "disputed"
  | "confirmed"
  | "reopened"
  | "unknownState"
  | "countedParticipants";

/**
 * What may be added across cells.
 *
 * Every count of issues is additive, because an issue belongs to exactly one
 * cell. `countedParticipants` is not, and it does not become additive by
 * living in a projection table: the same person can report in two wards, and
 * two cells of nine are not eighteen people.
 */
export const SUMMARY_MEASURE_SAFETY: Readonly<Record<SummaryMeasure, AggregationSafety>> = {
  issues: "additive",
  open: "additive",
  claimed: "additive",
  disputed: "additive",
  confirmed: "additive",
  reopened: "additive",
  unknownState: "additive",
  countedParticipants: "not_additive",
};

/** Rolls a measure up across cells, or refuses. Shares V037's refusals exactly. */
export const rollUpCells = (
  measure: SummaryMeasure,
  parts: readonly BoundaryPart[],
  boundaries: { readonly mutuallyExclusive: boolean },
): Combination => combineValues(measure, SUMMARY_MEASURE_SAFETY[measure], parts, boundaries);

// ---------------------------------------------------------------------------
// Which issues an event touches
// ---------------------------------------------------------------------------

export type ProjectionEvent = {
  readonly eventId: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
};

const uuidLike = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

/**
 * Every issue whose summary row this event could change.
 *
 * Usually just the aggregate. A merge is the exception and the reason this is
 * a function rather than a field read: `issue_merged` is recorded against the
 * **surviving** issue, so a projection that refreshed only the aggregate would
 * leave the merged-away issue counted as separate open work forever. The same
 * applies in reverse to a reversal, which is what a separation is.
 */
export const affectedIssueIds = (event: ProjectionEvent): readonly string[] => {
  if (event.aggregateType !== "canonical_issue") return [];
  const ids = new Set<string>([event.aggregateId]);
  for (const key of ["merged_issue_id", "surviving_issue_id", "issue_id", "target_issue_id"]) {
    const value = uuidLike(event.payload[key]);
    if (value !== undefined) ids.add(value);
  }
  return [...ids].sort();
};

/**
 * Whether an event can change a summary at all.
 *
 * Kept permissive on purpose. The cost of refreshing an issue that did not
 * change is one idempotent overwrite; the cost of skipping one that did is a
 * summary that is quietly wrong until the next full rebuild, and nothing on
 * screen would say so. Where those two errors are not symmetric, take the
 * cheap one.
 */
export const eventTouchesSummary = (event: ProjectionEvent): boolean =>
  event.aggregateType === "canonical_issue";

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

export type FactSnapshot = {
  readonly issueId: string;
  readonly rootIssueId: string;
  readonly retiredByMerge: boolean;
  readonly jurisdictionKey: string;
  readonly category: string;
  readonly state: SummaryState;
  readonly countedParticipants: number;
};

export type FactDifference = {
  readonly issueId: string;
  readonly field: string;
  readonly incremental: string;
  readonly rebuilt: string;
};

/**
 * Differences between what the incremental projection holds and what a clean
 * rebuild produces.
 *
 * This is the V038 acceptance clause as a function. It reports *what* differs
 * rather than a boolean, because "the summaries disagree" is not an
 * actionable statement and a reconciliation failure that cannot be
 * investigated will be silenced rather than fixed.
 */
export const diffFacts = (
  incremental: readonly FactSnapshot[],
  rebuilt: readonly FactSnapshot[],
): readonly FactDifference[] => {
  const differences: FactDifference[] = [];
  const byId = new Map(rebuilt.map((fact) => [fact.issueId, fact]));

  for (const left of incremental) {
    const right = byId.get(left.issueId);
    if (right === undefined) {
      differences.push({
        issueId: left.issueId,
        field: "presence",
        incremental: "present",
        rebuilt: "absent",
      });
      continue;
    }
    byId.delete(left.issueId);
    const fields: readonly (keyof FactSnapshot)[] = [
      "rootIssueId",
      "retiredByMerge",
      "jurisdictionKey",
      "category",
      "state",
      "countedParticipants",
    ];
    for (const field of fields) {
      if (left[field] !== right[field]) {
        differences.push({
          issueId: left.issueId,
          field,
          incremental: String(left[field]),
          rebuilt: String(right[field]),
        });
      }
    }
  }

  for (const missing of byId.values()) {
    differences.push({
      issueId: missing.issueId,
      field: "presence",
      incremental: "absent",
      rebuilt: "present",
    });
  }

  return differences.sort((a, b) =>
    a.issueId === b.issueId ? a.field.localeCompare(b.field) : a.issueId.localeCompare(b.issueId),
  );
};

/**
 * How stale a summary is, and whether that is acceptable.
 *
 * `pendingEvents` counts what has arrived and not been projected. Both numbers
 * are reported because either alone can look healthy while the other is not: a
 * projection that ran a second ago having skipped four hundred events is not
 * fresh, and one with nothing pending that last ran yesterday has simply had
 * nothing to do.
 */
export type SummaryFreshness = {
  readonly lastRefreshedAtMs: number | null;
  readonly lastRebuildAtMs: number | null;
  readonly pendingEvents: number;
  /**
   * Records with no row in the projection at all.
   *
   * Counted separately from `pendingEvents` because the two describe different
   * ways of being behind, and the second is invisible to the first: no
   * production path appends an event when an issue is opened, so a new report
   * adds nothing to the event backlog while still being entirely absent from
   * the summary. A projection reporting "nothing pending" while a hundred
   * reports have never been projected is the most misleading thing this
   * function could say.
   */
  readonly unprojectedIssues: number;
  readonly asOfMs: number;
};

export type FreshnessVerdict = {
  readonly stalenessSeconds: number | null;
  readonly pendingEvents: number;
  readonly unprojectedIssues: number;
  readonly state: "fresh" | "lagging" | "never_built";
  readonly explanation: string;
};

export const assessFreshness = (
  freshness: SummaryFreshness,
  toleranceSeconds: number,
): FreshnessVerdict => {
  if (freshness.lastRefreshedAtMs === null) {
    return {
      stalenessSeconds: null,
      pendingEvents: freshness.pendingEvents,
      unprojectedIssues: freshness.unprojectedIssues,
      state: "never_built",
      explanation:
        "This summary has never been built. Its cells are absent rather than zero, and nothing should be read from them.",
    };
  }
  const staleness = Math.max(
    0,
    Math.round((freshness.asOfMs - freshness.lastRefreshedAtMs) / 1000),
  );
  const behind = freshness.pendingEvents > 0 || freshness.unprojectedIssues > 0;
  const lagging = staleness > toleranceSeconds || behind;
  return {
    stalenessSeconds: staleness,
    pendingEvents: freshness.pendingEvents,
    unprojectedIssues: freshness.unprojectedIssues,
    state: lagging ? "lagging" : "fresh",
    explanation: lagging
      ? `Last projected ${String(staleness)}s ago with ${String(freshness.pendingEvents)} event(s) not yet applied and ${String(freshness.unprojectedIssues)} record(s) never projected. Figures below are behind the record.`
      : `Last projected ${String(staleness)}s ago with nothing pending and nothing unprojected.`,
  };
};
