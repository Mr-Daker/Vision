/**
 * Contextual data import rules (roadmap V040).
 *
 * Population, enrolment, access and investment figures are the numbers most
 * likely to be quoted out of this system and the least likely to have been
 * checked, because they arrive from somewhere else and look authoritative on
 * arrival. Three rules follow from that, and every function here serves one of
 * them.
 *
 * **Nothing is converted.** There is no unit conversion in this file and there
 * is not going to be one. A row declaring `households` where the dataset
 * declares `persons` is rejected, not multiplied by an average household size
 * somebody guessed. The conversion factor is the invention; the rejection is
 * the honest answer.
 *
 * **Missing stays missing, with a reason.** Source files say `NA`, `-`, `n/a`
 * and empty strings, and every one of them means *we do not know*. Each parses
 * to a null carrying the indicator that produced it. Substituting `0` would
 * turn "this ward was never surveyed" into "nobody lives in this ward".
 *
 * **Every value carries where it came from.** A context value without a source
 * record and a vintage is not a fact, it is a rumour with a number attached.
 * `lineageSentence` is what a screen has to display beside the figure, and
 * `validateContextRow` refuses a row that could not produce one.
 *
 * V004's licence downgrade rule sits behind all of it: no external dataset is
 * approved for ingestion, so everything loaded here is team-created synthetic
 * and says so. The gate is enforced rather than assumed — a row whose source is
 * reference-only or unavailable is rejected even if somebody hands it over.
 *
 * Pure: no clock, no storage. Every horizon is supplied.
 */

import { isIngestible, type SourceRecordSnapshot } from "@vision/contracts";

/**
 * The four kinds of context this system will hold.
 *
 * Deliberately closed. A fifth kind is a decision about what this product
 * claims to know, not a configuration value, and adding one should require
 * editing this file and reading the rules above.
 */
export type ContextKind = "population" | "enrolment" | "access" | "investment";

export const CONTEXT_KINDS: readonly ContextKind[] = [
  "population",
  "enrolment",
  "access",
  "investment",
];

/**
 * The units each kind may be expressed in.
 *
 * A closed vocabulary per kind, because the failure this prevents is not a
 * typo — it is a figure in one unit being read as a figure in another. A unit
 * outside this list is rejected with the list in the message, so whoever
 * prepared the file can correct it rather than guess.
 */
export const UNITS_BY_KIND: Readonly<Record<ContextKind, readonly string[]>> = {
  population: ["persons"],
  enrolment: ["students"],
  // A share, always out of 100 and never a bare ratio: "0.62" and "62" are the
  // same access level written two ways, and nothing downstream could tell them
  // apart from the number alone.
  access: ["percent_of_households"],
  investment: ["inr"],
};

export const unitsFor = (kind: ContextKind): readonly string[] => UNITS_BY_KIND[kind];

/**
 * Strings that mean "we do not know".
 *
 * Matched case-insensitively after trimming. Anything else that fails to parse
 * as a number is rejected rather than treated as missing — a value of `12,00`
 * is an error in the file, not an absence, and silently reading it as unknown
 * would lose a row somebody meant to provide.
 */
export const MISSING_INDICATORS: readonly string[] = [
  "",
  "-",
  "--",
  "na",
  "n/a",
  "nil",
  "null",
  "unknown",
  "not available",
  "not surveyed",
];

export type ParsedValue =
  | { readonly kind: "value"; readonly value: number }
  | { readonly kind: "missing"; readonly indicator: string }
  | { readonly kind: "unparseable"; readonly raw: string };

/** Parses one cell. Never returns `0` for an absence. */
export const parseContextValue = (raw: unknown): ParsedValue => {
  if (raw === null || raw === undefined) return { kind: "missing", indicator: "null" };
  if (typeof raw === "number") {
    return Number.isFinite(raw)
      ? { kind: "value", value: raw }
      : { kind: "unparseable", raw: String(raw) };
  }
  const text = String(raw).trim();
  if (MISSING_INDICATORS.includes(text.toLowerCase())) {
    return { kind: "missing", indicator: text.length === 0 ? "(empty)" : text };
  }
  // Deliberately strict: no thousands separators, no currency symbols, no
  // trailing units. Each of those is a file that needs correcting, and
  // accepting them is how a decimal comma becomes a factor of a hundred.
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) return { kind: "unparseable", raw: text };
  return { kind: "value", value: Number(text) };
};

// ---------------------------------------------------------------------------
// Rows and datasets
// ---------------------------------------------------------------------------

export type ContextDataset = {
  readonly datasetId: string;
  readonly kind: ContextKind;
  readonly unit: string;
  readonly label: string;
  /** The source this dataset came from, with its licence and retrieval time. */
  readonly source: SourceRecordSnapshot;
  /** How old a vintage may be before a reader is told it is stale. */
  readonly maxAgeDays: number;
};

export type ContextRow = {
  /** The boundary or asset this figure describes. */
  readonly subjectKind: "jurisdiction" | "asset";
  readonly subjectId: string;
  readonly value: unknown;
  readonly unit: string;
  /** When the source says the figure was true. */
  readonly vintage: string;
  readonly note?: string;
};

export type RejectionCode =
  | "source_not_ingestible"
  | "unknown_unit"
  | "unit_mismatch"
  | "unparseable_value"
  | "negative_value"
  | "share_out_of_range"
  | "missing_subject"
  | "unmatched_subject"
  | "missing_vintage"
  | "future_vintage"
  | "duplicate_subject";

export type Rejection = {
  readonly code: RejectionCode;
  readonly detail: string;
};

export type AcceptedRow = {
  readonly subjectKind: "jurisdiction" | "asset";
  readonly subjectId: string;
  /** Null when the source said it did not know. Never `0` standing in for that. */
  readonly value: number | null;
  /** Present exactly when `value` is null: the indicator the file used. */
  readonly missingIndicator: string | null;
  readonly unit: string;
  readonly vintage: string;
};

export type RowOutcome =
  | { readonly ok: true; readonly row: AcceptedRow }
  | { readonly ok: false; readonly rejections: readonly Rejection[] };

export type ValidationContext = {
  /** Subject identifiers that exist. A row naming anything else is unmatched. */
  readonly knownSubjects: ReadonlySet<string>;
  readonly asOfMs: number;
  /** Subjects already accepted in this run, so a repeat is caught. */
  readonly seen?: ReadonlySet<string>;
};

/**
 * Validates one row against its dataset.
 *
 * Returns **every** reason a row failed rather than the first, because the
 * point of the rejection list is that somebody can fix the file in one pass.
 */
export const validateContextRow = (
  dataset: ContextDataset,
  row: ContextRow,
  context: ValidationContext,
): RowOutcome => {
  const rejections: Rejection[] = [];

  if (!isIngestible(dataset.source)) {
    rejections.push({
      code: "source_not_ingestible",
      detail: `source '${dataset.source.source_name}' is ${dataset.source.licence_or_permission_status}/${dataset.source.demo_status}; only permitted, synthetic or consented data may be loaded (V004 §5)`,
    });
  }

  const permitted = unitsFor(dataset.kind);
  if (!permitted.includes(dataset.unit)) {
    rejections.push({
      code: "unknown_unit",
      detail: `dataset unit '${dataset.unit}' is not one of ${permitted.join(", ")} for ${dataset.kind}`,
    });
  } else if (row.unit !== dataset.unit) {
    // No conversion. A factor between these two units would be an invention,
    // and an invented factor is indistinguishable from a correct one once the
    // number is on a screen.
    rejections.push({
      code: "unit_mismatch",
      detail: `row is in '${row.unit}' but the dataset is in '${dataset.unit}'; this system does not convert units, so the row is refused rather than rescaled`,
    });
  }

  if (row.subjectId.trim().length === 0) {
    rejections.push({ code: "missing_subject", detail: "the row names no subject" });
  } else if (!context.knownSubjects.has(row.subjectId)) {
    rejections.push({
      code: "unmatched_subject",
      detail: `no ${row.subjectKind} with identifier '${row.subjectId}' exists; an unmatched row is reported, never attached to the nearest plausible one`,
    });
  } else if (context.seen?.has(`${row.subjectKind}:${row.subjectId}`) === true) {
    rejections.push({
      code: "duplicate_subject",
      detail: `'${row.subjectId}' appears more than once in this dataset; which figure stands cannot be decided here`,
    });
  }

  const vintageMs = Date.parse(row.vintage);
  if (row.vintage.trim().length === 0 || Number.isNaN(vintageMs)) {
    rejections.push({
      code: "missing_vintage",
      detail: "a context value with no vintage cannot be shown as current or as stale",
    });
  } else if (vintageMs > context.asOfMs) {
    rejections.push({
      code: "future_vintage",
      detail: `vintage ${row.vintage} is in the future; a figure cannot describe a moment that has not happened`,
    });
  }

  const parsed = parseContextValue(row.value);
  if (parsed.kind === "unparseable") {
    rejections.push({
      code: "unparseable_value",
      detail: `'${parsed.raw}' is neither a plain number nor a recognised missing-data indicator (${MISSING_INDICATORS.filter((item) => item.length > 0).join(", ")})`,
    });
  }
  if (parsed.kind === "value" && parsed.value < 0) {
    rejections.push({
      code: "negative_value",
      detail: `${String(parsed.value)} is negative; none of these quantities can be`,
    });
  }
  if (
    parsed.kind === "value" &&
    dataset.kind === "access" &&
    (parsed.value < 0 || parsed.value > 100)
  ) {
    rejections.push({
      code: "share_out_of_range",
      detail: `${String(parsed.value)} is not a percentage between 0 and 100; a share written as a fraction is a different number, and guessing which was meant is how a 62% becomes a 6200%`,
    });
  }

  if (rejections.length > 0) return { ok: false, rejections };
  return {
    ok: true,
    row: {
      subjectKind: row.subjectKind,
      subjectId: row.subjectId,
      value: parsed.kind === "value" ? parsed.value : null,
      missingIndicator: parsed.kind === "missing" ? parsed.indicator : null,
      unit: row.unit,
      vintage: new Date(vintageMs).toISOString(),
    },
  };
};

// ---------------------------------------------------------------------------
// Staleness
// ---------------------------------------------------------------------------

export type Staleness = {
  readonly ageDays: number;
  readonly stale: boolean;
  readonly explanation: string;
};

/**
 * How old a figure is, and whether that is worth saying.
 *
 * Stale data is reported, never withheld and never quietly refreshed. A
 * population from four years ago is still the best figure available; what
 * would be dishonest is presenting it without the four years.
 */
export const stalenessOf = (vintageMs: number, asOfMs: number, maxAgeDays: number): Staleness => {
  const ageDays = Math.max(0, Math.round(((asOfMs - vintageMs) / 86_400_000) * 10) / 10);
  const stale = ageDays > maxAgeDays;
  return {
    ageDays,
    stale,
    explanation: stale
      ? `Recorded as true ${String(ageDays)} days ago, past the ${String(maxAgeDays)} days this dataset is considered current for. It is still the most recent figure available.`
      : `Recorded as true ${String(ageDays)} days ago.`,
  };
};

// ---------------------------------------------------------------------------
// Lineage
// ---------------------------------------------------------------------------

export type DisplayableContextValue = {
  readonly datasetLabel: string;
  readonly kind: ContextKind;
  readonly value: number | null;
  readonly missingIndicator: string | null;
  readonly unit: string;
  readonly vintage: string;
  readonly sourceName: string;
  readonly sourceLocation: string;
  readonly licence: string;
  readonly synthetic: boolean;
  readonly staleness: Staleness;
};

/**
 * The sentence that must appear beside any context figure on a screen.
 *
 * The V040 acceptance clause is "every displayed context value links to a
 * source record or is visibly synthetic", and this is that clause expressed as
 * the only supported way to render one. A synthetic value says so first, in
 * its own words, before the number is discussed — a label at the bottom of a
 * page is not the same as a label on the figure.
 */
export const lineageSentence = (value: DisplayableContextValue): string => {
  const origin = value.synthetic
    ? `Invented for this demonstration. It describes no real place and no external dataset was ingested to produce it (${value.sourceName}).`
    : `From ${value.sourceName} (${value.sourceLocation}), used under: ${value.licence}.`;
  const figure =
    value.value === null
      ? `No figure is recorded — the source said "${value.missingIndicator ?? "unknown"}".`
      : `${String(value.value)} ${value.unit}.`;
  return `${figure} ${origin} ${value.staleness.explanation}`;
};

/** True when a value may be shown at all: it must have a source and a vintage. */
export const isDisplayable = (value: DisplayableContextValue): boolean =>
  value.sourceName.trim().length > 0 && Date.parse(value.vintage) > 0;
