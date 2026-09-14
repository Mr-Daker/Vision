/**
 * Submission acceptance against the real database (roadmap V018).
 *
 * Run with: npm run db:up && npm run db:migrate && npm run test:db
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
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

const DATABASE_URL =
  process.env["DATABASE_URL"] ??
  "postgresql://vision:vision_local_dev_only@127.0.0.1:5432/vision_dev";

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);

let client: pg.Client;
let storeRoot: string;
let store: FilesystemObjectStoreAdapter;
let service: SubmissionService;
/** Submissions committed by tests, cleaned up at the end. */
const committed: string[] = [];
/** Participants created by tests, cleaned up at the end. */
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
  storeRoot = await mkdtemp(join(tmpdir(), "vision-submissions-"));
  store = new FilesystemObjectStoreAdapter({ root: storeRoot, grantHmacKey: "test-only-key" });
  service = new SubmissionService(client, store, {
    localePackVersion: "demo-locales.v1",
    taxonomyVersion: "demo-taxonomy.v1",
    supportedLocales: ["en-IN", "mr-IN"],
  });
});

after(async () => {
  for (const submissionId of committed) {
    await client.query(
      "delete from outbox where event_id in (select event_id from status_event where aggregate_id = $1)",
      [submissionId],
    );
    await client.query("delete from status_event where aggregate_id = $1", [submissionId]);
    await client.query("delete from evidence_item where submission_id = $1", [submissionId]);
    await client.query("delete from submission where submission_id = $1", [submissionId]);
  }
  // Participants outlive their submissions, so they need removing explicitly.
  // Without this the file leaked a participant per test into the shared dev
  // database, which is the kind of drift that hides real problems.
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

/** Runs a real upload through V016 so the reference is accepted evidence. */
const acceptedUpload = async (owner: string): Promise<string> => {
  const grant = await store.createUploadGrant(
    { intended_content_type: "image/jpeg", max_bytes: 4096, owner_pseudonym: unsafeUuid(owner) },
    mutation("upload-key-v018"),
  );
  if (grant.kind !== "success") throw new Error("grant failed");
  const token = new URL(`http://x${grant.value.upload_url}`).searchParams.get("token")!;
  await store.putStagedObject(grant.value.object_reference, token, JPEG, "image/jpeg");
  const finalized = await store.finalizeUpload(grant.value.object_reference, mutation("fin-v018"));
  if (finalized.kind !== "success") throw new Error("finalize failed");
  return grant.value.object_reference;
};

const inputFor = (participantId: string, objectReference?: string): SubmissionInput => ({
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
  evidence: objectReference === undefined ? [] : [{ objectReference, mediaType: "photo" }],
});

// ---------------------------------------------------------------------------
// Acceptance and the receipt
// ---------------------------------------------------------------------------

test("V018: an accepted submission returns a durable receipt", async () => {
  const participant = await newParticipant();
  const objectReference = await acceptedUpload(participant);

  const result = await service.create(inputFor(participant, objectReference), {
    idempotencyKey: "submission-v018-0001",
    correlationId: randomUUID(),
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  committed.push(result.receipt.submission_id);

  assert.equal(result.receipt.replayed, false);
  assert.equal(result.receipt.processing_status, "received");
  assert.equal(result.receipt.status_url, `/v1/submissions/${result.receipt.submission_id}`);
  assert.ok(result.receipt.server_received_at.endsWith("Z"));

  // The submission, both evidence items, the first event and its work all
  // exist — from one commit.
  const { rows } = await client.query(
    // aggregate_id is text, so it needs an explicit cast when the same
    // parameter is also compared against uuid columns.
    `select (select count(*) from submission where submission_id = $1::uuid)::int as submissions,
            (select count(*) from evidence_item where submission_id = $1::uuid)::int as evidence,
            (select count(*) from status_event where aggregate_id = $1::text)::int as events,
            (select count(*) from outbox o join status_event e on e.event_id = o.event_id
               where e.aggregate_id = $1::text)::int as tasks`,
    [result.receipt.submission_id],
  );
  assert.equal(rows[0].submissions, 1);
  assert.equal(rows[0].evidence, 2, "one text item and one photo item");
  assert.equal(rows[0].events, 1);
  assert.equal(rows[0].tasks, 1, "processing work is queued in the same commit");
});

test("V018: the first event carries no citizen content", async () => {
  const participant = await newParticipant();
  const result = await service.create(inputFor(participant), {
    idempotencyKey: "submission-v018-0002",
    correlationId: randomUUID(),
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  committed.push(result.receipt.submission_id);

  const { rows } = await client.query("select payload from status_event where aggregate_id = $1", [
    result.receipt.submission_id,
  ]);
  const payload = JSON.stringify(rows[0].payload);
  assert.ok(!payload.includes("roof"), "the description must not reach the event payload");
  assert.ok(!payload.includes("74.56"), "coordinates must not reach the event payload");
  assert.match(payload, /evidence_count/);
});

// ---------------------------------------------------------------------------
// Retries return the original receipt
// ---------------------------------------------------------------------------

test("V018: a network retry returns the original receipt, not a second submission", async () => {
  const participant = await newParticipant();
  const key = "submission-v018-retry-01";
  const input = inputFor(participant);

  const first = await service.create(input, { idempotencyKey: key, correlationId: randomUUID() });
  const second = await service.create(input, { idempotencyKey: key, correlationId: randomUUID() });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  committed.push(first.receipt.submission_id);

  assert.equal(second.receipt.submission_id, first.receipt.submission_id);
  assert.equal(second.receipt.replayed, true, "the replay is labelled as such");
  assert.equal(first.receipt.replayed, false);

  const { rows } = await client.query(
    "select count(*)::int as n from submission where participant_id = $1",
    [participant],
  );
  assert.equal(rows[0].n, 1, "a retry must not inflate the number of reports");
});

test("V018: concurrent retries of one request commit exactly one submission", async () => {
  const participant = await newParticipant();
  const key = "submission-v018-race-01";
  const input = inputFor(participant);

  // Two in-flight requests with the same key. A second connection is needed
  // because one client serialises its own transactions.
  const second = new pg.Client({ connectionString: DATABASE_URL });
  await second.connect();
  const rival = new SubmissionService(second, store, {
    localePackVersion: "demo-locales.v1",
    taxonomyVersion: "demo-taxonomy.v1",
    supportedLocales: ["en-IN", "mr-IN"],
  });

  try {
    const results = await Promise.all([
      service.create(input, { idempotencyKey: key, correlationId: randomUUID() }),
      rival.create(input, { idempotencyKey: key, correlationId: randomUUID() }),
    ]);

    const accepted = results.filter((result) => result.ok);
    assert.equal(accepted.length, 2, "both callers get a receipt");

    const ids = new Set(accepted.map((result) => (result.ok ? result.receipt.submission_id : "")));
    assert.equal(ids.size, 1, "both receipts describe the same submission");
    committed.push([...ids][0]!);

    const { rows } = await client.query(
      "select count(*)::int as n from submission where participant_id = $1",
      [participant],
    );
    assert.equal(rows[0].n, 1);
  } finally {
    await second.end();
  }
});

test("V018: the same key from a different participant is a different report", async () => {
  const a = await newParticipant();
  const b = await newParticipant();
  const key = "client-generated-key-v018";

  const first = await service.create(inputFor(a), {
    idempotencyKey: key,
    correlationId: randomUUID(),
  });
  const secondResult = await service.create(inputFor(b), {
    idempotencyKey: key,
    correlationId: randomUUID(),
  });

  assert.equal(first.ok, true);
  assert.equal(secondResult.ok, true);
  if (!first.ok || !secondResult.ok) return;
  committed.push(first.receipt.submission_id, secondResult.receipt.submission_id);
  assert.notEqual(secondResult.receipt.submission_id, first.receipt.submission_id);
});

// ---------------------------------------------------------------------------
// A failed commit is never a successful report
// ---------------------------------------------------------------------------

test("V018: a failed commit leaves no submission and no receipt", async () => {
  const participant = await newParticipant();
  const input = inputFor(participant);

  // Force the event insert to collide by pre-claiming the aggregate version
  // this submission will try to write. The submission insert succeeds, then
  // the event insert fails, so the whole transaction must roll back.
  const failing = new SubmissionService(
    {
      query: async (sql: string, values?: readonly unknown[]) => {
        if (sql.includes("insert into status_event")) {
          throw new Error("simulated failure after the submission insert");
        }
        const result = await client.query(sql, values === undefined ? undefined : [...values]);
        return { rows: result.rows as Record<string, unknown>[], rowCount: result.rowCount };
      },
    },
    store,
    {
      localePackVersion: "demo-locales.v1",
      taxonomyVersion: "demo-taxonomy.v1",
      supportedLocales: ["en-IN", "mr-IN"],
    },
  );

  await assert.rejects(
    () =>
      failing.create(input, {
        idempotencyKey: "submission-v018-fail",
        correlationId: randomUUID(),
      }),
    /simulated failure/,
    "a failed commit must surface as an error, never as a receipt",
  );

  const { rows } = await client.query(
    "select count(*)::int as n from submission where participant_id = $1",
    [participant],
  );
  assert.equal(rows[0].n, 0, "no partially-created report may survive");
});

// ---------------------------------------------------------------------------
// Discoverability during a worker outage
// ---------------------------------------------------------------------------

test("V018: a saved submission stays discoverable while the worker is down", async () => {
  const participant = await newParticipant();
  const result = await service.create(inputFor(participant), {
    idempotencyKey: "submission-v018-outage",
    correlationId: randomUUID(),
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  committed.push(result.receipt.submission_id);

  // Simulate a total worker outage: the queued work is never claimed and the
  // submission stays in 'received'. The receipt must still read.
  const receipt = await service.readReceipt(result.receipt.submission_id, participant);
  assert.ok(receipt);
  assert.equal(receipt.processing_status, "received");
  assert.equal(receipt.submission_id, result.receipt.submission_id);

  const { rows } = await client.query(
    `select count(*)::int as pending from outbox o join status_event e on e.event_id = o.event_id
      where e.aggregate_id = $1 and o.delivered_at is null`,
    [result.receipt.submission_id],
  );
  assert.equal(rows[0].pending, 1, "the work is still owed, and visibly so");
});

test("V018: a receipt is readable only by its own participant", async () => {
  const owner = await newParticipant();
  const stranger = await newParticipant();
  const result = await service.create(inputFor(owner), {
    idempotencyKey: "submission-v018-owner",
    correlationId: randomUUID(),
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  committed.push(result.receipt.submission_id);

  assert.ok(await service.readReceipt(result.receipt.submission_id, owner));
  assert.equal(
    await service.readReceipt(result.receipt.submission_id, stranger),
    undefined,
    "another participant must not read this receipt",
  );
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test("V018: invalid input is rejected before anything is written", async () => {
  const participant = await newParticipant();

  const cases: readonly {
    readonly label: string;
    readonly input: SubmissionInput;
    readonly field: string;
  }[] = [
    {
      label: "longitude out of range",
      input: {
        ...inputFor(participant),
        observed: { ...inputFor(participant).observed, lon: 361 },
      },
      field: "observed.lon",
    },
    {
      label: "latitude out of range",
      input: {
        ...inputFor(participant),
        observed: { ...inputFor(participant).observed, lat: -95 },
      },
      field: "observed.lat",
    },
    {
      label: "negative accuracy",
      input: {
        ...inputFor(participant),
        observed: { ...inputFor(participant).observed, accuracyMetres: -4 },
      },
      field: "observed.accuracy_m",
    },
    {
      label: "unsupported locale",
      input: { ...inputFor(participant), interfaceLocale: "fr-FR" },
      field: "interface_locale",
    },
    {
      label: "no observation at all",
      input: { ...inputFor(participant), text: "", evidence: [] },
      field: "evidence",
    },
    {
      label: "oversized description",
      input: { ...inputFor(participant), text: "x".repeat(5000) },
      field: "text",
    },
    {
      label: "unfinalized upload reference",
      input: {
        ...inputFor(participant),
        evidence: [{ objectReference: "2026-09/never-uploaded", mediaType: "photo" }],
      },
      field: "evidence[0].object_reference",
    },
  ];

  for (const testCase of cases) {
    const result = await service.create(testCase.input, {
      idempotencyKey: `submission-v018-invalid-${testCase.field}`,
      correlationId: randomUUID(),
    });
    assert.equal(result.ok, false, `${testCase.label} must be rejected`);
    if (!result.ok && result.code === "validation_failed") {
      assert.ok(
        result.issues.some((issue) => issue.field === testCase.field),
        `${testCase.label}: expected an issue on ${testCase.field}, got ${result.issues.map((i) => i.field).join(", ")}`,
      );
    }
  }

  const { rows } = await client.query(
    "select count(*)::int as n from submission where participant_id = $1",
    [participant],
  );
  assert.equal(rows[0].n, 0, "no invalid request may create a row");
});

test("V018: a malformed idempotency key is refused", async () => {
  const participant = await newParticipant();
  const result = await service.create(inputFor(participant), {
    idempotencyKey: "short",
    correlationId: randomUUID(),
  });
  assert.equal(result.ok, false);
  if (!result.ok && result.code === "validation_failed") {
    assert.ok(result.issues.some((issue) => issue.field === "idempotency_key"));
  }
});

test("V018: a manually dropped pin is recorded as distinct from captured location", async () => {
  const participant = await newParticipant();
  const base = inputFor(participant);
  const { accuracyMetres: _noDeviceReading, ...observedWithoutAccuracy } = base.observed;
  const result = await service.create(
    {
      ...base,
      observed: { ...observedWithoutAccuracy, source: "manual_pin" },
    },
    { idempotencyKey: "submission-v018-pin", correlationId: randomUUID() },
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  committed.push(result.receipt.submission_id);

  const { rows } = await client.query(
    "select observed_location_source, observed_accuracy_m from submission where submission_id = $1",
    [result.receipt.submission_id],
  );
  assert.equal(
    rows[0].observed_location_source,
    "manual_pin",
    "a claimed pin must never be stored as captured location evidence",
  );
  assert.equal(
    rows[0].observed_accuracy_m,
    null,
    "a typed position has no device accuracy; 0 would read as a perfect measurement",
  );
});

test("V018: a typed position may not carry a device accuracy", async () => {
  const participant = await newParticipant();
  const base = inputFor(participant);
  const result = await service.create(
    { ...base, observed: { ...base.observed, source: "manual_pin", accuracyMetres: 3 } },
    { idempotencyKey: "submission-v018-pin-accuracy", correlationId: randomUUID() },
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "validation_failed");
  assert.ok(
    result.issues.some(
      (issue) => issue.field === "observed.accuracy_m" && issue.code === "not_applicable",
    ),
    "a client must not be able to dress a typed guess up as a measurement",
  );
});

test("V018: a device-reported position must state its accuracy", async () => {
  const participant = await newParticipant();
  const base = inputFor(participant);
  const { accuracyMetres: _omitted, ...observedWithoutAccuracy } = base.observed;
  const result = await service.create(
    { ...base, observed: { ...observedWithoutAccuracy, source: "device_geolocation" } },
    { idempotencyKey: "submission-v018-no-accuracy", correlationId: randomUUID() },
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "validation_failed");
  assert.ok(
    result.issues.some(
      (issue) => issue.field === "observed.accuracy_m" && issue.code === "required",
    ),
  );
});
