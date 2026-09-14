/**
 * Ingestion recovery and duplicate delivery (roadmap V022).
 *
 * Run with: npm run db:up && npm run db:migrate && npm run test:db
 *
 * V017 already covers the lease and outbox primitives in isolation. What this
 * file covers is the whole media stage under the failures that actually happen
 * in production: a worker that dies, the same task delivered twice, bytes that
 * have gone missing, a lease that expires mid-work, and a crash landing in the
 * window between committing a stage result and acknowledging the task.
 *
 * The distinction the roadmap asks for runs through all of it: an idempotent
 * *database* outcome is not the same as an idempotent *external* one. A repeat
 * delivery must not write a second row, and it must also not pay for a second
 * external call — and the second of those is a separate guard, tested
 * separately with a counter standing in for a paid call.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";

import {
  newCorrelationId,
  unsafeIdempotencyKey,
  unsafeIdempotencyScope,
  unsafeRequestFingerprint,
  unsafeUuid,
  type MutationAdapterCallContext,
} from "@vision/contracts";

import { FilesystemObjectStoreAdapter } from "./object-store.ts";
import { SubmissionService, type SubmissionInput } from "./submissions.ts";
import { MediaProcessingService, MEDIA_STAGE } from "./media-processing.ts";
import { MEDIA_PIPELINE_VERSION } from "./media-pipeline.ts";
import {
  acquireStageLease,
  completeStage,
  findExpiredStageLeases,
  reconcileExpiredStages,
} from "./outbox.ts";

const DATABASE_URL =
  process.env["DATABASE_URL"] ??
  "postgresql://vision:vision_local_dev_only@127.0.0.1:5432/vision_dev";

const TESTDATA = join(import.meta.dirname, "../../media/src/testdata");

let client: pg.Client;
let storeRoot: string;
let store: FilesystemObjectStoreAdapter;
let submissions: SubmissionService;
let processing: MediaProcessingService;
const committed: string[] = [];
const createdParticipants: string[] = [];

const mutation = (key: string): MutationAdapterCallContext => ({
  correlation_id: newCorrelationId(),
  idempotency_key: unsafeIdempotencyKey(key),
  idempotency_scope: unsafeIdempotencyScope("citizen:demo:uploads.create"),
  request_fingerprint: unsafeRequestFingerprint(`sha256:${"a".repeat(64)}`),
});

before(async () => {
  client = new pg.Client({ connectionString: DATABASE_URL, statement_timeout: 15_000 });
  await client.connect();
  storeRoot = await mkdtemp(join(tmpdir(), "vision-recovery-"));
  store = new FilesystemObjectStoreAdapter({ root: storeRoot, grantHmacKey: "test-only-key" });
  submissions = new SubmissionService(client, store, {
    localePackVersion: "demo-locales.v1",
    taxonomyVersion: "demo-taxonomy.v1",
    supportedLocales: ["en-IN", "mr-IN"],
  });
  processing = new MediaProcessingService(client, store);
});

after(async () => {
  for (const submissionId of committed) {
    await client.query("delete from processing_stage where submission_id = $1", [submissionId]);
    await client.query(
      "delete from outbox where event_id in (select event_id from status_event where aggregate_id = $1)",
      [submissionId],
    );
    await client.query("delete from status_event where aggregate_id = $1", [submissionId]);
    await client.query("delete from evidence_item where submission_id = $1", [submissionId]);
    await client.query("delete from submission where submission_id = $1", [submissionId]);
  }
  if (createdParticipants.length > 0) {
    await client.query("delete from app_session where participant_id = any($1::uuid[])", [
      createdParticipants,
    ]);
    await client.query("delete from identity_mapping where participant_id = any($1::uuid[])", [
      createdParticipants,
    ]);
    await client.query("delete from participant where participant_id = any($1::uuid[])", [
      createdParticipants,
    ]);
  }
  await client.end();
  await rm(storeRoot, { recursive: true, force: true });
});

const newParticipant = async (): Promise<string> => {
  const id = randomUUID();
  await client.query("insert into participant (participant_id) values ($1)", [id]);
  createdParticipants.push(id);
  return id;
};

const uploadFixture = async (owner: string, name: string, key: string): Promise<string> => {
  const bytes = await readFile(join(TESTDATA, name));
  const grant = await store.createUploadGrant(
    { intended_content_type: "image/png", max_bytes: 65_536, owner_pseudonym: unsafeUuid(owner) },
    mutation(key),
  );
  if (grant.kind !== "success") throw new Error("grant failed");
  const token = new URL(`http://x${grant.value.upload_url}`).searchParams.get("token");
  if (token === null) throw new Error("no token");
  await store.putStagedObject(grant.value.object_reference, token, bytes, "image/png");
  const done = await store.finalizeUpload(grant.value.object_reference, mutation(`${key}-fin`));
  if (done.kind !== "success") throw new Error("finalize failed");
  return grant.value.object_reference;
};

const newEvidence = async (
  name = "png-scene-32x32.png",
): Promise<{ submissionId: string; evidenceId: string; objectReference: string }> => {
  const participant = await newParticipant();
  const objectReference = await uploadFixture(participant, name, `rec-${randomUUID()}`);
  const input: SubmissionInput = {
    participantId: participant,
    observed: {
      lon: 74.56,
      lat: 16.85,
      accuracyMetres: 12,
      source: "device_geolocation",
      observedAt: new Date().toISOString(),
    },
    interfaceLocale: "en-IN",
    languageHint: "en-IN",
    text: "The classroom roof leaks whenever it rains.",
    evidence: [{ objectReference, mediaType: "photo" }],
  };
  const result = await submissions.create(input, {
    idempotencyKey: `rec-${randomUUID()}`,
    correlationId: randomUUID(),
  });
  if (!result.ok) throw new Error("submission failed");
  committed.push(result.receipt.submission_id);
  const { rows } = await client.query(
    "select evidence_id from evidence_item where submission_id = $1 and media_type = 'photo'",
    [result.receipt.submission_id],
  );
  return {
    submissionId: result.receipt.submission_id,
    evidenceId: String(rows[0]?.["evidence_id"]),
    objectReference,
  };
};

const stageRow = async (submissionId: string): Promise<Record<string, unknown>> => {
  const { rows } = await client.query(
    "select * from processing_stage where submission_id = $1 and stage = $2",
    [submissionId, MEDIA_STAGE],
  );
  if (rows[0] === undefined) throw new Error("no stage row");
  return rows[0];
};

// ---------------------------------------------------------------------------
// Missing uploads
// ---------------------------------------------------------------------------

test("V022: bytes that have gone missing become a visible recoverable failure", async () => {
  const { submissionId, evidenceId, objectReference } = await newEvidence();
  // The row says the object was accepted, but the bytes are gone. A restore
  // gap, a botched migration and a bug all look like this.
  await unlink(join(storeRoot, "originals", objectReference));

  const outcome = await processing.processEvidence({
    evidenceId,
    purpose: "media pipeline with missing bytes",
  });

  assert.equal(outcome.ok, false);
  assert.match(outcome.reasons.join(" "), /missing|not found|unreadable/i);

  const stage = await stageRow(submissionId);
  // Recoverable, not terminal, and not left leased: an operator must be able
  // to see it and a retry must be possible once the bytes are restored.
  assert.equal(stage["state"], "failed_retryable");
  assert.equal(stage["lease_owner"], null);
  assert.match(String(stage["failure_reason"]), /missing|unreadable/i);
});

test("V022: a missing-upload failure is retried successfully once the bytes return", async () => {
  const { evidenceId, objectReference } = await newEvidence("png-rgb-8x8.png");
  const path = join(storeRoot, "originals", objectReference);
  const bytes = await readFile(path);
  await unlink(path);

  const failed = await processing.processEvidence({
    evidenceId,
    purpose: "first attempt, no bytes",
  });
  assert.equal(failed.ok, false);

  await writeFile(path, bytes);
  const recovered = await processing.processEvidence({
    evidenceId,
    purpose: "retry after bytes restored",
  });

  assert.equal(recovered.ok, true);
  const { rows } = await client.query(
    "select processing_status, fingerprint_hash from evidence_item where evidence_id = $1",
    [evidenceId],
  );
  assert.equal(rows[0]?.["processing_status"], "needs_review");
  assert.equal(String(rows[0]?.["fingerprint_hash"]).length, 64);
});

// ---------------------------------------------------------------------------
// Worker crash and expired leases
// ---------------------------------------------------------------------------

test("V022: a worker that dies holding a lease leaves recoverable work", async () => {
  const { submissionId } = await newEvidence("png-gray-8x8.png");
  // Exactly what a crashed worker leaves: a lease taken and no result. The
  // database cannot tell this from a process that was killed.
  const lease = await acquireStageLease(
    client,
    { submissionId, stage: MEDIA_STAGE, pipelineVersion: MEDIA_PIPELINE_VERSION },
    { owner: "worker-that-died", leaseSeconds: 0 },
  );
  assert.equal(lease.acquired, true);

  const expired = await findExpiredStageLeases(client);
  assert.ok(
    expired.some((row) => row.submissionId === submissionId),
    "the dead worker's stage must be discoverable",
  );

  const reconciled = await reconcileExpiredStages(client);
  assert.ok(reconciled >= 1);
  const stage = await stageRow(submissionId);
  assert.equal(stage["state"], "failed_retryable");
  assert.equal(stage["lease_owner"], null);
});

test("V022: the dead worker's late result cannot overwrite the takeover's", async () => {
  const { submissionId, evidenceId } = await newEvidence("png-paeth-32x32.png");
  const key = { submissionId, stage: MEDIA_STAGE, pipelineVersion: MEDIA_PIPELINE_VERSION };

  const dying = await acquireStageLease(client, key, { owner: "worker-a", leaseSeconds: 0 });
  assert.equal(dying.acquired, true);
  if (!dying.acquired) return;

  await reconcileExpiredStages(client);
  // A second worker picks the work up and finishes it for real.
  const outcome = await processing.processEvidence({
    evidenceId,
    purpose: "takeover after the first worker died",
    owner: "worker-b",
  });
  assert.equal(outcome.ok, true);

  // Now the first worker wakes up and tries to write its stale result.
  const wrote = await completeStage(client, dying.lease, { stale: true });

  assert.equal(wrote, false, "a fenced-out holder must not be able to write");
  const stage = await stageRow(submissionId);
  assert.equal(stage["state"], "succeeded");
  assert.equal((stage["result"] as Record<string, unknown>)["stale"], undefined);
});

// ---------------------------------------------------------------------------
// Duplicate delivery
// ---------------------------------------------------------------------------

test("V022: the same task delivered three times leaves one authoritative result", async () => {
  const { submissionId, evidenceId } = await newEvidence("png-scene-64x64.png");

  const outcomes = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    outcomes.push(
      await processing.processEvidence({
        evidenceId,
        purpose: `duplicate delivery attempt ${String(attempt)}`,
      }),
    );
  }

  assert.equal(outcomes.filter((o) => o.ok && !o.alreadyProcessed).length, 1);
  assert.equal(outcomes.filter((o) => o.alreadyProcessed).length, 2);

  const { rows } = await client.query(
    "select count(*)::int as n from processing_stage where submission_id = $1 and stage = $2",
    [submissionId, MEDIA_STAGE],
  );
  assert.equal(rows[0]?.["n"], 1, "one unit of work, whatever the delivery count");

  const evidence = await client.query(
    "select current_version from evidence_item where evidence_id = $1",
    [evidenceId],
  );
  // Version 1 at insert, 2 after the single real processing run. A third
  // increment would mean the row was rewritten by a duplicate.
  assert.equal(evidence.rows[0]?.["current_version"], 2);
});

// ---------------------------------------------------------------------------
// Crash between committing the stage result and acknowledging the task
// ---------------------------------------------------------------------------

test("V022: a crash after stage commit but before task ack does not redo the work", async () => {
  const { submissionId, evidenceId } = await newEvidence("png-tone-base-32x32.png");

  // First delivery: succeeds and commits. The crash is what happens next —
  // the process dies before it can acknowledge the task, so the queue will
  // deliver the same task again.
  const first = await processing.processEvidence({ evidenceId, purpose: "committed then crashed" });
  assert.equal(first.ok, true);
  const afterFirst = await stageRow(submissionId);

  // Redelivery after the crash.
  const second = await processing.processEvidence({
    evidenceId,
    purpose: "redelivery after crash",
  });

  assert.equal(second.alreadyProcessed, true);
  assert.equal(second.ok, true, "the work is done; a redelivery is a success, not a failure");
  const afterSecond = await stageRow(submissionId);
  assert.deepEqual(afterSecond["result"], afterFirst["result"], "the result must not be rewritten");
  assert.equal(afterSecond["fencing_token"], afterFirst["fencing_token"], "no new lease was taken");
});

test("V022: an idempotent database outcome does not imply an idempotent external cost", async () => {
  const { evidenceId } = await newEvidence("png-tone-brighter-32x32.png");

  // The counter stands in for a paid external call. The point of the test is
  // that database idempotency alone would not have protected it: only the
  // `already_succeeded` short-circuit stops the second charge.
  let externalCalls = 0;
  const chargeableDetector = {
    label: "approved-vendor-detector v3",
    detect: () => {
      externalCalls += 1;
      return [];
    },
  };

  await processing.processEvidence({
    evidenceId,
    purpose: "first delivery, external call made",
    detector: chargeableDetector,
  });
  await processing.processEvidence({
    evidenceId,
    purpose: "second delivery, must not call again",
    detector: chargeableDetector,
  });

  assert.equal(externalCalls, 1, "a redelivery must not pay for the work twice");
});

test("V022: a genuinely killed process leaves a lease that is not reclaimable early", async () => {
  const { submissionId } = await newEvidence("png-scene-brighter-32x32.png");
  const key = { submissionId, stage: MEDIA_STAGE, pipelineVersion: MEDIA_PIPELINE_VERSION };
  // Create the row, then release it so the child can take a fresh lease.
  const seed = await acquireStageLease(client, key, { owner: "seed", leaseSeconds: 0 });
  assert.equal(seed.acquired, true);
  await reconcileExpiredStages(client);
  const stageId = String((await stageRow(submissionId))["stage_id"]);

  // A real process, really killed. The simulated case above asserts what the
  // database sees; this asserts that a SIGKILLed worker actually produces it.
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const { default: pg } = await import("pg");
       const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
       await c.connect();
       await c.query("update processing_stage set state='leased', lease_owner='killed-child', lease_expires_at=now()+interval '30 seconds', fencing_token=fencing_token+1, attempts=attempts+1 where stage_id=$1", [process.env.STAGE_ID]);
       process.kill(process.pid, "SIGKILL");`,
    ],
    {
      cwd: join(import.meta.dirname, "../../.."),
      env: { ...process.env, DATABASE_URL, STAGE_ID: stageId },
      encoding: "utf8",
      timeout: 20_000,
    },
  );

  assert.equal(child.signal, "SIGKILL", `child should have been killed: ${child.stderr}`);

  const stuck = await stageRow(submissionId);
  assert.equal(stuck["state"], "leased");
  assert.equal(stuck["lease_owner"], "killed-child");
  assert.equal(stuck["result"], null, "the dead process committed no result");

  // Its lease has not expired, so reconciliation must leave it alone. A
  // recovery that reclaimed a live lease early would let two workers run the
  // same stage at once, which is worse than waiting.
  await reconcileExpiredStages(client);
  assert.equal((await stageRow(submissionId))["state"], "leased");

  // Once the lease does expire, it becomes recoverable and is identified.
  await client.query("update processing_stage set lease_expires_at = now() where stage_id = $1", [
    stageId,
  ]);
  const expired = await findExpiredStageLeases(client);
  const mine = expired.find((row) => row.stageId === stageId);
  assert.equal(mine?.submissionId, submissionId);
  assert.equal(mine?.leaseOwner, "killed-child");
  assert.ok((await reconcileExpiredStages(client)) >= 1);
  assert.equal((await stageRow(submissionId))["state"], "failed_retryable");
});
