/**
 * District dashboard read model (roadmap V039).
 *
 * V037 said what the numbers mean, V038 projected them into tables. This
 * assembles the one payload a dashboard needs and — more importantly — the
 * three things it must show alongside the numbers for them to be readable at
 * all.
 *
 * **Totals that reconcile to a named population.** Every dashboard that has
 * ever misled anybody did so by showing a total without saying what it was a
 * total of. `sourcePopulation` is counted live from the authoritative records
 * using V038's own resolution, `projectedTotal` is summed from the stored
 * cells, and both are returned with a verdict. When they disagree the payload
 * says so and says by how much; it does not quietly show the prettier one.
 *
 * **Zero that cannot be confused with missing.** A ward with a cell holding
 * zero issues and a ward with no cell at all are different facts, and the
 * second one is the dangerous one — it reads as "nothing wrong here" when it
 * means "nobody has been able to report here, or we have not projected it
 * yet". Every jurisdiction in scope appears in `cells`, carrying an explicit
 * `coverage` of `projected` or `no_data`.
 *
 * **A route from an indicator to its records.** A number nobody can open is a
 * number nobody can check. `readCellIssues` and `readIssueDetail` are that
 * route, and they stop exactly where the V015 boundary does: a supervisor may
 * read redacted derivatives, so evidence arrives as derivative references and
 * the private original is never in the payload at all.
 */

import {
  METRIC_CATALOGUE,
  cellKey,
  summaryStateOf,
  type MetricContract,
  type MetricId,
  type MetricValue,
  type SummaryState,
} from "@vision/domain";

import type { Queryable } from "./outbox.ts";
import {
  DEFAULT_FRESHNESS_TOLERANCE_SECONDS,
  DISTRICT_CATEGORY_SUMMARY,
  FACT_SELECT_SQL,
  readSummaryCells,
  summaryStatus,
  type SummaryCell,
  type SummaryStatus,
} from "./summaries.ts";
import {
  readContextForJurisdictions,
  readImportRuns,
  type ContextValueRow,
  type ImportRunSummary,
} from "./context-import.ts";
import {
  dataCoverage,
  fixedWindowResolutionRate,
  reopeningRate,
  unresolvedAge,
  type MetricParams,
  type MetricReading,
} from "./analytics-metrics.ts";

export class DashboardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DashboardError";
  }
}

/** Issues with no jurisdiction. A visible bucket, never folded into a ward. */
export const UNPLACED_KEY = "UNKNOWN";

/**
 * The live count of active canonical roots, per cell.
 *
 * Built on V038's `FACT_SELECT_SQL` rather than on a second hand-written walk,
 * so the population a total is checked against resolves merges exactly the way
 * the projection does. Two different definitions of "one report" would make
 * every reconciliation a coin toss between two defensible answers.
 */
export const LIVE_POPULATION_SQL = `select
  coalesce(f.jurisdiction_id::text, '${UNPLACED_KEY}') as jurisdiction_key,
  f.category,
  count(*)::int as issue_count
from (${FACT_SELECT_SQL}) f
where f.root_issue_id = f.issue_id
group by 1, 2`;

/**
 * What an empty slot in the table means.
 *
 *  - `projected` — a stored cell holds reports.
 *  - `zero` — no stored cell, and the projection is healthy, so there really
 *    are no reports here.
 *  - `no_data` — no stored cell, and the projection is stale, unbuilt or
 *    disagreeing with the records, so nothing can be concluded.
 *
 * The middle case exists because V038 only ever materialises cells that hold
 * something: a cell with zero issues is deleted rather than stored, so
 * emptiness at cell grain carries no information on its own. What does carry
 * information is the **health of the whole projection**, and that is what
 * separates "we looked and there is nothing" from "we cannot say". Collapsing
 * the two into one label would have been safe in the wrong direction — a
 * permanently cautious map teaches its readers to ignore the caution.
 */
export type CellCoverage = "projected" | "zero" | "no_data";

export type DashboardCell = {
  readonly jurisdictionKey: string;
  readonly jurisdictionLabel: string;
  readonly category: string;
  readonly boundaryVersion: string | null;
  /**
   * `no_data` means nothing can be concluded about this ward and category.
   * It is not zero, and a reader must never be allowed to read it as zero.
   */
  readonly coverage: CellCoverage;
  /**
   * Whether the taxonomy pack lists this category.
   *
   * An untracked category is shown when it holds reports — hiding them would
   * make the totals disagree with the table — but it never generates a
   * `no_data` row, because "no reports in a category nobody tracks" is not a
   * gap anybody promised to fill.
   */
  readonly tracked: boolean;
  readonly issueCount: number;
  readonly open: number;
  readonly claimed: number;
  readonly disputed: number;
  readonly confirmed: number;
  readonly reopened: number;
  readonly unknownState: number;
  /** Distinct within this cell. Never summed across cells (V037 M12). */
  readonly countedParticipants: number;
  /** False for the unplaced bucket: no jurisdiction grant covers those records. */
  readonly drillDownAvailable: boolean;
};

export type PopulationReconciliation = {
  /** Counted live from the authoritative records at `asOf`. */
  readonly sourcePopulation: number;
  /** Summed from the stored summary cells. */
  readonly projectedTotal: number;
  readonly difference: number;
  readonly reconciles: boolean;
  readonly definition: string;
  readonly explanation: string;
};

export type DashboardMetric = {
  readonly id: MetricId;
  readonly title: string;
  readonly value: MetricValue;
  readonly unit: string;
  readonly definition: MetricContract;
  /** Stated with the figure, because a rate without its population is a rumour. */
  readonly populationNote: string;
};

export type DistrictDashboard = {
  readonly asOf: string;
  readonly jurisdictionScope: readonly string[];
  readonly cells: readonly DashboardCell[];
  readonly reconciliation: PopulationReconciliation;
  readonly metrics: readonly DashboardMetric[];
  readonly coverage: {
    readonly rows: number;
    readonly anyDimensionUnknown: number;
    readonly jurisdictionUnknown: number;
    readonly wardsWithNoData: number;
    /** Slots the projection looked at and found empty. Distinct from no_data. */
    readonly wardsWithNoReports: number;
    /** Reports recorded under a category the taxonomy pack does not list. */
    readonly untrackedCategoryCells: number;
    readonly unplacedIssues: number;
  };
  readonly summary: SummaryStatus;
  /**
   * Contextual figures for the wards in scope (V040).
   *
   * Each arrives with the lineage sentence already attached, because "every
   * displayed context value links to a source record or is visibly synthetic"
   * is not a property a screen can be trusted to remember.
   */
  readonly context: readonly ContextValueRow[];
  /** What the last context import refused, and why. Shown, not logged. */
  readonly contextImports: readonly ImportRunSummary[];
  readonly notAdditive: readonly string[];
};

const populationDefinition = (scopeSize: number): string =>
  `Active canonical roots at this moment — every accepted report that is not merged into another — in the ${String(scopeSize)} authorized jurisdiction(s) of this session, plus reports not yet placed in a ward.`;

const jurisdictionLabels = async (
  tx: Queryable,
  scope: readonly string[],
): Promise<ReadonlyMap<string, string>> => {
  if (scope.length === 0) return new Map();
  const { rows } = await tx.query(
    `select jurisdiction_id, internal_code from jurisdiction where jurisdiction_id = any($1::uuid[])`,
    [scope],
  );
  return new Map(rows.map((row) => [String(row["jurisdiction_id"]), String(row["internal_code"])]));
};

const metricOf = (reading: MetricReading, populationNote: string): DashboardMetric => ({
  id: reading.id,
  title: reading.title,
  value: reading.measure,
  unit: reading.unit,
  definition: METRIC_CATALOGUE[reading.id],
  populationNote,
});

/**
 * The whole dashboard payload.
 *
 * Every jurisdiction in scope appears in `cells` even when nothing has been
 * projected for it, and every category seen anywhere in scope appears for
 * every jurisdiction in scope. That produces some rows that are entirely
 * `no_data`, which is the point: a ward missing from a table reads as a ward
 * with nothing wrong in it.
 */
export const readDistrictDashboard = async (
  tx: Queryable,
  options: {
    readonly jurisdictionScope: readonly string[];
    readonly asOf: Date;
    /**
     * The categories this deployment tracks, from the taxonomy pack.
     *
     * Rows are the product of the authorized wards and these, so a ward with
     * nothing in a tracked category is a visible `no_data` row rather than an
     * absent one. Bounded by the pack rather than by every category string
     * ever written, because the second produces hundreds of empty rows and a
     * gap nobody can see among them is the same as a gap nobody was shown.
     * Any category present in the data but absent from the pack is still
     * added, so nothing is hidden by a stale pack.
     */
    readonly trackedCategories: readonly string[];
    /** Profile whose context datasets belong to these wards (V040). */
    readonly jurisdictionProfileId?: string;
    readonly summaryName?: string;
    readonly fixedWindowDays?: number;
    readonly cohortDays?: number;
  },
): Promise<DistrictDashboard> => {
  const summaryName = options.summaryName ?? DISTRICT_CATEGORY_SUMMARY;
  const scope = [...new Set(options.jurisdictionScope)];
  if (scope.length === 0) {
    throw new DashboardError("a dashboard requires at least one authorized jurisdiction");
  }
  if (options.trackedCategories.length === 0) {
    throw new DashboardError(
      "a dashboard requires the tracked categories from the taxonomy pack; without them an empty ward cannot be told from an untracked one",
    );
  }
  const asOfIso = options.asOf.toISOString();
  const cohortDays = options.cohortDays ?? 365;
  const params: MetricParams = {
    asOf: asOfIso,
    knowledgeCutoff: asOfIso,
    windowStart: new Date(options.asOf.getTime() - cohortDays * 86_400_000).toISOString(),
    windowEnd: asOfIso,
    fixedWindowDays: options.fixedWindowDays ?? 30,
  };

  const labels = await jurisdictionLabels(tx, scope);
  const inScope = (key: string): boolean => key === UNPLACED_KEY || labels.has(key);

  const storedCells = (await readSummaryCells(tx, { summaryName })).filter((cell) =>
    inScope(cell.jurisdictionKey),
  );

  const { rows: liveRows } = await tx.query(LIVE_POPULATION_SQL, [null, asOfIso]);
  const live = liveRows
    .map((row) => ({
      jurisdictionKey: String(row["jurisdiction_key"]),
      category: String(row["category"]),
      issueCount: Number(row["issue_count"]),
    }))
    .filter((row) => inScope(row.jurisdictionKey));

  const sourcePopulation = live.reduce((total, row) => total + row.issueCount, 0);
  const projectedTotal = storedCells.reduce((total, cell) => total + cell.issueCount, 0);
  const difference = projectedTotal - sourcePopulation;
  const reconciles = difference === 0;

  const tracked = [...new Set(options.trackedCategories)].sort();
  const trackedSet = new Set(tracked);
  const keys = [...scope, UNPLACED_KEY];
  const byCell = new Map<string, SummaryCell>(
    storedCells.map((cell) => [`${cell.jurisdictionKey}|${cell.category}`, cell]),
  );

  const labelFor = (key: string): string =>
    key === UNPLACED_KEY ? "Not yet placed in a ward" : (labels.get(key) ?? key);

  const status = await summaryStatus(tx, {
    summaryName,
    asOf: options.asOf,
    toleranceSeconds: DEFAULT_FRESHNESS_TOLERANCE_SECONDS,
  });
  // An empty slot only means "none reported" when the projection can be
  // trusted to have looked. Fresh is not enough on its own: a projection that
  // ran a second ago and disagrees with the records has not established
  // anything about the wards it found nothing in.
  const projectionHealthy =
    status.freshness.state === "fresh" &&
    (status.lastReconciliation?.reconciled ?? false) &&
    reconciles;
  const emptyCoverage: CellCoverage = projectionHealthy ? "zero" : "no_data";

  const fromStored = (key: string, stored: SummaryCell): DashboardCell => ({
    jurisdictionKey: key,
    jurisdictionLabel: labelFor(key),
    category: stored.category,
    boundaryVersion: stored.boundaryVersion,
    coverage: "projected",
    tracked: trackedSet.has(stored.category),
    issueCount: stored.issueCount,
    open: stored.open,
    claimed: stored.claimed,
    disputed: stored.disputed,
    confirmed: stored.confirmed,
    reopened: stored.reopened,
    unknownState: stored.unknownState,
    countedParticipants: stored.countedParticipants,
    // The unplaced bucket has no jurisdiction, so no grant covers its
    // records. The count is an aggregate and safe to show; the reports
    // behind it are not this principal's to open.
    drillDownAvailable: key !== UNPLACED_KEY,
  });

  const cells: DashboardCell[] = [];
  for (const key of keys) {
    // Every tracked category, for every authorized ward, present or not.
    for (const category of tracked) {
      const stored = byCell.get(`${key}|${category}`);
      cells.push(
        stored === undefined
          ? {
              jurisdictionKey: key,
              jurisdictionLabel: labelFor(key),
              category,
              boundaryVersion: null,
              coverage: emptyCoverage,
              tracked: true,
              issueCount: 0,
              open: 0,
              claimed: 0,
              disputed: 0,
              confirmed: 0,
              reopened: 0,
              unknownState: 0,
              countedParticipants: 0,
              drillDownAvailable: false,
            }
          : fromStored(key, stored),
      );
    }
    // Plus anything present under a category the pack does not list. Shown
    // without a no_data twin, so an untracked category never manufactures
    // rows — but never hidden either, or the table would stop adding up to
    // the total printed above it.
    for (const stored of storedCells) {
      if (stored.jurisdictionKey !== key) continue;
      if (trackedSet.has(stored.category)) continue;
      cells.push(fromStored(key, stored));
    }
  }

  const age = await unresolvedAge(tx, params, "live");
  const fixedWindow = await fixedWindowResolutionRate(tx, params, "live");
  const reopening = await reopeningRate(tx, params, "live");
  const coverage = await dataCoverage(tx, params, "live");

  const districtNote =
    "Measured across every report in the dataset, not only this ward. V037 defines these three against the whole district; a per-ward version would have an empty denominator in most wards and would read as zero.";

  return {
    asOf: asOfIso,
    jurisdictionScope: scope,
    cells,
    reconciliation: {
      sourcePopulation,
      projectedTotal,
      difference,
      reconciles,
      definition: populationDefinition(scope.length),
      explanation: reconciles
        ? `The ${String(projectedTotal)} reports counted in the table below are exactly the ${String(sourcePopulation)} active reports in the records right now.`
        : `The table below counts ${String(projectedTotal)} reports, but there are ${String(sourcePopulation)} active reports in the records right now — a difference of ${String(Math.abs(difference))}. The summary is behind or incorrect, and nothing on this page should be quoted until it is rebuilt.`,
    },
    metrics: [
      metricOf(age.reading, districtNote),
      metricOf(fixedWindow, districtNote),
      metricOf(reopening, districtNote),
    ],
    coverage: {
      rows: coverage.counts.rows,
      anyDimensionUnknown: coverage.counts.anyDimensionUnknown,
      jurisdictionUnknown: coverage.counts.jurisdictionUnknown,
      wardsWithNoData: cells.filter((cell) => cell.coverage === "no_data").length,
      wardsWithNoReports: cells.filter((cell) => cell.coverage === "zero").length,
      untrackedCategoryCells: cells.filter((cell) => !cell.tracked).length,
      unplacedIssues: cells
        .filter((cell) => cell.jurisdictionKey === UNPLACED_KEY)
        .reduce((total, cell) => total + cell.issueCount, 0),
    },
    summary: status,
    context: await readContextForJurisdictions(tx, {
      jurisdictionIds: scope,
      asOf: options.asOf,
    }),
    contextImports:
      options.jurisdictionProfileId === undefined
        ? []
        : await readImportRuns(tx, { jurisdictionProfileId: options.jurisdictionProfileId }),
    notAdditive: [
      "Counted demo participants are distinct within a ward and must not be added across wards: the same person can report in two of them.",
      "Population figures must not be added across these wards: a block sits inside its district, so the two overlap and their total would count the same people twice.",
      "Rows measured against different boundary directory versions must not be added; their total would describe an area that never existed.",
    ],
  };
};

// ---------------------------------------------------------------------------
// Drill-down
// ---------------------------------------------------------------------------

export type CellIssueRow = {
  readonly publicReference: string;
  readonly state: SummaryState;
  readonly openedAt: string;
  readonly ageHours: number;
  readonly countedParticipants: number;
  readonly activeEvidenceLinks: number;
};

/**
 * The records behind one indicator.
 *
 * Scoped twice: by the cell the reader clicked, and by the jurisdictions their
 * grant actually covers. The second check is not redundant — the cell key
 * arrives from the browser, and a reader who edits it must not thereby reach a
 * ward they have no grant for.
 */
export const readCellIssues = async (
  tx: Queryable,
  options: {
    readonly jurisdictionKey: string;
    readonly category: string;
    readonly jurisdictionScope: readonly string[];
    readonly asOf: Date;
    readonly limit?: number;
    readonly summaryName?: string;
  },
): Promise<readonly CellIssueRow[]> => {
  if (options.jurisdictionKey === UNPLACED_KEY) {
    throw new DashboardError(
      "these reports have not been placed in a ward yet, so no jurisdiction grant covers them; their count is shown but the records cannot be opened here",
    );
  }
  if (!options.jurisdictionScope.includes(options.jurisdictionKey)) {
    throw new DashboardError("this session has no grant for that jurisdiction");
  }
  const { rows } = await tx.query(
    `select c.public_reference, c.current_status, c.opened_at,
            round((extract(epoch from ($3::timestamptz - c.opened_at)) / 3600.0)::numeric, 1)
              as age_hours,
            coalesce(f.counted_participants, 0) as counted_participants,
            coalesce(f.active_evidence_links, 0) as active_evidence_links,
            f.state
       from canonical_issue c
       left join summary_issue_fact f
         on f.summary_name = $5 and f.issue_id = c.issue_id
      where c.jurisdiction_id = $1::uuid
        and c.category = $2
        and coalesce(f.retired_by_merge, false) = false
      order by c.opened_at asc
      limit $4`,
    [
      options.jurisdictionKey,
      options.category,
      options.asOf.toISOString(),
      options.limit ?? 100,
      options.summaryName ?? DISTRICT_CATEGORY_SUMMARY,
    ],
  );
  return rows.map((row) => ({
    publicReference: String(row["public_reference"]),
    state:
      row["state"] === null || row["state"] === undefined
        ? summaryStateOf(String(row["current_status"]))
        : (String(row["state"]) as SummaryState),
    openedAt: new Date(String(row["opened_at"])).toISOString(),
    ageHours: Number(row["age_hours"]),
    countedParticipants: Number(row["counted_participants"]),
    activeEvidenceLinks: Number(row["active_evidence_links"]),
  }));
};

export type EvidenceAvailability =
  "approved_derivative" | "withheld_pending_redaction" | "text_held_not_displayed" | "erased";

export type DashboardEvidenceItem = {
  readonly mediaType: string;
  readonly redactionStatus: string;
  /**
   * The redacted derivative, or `null` where no approved derivative exists.
   *
   * The private original's reference is not in this type at all. A supervisor
   * holds `evidence.read_redacted` and not `evidence.read_original` (V015), and
   * the surest way to honour that is to have no field that could carry it.
   */
  readonly derivativeReference: string | null;
  readonly availability: EvidenceAvailability;
};

export type DashboardIssueDetail = {
  readonly publicReference: string;
  readonly category: string;
  readonly state: SummaryState;
  readonly openedAt: string;
  readonly jurisdictionKey: string;
  readonly countedParticipants: number;
  readonly evidence: readonly DashboardEvidenceItem[];
  readonly evidenceNote: string;
};

export const EVIDENCE_NOTE =
  "Redacted copies only. The original photographs are private and are not reachable from this dashboard; a reviewer opens one through the review queue, for a named reason, and that access is recorded.";

/**
 * One canonical issue and the evidence a supervisor may see.
 *
 * The query selects `derivative_reference` and never `object_reference`. That
 * is deliberate rather than incidental: a select list is a boundary that a
 * later refactor cannot accidentally widen the way a filtered response object
 * can.
 */
export const readIssueDetail = async (
  tx: Queryable,
  options: {
    readonly publicReference: string;
    readonly jurisdictionScope: readonly string[];
    readonly asOf: Date;
    readonly summaryName?: string;
  },
): Promise<DashboardIssueDetail> => {
  const { rows } = await tx.query(
    `select c.issue_id, c.public_reference, c.category, c.current_status, c.opened_at,
            c.jurisdiction_id, coalesce(f.counted_participants, 0) as counted_participants,
            f.state
       from canonical_issue c
       left join summary_issue_fact f on f.summary_name = $2 and f.issue_id = c.issue_id
      where c.public_reference = $1`,
    [options.publicReference, options.summaryName ?? DISTRICT_CATEGORY_SUMMARY],
  );
  const issue = rows[0];
  if (issue === undefined) throw new DashboardError("no such report");

  const jurisdictionId =
    issue["jurisdiction_id"] === null || issue["jurisdiction_id"] === undefined
      ? null
      : String(issue["jurisdiction_id"]);
  if (jurisdictionId === null || !options.jurisdictionScope.includes(jurisdictionId)) {
    throw new DashboardError("this session has no grant for the jurisdiction of that report");
  }

  const { rows: evidenceRows } = await tx.query(
    `select e.media_type, e.redaction_status, e.privacy_state, e.derivative_reference
       from issue_evidence_link l
       join evidence_item e on e.evidence_id = l.evidence_id
      where l.canonical_issue_id = $1::uuid
        and l.effective_from <= $2::timestamptz
        and (l.effective_to is null or l.effective_to > $2::timestamptz)
      order by e.media_type, e.ingested_at`,
    [String(issue["issue_id"]), options.asOf.toISOString()],
  );

  return {
    publicReference: String(issue["public_reference"]),
    category: String(issue["category"]),
    state:
      issue["state"] === null || issue["state"] === undefined
        ? summaryStateOf(String(issue["current_status"]))
        : (String(issue["state"]) as SummaryState),
    openedAt: new Date(String(issue["opened_at"])).toISOString(),
    jurisdictionKey: cellKey(jurisdictionId),
    countedParticipants: Number(issue["counted_participants"]),
    evidence: evidenceRows.map((row) => {
      const derivative =
        row["derivative_reference"] === null || row["derivative_reference"] === undefined
          ? null
          : String(row["derivative_reference"]);
      const erased = String(row["privacy_state"]) === "erased";
      return {
        mediaType: String(row["media_type"]),
        redactionStatus: String(row["redaction_status"]),
        derivativeReference: erased ? null : derivative,
        // Text evidence has no derivative and is not withheld — there is
        // simply nothing to redact in an image sense. Calling it "withheld
        // pending redaction" would invent a queue that does not exist, and
        // showing the citizen's own words on an oversight dashboard is a
        // different decision from showing a redacted photograph; the review
        // queue is where somebody reads them, for a recorded reason.
        availability: erased
          ? "erased"
          : derivative !== null
            ? "approved_derivative"
            : String(row["media_type"]) === "text"
              ? "text_held_not_displayed"
              : "withheld_pending_redaction",
      };
    }),
    evidenceNote: EVIDENCE_NOTE,
  };
};
