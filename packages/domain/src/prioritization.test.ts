/**
 * V042 prioritization and sensitivity.
 *
 * The acceptance clauses this file holds:
 *
 *   * **a lower-reporting high-need case can rank appropriately for
 *     explainable reasons** — driven by the equity factor, which treats few
 *     reports per head as a reason to rank higher;
 *   * **changing plausible weights exposes rank sensitivity** — enforced
 *     structurally, because there is no way to obtain an ordering without an
 *     interval;
 *   * **neither an arbitrary score nor model prose is presented as optimal
 *     public spending** — no published score field exists, and no string the
 *     module produces survives the overclaim check.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BANNED_PRIORITY_PHRASES,
  PRIORITY_FACTORS,
  PrioritizationError,
  contributionOf,
  orderingText,
  prioritise,
  priorityOverclaims,
  stabilityOf,
  type CandidateInput,
  type RecommendationPolicy,
  type Weighting,
} from "./prioritization.ts";

const weighting = (id: string, weights: Weighting["weights"]): Weighting => ({
  id,
  label: `Weighting ${id}`,
  rationale: `a defensible reading in which ${id} matters most`,
  weights,
});

const policy = (over: Partial<RecommendationPolicy> = {}): RecommendationPolicy => ({
  version: "test-priority.v1",
  weightings: [
    weighting("equity-led", { reporting_equity: 0.5, persistence: 0.3, service_population: 0.2 }),
    weighting("persistence-led", {
      persistence: 0.6,
      reporting_equity: 0.2,
      service_population: 0.2,
    }),
  ],
  references: {
    persistenceReferenceDays: 90,
    persistencePerReopening: 0.2,
    populationReferenceCount: 20000,
    equityReferenceRatePer1000: 10,
    alternativesReferenceCount: 3,
  },
  existingProjectDirection: "deprioritise",
  existingProjectRationale: "a confirmed project suggests the work is already planned",
  minimumFactorsForRanking: 2,
  budgetAssumption:
    "No budget, cost or capacity information is used. This ordering does not sequence spending and cannot say what is affordable.",
  note: "An ordering of reports by configured factors, not a finding about need.",
  ...over,
});

const candidate = (over: Partial<CandidateInput> = {}): CandidateInput => ({
  candidateId: "C1",
  label: "Report C1",
  jurisdictionKey: "ward-1",
  category: "water_supply",
  openDays: 30,
  reopeningCount: 0,
  servicePopulation: 10000,
  wardReportCount: 50,
  alternativesNearby: 1,
  hasConfirmedProject: false,
  projectRegisterSearched: true,
  ...over,
});

// ---------------------------------------------------------------------------
// Sensitivity is not optional
// ---------------------------------------------------------------------------

test("a policy with one weighting is refused", () => {
  assert.throws(
    () =>
      prioritise([candidate()], policy({ weightings: [weighting("only", { persistence: 1 })] })),
    (error: unknown) =>
      error instanceof PrioritizationError && /looks like a finding/.test(error.message),
  );
});

test("an ordering publishes an interval, and no single position", () => {
  const ordering = prioritise(
    [candidate(), candidate({ candidateId: "C2", label: "Report C2" })],
    policy(),
  );
  for (const placement of ordering.placements) {
    assert.notEqual(placement.bestRank, null);
    assert.notEqual(placement.worstRank, null);
    assert.match(placement.explanation, /Between \d+ and \d+ of \d+ across 2 plausible weightings/);
  }
  // There is no field a caller could read as the position or the score.
  const fields = Object.keys(ordering.placements[0] ?? {});
  for (const field of fields) {
    assert.doesNotMatch(field, /^(score|priority|rank)$/i, `${field} would read as the answer`);
  }
});

test("a candidate whose position swings across the list is reported as unstable", async () => {
  // Five candidates ordered one way by persistence and exactly the reverse by
  // equity. Both readings are defensible, and the point is that the ordering
  // between them is a choice rather than a finding.
  const candidates = [
    candidate({ candidateId: "A", openDays: 0, wardReportCount: 0 }),
    candidate({ candidateId: "B", openDays: 30, wardReportCount: 25 }),
    candidate({ candidateId: "C", openDays: 60, wardReportCount: 50 }),
    candidate({ candidateId: "D", openDays: 90, wardReportCount: 75 }),
    candidate({ candidateId: "E", openDays: 300, wardReportCount: 100 }),
  ];
  const ordering = prioritise(
    candidates,
    policy({
      weightings: [
        weighting("equity-only", { reporting_equity: 1 }),
        weighting("persistence-only", { persistence: 1 }),
      ],
      references: { ...policy().references, persistenceReferenceDays: 400 },
      minimumFactorsForRanking: 1,
    }),
  );

  const first = ordering.placements.find((placement) => placement.candidateId === "A");
  assert.equal(first?.bestRank, 1, "equity puts the quietest, newest report first");
  assert.equal(first?.worstRank, 5, "persistence puts it last");
  assert.equal(
    first?.stability,
    "unstable",
    "and the module says the ordering reports the weighting rather than the evidence",
  );
  assert.match(first?.explanation ?? "", /says almost nothing about this candidate/);
});

test("stability is measured against the candidate's own position, not the list length", () => {
  // The part of the ordering anybody reads is the top, and a
  // proportion-of-the-list measure reports every swing there as negligible.
  assert.equal(stabilityOf(7, 16), "unstable", "nine places at position seven is enormous");
  assert.equal(stabilityOf(100, 110), "robust", "ten places at position one hundred is nothing");
  assert.equal(stabilityOf(1, 2), "sensitive", "the top spot changing is worth saying");
  assert.equal(stabilityOf(1, 1), "robust");
  assert.equal(stabilityOf(1, 5), "unstable");
});

// ---------------------------------------------------------------------------
// Low reporting is not low need
// ---------------------------------------------------------------------------

test("a quiet ward with a large population outranks a loud one, for stated reasons", () => {
  const quietHighNeed = candidate({
    candidateId: "QUIET",
    label: "Report in a ward that rarely files",
    servicePopulation: 18000,
    wardReportCount: 6,
    openDays: 120,
  });
  const loudLowNeed = candidate({
    candidateId: "LOUD",
    label: "Report in a ward that files constantly",
    servicePopulation: 4000,
    wardReportCount: 400,
    openDays: 120,
  });

  const ordering = prioritise([loudLowNeed, quietHighNeed], policy());
  const quiet = ordering.placements.find((placement) => placement.candidateId === "QUIET");
  const loud = ordering.placements.find((placement) => placement.candidateId === "LOUD");
  assert.equal(quiet?.bestRank, 1);
  assert.equal(loud?.worstRank, 2);

  const equity = quiet?.factors.find((factor) => factor.factor === "reporting_equity");
  assert.equal(equity?.status, "available");
  assert.match(
    equity?.explanation ?? "",
    /low reporting is not evidence of low need/,
    "the reason has to be readable, not inferred from the position",
  );
});

test("the equity factor is inverted deliberately, and says so", () => {
  const quiet = contributionOf(
    "reporting_equity",
    candidate({ servicePopulation: 10000, wardReportCount: 10 }),
    policy(),
  );
  const loud = contributionOf(
    "reporting_equity",
    candidate({ servicePopulation: 10000, wardReportCount: 300 }),
    policy(),
  );
  assert.ok((quiet.value ?? 0) > (loud.value ?? 1));
  assert.equal(loud.value, 0, "a ward already reporting above the reference gets no boost");
});

// ---------------------------------------------------------------------------
// Missing data never scores zero
// ---------------------------------------------------------------------------

test("a factor with no data has its weight redistributed, not counted as zero", () => {
  const withPopulation = candidate({ candidateId: "WITH" });
  const withoutPopulation = candidate({
    candidateId: "WITHOUT",
    servicePopulation: null,
    wardReportCount: null,
  });
  const ordering = prioritise([withPopulation, withoutPopulation], policy());

  const missing = ordering.placements.find((placement) => placement.candidateId === "WITHOUT");
  const population = missing?.factors.find((factor) => factor.factor === "service_population");
  assert.equal(population?.status, "missing_for_this_candidate");
  assert.equal(population?.contribution, null, "never 0");
  assert.equal(population?.appliedWeight, 0);
  assert.match(
    population?.explanation ?? "",
    /redistributed rather than counted as nobody living there/,
  );

  // The surviving factors carry the whole weight between them.
  const applied = (missing?.factors ?? [])
    .filter((factor) => factor.contribution !== null)
    .reduce((total, factor) => total + factor.appliedWeight, 0);
  assert.equal(Math.round(applied * 100) / 100, 1);
});

test("a ward that has been measured less is not pushed to the bottom for it", () => {
  const measured = candidate({ candidateId: "MEASURED", openDays: 10 });
  const unmeasured = candidate({
    candidateId: "UNMEASURED",
    openDays: 200,
    servicePopulation: null,
    wardReportCount: null,
    alternativesNearby: null,
  });
  const ordering = prioritise([measured, unmeasured], policy({ minimumFactorsForRanking: 1 }));
  const unmeasuredPlacement = ordering.placements.find(
    (placement) => placement.candidateId === "UNMEASURED",
  );
  assert.equal(
    unmeasuredPlacement?.bestRank,
    1,
    "with its remaining factor carrying the weight, the long-open report still ranks first",
  );
});

test("too few factors means not ranked at all, and the candidate is still listed", () => {
  const starved = candidate({
    candidateId: "STARVED",
    servicePopulation: null,
    wardReportCount: null,
    alternativesNearby: null,
    projectRegisterSearched: false,
  });
  const ordering = prioritise([candidate(), starved], policy({ minimumFactorsForRanking: 3 }));
  const placement = ordering.placements.find((item) => item.candidateId === "STARVED");
  assert.equal(placement?.stability, "not_ranked");
  assert.equal(placement?.bestRank, null);
  assert.equal(ordering.unranked.length, 1);
  assert.match(ordering.unranked[0]?.reason ?? "", /wearing a ranking's clothes/);
  assert.match(placement?.explanation ?? "", /listed here rather than dropped/);
});

// ---------------------------------------------------------------------------
// A candidate does not depend on its cohort
// ---------------------------------------------------------------------------

test("a candidate's factors do not change when unrelated candidates are added", () => {
  const subject = candidate({ candidateId: "SUBJECT" });
  const alone = prioritise([subject, candidate({ candidateId: "OTHER" })], policy());
  const crowded = prioritise(
    [
      subject,
      candidate({ candidateId: "OTHER" }),
      candidate({ candidateId: "X", openDays: 900, wardReportCount: 1 }),
      candidate({ candidateId: "Y", servicePopulation: 90000 }),
    ],
    policy(),
  );
  const before = alone.placements.find((placement) => placement.candidateId === "SUBJECT")?.factors;
  const after = crowded.placements.find(
    (placement) => placement.candidateId === "SUBJECT",
  )?.factors;
  assert.deepEqual(after, before, "no percentile or z-score may make this depend on the cohort");
});

// ---------------------------------------------------------------------------
// Factors that have no source
// ---------------------------------------------------------------------------

test("severity is declared and permanently empty, rather than left out", () => {
  assert.ok(PRIORITY_FACTORS.includes("severity"));
  const outcome = contributionOf("severity", candidate(), policy());
  assert.equal(outcome.status, "no_source_in_deployment");
  assert.equal(outcome.value, null);
  assert.match(outcome.explanation, /never had a calibrated severity model/);
  assert.match(outcome.explanation, /V046/);
});

test("accessibility is declared and empty too, naming what was imported instead", () => {
  const outcome = contributionOf("accessibility", candidate(), policy());
  assert.equal(outcome.status, "no_source_in_deployment");
  assert.match(outcome.explanation, /declared and empty rather than quietly dropped/);
});

test("an unsearched project register is distinguished from a search that found nothing", () => {
  const unsearched = contributionOf(
    "existing_project",
    candidate({ projectRegisterSearched: false }),
    policy(),
  );
  assert.equal(unsearched.status, "missing_for_this_candidate");
  assert.match(unsearched.explanation, /different state from having searched it and found nothing/);

  const searched = contributionOf(
    "existing_project",
    candidate({ projectRegisterSearched: true, hasConfirmedProject: false }),
    policy(),
  );
  assert.equal(searched.status, "available");
  assert.match(searched.explanation, /not evidence that nothing was funded/);
});

test("the direction of the existing-project factor is configured, with its rationale", () => {
  const deprioritised = contributionOf(
    "existing_project",
    candidate({ hasConfirmedProject: true }),
    policy(),
  );
  const prioritised = contributionOf(
    "existing_project",
    candidate({ hasConfirmedProject: true }),
    policy({
      existingProjectDirection: "prioritise",
      existingProjectRationale:
        "a confirmed project that did not fix it is evidence of a repeat failure",
    }),
  );
  assert.equal(deprioritised.value, 0);
  assert.equal(prioritised.value, 1);
  assert.match(prioritised.explanation, /repeat failure/);
});

// ---------------------------------------------------------------------------
// Disclosures and vocabulary
// ---------------------------------------------------------------------------

test("every ordering carries its budget assumption and what it is not", () => {
  const ordering = prioritise([candidate()], policy());
  const disclosures = ordering.disclosures.join(" ");
  assert.match(disclosures, /No budget, cost or capacity information is used/);
  assert.match(disclosures, /not a statement about how public money should be spent/);
  assert.match(disclosures, /never counted as zero/);
  assert.match(disclosures, /2 plausible weightings/);
});

test("nothing an ordering produces presents it as a spending decision", () => {
  const ordering = prioritise(
    [
      candidate(),
      candidate({ candidateId: "C2", servicePopulation: null, wardReportCount: null }),
      candidate({ candidateId: "C3", projectRegisterSearched: false, alternativesNearby: null }),
    ],
    policy({ minimumFactorsForRanking: 3 }),
  );
  assert.deepEqual(priorityOverclaims(orderingText(ordering)), []);
});

test("the overclaim check is live, not decorative", () => {
  assert.ok(BANNED_PRIORITY_PHRASES.length >= 6);
  assert.equal(priorityOverclaims("this is the optimal allocation").length, 1);
  assert.equal(priorityOverclaims("the highest need ward").length, 1);
  assert.equal(priorityOverclaims("this should be funded first").length, 1);
});
