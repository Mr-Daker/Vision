/** Deterministic ageing and escalation (roadmap V036). */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AgeingPolicyError,
  evaluateAgeing,
  pausedMillisWithin,
  type AgeingPolicyPack,
} from "./ageing-policy.ts";

const DAY = 86_400_000;
const T0 = Date.parse("2026-09-01T00:00:00.000Z");

const POLICY: AgeingPolicyPack = {
  version: "test-ageing.v1",
  note: "Elapsed time against a configured promise. This is NOT a severity, risk or urgency assessment.",
  rules: {
    "fast-cat": { alertAfterDays: 3, escalateAfterDays: 7 },
    "slow-cat": { alertAfterDays: 10, escalateAfterDays: 20 },
  },
  fallback: { alertAfterDays: 21, escalateAfterDays: 42 },
};

const base = {
  category: "fast-cat",
  policy: POLICY,
  departmentAnchorMs: T0,
  openedAtMs: T0,
  pausedIntervals: [],
};

test("V036: nothing has aged at the moment of assessment", () => {
  const assessment = evaluateAgeing({ ...base, asOfMs: T0 });
  assert.equal(assessment.departmentAgeDays, 0);
  assert.deepEqual(assessment.crossed, []);
});

test("V036: a rule fires only once its own threshold is reached", () => {
  // Deliberately checked either side of the boundary rather than just past it:
  // an off-by-one here would alert a department a day early, every time.
  const justBefore = evaluateAgeing({ ...base, asOfMs: T0 + 3 * DAY - 1 });
  assert.deepEqual(justBefore.crossed, []);

  const exactly = evaluateAgeing({ ...base, asOfMs: T0 + 3 * DAY });
  assert.deepEqual(exactly.crossed, ["overdue"]);

  const later = evaluateAgeing({ ...base, asOfMs: T0 + 7 * DAY });
  assert.deepEqual(later.crossed, ["overdue", "escalated"]);
});

test("V036: the same inputs always give the same answer", () => {
  // No clock is read inside, so this is the property that makes a sweep
  // replayable and a test able to drive time rather than sleep.
  const asOfMs = T0 + 5 * DAY;
  const first = evaluateAgeing({ ...base, asOfMs });
  const second = evaluateAgeing({ ...base, asOfMs });
  assert.deepEqual(first, second);
});

test("V036: an unconfigured category gets the lenient fallback, not a guessed deadline", () => {
  const assessment = evaluateAgeing({
    ...base,
    category: "nobody-configured-this",
    asOfMs: T0 + 10 * DAY,
  });
  // 10 days is past 'fast-cat' and past 'slow-cat', but the fallback is 21 —
  // a configuration gap must not manufacture an alert against a department
  // for a promise nobody made.
  assert.equal(assessment.ruleSource, "fallback");
  assert.deepEqual(assessment.crossed, []);
  assert.match(assessment.reasons[0] ?? "", /configures no rule/i);
});

test("V036: a supervisor override replaces the category rule", () => {
  const assessment = evaluateAgeing({
    ...base,
    category: "slow-cat",
    override: { alertAfterDays: 2, escalateAfterDays: 4 },
    asOfMs: T0 + 5 * DAY,
  });
  assert.equal(assessment.ruleSource, "override");
  assert.deepEqual(assessment.crossed, ["overdue", "escalated"]);
  assert.match(assessment.reasons[0] ?? "", /supervisor recorded an override/i);
});

// ---------------------------------------------------------------------------
// Pauses
// ---------------------------------------------------------------------------

test("V036: paused time does not count against the department", () => {
  // Routed at T0, claimed at day 2, disputed at day 6: four days of that
  // window belong to the people answering, not to the department.
  const assessment = evaluateAgeing({
    ...base,
    pausedIntervals: [{ fromMs: T0 + 2 * DAY, toMs: T0 + 6 * DAY }],
    asOfMs: T0 + 6 * DAY,
  });
  assert.equal(assessment.pausedDays, 4);
  assert.equal(assessment.departmentAgeDays, 2);
  assert.deepEqual(assessment.crossed, [], "two effective days is not past a three-day promise");
});

test("V036: an open pause runs to the assessment moment", () => {
  const assessment = evaluateAgeing({
    ...base,
    pausedIntervals: [{ fromMs: T0 + 1 * DAY, toMs: undefined }],
    asOfMs: T0 + 30 * DAY,
  });
  assert.equal(assessment.departmentAgeDays, 1);
  assert.deepEqual(assessment.crossed, []);
});

test("V036: overlapping pauses are counted once, not summed", () => {
  // Two overlapping pauses are one period of not-waiting. Summing them would
  // credit a department twice and could drive the effective age negative.
  const merged = pausedMillisWithin(
    [
      { fromMs: T0 + 1 * DAY, toMs: T0 + 5 * DAY },
      { fromMs: T0 + 3 * DAY, toMs: T0 + 6 * DAY },
    ],
    T0,
    T0 + 10 * DAY,
  );
  assert.equal(merged / DAY, 5);
});

test("V036: a pause before the department became responsible does not count", () => {
  const clamped = pausedMillisWithin(
    [{ fromMs: T0 - 10 * DAY, toMs: T0 + 2 * DAY }],
    T0,
    T0 + 10 * DAY,
  );
  assert.equal(clamped / DAY, 2, "only the part inside this department's window counts");
});

test("V036: effective age never goes negative", () => {
  const assessment = evaluateAgeing({
    ...base,
    pausedIntervals: [{ fromMs: T0 - 100 * DAY, toMs: T0 + 100 * DAY }],
    asOfMs: T0 + 5 * DAY,
  });
  assert.equal(assessment.departmentAgeDays, 0);
});

// ---------------------------------------------------------------------------
// Two clocks
// ---------------------------------------------------------------------------

test("V036: the citizen clock never pauses and never alerts", () => {
  const assessment = evaluateAgeing({
    ...base,
    openedAtMs: T0 - 30 * DAY,
    pausedIntervals: [{ fromMs: T0, toMs: T0 + 5 * DAY }],
    asOfMs: T0 + 5 * DAY,
  });
  // The department has zero effective days; the person has waited 35.
  assert.equal(assessment.departmentAgeDays, 0);
  assert.equal(assessment.citizenAgeDays, 35);
  assert.deepEqual(assessment.crossed, [], "the citizen clock must not raise an alert");
});

test("V036: a longer citizen wait is stated, so a re-route cannot hide it", () => {
  const assessment = evaluateAgeing({
    ...base,
    openedAtMs: T0 - 40 * DAY,
    asOfMs: T0 + 1 * DAY,
  });
  assert.ok(
    assessment.reasons.some((reason) => /has been waiting 41\.0 days/.test(reason)),
    "the reasons must name the citizen wait when it exceeds the department's",
  );
});

// ---------------------------------------------------------------------------
// The policy has to say what it is not
// ---------------------------------------------------------------------------

test("V036: a policy with no note is refused", () => {
  assert.throws(
    () => evaluateAgeing({ ...base, policy: { ...POLICY, note: "  " }, asOfMs: T0 }),
    (error: Error) =>
      error instanceof AgeingPolicyError &&
      /what an alert does and does not mean/.test(error.message),
  );
});

test("V036: an escalation that fires no later than the alert is refused", () => {
  assert.throws(
    () =>
      evaluateAgeing({
        ...base,
        override: { alertAfterDays: 5, escalateAfterDays: 5 },
        asOfMs: T0,
      }),
    (error: Error) => error instanceof AgeingPolicyError && /escalate later/.test(error.message),
  );
});

test("V036: no assessment carries a score", () => {
  const assessment = evaluateAgeing({ ...base, asOfMs: T0 + 9 * DAY });
  const serialised = JSON.stringify(assessment);
  // The words this system cannot support, asserted against the whole payload
  // rather than trusted to review.
  for (const word of ["severity", "urgency", "priority", "risk", "critical"]) {
    assert.doesNotMatch(
      serialised.replace(/not a severity, risk or urgency assessment/gi, ""),
      new RegExp(`\\b${word}\\b`, "i"),
      `an ageing assessment must not assert '${word}'`,
    );
  }
});
