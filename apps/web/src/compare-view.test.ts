/**
 * V043 comparison view presentation.
 *
 * The acceptance clauses this file holds:
 *
 *   * **a reviewer can explain why one intervention ranks above another** —
 *     `factorComparison` does the subtraction and `separationSummary` names
 *     the factors that carry the gap;
 *   * **a reviewer can identify unsupported assumptions** — the asserted and
 *     absent ones lead the list and are toned apart from the evidenced ones;
 *   * **recorded outcomes during a project are distinguishable from proof that
 *     spending caused them** — no outcome is ever toned as a success, and the
 *     attribution note is required beside it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { attributionOverclaims, priorityOverclaims } from "@vision/domain";

import {
  ASSUMPTION_HEADINGS,
  ASSUMPTION_TONES,
  OUTCOME_RELATION_LABELS,
  OUTCOME_TONES,
  STABILITY_LABELS,
  STABILITY_TONES,
  UNSEARCHED_REGISTER_NOTE,
  assumptionsByScrutiny,
  factorComparison,
  positionText,
  projectSummary,
  rankUnder,
  separationSummary,
  type ComparisonPayload,
  type FactorOutcomeView,
  type PlacementView,
} from "./compare-view.ts";

const factor = (over: Partial<FactorOutcomeView> = {}): FactorOutcomeView => ({
  factor: "persistence",
  status: "available",
  contribution: 0.8,
  appliedWeight: 0.3,
  explanation: "open 96 days against a reference of 120",
  ...over,
});

const placement = (over: Partial<PlacementView> = {}): PlacementView => ({
  candidateId: "C1",
  label: "VIS-A",
  bestRank: 1,
  worstRank: 1,
  stability: "robust",
  underWeighting: [
    { weightingId: "balanced", rank: 1 },
    { weightingId: "equity-led", rank: 1 },
  ],
  factors: [
    factor(),
    factor({ factor: "reporting_equity", contribution: 0.9, appliedWeight: 0.25 }),
  ],
  explanation: "Between 1 and 1 of 200 across 4 plausible weightings.",
  ...over,
});

const payload = (over: Partial<ComparisonPayload> = {}): ComparisonPayload => ({
  policyVersion: "demo-priority.v1",
  weightingIds: ["balanced", "equity-led"],
  asOf: "2026-09-17T00:00:00.000Z",
  candidateCount: 200,
  exhaustive: false,
  candidates: [],
  assumptions: [
    { id: "a", statement: "Evidenced thing.", support: "evidenced", detail: "A loaded source." },
    { id: "b", statement: "Chosen thing.", support: "asserted", detail: "A choice." },
    { id: "c", statement: "Missing thing.", support: "absent", detail: "No source." },
  ],
  disclosures: [],
  unranked: [],
  note: "Every figure here counts reports this demonstration received.",
  ...over,
});

// ---------------------------------------------------------------------------
// Positions stay intervals
// ---------------------------------------------------------------------------

test("a position is always a range, even when the weightings agreed", () => {
  // "3" says the system knows. "3 to 3" says the weightings agreed, which is
  // the honest version of the same fact.
  assert.equal(positionText(placement({ bestRank: 3, worstRank: 3 })), "3 to 3");
  assert.equal(positionText(placement({ bestRank: 7, worstRank: 16 })), "7 to 16");
  assert.equal(positionText(placement({ bestRank: null, worstRank: null })), "Not ranked");
});

test("no position rendering produces a bare number", () => {
  for (const shape of [
    placement({ bestRank: 1, worstRank: 1 }),
    placement({ bestRank: 2, worstRank: 9 }),
  ]) {
    assert.match(
      positionText(shape),
      / to /,
      "a scenario comparison must not become a leaderboard",
    );
  }
});

test("a moving position is toned as a caveat and labelled in words", () => {
  assert.equal(STABILITY_TONES.robust, "neutral");
  assert.equal(STABILITY_TONES.sensitive, "caution");
  assert.equal(STABILITY_TONES.unstable, "caution");
  assert.match(STABILITY_LABELS.unstable, /across much of the list/);
  assert.match(STABILITY_LABELS.not_ranked, /too few factors had data/i);
});

test("a candidate's position under each named weighting is available for the scenario view", () => {
  const shape = placement();
  assert.equal(rankUnder(shape, "balanced"), "1");
  assert.equal(rankUnder(shape, "nonexistent"), "not ranked");
});

// ---------------------------------------------------------------------------
// Why one ranks above another
// ---------------------------------------------------------------------------

test("the comparison does the subtraction, ordered by what carries the gap", () => {
  const left = placement({
    label: "VIS-A",
    factors: [
      factor({ factor: "persistence", contribution: 0.9, appliedWeight: 0.3 }),
      factor({ factor: "reporting_equity", contribution: 0.95, appliedWeight: 0.25 }),
    ],
  });
  const right = placement({
    candidateId: "C2",
    label: "VIS-B",
    factors: [
      factor({ factor: "persistence", contribution: 0.85, appliedWeight: 0.3 }),
      factor({ factor: "reporting_equity", contribution: 0.1, appliedWeight: 0.25 }),
    ],
  });

  const differences = factorComparison(left, right);
  assert.equal(differences[0]?.factor, "reporting_equity", "the biggest gap leads");
  assert.equal(differences[0]?.separates, true);
  assert.ok((differences[0]?.weightedDifference ?? 0) > 0);

  const summary = separationSummary(left, right, differences);
  assert.match(summary, /VIS-A sits above VIS-B mainly on reporting equity/);
  assert.match(summary, /Positive figures favour VIS-A/);
});

test("two candidates that barely differ are said to barely differ", () => {
  const left = placement({ label: "VIS-A" });
  const right = placement({ candidateId: "C2", label: "VIS-B" });
  const summary = separationSummary(left, right, factorComparison(left, right));
  assert.match(summary, /Nothing separates VIS-A and VIS-B/);
  assert.match(
    summary,
    /not a finding about either of them/,
    "an order between indistinguishable candidates is not evidence",
  );
});

test("a factor one side is missing accounts for none of the gap, and says so", () => {
  const left = placement({
    factors: [factor({ factor: "service_population", contribution: 0.9, appliedWeight: 0.2 })],
  });
  const right = placement({
    candidateId: "C2",
    factors: [
      factor({
        factor: "service_population",
        contribution: null,
        appliedWeight: 0,
        status: "missing_for_this_candidate",
      }),
    ],
  });
  const [difference] = factorComparison(left, right);
  assert.equal(difference?.weightedDifference, 0);
  assert.equal(difference?.separates, false);
  assert.match(
    difference?.explanation ?? "",
    /not the same as the two being equal on it/,
    "a missing value scored as a zero difference would read as agreement",
  );
});

// ---------------------------------------------------------------------------
// Assumptions
// ---------------------------------------------------------------------------

test("the assumptions a reviewer would argue with come first", () => {
  // A list that opens with what is well supported invites the reader to stop
  // there.
  const ordered = assumptionsByScrutiny(payload());
  assert.deepEqual(
    ordered.map((assumption) => assumption.support),
    ["absent", "asserted", "evidenced"],
  );
});

test("asserted and absent assumptions are toned apart from evidenced ones", () => {
  assert.equal(ASSUMPTION_TONES.evidenced, "neutral");
  assert.equal(ASSUMPTION_TONES.asserted, "caution");
  assert.equal(ASSUMPTION_TONES.absent, "absent");
  assert.match(ASSUMPTION_HEADINGS.asserted, /Chosen by this deployment/);
  assert.match(ASSUMPTION_HEADINGS.absent, /No source exists/);
});

// ---------------------------------------------------------------------------
// Outcomes are never a result
// ---------------------------------------------------------------------------

test("an outcome inside a project's dates is toned as a caveat, never as a success", () => {
  assert.equal(OUTCOME_TONES.during, "caution");
  assert.equal(OUTCOME_TONES.before, "neutral");
  assert.equal(OUTCOME_TONES.unknown, "absent");
  for (const label of Object.values(OUTCOME_RELATION_LABELS)) {
    assert.doesNotMatch(label, /success|result|achiev|deliver/i, `"${label}" reads as an outcome`);
  }
});

test("every outcome label describes when it was recorded, not what it means", () => {
  assert.match(OUTCOME_RELATION_LABELS.during, /Recorded while the project was running/);
  assert.match(OUTCOME_RELATION_LABELS.unknown, /Cannot be placed/);
});

test("a project with no recorded completion is described as having none", () => {
  const summary = projectSummary({
    projectId: "P1",
    projectName: "Block works (synthetic)",
    status: "confirmed",
    amount: 860000,
    amountUnit: "inr",
    sanctionedAt: "2025-04-01T00:00:00.000Z",
    completedAt: null,
    outcomes: [],
    attributionNote: "",
    absenceNote: "",
  });
  assert.match(summary, /no recorded completion/);
  assert.match(summary, /860000 inr/);
});

test("an unsearched register is its own sentence, distinct from finding nothing", () => {
  assert.match(UNSEARCHED_REGISTER_NOTE, /not the same as having searched it and found nothing/);
  assert.match(UNSEARCHED_REGISTER_NOTE, /evidence about whether this asset has been paid for/);
});

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

test("no label on this screen asserts a cause or a spending decision", () => {
  const everything = [
    ...Object.values(STABILITY_LABELS),
    ...Object.values(ASSUMPTION_HEADINGS),
    ...Object.values(OUTCOME_RELATION_LABELS),
    UNSEARCHED_REGISTER_NOTE,
    separationSummary(placement(), placement({ candidateId: "C2", label: "VIS-B" }), []),
    positionText(placement()),
  ].join(" \n ");
  assert.deepEqual(attributionOverclaims(everything), []);
  assert.deepEqual(priorityOverclaims(everything), []);
});
