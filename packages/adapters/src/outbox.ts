/**
 * Transactional outbox and durable stage execution (roadmap V017).
 *
 * Implements the V006 §7 design against the V012 tables. Two guarantees are
 * the whole point of this module:
 *
 *  1. **A domain change and its pending work commit together or not at all.**
 *     Nothing is enqueued before commit, so a receipt can never be returned
 *     for work the database did not accept.
 *  2. **An expired worker cannot overwrite a newer lease's result.** Every
 *     stage write is guarded by a fencing token that increments on each
 *     acquisition, so a slow worker waking up after its lease expired writes
 *     nothing.
 *
 * Delivery is at-least-once and unordered. Duplicate delivery is expected and
 * must be a no-op at the domain level, which the unique stage key provides.
 */

import { randomUUID } from "node:crypto";

/** Minimal surface both `pg.Client` and `pg.Pool` satisfy. */
export interface Queryable {
  query(
    sql: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rows: Record<string, unknown>[]; readonly rowCount: number | null }>;
}

export type EventToAppend = {
  readonly aggregate_type: string;
  readonly aggregate_id: string;
  readonly aggregate_version: number;
  readonly event_type: string;
  readonly actor_type: string;
  readonly actor_pseudonym?: string;
  readonly correlation_id: string;
  readonly occurred_at: string;
  readonly payload_schema_version: string;
  readonly payload: Readonly<Record<string, unknown>>;
};

export type TaskToEnqueue = {
  readonly task_type: string;
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly not_before?: string;
};

export type OutboxRow = {
  readonly outbox_id: string;
  readonly event_id: string;
  readonly task_type: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly attempts: number;
};

export type RetryPolicy = {
  readonly maxAttempts: number;
  readonly baseBackoffSeconds: number;
  /** Claims older than this are considered abandoned and reclaimed. */
  readonly claimStaleAfterSeconds: number;
};

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  baseBackoffSeconds: 2,
  claimStaleAfterSeconds: 300,
};

export class OutboxError extends Error {}

/**
 * Appends an event and its pending work **inside the caller's transaction**.
 *
 * This function deliberately does not open a transaction: the point is that
 * the caller's domain writes and these rows share one commit. Calling it
 * outside a transaction gives no atomicity, which is why the API expects a
 * client already inside `BEGIN`.
 */
export const appendEventWithOutbox = async (
  tx: Queryable,
  event: EventToAppend,
  tasks: readonly TaskToEnqueue[] = [],
): Promise<{ readonly eventId: string; readonly outboxIds: readonly string[] }> => {
  const eventId = randomUUID();

  await tx.query(
    `insert into status_event (
       event_id, aggregate_type, aggregate_id, aggregate_version, event_type,
       actor_type, actor_pseudonym, correlation_id, occurred_at, payload_schema_version, payload
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      eventId,
      event.aggregate_type,
      event.aggregate_id,
      event.aggregate_version,
      event.event_type,
      event.actor_type,
      event.actor_pseudonym ?? null,
      event.correlation_id,
      event.occurred_at,
      event.payload_schema_version,
      JSON.stringify(event.payload),
    ],
  );

  const outboxIds: string[] = [];
  for (const task of tasks) {
    const { rows } = await tx.query(
      `insert into outbox (event_id, task_type, payload, not_before)
       values ($1,$2,$3, coalesce($4::timestamptz, now()))
       returning outbox_id`,
      [eventId, task.task_type, JSON.stringify(task.payload ?? {}), task.not_before ?? null],
    );
    outboxIds.push(String(rows[0]!["outbox_id"]));
  }

  return { eventId, outboxIds };
};

/**
 * Claims a bounded batch of due work.
 *
 * `FOR UPDATE SKIP LOCKED` means two concurrent relays never claim the same
 * row, and `LIMIT` keeps a single relay pass bounded regardless of backlog
 * size (V006 §7 "bounded dispatch").
 */
/**
 * Claims a bounded batch of due work.
 *
 * `taskTypes` narrows the claim to particular kinds of work. A deployment can
 * run one relay per handler — a slow recipient notification must not hold up
 * projection refreshes — and it is also what lets a test claim only the rows
 * it created, instead of whatever else happens to be pending in a shared
 * database. Omitted, a relay claims everything due, which is the default.
 */
export const claimOutboxBatch = async (
  tx: Queryable,
  options: {
    readonly limit: number;
    readonly claimedBy: string;
    readonly taskTypes?: readonly string[];
  },
): Promise<readonly OutboxRow[]> => {
  if (options.limit <= 0 || options.limit > 1000) {
    throw new OutboxError("claim limit must be between 1 and 1000");
  }
  if (options.taskTypes !== undefined && options.taskTypes.length === 0) {
    // An empty filter would claim nothing at all, which is almost certainly a
    // caller bug rather than a request for a relay that does no work.
    throw new OutboxError("taskTypes must not be empty when given");
  }

  const { rows } = await tx.query(
    `with due as (
       select outbox_id from outbox
       where delivered_at is null
         and terminal_failure_reason is null
         and claimed_at is null
         and not_before <= now()
         and ($3::text[] is null or task_type = any($3::text[]))
       order by outbox_id
       limit $1
       for update skip locked
     )
     update outbox o
        set claimed_at = now(), claimed_by = $2
       from due
      where o.outbox_id = due.outbox_id
      returning o.outbox_id, o.event_id, o.task_type, o.payload, o.attempts`,
    [options.limit, options.claimedBy, options.taskTypes ?? null],
  );

  return rows.map((row) => ({
    outbox_id: String(row["outbox_id"]),
    event_id: String(row["event_id"]),
    task_type: String(row["task_type"]),
    payload: (row["payload"] ?? {}) as Record<string, unknown>,
    attempts: Number(row["attempts"]),
  }));
};

export const markDelivered = async (tx: Queryable, outboxId: string): Promise<boolean> => {
  const { rowCount } = await tx.query(
    `update outbox set delivered_at = now()
      where outbox_id = $1 and delivered_at is null and terminal_failure_reason is null`,
    [outboxId],
  );
  return (rowCount ?? 0) === 1;
};

export type DeliveryFailure =
  | { readonly outcome: "retry_scheduled"; readonly attempts: number; readonly notBefore: string }
  | { readonly outcome: "terminal"; readonly attempts: number };

/**
 * Records a failed delivery attempt. Exponential backoff until the attempt
 * ceiling, then an explicit terminal state — never an infinite retry loop and
 * never a silent drop (V006 §7).
 */
export const recordDeliveryFailure = async (
  tx: Queryable,
  outboxId: string,
  reason: string,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): Promise<DeliveryFailure> => {
  const { rows } = await tx.query(
    `update outbox
        set attempts = attempts + 1,
            claimed_at = null,
            claimed_by = null,
            not_before = now() + ($2::numeric * power(2, attempts)) * interval '1 second'
      where outbox_id = $1
      returning attempts, not_before`,
    [outboxId, policy.baseBackoffSeconds],
  );
  if (rows.length === 0) {
    throw new OutboxError(`no outbox row ${outboxId}`);
  }
  const attempts = Number(rows[0]!["attempts"]);

  if (attempts >= policy.maxAttempts) {
    await tx.query(
      `update outbox set terminal_failure_reason = $2, claimed_at = null, claimed_by = null
        where outbox_id = $1`,
      [outboxId, reason],
    );
    return { outcome: "terminal", attempts };
  }

  return {
    outcome: "retry_scheduled",
    attempts,
    notBefore: new Date(String(rows[0]!["not_before"])).toISOString(),
  };
};

/**
 * Reconciles work whose claim was abandoned — a relay that crashed after
 * claiming but before delivering. Without this, such rows would stay claimed
 * forever and the work would silently never happen.
 */
export const reclaimAbandonedClaims = async (
  tx: Queryable,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): Promise<number> => {
  const { rowCount } = await tx.query(
    `update outbox
        set claimed_at = null, claimed_by = null
      where delivered_at is null
        and terminal_failure_reason is null
        and claimed_at is not null
        and claimed_at < now() - ($1::numeric * interval '1 second')`,
    [policy.claimStaleAfterSeconds],
  );
  return rowCount ?? 0;
};

/** Undelivered, non-terminal work — what a monitoring alert watches. */
export const outboxBacklog = async (
  tx: Queryable,
): Promise<{
  readonly pending: number;
  readonly terminal: number;
  readonly oldestPendingSeconds: number;
}> => {
  const { rows } = await tx.query(
    `select
       count(*) filter (where delivered_at is null and terminal_failure_reason is null) as pending,
       count(*) filter (where terminal_failure_reason is not null) as terminal,
       coalesce(max(extract(epoch from (now() - created_at))) filter
         (where delivered_at is null and terminal_failure_reason is null), 0) as oldest
     from outbox`,
  );
  const row = rows[0]!;
  return {
    pending: Number(row["pending"]),
    terminal: Number(row["terminal"]),
    oldestPendingSeconds: Number(row["oldest"]),
  };
};

// ---------------------------------------------------------------------------
// Durable stage execution
// ---------------------------------------------------------------------------

export type StageKey = {
  readonly submissionId: string;
  readonly stage: string;
  readonly pipelineVersion: string;
};

export type StageLease = {
  readonly stageId: string;
  /** Increments on every acquisition. Required to write a result. */
  readonly fencingToken: number;
  readonly attempts: number;
};

export type LeaseOutcome =
  | { readonly acquired: true; readonly lease: StageLease }
  | {
      readonly acquired: false;
      readonly reason: "already_leased" | "already_succeeded" | "terminal";
    };

/**
 * Acquires a lease on a uniquely keyed stage.
 *
 * The unique key `(submission_id, stage, pipeline_version)` is what makes
 * duplicate queue delivery harmless: the second delivery finds the same row
 * rather than creating a second unit of work.
 *
 * A live lease held by someone else is refused. An *expired* lease can be
 * taken over, and doing so increments the fencing token — which is what
 * invalidates the previous holder's writes.
 */
export const acquireStageLease = async (
  tx: Queryable,
  key: StageKey,
  options: { readonly owner: string; readonly leaseSeconds: number; readonly inputHash?: string },
): Promise<LeaseOutcome> => {
  // Insert-or-find, so concurrent first deliveries converge on one row.
  await tx.query(
    `insert into processing_stage (stage_id, submission_id, stage, pipeline_version, input_hash)
     values ($1,$2,$3,$4,$5)
     on conflict (submission_id, stage, pipeline_version) do nothing`,
    [randomUUID(), key.submissionId, key.stage, key.pipelineVersion, options.inputHash ?? null],
  );

  const { rows } = await tx.query(
    `update processing_stage
        set state = 'leased',
            lease_owner = $4,
            lease_expires_at = now() + ($5::numeric * interval '1 second'),
            fencing_token = fencing_token + 1,
            attempts = attempts + 1,
            updated_at = now()
      where submission_id = $1 and stage = $2 and pipeline_version = $3
        and (
          state in ('pending','failed_retryable')
          -- An expired lease may be taken over; a live one may not.
          or (state = 'leased' and lease_expires_at <= now())
        )
      returning stage_id, fencing_token, attempts`,
    [key.submissionId, key.stage, key.pipelineVersion, options.owner, options.leaseSeconds],
  );

  if (rows.length === 1) {
    const row = rows[0]!;
    return {
      acquired: true,
      lease: {
        stageId: String(row["stage_id"]),
        fencingToken: Number(row["fencing_token"]),
        attempts: Number(row["attempts"]),
      },
    };
  }

  const { rows: current } = await tx.query(
    `select state from processing_stage
      where submission_id = $1 and stage = $2 and pipeline_version = $3`,
    [key.submissionId, key.stage, key.pipelineVersion],
  );
  const state = current.length === 1 ? String(current[0]!["state"]) : "pending";
  if (state === "succeeded") return { acquired: false, reason: "already_succeeded" };
  if (state === "failed_terminal") return { acquired: false, reason: "terminal" };
  return { acquired: false, reason: "already_leased" };
};

/** Extends a lease, but only for the holder of the current fencing token. */
export const renewStageLease = async (
  tx: Queryable,
  lease: StageLease,
  options: { readonly owner: string; readonly leaseSeconds: number },
): Promise<boolean> => {
  const { rowCount } = await tx.query(
    `update processing_stage
        set lease_expires_at = now() + ($4::numeric * interval '1 second'), updated_at = now()
      where stage_id = $1 and fencing_token = $2 and lease_owner = $3 and state = 'leased'`,
    [lease.stageId, lease.fencingToken, options.owner, options.leaseSeconds],
  );
  return (rowCount ?? 0) === 1;
};

/**
 * Commits a stage result. Guarded by the fencing token: an expired worker
 * whose lease was taken over writes **nothing**, because its token is stale.
 * Returns false rather than throwing, so a fenced worker can exit quietly.
 */
export const completeStage = async (
  tx: Queryable,
  lease: StageLease,
  result: Readonly<Record<string, unknown>>,
): Promise<boolean> => {
  const { rowCount } = await tx.query(
    `update processing_stage
        set state = 'succeeded', result = $3, lease_owner = null, lease_expires_at = null,
            failure_reason = null, updated_at = now()
      where stage_id = $1 and fencing_token = $2 and state = 'leased'`,
    [lease.stageId, lease.fencingToken, JSON.stringify(result)],
  );
  return (rowCount ?? 0) === 1;
};

export type StageFailure = { readonly recorded: boolean; readonly terminal: boolean };

/** Records a stage failure, escalating to a terminal state at the ceiling. */
export const failStage = async (
  tx: Queryable,
  lease: StageLease,
  reason: string,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): Promise<StageFailure> => {
  const terminal = lease.attempts >= policy.maxAttempts;
  const { rowCount } = await tx.query(
    `update processing_stage
        set state = $4, failure_reason = $3, lease_owner = null, lease_expires_at = null,
            updated_at = now()
      where stage_id = $1 and fencing_token = $2 and state = 'leased'`,
    [lease.stageId, lease.fencingToken, reason, terminal ? "failed_terminal" : "failed_retryable"],
  );
  return { recorded: (rowCount ?? 0) === 1, terminal };
};

/** Stages whose lease expired without a result — reconciliation input. */
/**
 * Expired leases, identified well enough to act on.
 *
 * The submission, stage and pipeline version are included because V022 needs
 * an abandoned unit of work to be *visible*: a bare stage id tells an operator
 * that something is stuck but not what, which turns every recovery into a
 * second query against a table they may not have open.
 */
export const findExpiredStageLeases = async (
  tx: Queryable,
  limit = 100,
): Promise<
  readonly {
    readonly stageId: string;
    readonly attempts: number;
    readonly submissionId: string;
    readonly stage: string;
    readonly pipelineVersion: string;
    readonly leaseOwner: string | undefined;
  }[]
> => {
  const { rows } = await tx.query(
    `select stage_id, attempts, submission_id, stage, pipeline_version, lease_owner
       from processing_stage
      where state = 'leased' and lease_expires_at <= now()
      order by lease_expires_at
      limit $1`,
    [limit],
  );
  return rows.map((row) => ({
    stageId: String(row["stage_id"]),
    attempts: Number(row["attempts"]),
    submissionId: String(row["submission_id"]),
    stage: String(row["stage"]),
    pipelineVersion: String(row["pipeline_version"]),
    leaseOwner: row["lease_owner"] === null ? undefined : String(row["lease_owner"]),
  }));
};

/**
 * Returns expired leases to a retryable state so they can be picked up again.
 * This is the reconciliation pass V017 requires for expired work.
 */
export const reconcileExpiredStages = async (tx: Queryable): Promise<number> => {
  const { rowCount } = await tx.query(
    `update processing_stage
        set state = 'failed_retryable',
            failure_reason = coalesce(failure_reason, 'lease_expired_without_result'),
            lease_owner = null, lease_expires_at = null, updated_at = now()
      where state = 'leased' and lease_expires_at <= now()`,
  );
  return rowCount ?? 0;
};
