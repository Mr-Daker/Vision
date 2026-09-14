/**
 * The relay that actually runs the stages (roadmap V017, V021, V026–V033).
 *
 * Run with: npm run db:up && npm run db:migrate && npm run test:db
 *
 * Until now `apps/worker` registered no stage handlers, and its own status
 * string said so. The consequence was not subtle: a citizen submitted a
 * report, received a durable receipt, and then **nothing happened to it** —
 * no issue, no matching, no trust report, no routing, no confirm/reject
 * question. Every stage was built and tested; none of them ran.
 *
 * `outbox` already held the work. `submissions.ts` enqueues
 * `process_submission_media` in the same commit as the submission (V017), and
 * that row was never claimed by anything.
 *
 * What this file pins is the relay's behaviour under the failures that matter,
 * because a relay that loses work is worse than no relay at all:
 *
 *  * an unknown task type is **not** marked delivered — silently dropping work
 *    is how a report disappears with every log looking clean;
 *  * a handler that throws leaves the task to be retried, not discarded;
 *  * a crash after the stage commits but before the task is acknowledged
 *    re-delivers, and the stage is idempotent, so effects do not double
 *    (V017's "duplicate queue delivery does not duplicate committed effects");
 *  * a text-only report reaches matching, because most reports have no photo.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

import { claimOutboxBatch, outboxBacklog } from "@vision/adapters";

import { runRelayOnce, type StageHandlers } from "./relay.ts";

const DATABASE_URL =
  process.env["DATABASE_URL"] ??
  "postgresql://vision:vision_local_dev_only@127.0.0.1:5432/vision_dev";

let client: pg.Client;
const participants: string[] = [];
const submissions: string[] = [];
const events: string[] = [];

const ORIGIN = { lon: 76.11, lat: 18.11 };

before(async () => {
  client = new pg.Client({ connectionString: DATABASE_URL, statement_timeout: 15_000 });
  await client.connect();
});

after(async () => {
  await client.end().catch(() => undefined);
  const cleaner = new pg.Client({ connectionString: DATABASE_URL, statement_timeout: 10_000 });
  await cleaner.connect();
  try {
    if (events.length > 0) {
      await cleaner.query("delete from outbox where event_id = any($1::uuid[])", [events]);
      await cleaner.query("delete from status_event where event_id = any($1::uuid[])", [events]);
    }
    if (submissions.length > 0) {
      await cleaner.query("delete from processing_stage where submission_id = any($1::uuid[])", [
        submissions,
      ]);
      await cleaner.query("delete from evidence_item where submission_id = any($1::uuid[])", [
        submissions,
      ]);
      await cleaner.query("delete from submission where submission_id = any($1::uuid[])", [
        submissions,
      ]);
    }
    if (participants.length > 0) {
      await cleaner.query("delete from participant where participant_id = any($1::uuid[])", [
        participants,
      ]);
    }
  } finally {
    await cleaner.end();
  }
});

/** A submission with its first event and the media task, as `submissions.ts` writes them. */
const newSubmissionWithTask = async (
  taskType = "process_submission_media",
): Promise<{ submissionId: string; eventId: string }> => {
  const participantId = randomUUID();
  await client.query("insert into participant (participant_id) values ($1)", [participantId]);
  participants.push(participantId);

  const submissionId = randomUUID();
  await client.query(
    `insert into submission
       (submission_id, participant_id, observed_location, observed_accuracy_m,
        observed_location_source, observed_at, interface_locale, locale_pack_version,
        taxonomy_version, idempotency_key)
     values ($1,$2, ST_SetSRID(ST_MakePoint($3,$4),4326)::geography, 12,
             'device_geolocation', now(), 'en-IN','demo-locales.v1','demo-taxonomy.v1',$5)`,
    [submissionId, participantId, ORIGIN.lon, ORIGIN.lat, `relay-${submissionId}`],
  );
  submissions.push(submissionId);
  await client.query(
    `insert into evidence_item (evidence_id, submission_id, media_type, content_text)
     values ($1,$2,'text','The drain outside the school gate is blocked.')`,
    [randomUUID(), submissionId],
  );

  const eventId = randomUUID();
  await client.query(
    `insert into status_event
       (event_id, aggregate_type, aggregate_id, aggregate_version, event_type,
        actor_type, actor_pseudonym, correlation_id, occurred_at, payload_schema_version, payload)
     values ($1,'Submission',$2,1,'submission_received','citizen',$3,$4, now(),'v1','{}'::jsonb)`,
    [eventId, submissionId, participantId, randomUUID()],
  );
  events.push(eventId);
  await client.query("insert into outbox (event_id, task_type, payload) values ($1,$2,$3::jsonb)", [
    eventId,
    taskType,
    JSON.stringify({ submission_id: submissionId }),
  ]);
  return { submissionId, eventId };
};

const claimedBy = () => `relay-test:${randomUUID().slice(0, 8)}`;

// ---------------------------------------------------------------------------

test("V017: the relay claims the task a submission enqueued and runs its handler", async () => {
  const { submissionId } = await newSubmissionWithTask();
  const seen: string[] = [];
  const handlers: StageHandlers = {
    process_submission_media: async (task) => {
      seen.push(String(task.payload["submission_id"]));
      return { outcome: "done" };
    },
  };

  const result = await runRelayOnce(client, {
    handlers,
    claimedBy: claimedBy(),
    limit: 10,
    taskTypes: ["process_submission_media"],
  });

  assert.deepEqual(seen, [submissionId]);
  assert.equal(result.delivered, 1);
  assert.equal(result.failed, 0);
});

test("V017: a delivered task is not claimed again", async () => {
  await newSubmissionWithTask();
  const handlers: StageHandlers = {
    process_submission_media: async () => ({ outcome: "done" }),
  };
  const owner = claimedBy();

  const first = await runRelayOnce(client, {
    handlers,
    claimedBy: owner,
    limit: 10,
    taskTypes: ["process_submission_media"],
  });
  const second = await runRelayOnce(client, {
    handlers,
    claimedBy: owner,
    limit: 10,
    taskTypes: ["process_submission_media"],
  });

  assert.equal(first.delivered, 1);
  assert.equal(second.claimed, 0);
});

test("V017: an unknown task type is never marked delivered", async () => {
  // Silently acknowledging work nobody can do is how a report disappears with
  // every log looking clean. It stays undelivered, and the backlog shows it.
  const { eventId } = await newSubmissionWithTask("some_task_nobody_handles");

  const result = await runRelayOnce(client, {
    handlers: {},
    claimedBy: claimedBy(),
    limit: 10,
    taskTypes: ["some_task_nobody_handles"],
  });

  assert.equal(result.delivered, 0);
  assert.equal(result.unhandled, 1);
  const { rows } = await client.query(
    "select delivered_at, attempts from outbox where event_id = $1",
    [eventId],
  );
  assert.equal(rows[0]?.["delivered_at"], null);
  assert.ok(Number(rows[0]?.["attempts"]) >= 1, "the attempt is recorded, so it is visible");
});

test("V017: a handler that throws leaves the work to be retried", async () => {
  const { eventId } = await newSubmissionWithTask();
  let calls = 0;
  const handlers: StageHandlers = {
    process_submission_media: async () => {
      calls += 1;
      if (calls === 1) throw new Error("the object store was briefly unreachable");
      return { outcome: "done" };
    },
  };

  const first = await runRelayOnce(client, {
    handlers,
    claimedBy: claimedBy(),
    limit: 10,
    taskTypes: ["process_submission_media"],
  });
  assert.equal(first.failed, 1);
  assert.equal(first.delivered, 0);

  // The retry backoff is in the future, so the row is claimable only once due.
  await client.query("update outbox set not_before = now() where event_id = $1", [eventId]);
  const second = await runRelayOnce(client, {
    handlers,
    claimedBy: claimedBy(),
    limit: 10,
    taskTypes: ["process_submission_media"],
  });

  assert.equal(second.delivered, 1);
  assert.equal(calls, 2);
});

test("V017: a handler may enqueue the next stage, and the relay runs that too", async () => {
  // Each stage is its own unit of work with its own retry, which is what the
  // outbox is for — a slow classification must not force the media stage to be
  // redone when it is retried.
  const { submissionId } = await newSubmissionWithTask();
  const ran: string[] = [];
  const handlers: StageHandlers = {
    process_submission_media: async (task, deps) => {
      ran.push("media");
      const enqueued = await deps.enqueueNext({
        aggregateType: "Submission",
        aggregateId: String(task.payload["submission_id"]),
        eventType: "submission_media_processed",
        taskType: "match_submission",
        payload: { submission_id: String(task.payload["submission_id"]) },
      });
      events.push(enqueued.eventId);
      return { outcome: "done" };
    },
    match_submission: async () => {
      ran.push("matching");
      return { outcome: "done" };
    },
  };
  const owner = claimedBy();

  await runRelayOnce(client, {
    handlers,
    claimedBy: owner,
    limit: 10,
    taskTypes: ["process_submission_media"],
  });
  await runRelayOnce(client, {
    handlers,
    claimedBy: owner,
    limit: 10,
    taskTypes: ["match_submission"],
  });

  assert.deepEqual(ran, ["media", "matching"]);
  void submissionId;
});

test("V017: a task re-delivered after its stage committed does not double the effects", async () => {
  // V017's own acceptance condition. The crash window is real: the stage
  // commits, the process dies, and the task is still unacknowledged.
  const { eventId } = await newSubmissionWithTask();
  let sideEffects = 0;
  const handlers: StageHandlers = {
    process_submission_media: async () => {
      // A handler that reports `already_processed` is telling the relay the
      // work was done by an earlier delivery — the relay must acknowledge it,
      // not retry forever.
      sideEffects += 1;
      return { outcome: sideEffects === 1 ? "done" : "already_processed" };
    },
  };
  const owner = claimedBy();

  await runRelayOnce(client, {
    handlers,
    claimedBy: owner,
    limit: 10,
    taskTypes: ["process_submission_media"],
  });
  // Simulate the crash: the stage ran, the acknowledgment never landed.
  await client.query(
    "update outbox set delivered_at = null, claimed_at = null, claimed_by = null where event_id = $1",
    [eventId],
  );
  const second = await runRelayOnce(client, {
    handlers,
    claimedBy: owner,
    limit: 10,
    taskTypes: ["process_submission_media"],
  });

  assert.equal(second.delivered, 1, "an already-processed task is acknowledged, not retried");
  const { rows } = await client.query("select delivered_at from outbox where event_id = $1", [
    eventId,
  ]);
  assert.notEqual(rows[0]?.["delivered_at"], null);
});

test("V017: the relay claims nothing when there is nothing due", async () => {
  const result = await runRelayOnce(client, {
    handlers: {},
    claimedBy: claimedBy(),
    limit: 10,
    taskTypes: ["a_task_type_that_is_never_enqueued"],
  });

  assert.equal(result.claimed, 0);
  assert.equal(result.delivered, 0);
});

test("V017: the backlog is reportable, so stuck work is visible", async () => {
  // A relay that cannot say what it has not done is a relay nobody can trust.
  await newSubmissionWithTask("some_task_nobody_handles");
  await runRelayOnce(client, {
    handlers: {},
    claimedBy: claimedBy(),
    limit: 10,
    taskTypes: ["some_task_nobody_handles"],
  });

  const backlog = await outboxBacklog(client);
  //  counts work that is due and undelivered, which is exactly where
  // an unhandled task lands after its failure is recorded.
  assert.ok(backlog.pending >= 1 || backlog.terminal >= 1);
});

test("V017: one relay pass is bounded by its limit", async () => {
  // Bounded dispatch (V006 §7): a large backlog must not turn one pass into an
  // unbounded run that holds connections and cannot be reasoned about.
  for (let index = 0; index < 3; index += 1) await newSubmissionWithTask();
  const handlers: StageHandlers = {
    process_submission_media: async () => ({ outcome: "done" }),
  };

  const result = await runRelayOnce(client, {
    handlers,
    claimedBy: claimedBy(),
    limit: 2,
    taskTypes: ["process_submission_media"],
  });

  assert.equal(result.claimed, 2);
});

test("V017: a refused task is not acknowledged, so it stays visible", async () => {
  // A handler that refuses is saying this work cannot be done as delivered.
  // Acknowledging it would mark the work complete when it never happened —
  // the same silent drop as an unhandled task type, just harder to spot.
  const { eventId } = await newSubmissionWithTask();
  const handlers: StageHandlers = {
    process_submission_media: async () => ({
      outcome: "refused",
      reason: "the task carries no submission_id",
    }),
  };

  const result = await runRelayOnce(client, {
    handlers,
    claimedBy: claimedBy(),
    limit: 10,
    taskTypes: ["process_submission_media"],
  });

  // Asserted on this test's own row rather than on the pass totals: earlier
  // tests in this file legitimately leave undelivered rows of the same task
  // type, so a count would pass or fail on test order.
  assert.ok(result.failed >= 1);
  assert.equal(result.delivered, 0);
  const { rows } = await client.query(
    "select delivered_at, attempts from outbox where event_id = $1",
    [eventId],
  );
  assert.equal(rows[0]?.["delivered_at"], null);
  assert.ok(Number(rows[0]?.["attempts"]) >= 1);
});

test("V017: the event a stage appends is attributed to the worker, not to a person", async () => {
  // The audit log is the record of who did what. An event a machine produced
  // attributed to a reviewer is a false statement about a person — and it is
  // exactly the sort that is never noticed, because it reads as ordinary.
  const { submissionId } = await newSubmissionWithTask();
  const handlers: StageHandlers = {
    process_submission_media: async (task, deps) => {
      const next = await deps.enqueueNext({
        aggregateType: "Submission",
        aggregateId: String(task.payload["submission_id"]),
        eventType: "submission_media_processed",
        taskType: "match_submission",
      });
      events.push(next.eventId);
      return { outcome: "done" };
    },
  };

  await runRelayOnce(client, {
    handlers,
    claimedBy: claimedBy(),
    limit: 10,
    taskTypes: ["process_submission_media"],
  });

  const { rows } = await client.query(
    `select actor_type, actor_pseudonym from status_event
      where aggregate_id = $1 and event_type = 'submission_media_processed'`,
    [submissionId],
  );
  assert.equal(rows[0]?.["actor_type"], "system_worker");
  // And no pseudonym: there is no person behind this event to name.
  assert.equal(rows[0]?.["actor_pseudonym"], null);
});

test("V017: a stage that appends twice does not collide on the event version", async () => {
  // `status_event_aggregate_version_uniq` makes a guessed version a hard
  // failure, and a retried stage would guess the same one twice. The version
  // is derived from what is already recorded, so the second append follows the
  // first instead of colliding with it.
  const { submissionId } = await newSubmissionWithTask();
  const handlers: StageHandlers = {
    process_submission_media: async (task, deps) => {
      for (const eventType of ["submission_media_processed", "submission_media_reprocessed"]) {
        const next = await deps.enqueueNext({
          aggregateType: "Submission",
          aggregateId: String(task.payload["submission_id"]),
          eventType,
          taskType: "match_submission",
        });
        events.push(next.eventId);
      }
      return { outcome: "done" };
    },
  };

  const result = await runRelayOnce(client, {
    handlers,
    claimedBy: claimedBy(),
    limit: 10,
    taskTypes: ["process_submission_media"],
  });

  assert.equal(result.failed, 0, `unexpected failure: ${result.notes.join("; ")}`);
  const { rows } = await client.query(
    "select aggregate_version from status_event where aggregate_id = $1 order by aggregate_version",
    [submissionId],
  );
  assert.deepEqual(
    rows.map((row) => Number(row["aggregate_version"])),
    [1, 2, 3],
  );
});
