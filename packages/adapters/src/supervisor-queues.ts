/**
 * Supervisor queues and deterministic ageing alerts (roadmap V036).
 *
 * A supervisor is the first actor in this system whose job is to look at what
 * is *not* happening. Three rules follow from that.
 *
 * **An alert is about a clock, not about a problem.** Every threshold here
 * comes from a configured pack or from a supervisor who wrote down a reason.
 * Nothing computes how serious anything is; `evaluateAgeing` in the domain has
 * no score to give, and this file has none to store.
 *
 * **The clock is honest about who was waiting.** The department clock starts
 * when the department became responsible and pauses whenever the department is
 * not the party being waited on. The citizen clock never pauses and never
 * alerts. Both travel together, so a re-route cannot quietly shorten somebody's
 * wait on the screen.
 *
 * **An alert is a record, not a message.** Nothing here touches the outbox. A
 * row in `issue_alert` means a configured promise passed and this system wrote
 * it down; it does not mean anyone was told. Delivery is V070's to earn.
 *
 * The sweep takes `asOf` rather than reading a clock, so a test advances time
 * explicitly and the same inputs always produce the same alerts.
 */

import { randomUUID } from "node:crypto";

import {
  authorize,
  evaluateAgeing,
  type AgeingAssessment,
  type AgeingPolicyPack,
  type AgeingRule,
  type Principal,
} from "@vision/domain";

import type { Queryable } from "./outbox.ts";

export class SupervisorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupervisorError";
  }
}

export const SUPERVISOR_QUEUE_LIMIT = 100;

/**
 * Statuses in which the department clock does not run.
 *
 * `resolution_claimed` is the substantive one: the department says the work is
 * done and is waiting on people to confirm it. Counting that against them
 * would alert a department for other people's response time.
 *
 * `resolution_disputed` and `reopened` are deliberately **absent**: the work
 * came back, and so does the clock.
 */
const PAUSED_STATUSES: ReadonlySet<string> = new Set([
  "resolution_claimed",
  "resolution_confirmed",
]);

export type SupervisorQueueId =
  "unacknowledged" | "overdue" | "escalated" | "disputed" | "reopened";

export type SupervisorIssue = {
  readonly issueId: string;
  readonly publicReference: string;
  readonly category: string;
  readonly currentStatus: string;
  readonly departmentId: string | undefined;
  readonly assignedStaffId: string | undefined;
  readonly openedAt: string;
  /** When the current department became responsible. The alerting anchor. */
  readonly departmentSince: string | undefined;
  readonly assessment: AgeingAssessment | undefined;
  /** Alerts already on record for this issue's current window. */
  readonly alerts: readonly {
    readonly alertId: string;
    readonly ruleId: string;
    readonly raisedAt: string;
    readonly acknowledgedAt: string | undefined;
  }[];
  readonly override:
    | {
        readonly alertAfterDays: number;
        readonly escalateAfterDays: number;
        readonly reason: string;
        readonly recordedAt: string;
      }
    | undefined;
  readonly queues: readonly SupervisorQueueId[];
};

export type SupervisorQueues = {
  readonly jurisdictionId: string;
  readonly asOf: string;
  readonly policyVersion: string;
  readonly policyNote: string;
  readonly issues: readonly SupervisorIssue[];
  readonly counts: Readonly<Record<SupervisorQueueId, number>>;
  readonly appliedLimit: number;
  readonly exhaustive: boolean;
  /** Said on every read, because an alert here was never sent to anyone. */
  readonly deliveryNote: string;
};

export const INTERNAL_ONLY_NOTE =
  "These alerts are internal records in this demonstration. Nothing here has been delivered or notified to any official, department or external system.";

const requireSupervisor = (
  principal: Principal,
  action: "issue.read_private" | "ageing.override",
  jurisdictionId: string,
): void => {
  if (principal.role !== "supervisor") {
    throw new SupervisorError(`role '${principal.role}' cannot operate a supervisor queue`);
  }
  const decision = authorize(principal, action, { jurisdictionId });
  if (!decision.allowed) {
    throw new SupervisorError(`role '${principal.role}' may not ${action}: ${decision.reason}`);
  }
};

/**
 * Periods in which the department clock did not run, for one issue.
 *
 * Built from the V035 resolution tables rather than by replaying event-type
 * strings: a claim, its answer and any reopening are precise rows with
 * timestamps, whereas reconstructing status from `status_event` would mean
 * mapping event names to statuses and breaking quietly the first time one is
 * renamed.
 */
export const pauseIntervalsFrom = (rows: {
  readonly claims: readonly { readonly claimedAtMs: number; readonly claimId: string }[];
  readonly answers: readonly {
    readonly claimId: string;
    readonly decidedAtMs: number;
    readonly decision: string;
  }[];
  readonly reopeningsMs: readonly number[];
}): readonly { readonly fromMs: number; readonly toMs: number | undefined }[] => {
  const intervals: { fromMs: number; toMs: number | undefined }[] = [];
  for (const claim of rows.claims) {
    const answers = rows.answers
      .filter((answer) => answer.claimId === claim.claimId)
      .sort((left, right) => left.decidedAtMs - right.decidedAtMs);

    // A dispute puts the work back on the department, so the pause ends there.
    const dispute = answers.find((answer) => answer.decision === "disputed");
    if (dispute !== undefined) {
      intervals.push({ fromMs: claim.claimedAtMs, toMs: dispute.decidedAtMs });
      continue;
    }

    // Otherwise the pause runs until the closure is reversed, or stays open.
    const reopenedAfter = rows.reopeningsMs
      .filter((at) => at > claim.claimedAtMs)
      .sort((left, right) => left - right)[0];
    intervals.push({ fromMs: claim.claimedAtMs, toMs: reopenedAfter });
  }
  return intervals;
};

type RawIssue = {
  readonly issueId: string;
  readonly publicReference: string;
  readonly category: string;
  readonly currentStatus: string;
  readonly departmentId: string | undefined;
  readonly assignedStaffId: string | undefined;
  readonly openedAtMs: number;
  readonly departmentSinceMs: number | undefined;
};

const loadIssues = async (
  tx: Queryable,
  jurisdictionId: string,
  limit: number,
): Promise<readonly RawIssue[]> => {
  const { rows } = await tx.query(
    `select i.issue_id, i.public_reference, i.category, i.current_status, i.opened_at,
            r.department_id, r.decided_at as department_since,
            (select a.assigned_staff_id from assignment a
              where a.issue_id = i.issue_id and a.valid_to is null
              order by a.valid_from desc limit 1) as assigned_staff_id
       from canonical_issue i
       left join lateral (
         select department_id, decided_at from routing_decision
          where issue_id = i.issue_id and outcome = 'routed'
          order by decided_at desc limit 1
       ) r on true
      where i.jurisdiction_id = $1
        -- A merged-away issue is not anybody's backlog; its data belongs to
        -- the surviving root, which appears here in its own right.
        and not exists (
          select 1 from issue_alias alias
           where alias.source_issue_id = i.issue_id and alias.valid_to is null
        )
      order by i.opened_at asc
      limit $2`,
    [jurisdictionId, limit + 1],
  );
  return rows.map((row) => ({
    issueId: String(row["issue_id"]),
    publicReference: String(row["public_reference"]),
    category: String(row["category"]),
    currentStatus: String(row["current_status"]),
    departmentId: row["department_id"] === null ? undefined : String(row["department_id"]),
    assignedStaffId:
      row["assigned_staff_id"] === null ? undefined : String(row["assigned_staff_id"]),
    openedAtMs: Date.parse(String(row["opened_at"])),
    departmentSinceMs:
      row["department_since"] === null ? undefined : Date.parse(String(row["department_since"])),
  }));
};

/** Every pause, override and standing alert for a set of issues, in three reads. */
const loadAgeingContext = async (
  tx: Queryable,
  issueIds: readonly string[],
): Promise<{
  readonly pauses: Map<
    string,
    readonly { readonly fromMs: number; readonly toMs: number | undefined }[]
  >;
  readonly overrides: Map<
    string,
    { readonly rule: AgeingRule; readonly reason: string; readonly recordedAt: string }
  >;
  readonly alerts: Map<
    string,
    {
      readonly alertId: string;
      readonly ruleId: string;
      readonly raisedAt: string;
      readonly acknowledgedAt: string | undefined;
      readonly windowStartMs: number;
    }[]
  >;
}> => {
  const empty = {
    pauses: new Map(),
    overrides: new Map(),
    alerts: new Map(),
  };
  if (issueIds.length === 0) return empty;

  const claimRows = await tx.query(
    `select k.issue_id, k.claim_id, k.claimed_at,
            c.decided_at, c.decision
       from resolution_claim k
       left join resolution_confirmation c on c.claim_id = k.claim_id
      where k.issue_id = any($1::uuid[])`,
    [issueIds],
  );
  const reopenRows = await tx.query(
    `select issue_id, reopened_at from reopening where issue_id = any($1::uuid[])`,
    [issueIds],
  );
  const overrideRows = await tx.query(
    `select issue_id, alert_after_days, escalate_after_days, reason, recorded_at
       from issue_ageing_override
      where issue_id = any($1::uuid[]) and superseded_at is null`,
    [issueIds],
  );
  const alertRows = await tx.query(
    `select alert_id, issue_id, rule_id, raised_at, acknowledged_at, window_start
       from issue_alert where issue_id = any($1::uuid[])
      order by raised_at asc`,
    [issueIds],
  );

  const pauses = new Map<string, readonly { fromMs: number; toMs: number | undefined }[]>();
  for (const issueId of issueIds) {
    const mine = claimRows.rows.filter((row) => String(row["issue_id"]) === issueId);
    const claims = [
      ...new Map(
        mine.map((row) => [
          String(row["claim_id"]),
          { claimId: String(row["claim_id"]), claimedAtMs: Date.parse(String(row["claimed_at"])) },
        ]),
      ).values(),
    ];
    const answers = mine
      .filter((row) => row["decided_at"] !== null)
      .map((row) => ({
        claimId: String(row["claim_id"]),
        decidedAtMs: Date.parse(String(row["decided_at"])),
        decision: String(row["decision"]),
      }));
    const reopeningsMs = reopenRows.rows
      .filter((row) => String(row["issue_id"]) === issueId)
      .map((row) => Date.parse(String(row["reopened_at"])));
    pauses.set(issueId, pauseIntervalsFrom({ claims, answers, reopeningsMs }));
  }

  const overrides = new Map<string, { rule: AgeingRule; reason: string; recordedAt: string }>();
  for (const row of overrideRows.rows) {
    overrides.set(String(row["issue_id"]), {
      rule: {
        alertAfterDays: Number(row["alert_after_days"]),
        escalateAfterDays: Number(row["escalate_after_days"]),
      },
      reason: String(row["reason"]),
      recordedAt: new Date(String(row["recorded_at"])).toISOString(),
    });
  }

  const alerts = new Map<
    string,
    {
      alertId: string;
      ruleId: string;
      raisedAt: string;
      acknowledgedAt: string | undefined;
      windowStartMs: number;
    }[]
  >();
  for (const row of alertRows.rows) {
    const issueId = String(row["issue_id"]);
    const list = alerts.get(issueId) ?? [];
    list.push({
      alertId: String(row["alert_id"]),
      ruleId: String(row["rule_id"]),
      raisedAt: new Date(String(row["raised_at"])).toISOString(),
      acknowledgedAt:
        row["acknowledged_at"] === null
          ? undefined
          : new Date(String(row["acknowledged_at"])).toISOString(),
      windowStartMs: Date.parse(String(row["window_start"])),
    });
    alerts.set(issueId, list);
  }

  return { pauses, overrides, alerts };
};

const queuesFor = (
  issue: RawIssue,
  assessment: AgeingAssessment | undefined,
): readonly SupervisorQueueId[] => {
  const queues: SupervisorQueueId[] = [];
  if (issue.currentStatus === "routed_internal") queues.push("unacknowledged");
  if (issue.currentStatus === "resolution_disputed") queues.push("disputed");
  if (issue.currentStatus === "reopened") queues.push("reopened");
  // A confirmed resolution is finished work, not a backlog item; its clock is
  // paused and alerting on it would keep a closed issue on a supervisor's
  // screen forever.
  if (assessment !== undefined && issue.currentStatus !== "resolution_confirmed") {
    if (assessment.crossed.includes("overdue")) queues.push("overdue");
    if (assessment.crossed.includes("escalated")) queues.push("escalated");
  }
  return queues;
};

export type SupervisorQueueOptions = {
  readonly principal: Principal;
  readonly jurisdictionId: string;
  readonly policy: AgeingPolicyPack;
  /** Supplied, never read from a clock here. */
  readonly asOf: Date;
  readonly limit?: number;
};

export const listSupervisorQueues = async (
  tx: Queryable,
  options: SupervisorQueueOptions,
): Promise<SupervisorQueues> => {
  requireSupervisor(options.principal, "issue.read_private", options.jurisdictionId);
  const limit = Math.min(
    Math.max(options.limit ?? SUPERVISOR_QUEUE_LIMIT, 1),
    SUPERVISOR_QUEUE_LIMIT,
  );
  const asOfMs = options.asOf.getTime();

  const raw = await loadIssues(tx, options.jurisdictionId, limit);
  const kept = raw.slice(0, limit);
  const context = await loadAgeingContext(
    tx,
    kept.map((issue) => issue.issueId),
  );

  const issues: SupervisorIssue[] = kept.map((issue) => {
    const override = context.overrides.get(issue.issueId);
    const assessment =
      issue.departmentSinceMs === undefined
        ? undefined
        : evaluateAgeing({
            category: issue.category,
            policy: options.policy,
            departmentAnchorMs: issue.departmentSinceMs,
            openedAtMs: issue.openedAtMs,
            pausedIntervals: context.pauses.get(issue.issueId) ?? [],
            ...(override === undefined ? {} : { override: override.rule }),
            asOfMs,
          });
    // Only alerts belonging to the *current* window are shown: an alert from a
    // previous department's window explains nothing about this one's delay.
    const alerts = (context.alerts.get(issue.issueId) ?? [])
      .filter((alert) => alert.windowStartMs === issue.departmentSinceMs)
      .map((alert) => ({
        alertId: alert.alertId,
        ruleId: alert.ruleId,
        raisedAt: alert.raisedAt,
        acknowledgedAt: alert.acknowledgedAt,
      }));

    return {
      issueId: issue.issueId,
      publicReference: issue.publicReference,
      category: issue.category,
      currentStatus: issue.currentStatus,
      departmentId: issue.departmentId,
      assignedStaffId: issue.assignedStaffId,
      openedAt: new Date(issue.openedAtMs).toISOString(),
      departmentSince:
        issue.departmentSinceMs === undefined
          ? undefined
          : new Date(issue.departmentSinceMs).toISOString(),
      assessment,
      alerts,
      ...(override === undefined
        ? { override: undefined }
        : {
            override: {
              alertAfterDays: override.rule.alertAfterDays,
              escalateAfterDays: override.rule.escalateAfterDays,
              reason: override.reason,
              recordedAt: override.recordedAt,
            },
          }),
      queues: queuesFor(issue, assessment),
    };
  });

  const counts: Record<SupervisorQueueId, number> = {
    unacknowledged: 0,
    overdue: 0,
    escalated: 0,
    disputed: 0,
    reopened: 0,
  };
  for (const issue of issues) {
    for (const queue of issue.queues) counts[queue] += 1;
  }

  return {
    jurisdictionId: options.jurisdictionId,
    asOf: options.asOf.toISOString(),
    policyVersion: options.policy.version,
    policyNote: options.policy.note,
    issues,
    counts,
    appliedLimit: limit,
    exhaustive: raw.length <= limit,
    deliveryNote: INTERNAL_ONLY_NOTE,
  };
};

export type SweepResult = {
  readonly evaluated: number;
  readonly raised: number;
  /** Alerts the rule would have raised that were already on record. */
  readonly alreadyRaised: number;
};

/**
 * One ageing pass.
 *
 * Idempotent by construction: the insert is `ON CONFLICT DO NOTHING` against
 * `issue_alert_once_per_window_uniq`, so running the sweep twice at the same
 * `asOf` — or twice concurrently — raises each alert exactly once. That
 * constraint, not this function, is what makes the V036 acceptance clause true.
 */
export const sweepAgeingAlerts = async (
  tx: Queryable,
  options: {
    readonly jurisdictionId: string;
    readonly policy: AgeingPolicyPack;
    readonly asOf: Date;
    readonly limit?: number;
  },
): Promise<SweepResult> => {
  const limit = Math.min(Math.max(options.limit ?? SUPERVISOR_QUEUE_LIMIT, 1), 1000);
  const asOfMs = options.asOf.getTime();
  const raw = await loadIssues(tx, options.jurisdictionId, limit);
  const kept = raw.slice(0, limit);
  const context = await loadAgeingContext(
    tx,
    kept.map((issue) => issue.issueId),
  );

  let raised = 0;
  let alreadyRaised = 0;
  for (const issue of kept) {
    if (issue.departmentSinceMs === undefined) continue;
    if (issue.currentStatus === "resolution_confirmed") continue;
    const override = context.overrides.get(issue.issueId);
    const assessment = evaluateAgeing({
      category: issue.category,
      policy: options.policy,
      departmentAnchorMs: issue.departmentSinceMs,
      openedAtMs: issue.openedAtMs,
      pausedIntervals: context.pauses.get(issue.issueId) ?? [],
      ...(override === undefined ? {} : { override: override.rule }),
      asOfMs,
    });

    for (const ruleId of assessment.crossed) {
      const threshold =
        ruleId === "overdue"
          ? assessment.appliedRule.alertAfterDays
          : assessment.appliedRule.escalateAfterDays;
      const inserted = await tx.query(
        `insert into issue_alert
           (alert_id, issue_id, rule_id, window_start, raised_at,
            department_age_days, citizen_age_days, threshold_days,
            rule_source, policy_version, reasons)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
         on conflict (issue_id, rule_id, window_start) do nothing
         returning alert_id`,
        [
          randomUUID(),
          issue.issueId,
          ruleId,
          new Date(issue.departmentSinceMs).toISOString(),
          options.asOf.toISOString(),
          assessment.departmentAgeDays.toFixed(4),
          assessment.citizenAgeDays.toFixed(4),
          threshold,
          assessment.ruleSource,
          assessment.policyVersion,
          JSON.stringify(assessment.reasons),
        ],
      );
      if (inserted.rows.length > 0) raised += 1;
      else alreadyRaised += 1;
    }
  }

  return { evaluated: kept.length, raised, alreadyRaised };
};

/**
 * A supervisor shortens (or lengthens) the clock on one issue.
 *
 * Superseded rather than updated: who decided a report should be chased sooner,
 * when, and why is the question an audit asks, and it cannot be answered from a
 * row that was overwritten.
 */
export const recordAgeingOverride = async (
  tx: Queryable,
  input: {
    readonly principal: Principal;
    readonly issueId: string;
    readonly alertAfterDays: number;
    readonly escalateAfterDays: number;
    readonly reason: string;
  },
): Promise<{ readonly overrideId: string }> => {
  if (input.reason.trim().length < 8) {
    // Also enforced by issue_ageing_override_reason_nonempty_ck; this is for
    // the message and to avoid writing a row that would then roll back.
    throw new SupervisorError(
      "an ageing override requires a recorded reason saying why this issue should be chased on a different clock",
    );
  }
  if (input.escalateAfterDays <= input.alertAfterDays || input.alertAfterDays <= 0) {
    throw new SupervisorError(
      "an override must alert after a positive number of days and escalate later than it alerts",
    );
  }

  const { rows } = await tx.query(
    "select jurisdiction_id from canonical_issue where issue_id = $1",
    [input.issueId],
  );
  if (rows[0] === undefined) throw new SupervisorError(`issue ${input.issueId} does not exist`);
  const jurisdictionId = rows[0]["jurisdiction_id"];
  if (jurisdictionId === null || jurisdictionId === undefined) {
    throw new SupervisorError("an ageing override is jurisdiction-scoped and this issue has none");
  }
  requireSupervisor(input.principal, "ageing.override", String(jurisdictionId));
  if (input.principal.staffId === undefined) {
    throw new SupervisorError("an ageing override must be attributable to a staff identity");
  }

  const overrideId = randomUUID();
  await tx.query("begin");
  try {
    const current = await tx.query(
      `select override_id from issue_ageing_override
        where issue_id = $1 and superseded_at is null
        order by recorded_at desc limit 1`,
      [input.issueId],
    );
    const supersedes =
      current.rows[0] === undefined ? null : String(current.rows[0]["override_id"]);
    if (supersedes !== null) {
      await tx.query(
        "update issue_ageing_override set superseded_at = now() where override_id = $1",
        [supersedes],
      );
    }
    await tx.query(
      `insert into issue_ageing_override
         (override_id, issue_id, alert_after_days, escalate_after_days, reason,
          supervisor_id, supersedes_override_id)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [
        overrideId,
        input.issueId,
        input.alertAfterDays,
        input.escalateAfterDays,
        input.reason.trim(),
        input.principal.staffId,
        supersedes,
      ],
    );
    await tx.query("commit");
  } catch (error) {
    await tx.query("rollback").catch(() => undefined);
    throw error;
  }
  return { overrideId };
};

/** Marks an alert as seen. Never deletes it: the alert happened. */
export const acknowledgeAlert = async (
  tx: Queryable,
  input: {
    readonly principal: Principal;
    readonly alertId: string;
    readonly jurisdictionId: string;
  },
): Promise<{ readonly acknowledged: boolean }> => {
  requireSupervisor(input.principal, "issue.read_private", input.jurisdictionId);
  const { rowCount } = await tx.query(
    `update issue_alert a
        set acknowledged_at = now(), acknowledged_by = $2
       from canonical_issue i
      where a.alert_id = $1
        and i.issue_id = a.issue_id
        and i.jurisdiction_id = $3
        and a.acknowledged_at is null`,
    [input.alertId, input.principal.staffId ?? null, input.jurisdictionId],
  );
  return { acknowledged: (rowCount ?? 0) > 0 };
};
