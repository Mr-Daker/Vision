/**
 * A resident's roadmap for one report, and its escalation track (report
 * roadmap design, 2026-09-30).
 *
 * The record already holds every step a report goes through, with a time, and
 * the supervisor side already knows how long a department has had it against
 * the configured wait. This turns both into what a resident can read: where
 * the report is, what happens next, and by when it is flagged if nobody acts.
 *
 * Two rules from the rest of the system hold here too. Nothing is a severity:
 * the escalation dates are a configured promise about time (V036), not a claim
 * about how serious the problem is. And nothing says anyone was notified: an
 * alert is recorded internally, and this build delivers it to nobody.
 *
 * Pure: no clock, no storage.
 */

import type { AgeingAssessment } from "./ageing-policy.ts";
import type { IssueStatus } from "./transitions.ts";

export const ROADMAP_STEPS = [
  "received",
  "checked",
  "grouped",
  "routed",
  "acknowledged",
  "work_planned",
  "repair_claimed",
  "confirmed",
] as const;

export type RoadmapStepId = (typeof ROADMAP_STEPS)[number];

/** What the current step is waiting on, in the words the interface will use. */
export type RoadmapNote =
  | "being_checked"
  | "being_grouped"
  | "your_answer_needed"
  | "being_routed"
  | "choosing_department"
  | "with_department"
  | "work_planned"
  | "your_confirmation_needed"
  | "repair_disputed"
  | "reopened"
  | "fixed";

export type RoadmapStep = {
  readonly id: RoadmapStepId;
  readonly state: "done" | "current" | "upcoming";
  /** When it happened, if the record says. A step passed without its own event has none. */
  readonly at: string | undefined;
};

/** The issue events a step can be dated from. */
export type RoadmapEventType =
  | "routed_internal"
  | "agency_ack_received"
  | "work_planned"
  | "disputed_work_returned"
  | "resolution_claimed"
  | "resolution_confirmed";

export type RoadmapInput = {
  readonly receivedAt: string;
  /** When the photo and description finished processing; absent until then. */
  readonly checkedAt: string | undefined;
  /** The matcher has asked the resident "is this the same problem?" and is waiting. */
  readonly awaitingAnswer: boolean;
  /** The issue this report was grouped with, once it has been. */
  readonly issue:
    | {
        readonly status: IssueStatus;
        /**
         * When this report joined the issue. Not the issue's opening time:
         * that is when the problem was first observed, which can be before
         * this report was even checked, and would put the steps out of order.
         */
        readonly groupedAt: string;
        /** The latest time each event was recorded, so a reopened issue shows its latest pass. */
        readonly lastEventAt: Readonly<Partial<Record<RoadmapEventType, string>>>;
      }
    | undefined;
};

export type Roadmap = {
  readonly steps: readonly RoadmapStep[];
  readonly note: RoadmapNote;
};

/**
 * Which step is current for each issue status, and what it is waiting on.
 * `undefined` means every step is done.
 */
const POSITION: Readonly<
  Record<IssueStatus, { readonly current: RoadmapStepId | undefined; readonly note: RoadmapNote }>
> = {
  created: { current: "routed", note: "being_routed" },
  routing_review: { current: "routed", note: "choosing_department" },
  routed_internal: { current: "acknowledged", note: "with_department" },
  agency_ack_received: { current: "work_planned", note: "with_department" },
  work_planned: { current: "repair_claimed", note: "work_planned" },
  resolution_claimed: { current: "confirmed", note: "your_confirmation_needed" },
  // The resident said it is not fixed; the claim stands on the record, and a
  // reviewer decides what happens next.
  resolution_disputed: { current: "confirmed", note: "repair_disputed" },
  // Back with the department, as if newly acknowledged.
  reopened: { current: "acknowledged", note: "reopened" },
  resolution_confirmed: { current: undefined, note: "fixed" },
};

const latest = (...times: readonly (string | undefined)[]): string | undefined =>
  times
    .filter((time): time is string => time !== undefined)
    .sort()
    .at(-1);

export const buildRoadmap = (input: RoadmapInput): Roadmap => {
  const events = input.issue?.lastEventAt ?? {};
  const dates: Readonly<Record<RoadmapStepId, string | undefined>> = {
    received: input.receivedAt,
    checked: input.checkedAt,
    grouped: input.issue?.groupedAt,
    routed: events.routed_internal,
    acknowledged: events.agency_ack_received,
    work_planned: latest(events.work_planned, events.disputed_work_returned),
    repair_claimed: events.resolution_claimed,
    confirmed: events.resolution_confirmed,
  };

  let current: RoadmapStepId | undefined;
  let note: RoadmapNote;
  if (input.issue !== undefined) {
    ({ current, note } = POSITION[input.issue.status]);
  } else if (input.checkedAt === undefined) {
    current = "checked";
    note = "being_checked";
  } else {
    current = "grouped";
    note = input.awaitingAnswer ? "your_answer_needed" : "being_grouped";
  }

  const currentIndex =
    current === undefined ? ROADMAP_STEPS.length : ROADMAP_STEPS.indexOf(current);
  const steps = ROADMAP_STEPS.map((id, index): RoadmapStep => {
    const state = index < currentIndex ? "done" : index === currentIndex ? "current" : "upcoming";
    // Only a step that has happened carries a date; a reopened issue's later
    // steps are upcoming again, and their old dates would say otherwise.
    return { id, state, at: state === "done" ? dates[id] : undefined };
  });

  return { steps, note };
};

// ---------------------------------------------------------------------------
// Escalation
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;

export type EscalationInput = {
  /** The supervisor view's own assessment for this issue, unchanged. */
  readonly assessment: AgeingAssessment;
  readonly departmentSinceMs: number;
  /** The clock is paused right now (the resident is being asked to confirm a repair). */
  readonly pausedNow: boolean;
  /** Alerts recorded in the current department's window. */
  readonly alerts: readonly { readonly ruleId: string; readonly raisedAt: string }[];
};

export type EscalationTrack = {
  readonly departmentSince: string;
  /** Running days with the department, to one decimal. */
  readonly departmentDays: number;
  readonly alertAfterDays: number;
  readonly escalateAfterDays: number;
  /**
   * When the department clock reaches each threshold, if nothing else pauses
   * it: time already paused pushes both dates later, day for day.
   */
  readonly flagDueAt: string;
  readonly escalateDueAt: string;
  readonly flaggedAt: string | undefined;
  readonly escalatedAt: string | undefined;
  readonly paused: boolean;
  readonly ruleSource: AgeingAssessment["ruleSource"];
};

export const buildEscalation = (input: EscalationInput): EscalationTrack => {
  const { assessment } = input;
  const due = (days: number): string =>
    new Date(input.departmentSinceMs + (days + assessment.pausedDays) * MS_PER_DAY).toISOString();
  const recorded = (ruleId: string): string | undefined =>
    input.alerts.find((alert) => alert.ruleId === ruleId)?.raisedAt;
  return {
    departmentSince: new Date(input.departmentSinceMs).toISOString(),
    departmentDays: Math.round(assessment.departmentAgeDays * 10) / 10,
    alertAfterDays: assessment.appliedRule.alertAfterDays,
    escalateAfterDays: assessment.appliedRule.escalateAfterDays,
    flagDueAt: due(assessment.appliedRule.alertAfterDays),
    escalateDueAt: due(assessment.appliedRule.escalateAfterDays),
    flaggedAt: recorded("overdue"),
    escalatedAt: recorded("escalated"),
    paused: input.pausedNow,
    ruleSource: assessment.ruleSource,
  };
};
