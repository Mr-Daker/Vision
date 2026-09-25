/**
 * The refusals that make a durability figure publishable (roadmap V050a).
 *
 * The arithmetic is the easy part. What these test is the set of things the
 * module will not do with it — because a measurement attached to the people
 * doing public work is one bad inference away from being a disciplinary tool.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BANNED_DURABILITY_PHRASES,
  DURABILITY_LIMITS,
  MINIMUM_CLOSURES_FOR_A_CONCERN,
  DURABILITY_SIGNALS,
  RANKING_REFUSAL,
  SIGNAL_MEANING,
  concernsFrom,
  durabilityFigure,
  durabilityOverclaims,
  separated,
  type DurabilitySignal,
  type UnitObservation,
} from "./resolution-durability.ts";
import { figureOf } from "./evaluation.ts";

const unit = (
  label: string,
  confirmed: number,
  didNotHold: number,
  claims = confirmed,
): UnitObservation => ({
  unit: { departmentId: "dept", jurisdictionId: "ward", label },
  confirmedClosures: confirmed,
  answeredClaims: confirmed,
  claims,
  counts: {
    did_not_hold: didNotHold,
    disputed_by_reporter: 0,
    claimed_near_deadline: 0,
    claimed_implausibly_fast: 0,
    minimum_evidence: 0,
  },
});

// ---------------------------------------------------------------------------
// No score
// ---------------------------------------------------------------------------

test("a figure is counts and an interval, never a rate at small denominators", () => {
  const figure = durabilityFigure(unit("a", 3, 1), "did_not_hold");
  assert.equal(figure.kind, "counted");
  // One of three coming back is not "33%".
  assert.ok(figure.kind === "counted" && !figure.rateReportable);
});

test("each signal uses the denominator that belongs to it", () => {
  const observation: UnitObservation = {
    ...unit("a", 10, 2, 40),
    answeredClaims: 20,
  };
  const held = durabilityFigure(observation, "did_not_hold");
  const disputed = durabilityFigure(observation, "disputed_by_reporter");
  const thin = durabilityFigure(observation, "minimum_evidence");
  // Confirmed closures, answered claims and all claims are three different
  // populations, and V037's rule is that a rate must name the one it used.
  assert.ok(held.kind === "counted" && held.denominator === 10);
  assert.ok(disputed.kind === "counted" && disputed.denominator === 20);
  assert.ok(thin.kind === "counted" && thin.denominator === 40);
});

// ---------------------------------------------------------------------------
// No league table
// ---------------------------------------------------------------------------

test("two units whose intervals overlap are not distinguishable", () => {
  assert.equal(separated(figureOf(6, 47), figureOf(3, 37)), false);
});

test("a unit far outside the rest is distinguishable", () => {
  assert.equal(separated(figureOf(18, 39), figureOf(13, 119)), true);
});

test("a unit is compared against everyone else pooled, never against itself", () => {
  const observations = [unit("problem", 39, 18), unit("a", 47, 6), unit("b", 37, 3)];
  const concerns = concernsFrom({ observations, signal: "did_not_hold" });
  assert.equal(concerns.length, 1);
  assert.equal(concerns[0]?.unit.label, "problem");
  // The baseline excludes the unit under examination: 6 + 3 of 47 + 37.
  assert.ok(concerns[0]?.baseline.kind === "counted" && concerns[0].baseline.denominator === 84);
});

test("a unit that looks worse but overlaps raises nothing", () => {
  const observations = [unit("a", 47, 6), unit("b", 37, 3), unit("c", 35, 4)];
  assert.deepEqual(concernsFrom({ observations, signal: "did_not_hold" }), []);
});

test("a unit that is better than everyone else is never raised as a concern", () => {
  // Separation is symmetric; a concern is not. Being distinguishably good is
  // not something to send a supervisor to investigate, so `spotless` must be
  // absent even though its interval is nowhere near the others'.
  const observations = [unit("spotless", 60, 0), unit("a", 40, 18), unit("b", 40, 16)];
  const raised = concernsFrom({ observations, signal: "did_not_hold" }).map((c) => c.unit.label);
  assert.ok(
    !raised.includes("spotless"),
    `a distinguishably good unit was raised: ${raised.join()}`,
  );
});

test("a unit with a handful of closures is never raised, however bad it looks", () => {
  // Two of two coming back does separate from an eleven-percent baseline, and
  // raising it anyway would send somebody to examine a team's work on the
  // strength of two events.
  const observations = [unit("tiny", 2, 2), unit("a", 47, 6), unit("b", 37, 3)];
  assert.deepEqual(concernsFrom({ observations, signal: "did_not_hold" }), []);
});

test("the closure floor is the only thing holding that unit back, not the arithmetic", () => {
  // The same proportion, above the floor, is raised — so the floor is doing
  // real work rather than the figure simply being unremarkable.
  const observations = [unit("bigger", 12, 12), unit("a", 47, 6), unit("b", 37, 3)];
  assert.equal(concernsFrom({ observations, signal: "did_not_hold" }).length, 1);
});

// ---------------------------------------------------------------------------
// Every finding carries what it cannot rule out
// ---------------------------------------------------------------------------

test("a concern carries the innocent explanations and a next step that is not discipline", () => {
  const concerns = concernsFrom({
    observations: [unit("problem", 39, 18), unit("a", 47, 6), unit("b", 37, 3)],
    signal: "did_not_hold",
  });
  const concern = concerns[0];
  assert.ok(concern !== undefined);
  assert.ok(concern.alternatives.length >= 3);
  assert.match(concern.nextStep, /read the issues themselves/);
  assert.doesNotMatch(concern.nextStep, /disciplin|suspend|penal/i);
});

test("every signal declares both what it observed and what it cannot rule out", () => {
  for (const signal of DURABILITY_SIGNALS) {
    const meaning = SIGNAL_MEANING[signal as DurabilitySignal];
    assert.ok(meaning.observed.length > 20, `${signal} does not say what it observed`);
    assert.ok(meaning.alternatives.length >= 3, `${signal} lists too few alternatives`);
  }
});

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

test("the banned phrasings catch a claim about intent", () => {
  assert.ok(
    durabilityOverclaims("The ward's sanitation crew is falsifying closures and is negligent.")
      .length >= 2,
  );
  assert.ok(durabilityOverclaims("reliability score of 62").length >= 1);
  assert.ok(durabilityOverclaims("the worst performing ward").length >= 1);
});

test("the honest sentences this report needs are not banned", () => {
  const honest = [
    "18 of 39 confirmed closures in this ward did not hold.",
    "That is a fact about the work, not a finding about the people who did it.",
    "The same repair may simply fail sooner here.",
  ].join(" ");
  assert.deepEqual(durabilityOverclaims(honest), []);
});

test("every banned phrase is lower case so the substring check cannot miss one", () => {
  for (const phrase of BANNED_DURABILITY_PHRASES) assert.equal(phrase, phrase.toLowerCase());
});

test("the closure floor is stated rather than hidden in a comparison", () => {
  assert.ok(MINIMUM_CLOSURES_FOR_A_CONCERN >= 10);
});

test("the limits name the signal that was deliberately given up", () => {
  assert.ok(DURABILITY_LIMITS.some((limit) => /EXIF|location data from staff phones/.test(limit)));
  assert.ok(DURABILITY_LIMITS.some((limit) => /not thereby cleared/.test(limit)));
  assert.match(RANKING_REFUSAL, /never ordered/);
});
