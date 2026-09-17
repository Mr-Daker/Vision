/**
 * V041 sanctioned-project link proposals.
 *
 * The acceptance clause this file exists to hold: **no match is never
 * translated into a claim that government has not funded the asset.** Every
 * outcome carries the absence note, and no string this module can produce
 * survives the overclaim check.
 *
 * The rest is the weighting discipline: an asset identifier can carry a
 * proposal alone, place and scope can only corroborate each other, dates are
 * reported and never disqualify, and a tie is `ambiguous` rather than a coin
 * toss presented as a decision.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BANNED_ABSENCE_PHRASES,
  DEFAULT_PROJECT_THRESHOLDS,
  PROJECT_MATCHER_VERSION,
  REQUIRES_REVIEWER_DECISION,
  absenceOverclaims,
  absenceStatement,
  proposalText,
  proposeProjectMatch,
  type ProjectSignals,
} from "./project-match.ts";

const register = { registerName: "Demo synthetic project register", registerIsSynthetic: true };

const candidate = (over: Partial<ProjectSignals> = {}): ProjectSignals => ({
  projectId: "PRJ-1",
  projectName: "Block 1 handpump rehabilitation (synthetic)",
  sourceRecordId: "a0410000-0000-4000-8000-000000000041",
  sourceName: "Demo synthetic project register",
  synthetic: true,
  assetIdMatches: false,
  distanceMetres: undefined,
  sharedScopeTerms: [],
  sanctionedAt: "2025-04-01T00:00:00Z",
  completedAt: "2025-11-01T00:00:00Z",
  openedInsideProjectWindow: false,
  ...over,
});

const propose = (candidates: readonly ProjectSignals[]) =>
  proposeProjectMatch({ candidates, ...register });

// ---------------------------------------------------------------------------
// Absence is never a claim
// ---------------------------------------------------------------------------

test("an empty register produces a finding, and says what it does not mean", () => {
  const proposal = propose([]);
  assert.equal(proposal.outcome, "no_candidate");
  assert.match(proposal.absenceNote, /does not mean no project exists/);
  assert.match(proposal.absenceNote, /not evidence about whether this asset has been paid for/);
  assert.match(proposal.absenceNote, /Demo synthetic project register/);
});

test("the absence note travels with every outcome, not only the empty one", () => {
  const outcomes = [
    propose([]),
    propose([candidate({ assetIdMatches: true })]),
    propose([
      candidate({ projectId: "A", assetIdMatches: true }),
      candidate({ projectId: "B", assetIdMatches: true }),
    ]),
  ];
  for (const proposal of outcomes) {
    assert.match(
      proposal.absenceNote,
      /not evidence about whether this asset has been paid for/,
      `${proposal.outcome} must carry it too — a reader looking at one weak candidate reads the gaps around it as absence`,
    );
  }
});

test("a synthetic register says so; a real one says it may be incomplete", () => {
  assert.match(absenceStatement(register), /team-created synthetic data/);
  assert.match(
    absenceStatement({ registerName: "A register", registerIsSynthetic: false }),
    /may be incomplete/,
  );
});

test("nothing this module produces can be read as a claim about funding", () => {
  const everything = [
    propose([]),
    propose([candidate({ assetIdMatches: true })]),
    propose([candidate({ distanceMetres: 40, sharedScopeTerms: ["water_supply"] })]),
    propose([
      candidate({ projectId: "A", distanceMetres: 40, sharedScopeTerms: ["water_supply"] }),
      candidate({ projectId: "B", distanceMetres: 60, sharedScopeTerms: ["water_supply"] }),
    ]),
    propose([candidate({ distanceMetres: 2000 })]),
  ]
    .map(proposalText)
    .join(" \n ");
  assert.deepEqual(absenceOverclaims(everything), []);
});

test("the overclaim check is live, not decorative", () => {
  assert.ok(BANNED_ABSENCE_PHRASES.length >= 6);
  assert.equal(absenceOverclaims("this asset is not funded").length, 1);
  assert.equal(absenceOverclaims("government has not paid for this").length, 1);
});

// ---------------------------------------------------------------------------
// Nothing is decided here
// ---------------------------------------------------------------------------

test("every proposal demands a reviewer, and the flag is not a setting", () => {
  assert.equal(REQUIRES_REVIEWER_DECISION, true);
  for (const proposal of [propose([]), propose([candidate({ assetIdMatches: true })])]) {
    assert.equal(proposal.requiresReviewerDecision, true);
    assert.equal(proposal.matcherVersion, PROJECT_MATCHER_VERSION);
  }
});

// ---------------------------------------------------------------------------
// Weighting
// ---------------------------------------------------------------------------

test("one project naming the asset is a single candidate to show a reviewer", () => {
  const proposal = propose([
    candidate({ assetIdMatches: true }),
    candidate({ projectId: "PRJ-2", distanceMetres: 30 }),
  ]);
  assert.equal(proposal.outcome, "single_candidate");
  assert.equal(proposal.candidates.length, 1);
  assert.equal(proposal.candidates[0]?.projectId, "PRJ-1");
  assert.match(proposal.reasons.join(" "), /names this asset, and no other does/);
  assert.match(
    proposal.candidates[0]?.reasons.join(" ") ?? "",
    /the thing itself rather than a place near it/,
  );
});

test("two projects naming the same asset are ambiguous, never ranked", () => {
  const proposal = propose([
    candidate({ projectId: "A", assetIdMatches: true }),
    candidate({ projectId: "B", assetIdMatches: true }),
  ]);
  assert.equal(proposal.outcome, "ambiguous");
  assert.equal(proposal.candidates.length, 2);
  assert.match(proposal.reasons.join(" "), /a ranking between them would be arbitrary/);
});

test("proximity alone is never enough to propose a link", () => {
  const proposal = propose([candidate({ distanceMetres: 20 })]);
  assert.equal(
    proposal.outcome,
    "no_candidate",
    "a sanctioned drain twenty metres from a broken light is not that light's funding",
  );
  assert.match(proposal.reasons.join(" "), /a single weak signal only/);
});

test("shared scope alone is never enough either", () => {
  const proposal = propose([candidate({ sharedScopeTerms: ["water_supply"] })]);
  assert.equal(proposal.outcome, "no_candidate");
});

test("place and scope together are enough to propose, and said to be no more", () => {
  const proposal = propose([candidate({ distanceMetres: 40, sharedScopeTerms: ["water_supply"] })]);
  assert.equal(proposal.outcome, "single_candidate");
  assert.match(proposal.reasons.join(" "), /enough to show a reviewer and not enough to conclude/);
});

test("two projects matching on place and scope are ambiguous", () => {
  const proposal = propose([
    candidate({ projectId: "A", distanceMetres: 40, sharedScopeTerms: ["water_supply"] }),
    candidate({ projectId: "B", distanceMetres: 90, sharedScopeTerms: ["water_supply"] }),
  ]);
  assert.equal(proposal.outcome, "ambiguous");
  assert.match(proposal.reasons.join(" "), /a coin toss presented as a decision/);
});

test("a project beyond the distance threshold contributes no geography signal", () => {
  const proposal = propose([
    candidate({
      distanceMetres: DEFAULT_PROJECT_THRESHOLDS.maxDistanceMetres + 1,
      sharedScopeTerms: ["water_supply"],
    }),
  ]);
  assert.equal(proposal.outcome, "no_candidate");
});

test("an asset match outranks a place-and-scope match rather than competing with it", () => {
  const proposal = propose([
    candidate({ projectId: "NAMED", assetIdMatches: true }),
    candidate({ projectId: "NEARBY", distanceMetres: 10, sharedScopeTerms: ["water_supply"] }),
  ]);
  assert.equal(proposal.outcome, "single_candidate");
  assert.equal(proposal.candidates[0]?.projectId, "NAMED");
});

// ---------------------------------------------------------------------------
// Dates report, they do not disqualify
// ---------------------------------------------------------------------------

test("a project completed long before the report still links on its identifier", () => {
  const proposal = propose([
    candidate({
      assetIdMatches: true,
      completedAt: "2019-03-01T00:00:00Z",
      openedInsideProjectWindow: false,
    }),
  ]);
  assert.equal(
    proposal.outcome,
    "single_candidate",
    "funding history is exactly what somebody asking 'has this been paid for before?' wants",
  );
  assert.equal(proposal.candidates[0]?.methods.includes("date_window"), false);
});

test("a report opened inside the project window says so as a reason", () => {
  const proposal = propose([candidate({ assetIdMatches: true, openedInsideProjectWindow: true })]);
  assert.ok(proposal.candidates[0]?.methods.includes("date_window"));
  assert.match(
    proposal.candidates[0]?.reasons.join(" ") ?? "",
    /between the project's sanction on/,
  );
});

test("a project with no completion date is described as still open, not as missing", () => {
  const proposal = propose([
    candidate({ assetIdMatches: true, completedAt: undefined, openedInsideProjectWindow: true }),
  ]);
  assert.match(proposal.candidates[0]?.reasons.join(" ") ?? "", /still-open completion/);
});

// ---------------------------------------------------------------------------
// Missing positions
// ---------------------------------------------------------------------------

test("an uncomputable distance is reported rather than assumed either way", () => {
  const proposal = propose([candidate({ assetIdMatches: true, distanceMetres: undefined })]);
  assert.match(proposal.candidates[0]?.reasons.join(" ") ?? "", /no distance could be computed/);
  assert.match(proposal.candidates[0]?.reasons.join(" ") ?? "", /rather than assumed either way/);
});
