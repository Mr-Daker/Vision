/**
 * Analytics metric semantics (roadmap V037).
 *
 * This file is the specification. Every metric this system is allowed to
 * publish is declared here as data — its population, its denominator, its
 * horizon, what it excludes, and what may not be done with the result — and
 * `analytics-metrics.ts` in the adapter layer executes exactly this list. A
 * test holds the two in one-to-one correspondence, so a number can never
 * appear on a screen without a contract saying what it means, and a contract
 * can never sit here describing a number nothing computes.
 *
 * Four rules run through all fifteen of them.
 *
 * **Missing stays missing.** An absent value is `null` and carries a reason.
 * Substituting `0` for "we do not know" is the single most common way a civic
 * dashboard invents good news: no reports from a ward reads as no problems
 * there, when it far more often means nobody could file one.
 *
 * **A rate must name its population.** `denominator` is a discriminated field,
 * so a percentage cannot be declared without saying what it is a percentage
 * of, and a count has to say in words why it has no denominator. A zero
 * denominator yields `null`, never `0` and never a division error.
 *
 * **Speed never travels alone.** Averages computed only over resolved issues
 * flatter any backlog: the slowest cases are precisely the ones still open, so
 * excluding them makes a department look faster the more it neglects. Every
 * speed figure here is carried inside a structure that also carries how many
 * are still waiting, and `speedStatement` cannot render one without the other.
 *
 * **Some numbers do not add up.** Distinct counts of people and externally
 * sourced populations are not additive across areas. Two wards each reporting
 * nine contributors are not eighteen contributors, and two overlapping
 * boundaries cannot have their populations summed at all. `combineAcrossBoundaries`
 * refuses rather than returning a plausible wrong total.
 *
 * Pure: no clock, no storage, no network. Every horizon is supplied.
 */

export type MetricId =
  | "M01"
  | "M02"
  | "M03"
  | "M04"
  | "M05"
  | "M06"
  | "M07"
  | "M08"
  | "M09"
  | "M10"
  | "M11"
  | "M12"
  | "M13"
  | "M14"
  | "M15";

export const METRIC_IDS: readonly MetricId[] = [
  "M01",
  "M02",
  "M03",
  "M04",
  "M05",
  "M06",
  "M07",
  "M08",
  "M09",
  "M10",
  "M11",
  "M12",
  "M13",
  "M14",
  "M15",
];

export type MetricUnit = "count" | "percent" | "hours" | "population";

/**
 * What may be done with two of these from two different areas.
 *
 *  - `additive` — disjoint areas may be summed.
 *  - `not_additive` — a distinct count. Summing double-counts anybody who
 *    appears in both, and there is no way to detect that from the totals.
 *  - `requires_exclusive_boundaries` — summable only where the boundaries are
 *    proven not to overlap, which for an external population means proven from
 *    the source, not assumed from the names.
 */
export type AggregationSafety = "additive" | "not_additive" | "requires_exclusive_boundaries";

/** A rate names its population; a count says why it has none. */
export type MetricDenominator =
  | { readonly kind: "none"; readonly why: string }
  | { readonly kind: "population"; readonly of: string };

/**
 * Which clock bounds the metric.
 *
 *  - `as_of` — a state snapshot at one instant.
 *  - `window` — a cohort defined by a half-open interval `[start, end)`.
 */
export type MetricHorizon = "as_of" | "window";

export type MetricContract = {
  readonly id: MetricId;
  readonly title: string;
  readonly meaning: string;
  readonly unit: MetricUnit;
  readonly numerator: string;
  readonly denominator: MetricDenominator;
  readonly cohort: string;
  readonly inclusions: readonly string[];
  readonly exclusions: readonly string[];
  readonly horizon: MetricHorizon;
  readonly aliasSemantics: string;
  readonly corrections: string;
  readonly missingData: string;
  readonly aggregation: AggregationSafety;
  readonly disclosures: readonly string[];
};

/**
 * Why a value is absent. Always populated when a value is `null`, so a caller
 * never has to guess between "nothing happened", "nobody was in the
 * denominator" and "this cannot be reconstructed".
 */
export type UnknownReason =
  | "empty_denominator"
  | "no_population_source"
  /** A source exists and was loaded; it said it did not know (V040). */
  | "source_reported_unknown"
  | "dimension_not_reconstructible"
  | "cohort_not_sufficiently_observed"
  | "overlapping_boundaries"
  | "mixed_boundary_versions"
  | "not_additive";

export type MetricValue = {
  readonly value: number | null;
  readonly unknownReason: UnknownReason | null;
};

export const known = (value: number): MetricValue => ({ value, unknownReason: null });

export const unknown = (reason: UnknownReason): MetricValue => ({
  value: null,
  unknownReason: reason,
});

// ---------------------------------------------------------------------------
// Denominator safety
// ---------------------------------------------------------------------------

/**
 * A percentage, or `null` where the population is empty or unknown.
 *
 * Zero in the denominator is not an error and not zero percent: it is the
 * absence of anybody to measure. Reporting `0%` for a ward nobody filed from
 * would read as a total failure to fix anything, which is a different claim
 * entirely from having nothing to fix yet.
 */
export const ratio = (numerator: number | null, denominator: number | null): MetricValue => {
  if (numerator === null || denominator === null) return unknown("empty_denominator");
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) {
    return unknown("empty_denominator");
  }
  if (denominator === 0) return unknown("empty_denominator");
  return known(Math.round((numerator / denominator) * 1000) / 10);
};

/** Elapsed-hour semantics, one decimal place. Never calendar days. */
export const elapsedHours = (fromMs: number, toMs: number): number =>
  Math.round(((toMs - fromMs) / 3_600_000) * 10) / 10;

// ---------------------------------------------------------------------------
// Cohort observation
// ---------------------------------------------------------------------------

/**
 * Whether a fixed-window cohort member has been observed long enough to belong
 * in the denominator.
 *
 * An issue opened yesterday cannot yet have failed a thirty-day window, and
 * counting it as a failure is how a fixed-window rate drops every time
 * reporting picks up. It is excluded from both sides until its window closes.
 */
export const isSufficientlyObserved = (
  openedAtMs: number,
  windowDays: number,
  asOfMs: number,
): boolean => openedAtMs + windowDays * 86_400_000 <= asOfMs;

/**
 * Whether reopening inside the observation window invalidates the resolution.
 *
 * It does. A repair that failed within the window it was measured against was
 * not a resolution inside that window, and counting it as one would let a
 * department bank the credit for work that did not hold. A reopening *after*
 * the window closes leaves the historical figure alone — that number was true
 * of the period it describes, and silently restating closed history is its own
 * kind of dishonesty.
 */
export const REOPENING_WITHIN_WINDOW_INVALIDATES = true;

export const standsAtWindowEnd = (input: {
  readonly openedAtMs: number;
  readonly windowDays: number;
  readonly firstConfirmedAtMs: number | null;
  readonly firstReopenedAtMs: number | null;
}): boolean => {
  const windowEnd = input.openedAtMs + input.windowDays * 86_400_000;
  if (input.firstConfirmedAtMs === null) return false;
  if (input.firstConfirmedAtMs > windowEnd) return false;
  if (input.firstReopenedAtMs === null) return true;
  return input.firstReopenedAtMs > windowEnd;
};

// ---------------------------------------------------------------------------
// Speed, which never travels alone
// ---------------------------------------------------------------------------

/**
 * Time to resolution, kept in four separated components.
 *
 * There is deliberately no single `averageResolutionHours` field. One number
 * cannot honestly answer "how fast is this", because first confirmation,
 * resolution that held, and the gap before a reopening measure three different
 * things — and none of them mean anything without the count of issues that
 * have no resolution time at all because they are still open.
 */
export type ResolutionSpeed = {
  /** Roots in the cohort that reached a standing confirmation. */
  readonly resolvedCount: number;
  /** Roots in the cohort that have not. These have no resolution time. */
  readonly stillWaitingCount: number;
  /** Opened to first confirmation. */
  readonly firstConfirmationHoursMedian: number | null;
  /** Opened to the confirmation that currently stands, less reopened gaps. */
  readonly standingResolutionHoursMedian: number | null;
  /** Confirmation to the reopening that followed it. */
  readonly reopeningCycleHoursMedian: number | null;
};

/** The share of the cohort any speed figure was computed from. */
export const speedCoverage = (speed: ResolutionSpeed): MetricValue =>
  ratio(speed.resolvedCount, speed.resolvedCount + speed.stillWaitingCount);

/**
 * The only supported rendering of a speed figure.
 *
 * It always states how many are still waiting, including when that number is
 * zero, because a reader who never sees the field cannot tell whether it was
 * absent or omitted. This is the V037 acceptance clause "resolved-only speed
 * does not hide unresolved cases" expressed as the single code path that can
 * produce the sentence.
 */
export const speedStatement = (speed: ResolutionSpeed): string => {
  const waiting =
    speed.stillWaitingCount === 1
      ? "1 issue in this group is still waiting"
      : `${speed.stillWaitingCount} issues in this group are still waiting`;
  if (speed.resolvedCount === 0 || speed.firstConfirmationHoursMedian === null) {
    return `No resolution time can be reported: nothing in this group has a standing confirmed resolution, and ${waiting}.`;
  }
  return (
    `Median ${speed.firstConfirmationHoursMedian} hours to first confirmation, ` +
    `measured over the ${speed.resolvedCount} that reached one; ${waiting}.`
  );
};

/** Median of a sample, `null` for an empty one. Never `0` for "none". */
export const median = (samples: readonly number[]): number | null => {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const value =
    sorted.length % 2 === 1
      ? (sorted[middle] ?? 0)
      : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
  return Math.round(value * 10) / 10;
};

// ---------------------------------------------------------------------------
// Aggregation across boundaries
// ---------------------------------------------------------------------------

/**
 * One area's value, with the boundary version it was measured against.
 *
 * The version travels with the number because ward boundaries get redrawn.
 * Adding a figure measured against one directory version to a figure measured
 * against another produces a total for an area that never existed.
 */
export type BoundaryPart = {
  readonly boundaryId: string;
  readonly boundaryVersion: string;
  readonly value: number | null;
};

export type Combination =
  | { readonly ok: true; readonly value: MetricValue }
  | { readonly ok: false; readonly reason: string; readonly unknownReason: UnknownReason };

/**
 * Combines per-area values, or refuses.
 *
 * Refusing is the point. Every one of these rejections corresponds to a total
 * somebody would otherwise publish: distinct contributors summed into a
 * headcount, populations added across areas that overlap, or two boundary
 * versions silently reconciled.
 */
export const combineAcrossBoundaries = (
  contract: MetricContract,
  parts: readonly BoundaryPart[],
  boundaries: { readonly mutuallyExclusive: boolean },
): Combination => combineValues(contract.id, contract.aggregation, parts, boundaries);

/**
 * The same refusals, addressable by label rather than by metric contract.
 *
 * V038's summary cells are not metric contracts but obey identical rules — a
 * distinct participant count is no more summable because it lives in a
 * projection table. Both callers share this function so the two can never
 * drift into disagreeing about what may be added.
 */
export const combineValues = (
  label: string,
  aggregation: AggregationSafety,
  parts: readonly BoundaryPart[],
  boundaries: { readonly mutuallyExclusive: boolean },
): Combination => {
  if (aggregation === "not_additive") {
    return {
      ok: false,
      unknownReason: "not_additive",
      reason: `${label} counts distinct subjects within one area. Summing two areas counts anybody present in both twice, and the totals carry nothing that would reveal it. Recompute over the combined area instead.`,
    };
  }

  const seen = new Set<string>();
  for (const part of parts) {
    if (seen.has(part.boundaryId)) {
      return {
        ok: false,
        unknownReason: "overlapping_boundaries",
        reason: `boundary '${part.boundaryId}' appears twice in this combination`,
      };
    }
    seen.add(part.boundaryId);
  }

  const versions = new Set(parts.map((part) => part.boundaryVersion));
  if (versions.size > 1) {
    return {
      ok: false,
      unknownReason: "mixed_boundary_versions",
      reason: `these values were measured against different boundary versions (${[...versions].sort().join(", ")}), so their total describes no real area`,
    };
  }

  if (aggregation === "requires_exclusive_boundaries" && !boundaries.mutuallyExclusive) {
    return {
      ok: false,
      unknownReason: "overlapping_boundaries",
      reason: `${label} may only be combined across boundaries proven not to overlap. Overlap has not been established for these, and an unproven assumption of disjointness is what double-counts a shared area.`,
    };
  }

  // Missing stays missing: one unknown area makes the total unknown rather
  // than making it the sum of the areas that happened to answer.
  if (parts.some((part) => part.value === null)) {
    return { ok: true, value: unknown("dimension_not_reconstructible") };
  }
  return {
    ok: true,
    value: known(parts.reduce((total, part) => total + (part.value ?? 0), 0)),
  };
};

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * Phrasing that overstates what this system knows.
 *
 * Each of these is a specific overclaim rather than a style preference. The
 * system records that somebody said a repair looks done; it has not inspected
 * anything, has not certified anything, and does not know how many people a
 * problem affects. Checked against metric titles and measurement descriptions,
 * not against the disclosures — a disclosure has to be free to say plainly
 * that people agreed, because that is exactly what happened.
 */
export const BANNED_MEASUREMENT_PHRASES: readonly {
  readonly pattern: RegExp;
  readonly instead: string;
}[] = [
  { pattern: /successfully closed/i, instead: "standing confirmed" },
  { pattern: /closed successfully/i, instead: "standing confirmed" },
  { pattern: /\bverified repair/i, instead: "claimed repair, confirmed by participants" },
  { pattern: /\bcertifi(?:ed|cation)\b/i, instead: "confirmed by participants" },
  { pattern: /\brejected\b/i, instead: "disputed" },
  { pattern: /\bnumber of people\b/i, instead: "counted demo participants" },
  { pattern: /\baffected population\b/i, instead: "estimated population from an external source" },
  { pattern: /\bresidents affected\b/i, instead: "counted demo participants" },
];

export const vocabularyViolations = (text: string): readonly string[] =>
  BANNED_MEASUREMENT_PHRASES.filter((banned) => banned.pattern.test(text)).map(
    (banned) => `"${text.match(banned.pattern)?.[0] ?? ""}" — say "${banned.instead}" instead`,
  );

// ---------------------------------------------------------------------------
// Disclosures reused by more than one contract
// ---------------------------------------------------------------------------

export const CONFIRMATION_DISCLOSURE =
  "A confirmed repair means the people who reported it agreed the problem looks fixed. It is not an inspection and not an engineer's certification.";

export const CONTRIBUTOR_DISCLOSURE =
  "A count of counted demo participants. It does not mean nobody else is affected, and it is not evidence that the reports are accurate.";

export const POPULATION_DISCLOSURE =
  "Population comes from a named source with its own unit, vintage and licence, and is shown with all three. Report volume is never used to estimate how many people a problem affects. The figures loaded in this demonstration are team-created synthetic data: they describe no real place and must not be quoted as a statistic about anywhere.";

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

const ALIAS_AT_HORIZON =
  "Alias edges active at the horizon are followed to the canonical root; a cycle or a chain longer than 16 hops resolves to nothing and is excluded from every count rather than guessed at. Child data folds into the root.";

const LEDGER_STATUS =
  "Status at a past horizon is reconstructed from status_event bounded by both occurred_at and the knowledge cutoff, so a later state never leaks backwards. Where the ledger cannot establish it, the dimension is UNKNOWN.";

export const METRIC_CATALOGUE: Readonly<Record<MetricId, MetricContract>> = {
  M01: {
    id: "M01",
    title: "Current backlog",
    meaning: "Canonical issues that are open at the horizon and have no standing confirmation.",
    unit: "count",
    numerator:
      "Distinct active canonical roots whose reconstructed status at the horizon is not resolution_confirmed.",
    denominator: { kind: "none", why: "A count of open work, not a share of anything." },
    cohort: "Every canonical root opened at or before the horizon.",
    inclusions: ["Open", "claimed but unconfirmed", "disputed", "reopened"],
    exclusions: ["Standing confirmed issues", "Issues retired by an active alias at the horizon"],
    horizon: "as_of",
    aliasSemantics: ALIAS_AT_HORIZON,
    corrections: LEDGER_STATUS,
    missingData: "An issue whose status cannot be reconstructed is reported as UNKNOWN, not open.",
    aggregation: "additive",
    disclosures: [],
  },

  M02: {
    id: "M02",
    title: "Backlog by category and jurisdiction",
    meaning: "The current backlog split by category and jurisdiction.",
    unit: "count",
    numerator: "M01 grouped by the root's category and jurisdiction.",
    denominator: { kind: "none", why: "A count per group, not a share of anything." },
    cohort: "Every canonical root opened at or before the horizon.",
    inclusions: ["Open", "claimed but unconfirmed", "disputed", "reopened"],
    exclusions: ["Standing confirmed issues", "Issues retired by an active alias at the horizon"],
    horizon: "as_of",
    aliasSemantics: ALIAS_AT_HORIZON,
    corrections:
      "Category and jurisdiction are corrected in place on canonical_issue with no effective-dated history, so neither can be reconstructed for a past horizon. At a past horizon both dimensions read UNKNOWN rather than borrowing today's value.",
    missingData: "A null jurisdiction is UNKNOWN and is never folded into another group.",
    aggregation: "additive",
    disclosures: [],
  },

  M03: {
    id: "M03",
    title: "Accepted issue cohort",
    meaning: "Distinct canonical roots opened inside a window.",
    unit: "count",
    numerator: "Distinct roots whose opened_at falls in [window_start, window_end).",
    denominator: { kind: "none", why: "A cohort size, which is itself a denominator for M04." },
    cohort: "Roots opened in [window_start, window_end).",
    inclusions: ["Every accepted issue in the window"],
    exclusions: ["Submissions that never became a canonical issue"],
    horizon: "window",
    aliasSemantics: `${ALIAS_AT_HORIZON} Membership is fixed at the window end; a later merge does not retrospectively change who was in the cohort.`,
    corrections: LEDGER_STATUS,
    missingData: "Not applicable: opened_at is mandatory.",
    aggregation: "additive",
    disclosures: [],
  },

  M04: {
    id: "M04",
    title: "Standing resolution rate, status as of a date",
    meaning:
      "The share of one opened cohort that is standing confirmed at the horizon. A status snapshot, not a speed.",
    unit: "percent",
    numerator: "Cohort roots whose reconstructed status at the horizon is resolution_confirmed.",
    denominator: { kind: "population", of: "Every root in the opened cohort (M03)." },
    cohort: "Roots opened in [window_start, window_end).",
    inclusions: ["Roots standing confirmed at the horizon"],
    exclusions: ["Roots currently reopened, disputed, or claimed but unconfirmed"],
    horizon: "window",
    aliasSemantics: ALIAS_AT_HORIZON,
    corrections:
      "A reopening at or before the horizon removes the root from the numerator, because the resolution no longer stands.",
    missingData: "An empty cohort yields UNKNOWN, never 0%.",
    aggregation: "additive",
    disclosures: [CONFIRMATION_DISCLOSURE],
  },

  M05: {
    id: "M05",
    title: "Fixed-window resolution rate",
    meaning:
      "The share of a cohort that reached a confirmation within the window and still stood at the window's end. Comparable between cohorts in a way M04 is not.",
    unit: "percent",
    numerator:
      "Cohort roots first confirmed at or before opened_at + window, with no reopening at or before that same instant.",
    denominator: {
      kind: "population",
      of: "Cohort roots whose window has fully elapsed at the horizon. Younger roots are in neither the numerator nor the denominator.",
    },
    cohort: "Roots opened in [window_start, window_end) and observed for the full window.",
    inclusions: ["Resolutions that still stood at the window's end"],
    exclusions: [
      "Roots not yet observed for the full window",
      "Roots confirmed inside the window and reopened inside it",
    ],
    horizon: "window",
    aliasSemantics: ALIAS_AT_HORIZON,
    corrections:
      "A reopening after the window closes does not restate the historical figure; the resolution did stand for the period the number describes.",
    missingData: "No sufficiently observed root yields UNKNOWN, never 0%.",
    aggregation: "additive",
    disclosures: [CONFIRMATION_DISCLOSURE],
  },

  M06: {
    id: "M06",
    title: "Time to resolution",
    meaning:
      "Separated duration components, reported only alongside the count of issues that have no resolution time because they are still open.",
    unit: "hours",
    numerator:
      "Median elapsed hours for first confirmation, for the resolution that currently stands, and for the gap before a reopening.",
    denominator: {
      kind: "population",
      of: "The resolved part of the cohort, reported with the unresolved remainder so the coverage of every figure is visible.",
    },
    cohort: "Roots opened in [window_start, window_end).",
    inclusions: [
      "First-confirmation duration",
      "Standing-resolution duration, less reopened gaps",
      "Reopening-cycle duration",
      "The count of roots with no resolution time",
    ],
    exclusions: ["Any single headline average that omits the unresolved remainder"],
    horizon: "window",
    aliasSemantics: "Durations are measured on the canonical root's own lifecycle events.",
    corrections: "Gaps are recomputed from status_event, so a late correction changes the figure.",
    missingData: "No resolved root yields UNKNOWN for every duration, never 0 hours.",
    aggregation: "not_additive",
    disclosures: [CONFIRMATION_DISCLOSURE],
  },

  M07: {
    id: "M07",
    title: "Age of unresolved issues",
    meaning: "Elapsed hours since opening for everything still in the backlog.",
    unit: "hours",
    numerator: "Median and maximum elapsed hours from opened_at to the horizon.",
    denominator: { kind: "population", of: "The current backlog (M01)." },
    cohort: "Unresolved roots at the horizon.",
    inclusions: ["Open", "claimed but unconfirmed", "disputed", "reopened"],
    exclusions: ["Standing confirmed issues"],
    horizon: "as_of",
    aliasSemantics: "Age is measured on the canonical root.",
    corrections: "None: opened_at is not corrected.",
    missingData: "An empty backlog yields UNKNOWN, never 0 hours.",
    aggregation: "not_additive",
    disclosures: [],
  },

  M08: {
    id: "M08",
    title: "Claims awaiting a response",
    meaning: "Repair claims recorded by staff that nobody has confirmed or disputed yet.",
    unit: "count",
    numerator: "Distinct roots whose reconstructed status at the horizon is resolution_claimed.",
    denominator: { kind: "none", why: "A count of outstanding responses." },
    cohort: "Backlog roots.",
    inclusions: ["Claims with no confirmation and no dispute"],
    exclusions: ["Claims already confirmed", "Claims already disputed", "Reopened issues"],
    horizon: "as_of",
    aliasSemantics: ALIAS_AT_HORIZON,
    corrections: LEDGER_STATUS,
    missingData: "Not applicable.",
    aggregation: "additive",
    disclosures: [
      "A claim is a department's account of its own work. It is not a resolution until somebody who reported the problem responds.",
    ],
  },

  M09: {
    id: "M09",
    title: "Disputed resolutions",
    meaning: "Claims a participant has disputed and that nobody has since resolved.",
    unit: "count",
    numerator: "Distinct roots whose reconstructed status at the horizon is resolution_disputed.",
    denominator: { kind: "none", why: "A count of open disagreements." },
    cohort: "Backlog roots.",
    inclusions: ["Disputes still standing at the horizon"],
    exclusions: [
      "Disputes a reviewer overruled, which become standing confirmed",
      "Disputes returned to the crew, which become planned work",
    ],
    horizon: "as_of",
    aliasSemantics: ALIAS_AT_HORIZON,
    corrections: LEDGER_STATUS,
    missingData: "Not applicable.",
    aggregation: "additive",
    disclosures: [],
  },

  M10: {
    id: "M10",
    title: "Reopening rate",
    meaning: "The share of issues that reached a confirmation and were later reopened.",
    unit: "percent",
    numerator:
      "Roots with at least one issue_reopened event at or before the horizon, among those that had been confirmed.",
    denominator: {
      kind: "population",
      of: "Roots that reached resolution_confirmed at least once at or before the horizon.",
    },
    cohort: "Every root ever confirmed at or before the horizon.",
    inclusions: ["Roots reopened at least once"],
    exclusions: ["Roots never confirmed, which could not be reopened"],
    horizon: "as_of",
    aliasSemantics: ALIAS_AT_HORIZON,
    corrections: "Reconstructed from the event ledger, so a late-recorded reopening changes it.",
    missingData: "No confirmed root yields UNKNOWN, never 0%.",
    aggregation: "additive",
    disclosures: [
      "A reopening is a sign the system worked, not that it failed: somebody was able to say a repair had not held.",
    ],
  },

  M11: {
    id: "M11",
    title: "Standing confirmed resolutions",
    meaning: "Issues whose confirmation stands at the horizon and that are not currently reopened.",
    unit: "count",
    numerator: "Distinct roots whose reconstructed status at the horizon is resolution_confirmed.",
    denominator: { kind: "none", why: "A count; M04 is the rate built on it." },
    cohort: "Every canonical root opened at or before the horizon.",
    inclusions: ["Standing confirmations"],
    exclusions: ["Issues reopened at or before the horizon"],
    horizon: "as_of",
    aliasSemantics: ALIAS_AT_HORIZON,
    corrections: LEDGER_STATUS,
    missingData: "Not applicable.",
    aggregation: "additive",
    disclosures: [CONFIRMATION_DISCLOSURE],
  },

  M12: {
    id: "M12",
    title: "Unique counted demo participants",
    meaning: "Distinct participants whose participation counts, folded across merged issues.",
    unit: "count",
    numerator:
      "Distinct participant_id with counted = true across the active alias closure of each root.",
    denominator: { kind: "none", why: "A distinct count of subjects, not a share." },
    cohort: "Participants attached to a canonical root at the horizon.",
    inclusions: [
      "Participation rows with counted = true and first evidence at or before the horizon",
    ],
    exclusions: ["Participation explicitly not counted, with its recorded reason"],
    horizon: "as_of",
    aliasSemantics:
      "A merge unions contributors into the surviving root; it never adds the two totals.",
    corrections: "Reconstructed from first_evidence_at.",
    missingData: "Not applicable.",
    aggregation: "not_additive",
    disclosures: [CONTRIBUTOR_DISCLOSURE],
  },

  M13: {
    id: "M13",
    title: "Evidence and submission volumes",
    meaning: "How much evidence is attached, kept separate from how many people reported.",
    unit: "count",
    numerator:
      "Four separated counts: distinct submissions, links active at the horizon, links ever created before the horizon, and completion-evidence items attached to resolution claims.",
    denominator: { kind: "none", why: "Volumes, not shares. Never a proxy for concern." },
    cohort: "Evidence belonging to a canonical root's alias closure.",
    inclusions: [
      "Active links for the active count",
      "Every historical link for the historical count",
    ],
    exclusions: ["Superseded or corrected links, for the active count only"],
    horizon: "as_of",
    aliasSemantics: "Summed across the active alias closure.",
    corrections: "Reconstructed from effective_from and effective_to.",
    missingData: "Not applicable.",
    aggregation: "additive",
    disclosures: [
      "Evidence volume measures how much was uploaded, not how many people are affected and not how serious anything is.",
    ],
  },

  M14: {
    id: "M14",
    title: "Estimated population served",
    meaning: "Population for a jurisdiction, taken only from a named external source.",
    unit: "population",
    numerator:
      "The value the loaded context source published for that boundary, carried with its unit, its vintage and its licence. Nothing is converted between units.",
    denominator: { kind: "none", why: "An externally sourced size, not a computed share." },
    cohort: "Jurisdiction boundaries.",
    inclusions: ["Values carrying a source, a unit, and a vintage"],
    exclusions: ["Anything derived from report volume or contributor counts"],
    horizon: "as_of",
    aliasSemantics: "Not applicable.",
    corrections:
      "Managed by the V040 context import, which replaces a dataset's observations wholesale and records every row it refused.",
    missingData:
      "A boundary with no loaded observation is UNKNOWN; a boundary whose source recorded a missing-data indicator is UNKNOWN for a different, reported reason. Neither ever falls back to 0, and report volume is never substituted.",
    aggregation: "requires_exclusive_boundaries",
    disclosures: [POPULATION_DISCLOSURE],
  },

  M15: {
    id: "M15",
    title: "Data coverage",
    meaning:
      "The share of records missing a dimension, so a reader can tell a real zero from an absence of data.",
    unit: "percent",
    numerator: "Records whose dimension is null or UNKNOWN.",
    denominator: { kind: "population", of: "Every record in scope at the horizon." },
    cohort: "Canonical roots at the horizon.",
    inclusions: ["Genuinely unknown dimensions"],
    exclusions: [],
    horizon: "as_of",
    aliasSemantics: "Evaluated against the active root.",
    corrections: "Recomputed at each horizon.",
    missingData: "This metric measures missing data; an empty scope yields UNKNOWN.",
    aggregation: "additive",
    disclosures: [
      "Missing coverage is not zero incidence. A jurisdiction with no data has not been shown to have no problems.",
    ],
  },
};

export const metricContract = (id: MetricId): MetricContract => METRIC_CATALOGUE[id];
