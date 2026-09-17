/**
 * V043 recorded outcomes and attribution.
 *
 * The acceptance clause this file holds: **a reviewer can distinguish recorded
 * outcomes during a project from proof that spending caused those outcomes.**
 * Every rendering says so, events outside the window are shown rather than
 * hidden, an open-ended project claims nothing, and no string this module can
 * produce survives the overclaim check.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ASSUMPTION_SUPPORT_LABELS,
  BANNED_ATTRIBUTION_PHRASES,
  assumptionsAreCandid,
  attributionOverclaims,
  outcomeStatement,
  placeOutcome,
  placeOutcomes,
  type Assumption,
  type ProjectWindow,
  type RecordedOutcome,
} from "./outcome-attribution.ts";

const DAY = 86_400_000;
const SANCTIONED = Date.UTC(2025, 3, 1);
const COMPLETED = Date.UTC(2025, 10, 1);

const window = (over: Partial<ProjectWindow> = {}): ProjectWindow => ({
  projectId: "PRJ-1",
  projectName: "Block 1 water works (synthetic)",
  sanctionedAtMs: SANCTIONED,
  completedAtMs: COMPLETED,
  ...over,
});

const outcome = (over: Partial<RecordedOutcome> = {}): RecordedOutcome => ({
  eventType: "resolution_confirmed",
  occurredAtMs: SANCTIONED + 30 * DAY,
  description: "participants agreed the problem looked fixed",
  ...over,
});

// ---------------------------------------------------------------------------
// Placing an event
// ---------------------------------------------------------------------------

test("an event inside the project's dates is during, and says it proves nothing", () => {
  const placed = placeOutcomes([outcome()], window());
  assert.equal(placed[0]?.relation, "during");
  assert.match(placed[0]?.explanation ?? "", /coincidence in time/);
  assert.match(placed[0]?.explanation ?? "", /compares it with what would have happened otherwise/);
});

test("an event before the sanction rules the project out of the explanation", () => {
  const placed = placeOutcomes([outcome({ occurredAtMs: SANCTIONED - DAY })], window());
  assert.equal(placed[0]?.relation, "before");
  assert.match(placed[0]?.explanation ?? "", /cannot be part of the explanation/);
});

test("an event after completion is neither claimed nor dismissed", () => {
  const placed = placeOutcomes([outcome({ occurredAtMs: COMPLETED + DAY })], window());
  assert.equal(placed[0]?.relation, "after");
  assert.match(placed[0]?.explanation ?? "", /not something this system can say/);
});

test("an open-ended project claims nothing after its sanction", () => {
  // "Still running, so everything since counts" is the assumption that turns
  // an indefinite project into credit for every improvement in its area.
  const relation = placeOutcome(
    outcome({ occurredAtMs: SANCTIONED + 900 * DAY }),
    window({ completedAtMs: null }),
  );
  assert.equal(relation, "unknown");
});

test("an open-ended project still rules out what happened before it", () => {
  assert.equal(
    placeOutcome(outcome({ occurredAtMs: SANCTIONED - DAY }), window({ completedAtMs: null })),
    "before",
  );
});

test("an event with no recorded time is not assumed to fall inside", () => {
  assert.equal(placeOutcome(outcome({ occurredAtMs: null }), window()), "unknown");
});

test("the boundaries are inclusive at both ends, and stated once", () => {
  assert.equal(placeOutcome(outcome({ occurredAtMs: SANCTIONED }), window()), "during");
  assert.equal(placeOutcome(outcome({ occurredAtMs: COMPLETED }), window()), "during");
  assert.equal(placeOutcome(outcome({ occurredAtMs: COMPLETED + 1 }), window()), "after");
});

// ---------------------------------------------------------------------------
// The statement
// ---------------------------------------------------------------------------

test("the statement counts what fell outside the window, not only what fell inside", () => {
  // Showing only the overlap is how an overlap starts to look like a mechanism.
  const placed = placeOutcomes(
    [
      outcome({ occurredAtMs: SANCTIONED + 10 * DAY }),
      outcome({ occurredAtMs: SANCTIONED - 10 * DAY }),
      outcome({ occurredAtMs: COMPLETED + 10 * DAY }),
      outcome({ occurredAtMs: null }),
    ],
    window(),
  );
  const statement = outcomeStatement(placed, window());
  assert.match(statement, /1 recorded event\(s\) fall inside/);
  assert.match(statement, /2 fall outside them/);
  assert.match(statement, /1 cannot be placed/);
});

test("the statement always says what a coincidence in time is not", () => {
  const statement = outcomeStatement(placeOutcomes([outcome()], window()), window());
  assert.match(statement, /no comparison with what would have happened without the spending/);
  assert.match(statement, /no measurement of the work itself/);
  assert.match(statement, /nothing that could show the money caused any of this/);
});

test("no recorded outcomes is not evidence either way", () => {
  const statement = outcomeStatement([], window());
  assert.match(statement, /not evidence either way about the project/);
  assert.doesNotMatch(statement, /\b0 recorded event/);
});

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

test("nothing this module produces asserts a cause", () => {
  const placed = placeOutcomes(
    [
      outcome({ occurredAtMs: SANCTIONED + DAY }),
      outcome({ occurredAtMs: SANCTIONED - DAY }),
      outcome({ occurredAtMs: COMPLETED + DAY }),
      outcome({ occurredAtMs: null }),
    ],
    window(),
  );
  const everything = [
    outcomeStatement(placed, window()),
    outcomeStatement([], window()),
    ...placed.map((item) => `${item.description} ${item.explanation}`),
    ...Object.values(ASSUMPTION_SUPPORT_LABELS),
  ].join(" \n ");
  assert.deepEqual(attributionOverclaims(everything), []);
});

test("the overclaim check is live, not decorative", () => {
  assert.ok(BANNED_ATTRIBUTION_PHRASES.length >= 8);
  assert.equal(attributionOverclaims("the repair happened thanks to the project").length, 1);
  assert.equal(attributionOverclaims("the project fixed the handpump").length, 1);
  assert.equal(attributionOverclaims("this shows the impact of the investment").length, 1);
  assert.equal(attributionOverclaims("money well spent").length, 1);
});

// ---------------------------------------------------------------------------
// Assumptions
// ---------------------------------------------------------------------------

const assumption = (over: Partial<Assumption> = {}): Assumption => ({
  id: "equity-inversion",
  statement: "Few reports per head is treated as a reason to rank higher.",
  support: "asserted",
  detail: "Nothing measured shows that low reporting means high need.",
  ...over,
});

test("each kind of support has words a reviewer can argue with", () => {
  assert.match(ASSUMPTION_SUPPORT_LABELS.asserted, /no evidence behind the choice/);
  assert.match(ASSUMPTION_SUPPORT_LABELS.absent, /No source exists/);
  assert.match(ASSUMPTION_SUPPORT_LABELS.evidenced, /loaded source/);
});

test("an ordering claiming every assumption is evidenced is the one to distrust", () => {
  assert.equal(assumptionsAreCandid([assumption()]), true);
  assert.equal(assumptionsAreCandid([assumption({ support: "absent" })]), true);
  assert.equal(
    assumptionsAreCandid([assumption({ support: "evidenced" })]),
    false,
    "some of these are configuration choices, and saying otherwise is the overclaim",
  );
});
