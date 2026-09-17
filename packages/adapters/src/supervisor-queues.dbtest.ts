/**
 * Supervisor queues and ageing alerts against a real database (roadmap V036).
 *
 * Run with: npm run db:up && npm run db:migrate && npm run test:db
 *
 * The two acceptance clauses this file exists to hold:
 *
 *   * an alert fires **once per intended rule window**, including when two
 *     sweeps run concurrently;
 *   * the **age survives reassignment** — moving an issue between staff must
 *     not restart the clock a department is measured by.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

import type { AgeingPolicyPack, Principal } from "@vision/domain";

import {
  acknowledgeAlert,
  listSupervisorQueues,
  pauseIntervalsFrom,
  recordAgeingOverride,
  SupervisorError,
  sweepAgeingAlerts,
} from "./supervisor-queues.ts";

const DATABASE_URL =
  process.env["DATABASE_URL"] ??
  "postgresql://vision:vision_local_dev_only@127.0.0.1:5432/vision_dev";

const DAY = 86_400_000;
const FAST = "v036-fast";
const SLOW = "v036-slow";

const POLICY: AgeingPolicyPack = {
  version: "v036-test.v1",
  note: "Elapsed time against a configured promise. This is NOT a severity, risk or urgency assessment.",
  rules: {
    [FAST]: { alertAfterDays: 3, escalateAfterDays: 7 },
    [SLOW]: { alertAfterDays: 30, escalateAfterDays: 60 },
  },
  fallback: { alertAfterDays: 21, escalateAfterDays: 42 },
};

let client: pg.Client;
let jurisdictionId: string;
let otherJurisdictionId: string;
let responsibilityId: string;
const issues: string[] = [];
const participants: string[] = [];

const supervisor = (scope?: readonly string[]): Principal => ({
  role: "supervisor",
  staffId: randomUUID() as never,
  jurisdictionScope: scope ?? [jurisdictionId],
  sessionId: randomUUID() as never,
});

before(async () => {
  client = new pg.Client({ connectionString: DATABASE_URL, statement_timeout: 20_000 });
  await client.connect();
  jurisdictionId = randomUUID();
  otherJurisdictionId = randomUUID();
  await client.query(
    `insert into jurisdiction
       (jurisdiction_id, jurisdiction_profile_id, internal_code, directory_version,
        level_scheme, level_code, effective_from, synthetic_provenance)
     values ($1,'v036-profile',$2,'v036-directory.v1','v036-scheme','block',
             now() - interval '1 year', true),
            ($3,'v036-profile',$4,'v036-directory.v1','v036-scheme','block',
             now() - interval '1 year', true)`,
    [
      jurisdictionId,
      `V36-${jurisdictionId.slice(0, 8)}`,
      otherJurisdictionId,
      `V36X-${otherJurisdictionId.slice(0, 8)}`,
    ],
  );
  responsibilityId = randomUUID();
  await client.query(
    `insert into responsibility_directory
       (responsibility_id, directory_version, jurisdiction_id, category,
        department_id, department_label, provider_mode, effective_from)
     values ($1,'v036-directory.v1',$2,'v036-any','v036-dept','V036 Works (simulated)',
             'simulated', now() - interval '1 year')`,
    [responsibilityId, jurisdictionId],
  );
});

after(async () => {
  await client.end().catch(() => undefined);
  const cleaner = new pg.Client({ connectionString: DATABASE_URL, statement_timeout: 20_000 });
  await cleaner.connect();
  try {
    if (issues.length > 0) {
      await cleaner.query("delete from issue_alert where issue_id = any($1::uuid[])", [issues]);
      await cleaner.query("delete from issue_ageing_override where issue_id = any($1::uuid[])", [
        issues,
      ]);
      await cleaner.query("delete from reopening where issue_id = any($1::uuid[])", [issues]);
      await cleaner.query(
        `delete from resolution_confirmation where claim_id in
           (select claim_id from resolution_claim where issue_id = any($1::uuid[]))`,
        [issues],
      );
      await cleaner.query("delete from resolution_claim where issue_id = any($1::uuid[])", [
        issues,
      ]);
      await cleaner.query("delete from assignment where issue_id = any($1::uuid[])", [issues]);
      await cleaner.query("delete from routing_decision where issue_id = any($1::uuid[])", [
        issues,
      ]);
      await cleaner.query(
        "delete from issue_participation where canonical_issue_id = any($1::uuid[])",
        [issues],
      );
      await cleaner.query("delete from canonical_issue where issue_id = any($1::uuid[])", [issues]);
    }
    if (participants.length > 0) {
      await cleaner.query("delete from participant where participant_id = any($1::uuid[])", [
        participants,
      ]);
    }
    await cleaner.query("delete from responsibility_directory where responsibility_id = $1", [
      responsibilityId,
    ]);
    await cleaner.query("delete from jurisdiction where jurisdiction_id = any($1::uuid[])", [
      [jurisdictionId, otherJurisdictionId],
    ]);
  } finally {
    await cleaner.end();
  }
});

/** An issue routed to a department this many days ago and left there. */
const routedIssue = async (options: {
  readonly category?: string;
  readonly openedDaysAgo?: number;
  readonly routedDaysAgo?: number;
  readonly status?: string;
  readonly jurisdiction?: string;
}): Promise<string> => {
  const issueId = randomUUID();
  const opened = options.openedDaysAgo ?? 30;
  const routed = options.routedDaysAgo ?? 30;
  await client.query(
    `insert into canonical_issue
       (issue_id, public_reference, category, current_status, opened_at,
        representative_location, last_evidence_at, jurisdiction_id)
     values ($1,$2,$3,$4, now() - ($5 || ' days')::interval,
             ST_SetSRID(ST_MakePoint(75.9,17.6),4326)::geography, now(), $6)`,
    [
      issueId,
      `VIS-${issueId.slice(0, 8).toUpperCase()}`,
      options.category ?? FAST,
      options.status ?? "routed_internal",
      String(opened),
      options.jurisdiction ?? jurisdictionId,
    ],
  );
  issues.push(issueId);
  await client.query(
    `insert into routing_decision
       (routing_id, issue_id, directory_version, category, jurisdiction_id,
        responsibility_id, department_id, department_label, recipient_mode,
        outcome, reason, decided_at)
     values ($1,$2,'v036-directory.v1',$3,$4,$5,'v036-dept','V036 Works (simulated)',
             'simulated','routed','v036 test route', now() - ($6 || ' days')::interval)`,
    [
      randomUUID(),
      issueId,
      options.category ?? FAST,
      options.jurisdiction ?? jurisdictionId,
      responsibilityId,
      String(routed),
    ],
  );
  return issueId;
};

const alertsFor = async (issueId: string): Promise<readonly string[]> => {
  const { rows } = await client.query(
    "select rule_id from issue_alert where issue_id = $1 order by rule_id",
    [issueId],
  );
  return rows.map((row) => String(row["rule_id"]));
};

// ---------------------------------------------------------------------------
// Once per window
// ---------------------------------------------------------------------------

test("V036: a sweep raises each rule once, however many times it runs", async () => {
  const issueId = await routedIssue({ routedDaysAgo: 30 });
  const asOf = new Date();

  const first = await sweepAgeingAlerts(client, { jurisdictionId, policy: POLICY, asOf });
  assert.ok(first.raised >= 2, "both thresholds are long past");
  assert.deepEqual(await alertsFor(issueId), ["escalated", "overdue"]);

  const second = await sweepAgeingAlerts(client, { jurisdictionId, policy: POLICY, asOf });
  assert.equal(second.raised, 0, "a repeated sweep raises nothing new");
  assert.ok(second.alreadyRaised >= 2);
  assert.deepEqual(await alertsFor(issueId), ["escalated", "overdue"]);

  // And again with the clock moved on: still the same window.
  await sweepAgeingAlerts(client, {
    jurisdictionId,
    policy: POLICY,
    asOf: new Date(asOf.getTime() + 10 * DAY),
  });
  assert.deepEqual(await alertsFor(issueId), ["escalated", "overdue"]);
});

test("V036: concurrent sweeps cannot both raise the same alert", async () => {
  const issueId = await routedIssue({ routedDaysAgo: 30 });
  const asOf = new Date();
  // Separate connections, so this is a real race against the constraint rather
  // than two calls serialised by one client.
  const second = new pg.Client({ connectionString: DATABASE_URL, statement_timeout: 20_000 });
  await second.connect();
  try {
    const [left, right] = await Promise.all([
      sweepAgeingAlerts(client, { jurisdictionId, policy: POLICY, asOf }),
      sweepAgeingAlerts(second, { jurisdictionId, policy: POLICY, asOf }),
    ]);
    assert.equal(
      left.raised + right.raised,
      2,
      "exactly two alerts exist between them, whichever won the race",
    );
  } finally {
    await second.end();
  }
  assert.deepEqual(await alertsFor(issueId), ["escalated", "overdue"]);
});

test("V036: an alert fires only once its threshold is actually past", async () => {
  const issueId = await routedIssue({ routedDaysAgo: 1 });
  await sweepAgeingAlerts(client, { jurisdictionId, policy: POLICY, asOf: new Date() });
  assert.deepEqual(await alertsFor(issueId), [], "one day is not past a three-day promise");
});

// ---------------------------------------------------------------------------
// Age survives reassignment
// ---------------------------------------------------------------------------

test("V036: reassigning staff does not restart the department clock", async () => {
  const issueId = await routedIssue({ routedDaysAgo: 10 });
  const asOf = new Date();

  const before = await listSupervisorQueues(client, {
    principal: supervisor(),
    jurisdictionId,
    policy: POLICY,
    asOf,
  });
  const ageBefore = before.issues.find((issue) => issue.issueId === issueId)?.assessment
    ?.departmentAgeDays;
  assert.ok((ageBefore ?? 0) >= 9.9);

  // Two assignments, the second superseding the first — exactly what V034's
  // `assignIssue` writes when work changes hands.
  for (const staffId of [randomUUID(), randomUUID()]) {
    await client.query("update assignment set valid_to = now() where issue_id = $1", [issueId]);
    await client.query(
      `insert into assignment
         (assignment_id, issue_id, department_id, assigned_staff_id, reason, valid_from)
       values ($1,$2,'v036-dept',$3,'reassigned during the test', now())`,
      [randomUUID(), issueId, staffId],
    );
  }

  const afterwards = await listSupervisorQueues(client, {
    principal: supervisor(),
    jurisdictionId,
    policy: POLICY,
    asOf,
  });
  const ageAfter = afterwards.issues.find((issue) => issue.issueId === issueId)?.assessment
    ?.departmentAgeDays;
  assert.equal(ageAfter, ageBefore, "the clock is anchored to routing, not to an assignment");
});

test("V036: re-routing to another department opens a new alert window", async () => {
  const issueId = await routedIssue({ routedDaysAgo: 30 });
  await sweepAgeingAlerts(client, { jurisdictionId, policy: POLICY, asOf: new Date() });
  assert.equal((await alertsFor(issueId)).length, 2);

  // A newly responsible department starts its own clock — and must be able to
  // be alerted about its own delay rather than being silenced by the previous
  // department's alert.
  await client.query(
    `insert into routing_decision
       (routing_id, issue_id, directory_version, category, jurisdiction_id,
        responsibility_id, department_id, department_label, recipient_mode,
        outcome, reason, decided_at)
     values ($1,$2,'v036-directory.v1',$3,$4,$5,'v036-dept','V036 Works (simulated)',
             'simulated','routed','re-routed during the test', now() - interval '10 days')`,
    [randomUUID(), issueId, FAST, jurisdictionId, responsibilityId],
  );

  const swept = await sweepAgeingAlerts(client, {
    jurisdictionId,
    policy: POLICY,
    asOf: new Date(),
  });
  assert.ok(swept.raised >= 2, "the new window raises its own alerts");
  const { rows } = await client.query(
    "select count(distinct window_start)::int as windows from issue_alert where issue_id = $1",
    [issueId],
  );
  assert.equal(Number(rows[0]?.["windows"]), 2, "two windows, each with its own alerts");
});

// ---------------------------------------------------------------------------
// Pauses
// ---------------------------------------------------------------------------

test("V036: a claim awaiting citizens pauses the department clock", () => {
  const t0 = Date.parse("2026-09-01T00:00:00.000Z");
  const intervals = pauseIntervalsFrom({
    claims: [{ claimId: "c1", claimedAtMs: t0 + 2 * DAY }],
    answers: [],
    reopeningsMs: [],
  });
  assert.deepEqual(intervals, [{ fromMs: t0 + 2 * DAY, toMs: undefined }]);
});

test("V036: a dispute ends the pause, because the work came back", () => {
  const t0 = Date.parse("2026-09-01T00:00:00.000Z");
  const intervals = pauseIntervalsFrom({
    claims: [{ claimId: "c1", claimedAtMs: t0 + 2 * DAY }],
    answers: [{ claimId: "c1", decidedAtMs: t0 + 5 * DAY, decision: "disputed" }],
    reopeningsMs: [],
  });
  assert.deepEqual(intervals, [{ fromMs: t0 + 2 * DAY, toMs: t0 + 5 * DAY }]);
});

test("V036: a reopening ends the pause a confirmation started", () => {
  const t0 = Date.parse("2026-09-01T00:00:00.000Z");
  const intervals = pauseIntervalsFrom({
    claims: [{ claimId: "c1", claimedAtMs: t0 + 2 * DAY }],
    answers: [{ claimId: "c1", decidedAtMs: t0 + 4 * DAY, decision: "confirmed" }],
    reopeningsMs: [t0 + 9 * DAY],
  });
  assert.deepEqual(intervals, [{ fromMs: t0 + 2 * DAY, toMs: t0 + 9 * DAY }]);
});

test("V036: a confirmed resolution is never alerted on", async () => {
  const issueId = await routedIssue({ routedDaysAgo: 60, status: "resolution_confirmed" });
  await sweepAgeingAlerts(client, { jurisdictionId, policy: POLICY, asOf: new Date() });
  assert.deepEqual(await alertsFor(issueId), [], "finished work is not a backlog item");
});

// ---------------------------------------------------------------------------
// Queues
// ---------------------------------------------------------------------------

test("V036: each lifecycle state lands in the queue that describes it", async () => {
  const unacknowledged = await routedIssue({ routedDaysAgo: 1, status: "routed_internal" });
  const disputed = await routedIssue({ routedDaysAgo: 1, status: "resolution_disputed" });
  const reopened = await routedIssue({ routedDaysAgo: 1, status: "reopened" });
  const overdue = await routedIssue({ routedDaysAgo: 5, status: "work_planned" });

  const queues = await listSupervisorQueues(client, {
    principal: supervisor(),
    jurisdictionId,
    policy: POLICY,
    asOf: new Date(),
  });
  const queuesOf = (issueId: string): readonly string[] =>
    queues.issues.find((issue) => issue.issueId === issueId)?.queues ?? [];

  assert.deepEqual(queuesOf(unacknowledged), ["unacknowledged"]);
  assert.deepEqual(queuesOf(disputed), ["disputed"]);
  assert.deepEqual(queuesOf(reopened), ["reopened"]);
  assert.deepEqual(queuesOf(overdue), ["overdue"], "5 days is past 3 but not past 7");
});

test("V036: the queue read never raises an alert", async () => {
  const issueId = await routedIssue({ routedDaysAgo: 30 });
  await listSupervisorQueues(client, {
    principal: supervisor(),
    jurisdictionId,
    policy: POLICY,
    asOf: new Date(),
  });
  // Opening a page is not a clock. Alerts come from the sweep.
  assert.deepEqual(await alertsFor(issueId), []);
});

test("V036: a supervisor cannot read another jurisdiction's queue", async () => {
  await assert.rejects(
    listSupervisorQueues(client, {
      principal: supervisor([otherJurisdictionId]),
      jurisdictionId,
      policy: POLICY,
      asOf: new Date(),
    }),
    (error: Error) => error instanceof SupervisorError,
  );
});

test("V036: a department staff member cannot read a supervisor queue", async () => {
  const staff: Principal = {
    role: "department_staff",
    staffId: randomUUID() as never,
    jurisdictionScope: [jurisdictionId],
    sessionId: randomUUID() as never,
  };
  await assert.rejects(
    listSupervisorQueues(client, {
      principal: staff,
      jurisdictionId,
      policy: POLICY,
      asOf: new Date(),
    }),
    (error: Error) => error instanceof SupervisorError && /cannot operate/.test(error.message),
  );
});

test("V036: every queue read says the alerts were not delivered to anyone", async () => {
  const queues = await listSupervisorQueues(client, {
    principal: supervisor(),
    jurisdictionId,
    policy: POLICY,
    asOf: new Date(),
  });
  assert.match(queues.deliveryNote, /internal records/i);
  assert.match(queues.deliveryNote, /delivered or notified to any official/i);
  assert.match(queues.policyNote, /not a severity, risk or urgency/i);
});

// ---------------------------------------------------------------------------
// Reviewed overrides
// ---------------------------------------------------------------------------

test("V036: an override changes the clock and is attributed", async () => {
  const issueId = await routedIssue({ category: SLOW, routedDaysAgo: 5, status: "work_planned" });
  const principal = supervisor();
  const asOf = new Date();

  const before = await listSupervisorQueues(client, {
    principal,
    jurisdictionId,
    policy: POLICY,
    asOf,
  });
  assert.deepEqual(
    before.issues.find((issue) => issue.issueId === issueId)?.queues,
    [],
    "5 days is nowhere near the slow category's 30",
  );

  await recordAgeingOverride(client, {
    principal,
    issueId,
    alertAfterDays: 2,
    escalateAfterDays: 4,
    reason: "The school reopens on Monday and this blocks the only gate.",
  });

  const afterwards = await listSupervisorQueues(client, {
    principal,
    jurisdictionId,
    policy: POLICY,
    asOf,
  });
  const row = afterwards.issues.find((issue) => issue.issueId === issueId);
  assert.deepEqual(row?.queues, ["overdue", "escalated"]);
  assert.equal(row?.assessment?.ruleSource, "override");
  assert.match(row?.override?.reason ?? "", /school reopens/i);
});

test("V036: an override with no reason is refused", async () => {
  const issueId = await routedIssue({ routedDaysAgo: 5 });
  await assert.rejects(
    recordAgeingOverride(client, {
      principal: supervisor(),
      issueId,
      alertAfterDays: 2,
      escalateAfterDays: 4,
      reason: "  ",
    }),
    (error: Error) => error instanceof SupervisorError && /recorded reason/.test(error.message),
  );
  const { rows } = await client.query(
    "select count(*)::int as n from issue_ageing_override where issue_id = $1",
    [issueId],
  );
  assert.equal(Number(rows[0]?.["n"]), 0, "nothing is written for a refused override");
});

test("V036: a second override supersedes the first rather than replacing it", async () => {
  const issueId = await routedIssue({ routedDaysAgo: 5 });
  const principal = supervisor();
  await recordAgeingOverride(client, {
    principal,
    issueId,
    alertAfterDays: 2,
    escalateAfterDays: 4,
    reason: "First decision, with its own reasoning recorded.",
  });
  await recordAgeingOverride(client, {
    principal,
    issueId,
    alertAfterDays: 6,
    escalateAfterDays: 9,
    reason: "Second decision after speaking to the crew on site.",
  });

  const { rows } = await client.query(
    `select alert_after_days, superseded_at from issue_ageing_override
      where issue_id = $1 order by recorded_at asc`,
    [issueId],
  );
  assert.equal(rows.length, 2, "who decided what, and when, survives the second decision");
  assert.notEqual(rows[0]?.["superseded_at"], null);
  assert.equal(rows[1]?.["superseded_at"], null);
  assert.equal(Number(rows[1]?.["alert_after_days"]), 6);
});

test("V036: a department staff member cannot override the clock on their own work", async () => {
  const issueId = await routedIssue({ routedDaysAgo: 5 });
  const staff: Principal = {
    role: "department_staff",
    staffId: randomUUID() as never,
    jurisdictionScope: [jurisdictionId],
    sessionId: randomUUID() as never,
  };
  await assert.rejects(
    recordAgeingOverride(client, {
      principal: staff,
      issueId,
      alertAfterDays: 2,
      escalateAfterDays: 4,
      reason: "Giving my own department a longer deadline.",
    }),
    (error: Error) => error instanceof SupervisorError,
  );
});

// ---------------------------------------------------------------------------
// Acknowledgement
// ---------------------------------------------------------------------------

test("V036: acknowledging an alert marks it seen without deleting it", async () => {
  const issueId = await routedIssue({ routedDaysAgo: 30 });
  const principal = supervisor();
  await sweepAgeingAlerts(client, { jurisdictionId, policy: POLICY, asOf: new Date() });
  const { rows } = await client.query(
    "select alert_id from issue_alert where issue_id = $1 limit 1",
    [issueId],
  );
  const alertId = String(rows[0]?.["alert_id"]);

  const first = await acknowledgeAlert(client, { principal, alertId, jurisdictionId });
  assert.equal(first.acknowledged, true);
  const second = await acknowledgeAlert(client, { principal, alertId, jurisdictionId });
  assert.equal(second.acknowledged, false, "acknowledging twice is not a second event");

  const { rows: after } = await client.query(
    "select acknowledged_at, acknowledged_by from issue_alert where alert_id = $1",
    [alertId],
  );
  assert.notEqual(after[0]?.["acknowledged_at"], null);
  assert.notEqual(after[0]?.["acknowledged_by"], null, "the alert records who saw it");
});
