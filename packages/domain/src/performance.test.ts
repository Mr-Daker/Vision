/**
 * The rules that keep a latency from becoming a capacity (roadmap V049).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BANNED_PERFORMANCE_PHRASES,
  BudgetError,
  PERFORMANCE_LIMITS,
  budget,
  budgetStatement,
  capacityClaimVerdict,
  checkBudget,
  percentileOf,
  percentileStatement,
  performanceOverclaims,
  summaryOf,
  type Measurement,
  type PerformanceConditions,
} from "./performance.ts";

const conditions: PerformanceConditions = {
  host: "a-laptop",
  cpuCount: 8,
  totalMemoryBytes: 16 * 1024 ** 3,
  databaseSettings: { max_connections: "50" },
  rowsPresent: { canonical_issue: 900 },
  startedAt: "2026-09-18T00:00:00.000Z",
  concurrency: 1,
};

const measurement = (samples: readonly number[], failures = 0): Measurement => ({
  name: "a_measurement",
  operation: "something",
  samples,
  unit: "ms",
  failures,
});

// ---------------------------------------------------------------------------
// Percentiles
// ---------------------------------------------------------------------------

test("a percentile says how many observations were slower than it", () => {
  const p95 = percentileOf(
    Array.from({ length: 40 }, (_, index) => index + 1),
    0.95,
  );
  assert.equal(p95.kind, "reported");
  assert.ok(p95.kind === "reported" && p95.observationsAbove === 2);
  assert.match(percentileStatement(p95, "ms"), /2 of 40 observations were slower/);
});

test("a percentile that is really the maximum says so rather than posing as a tail", () => {
  const p95 = percentileOf([1, 2, 3, 4, 5], 0.95);
  assert.ok(p95.kind === "reported" && p95.observationsAbove === 0);
  assert.match(percentileStatement(p95, "ms"), /a maximum wearing a percentile's name/);
});

test("no observations produces a withheld percentile, never a zero", () => {
  const empty = percentileOf([], 0.95);
  assert.equal(empty.kind, "withheld");
  assert.doesNotMatch(percentileStatement(empty, "ms"), /\b0\b/);
});

test("the summary carries failures beside the timings", () => {
  const summary = summaryOf(measurement([5, 6, 7], 4));
  assert.equal(summary.failures, 4);
  assert.equal(summary.count, 3);
});

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

const ceiling = budget({
  name: "a_ceiling",
  limit: 100,
  unit: "ms",
  direction: "at_most",
  source: { kind: "chosen", reasoning: "chosen because a slower page is a page people abandon" },
  whenExceeded: "look at the query plan before adding an index, and record what changed",
});

test("a budget with no consequence is refused", () => {
  assert.throws(() => budget({ ...ceiling, whenExceeded: "fix it" }), BudgetError);
});

test("a chosen budget with no reasoning is refused", () => {
  assert.throws(
    () => budget({ ...ceiling, source: { kind: "chosen", reasoning: "because" } }),
    BudgetError,
  );
});

test("a floor is not checked as a ceiling", () => {
  const floor = budget({
    ...ceiling,
    name: "a_floor",
    limit: 36,
    unit: "connections",
    direction: "at_least",
  });
  // The bug this exists for: 47 available connections against a floor of 36 is
  // headroom, and the first version of the checker called it an overrun.
  assert.equal(checkBudget(floor, 47).within, true);
  assert.equal(checkBudget(floor, 20).within, false);
  assert.equal(checkBudget(ceiling, 47).within, true);
  assert.equal(checkBudget(ceiling, 120).within, false);
});

test("a budget statement names its source and says which side of the limit is good", () => {
  const statement = budgetStatement(checkBudget(ceiling, 42));
  assert.match(statement, /a ceiling of/);
  assert.match(statement, /chosen:/);
  assert.match(statement, /When exceeded:/);
});

test("an unmeasured budget is reported as unmeasured, not as passing", () => {
  const check = checkBudget(ceiling, undefined);
  assert.equal(check.within, undefined);
  assert.match(budgetStatement(check), /not measured in this run/);
});

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

test("a laptop run is refused as the basis for a capacity claim", () => {
  const verdict = capacityClaimVerdict({
    conditions,
    measurements: [measurement(Array.from({ length: 200 }, () => 5))],
    ranOnTheDeployedEnvironment: false,
    dataVolumeMatchesTheClaim: false,
  });
  assert.equal(verdict.permitted, false);
  assert.ok(
    verdict.permitted === false && verdict.reasons.some((reason) => /a-laptop/.test(reason)),
  );
});

test("a sequential run is refused, because contention is the whole question", () => {
  const verdict = capacityClaimVerdict({
    conditions,
    measurements: [measurement(Array.from({ length: 200 }, () => 5))],
    ranOnTheDeployedEnvironment: true,
    dataVolumeMatchesTheClaim: true,
  });
  assert.equal(verdict.permitted, false);
  assert.ok(verdict.permitted === false && verdict.reasons.some((r) => /sequential/.test(r)));
});

test("failures make a latency figure refuse, because it describes a different system", () => {
  const verdict = capacityClaimVerdict({
    conditions: { ...conditions, concurrency: 8 },
    measurements: [
      measurement(
        Array.from({ length: 200 }, () => 5),
        3,
      ),
    ],
    ranOnTheDeployedEnvironment: true,
    dataVolumeMatchesTheClaim: true,
  });
  assert.equal(verdict.permitted, false);
  assert.ok(verdict.permitted === false && verdict.reasons.some((r) => /failure/.test(r)));
});

test("a run that meets every condition is permitted", () => {
  const verdict = capacityClaimVerdict({
    conditions: { ...conditions, concurrency: 8 },
    measurements: [measurement(Array.from({ length: 200 }, () => 5))],
    ranOnTheDeployedEnvironment: true,
    dataVolumeMatchesTheClaim: true,
  });
  assert.deepEqual(verdict, { permitted: true });
});

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

test("the banned phrasings catch the claim V002 row 22 prohibits", () => {
  assert.ok(
    performanceOverclaims("It scales linearly and is ready for production load.").length >= 2,
  );
  for (const phrase of BANNED_PERFORMANCE_PHRASES) assert.equal(phrase, phrase.toLowerCase());
});

test("the honest sentences this report needs are not banned", () => {
  assert.deepEqual(
    performanceOverclaims(
      "Every figure is from one laptop against 900 issues. No figure here may be multiplied by a population.",
    ),
    [],
  );
});

test("the limits name the specific prohibited extrapolation", () => {
  assert.ok(PERFORMANCE_LIMITS.some((limit) => /multiplied by a population/.test(limit)));
});

// ---------------------------------------------------------------------------
// The published documents
// ---------------------------------------------------------------------------

test("neither published V049 document turns a measurement into a capacity", async () => {
  const { readFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

  for (const path of [
    "deliverables/V049-performance-results.md",
    "docs/foundation/V049-performance-and-operating-budgets.md",
  ]) {
    const text = readFileSync(join(root, path), "utf8");
    assert.deepEqual(
      performanceOverclaims(text),
      [],
      `${path} carries a claim this run cannot support`,
    );
  }
});

test("the results document refuses before it reports", async () => {
  const { readFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const text = readFileSync(join(root, "deliverables/V049-performance-results.md"), "utf8");

  const refusal = text.indexOf("What this run may not be used to say");
  const firstTable = text.indexOf("| Measurement");
  assert.ok(refusal >= 0, "the results document must carry the refusal section");
  assert.ok(
    refusal < firstTable,
    "a reader who meets the figures first has already done the arithmetic",
  );
});

test("every latency figure in the results document carries its rank", async () => {
  const { readFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const text = readFileSync(join(root, "deliverables/V049-performance-results.md"), "utf8");

  const rows = text
    .split("\n")
    .filter((line) => /observations were slower|maximum wearing/.test(line));
  assert.ok(rows.length > 0, "the results document should report percentiles with their rank");
});
