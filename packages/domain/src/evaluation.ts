/**
 * Held-out evaluation semantics (roadmap V046).
 *
 * Every earlier task in this system refused to publish a number it could not
 * stand behind and named V046 as the place the number would be measured. This
 * is that place — and the first thing it has to be able to say is **"not from
 * this run"**, because a measurement device that cannot report insufficiency
 * reports confidence instead.
 *
 * Three rules are enforced here rather than remembered:
 *
 *  1. **A row whose labels are not signed off cannot back a figure.** V011 §4
 *     recorded that every `mr-IN` fixture is `pending_native_review` and "must
 *     not back a V046 measurement until a native reviewer signs off". That was
 *     prose in a document. `labelAuthorityOf` makes it a gate.
 *
 *  2. **A proportion is only rendered as a rate when the interval is narrow
 *     enough to distinguish anything.** `figureOf` always carries a numerator,
 *     a denominator and a Wilson interval, and `rateReportable` refuses the
 *     rate when that interval is wider than anyone could act on. Four of four
 *     is consistent with a true value near a half; printing "100%" hides that
 *     and printing "4 of 4, somewhere between 51% and 100%" does not.
 *
 *  3. **Candidate recall and incorrect merges are never combined.** They are
 *     different failures with different costs — a missed duplicate makes two
 *     records of one problem, a wrong merge makes one record of two problems
 *     and silently deletes somebody's report from view. `matchingFigures`
 *     returns both and there is deliberately no function returning one.
 *
 * Pure: no clock, no storage, no provider.
 */

// ---------------------------------------------------------------------------
// 1. Label authority — which rows may back a figure at all
// ---------------------------------------------------------------------------

/** The reviewer sentinel V011 uses for a Marathi row nobody has signed off. */
export const PENDING_NATIVE_REVIEW = "pending_native_review";

export type LabelAuthority =
  | { readonly usable: true }
  | { readonly usable: false; readonly reasonCode: string; readonly reason: string };

/**
 * Whether one corpus row's labels may back a measurement.
 *
 * Deliberately not a boolean: the reason travels, because "withheld" with no
 * reason reads like a gap in the data rather than a rule being kept.
 */
export const labelAuthorityOf = (row: {
  readonly reviewer: {
    readonly decision: string;
    readonly reviewed_by: string;
    readonly reviewed_at: string | null;
  };
}): LabelAuthority => {
  if (row.reviewer.reviewed_by === PENDING_NATIVE_REVIEW) {
    return {
      usable: false,
      reasonCode: "pending_native_review",
      reason:
        "the label is a team draft awaiting a native-speaker reviewer; V011 §4 forbids it backing a measurement",
    };
  }
  if (row.reviewer.reviewed_at === null) {
    return {
      usable: false,
      reasonCode: "never_reviewed",
      reason: "the row carries no review timestamp, so nobody has signed the label off",
    };
  }
  if (row.reviewer.decision === "undecided_by_design") {
    return {
      usable: false,
      reasonCode: "undecided_by_design",
      reason:
        "the reviewers recorded that both treatments are defensible, so there is no correct answer to score against",
    };
  }
  return { usable: true };
};

// ---------------------------------------------------------------------------
// 2. Scoring one field against one reviewed label
// ---------------------------------------------------------------------------

export type FieldOutcome =
  /** The model named the label the reviewers recorded. */
  | { readonly kind: "match"; readonly value: string }
  /** The model named something else. Both values travel; this is an error example. */
  | { readonly kind: "mismatch"; readonly expected: string; readonly produced: string }
  /** A label exists and the model declined to assert one. Not a wrong answer; a missing one. */
  | { readonly kind: "abstained_where_labelled"; readonly expected: string }
  /** No label exists and the model declined. The corpus's uninformative reports test this. */
  | { readonly kind: "correct_abstention" }
  /** No label exists and the model asserted one anyway. The expensive direction. */
  | { readonly kind: "asserted_where_none_expected"; readonly produced: string }
  /** The reviewers themselves left this field open, so it is outside the score. */
  | { readonly kind: "unscorable"; readonly reason: string };

/**
 * Scores one field.
 *
 * `abstained` is the model declining — a `low` certainty band or a proposal
 * that asks for review. It is kept distinct from a wrong answer throughout,
 * because a system that abstains is behaving as V002 row 10 requires and a
 * system that guesses is not, and a single "incorrect" bucket would make the
 * two indistinguishable.
 */
export const scoreField = (input: {
  readonly expected: string | null;
  readonly produced: string | undefined;
  readonly abstained: boolean;
  readonly unresolvedLabels: readonly string[];
  readonly fieldName: string;
}): FieldOutcome => {
  if (input.unresolvedLabels.includes(input.fieldName)) {
    return {
      kind: "unscorable",
      reason: `the corpus records '${input.fieldName}' as an unresolved label on this report, so there is nothing to compare against`,
    };
  }
  if (input.expected === null) {
    if (input.abstained || input.produced === undefined) return { kind: "correct_abstention" };
    return { kind: "asserted_where_none_expected", produced: input.produced };
  }
  if (input.abstained || input.produced === undefined) {
    return { kind: "abstained_where_labelled", expected: input.expected };
  }
  return input.produced === input.expected
    ? { kind: "match", value: input.produced }
    : { kind: "mismatch", expected: input.expected, produced: input.produced };
};

// ---------------------------------------------------------------------------
// 3. Figures — counts first, a rate only when the interval permits one
// ---------------------------------------------------------------------------

export type Interval = { readonly low: number; readonly high: number };

/**
 * A 95% Wilson score interval.
 *
 * Wilson rather than the textbook normal interval because the normal one is
 * wrong exactly where this corpus lives: at n = 4 with 4 successes it returns
 * the zero-width interval [1, 1], which would report a four-example run as
 * certainty. Wilson returns [0.51, 1] — the same data, honestly described.
 *
 * This is arithmetic on the counts, not a calibration: it introduces no
 * parameter that anybody had to choose.
 */
export const wilsonInterval = (successes: number, trials: number): Interval | undefined => {
  if (!Number.isInteger(successes) || !Number.isInteger(trials)) return undefined;
  if (trials <= 0 || successes < 0 || successes > trials) return undefined;
  const z = 1.959963984540054; // two-sided 95%
  const p = successes / trials;
  const z2 = z * z;
  const denominator = 1 + z2 / trials;
  const centre = p + z2 / (2 * trials);
  const spread = z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials));
  return {
    low: Math.max(0, (centre - spread) / denominator),
    high: Math.min(1, (centre + spread) / denominator),
  };
};

/**
 * How wide an interval may be before the proportion stops meaning anything.
 *
 * Chosen, not measured — and recorded as chosen, the way V026's retrieval
 * bounds are. The reasoning: a figure whose 95% interval spans more than
 * twenty percentage points cannot tell a system that is
 * usually right apart from one that is right about as often as it is wrong,
 * and every decision anybody would take on a classification figure turns on
 * exactly that distinction.
 */
export const MAX_INTERVAL_WIDTH_FOR_A_RATE = 0.2;

export const MAX_INTERVAL_WIDTH_RATIONALE =
  "chosen by reasoning, not measured: a 95% interval wider than twenty percentage points cannot tell a system that is usually right apart from one that is right about as often as it is wrong, and that is the distinction every decision on this figure turns on";

export type Figure =
  | {
      readonly kind: "counted";
      readonly numerator: number;
      readonly denominator: number;
      readonly interval: Interval;
      /** True only when the interval is narrow enough for a percentage to mean something. */
      readonly rateReportable: boolean;
    }
  | { readonly kind: "withheld"; readonly reasonCode: string; readonly reason: string }
  | { readonly kind: "empty"; readonly reason: string };

export const withheldFigure = (reasonCode: string, reason: string): Figure => ({
  kind: "withheld",
  reasonCode,
  reason,
});

export const figureOf = (numerator: number, denominator: number): Figure => {
  if (denominator <= 0) {
    return {
      kind: "empty",
      reason: "nothing was scored into this cell, so there is no proportion to describe",
    };
  }
  const interval = wilsonInterval(numerator, denominator);
  if (interval === undefined) {
    return withheldFigure(
      "not_a_proportion",
      `${String(numerator)} of ${String(denominator)} is not a proportion`,
    );
  }
  return {
    kind: "counted",
    numerator,
    denominator,
    interval,
    rateReportable: interval.high - interval.low <= MAX_INTERVAL_WIDTH_FOR_A_RATE,
  };
};

const percent = (value: number): string => `${(value * 100).toFixed(0)}%`;

/**
 * How a figure is written down.
 *
 * There is no branch that produces a bare percentage. When the interval is
 * narrow enough the percentage appears *beside* the counts and the interval,
 * never instead of them — the same device V042 uses to keep a rank interval
 * from collapsing into a rank.
 */
export const figureStatement = (figure: Figure): string => {
  if (figure.kind === "withheld") return `withheld — ${figure.reason}`;
  if (figure.kind === "empty") return figure.reason;
  const counts = `${String(figure.numerator)} of ${String(figure.denominator)}`;
  const band = `95% interval ${percent(figure.interval.low)}–${percent(figure.interval.high)}`;
  if (!figure.rateReportable) {
    return `${counts} (${band} — too wide to be written as a rate)`;
  }
  return `${counts}, ${percent(figure.numerator / figure.denominator)} (${band})`;
};

// ---------------------------------------------------------------------------
// 4. Abstention coverage — both directions, always
// ---------------------------------------------------------------------------

export type AbstentionCoverage = {
  readonly scored: number;
  /** Reports the corpus expects nobody to be able to classify. */
  readonly abstentionExpected: number;
  readonly abstainedWhenExpected: number;
  readonly assertedWhenAbstentionExpected: number;
  /** Reports carrying a label where the model declined anyway. */
  readonly abstainedWhenLabelled: number;
};

export const abstentionCoverageOf = (outcomes: readonly FieldOutcome[]): AbstentionCoverage => {
  let abstentionExpected = 0;
  let abstainedWhenExpected = 0;
  let assertedWhenAbstentionExpected = 0;
  let abstainedWhenLabelled = 0;
  let scored = 0;
  for (const outcome of outcomes) {
    if (outcome.kind === "unscorable") continue;
    scored += 1;
    if (outcome.kind === "correct_abstention") {
      abstentionExpected += 1;
      abstainedWhenExpected += 1;
    } else if (outcome.kind === "asserted_where_none_expected") {
      abstentionExpected += 1;
      assertedWhenAbstentionExpected += 1;
    } else if (outcome.kind === "abstained_where_labelled") {
      abstainedWhenLabelled += 1;
    }
  }
  return {
    scored,
    abstentionExpected,
    abstainedWhenExpected,
    assertedWhenAbstentionExpected,
    abstainedWhenLabelled,
  };
};

/**
 * The sentence. Names both failure directions every time, including when one
 * of them is zero — "it never over-asserted" is only meaningful next to how
 * often it had the chance to.
 */
export const abstentionStatement = (coverage: AbstentionCoverage): string =>
  [
    `${String(coverage.abstainedWhenExpected)} of ${String(coverage.abstentionExpected)} reports where the corpus expects an abstention were abstained on`,
    `${String(coverage.assertedWhenAbstentionExpected)} asserted a category where none should be assertable`,
    `${String(coverage.abstainedWhenLabelled)} of ${String(coverage.scored)} scored reports were abstained on despite carrying a reviewed label`,
  ].join("; ");

// ---------------------------------------------------------------------------
// 5. Matching — recall and incorrect merges, never combined
// ---------------------------------------------------------------------------

export type PairObservation = {
  readonly relationId: string;
  /** Did the second report's retrieval return the issue the first one opened? */
  readonly retrieved: boolean;
  /** Did the pipeline attach them to one issue? */
  readonly merged: boolean;
};

export type MatchingFigures = {
  /** Of the pairs reviewers call the same defect, how many were retrieved at all. */
  readonly candidateRecall: Figure;
  /** Of those retrieved, how many were then merged. A separate stage, a separate figure. */
  readonly mergeOfRetrieved: Figure;
  /** Of the pairs reviewers call distinct, how many were merged anyway. */
  readonly incorrectMerges: Figure;
  /** Distinct pairs that were retrieved as candidates and correctly left alone. */
  readonly correctlySeparated: Figure;
};

export const matchingFigures = (input: {
  readonly duplicatePairs: readonly PairObservation[];
  readonly distinctPairs: readonly PairObservation[];
}): MatchingFigures => {
  const retrievedDuplicates = input.duplicatePairs.filter((pair) => pair.retrieved);
  return {
    candidateRecall: figureOf(retrievedDuplicates.length, input.duplicatePairs.length),
    mergeOfRetrieved: figureOf(
      retrievedDuplicates.filter((pair) => pair.merged).length,
      retrievedDuplicates.length,
    ),
    incorrectMerges: figureOf(
      input.distinctPairs.filter((pair) => pair.merged).length,
      input.distinctPairs.length,
    ),
    correctlySeparated: figureOf(
      input.distinctPairs.filter((pair) => pair.retrieved && !pair.merged).length,
      input.distinctPairs.length,
    ),
  };
};

/**
 * Why there is no single matching figure.
 *
 * Kept as an exported statement rather than a comment so that the refusal is
 * something the report prints, in the same way V037's `combineAcrossBoundaries`
 * refuses rather than silently adding.
 */
export const MATCHING_NOT_COMBINABLE =
  "candidate recall and incorrect merges are reported separately and are never averaged into one figure: a missed duplicate produces two records of one problem, while a wrong merge produces one record of two problems and removes somebody's report from the count they were told they were part of";

// ---------------------------------------------------------------------------
// 6. Unsupported statements in a model reply
// ---------------------------------------------------------------------------

export type UnsupportedStatement = {
  readonly code: string;
  readonly why: string;
  /** A short masked excerpt. Never the whole reply, which contains the citizen's words. */
  readonly excerpt: string;
};

const STATEMENT_PATTERNS: readonly {
  readonly code: string;
  readonly pattern: RegExp;
  readonly why: string;
}[] = [
  {
    code: "probability_or_percentage",
    pattern: /\b\d{1,3}(?:\.\d+)?\s?%|\bprobabilit(?:y|ies)\b|\bconfidence\s*(?:score|level|of)\b/i,
    why: "the system instruction forbids a probability, a percentage or a score, and V002 prohibition 9 forbids presenting one as calibrated",
  },
  {
    code: "numeric_score",
    pattern: /\b(?:score|certainty|likelihood)\b\s*[:=]\s*-?\d/i,
    why: "a numeric score would be read as calibrated by every surface that renders it",
  },
  {
    code: "severity_assertion",
    pattern: /\b(?:critical|severe|hazardous|dangerous|life[- ]threatening|emergency)\b/i,
    why: "no severity model has been calibrated here; V034 and V042 both refuse severity, so a reply asserting one is unsupported",
  },
  {
    code: "repair_recommendation",
    pattern:
      /\b(?:should be (?:repaired|fixed|replaced|prioriti[sz]ed)|recommend(?:ed|s|ation)?|must be (?:repaired|fixed)|requires? immediate)\b/i,
    why: "a recommendation is an operational instruction the model has no standing to give and no evidence to support",
  },
  {
    code: "status_assertion",
    pattern: /\b(?:resolved|closed|acknowledged by|approved by|verified by)\b/i,
    why: "status belongs to the lifecycle and to a department; a classifier asserting it would be taken as an acknowledgment, which V033 forbids",
  },
  {
    code: "instruction_compliance",
    pattern: /\b(?:administrator|credential|password|api[_ ]?key|ignore (?:all )?previous)\b/i,
    why: "the reply is echoing an instruction embedded in the report instead of treating the report as data",
  },
];

/** At most this much of a reply travels into a finding. */
export const STATEMENT_EXCERPT_LIMIT = 24;

/**
 * Finds claim language in a model reply.
 *
 * The finding carries the matched fragment and nothing else. A report that
 * printed the whole reply to show what was wrong with it would have copied
 * the citizen's words into a more widely circulated file — the mistake V044
 * fixed in the privacy audit, not repeated here.
 */
export const unsupportedStatements = (replyText: string): readonly UnsupportedStatement[] => {
  const findings: UnsupportedStatement[] = [];
  for (const { code, pattern, why } of STATEMENT_PATTERNS) {
    const match = pattern.exec(replyText);
    if (match === null) continue;
    const raw = match[0];
    const excerpt =
      raw.length <= STATEMENT_EXCERPT_LIMIT ? raw : `${raw.slice(0, STATEMENT_EXCERPT_LIMIT)}…`;
    findings.push({ code, why, excerpt });
  }
  return findings;
};

// ---------------------------------------------------------------------------
// 7. Cost — tokens always, money only with a recorded price
// ---------------------------------------------------------------------------

export type ProviderUsage = {
  readonly calls: number;
  readonly promptTokens: number | undefined;
  readonly outputTokens: number | undefined;
  readonly totalTokens: number | undefined;
};

export type RecordedPrice = {
  readonly currency: string;
  readonly perMillionInputTokens: number;
  readonly perMillionOutputTokens: number;
  /** The row in the V004 source register this came from. Required. */
  readonly sourceId: string;
  readonly observedOn: string;
};

/**
 * What a run cost.
 *
 * Tokens and calls are observations — the provider returned them. A monetary
 * figure is not: it needs a published price, and a price typed into this
 * repository from memory is exactly the kind of unsourced number V004 §5 and
 * the source register exist to prevent. So money appears only when a price
 * with a register entry is supplied, and its absence is stated rather than
 * rounded to zero.
 */
export const costStatement = (usage: ProviderUsage, price?: RecordedPrice): string => {
  const tokens = [
    usage.promptTokens === undefined
      ? "input tokens not reported by the provider"
      : `${String(usage.promptTokens)} input tokens`,
    usage.outputTokens === undefined
      ? "output tokens not reported by the provider"
      : `${String(usage.outputTokens)} output tokens`,
  ].join(", ");
  const base = `${String(usage.calls)} provider call(s); ${tokens}`;
  if (price === undefined) {
    return `${base}. No monetary cost is given: no price for this model is recorded in the source register, and a figure typed here would have no provenance.`;
  }
  if (usage.promptTokens === undefined || usage.outputTokens === undefined) {
    return `${base}. No monetary cost is given: the provider did not report the token counts a price would be applied to.`;
  }
  const amount =
    (usage.promptTokens / 1_000_000) * price.perMillionInputTokens +
    (usage.outputTokens / 1_000_000) * price.perMillionOutputTokens;
  return `${base}. ${price.currency} ${amount.toFixed(4)} at the price recorded as ${price.sourceId}, observed ${price.observedOn}.`;
};

// ---------------------------------------------------------------------------
// 8. The verdict — what this run is and is not allowed to license
// ---------------------------------------------------------------------------

export type RunConditions = {
  /**
   * Which split answered.
   *
   * V046 requires that "no failures are hidden by replacing the holdout with
   * rehearsal examples". The development split is the rehearsal: the harness
   * is allowed to run on it, and a run that did is refused here rather than
   * being distinguishable only by someone remembering which flag was passed.
   */
  readonly split: "holdout" | "development";
  /** "real" means a provider was actually called; "stub" measures the stub. */
  readonly providerMode: "real" | "stub";
  readonly scoredReports: number;
  readonly withheldReports: number;
  readonly languages: readonly string[];
  /** Languages whose every row was withheld. A language present but unmeasurable. */
  readonly withheldLanguages: readonly string[];
  readonly duplicatePairs: number;
  readonly distinctPairs: number;
  readonly widestReportedFigure: Figure | undefined;
  /**
   * Whether the label space the reviewed corpus uses is the one the deployment
   * is actually configured with.
   *
   * A classification figure compares a model's answer to a reviewer's label.
   * If the model was given a different list of permitted identifiers from the
   * one the reviewer chose from, the comparison is not a measurement of
   * anything — and because both lists can declare the same `taxonomy_version`,
   * that condition is invisible unless something checks it.
   */
  readonly labelSpaceAgreesWithDeployment: boolean;
};

export type EvaluationClaimVerdict =
  { readonly permitted: true } | { readonly permitted: false; readonly reasons: readonly string[] };

/**
 * Whether this run may back a quality claim.
 *
 * The same shape as V045's `comparativeClaimVerdict`, for the same reason: a
 * refusal that lists what is missing reads as a next step, and a refusal
 * expressed in code cannot be forgotten by whoever writes the summary slide.
 */
export const qualityClaimVerdict = (conditions: RunConditions): EvaluationClaimVerdict => {
  const reasons: string[] = [];

  if (conditions.split !== "holdout") {
    reasons.push(
      `this run used the ${conditions.split} split, which the pipeline has been developed against; a figure from it is a rehearsal result and not a held-out measurement`,
    );
  }
  if (!conditions.labelSpaceAgreesWithDeployment) {
    reasons.push(
      "the reviewed corpus and the deployment pack declare the same taxonomy version while using different category identifiers, so a classification figure would compare a model's answer against a list the reviewer never chose from",
    );
  }
  if (conditions.providerMode === "stub") {
    reasons.push(
      "the deterministic stub answered, not a model: this run measures the stub's fixed replies and says nothing about model quality",
    );
  }
  if (conditions.scoredReports === 0) {
    reasons.push("no report in this run had labels that may back a figure");
  }
  if (conditions.withheldReports > 0) {
    reasons.push(
      `${String(conditions.withheldReports)} of ${String(conditions.scoredReports + conditions.withheldReports)} corpus reports were withheld from every label-dependent figure, so the measured subset is not the corpus`,
    );
  }
  for (const language of conditions.withheldLanguages) {
    reasons.push(
      `every ${language} row was withheld, so this run carries no per-language result for ${language} — which is a result V046 explicitly requires`,
    );
  }
  if (conditions.duplicatePairs < 2) {
    reasons.push(
      `candidate recall rests on ${String(conditions.duplicatePairs)} reviewed duplicate pair(s); one pair is an example, not a recall measurement`,
    );
  }
  if (conditions.distinctPairs < 2) {
    reasons.push(
      `the incorrect-merge figure rests on ${String(conditions.distinctPairs)} reviewed distinct pair(s), which cannot distinguish a system that never merges wrongly from one that has not been given the chance`,
    );
  }
  const widest = conditions.widestReportedFigure;
  if (widest === undefined || widest.kind === "empty" || widest.kind === "withheld") {
    // A run where nothing was scorable is not a run with nothing to say; it is
    // a run with nothing measured, and the two look identical in a table of
    // empty cells. Found by a run in which the provider rate-limited every
    // call: every figure came back empty and the verdict had no reason to give.
    reasons.push(
      "no scored row produced an answer to compare against, so this run contains no classification result at all",
    );
  } else if (widest.kind === "counted" && !widest.rateReportable) {
    reasons.push(
      `no figure in this run has a 95% interval narrower than ${String(Math.round(MAX_INTERVAL_WIDTH_FOR_A_RATE * 100))} percentage points, so none may be written as a rate`,
    );
  }

  return reasons.length === 0 ? { permitted: true } : { permitted: false, reasons };
};

/**
 * Phrasings a V046 report may not contain.
 *
 * Checked by test against the published documents, the same device V034, V036,
 * V041, V042, V043 and V045 each carry. The list is about claim constructions
 * rather than bare words: this report has to be able to use the word "accuracy"
 * when saying that it has not measured one.
 */
export const BANNED_EVALUATION_PHRASES: readonly string[] = [
  "is accurate",
  "proven accurate",
  "production-ready",
  "production ready",
  "human-level",
  "outperforms",
  "state of the art",
  "state-of-the-art",
  "highly reliable",
  "ready for deployment",
  "no further evaluation",
  "validated model",
  "sets a benchmark",
];

/** Claim shapes a fixed string cannot catch: a number wearing an accuracy label. */
const BANNED_EVALUATION_PATTERNS: readonly RegExp[] = [
  /accuracy of \s*\d/i,
  /\d\s?%\s*(?:accuracy|accurate|correct|recall|precision)/i,
  /(?:accuracy|recall|precision)\s*(?:of|:|=)\s*\d{1,3}\s?%/i,
];

export const evaluationOverclaims = (text: string): readonly string[] => {
  const haystack = text.toLowerCase();
  const found = BANNED_EVALUATION_PHRASES.filter((phrase) => haystack.includes(phrase));
  for (const pattern of BANNED_EVALUATION_PATTERNS) {
    const match = pattern.exec(text);
    if (match !== null) found.push(match[0]);
  }
  return found;
};
