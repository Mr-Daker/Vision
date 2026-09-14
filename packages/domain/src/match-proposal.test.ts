/**
 * Duplicate-match proposals (roadmap V027).
 *
 * The proposal is advice with its reasons attached, never a decision that
 * takes effect on its own. Three outcomes only: attach to an existing issue,
 * open a new one, or say the evidence is ambiguous — and an ambiguous
 * proposal must be incapable of causing a merge, because a merge is the one
 * step that is expensive to undo.
 *
 * The hard case throughout is a *hard negative*: a different defect at
 * effectively the same place. Nearness is the weakest of the signals and must
 * never on its own collapse two distinct problems into one.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { proposeMatch, MATCHER_VERSION, type MatchSignals } from "./match-proposal.ts";

const signals = (overrides: Partial<MatchSignals> = {}): MatchSignals => ({
  issueId: "11111111-1111-1111-1111-111111111111",
  publicReference: "VIS-0001",
  distanceMetres: 20,
  positionAccuracyMetres: 10,
  assetMatches: false,
  categoryMatches: true,
  semanticDistance: 0.08,
  mediaNearDuplicate: undefined,
  issueOpenedAt: "2026-09-01T00:00:00Z",
  lastEvidenceAt: "2026-09-09T00:00:00Z",
  recurrence: undefined,
  ...overrides,
});

const input = (candidates: readonly MatchSignals[], overrides: Record<string, unknown> = {}) => ({
  candidates,
  observedAt: "2026-09-10T00:00:00Z",
  taxonomyVersion: "demo-taxonomy.v1",
  evidenceIds: ["ev-1"],
  ...overrides,
});

test("V027: no candidates yields a new-issue proposal, with a reason", () => {
  const proposal = proposeMatch(input([]));

  assert.equal(proposal.decision, "new_issue");
  assert.ok(proposal.reasons.length > 0);
  assert.equal(proposal.matcherVersion, MATCHER_VERSION);
});

test("V027: a close, same-category, semantically similar candidate is proposed as existing", () => {
  const proposal = proposeMatch(input([signals()]));

  assert.equal(proposal.decision, "existing_issue");
  if (proposal.decision !== "existing_issue") return;
  assert.equal(proposal.issueId, "11111111-1111-1111-1111-111111111111");
  assert.match(proposal.reasons.join(" "), /metres|semantic/i);
});

test("V027: a different category at the same place stays separate", () => {
  // The hard negative. Nearness alone must never merge two distinct problems.
  const proposal = proposeMatch(
    input([signals({ distanceMetres: 2, categoryMatches: false, semanticDistance: 0.05 })]),
  );

  assert.equal(proposal.decision, "new_issue");
  assert.match(proposal.reasons.join(" "), /categor/i);
});

test("V027: a same-asset candidate in a different category still stays separate", () => {
  const proposal = proposeMatch(
    input([signals({ assetMatches: true, categoryMatches: false, distanceMetres: 1 })]),
  );

  assert.equal(proposal.decision, "new_issue");
});

test("V027: a clearly different description near the same place is a new issue", () => {
  // A semantic distance of 0.62 is past the point where the meanings are
  // clearly different. That is evidence of difference, not an ambiguity —
  // proximity does not make two unlike reports uncertain.
  const proposal = proposeMatch(input([signals({ distanceMetres: 15, semanticDistance: 0.62 })]));

  assert.equal(proposal.decision, "new_issue");
  assert.match(proposal.reasons.join(" "), /descriptions differ/i);
});

test("V027: a borderline-similar description asks a person rather than guessing", () => {
  // Inside the similarity threshold but only just: similar enough that
  // "different problem" would be wrong, not similar enough to attach.
  const proposal = proposeMatch(input([signals({ distanceMetres: 15, semanticDistance: 0.2 })]));

  assert.equal(proposal.decision, "ambiguous");
  assert.match(proposal.reasons.join(" "), /not clearly the same/i);
});

test("V027: an ambiguous proposal can never authorise a merge", () => {
  // Both inside the similarity threshold, and far too close to each other to
  // rank. Candidates *above* the threshold would simply be ineligible, which
  // is a new issue rather than an ambiguity.
  const proposal = proposeMatch(
    input([
      signals({ issueId: "a", publicReference: "VIS-A", semanticDistance: 0.2 }),
      signals({ issueId: "b", publicReference: "VIS-B", semanticDistance: 0.205 }),
    ]),
  );

  assert.equal(proposal.decision, "ambiguous");
  if (proposal.decision !== "ambiguous") return;
  assert.equal(proposal.mayMerge, false);
  assert.equal(proposal.requiresReview, true);
  assert.ok(proposal.candidates.length >= 2);
});

test("V027: two near-equally-scored candidates are ambiguous, not a coin toss", () => {
  const proposal = proposeMatch(
    input([
      signals({
        issueId: "a",
        publicReference: "VIS-A",
        semanticDistance: 0.07,
        distanceMetres: 18,
      }),
      signals({
        issueId: "b",
        publicReference: "VIS-B",
        semanticDistance: 0.075,
        distanceMetres: 19,
      }),
    ]),
  );

  assert.equal(proposal.decision, "ambiguous");
});

test("V027: a clear leader among several candidates is proposed as existing", () => {
  const proposal = proposeMatch(
    input([
      signals({
        issueId: "a",
        publicReference: "VIS-A",
        semanticDistance: 0.04,
        distanceMetres: 5,
        assetMatches: true,
      }),
      signals({
        issueId: "b",
        publicReference: "VIS-B",
        semanticDistance: 0.55,
        distanceMetres: 140,
      }),
    ]),
  );

  assert.equal(proposal.decision, "existing_issue");
  if (proposal.decision !== "existing_issue") return;
  assert.equal(proposal.issueId, "a");
});

test("V027: reused media is reported as a reason but never decides the match alone", () => {
  // Identical bytes mean one photograph submitted twice. That is worth saying,
  // and it is not evidence that the two reports are about one problem.
  const proposal = proposeMatch(
    input([signals({ mediaNearDuplicate: true, categoryMatches: false, distanceMetres: 3 })]),
  );

  assert.equal(proposal.decision, "new_issue", "a different category still wins");
  assert.match(proposal.reasons.join(" "), /media|bytes|photograph/i);
});

test("V027: a recurrence candidate always requires a human decision", () => {
  const proposal = proposeMatch(
    input([
      signals({
        assetMatches: true,
        recurrence: {
          isRecurrenceCandidate: true,
          requiresHumanDecision: true,
          permittedTreatments: ["reopening_of_prior_issue", "new_issue_on_same_asset"],
          rationale: "the prior issue on this asset was confirmed resolved",
        },
      }),
    ]),
  );

  assert.equal(proposal.decision, "ambiguous");
  if (proposal.decision !== "ambiguous") return;
  assert.equal(proposal.requiresReview, true);
  // The branch where a wrong merge would do most damage: reopening a resolved
  // issue and opening a fresh one are different acts with different histories.
  assert.equal(proposal.mayMerge, false);
  assert.match(proposal.reasons.join(" "), /recurrence|resolved/i);
  assert.deepEqual(proposal.permittedTreatments, [
    "reopening_of_prior_issue",
    "new_issue_on_same_asset",
  ]);
});

test("V027: a non-recurrence classification does not force review", () => {
  const proposal = proposeMatch(
    input([
      signals({
        recurrence: {
          isRecurrenceCandidate: false,
          requiresHumanDecision: false,
          permittedTreatments: [],
          rationale: "the prior issue is not in a confirmed-resolved state",
        },
      }),
    ]),
  );

  assert.equal(proposal.decision, "existing_issue");
});

test("V027: every proposal carries versioned decision metadata and its evidence", () => {
  const proposal = proposeMatch(input([signals()], { evidenceIds: ["ev-1", "ev-2"] }));

  assert.equal(proposal.matcherVersion, MATCHER_VERSION);
  assert.equal(proposal.taxonomyVersion, "demo-taxonomy.v1");
  assert.deepEqual(proposal.evidenceIds, ["ev-1", "ev-2"]);
  // The thresholds that produced this decision travel with it, so a later
  // reader can tell a changed rule from a changed input.
  assert.ok(proposal.thresholds.maxSemanticDistance > 0);
  assert.ok(proposal.thresholds.maxDistanceMetres > 0);
});

test("V027: a candidate with no semantic vector is never matched on distance alone", () => {
  // Without a meaning comparison the only evidence is "it is near", which is
  // exactly the signal that must not decide by itself.
  const proposal = proposeMatch(
    input([signals({ semanticDistance: undefined, distanceMetres: 4 })]),
  );

  assert.notEqual(proposal.decision, "existing_issue");
  assert.match(proposal.reasons.join(" "), /no semantic|not compared|without a/i);
});

test("V027: a same-asset, same-category candidate may match without a vector", () => {
  // An asset identifier is a much stronger signal than proximity: it names
  // the physical thing rather than a place near it.
  const proposal = proposeMatch(
    input([
      signals({
        semanticDistance: undefined,
        assetMatches: true,
        categoryMatches: true,
        distanceMetres: 900,
      }),
    ]),
  );

  assert.equal(proposal.decision, "existing_issue");
  assert.match(proposal.reasons.join(" "), /asset/i);
});

test("V027: a candidate beyond the distance threshold and without an asset match is not proposed", () => {
  const proposal = proposeMatch(
    input([signals({ distanceMetres: 5_000, assetMatches: false, semanticDistance: 0.02 })]),
  );

  assert.equal(proposal.decision, "new_issue");
});

test("V027: the accuracy figure widens what counts as the same place", () => {
  const precise = proposeMatch(
    input([signals({ distanceMetres: 210, positionAccuracyMetres: 5 })]),
  );
  const imprecise = proposeMatch(
    input([signals({ distanceMetres: 210, positionAccuracyMetres: 300 })]),
  );

  assert.equal(precise.decision, "new_issue");
  assert.equal(imprecise.decision, "existing_issue");
});
