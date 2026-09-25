/**
 * Measuring how fast this is, without saying how fast it would be (V049).
 *
 * V002 row 22 lists the prohibited claim for this task in advance: *national-
 * scale capacity or accuracy extrapolated from a small demonstration*. The
 * temptation is not malice, it is arithmetic — a laptop served 40 requests a
 * second, a district has 400 000 people, therefore... and the "therefore" is
 * where a measurement becomes a promise nobody can keep.
 *
 * So three rules are structural here:
 *
 *  * **A measurement without its conditions is not a measurement.** `Measurement`
 *    carries the hardware, the database settings, the workload size and the date,
 *    and `measurementStatement` prints them beside every figure rather than in a
 *    footnote. The figure and the thing that makes it meaningless travel together.
 *
 *  * **A percentile says where it sits.** With 50 observations a p95 is the third
 *    slowest one, and writing "p95 = 210 ms" hides that. `percentileOf` returns
 *    the value *and* how many observations sit above it, and the rendering always
 *    says so. This is V046's "counts, not rates", applied to latency.
 *
 *  * **A budget names its own source.** V026 recorded that a default in code is
 *    what makes an uncalibrated number invisible. A budget here is either
 *    `measured` — and then says what measured it — or `chosen`, and then says by
 *    what reasoning. There is no third kind, and no unlabelled number.
 *
 * Pure: no clock, no storage, no timers.
 */

// ---------------------------------------------------------------------------
// 1. What a run was
// ---------------------------------------------------------------------------

export type PerformanceConditions = {
  /** The machine. A figure from a laptop is a figure from a laptop. */
  readonly host: string;
  readonly cpuCount: number;
  readonly totalMemoryBytes: number;
  /** The database as it is actually configured, read from it rather than assumed. */
  readonly databaseSettings: Readonly<Record<string, string>>;
  /** How much data was present. A query over 900 rows is not a query over 9 000 000. */
  readonly rowsPresent: Readonly<Record<string, number>>;
  readonly startedAt: string;
  /** Whether anything else was running. Honest default: unknown. */
  readonly concurrency: number;
};

export type Measurement = {
  readonly name: string;
  /** What one observation timed, in a sentence. */
  readonly operation: string;
  readonly samples: readonly number[];
  readonly unit: "ms" | "bytes" | "count";
  /** Failures are part of the result, not an interruption of it. */
  readonly failures: number;
};

// ---------------------------------------------------------------------------
// 2. Percentiles that admit where they sit
// ---------------------------------------------------------------------------

export type Percentile =
  | {
      readonly kind: "reported";
      readonly value: number;
      /** How many observations were slower. A p95 over 50 samples has two. */
      readonly observationsAbove: number;
      readonly sampleSize: number;
    }
  | { readonly kind: "withheld"; readonly reason: string };

/**
 * The pth percentile by nearest-rank, with the count of observations above it.
 *
 * Nearest-rank rather than an interpolating method on purpose: interpolation
 * invents a value between two observations, and at these sample sizes the
 * invented value is doing more work than the data.
 */
export const percentileOf = (samples: readonly number[], p: number): Percentile => {
  if (samples.length === 0) {
    return { kind: "withheld", reason: "no observation was recorded" };
  }
  if (!(p > 0 && p < 1)) {
    return { kind: "withheld", reason: `${String(p)} is not a percentile between 0 and 1` };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  const value = sorted[rank - 1];
  if (value === undefined) {
    return { kind: "withheld", reason: "the rank fell outside the observations" };
  }
  return {
    kind: "reported",
    value,
    observationsAbove: sorted.length - rank,
    sampleSize: sorted.length,
  };
};

const round = (value: number): string =>
  value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2);

/**
 * How a percentile is written down.
 *
 * There is no branch that prints a bare percentile. The number of observations
 * above it is part of the sentence, because that is what says whether the
 * figure is a measurement or an anecdote with a subscript.
 */
export const percentileStatement = (percentile: Percentile, unit: string): string => {
  if (percentile.kind === "withheld") return `withheld — ${percentile.reason}`;
  if (percentile.observationsAbove === 0) {
    return `${round(percentile.value)} ${unit} — the slowest of ${String(percentile.sampleSize)} observations, so this is a maximum wearing a percentile's name`;
  }
  return `${round(percentile.value)} ${unit} (${String(percentile.observationsAbove)} of ${String(percentile.sampleSize)} observations were slower)`;
};

export const summaryOf = (
  measurement: Measurement,
): {
  readonly count: number;
  readonly failures: number;
  readonly min: number | undefined;
  readonly median: Percentile;
  readonly p95: Percentile;
  readonly max: number | undefined;
} => {
  const sorted = [...measurement.samples].sort((a, b) => a - b);
  return {
    count: sorted.length,
    failures: measurement.failures,
    min: sorted[0],
    median: percentileOf(sorted, 0.5),
    p95: percentileOf(sorted, 0.95),
    max: sorted[sorted.length - 1],
  };
};

// ---------------------------------------------------------------------------
// 3. Budgets, each naming its own source
// ---------------------------------------------------------------------------

export type Budget = {
  readonly name: string;
  readonly limit: number;
  readonly unit: string;
  /**
   * Which side of the limit is acceptable.
   *
   * Not a detail: the connection budget is a **floor** — V006 §5 requires at
   * least 36 for the workload — and the first run of this reported a healthy 47
   * as "exceeded" because the checker assumed every limit was a ceiling. A
   * budget that reports a passing system as failing is how a budget stops being
   * read.
   */
  readonly direction: "at_most" | "at_least";
  /**
   * Where the number came from. There is no third kind: a budget is either
   * something that was measured, or something somebody decided.
   */
  readonly source:
    | { readonly kind: "measured"; readonly by: string; readonly on: string }
    | { readonly kind: "chosen"; readonly reasoning: string };
  /** What happens when it is exceeded. A budget with no consequence is a wish. */
  readonly whenExceeded: string;
};

export class BudgetError extends Error {}

export const budget = (input: Budget): Budget => {
  if (input.whenExceeded.trim().length < 20) {
    throw new BudgetError(
      `budget '${input.name}' does not say what happens when it is exceeded; a limit with no consequence is a wish`,
    );
  }
  if (input.source.kind === "chosen" && input.source.reasoning.trim().length < 20) {
    throw new BudgetError(
      `budget '${input.name}' is a chosen number with no reasoning recorded, which is exactly the kind of default V026 refused to leave in code`,
    );
  }
  return input;
};

export type BudgetCheck = {
  readonly budget: Budget;
  readonly observed: number | undefined;
  readonly within: boolean | undefined;
};

export const checkBudget = (against: Budget, observed: number | undefined): BudgetCheck => ({
  budget: against,
  observed,
  within:
    observed === undefined
      ? undefined
      : against.direction === "at_most"
        ? observed <= against.limit
        : observed >= against.limit,
});

export const budgetStatement = (check: BudgetCheck): string => {
  const source =
    check.budget.source.kind === "measured"
      ? `measured by ${check.budget.source.by} on ${check.budget.source.on}`
      : `chosen: ${check.budget.source.reasoning}`;
  const observed =
    check.observed === undefined
      ? "not measured in this run"
      : `${round(check.observed)} ${check.budget.unit}`;
  const verdict = check.within === undefined ? "unknown" : check.within ? "within" : "**exceeded**";
  const bound = check.budget.direction === "at_most" ? "a ceiling of" : "a floor of";
  return `${check.budget.name}: ${observed} against ${bound} ${round(check.budget.limit)} ${check.budget.unit} — ${verdict}. (${source}.) When exceeded: ${check.budget.whenExceeded}`;
};

// ---------------------------------------------------------------------------
// 4. The verdict
// ---------------------------------------------------------------------------

export type CapacityVerdict =
  { readonly permitted: true } | { readonly permitted: false; readonly reasons: readonly string[] };

/**
 * Whether this run may back a capacity claim.
 *
 * It essentially never can, and saying why in a list is more useful than saying
 * so once in prose. The same shape as V045's and V046's verdicts.
 */
export const capacityClaimVerdict = (input: {
  readonly conditions: PerformanceConditions;
  readonly measurements: readonly Measurement[];
  /** True only when the run happened on the hardware the claim is about. */
  readonly ranOnTheDeployedEnvironment: boolean;
  /** True only when the data volume matches what the claim is about. */
  readonly dataVolumeMatchesTheClaim: boolean;
}): CapacityVerdict => {
  const reasons: string[] = [];

  if (!input.ranOnTheDeployedEnvironment) {
    reasons.push(
      `this ran on '${input.conditions.host}' with ${String(input.conditions.cpuCount)} CPU(s), which is not the environment any capacity claim would be about`,
    );
  }
  if (!input.dataVolumeMatchesTheClaim) {
    reasons.push(
      "the data volume present during the run is not the volume a claim would be about, and query cost does not stay flat as rows accumulate",
    );
  }
  if (input.conditions.concurrency <= 1) {
    reasons.push(
      "the run was sequential, so nothing here measures what happens when requests arrive at once — which is the only thing a capacity figure is about",
    );
  }
  for (const measurement of input.measurements) {
    if (measurement.samples.length < 30) {
      reasons.push(
        `'${measurement.name}' has ${String(measurement.samples.length)} observation(s); a tail figure from that is the second or third slowest sample wearing a percentile's name`,
      );
    }
    if (measurement.failures > 0) {
      reasons.push(
        `'${measurement.name}' had ${String(measurement.failures)} failure(s), and a latency figure that excludes the requests that failed describes a system that was not the one under test`,
      );
    }
  }

  return reasons.length === 0 ? { permitted: true } : { permitted: false, reasons };
};

export const PERFORMANCE_LIMITS: readonly string[] = [
  "every figure here is from one machine, one database container, and the data that happened to be in it; none of that is the deployed environment",
  "the workload is synthetic and sequential unless a measurement says otherwise, so nothing here describes contention",
  "no figure may be multiplied by a population to produce a capacity, which is the specific claim V002 row 22 prohibits",
  "a percentile over a few dozen observations is a ranked observation, not an estimate of a distribution",
  "nothing here measures a cold start, a network between services, or a provider under load",
];

export const BANNED_PERFORMANCE_PHRASES: readonly string[] = [
  "scales to",
  "scales linearly",
  "handles millions",
  "production-grade performance",
  "sub-second guaranteed",
  "national scale",
  "unlimited throughput",
  "no performance impact",
  "ready for production load",
];

export const performanceOverclaims = (text: string): readonly string[] => {
  const haystack = text.toLowerCase();
  return BANNED_PERFORMANCE_PHRASES.filter((phrase) => haystack.includes(phrase));
};
