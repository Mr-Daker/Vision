/**
 * A resident's report roadmap and escalation track (report roadmap design,
 * 2026-09-30).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { evaluateAgeing, type AgeingPolicyPack } from "./ageing-policy.ts";
import {
  ROADMAP_STEPS,
  buildEscalation,
  buildRoadmap,
  type RoadmapInput,
} from "./report-roadmap.ts";

const RECEIVED = "2026-09-29T04:15:59.000Z";
const CHECKED = "2026-09-29T04:16:30.000Z";
const OPENED = "2026-09-29T04:16:40.000Z";

const statesOf = (input: RoadmapInput): string =>
  buildRoadmap(input)
    .steps.map((step) => `${step.id}:${step.state}`)
    .join(" ");

const withIssue = (
  status: NonNullable<RoadmapInput["issue"]>["status"],
  events: NonNullable<RoadmapInput["issue"]>["lastEventAt"] = {},
): RoadmapInput => ({
  receivedAt: RECEIVED,
  checkedAt: CHECKED,
  awaitingAnswer: false,
  issue: { status, groupedAt: OPENED, lastEventAt: events },
});

test("the roadmap is the eight steps a report goes through, in order", () => {
  assert.deepEqual(
    [...ROADMAP_STEPS],
    [
      "received",
      "checked",
      "grouped",
      "routed",
      "acknowledged",
      "work_planned",
      "repair_claimed",
      "confirmed",
    ],
  );
});

test("before the worker has run, the report is being checked", () => {
  const input: RoadmapInput = {
    receivedAt: RECEIVED,
    checkedAt: undefined,
    awaitingAnswer: false,
    issue: undefined,
  };
  const roadmap = buildRoadmap(input);
  assert.equal(roadmap.note, "being_checked");
  assert.equal(roadmap.steps[0]?.at, RECEIVED);
  assert.match(statesOf(input), /^received:done checked:current grouped:upcoming/);
});

test("checked but not yet grouped: grouping is current, or the resident's answer is", () => {
  const base: RoadmapInput = {
    receivedAt: RECEIVED,
    checkedAt: CHECKED,
    awaitingAnswer: false,
    issue: undefined,
  };
  assert.equal(buildRoadmap(base).note, "being_grouped");
  assert.match(statesOf(base), /checked:done grouped:current routed:upcoming/);
  assert.equal(buildRoadmap({ ...base, awaitingAnswer: true }).note, "your_answer_needed");
});

test("an issue waiting for a person to choose the department says so", () => {
  const roadmap = buildRoadmap(withIssue("routing_review"));
  assert.equal(roadmap.note, "choosing_department");
  assert.equal(roadmap.steps[2]?.state, "done");
  assert.equal(roadmap.steps[2]?.at, OPENED);
  assert.equal(roadmap.steps[3]?.state, "current");
});

test("once routed, the department's acknowledgment is what comes next", () => {
  const routedAt = "2026-09-29T05:00:00.000Z";
  const roadmap = buildRoadmap(withIssue("routed_internal", { routed_internal: routedAt }));
  assert.equal(roadmap.note, "with_department");
  assert.equal(roadmap.steps[3]?.state, "done");
  assert.equal(roadmap.steps[3]?.at, routedAt);
  assert.equal(roadmap.steps[4]?.state, "current");
});

test("a claimed repair hands the next move to the resident", () => {
  const roadmap = buildRoadmap(
    withIssue("resolution_claimed", {
      routed_internal: "2026-09-29T05:00:00.000Z",
      agency_ack_received: "2026-09-30T05:00:00.000Z",
      work_planned: "2026-10-01T05:00:00.000Z",
      resolution_claimed: "2026-10-02T05:00:00.000Z",
    }),
  );
  assert.equal(roadmap.note, "your_confirmation_needed");
  assert.equal(roadmap.steps[6]?.at, "2026-10-02T05:00:00.000Z");
  assert.equal(roadmap.steps[7]?.state, "current");
});

test("a confirmed repair completes every step and leaves nothing current", () => {
  const input = withIssue("resolution_confirmed", {
    resolution_confirmed: "2026-10-03T05:00:00.000Z",
  });
  const roadmap = buildRoadmap(input);
  assert.equal(roadmap.note, "fixed");
  assert.ok(roadmap.steps.every((step) => step.state === "done"));
  assert.equal(roadmap.steps[7]?.at, "2026-10-03T05:00:00.000Z");
});

test("a disputed repair and a reopened issue each explain themselves", () => {
  assert.equal(buildRoadmap(withIssue("resolution_disputed")).note, "repair_disputed");
  const reopened = buildRoadmap(withIssue("reopened"));
  assert.equal(reopened.note, "reopened");
  assert.equal(reopened.steps[4]?.state, "current", "back with the department");
  assert.equal(reopened.steps[7]?.state, "upcoming");
});

test("a returned dispute counts as the work being planned again", () => {
  const roadmap = buildRoadmap(
    withIssue("work_planned", { disputed_work_returned: "2026-10-04T05:00:00.000Z" }),
  );
  assert.equal(roadmap.steps[5]?.at, "2026-10-04T05:00:00.000Z");
});

// ---------------------------------------------------------------------------
// Escalation
// ---------------------------------------------------------------------------

const POLICY: AgeingPolicyPack = {
  version: "test-ageing.v1",
  note: "An alert means a configured promise about time has passed, and nothing more.",
  rules: { sanitation: { alertAfterDays: 7, escalateAfterDays: 14 } },
  fallback: { alertAfterDays: 21, escalateAfterDays: 42 },
};

const DAY = 86_400_000;
const SINCE = Date.parse("2026-09-29T05:00:00.000Z");

test("the escalation track gives the day count and the two dates", () => {
  const asOfMs = SINCE + 2 * DAY;
  const assessment = evaluateAgeing({
    category: "sanitation",
    policy: POLICY,
    departmentAnchorMs: SINCE,
    openedAtMs: SINCE,
    pausedIntervals: [],
    asOfMs,
  });
  const track = buildEscalation({
    assessment,
    departmentSinceMs: SINCE,
    pausedNow: false,
    alerts: [],
  });
  assert.equal(track.departmentDays, 2);
  assert.equal(track.alertAfterDays, 7);
  assert.equal(track.escalateAfterDays, 14);
  assert.equal(track.flagDueAt, "2026-10-06T05:00:00.000Z");
  assert.equal(track.escalateDueAt, "2026-10-13T05:00:00.000Z");
  assert.equal(track.flaggedAt, undefined);
  assert.equal(track.ruleSource, "category");
});

test("time the department was not being waited on moves both dates later", () => {
  const asOfMs = SINCE + 5 * DAY;
  const assessment = evaluateAgeing({
    category: "sanitation",
    policy: POLICY,
    departmentAnchorMs: SINCE,
    openedAtMs: SINCE,
    pausedIntervals: [{ fromMs: SINCE + DAY, toMs: SINCE + 3 * DAY }],
    asOfMs,
  });
  const track = buildEscalation({
    assessment,
    departmentSinceMs: SINCE,
    pausedNow: false,
    alerts: [],
  });
  assert.equal(track.departmentDays, 3);
  assert.equal(track.flagDueAt, "2026-10-08T05:00:00.000Z");
  assert.equal(track.escalateDueAt, "2026-10-15T05:00:00.000Z");
});

test("an alert already recorded is reported with the moment it was recorded", () => {
  const asOfMs = SINCE + 9 * DAY;
  const assessment = evaluateAgeing({
    category: "sanitation",
    policy: POLICY,
    departmentAnchorMs: SINCE,
    openedAtMs: SINCE,
    pausedIntervals: [],
    asOfMs,
  });
  const track = buildEscalation({
    assessment,
    departmentSinceMs: SINCE,
    pausedNow: true,
    alerts: [{ ruleId: "overdue", raisedAt: "2026-10-06T06:00:00.000Z" }],
  });
  assert.equal(track.flaggedAt, "2026-10-06T06:00:00.000Z");
  assert.equal(track.escalatedAt, undefined);
  assert.equal(track.paused, true);
});
