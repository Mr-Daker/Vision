import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ALERT_LABELS,
  clockSummary,
  dayLabel,
  isOverridden,
  QUEUE_EXPLANATIONS,
  QUEUE_LABELS,
  toSupervisorQueueView,
  type SupervisorIssueRow,
} from "./supervisor-view.ts";

const payload = (overrides: Record<string, unknown> = {}) => ({
  jurisdiction_id: "11111111-1111-4111-8111-111111111111",
  as_of: "2026-09-16T09:00:00.000Z",
  policy_version: "demo-ageing.v1",
  policy_note: "Elapsed time. This is NOT a severity, risk or urgency assessment.",
  delivery_note: "These alerts are internal records in this demonstration.",
  counts: { unacknowledged: 1, overdue: 2, escalated: 0, disputed: 0, reopened: 0 },
  applied_limit: 100,
  exhaustive: true,
  issues: [
    {
      issue_id: "22222222-2222-4222-8222-222222222222",
      public_reference: "VIS-V036-WAIT",
      category: "sanitation",
      current_status: "work_planned",
      department_id: "demo-sanitation",
      assigned_staff_id: null,
      opened_at: "2026-08-01T00:00:00.000Z",
      department_since: "2026-08-03T00:00:00.000Z",
      queues: ["overdue"],
      department_age_days: 12.5,
      citizen_age_days: 46.2,
      paused_days: 0,
      alert_after_days: 7,
      escalate_after_days: 14,
      rule_source: "category",
      reasons: ["policy 'demo-ageing.v1' gives category 'sanitation' 7 days"],
      alerts: [
        {
          alert_id: "33333333-3333-4333-8333-333333333333",
          rule_id: "overdue",
          raised_at: "2026-08-10T00:00:00.000Z",
          acknowledged_at: null,
        },
      ],
      override: null,
    },
  ],
  ...overrides,
});

const row = (overrides: Partial<SupervisorIssueRow> = {}): SupervisorIssueRow => ({
  issueId: "i",
  publicReference: "VIS-X",
  category: "sanitation",
  currentStatus: "work_planned",
  openedAt: "2026-08-01T00:00:00.000Z",
  queues: [],
  reasons: [],
  alerts: [],
  ...overrides,
});

test("V036: a well-formed queue payload parses with both clocks", () => {
  const view = toSupervisorQueueView(payload());
  assert.equal(view?.issues.length, 1);
  assert.equal(view?.issues[0]?.departmentAgeDays, 12.5);
  assert.equal(view?.issues[0]?.citizenAgeDays, 46.2);
  assert.equal(view?.counts.overdue, 2);
});

test("V036: an unknown queue name fails the whole payload closed", () => {
  // Invalid private data becomes nothing, never a row in a queue the server
  // did not put it in.
  const view = toSupervisorQueueView(
    payload({
      issues: [{ ...payload().issues[0], queues: ["critical"] }],
    }),
  );
  assert.equal(view, undefined);
});

test("V036: no queue label or explanation claims a severity", () => {
  // The roadmap's "critical" queue is rendered as an elapsed-time statement,
  // because this system has no severity model and none has been calibrated.
  const text = [...Object.values(QUEUE_LABELS), ...Object.values(QUEUE_EXPLANATIONS)].join(" ");
  for (const word of ["critical", "urgent", "severity", "priority", "risk"]) {
    assert.doesNotMatch(
      text.replace(/nothing here measures danger[^.]*\./gi, ""),
      new RegExp(`\\b${word}\\b`, "i"),
      `a supervisor label asserts '${word}'`,
    );
  }
});

test("V036: no alert label says anything was sent", () => {
  const text = Object.values(ALERT_LABELS).join(" ");
  for (const word of ["sent", "notified", "delivered", "emailed", "alerted"]) {
    assert.doesNotMatch(
      text,
      new RegExp(`\\b${word}\\b`, "i"),
      `an alert label implies delivery: ${text}`,
    );
  }
  assert.match(ALERT_LABELS["overdue"] ?? "", /wait passed/i);
});

test("V036: the escalated queue is named for time, not for danger", () => {
  assert.equal(QUEUE_LABELS["escalated"], "Past the escalation wait");
  assert.match(QUEUE_EXPLANATIONS["escalated"], /statement about time/i);
});

test("V036: a longer citizen wait is always stated alongside the department's", () => {
  // A re-route restarts the department clock. If the summary showed only that
  // number, the screen would quietly shorten how long somebody has waited.
  const summary = clockSummary(row({ departmentAgeDays: 2, citizenAgeDays: 40 }));
  assert.match(summary, /2\.0 days with this department/);
  assert.match(summary, /40\.0 days since it was first reported/);
});

test("V036: paused time is named rather than silently subtracted", () => {
  const summary = clockSummary(row({ departmentAgeDays: 3, citizenAgeDays: 3, pausedDays: 5 }));
  assert.match(summary, /5\.0 days paused awaiting people who reported it/);
});

test("V036: an unrouted issue says so instead of showing a zero", () => {
  assert.match(clockSummary(row({})), /not been routed to a department/i);
});

test("V036: day labels carry one decimal and no score", () => {
  assert.equal(dayLabel(7), "7.0 days");
  assert.equal(dayLabel(undefined), "—");
  assert.doesNotMatch(dayLabel(7), /%/);
});

test("V036: an overridden threshold is identifiable as a human decision", () => {
  assert.equal(isOverridden(row({ ruleSource: "override" })), true);
  assert.equal(isOverridden(row({ ruleSource: "category" })), false);
});
