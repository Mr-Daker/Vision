/**
 * V037 metric semantics.
 *
 * The acceptance clauses this file holds:
 *
 *   * every metric has a reproducible formula **and a denominator** — a rate
 *     names its population, a count says why it has none;
 *   * a zero denominator yields UNKNOWN, never `0` and never a thrown error;
 *   * resolved-only speed cannot be rendered without the unresolved remainder;
 *   * local distinct counts and externally sourced populations cannot be
 *     summed without valid aggregation rules.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BANNED_MEASUREMENT_PHRASES,
  METRIC_CATALOGUE,
  METRIC_IDS,
  REOPENING_WITHIN_WINDOW_INVALIDATES,
  combineAcrossBoundaries,
  elapsedHours,
  isSufficientlyObserved,
  known,
  median,
  metricContract,
  ratio,
  speedCoverage,
  speedStatement,
  standsAtWindowEnd,
  unknown,
  vocabularyViolations,
  type MetricId,
  type ResolutionSpeed,
} from "./metric-semantics.ts";

const DAY = 86_400_000;

// ---------------------------------------------------------------------------
// The catalogue is complete and self-describing
// ---------------------------------------------------------------------------

test("every declared metric has a contract, and every contract is declared", () => {
  const catalogued = Object.keys(METRIC_CATALOGUE).sort() as MetricId[];
  assert.deepEqual(catalogued, [...METRIC_IDS].sort());
  for (const id of METRIC_IDS) {
    assert.equal(metricContract(id).id, id, `${id} contract must know its own id`);
  }
});

test("every metric states a formula, a cohort, a horizon and a denominator", () => {
  for (const id of METRIC_IDS) {
    const contract = METRIC_CATALOGUE[id];
    assert.ok(contract.numerator.length > 20, `${id} must state how it is computed`);
    assert.ok(contract.cohort.length > 10, `${id} must state its cohort`);
    assert.ok(contract.meaning.length > 20, `${id} must state what it means`);
    assert.ok(contract.missingData.length > 10, `${id} must state its missing-data behaviour`);
    assert.ok(contract.aliasSemantics.length > 10, `${id} must state its alias semantics`);
    assert.ok(contract.corrections.length > 4, `${id} must state how corrections land`);
  }
});

test("a rate or a duration names its population; a count says why it has none", () => {
  for (const id of METRIC_IDS) {
    const contract = METRIC_CATALOGUE[id];
    // A percentage must name what it is a percentage of. A duration must name
    // the set it was measured over for the same reason: an average computed
    // from three resolved issues out of two hundred is not wrong, it is
    // unrepresentative, and only the population reveals which.
    if (contract.unit === "percent" || contract.unit === "hours") {
      assert.equal(
        contract.denominator.kind,
        "population",
        `${id} must name the population it was measured over`,
      );
      if (contract.denominator.kind === "population") {
        assert.ok(contract.denominator.of.length > 10, `${id} denominator must be specific`);
      }
    } else {
      assert.equal(contract.denominator.kind, "none", `${id} is not a rate`);
      if (contract.denominator.kind === "none") {
        assert.ok(contract.denominator.why.length > 10, `${id} must say why it has no denominator`);
      }
    }
  }
});

test("measurement wording never overstates what the system knows", () => {
  for (const id of METRIC_IDS) {
    const contract = METRIC_CATALOGUE[id];
    const measurementText = [
      contract.title,
      contract.meaning,
      contract.numerator,
      contract.denominator.kind === "population"
        ? contract.denominator.of
        : contract.denominator.why,
      ...contract.inclusions,
      ...contract.exclusions,
    ].join(" \n ");
    assert.deepEqual(
      vocabularyViolations(measurementText),
      [],
      `${id} uses phrasing this system cannot support`,
    );
  }
});

test("the banned-phrase list is live, not decorative", () => {
  assert.ok(BANNED_MEASUREMENT_PHRASES.length >= 6);
  assert.deepEqual(vocabularyViolations("47 issues successfully closed this month").length, 1);
  assert.deepEqual(vocabularyViolations("number of people helped").length, 1);
  // The disclosures are deliberately exempt: one of them has to be able to say
  // plainly that people agreed, because that is exactly what was recorded.
  assert.ok(METRIC_CATALOGUE.M04.disclosures[0]?.includes("people"));
});

test("every rate and every people-shaped count carries a disclosure", () => {
  for (const id of ["M04", "M05", "M10", "M12", "M14"] as const) {
    assert.ok(
      METRIC_CATALOGUE[id].disclosures.length > 0,
      `${id} must travel with what it does not mean`,
    );
  }
});

// ---------------------------------------------------------------------------
// Denominator safety
// ---------------------------------------------------------------------------

test("a zero denominator is UNKNOWN, not zero and not an error", () => {
  const result = ratio(0, 0);
  assert.equal(result.value, null);
  assert.equal(result.unknownReason, "empty_denominator");
});

test("an unknown numerator or denominator propagates rather than becoming zero", () => {
  assert.equal(ratio(null, 10).value, null);
  assert.equal(ratio(3, null).value, null);
  assert.equal(ratio(Number.NaN, 10).value, null);
});

test("ratios round to one decimal place", () => {
  assert.equal(ratio(1, 3).value, 33.3);
  assert.equal(ratio(2, 3).value, 66.7);
  assert.equal(ratio(0, 7).value, 0);
});

test("zero out of seven is a real zero, distinct from an empty denominator", () => {
  const realZero = ratio(0, 7);
  const noPopulation = ratio(0, 0);
  assert.equal(realZero.value, 0);
  assert.equal(realZero.unknownReason, null);
  assert.equal(noPopulation.value, null);
  assert.notEqual(realZero.value, noPopulation.value);
});

test("elapsed time is measured in hours, not calendar days", () => {
  const start = Date.UTC(2026, 2, 1, 23, 0, 0);
  assert.equal(elapsedHours(start, start + 2 * 3_600_000), 2);
  // Crossing midnight is two hours, not "one day".
  assert.ok(elapsedHours(start, start + 2 * 3_600_000) < 24);
});

test("median of an empty sample is null, never zero", () => {
  assert.equal(median([]), null);
  assert.equal(median([4]), 4);
  assert.equal(median([1, 2, 3, 4]), 2.5);
});

// ---------------------------------------------------------------------------
// Cohort observation and fixed windows
// ---------------------------------------------------------------------------

test("a cohort member younger than the window is in neither side of the rate", () => {
  const asOf = Date.UTC(2026, 5, 1);
  assert.equal(isSufficientlyObserved(asOf - 40 * DAY, 30, asOf), true);
  assert.equal(isSufficientlyObserved(asOf - 10 * DAY, 30, asOf), false);
  // Exactly at the boundary the window has closed: [start, end) is half-open.
  assert.equal(isSufficientlyObserved(asOf - 30 * DAY, 30, asOf), true);
});

test("reopening inside the window invalidates the resolution; outside it does not", () => {
  assert.equal(REOPENING_WITHIN_WINDOW_INVALIDATES, true);
  const openedAtMs = Date.UTC(2026, 0, 1);

  assert.equal(
    standsAtWindowEnd({
      openedAtMs,
      windowDays: 30,
      firstConfirmedAtMs: openedAtMs + 5 * DAY,
      firstReopenedAtMs: openedAtMs + 10 * DAY,
    }),
    false,
    "a repair that failed inside the window it is measured against did not hold",
  );

  assert.equal(
    standsAtWindowEnd({
      openedAtMs,
      windowDays: 30,
      firstConfirmedAtMs: openedAtMs + 5 * DAY,
      firstReopenedAtMs: openedAtMs + 200 * DAY,
    }),
    true,
    "a reopening long afterwards does not retrospectively restate closed history",
  );

  assert.equal(
    standsAtWindowEnd({
      openedAtMs,
      windowDays: 30,
      firstConfirmedAtMs: openedAtMs + 44 * DAY,
      firstReopenedAtMs: null,
    }),
    false,
    "confirmed after the window is not confirmed within it",
  );

  assert.equal(
    standsAtWindowEnd({
      openedAtMs,
      windowDays: 30,
      firstConfirmedAtMs: null,
      firstReopenedAtMs: null,
    }),
    false,
  );
});

// ---------------------------------------------------------------------------
// Speed never travels alone
// ---------------------------------------------------------------------------

const speed = (over: Partial<ResolutionSpeed>): ResolutionSpeed => ({
  resolvedCount: 0,
  stillWaitingCount: 0,
  firstConfirmationHoursMedian: null,
  standingResolutionHoursMedian: null,
  reopeningCycleHoursMedian: null,
  ...over,
});

test("a speed figure always names how many are still waiting", () => {
  const flattering = speed({
    resolvedCount: 1,
    stillWaitingCount: 99,
    firstConfirmationHoursMedian: 3,
  });
  const statement = speedStatement(flattering);
  assert.match(statement, /3 hours/);
  assert.match(statement, /99 issues in this group are still waiting/);
});

test("a cohort with no resolutions reports no speed rather than zero hours", () => {
  const statement = speedStatement(speed({ stillWaitingCount: 12 }));
  assert.match(statement, /No resolution time can be reported/);
  assert.match(statement, /12 issues in this group are still waiting/);
  assert.doesNotMatch(statement, /\b0 hours\b/);
});

test("a fully resolved cohort still states the unresolved count, as zero", () => {
  const statement = speedStatement(
    speed({ resolvedCount: 8, stillWaitingCount: 0, firstConfirmationHoursMedian: 40 }),
  );
  assert.match(statement, /0 issues in this group are still waiting/);
});

test("speed coverage exposes how little of the cohort a fast figure was measured from", () => {
  const coverage = speedCoverage(
    speed({ resolvedCount: 1, stillWaitingCount: 99, firstConfirmationHoursMedian: 3 }),
  );
  assert.equal(coverage.value, 1);
  assert.equal(speedCoverage(speed({})).value, null);
});

test("ResolutionSpeed offers no field that reads as an overall resolution time", () => {
  const fields = Object.keys(speed({}));
  for (const field of fields) {
    assert.doesNotMatch(
      field,
      /^(?:average|mean|overall)/i,
      `${field} would be read as a headline speed with no coverage attached`,
    );
  }
  assert.ok(fields.includes("stillWaitingCount"));
});

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

const exclusive = { mutuallyExclusive: true } as const;
const unproven = { mutuallyExclusive: false } as const;

test("distinct contributor counts are refused across areas, not summed", () => {
  const result = combineAcrossBoundaries(
    METRIC_CATALOGUE.M12,
    [
      { boundaryId: "ward-1", boundaryVersion: "v1", value: 9 },
      { boundaryId: "ward-2", boundaryVersion: "v1", value: 9 },
    ],
    exclusive,
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.unknownReason, "not_additive");
    assert.match(result.reason, /twice/);
  }
});

test("population may only be combined across boundaries proven not to overlap", () => {
  const parts = [
    { boundaryId: "block-a", boundaryVersion: "v1", value: 1200 },
    { boundaryId: "block-b", boundaryVersion: "v1", value: 800 },
  ];
  const refused = combineAcrossBoundaries(METRIC_CATALOGUE.M14, parts, unproven);
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.unknownReason, "overlapping_boundaries");

  const allowed = combineAcrossBoundaries(METRIC_CATALOGUE.M14, parts, exclusive);
  assert.equal(allowed.ok, true);
  if (allowed.ok) assert.equal(allowed.value.value, 2000);
});

test("values measured against different boundary versions are never added", () => {
  const result = combineAcrossBoundaries(
    METRIC_CATALOGUE.M01,
    [
      { boundaryId: "ward-1", boundaryVersion: "directory.v1", value: 4 },
      { boundaryId: "ward-2", boundaryVersion: "directory.v2", value: 6 },
    ],
    exclusive,
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.unknownReason, "mixed_boundary_versions");
    assert.match(result.reason, /describes no real area/);
  }
});

test("the same boundary counted twice is refused", () => {
  const result = combineAcrossBoundaries(
    METRIC_CATALOGUE.M01,
    [
      { boundaryId: "ward-1", boundaryVersion: "v1", value: 4 },
      { boundaryId: "ward-1", boundaryVersion: "v1", value: 4 },
    ],
    exclusive,
  );
  assert.equal(result.ok, false);
});

test("one unknown area makes the total unknown rather than the sum of the rest", () => {
  const result = combineAcrossBoundaries(
    METRIC_CATALOGUE.M01,
    [
      { boundaryId: "ward-1", boundaryVersion: "v1", value: 4 },
      { boundaryId: "ward-2", boundaryVersion: "v1", value: null },
    ],
    exclusive,
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.value, null);
    assert.equal(result.value.unknownReason, "dimension_not_reconstructible");
  }
});

test("additive counts do add across disjoint areas of one boundary version", () => {
  const result = combineAcrossBoundaries(
    METRIC_CATALOGUE.M01,
    [
      { boundaryId: "ward-1", boundaryVersion: "v1", value: 4 },
      { boundaryId: "ward-2", boundaryVersion: "v1", value: 6 },
    ],
    exclusive,
  );
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.value, 10);
});

test("aggregation safety is declared for the two metrics that must refuse", () => {
  assert.equal(METRIC_CATALOGUE.M12.aggregation, "not_additive");
  assert.equal(METRIC_CATALOGUE.M14.aggregation, "requires_exclusive_boundaries");
});

// ---------------------------------------------------------------------------
// Missing stays missing
// ---------------------------------------------------------------------------

test("an absent value always carries a reason, and a present value never does", () => {
  assert.deepEqual(unknown("no_population_source"), {
    value: null,
    unknownReason: "no_population_source",
  });
  assert.deepEqual(known(7), { value: 7, unknownReason: null });
});

test("population never falls back to zero, and never borrows report volume", () => {
  const contract = METRIC_CATALOGUE.M14;
  assert.match(contract.missingData, /falls back to 0/);
  assert.match(contract.missingData, /Neither ever falls back/);
  assert.match(contract.exclusions.join(" "), /report volume|contributor counts/i);
  // Two different unknowns, kept apart (V040): nothing was imported for this
  // boundary, versus the source itself recorded that it did not know.
  assert.match(contract.missingData, /no loaded observation/);
  assert.match(contract.missingData, /missing-data indicator/);
});

test("the population disclosure says the loaded figures are invented", () => {
  // V004 approves no external dataset for ingestion, so every population
  // figure in this demonstration is team-created. A screen inherits that
  // claim, so the disclosure has to carry it.
  const disclosure = METRIC_CATALOGUE.M14.disclosures.join(" ");
  assert.match(disclosure, /synthetic/i);
  assert.match(disclosure, /describe no real place/i);
  assert.match(disclosure, /unit, vintage and licence/i);
});

test("coverage exists so a reader can tell a real zero from missing data", () => {
  assert.match(METRIC_CATALOGUE.M15.disclosures.join(" "), /not zero incidence/i);
});
