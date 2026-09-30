/**
 * A resident's roadmap for one of their own reports (report roadmap design,
 * 2026-09-30).
 *
 * Owner-scoped like the receipt: a report that is not this participant's is
 * indistinguishable from one that does not exist, so a reference cannot be
 * used to learn anything about somebody else's report.
 *
 * The department clock is the supervisor view's own: the same routing
 * decision anchors it, the same pauses stop it, the same override replaces the
 * category rule, and `evaluateAgeing` does the arithmetic. A resident and a
 * supervisor looking at one issue see the same day count.
 */

import {
  buildEscalation,
  buildRoadmap,
  evaluateAgeing,
  type AgeingPolicyPack,
  type EscalationTrack,
  type IssueStatus,
  type Roadmap,
  type RoadmapEventType,
} from "@vision/domain";

import type { Queryable } from "./outbox.ts";
import { loadAgeingContext } from "./supervisor-queues.ts";

export type ReportRoadmap = Roadmap & {
  readonly issue:
    | {
        readonly publicReference: string;
        readonly category: string;
        readonly status: IssueStatus;
      }
    | undefined;
  /** Present only while a department is responsible and the repair is not confirmed. */
  readonly escalation: EscalationTrack | undefined;
};

const ROADMAP_EVENTS: readonly RoadmapEventType[] = [
  "routed_internal",
  "agency_ack_received",
  "work_planned",
  "disputed_work_returned",
  "resolution_claimed",
  "resolution_confirmed",
];

const iso = (value: unknown): string => new Date(String(value)).toISOString();

export const readReportRoadmap = async (
  tx: Queryable,
  options: {
    readonly participantId: string;
    readonly submissionId: string;
    readonly policy: AgeingPolicyPack;
    readonly asOf: Date;
  },
): Promise<ReportRoadmap | undefined> => {
  const own = await tx.query(
    `select s.server_received_at,
            (select max(e.occurred_at) from status_event e
              where e.aggregate_id = s.submission_id::text
                and e.event_type = 'submission_media_processed') as checked_at,
            exists (select 1 from issue_match m
                     where m.submission_id = s.submission_id
                       and m.state = 'ambiguous'
                       and m.superseded_at is null
                       and m.decided_at is null) as awaiting_answer,
            grouped.issue_id, grouped.public_reference, grouped.category,
            grouped.current_status, grouped.opened_at, grouped.grouped_at
       from submission s
       left join lateral (
         select i.issue_id, i.public_reference, i.category, i.current_status, i.opened_at,
                link.effective_from as grouped_at
           from evidence_item e
           join issue_evidence_link link
             on link.evidence_id = e.evidence_id and link.effective_to is null
           join canonical_issue i on i.issue_id = link.canonical_issue_id
          where e.submission_id = s.submission_id
          order by link.effective_from desc
          limit 1
       ) grouped on true
      where s.submission_id = $1 and s.participant_id = $2 and s.privacy_state = 'active'`,
    [options.submissionId, options.participantId],
  );
  const row = own.rows[0];
  if (row === undefined) return undefined;

  const receivedAt = iso(row["server_received_at"]);
  const checkedAt = row["checked_at"] === null ? undefined : iso(row["checked_at"]);
  const awaitingAnswer = row["awaiting_answer"] === true;

  if (row["issue_id"] === null) {
    return {
      ...buildRoadmap({ receivedAt, checkedAt, awaitingAnswer, issue: undefined }),
      issue: undefined,
      escalation: undefined,
    };
  }

  const issueId = String(row["issue_id"]);
  const status = String(row["current_status"]) as IssueStatus;
  const progress = await issueProgress(tx, {
    issueId,
    status,
    category: String(row["category"]),
    openedAt: iso(row["opened_at"]),
    policy: options.policy,
    asOf: options.asOf,
  });
  const roadmap = buildRoadmap({
    receivedAt,
    checkedAt,
    awaitingAnswer,
    issue: { status, groupedAt: iso(row["grouped_at"]), lastEventAt: progress.lastEventAt },
  });
  return {
    ...roadmap,
    issue: {
      publicReference: String(row["public_reference"]),
      category: String(row["category"]),
      status,
    },
    escalation: progress.escalation,
  };
};

/**
 * The issue's own part of a roadmap: when each step was recorded, and the
 * department's clock. Shared by a resident's report and the public issue page,
 * so the two can never show different dates for the same issue.
 */
const issueProgress = async (
  tx: Queryable,
  options: {
    readonly issueId: string;
    readonly status: IssueStatus;
    readonly category: string;
    readonly openedAt: string;
    readonly policy: AgeingPolicyPack;
    readonly asOf: Date;
  },
): Promise<{
  readonly lastEventAt: Partial<Record<RoadmapEventType, string>>;
  readonly escalation: EscalationTrack | undefined;
}> => {
  const { issueId, status, category } = options;
  const events = await tx.query(
    `select event_type, max(occurred_at) as at
       from status_event
      where aggregate_type = 'canonical_issue' and aggregate_id = $1
        and event_type = any($2::text[])
      group by event_type`,
    [issueId, [...ROADMAP_EVENTS]],
  );
  const lastEventAt: Partial<Record<RoadmapEventType, string>> = {};
  for (const event of events.rows) {
    lastEventAt[String(event["event_type"]) as RoadmapEventType] = iso(event["at"]);
  }

  // The department clock, measured as the supervisor view measures it.
  const routing = await tx.query(
    `select decided_at from routing_decision
      where issue_id = $1 and outcome = 'routed'
      order by decided_at desc limit 1`,
    [issueId],
  );
  const decidedAt = routing.rows[0]?.["decided_at"];
  if (decidedAt === undefined || decidedAt === null || status === "resolution_confirmed") {
    return { lastEventAt, escalation: undefined };
  }

  const departmentSinceMs = Date.parse(iso(decidedAt));
  const asOfMs = options.asOf.getTime();
  const context = await loadAgeingContext(tx, [issueId]);
  const pauses = context.pauses.get(issueId) ?? [];
  const override = context.overrides.get(issueId);
  const assessment = evaluateAgeing({
    category,
    policy: options.policy,
    departmentAnchorMs: departmentSinceMs,
    openedAtMs: Date.parse(options.openedAt),
    pausedIntervals: pauses,
    ...(override === undefined ? {} : { override: override.rule }),
    asOfMs,
  });
  const escalation = buildEscalation({
    assessment,
    departmentSinceMs,
    pausedNow: pauses.some(
      (pause) => pause.fromMs <= asOfMs && (pause.toMs === undefined || pause.toMs > asOfMs),
    ),
    // Only this department's window: an alert about a previous department's
    // delay says nothing about this one.
    alerts: (context.alerts.get(issueId) ?? []).filter(
      (alert) => alert.windowStartMs === departmentSinceMs,
    ),
  });
  return { lastEventAt, escalation };
};

/**
 * The roadmap of an issue itself, for its public page. Public like the page:
 * it carries only what the issue page already shows publicly (status, the
 * dates of its recorded steps) and the configured waits, never a reporter.
 * The first three steps are the issue's own: first reported, and grouped.
 */
export const readIssueRoadmap = async (
  tx: Queryable,
  options: { readonly issueId: string; readonly policy: AgeingPolicyPack; readonly asOf: Date },
): Promise<ReportRoadmap | undefined> => {
  const { rows } = await tx.query(
    `select public_reference, category, current_status, opened_at
       from canonical_issue where issue_id = $1`,
    [options.issueId],
  );
  const row = rows[0];
  if (row === undefined) return undefined;
  const status = String(row["current_status"]) as IssueStatus;
  const openedAt = iso(row["opened_at"]);
  const progress = await issueProgress(tx, {
    issueId: options.issueId,
    status,
    category: String(row["category"]),
    openedAt,
    policy: options.policy,
    asOf: options.asOf,
  });
  const roadmap = buildRoadmap({
    receivedAt: openedAt,
    checkedAt: openedAt,
    awaitingAnswer: false,
    issue: { status, groupedAt: openedAt, lastEventAt: progress.lastEventAt },
  });
  return {
    ...roadmap,
    issue: {
      publicReference: String(row["public_reference"]),
      category: String(row["category"]),
      status,
    },
    escalation: progress.escalation,
  };
};
