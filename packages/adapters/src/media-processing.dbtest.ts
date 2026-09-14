/**
 * Media processing against the real database (roadmap V021, V022 groundwork).
 *
 * Run with: npm run db:up && npm run db:migrate && npm run test:db
 *
 * The pure decisions are covered in `media-pipeline.test.ts`. What is asserted
 * here is everything that only the database and the object store can show:
 * that an unresolved redaction case leaves no derivative anywhere, that a
 * quarantined item records why, and that recognising reused bytes never
 * deletes another contributor's record or counts as corroboration.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { MediaProcessingService, findFingerprintReuse } from "./media-processing.ts";
import { MEDIA_PIPELINE_VERSION } from "./media-pipeline.ts";

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
  storeRoot = await mkdtemp(join(tmpdir(), "vision-media-"));
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

/** Uploads real fixture bytes through V016 so the reference is accepted evidence. */
const uploadFixture = async (owner: string, name: string, contentType: string, key: string) => {
  const bytes = await readFile(join(TESTDATA, name));
  const grant = await store.createUploadGrant(
    {
      intended_content_type: contentType,
      max_bytes: 65_536,
      owner_pseudonym: unsafeUuid(owner),
    },
    mutation(key),
  );
  if (grant.kind !== "success") throw new Error("grant failed");
  const token = new URL(`http://x${grant.value.upload_url}`).searchParams.get("token");
  if (token === null) throw new Error("no token");
  await store.putStagedObject(grant.value.object_reference, token, bytes, contentType);
  const finalized = await store.finalizeUpload(
    grant.value.object_reference,
    mutation(`${key}-fin`),
  );
  if (finalized.kind !== "success") throw new Error("finalize failed");
  return grant.value.object_reference;
};

const submissionWith = async (
  participantId: string,
  objectReference: string,
): Promise<{ submissionId: string; evidenceId: string }> => {
  const input: SubmissionInput = {
    participantId,
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
    idempotencyKey: `media-${randomUUID()}`,
    correlationId: randomUUID(),
  });
  if (!result.ok) throw new Error(`submission failed: ${JSON.stringify(result)}`);
  committed.push(result.receipt.submission_id);
  const { rows } = await client.query(
    "select evidence_id from evidence_item where submission_id = $1 and media_type = 'photo'",
    [result.receipt.submission_id],
  );
  return {
    submissionId: result.receipt.submission_id,
    evidenceId: String(rows[0]?.["evidence_id"]),
  };
};

const evidenceRow = async (evidenceId: string): Promise<Record<string, unknown>> => {
  const { rows } = await client.query("select * from evidence_item where evidence_id = $1", [
    evidenceId,
  ]);
  if (rows[0] === undefined) throw new Error("evidence row missing");
  return rows[0];
};

test("V021: a valid photo is fingerprinted but left unresolved with no derivative", async () => {
  const participant = await newParticipant();
  const reference = await uploadFixture(participant, "png-scene-32x32.png", "image/png", "k1");
  const { evidenceId } = await submissionWith(participant, reference);

  const outcome = await processing.processEvidence({
    evidenceId,
    purpose: "media pipeline normalisation for review",
  });

  assert.equal(outcome.ok, true);
  const row = await evidenceRow(evidenceId);
  assert.equal(row["processing_status"], "needs_review");
  assert.equal(row["redaction_status"], "needs_review");
  assert.equal(row["derivative_reference"], null, "an unresolved case must publish nothing");
  assert.equal(String(row["fingerprint_hash"]).length, 64);
  assert.equal(String(row["perceptual_hash"]).length, 16);
});

test("V021: no derivative file exists on disk for an unresolved case", async () => {
  const participant = await newParticipant();
  const reference = await uploadFixture(participant, "png-rgb-8x8.png", "image/png", "k2");
  const { evidenceId } = await submissionWith(participant, reference);

  await processing.processEvidence({ evidenceId, purpose: "media pipeline normalisation" });

  const counts = await store.treeCounts();
  assert.equal(counts["derivatives"] ?? 0, 0, "nothing may be written to the public tree");
});

test("V021: a declared/actual type mismatch cannot even become evidence", async () => {
  // V016 sniffs at completion, so the mismatch never reaches the pipeline.
  // Asserting that here records *where* the boundary actually is, instead of
  // testing the pipeline's unreachable defence-in-depth branch through a path
  // that cannot produce it.
  const participant = await newParticipant();

  await assert.rejects(
    () => uploadFixture(participant, "jpeg-420-16x16.jpg", "image/png", "k3-mismatch"),
    /finalize failed/,
  );
});

test("V021: an original that fails to decode is quarantined and the stage records why", async () => {
  const participant = await newParticipant();
  const reference = await uploadFixture(participant, "png-rgb-8x8.png", "image/png", "k3");
  const { submissionId, evidenceId } = await submissionWith(participant, reference);

  // Corrupt the stored original after acceptance. This is the reachable
  // decode-failure path: bytes that were valid when accepted and are not now.
  const originalPath = join(storeRoot, "originals", reference);
  const good = await readFile(originalPath);
  await writeFile(originalPath, Buffer.concat([good.subarray(0, 20), Buffer.alloc(16, 0xff)]));

  const outcome = await processing.processEvidence({ evidenceId, purpose: "media pipeline check" });

  assert.equal(outcome.ok, false);
  const row = await evidenceRow(evidenceId);
  assert.equal(row["processing_status"], "quarantined");
  assert.equal(row["derivative_reference"], null, "a quarantined item publishes nothing");

  const { rows } = await client.query(
    "select state, failure_reason from processing_stage where submission_id = $1 and pipeline_version = $2",
    [submissionId, MEDIA_PIPELINE_VERSION],
  );
  assert.match(String(rows[0]?.["failure_reason"]), /decode_failed/);
});

test("V021: processing twice does not create a second stage or change the result", async () => {
  const participant = await newParticipant();
  const reference = await uploadFixture(participant, "png-gray-8x8.png", "image/png", "k4");
  const { submissionId, evidenceId } = await submissionWith(participant, reference);

  const first = await processing.processEvidence({ evidenceId, purpose: "media pipeline run one" });
  const second = await processing.processEvidence({
    evidenceId,
    purpose: "media pipeline run two",
  });

  assert.equal(first.ok, true);
  assert.equal(second.alreadyProcessed, true, "a duplicate delivery must be a no-op");

  const { rows } = await client.query(
    "select count(*)::int as n from processing_stage where submission_id = $1",
    [submissionId],
  );
  assert.equal(rows[0]?.["n"], 1, "at-least-once delivery must not create a second unit of work");
});

test("V021: reused bytes are recognised without deleting the earlier record", async () => {
  const participantA = await newParticipant();
  const participantB = await newParticipant();
  const referenceA = await uploadFixture(participantA, "png-scene-64x64.png", "image/png", "k5a");
  const referenceB = await uploadFixture(participantB, "png-scene-64x64.png", "image/png", "k5b");
  const first = await submissionWith(participantA, referenceA);
  const second = await submissionWith(participantB, referenceB);

  await processing.processEvidence({ evidenceId: first.evidenceId, purpose: "media pipeline one" });
  const outcome = await processing.processEvidence({
    evidenceId: second.evidenceId,
    purpose: "media pipeline two",
  });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.reuse?.seenBefore, true);
  assert.deepEqual(outcome.reuse?.otherEvidenceIds, [first.evidenceId]);
  // The critical rule: recognising reuse must never remove the other
  // contributor's evidence record.
  const stillThere = await evidenceRow(first.evidenceId);
  assert.equal(stillThere["privacy_state"], "active");
});

test("V021: reuse is never reported as independent corroboration", async () => {
  const reuse = await findFingerprintReuse(client, {
    fingerprintHash: `sha256-${"b".repeat(58)}`,
    excludeEvidenceId: randomUUID(),
  });

  assert.equal(reuse.seenBefore, false);
  assert.equal(reuse.isIndependentCorroboration, false);
  assert.match(reuse.note, /not .*corroboration/i);
});

test("V021: reading a private original requires a recorded purpose", async () => {
  const participant = await newParticipant();
  const reference = await uploadFixture(participant, "png-rgb-17x9.png", "image/png", "k6");
  const { evidenceId } = await submissionWith(participant, reference);

  await assert.rejects(() => processing.processEvidence({ evidenceId, purpose: "x" }), /purpose/i);
});

test("V021: the object store refuses to publish a derivative for an unresolved case", async () => {
  // The shell's own `mayEnterPublicView` check is unreachable while the
  // pipeline emits no bytes for an unresolved case, so mutation testing cannot
  // distinguish it. This pins the layer that *is* reachable: even handed the
  // bytes directly, the store refuses to put them in the public tree.
  await assert.rejects(
    () => store.writeApprovedDerivative("some/object", Buffer.from([1, 2, 3]), "needs_review"),
    /refusing to publish/,
  );
  await assert.rejects(
    () => store.writeApprovedDerivative("some/object", Buffer.from([1, 2, 3]), "pending"),
    /refusing to publish/,
  );
});

test("V021: the database forbids an erased row from keeping its fingerprint", async () => {
  // Reuse detection filters to active rows. That filter is only redundant
  // because erasure is guaranteed to clear the fingerprint — so the guarantee
  // itself is what needs pinning, not the filter.
  const participant = await newParticipant();
  const reference = await uploadFixture(participant, "png-palette-8x8.png", "image/png", "k7");
  const { evidenceId } = await submissionWith(participant, reference);
  await processing.processEvidence({ evidenceId, purpose: "media pipeline for erasure test" });

  await assert.rejects(
    () =>
      client.query(
        `update evidence_item set privacy_state = 'erased', erased_at = now()
          where evidence_id = $1`,
        [evidenceId],
      ),
    /evidence_item_erased_ck/,
    "an erased row retaining restricted values must be refused by the database",
  );
});
