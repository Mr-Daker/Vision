/**
 * The resolution-durability panel (roadmap V050a).
 *
 * The rule this file exists to keep: **a figure never appears without what it
 * cannot rule out.** On a terminal the alternatives are three lines below the
 * number and a reader sees both. On a screen they are one collapsed section
 * away, and a collapsed caveat is a caveat nobody reads — so every concern
 * here renders its alternatives inline, in the same block as the count, and
 * there is no branch that renders one without the other.
 *
 * Pure: builds view models from a payload. No DOM, no fetch.
 */

export type DurabilityFigureView =
  | {
      readonly kind: "counted";
      readonly numerator: number;
      readonly denominator: number;
      readonly low: number;
      readonly high: number;
      readonly rateReportable: boolean;
    }
  | { readonly kind: "absent"; readonly reason: string };

export type DurabilityUnitRow = {
  readonly label: string;
  readonly figure: DurabilityFigureView;
};

export type DurabilitySignalView = {
  readonly signal: string;
  readonly observed: string;
  readonly units: readonly DurabilityUnitRow[];
};

export type DurabilityConcernView = {
  readonly unit: string;
  readonly signal: string;
  readonly figure: DurabilityFigureView;
  readonly baseline: DurabilityFigureView;
  readonly observed: string;
  readonly alternatives: readonly string[];
  readonly nextStep: string;
};

export type DurabilityView = {
  readonly windowDays: number;
  readonly totalClaims: number;
  readonly signals: readonly DurabilitySignalView[];
  readonly concerns: readonly DurabilityConcernView[];
  readonly rankingNote: string;
  readonly limits: readonly string[];
};

const asFigure = (raw: unknown): DurabilityFigureView => {
  if (typeof raw !== "object" || raw === null) {
    return { kind: "absent", reason: "no figure was returned" };
  }
  const record = raw as Record<string, unknown>;
  if (record["kind"] !== "counted") {
    const reason = record["reason"];
    return {
      kind: "absent",
      reason:
        typeof reason === "string"
          ? reason
          : "nothing was measured into this cell, so there is no proportion to describe",
    };
  }
  const interval = record["interval"] as Record<string, unknown> | undefined;
  return {
    kind: "counted",
    numerator: Number(record["numerator"] ?? 0),
    denominator: Number(record["denominator"] ?? 0),
    low: Number(interval?.["low"] ?? 0),
    high: Number(interval?.["high"] ?? 0),
    rateReportable: record["rateReportable"] === true,
  };
};

const asStrings = (raw: unknown): readonly string[] =>
  Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === "string") : [];

export const toDurabilityView = (payload: unknown): DurabilityView | undefined => {
  if (typeof payload !== "object" || payload === null) return undefined;
  const record = payload as Record<string, unknown>;
  const rawSignals = record["signals"];
  if (!Array.isArray(rawSignals)) return undefined;

  const signals: DurabilitySignalView[] = rawSignals.map((entry) => {
    const signal = entry as Record<string, unknown>;
    const units = Array.isArray(signal["units"]) ? signal["units"] : [];
    return {
      signal: String(signal["signal"] ?? ""),
      observed: String(signal["observed"] ?? ""),
      units: units.map((unit) => {
        const row = unit as Record<string, unknown>;
        return { label: String(row["label"] ?? ""), figure: asFigure(row["figure"]) };
      }),
    };
  });

  const rawConcerns = Array.isArray(record["concerns"]) ? record["concerns"] : [];
  const concerns: DurabilityConcernView[] = rawConcerns.map((entry) => {
    const concern = entry as Record<string, unknown>;
    return {
      unit: String(concern["unit"] ?? ""),
      signal: String(concern["signal"] ?? ""),
      figure: asFigure(concern["figure"]),
      baseline: asFigure(concern["baseline"]),
      observed: String(concern["observed"] ?? ""),
      alternatives: asStrings(concern["alternatives"]),
      nextStep: String(concern["next_step"] ?? ""),
    };
  });

  return {
    windowDays: Number(record["window_days"] ?? 0),
    totalClaims: Number(record["total_claims"] ?? 0),
    signals,
    concerns,
    rankingNote: String(record["ranking_note"] ?? ""),
    limits: asStrings(record["limits"]),
  };
};

const percent = (value: number): string => `${String(Math.round(value * 100))}%`;

/**
 * How a figure reads on screen.
 *
 * There is no branch that returns a bare percentage. Below the interval width
 * V046 set, the counts and the interval are the whole answer; above it the
 * percentage appears beside them and never instead of them.
 */
export const figureText = (figure: DurabilityFigureView): string => {
  if (figure.kind === "absent") return figure.reason;
  const counts = `${String(figure.numerator)} of ${String(figure.denominator)}`;
  const band = `95% interval ${percent(figure.low)}–${percent(figure.high)}`;
  if (!figure.rateReportable) return `${counts} (${band}: too wide to be written as a rate)`;
  return `${counts}, ${percent(figure.numerator / figure.denominator)} (${band})`;
};

/** The words for each signal, so the panel never shows a raw identifier. */
export const SIGNAL_LABELS: Readonly<Record<string, string>> = {
  did_not_hold: "Confirmed, then reopened",
  disputed_by_reporter: "Disputed by the reporter",
  claimed_near_deadline: "Claimed near the deadline",
  claimed_implausibly_fast: "Claimed very soon after planning",
  minimum_evidence: "Claimed with minimum evidence",
};

export const signalLabel = (signal: string): string => SIGNAL_LABELS[signal] ?? signal;

/**
 * The sentence above the panel.
 *
 * States the unit of measurement before any number, because a reader who meets
 * the figures first has already decided they are about people.
 */
export const panelPreamble = (view: DurabilityView): string =>
  `${String(view.totalClaims)} completion claim(s) over ${String(view.windowDays)} days. These figures are about work in a ward, not about the people who did it, and nothing here names an individual.`;
