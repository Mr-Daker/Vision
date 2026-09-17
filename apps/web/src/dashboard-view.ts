/**
 * Pure presentation rules for the V039 district dashboard.
 *
 * One rule dominates this file: **zero and missing must never render the
 * same.** A ward with a projected cell holding no reports and a ward with no
 * cell at all are different facts, and conflating them produces the specific
 * failure a civic dashboard is most likely to cause — a map where the places
 * nobody could report from look like the places with nothing wrong. `figure`
 * is the single function that turns a cell into something a reader sees, and
 * it returns a different string *and* a different tone for each.
 *
 * The same rule governs the metrics. A V037 measure that is UNKNOWN arrives
 * with a reason from a closed list, and `measureText` renders the reason in
 * words rather than substituting a number. Nothing here can print `0` for a
 * quantity the server said it did not know.
 *
 * No DOM, no network, no clock. `dashboard-main.ts` does all three.
 */

/**
 * What an empty slot means.
 *
 *  - `projected` — a stored cell holds reports.
 *  - `zero` — the projection is healthy and found nothing here.
 *  - `no_data` — the projection is stale, unbuilt, or disagreeing with the
 *    records, so nothing can be concluded about this slot.
 */
export type CellCoverage = "projected" | "zero" | "no_data";

export type SummaryState = "open" | "claimed" | "disputed" | "confirmed" | "reopened" | "unknown";

export type UnknownReason =
  | "empty_denominator"
  | "no_population_source"
  | "dimension_not_reconstructible"
  | "cohort_not_sufficiently_observed"
  | "overlapping_boundaries"
  | "mixed_boundary_versions"
  | "not_additive";

export type MetricValue = {
  readonly value: number | null;
  readonly unknownReason: UnknownReason | null;
};

export type DashboardCell = {
  readonly jurisdictionKey: string;
  readonly jurisdictionLabel: string;
  readonly category: string;
  readonly coverage: CellCoverage;
  readonly tracked: boolean;
  readonly issueCount: number;
  readonly open: number;
  readonly claimed: number;
  readonly disputed: number;
  readonly confirmed: number;
  readonly reopened: number;
  readonly unknownState: number;
  readonly countedParticipants: number;
  readonly drillDownAvailable: boolean;
};

export type DashboardMetric = {
  readonly id: string;
  readonly title: string;
  readonly value: MetricValue;
  readonly unit: string;
  readonly populationNote: string;
  readonly definition: {
    readonly meaning: string;
    readonly numerator: string;
    readonly denominator: { readonly kind: string; readonly of?: string; readonly why?: string };
    readonly missingData: string;
    readonly disclosures: readonly string[];
  };
};

export type ContextValue = {
  readonly datasetId: string;
  readonly datasetLabel: string;
  readonly kind: "population" | "enrolment" | "access" | "investment";
  readonly jurisdictionId: string;
  readonly value: number | null;
  readonly missingIndicator: string | null;
  readonly unit: string;
  readonly vintage: string;
  readonly sourceName: string;
  readonly synthetic: boolean;
  readonly staleness: {
    readonly ageDays: number;
    readonly stale: boolean;
    readonly explanation: string;
  };
  /** The sentence that must be rendered beside the figure. Never omitted. */
  readonly lineage: string;
};

export type ContextImportRun = {
  readonly datasetId: string;
  readonly ranAt: string;
  readonly rowsRead: number;
  readonly rowsLoaded: number;
  readonly rowsRejected: number;
  readonly rejections: readonly {
    readonly code: string;
    readonly detail: string;
    readonly rowIndex: number;
  }[];
};

export type DashboardPayload = {
  readonly asOf: string;
  readonly cells: readonly DashboardCell[];
  readonly reconciliation: {
    readonly sourcePopulation: number;
    readonly projectedTotal: number;
    readonly difference: number;
    readonly reconciles: boolean;
    readonly definition: string;
    readonly explanation: string;
  };
  readonly metrics: readonly DashboardMetric[];
  readonly coverage: {
    readonly rows: number;
    readonly anyDimensionUnknown: number;
    readonly jurisdictionUnknown: number;
    readonly wardsWithNoData: number;
    readonly wardsWithNoReports: number;
    readonly untrackedCategoryCells: number;
    readonly unplacedIssues: number;
  };
  readonly summary: {
    readonly freshness: {
      readonly state: "fresh" | "lagging" | "never_built";
      readonly explanation: string;
      readonly pendingEvents: number;
      readonly unprojectedIssues: number;
    };
    readonly lastRebuildAt: string | null;
    readonly lastReconciliation: {
      readonly ranAt: string;
      readonly reconciled: boolean;
      readonly mismatches: number;
    } | null;
  };
  readonly context: readonly ContextValue[];
  readonly contextImports: readonly ContextImportRun[];
  readonly notAdditive: readonly string[];
  readonly note: string;
};

// ---------------------------------------------------------------------------
// Zero is not missing
// ---------------------------------------------------------------------------

export type Tone = "neutral" | "caution" | "absent";

export type Figure = {
  readonly text: string;
  readonly tone: Tone;
  /** Read by a screen reader in place of the terse cell text. */
  readonly description: string;
};

/**
 * What one cell shows, and how it is to be read.
 *
 * Three outcomes, never two:
 *
 *  - **no data** — nothing has been projected for this ward and category.
 *    Rendered as words rather than a numeral, with its own tone, because a
 *    reader scanning a column of numbers will read any numeral as a
 *    measurement.
 *  - **a real zero** — projected, and there genuinely are no open reports.
 *  - **a count**.
 *
 * The distinction is the V039 acceptance clause, and it lives here rather than
 * in the template so a test can hold it.
 */
export const figure = (cell: DashboardCell): Figure => {
  if (cell.coverage === "no_data") {
    return {
      text: "No data",
      tone: "absent",
      description: `${cell.jurisdictionLabel}, ${cell.category}: the summary is behind the records or has not been checked, so nothing can be said about this. It is not zero reports, and it is not evidence that there is nothing wrong here.`,
    };
  }
  if (cell.coverage === "zero" || cell.issueCount === 0) {
    return {
      text: "0",
      tone: "neutral",
      description: `${cell.jurisdictionLabel}, ${cell.category}: the summary is up to date and matches the records, and no reports are open here.`,
    };
  }
  return {
    text: String(cell.issueCount),
    tone: "neutral",
    description: `${cell.jurisdictionLabel}, ${cell.category}: ${String(cell.issueCount)} report(s).`,
  };
};

const UNKNOWN_REASON_TEXT: Readonly<Record<UnknownReason, string>> = {
  empty_denominator: "nothing was in the population this would be measured over",
  no_population_source: "no population source has been loaded",
  dimension_not_reconstructible: "this cannot be reconstructed for the chosen moment",
  cohort_not_sufficiently_observed: "nothing has been observed for long enough yet",
  overlapping_boundaries: "the areas overlap, so a combined figure would double-count",
  mixed_boundary_versions: "the areas were measured against different boundary versions",
  not_additive: "this quantity cannot be added across areas",
};

/**
 * A measure as text.
 *
 * An unknown measure renders as the word and the reason. It never renders as
 * `0`, and there is no code path here that could: `value` is `null` exactly
 * when the server declined to answer.
 */
export const measureText = (measure: MetricValue, unit: string): string => {
  if (measure.value === null) {
    const reason =
      measure.unknownReason === null
        ? "the server did not say why"
        : UNKNOWN_REASON_TEXT[measure.unknownReason];
    return `Not known — ${reason}`;
  }
  if (unit === "percent") return `${String(measure.value)}%`;
  if (unit === "hours") return `${String(measure.value)} hours`;
  return String(measure.value);
};

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export const STATE_LABELS: Readonly<Record<SummaryState, string>> = {
  open: "Waiting",
  claimed: "Repair claimed, not yet answered",
  disputed: "Disputed",
  confirmed: "Standing confirmed",
  reopened: "Reopened after confirmation",
  unknown: "Cannot be placed",
};

export type EvidenceAvailability =
  "approved_derivative" | "withheld_pending_redaction" | "text_held_not_displayed" | "erased";

export const EVIDENCE_LABELS: Readonly<Record<EvidenceAvailability, string>> = {
  approved_derivative: "Redacted copy",
  withheld_pending_redaction: "Held — no redacted copy has been approved yet",
  text_held_not_displayed: "Written description — read it in the review queue, not here",
  erased: "Erased at the reporter's request",
};

// ---------------------------------------------------------------------------
// Banners
// ---------------------------------------------------------------------------

export type Banner = { readonly tone: Tone; readonly heading: string; readonly detail: string };

/**
 * The totals banner, which is the first thing on the page.
 *
 * When the projection and the records disagree the banner says by how much and
 * says not to quote the page. Putting that under the table, or rendering it in
 * the same tone as the healthy case, would be the same as not saying it.
 */
export const reconciliationBanner = (payload: DashboardPayload): Banner =>
  payload.reconciliation.reconciles
    ? {
        tone: "neutral",
        heading: `${String(payload.reconciliation.projectedTotal)} reports, and the table adds up to them`,
        detail: `${payload.reconciliation.explanation} ${payload.reconciliation.definition}`,
      }
    : {
        tone: "caution",
        heading: "These totals do not add up to the records",
        detail: `${payload.reconciliation.explanation} ${payload.reconciliation.definition}`,
      };

export const freshnessBanner = (payload: DashboardPayload): Banner => {
  const { freshness, lastReconciliation } = payload.summary;
  const check =
    lastReconciliation === null
      ? "The summary has never been checked against a clean rebuild."
      : lastReconciliation.reconciled
        ? `Last checked against a clean rebuild at ${lastReconciliation.ranAt}, and it matched.`
        : `The last check found ${String(lastReconciliation.mismatches)} mismatch(es) against a clean rebuild.`;
  const healthy = freshness.state === "fresh" && (lastReconciliation?.reconciled ?? false);
  return {
    tone: healthy ? "neutral" : "caution",
    heading:
      freshness.state === "never_built"
        ? "This summary has never been built"
        : freshness.state === "lagging"
          ? "This summary is behind the record"
          : "Summary is up to date",
    detail: `${freshness.explanation} ${check}`,
  };
};

/**
 * The coverage banner.
 *
 * Reports the three ways this page is incomplete rather than a single
 * percentage. A reader needs to know which kind of gap they are looking at:
 * wards with nothing projected, reports that were never placed in a ward, and
 * reports filed under a category the deployment does not track are three
 * different problems with three different fixes.
 */
export const coverageBanner = (payload: DashboardPayload): Banner => {
  const { coverage } = payload;
  const gaps = [
    `${String(coverage.wardsWithNoData)} ward-and-category combination(s) cannot be reported on at all`,
    `${String(coverage.unplacedIssues)} report(s) have not been placed in a ward`,
    `${String(coverage.untrackedCategoryCells)} group(s) are filed under a category this deployment does not track`,
  ];
  const clean = coverage.wardsWithNoData === 0 && coverage.unplacedIssues === 0;
  return {
    tone: clean ? "neutral" : "caution",
    heading: clean ? "Every tracked ward has data" : "Where this page is incomplete",
    detail: `${gaps.join("; ")}. Missing coverage is not zero incidence: a ward with no data has not been shown to have no problems.`,
  };
};

// ---------------------------------------------------------------------------
// Shaping
// ---------------------------------------------------------------------------

export type WardRow = {
  readonly jurisdictionKey: string;
  readonly jurisdictionLabel: string;
  readonly cells: readonly DashboardCell[];
  /** Reports in categories the taxonomy pack does not list. */
  readonly untrackedTotal: number;
  readonly total: number;
  readonly hasAnyData: boolean;
};

/**
 * Groups cells by ward, keeping every ward in scope.
 *
 * A ward whose every cell is `no_data` still gets a row. Dropping it would be
 * the table-level version of the same mistake `figure` prevents at the cell
 * level.
 */
export const byWard = (payload: DashboardPayload): readonly WardRow[] => {
  const wards = new Map<string, DashboardCell[]>();
  for (const cell of payload.cells) {
    const existing = wards.get(cell.jurisdictionKey);
    if (existing === undefined) wards.set(cell.jurisdictionKey, [cell]);
    else existing.push(cell);
  }
  return [...wards.entries()]
    .map(([jurisdictionKey, cells]) => ({
      jurisdictionKey,
      jurisdictionLabel: cells[0]?.jurisdictionLabel ?? jurisdictionKey,
      cells: [...cells].sort((a, b) => a.category.localeCompare(b.category)),
      // Carried as its own column so every row adds up on screen. A ward total
      // that exceeds the visible columns is the same failure as a total that
      // does not match the records, one level down.
      untrackedTotal: cells
        .filter((cell) => !cell.tracked)
        .reduce((sum, cell) => sum + cell.issueCount, 0),
      total: cells.reduce((sum, cell) => sum + cell.issueCount, 0),
      hasAnyData: cells.some((cell) => cell.coverage === "projected"),
    }))
    .sort((a, b) => {
      // The unplaced bucket last: it is a data-quality row, not a ward.
      if (a.jurisdictionKey === "UNKNOWN") return 1;
      if (b.jurisdictionKey === "UNKNOWN") return -1;
      return a.jurisdictionLabel.localeCompare(b.jurisdictionLabel);
    });
};

/** Categories present anywhere in the payload, in a stable column order. */
export const categoriesOf = (payload: DashboardPayload): readonly string[] =>
  [...new Set(payload.cells.filter((cell) => cell.tracked).map((cell) => cell.category))].sort();

export const untrackedOf = (payload: DashboardPayload): readonly DashboardCell[] =>
  payload.cells
    .filter((cell) => !cell.tracked && cell.issueCount > 0)
    .sort((a, b) => b.issueCount - a.issueCount);

export const categoryLabel = (category: string): string =>
  category.replace(/[_-]/g, " ").replace(/^./, (first) => first.toUpperCase());

// ---------------------------------------------------------------------------
// Context (V040)
// ---------------------------------------------------------------------------

export const CONTEXT_KIND_LABELS: Readonly<
  Record<ContextValue["kind"], { readonly label: string; readonly unitWords: string }>
> = {
  population: { label: "Resident population", unitWords: "people" },
  enrolment: { label: "School enrolment", unitWords: "students" },
  access: { label: "Households with a piped connection", unitWords: "% of households" },
  investment: { label: "Sanctioned investment", unitWords: "₹" },
};

export type ContextFigure = {
  readonly text: string;
  readonly tone: Tone;
  /** Never empty: a figure with no lineage is refused before it can be shown. */
  readonly lineage: string;
  readonly stale: boolean;
};

/**
 * One context figure, ready to render.
 *
 * Returns `undefined` for a value that could not carry a lineage sentence,
 * which is how "every displayed context value links to a source record or is
 * visibly synthetic" is kept true by construction rather than by review: there
 * is no way to obtain renderable text for a value that has no source.
 */
export const contextFigure = (value: ContextValue): ContextFigure | undefined => {
  if (value.lineage.trim().length === 0 || value.sourceName.trim().length === 0) return undefined;
  if (value.value === null) {
    return {
      text: "Not known",
      tone: "absent",
      lineage: value.lineage,
      stale: value.staleness.stale,
    };
  }
  const words = CONTEXT_KIND_LABELS[value.kind].unitWords;
  return {
    text:
      value.kind === "investment"
        ? `₹${value.value.toLocaleString("en-IN")}`
        : `${String(value.value)} ${words}`,
    tone: value.staleness.stale ? "caution" : "neutral",
    lineage: value.lineage,
    stale: value.staleness.stale,
  };
};

/** Context grouped by ward, in a stable order. */
export const contextByWard = (
  payload: DashboardPayload,
): readonly { readonly jurisdictionId: string; readonly values: readonly ContextValue[] }[] => {
  const wards = new Map<string, ContextValue[]>();
  for (const value of payload.context) {
    const existing = wards.get(value.jurisdictionId);
    if (existing === undefined) wards.set(value.jurisdictionId, [value]);
    else existing.push(value);
  }
  return [...wards.entries()]
    .map(([jurisdictionId, values]) => ({
      jurisdictionId,
      values: [...values].sort((a, b) => a.kind.localeCompare(b.kind)),
    }))
    .sort((a, b) => a.jurisdictionId.localeCompare(b.jurisdictionId));
};

/**
 * What the last context import refused.
 *
 * Returns a banner even when nothing was refused, because "0 rows refused" is
 * a different statement from an absent section, and a reader who never sees
 * the line cannot tell which they are looking at.
 */
export const contextImportBanner = (payload: DashboardPayload): Banner => {
  const refused = payload.contextImports.reduce((total, run) => total + run.rowsRejected, 0);
  const loaded = payload.contextImports.reduce((total, run) => total + run.rowsLoaded, 0);
  if (payload.contextImports.length === 0) {
    return {
      tone: "absent",
      heading: "No context data has been imported",
      detail:
        "No population, enrolment, access or investment figures have been loaded for these wards. That is not the same as those figures being zero.",
    };
  }
  return {
    tone: refused === 0 ? "neutral" : "caution",
    heading:
      refused === 0
        ? `${String(loaded)} context figure(s) loaded, none refused`
        : `${String(refused)} context row(s) were refused and not loaded`,
    detail:
      refused === 0
        ? "Every row in the last import was accepted. Figures that were absent in the source are stored as unknown, not as zero."
        : "Rows with an unrecognised unit, an identifier that matches nothing, or an unreadable value are refused rather than converted into a plausible figure. Each refusal is listed below with its reason.",
  };
};
