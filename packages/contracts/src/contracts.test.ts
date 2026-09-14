import { test } from "node:test";
import assert from "node:assert/strict";

import { CONTRACT_FIXTURES, recipientDeliveryFixtures } from "./fixtures.ts";
import { OUTCOME_KINDS, carriesExternalAuthority, isSuccess } from "./outcomes.ts";
import { ERROR_STATUS } from "./errors.ts";
import { findForbiddenPayloadKeys, type MutationRequestEnvelope } from "./envelope.ts";
import { findUnlabelledSimulations } from "./capability.ts";
import { isIngestible, type MutationAdapterCallContext } from "./adapters.ts";
import {
  CONTRACT_VERSION,
  newCorrelationId,
  parseBcp47,
  parseIdempotencyKey,
  parseIdempotencyScope,
  parseIsoTimestamp,
  parseRequestFingerprint,
  parseUuid,
  unsafeIdempotencyKey,
  unsafeIdempotencyScope,
  unsafeRequestFingerprint,
  unsafeTimestamp,
  unsafeUuid,
} from "./primitives.ts";

// This compile-time assertion guards the required mutation binding. If the
// fields ever become optional, TypeScript reports an unused @ts-expect-error.
// @ts-expect-error mutation calls require an idempotency key, scope and request fingerprint
const incompleteMutationContext: MutationAdapterCallContext = {
  correlation_id: newCorrelationId(),
};
void incompleteMutationContext;

test("every adapter capability has a fixture for all six outcome kinds", () => {
  const capabilities = Object.keys(CONTRACT_FIXTURES);
  assert.ok(capabilities.length >= 7, "expected a fixture set per adapter capability");

  for (const [capability, outcomes] of Object.entries(CONTRACT_FIXTURES)) {
    for (const kind of OUTCOME_KINDS) {
      const outcome = outcomes[kind];
      assert.ok(outcome, `${capability} is missing a '${kind}' fixture`);
      assert.equal(outcome.kind, kind, `${capability}.${kind} declares the wrong kind`);
    }
  }
});

test("recipient delivery has a fixture for all six outcome kinds", () => {
  for (const kind of OUTCOME_KINDS) {
    const outcome = recipientDeliveryFixtures[kind];
    assert.ok(outcome, `recipient delivery is missing a '${kind}' fixture`);
    assert.equal(outcome.kind, kind);
    assert.equal(outcome.provenance.authenticity, "simulated_fixture");
    assert.equal(carriesExternalAuthority(outcome.provenance), false);
  }
});

test("mutation request envelopes carry a complete retry binding", () => {
  const envelope: MutationRequestEnvelope<{ readonly operation: string }> = {
    contract_version: CONTRACT_VERSION,
    correlation_id: newCorrelationId(),
    idempotency_key: unsafeIdempotencyKey("mutation-request-key-001"),
    idempotency_scope: unsafeIdempotencyScope("citizen:fixture:recipient.deliver"),
    request_fingerprint: unsafeRequestFingerprint(`sha256:${"b".repeat(64)}`),
    body: { operation: "deliver" },
  };

  assert.ok(envelope.idempotency_key.length > 0);
  assert.match(envelope.idempotency_scope, /recipient\.deliver$/);
  assert.match(envelope.request_fingerprint, /^sha256:[0-9a-f]{64}$/);
});

test("no fixture can claim external authority", () => {
  for (const [capability, outcomes] of Object.entries(CONTRACT_FIXTURES)) {
    for (const kind of OUTCOME_KINDS) {
      const outcome = outcomes[kind]!;
      assert.equal(
        outcome.provenance.authenticity,
        "simulated_fixture",
        `${capability}.${kind} must be labelled as a simulated fixture`,
      );
      assert.equal(
        carriesExternalAuthority(outcome.provenance),
        false,
        `${capability}.${kind} must not carry external authority`,
      );
    }
  }
});

test("duplicate is not treated as success", () => {
  const duplicate = CONTRACT_FIXTURES.citizen_identity.duplicate;
  assert.equal(isSuccess(duplicate), false);
});

test("ambiguous outcomes always require review", () => {
  for (const outcomes of Object.values(CONTRACT_FIXTURES)) {
    const ambiguous = outcomes.ambiguous;
    assert.equal(ambiguous.kind, "ambiguous");
    if (ambiguous.kind === "ambiguous") {
      assert.equal(ambiguous.requires_review, true);
    }
  }
});

test("unavailable is retryable and rejected is not", () => {
  const unavailable = CONTRACT_FIXTURES.task_delivery.unavailable;
  const rejected = CONTRACT_FIXTURES.task_delivery.rejected;
  assert.equal(unavailable.kind === "unavailable" && unavailable.retryable, true);
  assert.equal(rejected.kind === "rejected" && rejected.retryable, false);
});

test("identifier validators reject malformed input", () => {
  assert.equal(parseUuid("not-a-uuid").ok, false);
  assert.equal(parseUuid("6ba7b810-9dad-41d1-80b4-00c04fd430c8").ok, true);

  assert.equal(parseBcp47("english").ok, false);
  assert.equal(parseBcp47("mr-IN").ok, true);
  assert.equal(parseBcp47("en-IN").ok, true);

  assert.equal(parseIdempotencyKey("short").ok, false);
  assert.equal(parseIdempotencyKey("has spaces and!").ok, false);
  assert.equal(parseIdempotencyKey("submission-2026-09-09-0001").ok, true);

  assert.equal(parseIdempotencyScope("citizen:abc:recipient.deliver").ok, true);
  assert.equal(parseIdempotencyScope("contains spaces").ok, false);

  assert.equal(parseRequestFingerprint(`sha256:${"a".repeat(64)}`).ok, true);
  assert.equal(parseRequestFingerprint("sha256:not-a-digest").ok, false);
});

test("timestamps require a complete RFC 3339 date-time and a real calendar date", () => {
  assert.equal(parseIsoTimestamp("2026-09-09T10:00:00").ok, false, "local time must be rejected");
  assert.equal(parseIsoTimestamp("2026-09-09T10:00:00Z").ok, true);
  assert.equal(parseIsoTimestamp("2026-09-09T15:30:00+05:30").ok, true);
  assert.equal(parseIsoTimestamp("2024-02-29T23:59:59.123456Z").ok, true);

  assert.equal(parseIsoTimestamp("2026-02-29T10:00:00Z").ok, false, "non-leap day");
  assert.equal(parseIsoTimestamp("2026-02-30T10:00:00Z").ok, false, "impossible date");
  assert.equal(parseIsoTimestamp("2026-09-09Z").ok, false, "date-only values are not instants");
  assert.equal(
    parseIsoTimestamp("09 Sep 2026 10:00:00 Z").ok,
    false,
    "implementation-specific Date.parse formats must be rejected",
  );
  assert.equal(parseIsoTimestamp("2026-09-09 10:00:00Z").ok, false, "space is not RFC 3339 T");
  assert.equal(parseIsoTimestamp("2026-09-09T10:00:60Z").ok, false, "leap seconds unsupported");
  assert.equal(parseIsoTimestamp("2026-09-09T10:00:00+24:00").ok, false, "invalid offset");
});

test("event payload guard finds restricted keys", () => {
  assert.deepEqual(findForbiddenPayloadKeys({ issue_id: "x", reason_code: "y" }), []);

  const violations = findForbiddenPayloadKeys({
    issue_id: "x",
    transcript_text: "should never be here",
    session_token: "nope",
  });
  assert.ok(violations.includes("transcript_text"));
  assert.ok(violations.includes("session_token"));
});

test("every error code maps to an HTTP status", () => {
  for (const [code, status] of Object.entries(ERROR_STATUS)) {
    assert.ok(status >= 400 && status <= 599, `${code} maps to a non-error status`);
  }
});

test("capability metadata guard flags an unlabelled simulation", () => {
  const unlabelled = findUnlabelledSimulations({
    contract_version: "1.0.0",
    generated_at: unsafeTimestamp("2026-09-09T10:00:00Z"),
    capabilities: [
      {
        capability: "citizen_identity",
        provider_name: "simulated-identity",
        provider_mode: "simulated",
        display_label: "Identity verified",
        v002_row: 1,
        may_claim: [],
        must_not_claim: [],
      },
    ],
  });
  assert.deepEqual(unlabelled, ["citizen_identity"]);
});

test("reference-only and unavailable sources are never ingestible", () => {
  const shared = {
    source_record_id: unsafeUuid("6ba7b812-9dad-41d1-80b4-00c04fd430c8"),
    source_name: "Local Government Directory",
    source_url_or_location: "https://lgdirectory.gov.in/",
    retrieved_at: unsafeTimestamp("2026-09-09T10:00:00Z"),
  };

  assert.equal(
    isIngestible({
      ...shared,
      licence_or_permission_status: "reference_only",
      demo_status: "unavailable_not_approved",
    }),
    false,
  );
  assert.equal(
    isIngestible({
      ...shared,
      licence_or_permission_status: "unavailable",
      demo_status: "unavailable_not_approved",
    }),
    false,
  );
  assert.equal(
    isIngestible({
      ...shared,
      licence_or_permission_status: "synthetic",
      demo_status: "team_created_synthetic",
    }),
    true,
  );
});
