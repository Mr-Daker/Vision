/**
 * The relay that runs the stages (roadmap V017).
 *
 * This is what was missing. `apps/worker` registered no handlers, so the
 * `process_submission_media` task that `submissions.ts` enqueues in the same
 * commit as every submission (V017) was never claimed by anything. A citizen
 * submitted a report, received a durable receipt, and then nothing happened to
 * it: no issue, no matching, no trust report, no routing, no confirm/reject
 * question. Every stage was built and tested; none of them ran.
 *
 * One relay pass is deliberately a *function*, not a loop. It claims a bounded
 * batch, runs each task, and returns what it did. The loop that calls it lives
 * in the entry point, so this is testable without timers and a deployment can
 * choose its own cadence — and `limit` keeps a pass bounded regardless of how
 * large the backlog is (V006 §7 "bounded dispatch").
 *
 * The failure behaviour is the part that matters, because a relay that loses
 * work is worse than no relay:
 *
 *  * **An unhandled task type is never marked delivered.** Acknowledging work
 *    nobody can do is how a report disappears with every log looking clean. It
 *    is recorded as a failure, so it backs off, becomes terminal, and shows up
 *    in `outboxBacklog` — visible rather than gone.
 *  * **A throwing handler leaves the task to be retried.** `recordDeliveryFailure`
 *    already implements bounded exponential backoff and an explicit terminal
 *    state, so this only has to not swallow the error.
 *  * **An already-processed task is acknowledged, not retried.** A handler that
 *    reports `already_processed` is telling the relay an earlier delivery did
 *    the work — which is the crash window V017 exists for: the stage commits,
 *    the process dies, the task is still unacknowledged. Retrying forever on
 *    that would be as bad as dropping it.
 */

import { randomUUID } from "node:crypto";

import {
  appendEventWithOutbox,
  claimOutboxBatch,
  markDelivered,
  recordDeliveryFailure,
  type OutboxRow,
  type Queryable,
} from "@vision/adapters";

export type StageTask = {
  readonly outboxId: string;
  readonly eventId: string;
  readonly taskType: string;
  readonly payload: Record<string, unknown>;
  /** How many times delivery has already been attempted, for a handler that cares. */
  readonly attempts: number;
};

export type NextStage = {
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly taskType: string;
  readonly payload?: Record<string, unknown>;
  readonly actorPseudonym?: string;
};

export type StageDependencies = {
  /**
   * Appends an event and enqueues the following stage in one commit.
   *
   * Each stage is its own unit of work with its own retry, which is what the
   * outbox is for: a slow classification must not force the media stage to be
   * redone when it is retried.
   *
   * The aggregate version is derived rather than passed in, because
   * `status_event_aggregate_version_uniq` makes a guessed version a hard
   * failure — and a stage retried after a partial failure would guess wrong.
   */
  enqueueNext(next: NextStage): Promise<{ readonly eventId: string }>;
};

export type StageOutcome =
  | { readonly outcome: "done" }
  /** An earlier delivery already did this work; acknowledge rather than retry. */
  | { readonly outcome: "already_processed" }
  /** Permanently impossible. Recorded and backed off, never silently dropped. */
  | { readonly outcome: "refused"; readonly reason: string };

export type StageHandler = (task: StageTask, deps: StageDependencies) => Promise<StageOutcome>;

export type StageHandlers = Readonly<Record<string, StageHandler>>;

export type RelayPass = {
  readonly claimed: number;
  readonly delivered: number;
  readonly failed: number;
  /** Claimed but with no handler registered. Counted separately: it is a deployment fault. */
  readonly unhandled: number;
  readonly notes: readonly string[];
};

const dependenciesFor = (tx: Queryable): StageDependencies => ({
  enqueueNext: async (next) => {
    const { rows } = await tx.query(
      `select coalesce(max(aggregate_version), 0) + 1 as next
         from status_event where aggregate_type = $1 and aggregate_id = $2`,
      [next.aggregateType, next.aggregateId],
    );
    const version = Number(rows[0]?.["next"] ?? 1);
    const appended = await appendEventWithOutbox(
      tx,
      {
        aggregate_type: next.aggregateType,
        aggregate_id: next.aggregateId,
        aggregate_version: version,
        event_type: next.eventType,
        // , which is what the event table permits — a relay is
        // not a person and must not be recorded as one.
        actor_type: "system_worker",
        ...(next.actorPseudonym === undefined ? {} : { actor_pseudonym: next.actorPseudonym }),
        correlation_id: randomUUID() as never,
        occurred_at: new Date().toISOString(),
        payload_schema_version: "v1",
        // Identifiers and counts only, like every other event (V005 §8).
        payload: next.payload ?? {},
      },
      [
        {
          task_type: next.taskType,
          ...(next.payload === undefined ? {} : { payload: next.payload }),
        },
      ],
    );
    return { eventId: appended.eventId };
  },
});

const toTask = (row: OutboxRow): StageTask => ({
  outboxId: row.outbox_id,
  eventId: row.event_id,
  taskType: row.task_type,
  payload: row.payload,
  attempts: row.attempts,
});

export const runRelayOnce = async (
  tx: Queryable,
  options: {
    readonly handlers: StageHandlers;
    readonly claimedBy: string;
    readonly limit: number;
    /** Narrows the claim, so a slow stage cannot hold up a fast one. */
    readonly taskTypes?: readonly string[];
  },
): Promise<RelayPass> => {
  const rows = await claimOutboxBatch(tx, {
    limit: options.limit,
    claimedBy: options.claimedBy,
    ...(options.taskTypes === undefined ? {} : { taskTypes: options.taskTypes }),
  });

  let delivered = 0;
  let failed = 0;
  let unhandled = 0;
  const notes: string[] = [];

  for (const row of rows) {
    const handler = options.handlers[row.task_type];
    if (handler === undefined) {
      // Not delivered. A deployment missing a handler has a real problem, and
      // the work must still be there when somebody fixes it.
      const failure = await recordDeliveryFailure(
        tx,
        row.outbox_id,
        `no handler is registered for task type '${row.task_type}'`,
      );
      unhandled += 1;
      notes.push(
        `no handler for '${row.task_type}' (${failure.outcome}, attempt ${String(failure.attempts)})`,
      );
      continue;
    }

    try {
      const outcome = await handler(toTask(row), dependenciesFor(tx));
      if (outcome.outcome === "refused") {
        const failure = await recordDeliveryFailure(tx, row.outbox_id, outcome.reason);
        failed += 1;
        notes.push(`'${row.task_type}' refused: ${outcome.reason} (${failure.outcome})`);
        continue;
      }
      await markDelivered(tx, row.outbox_id);
      delivered += 1;
      if (outcome.outcome === "already_processed") {
        notes.push(`'${row.task_type}' was already processed by an earlier delivery`);
      }
    } catch (error) {
      // The reason is recorded, but not the provider's or database's own text:
      // an error message can quote the request, and a request carries the
      // citizen's words (V005 §6).
      const failure = await recordDeliveryFailure(
        tx,
        row.outbox_id,
        `handler for '${row.task_type}' threw`,
      );
      failed += 1;
      notes.push(
        `'${row.task_type}' threw (${failure.outcome}, attempt ${String(failure.attempts)}): ${
          error instanceof Error ? error.name : "unknown error"
        }`,
      );
    }
  }

  return { claimed: rows.length, delivered, failed, unhandled, notes };
};
