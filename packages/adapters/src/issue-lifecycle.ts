/**
 * Shared issue lifecycle writes (roadmap V014, V034, V035).
 *
 * Two things every actor that moves an issue needs, kept in one place so they
 * cannot drift apart:
 *
 *  - `appendIssueEvent`, which keeps `aggregate_version` contiguous. A gap in
 *    that sequence is indistinguishable from a dropped event, and V035 asserts
 *    contiguity across the whole claim → confirm → reopen path.
 *  - `advanceIssueStatus`, which never moves an issue without asking
 *    `canTransitionIssue` first. Every guard the V003 contract states is an
 *    explicit input there, so a caller has to present the evidence rather than
 *    assert a status.
 *
 * V034 recorded acknowledgments and assignments without touching
 * `current_status`, which left every routed issue sitting at `routed_internal`
 * forever — so V035's `work_planned -> resolution_claimed` edge was
 * unreachable in the running product even though both layers were built. The
 * fix is the two guarded advances below, not a bypass: an issue still reaches
 * `agency_ack_received` only with recorded provider provenance, and
 * `work_planned` only with an active assignment.
 */

import { randomUUID } from "node:crypto";

import { canTransitionIssue, type IssueStatus } from "@vision/domain";

import type { Queryable } from "./outbox.ts";

/** Appends one issue event, keeping the version sequence contiguous. */
export const appendIssueEvent = async (
  tx: Queryable,
  options: {
    readonly issueId: string;
    readonly eventType: string;
    readonly actorType: string;
    readonly actorId?: string | undefined;
    readonly payload: Readonly<Record<string, unknown>>;
    /**
     * When the thing this event describes actually happened.
     *
     * Defaults to now, which is right for a transition a caller is making as
     * it writes. It is wrong for a fact that is being recorded after the
     * moment it describes — an issue's opening, which carries the observation
     * time the citizen reported, is the case this exists for. `recorded_at`
     * is always now either way, so a backdated event still enters V037's
     * knowledge-time bound on the day it arrived and cannot leak into a
     * snapshot published before it existed.
     *
     * An event time *after* now is clamped to now rather than stored: it
     * would otherwise be an event this system has already recorded that a
     * snapshot taken today cannot see, which is a shape no reader expects.
     */
    readonly occurredAt?: string | undefined;
  },
): Promise<string> => {
  const eventId = randomUUID();
  const version = await tx.query(
    `select coalesce(max(aggregate_version), 0) + 1 as next
       from status_event where aggregate_type = 'canonical_issue' and aggregate_id = $1`,
    [options.issueId],
  );
  await tx.query(
    `insert into status_event
       (event_id, aggregate_type, aggregate_id, aggregate_version, event_type,
        actor_type, actor_pseudonym, correlation_id, occurred_at,
        payload_schema_version, payload)
     values ($1,'canonical_issue',$2,$3,$4,$5,$6,$7,
             least(coalesce($9::timestamptz, now()), now()),'1.0.0',$8::jsonb)`,
    [
      eventId,
      options.issueId,
      Number(version.rows[0]?.["next"] ?? 1),
      options.eventType,
      options.actorType,
      options.actorId ?? null,
      randomUUID(),
      JSON.stringify(options.payload),
      options.occurredAt ?? null,
    ],
  );
  return eventId;
};

export class IssueLifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IssueLifecycleError";
  }
}

/**
 * Moves an issue, refusing anything the V003 lifecycle does not permit.
 *
 * Returns `false` when the issue is not in `from` — which is how a repeated
 * callback stays a no-op rather than an error. A delivery webhook that fires
 * twice must not fail the second time, and an acknowledgment recorded against
 * an issue somebody already advanced is not a fault.
 */
export const advanceIssueStatus = async (
  tx: Queryable,
  options: {
    readonly issueId: string;
    readonly from: IssueStatus;
    readonly to: IssueStatus;
    readonly context: Parameters<typeof canTransitionIssue>[2];
    readonly eventType: string;
    readonly actorType: string;
    readonly actorId?: string | undefined;
    readonly payload: Readonly<Record<string, unknown>>;
  },
): Promise<boolean> => {
  const check = canTransitionIssue(options.from, options.to, options.context);
  if (!check.ok) {
    throw new IssueLifecycleError(`refusing ${options.from} -> ${options.to}: ${check.reason}`);
  }
  // Guarded by the current status in the UPDATE itself, so two concurrent
  // requests cannot both believe they performed the advance.
  const moved = await tx.query(
    `update canonical_issue
        set current_status = $3, current_version = current_version + 1
      where issue_id = $1 and current_status = $2
      returning issue_id`,
    [options.issueId, options.from, options.to],
  );
  if (moved.rows.length === 0) return false;

  await appendIssueEvent(tx, {
    issueId: options.issueId,
    eventType: options.eventType,
    actorType: options.actorType,
    actorId: options.actorId,
    payload: options.payload,
  });
  return true;
};
