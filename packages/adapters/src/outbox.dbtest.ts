/**
 * Outbox and durable stage execution against the real database (roadmap V017).
 *
 * Run with: npm run db:up && npm run db:migrate && npm run test:db
 *
 * Two of these tests need genuinely concurrent connections (claim contention
 * and lease takeover), so they open a second client rather than simulating
 * concurrency inside one transaction.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

import {
  DEFAULT_RETRY_POLICY,
  acquireStageLease,
  appendEventWithOutbox,
  claimOutboxBatch,
  completeStage,
  failStage,
  findExpiredStageLeases,
  markDelivered,
  outboxBacklog,
  reclaimAbandonedClaims,
  reconcileExpiredStages,
  recordDeliveryFailure,
  renewStageLease,
  type StageKey,
} from "./outbox.ts";

/**
 * The task type these tests enqueue and claim.
 *
 * Relay claiming is global by design, so an earlier assertion that the whole
 * outbox was empty failed the moment anyone ran the demo interface and left
 * real pending work behind. Claiming by task type isolates the tests properly
 * instead of demanding an empty database.
 */
const TEST_TASK = "outbox_dbtest_task";
const TEST_TASKS: readonly string[] = [TEST_TASK, `${TEST_TASK}_second`];

const DATABASE_URL =
  process.env["DATABASE_URL"] ??
  "postgresql://vision:vision_local_dev_only@127.0.0.1:5432/vision_dev";

let client: pg.Client;

before(async () => {
  client = new pg.Client({ connectionString: DATABASE_URL, statement_timeout: 15_000 });
  await client.connect();
});

after(async () => {
  await client.end();
});

const inRollback = async (body: () => Promise<void>): Promise<void> => {
  await client.query("begin");
  try {
    await body();
  } finally {
    await client.query("rollback");
  }
};

const newParticipant = async (tx: pg.Client): Promise<string> => {
  const id = randomUUID();
  await tx.query("insert into participant (participant_id) values ($1)", [id]);
  return id;
};

const newSubmission = async (tx: pg.Client, participantId: string): Promise<string> => {
  const id = randomUUID();
  await tx.query(
    `insert into submission (
       submission_id, participant_id, observed_location, observed_accuracy_m,
       observed_at, interface_locale, locale_pack_version, idempotency_key, taxonomy_version
     ) values ($1,$2, ST_SetSRID(ST_MakePoint(74.56,16.85),4326)::geography, 12,
               now(),'en-IN','demo-locales.v1',$3,'demo-taxonomy.v1')`,
    [id, participantId, `outbox-test-${id}`],
  );
  return id;
};

const newIssue = async (tx: pg.Client): Promise<string> => {
  const id = randomUUID();
  await tx.query(
    `insert into canonical_issue (issue_id, public_reference, category, opened_at)
     values ($1,$2,'structure.roof', now())`,
    [id, `VIS-${id.slice(0, 8)}`],
  );
  return id;
};

const eventFor = (aggregateId: string, version: number) => ({
  aggregate_type: "CanonicalIssue",
  aggregate_id: aggregateId,
  aggregate_version: version,
  event_type: "status_transitioned",
  actor_type: "system_worker",
  correlation_id: randomUUID(),
  occurred_at: new Date().toISOString(),
  payload_schema_version: "v1",
  payload: { reason_code: "test" },
});

const stageKeyFor = (submissionId: string): StageKey => ({
  submissionId,
  stage: "media_processing",
  pipelineVersion: "v1",
});

// ---------------------------------------------------------------------------
// Atomic domain change + pending work
// ---------------------------------------------------------------------------

test("V017: a domain change and its pending work commit together", async () => {
  const issueId = await (async () => {
    await client.query("begin");
    const id = await newIssue(client);
    const { eventId, outboxIds } = await appendEventWithOutbox(client, eventFor(id, 1), [
      { task_type: TEST_TASK },
      { task_type: `${TEST_TASK}_second` },
    ]);
    assert.equal(outboxIds.length, 2);
    await client.query("commit");
    // Everything is visible only after the single commit.
    const { rows } = await client.query(
      `select (select count(*) from status_event where event_id = $1)::int as events,
              (select count(*) from outbox where event_id = $1)::int as tasks`,
      [eventId],
    );
    assert.equal(rows[0].events, 1);
    assert.equal(rows[0].tasks, 2);
    return id;
  })();

  // Cleanup: this test commits deliberately, so it removes its own rows.
  await client.query(
    "delete from outbox where event_id in (select event_id from status_event where aggregate_id = $1)",
    [issueId],
  );
  await client.query("delete from status_event where aggregate_id = $1", [issueId]);
  await client.query("delete from canonical_issue where issue_id = $1", [issueId]);
});

test("V017: a rolled-back transaction leaves no pending work behind", async () => {
  const issueId = randomUUID();
  await client.query("begin");
  await client.query(
    `insert into canonical_issue (issue_id, public_reference, category, opened_at)
     values ($1,$2,'structure.roof', now())`,
    [issueId, `VIS-${issueId.slice(0, 8)}`],
  );
  const { eventId } = await appendEventWithOutbox(client, eventFor(issueId, 1), [
    { task_type: TEST_TASK },
  ]);
  await client.query("rollback");

  const { rows } = await client.query(
    `select (select count(*) from status_event where event_id = $1)::int as events,
            (select count(*) from outbox where event_id = $1)::int as tasks,
            (select count(*) from canonical_issue where issue_id = $2)::int as issues`,
    [eventId, issueId],
  );
  assert.equal(rows[0].events, 0);
  assert.equal(rows[0].tasks, 0);
  assert.equal(rows[0].issues, 0, "a failed commit cannot leave a half-created report");
});

// ---------------------------------------------------------------------------
// Bounded dispatch
// ---------------------------------------------------------------------------

test("V017: dispatch is bounded by the requested batch size", async () => {
  await inRollback(async () => {
    const issueId = await newIssue(client);
    for (let version = 1; version <= 7; version += 1) {
      await appendEventWithOutbox(client, eventFor(issueId, version), [{ task_type: TEST_TASK }]);
    }

    const batch = await claimOutboxBatch(client, {
      limit: 3,
      claimedBy: "relay-a",
      taskTypes: TEST_TASKS,
    });
    assert.equal(batch.length, 3, "a relay pass must stay bounded regardless of backlog");

    const second = await claimOutboxBatch(client, {
      limit: 10,
      claimedBy: "relay-a",
      taskTypes: TEST_TASKS,
    });
    assert.equal(second.length, 4, "the rest remains claimable");

    const third = await claimOutboxBatch(client, {
      limit: 10,
      claimedBy: "relay-a",
      taskTypes: TEST_TASKS,
    });
    assert.equal(third.length, 0, "already-claimed work is not re-claimed");
  });
});

test("V017: an absurd batch size is refused", async () => {
  await assert.rejects(
    () => claimOutboxBatch(client, { limit: 0, claimedBy: "x", taskTypes: TEST_TASKS }),
    /between 1 and/,
  );
  await assert.rejects(
    () => claimOutboxBatch(client, { limit: 5000, claimedBy: "x", taskTypes: TEST_TASKS }),
    /between 1 and/,
  );
});

test("V017: a relay claims only the kinds of work it handles", async () => {
  await inRollback(async () => {
    const issueId = await newIssue(client);
    await appendEventWithOutbox(client, eventFor(issueId, 1), [
      { task_type: TEST_TASK },
      { task_type: `${TEST_TASK}_second` },
    ]);

    const first = await claimOutboxBatch(client, {
      limit: 10,
      claimedBy: "relay-first",
      taskTypes: [TEST_TASK],
    });
    assert.deepEqual(
      first.map((row) => row.task_type),
      [TEST_TASK],
      "a per-handler relay must not take work it cannot process",
    );

    const second = await claimOutboxBatch(client, {
      limit: 10,
      claimedBy: "relay-second",
      taskTypes: [`${TEST_TASK}_second`],
    });
    assert.deepEqual(
      second.map((row) => row.task_type),
      [`${TEST_TASK}_second`],
      "the other kind is still claimable by the relay that handles it",
    );
  });
});

test("V017: an empty task-type filter is refused rather than claiming nothing", async () => {
  await assert.rejects(
    () => claimOutboxBatch(client, { limit: 5, claimedBy: "x", taskTypes: [] }),
    /taskTypes must not be empty/,
  );
});

test("V017: work scheduled for later is not claimed early", async () => {
  await inRollback(async () => {
    const issueId = await newIssue(client);
    const future = new Date(Date.now() + 60_000).toISOString();
    await appendEventWithOutbox(client, eventFor(issueId, 1), [
      { task_type: "notify_recipient", not_before: future },
    ]);

    const batch = await claimOutboxBatch(client, {
      limit: 10,
      claimedBy: "relay-a",
      taskTypes: TEST_TASKS,
    });
    assert.equal(batch.length, 0, "backoff must be respected");
  });
});

test("V017: two concurrent relays never claim the same row", async () => {
  const issueId = randomUUID();
  const second = new pg.Client({ connectionString: DATABASE_URL });
  await second.connect();

  try {
    await client.query(
      `insert into canonical_issue (issue_id, public_reference, category, opened_at)
       values ($1,$2,'structure.roof', now())`,
      [issueId, `VIS-${issueId.slice(0, 8)}`],
    );
    for (let version = 1; version <= 6; version += 1) {
      await appendEventWithOutbox(client, eventFor(issueId, version), [{ task_type: TEST_TASK }]);
    }

    // Both relays claim at the same time from separate connections.
    const [a, b] = await Promise.all([
      claimOutboxBatch(client, { limit: 6, claimedBy: "relay-a", taskTypes: TEST_TASKS }),
      claimOutboxBatch(second, { limit: 6, claimedBy: "relay-b", taskTypes: TEST_TASKS }),
    ]);

    const ids = [...a, ...b].map((row) => row.outbox_id);
    assert.equal(new Set(ids).size, ids.length, "SKIP LOCKED must prevent double-claiming");
    assert.equal(ids.length, 6, "between them they claim everything exactly once");
  } finally {
    await second.end();
    await client.query(
      "delete from outbox where event_id in (select event_id from status_event where aggregate_id = $1)",
      [issueId],
    );
    await client.query("delete from status_event where aggregate_id = $1", [issueId]);
    await client.query("delete from canonical_issue where issue_id = $1", [issueId]);
  }
});

// ---------------------------------------------------------------------------
// Retry policy, terminal failure, reconciliation
// ---------------------------------------------------------------------------

test("V017: delivery failures back off and then become terminal", async () => {
  await inRollback(async () => {
    const issueId = await newIssue(client);
    const { outboxIds } = await appendEventWithOutbox(client, eventFor(issueId, 1), [
      { task_type: TEST_TASK },
    ]);
    const outboxId = outboxIds[0]!;

    for (let attempt = 1; attempt < DEFAULT_RETRY_POLICY.maxAttempts; attempt += 1) {
      const result = await recordDeliveryFailure(client, outboxId, "provider timeout");
      assert.equal(result.outcome, "retry_scheduled", `attempt ${String(attempt)}`);
      assert.equal(result.attempts, attempt);
    }

    const final = await recordDeliveryFailure(client, outboxId, "provider timeout");
    assert.equal(final.outcome, "terminal");

    // A terminal row is never claimed again, and is visible as terminal.
    assert.equal(
      (await claimOutboxBatch(client, { limit: 10, claimedBy: "r", taskTypes: TEST_TASKS })).length,
      0,
    );
    const backlog = await outboxBacklog(client);
    assert.equal(backlog.terminal >= 1, true);
  });
});

test("V017: a failed attempt releases its claim so it can be retried", async () => {
  await inRollback(async () => {
    const issueId = await newIssue(client);
    const { outboxIds } = await appendEventWithOutbox(client, eventFor(issueId, 1), [
      { task_type: TEST_TASK },
    ]);

    const claimed = await claimOutboxBatch(client, {
      limit: 1,
      claimedBy: "relay-a",
      taskTypes: TEST_TASKS,
    });
    assert.equal(claimed.length, 1);

    await recordDeliveryFailure(client, outboxIds[0]!, "transient");

    // Backoff pushes not_before into the future, so it is not immediately due.
    assert.equal(
      (await claimOutboxBatch(client, { limit: 1, claimedBy: "relay-a", taskTypes: TEST_TASKS }))
        .length,
      0,
    );
    await client.query("update outbox set not_before = now() where outbox_id = $1", [
      outboxIds[0]!,
    ]);
    assert.equal(
      (await claimOutboxBatch(client, { limit: 1, claimedBy: "relay-a", taskTypes: TEST_TASKS }))
        .length,
      1,
    );
  });
});

test("V017: delivery is recorded once and cannot be double-marked", async () => {
  await inRollback(async () => {
    const issueId = await newIssue(client);
    const { outboxIds } = await appendEventWithOutbox(client, eventFor(issueId, 1), [
      { task_type: TEST_TASK },
    ]);

    assert.equal(await markDelivered(client, outboxIds[0]!), true);
    assert.equal(
      await markDelivered(client, outboxIds[0]!),
      false,
      "a duplicate delivery acknowledgement is a no-op, not a second effect",
    );
    assert.equal(
      (await claimOutboxBatch(client, { limit: 10, claimedBy: "r", taskTypes: TEST_TASKS })).length,
      0,
    );
  });
});

test("V017: an abandoned claim is reconciled back to claimable", async () => {
  await inRollback(async () => {
    const issueId = await newIssue(client);
    await appendEventWithOutbox(client, eventFor(issueId, 1), [{ task_type: TEST_TASK }]);

    const claimed = await claimOutboxBatch(client, {
      limit: 1,
      claimedBy: "relay-that-crashed",
      taskTypes: TEST_TASKS,
    });
    assert.equal(claimed.length, 1);
    assert.equal(
      (await claimOutboxBatch(client, { limit: 1, claimedBy: "relay-b", taskTypes: TEST_TASKS }))
        .length,
      0,
    );

    // Nothing is stale yet.
    assert.equal(await reclaimAbandonedClaims(client), 0);

    // Age the claim past the staleness window.
    await client.query(
      "update outbox set claimed_at = now() - interval '2 hours' where outbox_id = $1",
      [claimed[0]!.outbox_id],
    );
    assert.equal(await reclaimAbandonedClaims(client), 1);

    const recovered = await claimOutboxBatch(client, {
      limit: 1,
      claimedBy: "relay-b",
      taskTypes: TEST_TASKS,
    });
    assert.equal(recovered.length, 1, "work must not be lost because a relay died");
  });
});

// ---------------------------------------------------------------------------
// Unique stage keys and duplicate delivery
// ---------------------------------------------------------------------------

test("V017: duplicate queue delivery does not duplicate committed effects", async () => {
  await inRollback(async () => {
    const submissionId = await newSubmission(client, await newParticipant(client));
    const key = stageKeyFor(submissionId);

    // First delivery leases and completes the stage.
    const first = await acquireStageLease(client, key, { owner: "worker-1", leaseSeconds: 60 });
    assert.equal(first.acquired, true);
    if (!first.acquired) return;
    assert.equal(await completeStage(client, first.lease, { thumbnails: 2 }), true);

    // A duplicate delivery of the same task finds the same stage row.
    const duplicate = await acquireStageLease(client, key, { owner: "worker-2", leaseSeconds: 60 });
    assert.equal(duplicate.acquired, false);
    if (!duplicate.acquired) {
      assert.equal(duplicate.reason, "already_succeeded");
    }

    const { rows } = await client.query(
      `select count(*)::int as stages, max(result::text) as result
         from processing_stage where submission_id = $1`,
      [submissionId],
    );
    assert.equal(rows[0].stages, 1, "one unit of work, however many deliveries");
    assert.match(String(rows[0].result), /thumbnails/);
  });
});

test("V017: a live lease cannot be stolen", async () => {
  await inRollback(async () => {
    const submissionId = await newSubmission(client, await newParticipant(client));
    const key = stageKeyFor(submissionId);

    const held = await acquireStageLease(client, key, { owner: "worker-1", leaseSeconds: 300 });
    assert.equal(held.acquired, true);

    const stolen = await acquireStageLease(client, key, { owner: "worker-2", leaseSeconds: 300 });
    assert.equal(stolen.acquired, false);
    if (!stolen.acquired) assert.equal(stolen.reason, "already_leased");
  });
});

// ---------------------------------------------------------------------------
// Fencing: the V017 acceptance condition
// ---------------------------------------------------------------------------

test("V017: an expired worker cannot overwrite a newer lease's result", async () => {
  await inRollback(async () => {
    const submissionId = await newSubmission(client, await newParticipant(client));
    const key = stageKeyFor(submissionId);

    // Worker 1 takes a short lease and then stalls.
    const first = await acquireStageLease(client, key, { owner: "worker-1", leaseSeconds: 60 });
    assert.equal(first.acquired, true);
    if (!first.acquired) return;

    // Its lease expires.
    await client.query(
      "update processing_stage set lease_expires_at = now() - interval '1 second' where stage_id = $1",
      [first.lease.stageId],
    );

    // Worker 2 takes over; the fencing token increments.
    const second = await acquireStageLease(client, key, { owner: "worker-2", leaseSeconds: 300 });
    assert.equal(second.acquired, true);
    if (!second.acquired) return;
    assert.ok(
      second.lease.fencingToken > first.lease.fencingToken,
      "takeover must increment the fencing token",
    );

    // Worker 1 finally wakes up and tries to write. It must write nothing.
    assert.equal(
      await completeStage(client, first.lease, { written_by: "stale-worker-1" }),
      false,
      "a fenced worker's write must not apply",
    );
    assert.equal(
      await renewStageLease(client, first.lease, { owner: "worker-1", leaseSeconds: 60 }),
      false,
    );
    assert.equal((await failStage(client, first.lease, "stale failure")).recorded, false);

    // Worker 2's write applies.
    assert.equal(await completeStage(client, second.lease, { written_by: "worker-2" }), true);

    const { rows } = await client.query(
      "select state, result from processing_stage where stage_id = $1",
      [first.lease.stageId],
    );
    assert.equal(rows[0].state, "succeeded");
    assert.equal(
      rows[0].result.written_by,
      "worker-2",
      "the newer lease's result survives, not the stale one's",
    );
  });
});

test("V017: a lease holder can renew while it still holds the lease", async () => {
  await inRollback(async () => {
    const submissionId = await newSubmission(client, await newParticipant(client));
    const lease = await acquireStageLease(client, stageKeyFor(submissionId), {
      owner: "worker-1",
      leaseSeconds: 30,
    });
    assert.equal(lease.acquired, true);
    if (!lease.acquired) return;

    assert.equal(
      await renewStageLease(client, lease.lease, { owner: "worker-1", leaseSeconds: 300 }),
      true,
    );
    // A different owner presenting the right token still cannot renew.
    assert.equal(
      await renewStageLease(client, lease.lease, { owner: "worker-2", leaseSeconds: 300 }),
      false,
    );
  });
});

test("V017: stage failures escalate to terminal at the attempt ceiling", async () => {
  await inRollback(async () => {
    const submissionId = await newSubmission(client, await newParticipant(client));
    const key = stageKeyFor(submissionId);

    let terminalSeen = false;
    for (let round = 1; round <= DEFAULT_RETRY_POLICY.maxAttempts; round += 1) {
      const lease = await acquireStageLease(client, key, { owner: "worker-1", leaseSeconds: 60 });
      assert.equal(lease.acquired, true, `round ${String(round)} should be claimable`);
      if (!lease.acquired) return;

      const failure = await failStage(client, lease.lease, "decoder error");
      assert.equal(failure.recorded, true);
      if (failure.terminal) {
        terminalSeen = true;
        break;
      }
    }
    assert.equal(terminalSeen, true, "retries must not loop forever");

    // A terminal stage is not re-leasable.
    const afterTerminal = await acquireStageLease(client, key, {
      owner: "worker-2",
      leaseSeconds: 60,
    });
    assert.equal(afterTerminal.acquired, false);
    if (!afterTerminal.acquired) assert.equal(afterTerminal.reason, "terminal");
  });
});

test("V017: expired leases are discoverable and reconciled", async () => {
  await inRollback(async () => {
    const submissionId = await newSubmission(client, await newParticipant(client));
    const lease = await acquireStageLease(client, stageKeyFor(submissionId), {
      owner: "worker-1",
      leaseSeconds: 60,
    });
    assert.equal(lease.acquired, true);
    if (!lease.acquired) return;

    // Scoped to this stage, not asserted globally. `findExpiredStageLeases`
    // scans the whole table, and this database is shared with every other
    // dbtest file — including the worker's, which creates real stage rows. A
    // global "there are none" assertion passes or fails on what else happens
    // to be present, which is how a suite becomes order-dependent.
    assert.equal(
      (await findExpiredStageLeases(client)).filter((row) => row.stageId === lease.lease.stageId)
        .length,
      0,
    );

    await client.query(
      "update processing_stage set lease_expires_at = now() - interval '1 minute' where stage_id = $1",
      [lease.lease.stageId],
    );

    const expired = await findExpiredStageLeases(client);
    assert.ok(expired.some((row) => row.stageId === lease.lease.stageId));

    const reconciled = await reconcileExpiredStages(client);
    assert.ok(reconciled >= 1);

    const { rows } = await client.query(
      "select state, failure_reason, lease_owner from processing_stage where stage_id = $1",
      [lease.lease.stageId],
    );
    assert.equal(rows[0].state, "failed_retryable");
    assert.equal(rows[0].failure_reason, "lease_expired_without_result");
    assert.equal(rows[0].lease_owner, null, "a reconciled stage holds no lease");

    // And it can be picked up again.
    const retry = await acquireStageLease(client, stageKeyFor(submissionId), {
      owner: "worker-2",
      leaseSeconds: 60,
    });
    assert.equal(retry.acquired, true);
  });
});

test("V017: backlog reporting distinguishes pending from terminal work", async () => {
  await inRollback(async () => {
    const issueId = await newIssue(client);
    const { outboxIds } = await appendEventWithOutbox(client, eventFor(issueId, 1), [
      { task_type: "a" },
      { task_type: "b" },
    ]);
    await client.query(
      "update outbox set terminal_failure_reason = 'gave up' where outbox_id = $1",
      [outboxIds[0]!],
    );

    const backlog = await outboxBacklog(client);
    assert.ok(backlog.pending >= 1);
    assert.ok(backlog.terminal >= 1);
    assert.ok(backlog.oldestPendingSeconds >= 0, "oldest pending age is observable for alerting");
  });
});
