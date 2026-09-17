/**
 * Pure parsing and presentation rules for the V036 supervisor workspace.
 *
 * The vocabulary here is the whole point. A supervisor screen is where
 * "critical" and "urgent" would arrive most naturally and do the most damage:
 * this system measures how long something has waited against a promise
 * somebody configured, and nothing else. `supervisor-view.test.ts` asserts
 * that no label below claims otherwise.
 *
 * The roadmap's "critical" queue is rendered as **Escalated** for that reason.
 * It holds issues past the pack's second threshold — a statement about elapsed
 * time, not about danger.
 */

export type SupervisorQueueId =
  "unacknowledged" | "overdue" | "escalated" | "disputed" | "reopened";

export type SupervisorAlert = {
  readonly alertId: string;
  readonly ruleId: string;
  readonly raisedAt: string;
  readonly acknowledgedAt?: string;
};

export type SupervisorIssueRow = {
  readonly issueId: string;
  readonly publicReference: string;
  readonly category: string;
  readonly currentStatus: string;
  readonly departmentId?: string;
  readonly assignedStaffId?: string;
  readonly openedAt: string;
  readonly departmentSince?: string;
  readonly queues: readonly SupervisorQueueId[];
  readonly departmentAgeDays?: number;
  readonly citizenAgeDays?: number;
  readonly pausedDays?: number;
  readonly alertAfterDays?: number;
  readonly escalateAfterDays?: number;
  readonly ruleSource?: string;
  readonly reasons: readonly string[];
  readonly alerts: readonly SupervisorAlert[];
  readonly override?: {
    readonly alertAfterDays: number;
    readonly escalateAfterDays: number;
    readonly reason: string;
    readonly recordedAt: string;
  };
};

export type SupervisorQueueView = {
  readonly jurisdictionId: string;
  readonly asOf: string;
  readonly policyVersion: string;
  readonly policyNote: string;
  readonly counts: Readonly<Record<SupervisorQueueId, number>>;
  readonly issues: readonly SupervisorIssueRow[];
  readonly exhaustive: boolean;
  readonly deliveryNote: string;
};

const QUEUE_IDS = new Set<SupervisorQueueId>([
  "unacknowledged",
  "overdue",
  "escalated",
  "disputed",
  "reopened",
]);

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;

const optionalString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const optionalNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** Invalid private data fails closed rather than becoming an actionable row. */
export const toSupervisorQueueView = (payload: unknown): SupervisorQueueView | undefined => {
  const root = record(payload);
  if (root === undefined || !Array.isArray(root["issues"])) return undefined;
  const counts = record(root["counts"]);
  if (
    typeof root["jurisdiction_id"] !== "string" ||
    typeof root["as_of"] !== "string" ||
    typeof root["policy_version"] !== "string" ||
    typeof root["policy_note"] !== "string" ||
    typeof root["delivery_note"] !== "string" ||
    counts === undefined
  ) {
    return undefined;
  }

  const issues: SupervisorIssueRow[] = [];
  for (const raw of root["issues"]) {
    const item = record(raw);
    if (item === undefined) return undefined;
    const queues = item["queues"];
    if (
      typeof item["issue_id"] !== "string" ||
      typeof item["public_reference"] !== "string" ||
      typeof item["category"] !== "string" ||
      typeof item["current_status"] !== "string" ||
      typeof item["opened_at"] !== "string" ||
      !Array.isArray(queues) ||
      !queues.every(
        (queue) => typeof queue === "string" && QUEUE_IDS.has(queue as SupervisorQueueId),
      ) ||
      !Array.isArray(item["alerts"]) ||
      !Array.isArray(item["reasons"])
    ) {
      return undefined;
    }

    const alerts: SupervisorAlert[] = [];
    for (const rawAlert of item["alerts"]) {
      const alert = record(rawAlert);
      if (
        alert === undefined ||
        typeof alert["alert_id"] !== "string" ||
        typeof alert["rule_id"] !== "string" ||
        typeof alert["raised_at"] !== "string"
      ) {
        return undefined;
      }
      alerts.push({
        alertId: alert["alert_id"],
        ruleId: alert["rule_id"],
        raisedAt: alert["raised_at"],
        ...(optionalString(alert["acknowledged_at"]) === undefined
          ? {}
          : { acknowledgedAt: String(alert["acknowledged_at"]) }),
      });
    }

    const override = record(item["override"]);
    issues.push({
      issueId: item["issue_id"],
      publicReference: item["public_reference"],
      category: item["category"],
      currentStatus: item["current_status"],
      ...(optionalString(item["department_id"]) === undefined
        ? {}
        : { departmentId: String(item["department_id"]) }),
      ...(optionalString(item["assigned_staff_id"]) === undefined
        ? {}
        : { assignedStaffId: String(item["assigned_staff_id"]) }),
      openedAt: item["opened_at"],
      ...(optionalString(item["department_since"]) === undefined
        ? {}
        : { departmentSince: String(item["department_since"]) }),
      queues: queues as readonly SupervisorQueueId[],
      ...(optionalNumber(item["department_age_days"]) === undefined
        ? {}
        : { departmentAgeDays: Number(item["department_age_days"]) }),
      ...(optionalNumber(item["citizen_age_days"]) === undefined
        ? {}
        : { citizenAgeDays: Number(item["citizen_age_days"]) }),
      ...(optionalNumber(item["paused_days"]) === undefined
        ? {}
        : { pausedDays: Number(item["paused_days"]) }),
      ...(optionalNumber(item["alert_after_days"]) === undefined
        ? {}
        : { alertAfterDays: Number(item["alert_after_days"]) }),
      ...(optionalNumber(item["escalate_after_days"]) === undefined
        ? {}
        : { escalateAfterDays: Number(item["escalate_after_days"]) }),
      ...(optionalString(item["rule_source"]) === undefined
        ? {}
        : { ruleSource: String(item["rule_source"]) }),
      reasons: (item["reasons"] as unknown[]).map(String),
      alerts,
      ...(override === undefined
        ? {}
        : {
            override: {
              alertAfterDays: Number(override["alert_after_days"]),
              escalateAfterDays: Number(override["escalate_after_days"]),
              reason: String(override["reason"]),
              recordedAt: String(override["recorded_at"]),
            },
          }),
    });
  }

  return {
    jurisdictionId: root["jurisdiction_id"],
    asOf: root["as_of"],
    policyVersion: root["policy_version"],
    policyNote: root["policy_note"],
    counts: {
      unacknowledged: Number(counts["unacknowledged"] ?? 0),
      overdue: Number(counts["overdue"] ?? 0),
      escalated: Number(counts["escalated"] ?? 0),
      disputed: Number(counts["disputed"] ?? 0),
      reopened: Number(counts["reopened"] ?? 0),
    },
    issues,
    exhaustive: root["exhaustive"] === true,
    deliveryNote: root["delivery_note"],
  };
};

/**
 * Queue labels.
 *
 * "Escalated" rather than the roadmap's "critical": this system cannot say a
 * problem is critical, only that a configured number of days has passed.
 */
export const QUEUE_LABELS: Readonly<Record<SupervisorQueueId, string>> = {
  unacknowledged: "No recipient reply yet",
  overdue: "Past the configured wait",
  escalated: "Past the escalation wait",
  disputed: "Repair claim disputed",
  reopened: "Reopened after confirmation",
};

/** What each queue means, in words that make no claim about the problem. */
export const QUEUE_EXPLANATIONS: Readonly<Record<SupervisorQueueId, string>> = {
  unacknowledged:
    "Routed to a department, but no recipient acknowledgment has been recorded. Every recipient in this demonstration is simulated.",
  overdue:
    "Has been with this department longer than the configured policy said it would wait. This is a statement about time, not about how serious the problem is.",
  escalated:
    "Has passed the policy's second threshold. Still a statement about time: nothing here measures danger, and no severity model has been calibrated.",
  disputed:
    "Someone who reported this says the repair claim is not right. A reviewer decides what happens next.",
  reopened:
    "Was confirmed and then reopened, so it is an open problem again and no longer counts as closed.",
};

export const ALERT_LABELS: Readonly<Record<string, string>> = {
  overdue: "Configured wait passed",
  escalated: "Escalation wait passed",
};

/** One decimal, so "7.0 days" does not read as a precise measurement. */
export const dayLabel = (days: number | undefined): string =>
  days === undefined ? "—" : `${days.toFixed(1)} days`;

/**
 * How the two clocks are described together.
 *
 * The citizen clock is named explicitly whenever it is longer, because a
 * re-route restarts the department clock and a screen showing only that one
 * would quietly shorten somebody's wait.
 */
export const clockSummary = (row: SupervisorIssueRow): string => {
  if (row.departmentAgeDays === undefined) {
    return "This issue has not been routed to a department, so no department clock is running.";
  }
  const parts = [`${dayLabel(row.departmentAgeDays)} with this department`];
  if (row.pausedDays !== undefined && row.pausedDays >= 0.05) {
    parts.push(`${dayLabel(row.pausedDays)} paused awaiting people who reported it`);
  }
  if (
    row.citizenAgeDays !== undefined &&
    row.citizenAgeDays > (row.departmentAgeDays ?? 0) + 0.05
  ) {
    parts.push(`${dayLabel(row.citizenAgeDays)} since it was first reported`);
  }
  return parts.join(" · ");
};

/** True when a supervisor's override is what set the current threshold. */
export const isOverridden = (row: SupervisorIssueRow): boolean => row.ruleSource === "override";
