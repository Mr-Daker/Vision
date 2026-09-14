import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  newCorrelationId,
  unsafeIdempotencyKey,
  unsafeIdempotencyScope,
  unsafeRequestFingerprint,
  unsafeTimestamp,
  unsafeUuid,
  type IsoTimestamp,
  type MutationAdapterCallContext,
} from "@vision/contracts";

import {
  FilesystemObjectStoreAdapter,
  MAX_OBJECT_BYTES,
  ObjectStoreError,
  grantOriginalAccess,
} from "./object-store.ts";

const OWNER = unsafeUuid("6ba7b810-9dad-41d1-80b4-00c04fd430c8");
const OTHER_OWNER = unsafeUuid("6ba7b811-9dad-41d1-80b4-00c04fd430c8");

const mutation = (key: string): MutationAdapterCallContext => ({
  correlation_id: newCorrelationId(),
  idempotency_key: unsafeIdempotencyKey(key),
  idempotency_scope: unsafeIdempotencyScope("citizen:demo:uploads.create"),
  request_fingerprint: unsafeRequestFingerprint(`sha256:${"a".repeat(64)}`),
});

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 3),
]);
const WEBM_AUDIO = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(32, 1)]);

/** Controllable clock so grant expiry and staging TTL are testable. */
const makeClock = (startIso: string) => {
  let current = Date.parse(startIso);
  return {
    now: (): IsoTimestamp => new Date(current).toISOString() as IsoTimestamp,
    advanceSeconds: (s: number): void => {
      current += s * 1000;
    },
  };
};

const setup = async (startIso = "2026-09-09T10:00:00.000Z") => {
  const root = await mkdtemp(join(tmpdir(), "vision-objstore-"));
  const clock = makeClock(startIso);
  const store = new FilesystemObjectStoreAdapter(
    { root, grantHmacKey: "test-only-grant-key", grantTtlSeconds: 900 },
    clock.now,
  );
  return { root, clock, store, cleanup: () => rm(root, { recursive: true, force: true }) };
};

/** Issues a grant and returns its reference plus the bound token. */
const grantFor = async (
  store: FilesystemObjectStoreAdapter,
  contentType = "image/jpeg",
  maxBytes = 1024,
  owner = OWNER,
) => {
  const outcome = await store.createUploadGrant(
    { intended_content_type: contentType, max_bytes: maxBytes, owner_pseudonym: owner },
    mutation("upload-key-0001"),
  );
  assert.equal(outcome.kind, "success");
  if (outcome.kind !== "success") throw new Error("grant failed");
  const token = new URL(`http://x${outcome.value.upload_url}`).searchParams.get("token");
  assert.ok(token);
  return { grant: outcome.value, token };
};

// ---------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------

test("V016: an authorized upload completes and becomes private accepted evidence", async () => {
  const { store, cleanup } = await setup();
  try {
    const { grant, token } = await grantFor(store);

    const put = await store.putStagedObject(grant.object_reference, token, JPEG, "image/jpeg");
    assert.equal(put.ok, true);
    assert.equal(await store.hasStagedObject(grant.object_reference), true);
    assert.equal(await store.hasAcceptedEvidence(grant.object_reference), false);

    const finalized = await store.finalizeUpload(grant.object_reference, mutation("finalize-0001"));
    assert.equal(finalized.kind, "success");
    if (finalized.kind === "success") {
      assert.equal(finalized.value.byte_size, JPEG.byteLength);
      assert.equal(finalized.value.content_type, "image/jpeg");
    }

    // The bytes moved out of staging into the private originals tree.
    assert.equal(await store.hasStagedObject(grant.object_reference), false);
    assert.equal(await store.hasAcceptedEvidence(grant.object_reference), true);
    assert.equal(store.isUploadOwnedBy(grant.object_reference, OWNER), true);
    assert.equal(store.isUploadOwnedBy(grant.object_reference, OTHER_OWNER), false);
    assert.equal(await store.hasAcceptedEvidenceOwnedBy(grant.object_reference, OWNER), true);
    assert.equal(
      await store.hasAcceptedEvidenceOwnedBy(grant.object_reference, OTHER_OWNER),
      false,
    );
    assert.match(store.fingerprintOf(grant.object_reference) ?? "", /^[0-9a-f]{64}$/);

    const counts = await store.treeCounts();
    assert.equal(counts["originals"], 1);
    assert.equal(counts["staging"], 0);
    assert.equal(counts["derivatives"], 0, "no derivative exists until one is approved");
  } finally {
    await cleanup();
  }
});

test("V016: object paths are unique and not caller-supplied", async () => {
  const { store, cleanup } = await setup();
  try {
    const a = await grantFor(store);
    const b = await grantFor(store);
    assert.notEqual(a.grant.object_reference, b.grant.object_reference);
    // Date-partitioned + random, so a caller cannot predict or choose a path.
    assert.match(a.grant.object_reference, /^\d{4}-\d{2}\/[0-9a-f-]{36}$/);
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// "uploads only to its assigned object"
// ---------------------------------------------------------------------------

test("V016: a grant token cannot be used against a different object", async () => {
  const { store, cleanup } = await setup();
  try {
    const mine = await grantFor(store);
    const someoneElse = await grantFor(store, "image/jpeg", 1024, OTHER_OWNER);

    // Presenting my token against another granted object must fail.
    const crossWrite = await store.putStagedObject(
      someoneElse.grant.object_reference,
      mine.token,
      JPEG,
      "image/jpeg",
    );
    assert.equal(crossWrite.ok, false);
    if (!crossWrite.ok) assert.equal(crossWrite.reason, "grant_token_mismatch");
    assert.equal(await store.hasStagedObject(someoneElse.grant.object_reference), false);
  } finally {
    await cleanup();
  }
});

test("V016: writing to an ungranted object reference fails", async () => {
  const { store, cleanup } = await setup();
  try {
    const { token } = await grantFor(store);
    const result = await store.putStagedObject(
      "2026-09/not-a-granted-object",
      token,
      JPEG,
      "image/jpeg",
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "no_grant_for_object");
  } finally {
    await cleanup();
  }
});

test("V016: a path-traversal reference is refused by the storage layer", async () => {
  const { store, cleanup } = await setup();
  try {
    await assert.rejects(
      () => store.hasAcceptedEvidence("../../etc/passwd"),
      ObjectStoreError,
      "a reference escaping the tree must be refused, not resolved",
    );
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// Forged completion
// ---------------------------------------------------------------------------

test("V016: a forged completion creates no accepted evidence", async () => {
  const { store, cleanup } = await setup();
  try {
    const outcome = await store.finalizeUpload("2026-09/never-granted", mutation("forged-0001"));
    assert.equal(outcome.kind, "rejected");
    if (outcome.kind === "rejected") assert.equal(outcome.reason_code, "no_grant_for_object");
    assert.equal(await store.hasAcceptedEvidence("2026-09/never-granted"), false);
  } finally {
    await cleanup();
  }
});

test("V016: claiming completion without uploading bytes is refused", async () => {
  const { store, cleanup } = await setup();
  try {
    const { grant } = await grantFor(store);
    const outcome = await store.finalizeUpload(grant.object_reference, mutation("finalize-0002"));
    assert.equal(outcome.kind, "rejected");
    if (outcome.kind === "rejected") assert.equal(outcome.reason_code, "no_staged_object");
    assert.equal(await store.hasAcceptedEvidence(grant.object_reference), false);
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// Oversized content
// ---------------------------------------------------------------------------

test("V016: oversized content is refused at write time and never persisted", async () => {
  const { store, cleanup } = await setup();
  try {
    const { grant, token } = await grantFor(store, "image/jpeg", 128);
    const tooBig = Buffer.concat([JPEG, Buffer.alloc(512, 9)]);

    const put = await store.putStagedObject(grant.object_reference, token, tooBig, "image/jpeg");
    assert.equal(put.ok, false);
    if (!put.ok) assert.equal(put.reason, "oversized_content");

    assert.equal(await store.hasStagedObject(grant.object_reference), false);
    assert.equal(await store.hasAcceptedEvidence(grant.object_reference), false);
  } finally {
    await cleanup();
  }
});

test("V016: a grant cannot exceed the hard size ceiling", async () => {
  const { store, cleanup } = await setup();
  try {
    const outcome = await store.createUploadGrant(
      {
        intended_content_type: "image/jpeg",
        max_bytes: MAX_OBJECT_BYTES + 1,
        owner_pseudonym: OWNER,
      },
      mutation("upload-key-0002"),
    );
    assert.equal(outcome.kind, "rejected");
    if (outcome.kind === "rejected") assert.equal(outcome.reason_code, "invalid_size_limit");
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// Mismatched metadata
// ---------------------------------------------------------------------------

test("V016: bytes that disagree with the declared type are quarantined, not accepted", async () => {
  const { store, cleanup } = await setup();
  try {
    const { grant, token } = await grantFor(store, "image/jpeg", 1024);

    // The client declares JPEG (matching its grant) but sends PNG bytes.
    const put = await store.putStagedObject(grant.object_reference, token, PNG, "image/jpeg");
    assert.equal(put.ok, true, "the lie is only detectable at completion, by inspecting bytes");

    const finalized = await store.finalizeUpload(grant.object_reference, mutation("finalize-0003"));
    assert.equal(finalized.kind, "rejected");
    if (finalized.kind === "rejected") {
      assert.equal(finalized.reason_code, "content_metadata_mismatch");
      assert.match(finalized.detail, /declared 'image\/jpeg' but the bytes are image\/png/);
    }

    // Isolated for review, and definitively not accepted evidence.
    assert.equal(await store.hasAcceptedEvidence(grant.object_reference), false);
    const counts = await store.treeCounts();
    assert.equal(counts["quarantine"], 1);
    assert.equal(counts["originals"], 0);
  } finally {
    await cleanup();
  }
});

test("V016: unrecognised content is quarantined", async () => {
  const { store, cleanup } = await setup();
  try {
    const { grant, token } = await grantFor(store, "image/jpeg", 1024);
    await store.putStagedObject(
      grant.object_reference,
      token,
      Buffer.from("not an image"),
      "image/jpeg",
    );

    const finalized = await store.finalizeUpload(grant.object_reference, mutation("finalize-0004"));
    assert.equal(finalized.kind, "rejected");
    assert.equal(await store.hasAcceptedEvidence(grant.object_reference), false);
    assert.equal((await store.treeCounts())["quarantine"], 1);
  } finally {
    await cleanup();
  }
});

test("V016: declaring a type other than the granted one is refused", async () => {
  const { store, cleanup } = await setup();
  try {
    const { grant, token } = await grantFor(store, "image/jpeg", 1024);
    const put = await store.putStagedObject(grant.object_reference, token, PNG, "image/png");
    assert.equal(put.ok, false);
    if (!put.ok) assert.equal(put.reason, "declared_content_type_mismatch");
  } finally {
    await cleanup();
  }
});

test("V016: an unsupported content type never gets a grant", async () => {
  const { store, cleanup } = await setup();
  try {
    for (const type of ["application/pdf", "video/mp4", "text/html"]) {
      const outcome = await store.createUploadGrant(
        { intended_content_type: type, max_bytes: 1024, owner_pseudonym: OWNER },
        mutation("upload-key-0003"),
      );
      assert.equal(outcome.kind, "rejected", `${type} must not be granted`);
    }
    // Voice is supported, since the citizen flow accepts recorded audio.
    const audio = await grantFor(store, "audio/webm", 1024);
    const put = await store.putStagedObject(
      audio.grant.object_reference,
      audio.token,
      WEBM_AUDIO,
      "audio/webm",
    );
    assert.equal(put.ok, true);
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// Unauthorized reads
// ---------------------------------------------------------------------------

test("V016: a private original cannot be read without audited access", async () => {
  const { store, cleanup } = await setup();
  try {
    const { grant, token } = await grantFor(store);
    await store.putStagedObject(grant.object_reference, token, JPEG, "image/jpeg");
    await store.finalizeUpload(grant.object_reference, mutation("finalize-0005"));

    // A routine allowed decision is not enough: it must be audited access.
    assert.throws(
      () => grantOriginalAccess({ allowed: true, auditRequired: false }, "just looking"),
      /must be audited/,
    );
    // A denied decision cannot be laundered into a grant.
    assert.throws(
      () => grantOriginalAccess({ allowed: false, reason: "out of scope" }, "reviewing evidence"),
      /allowed decision/,
    );
    // Even audited access needs a recorded purpose.
    assert.throws(
      () => grantOriginalAccess({ allowed: true, auditRequired: true }, "x"),
      /purpose/,
    );

    // With a proper grant, the read succeeds.
    const access = grantOriginalAccess(
      { allowed: true, auditRequired: true },
      "citizen disputes the redaction accuracy",
    );
    const bytes = await store.readOriginal(grant.object_reference, access);
    assert.equal(bytes.byteLength, JPEG.byteLength);
  } finally {
    await cleanup();
  }
});

test("V016: a derivative is only published with an approved redaction decision", async () => {
  const { store, cleanup } = await setup();
  try {
    const { grant, token } = await grantFor(store);
    await store.putStagedObject(grant.object_reference, token, JPEG, "image/jpeg");
    await store.finalizeUpload(grant.object_reference, mutation("finalize-0006"));

    for (const status of ["pending", "needs_review"] as const) {
      await assert.rejects(
        () => store.writeApprovedDerivative(grant.object_reference, JPEG, status),
        ObjectStoreError,
        `redaction_status '${status}' must not publish`,
      );
    }
    assert.equal((await store.treeCounts())["derivatives"], 0);

    const reference = await store.writeApprovedDerivative(grant.object_reference, JPEG, "approved");
    assert.match(reference, /^derivatives\//);
    assert.equal((await store.treeCounts())["derivatives"], 1);
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// Expiry, replay and cleanup
// ---------------------------------------------------------------------------

test("V016: an expired grant cannot be used or completed", async () => {
  const { store, clock, cleanup } = await setup();
  try {
    const { grant, token } = await grantFor(store);
    await store.putStagedObject(grant.object_reference, token, JPEG, "image/jpeg");

    clock.advanceSeconds(901);

    const put = await store.putStagedObject(grant.object_reference, token, JPEG, "image/jpeg");
    assert.equal(put.ok, false);
    if (!put.ok) assert.equal(put.reason, "grant_expired");

    const finalized = await store.finalizeUpload(grant.object_reference, mutation("finalize-0007"));
    assert.equal(finalized.kind, "rejected");
    if (finalized.kind === "rejected") assert.equal(finalized.reason_code, "grant_expired");
    assert.equal(await store.hasAcceptedEvidence(grant.object_reference), false);
    assert.equal((await store.treeCounts())["quarantine"], 1, "expired bytes are isolated");
  } finally {
    await cleanup();
  }
});

test("V016: replayed completion returns the committed result, not a second object", async () => {
  const { store, cleanup } = await setup();
  try {
    const { grant, token } = await grantFor(store);
    await store.putStagedObject(grant.object_reference, token, JPEG, "image/jpeg");

    const first = await store.finalizeUpload(grant.object_reference, mutation("finalize-0008"));
    const second = await store.finalizeUpload(grant.object_reference, mutation("finalize-0008"));

    assert.equal(first.kind, "success");
    assert.equal(second.kind, "duplicate");
    if (first.kind === "success" && second.kind === "duplicate") {
      assert.deepEqual(second.existing_value, first.value);
    }
    assert.equal((await store.treeCounts())["originals"], 1);

    // A finalized object cannot be overwritten.
    const overwrite = await store.putStagedObject(grant.object_reference, token, PNG, "image/jpeg");
    assert.equal(overwrite.ok, false);
    if (!overwrite.ok) assert.equal(overwrite.reason, "object_already_finalized");
  } finally {
    await cleanup();
  }
});

test("V016: incomplete uploads are cleaned up and accepted evidence is not", async () => {
  const { store, clock, cleanup } = await setup();
  try {
    const abandoned = await grantFor(store);
    await store.putStagedObject(
      abandoned.grant.object_reference,
      abandoned.token,
      JPEG,
      "image/jpeg",
    );

    const completed = await grantFor(store);
    await store.putStagedObject(
      completed.grant.object_reference,
      completed.token,
      JPEG,
      "image/jpeg",
    );
    await store.finalizeUpload(completed.grant.object_reference, mutation("finalize-0009"));

    assert.equal((await store.treeCounts())["staging"], 1);

    // Past the grant TTL, the abandoned upload is collectable.
    clock.advanceSeconds(901);
    const removed = await store.cleanupExpiredStaging();
    assert.deepEqual([...removed], [abandoned.grant.object_reference]);

    const counts = await store.treeCounts();
    assert.equal(counts["staging"], 0, "no incomplete upload is retained");
    assert.equal(counts["originals"], 1, "accepted evidence survives cleanup");
    assert.equal(await store.hasAcceptedEvidence(completed.grant.object_reference), true);
  } finally {
    await cleanup();
  }
});

test("V016: the store refuses to run without a grant key", async () => {
  const { root, cleanup } = await setup();
  try {
    assert.throws(
      () => new FilesystemObjectStoreAdapter({ root, grantHmacKey: "" }),
      ObjectStoreError,
    );
  } finally {
    await cleanup();
  }
});

test("V016: the capability is labelled simulated and claims nothing about authenticity", () => {
  const store = new FilesystemObjectStoreAdapter({ root: tmpdir(), grantHmacKey: "k" });
  const capability = store.descriptor.capability;
  assert.match(capability.display_label, /simulated/i);
  assert.ok(capability.must_not_claim.some((claim) => /authentic/i.test(claim)));
  assert.equal(unsafeTimestamp("2026-09-09T10:00:00Z").length > 0, true);
});
