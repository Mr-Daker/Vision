/**
 * V045 study design and the claims it will not support.
 *
 * The property this file exists to hold: **the absence of participants cannot
 * quietly become a claim.** `comparativeClaimVerdict` refuses at n = 0 and
 * says why, and there is no path through it that permits a comparison the data
 * does not carry.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AUTOMATED_PASS_LIMITS,
  BANNED_COMPARATIVE_PHRASES,
  STUDY_CONDITIONS,
  STUDY_TASKS,
  comparativeClaimVerdict,
  comparativeOverclaims,
  counterbalanceOrder,
  firstArmFor,
  isCounterbalanced,
  type StudyResults,
  type TaskRecord,
} from "./usability-study.ts";

const record = (over: Partial<TaskRecord> = {}): TaskRecord => ({
  participantIndex: 0,
  arm: "prototype",
  task: "reporting",
  conditions: ["keyboard_only"],
  completed: true,
  completionSeconds: 120,
  assistanceEvents: 0,
  errors: 0,
  understandingProbe: "they said the report had been received but not acted on",
  observerNote: "",
  ...over,
});

const results = (over: Partial<StudyResults> = {}): StudyResults => ({
  protocolVersion: "v045-protocol.v1",
  sampleSize: 0,
  records: [],
  conditionsRun: [],
  consentRecorded: false,
  noRealComplaintsFiled: true,
  ...over,
});

const complete = (): StudyResults =>
  results({
    sampleSize: 6,
    records: [0, 1, 2, 3, 4, 5].flatMap((index) =>
      (["prototype", "existing_flow"] as const).map((arm) =>
        record({ participantIndex: index, arm }),
      ),
    ),
    conditionsRun: [...STUDY_CONDITIONS],
    consentRecorded: true,
    noRealComplaintsFiled: true,
  });

// ---------------------------------------------------------------------------
// No sample, no claim
// ---------------------------------------------------------------------------

test("with no participants, no comparative claim is permitted", () => {
  const verdict = comparativeClaimVerdict(results());
  assert.equal(verdict.permitted, false);
  if (!verdict.permitted) {
    assert.match(
      verdict.reasons.join(" "),
      /no participant session has been run/,
      "the refusal has to say what is missing, or it reads as a wall",
    );
  }
});

test("a handful of participants is still not enough to report a difference", () => {
  const verdict = comparativeClaimVerdict({ ...complete(), sampleSize: 3 });
  assert.equal(verdict.permitted, false);
  if (!verdict.permitted) assert.match(verdict.reasons.join(" "), /below the five/);
});

test("one arm is not a comparison", () => {
  const single = complete();
  const verdict = comparativeClaimVerdict({
    ...single,
    records: single.records.filter((item) => item.arm === "prototype"),
  });
  assert.equal(verdict.permitted, false);
  if (!verdict.permitted) assert.match(verdict.reasons.join(" "), /only one arm was run/);
});

test("a missing required condition blocks the claim, naming it", () => {
  const verdict = comparativeClaimVerdict({
    ...complete(),
    conditionsRun: STUDY_CONDITIONS.filter((condition) => condition !== "language_mr_IN"),
  });
  assert.equal(verdict.permitted, false);
  if (!verdict.permitted) assert.match(verdict.reasons.join(" "), /language_mr_IN/);
});

test("filing real complaints in the existing flow invalidates the study", () => {
  const verdict = comparativeClaimVerdict({ ...complete(), noRealComplaintsFiled: false });
  assert.equal(verdict.permitted, false);
  if (!verdict.permitted) {
    assert.match(
      verdict.reasons.join(" "),
      /must not put invented reports in front of a real authority/,
    );
  }
});

test("unrecorded consent blocks the claim", () => {
  const verdict = comparativeClaimVerdict({ ...complete(), consentRecorded: false });
  assert.equal(verdict.permitted, false);
});

test("a complete, counterbalanced, consented study does permit the claim", () => {
  // The refusal is a gate, not a wall: it opens when the evidence exists.
  assert.equal(comparativeClaimVerdict(complete()).permitted, true);
});

test("every refusal lists everything missing, so a fix is one pass", () => {
  const verdict = comparativeClaimVerdict(results());
  assert.equal(verdict.permitted, false);
  if (!verdict.permitted) assert.ok(verdict.reasons.length >= 4);
});

// ---------------------------------------------------------------------------
// Counterbalancing
// ---------------------------------------------------------------------------

test("participants alternate which arm they meet first", () => {
  assert.equal(firstArmFor(0), "prototype");
  assert.equal(firstArmFor(1), "existing_flow");
  assert.deepEqual(counterbalanceOrder(1), ["existing_flow", "prototype"]);
});

test("an unbalanced set of orders is detected", () => {
  assert.equal(isCounterbalanced([]), false);
  assert.equal(
    isCounterbalanced([
      ["prototype", "existing_flow"],
      ["prototype", "existing_flow"],
      ["prototype", "existing_flow"],
    ]),
    false,
    "everybody meeting the prototype first measures practice in favour of the other arm",
  );
  assert.equal(
    isCounterbalanced([
      ["prototype", "existing_flow"],
      ["existing_flow", "prototype"],
    ]),
    true,
  );
});

// ---------------------------------------------------------------------------
// The design covers what V045 names
// ---------------------------------------------------------------------------

test("the design names all three flows and all six conditions", () => {
  assert.deepEqual([...STUDY_TASKS].sort(), [
    "duplicate_confirmation",
    "report_tracking",
    "reporting",
  ]);
  for (const required of [
    "keyboard_only",
    "screen_reader",
    "text_zoom_200",
    "language_en_IN",
    "language_mr_IN",
    "constrained_mobile_network",
  ] as const) {
    assert.ok(STUDY_CONDITIONS.includes(required), `${required} is required by V045`);
  }
});

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

test("comparative phrasing is detectable in anything published", () => {
  assert.ok(BANNED_COMPARATIVE_PHRASES.length >= 8);
  assert.equal(comparativeOverclaims("this is easier than the existing portal").length, 1);
  assert.equal(comparativeOverclaims("participants preferred the prototype").length, 1);
  assert.equal(comparativeOverclaims("40% quicker").length, 1);
  assert.deepEqual(comparativeOverclaims("six participants completed the task"), []);
});

test("an automated pass says what it cannot establish", () => {
  const limits = AUTOMATED_PASS_LIMITS.join(" ");
  assert.match(limits, /does not establish that anybody could complete the task/);
  assert.match(limits, /whether a sentence was understood/);
  assert.match(limits, /not that somebody who uses a screen reader daily attempted the task/);
  assert.match(limits, /supports a comparison with any other flow/i);
});

// ---------------------------------------------------------------------------
// The published documents
// ---------------------------------------------------------------------------

test("the published results make no comparative claim", async () => {
  // The results document is where a comparison would most plausibly creep in,
  // and it is the one nobody re-reads before quoting.
  const { readFileSync } = await import("node:fs");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");

  for (const file of [
    "deliverables/V045-usability-results.md",
    "docs/foundation/V045-usability-study-protocol.md",
  ]) {
    const text = readFileSync(join(root, file), "utf8");
    assert.deepEqual(comparativeOverclaims(text), [], `${file} compares two flows`);
  }
});

test("the published results state the sample size before anything else", async () => {
  const { readFileSync } = await import("node:fs");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
  const text = readFileSync(join(root, "deliverables/V045-usability-results.md"), "utf8");

  const sampleAt = text.indexOf("## Sample size");
  assert.ok(sampleAt >= 0, "the results must state a sample size");
  assert.ok(
    sampleAt < text.indexOf("## Conditions exercised"),
    "a reader must meet the sample size before any observation",
  );
  assert.match(text, /\*\*Zero\.\*\*/, "n = 0 is stated plainly, not implied");
});
