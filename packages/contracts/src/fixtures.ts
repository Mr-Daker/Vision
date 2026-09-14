/**
 * Contract fixtures (roadmap V008 "done when").
 *
 * Every adapter capability has a fixture for all six outcome kinds: success,
 * unavailable, pending, rejected, duplicate and ambiguous. The completeness of
 * this table is asserted by a test rather than trusted, and every fixture
 * carries simulated provenance — a fixture can never claim external authority.
 */

import type { AdapterOutcome, OutcomeKind, SimulatedProvenance } from "./outcomes.ts";
import type { CapabilityId } from "./capability.ts";
import {
  unsafeBcp47,
  unsafeCorrelationId,
  unsafeTimestamp,
  unsafeUuid,
  type CorrelationId,
} from "./primitives.ts";

const FIXTURE_TIME = unsafeTimestamp("2026-09-09T10:00:00Z");
const FIXTURE_CORRELATION: CorrelationId = unsafeCorrelationId(
  "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
);
const FIXTURE_ISSUE = unsafeUuid("6ba7b810-9dad-41d1-80b4-00c04fd430c8");
const FIXTURE_DELIVERY = unsafeUuid("6ba7b811-9dad-41d1-80b4-00c04fd430c8");
const FIXTURE_SOURCE = unsafeUuid("6ba7b812-9dad-41d1-80b4-00c04fd430c8");
const FIXTURE_OWNER = unsafeUuid("6ba7b813-9dad-41d1-80b4-00c04fd430c8");

export const simulatedProvenance = (
  providerName: string,
  fixtureId: string,
): SimulatedProvenance => ({
  provider_mode: "simulated",
  authenticity: "simulated_fixture",
  provider_name: providerName,
  observed_at: FIXTURE_TIME,
  fixture_id: fixtureId,
});

const base = (providerName: string, fixtureId: string) => ({
  provenance: simulatedProvenance(providerName, fixtureId),
  correlation_id: FIXTURE_CORRELATION,
});

/** Builds the five non-success outcomes, which are identical in shape per adapter. */
const nonSuccessOutcomes = <T>(
  providerName: string,
  prefix: string,
  candidates: readonly T[],
  existing?: T,
): Record<Exclude<OutcomeKind, "success">, AdapterOutcome<T>> => ({
  unavailable: {
    kind: "unavailable",
    reason_code: "provider_unreachable",
    retryable: true,
    retry_after_ms: 2_000,
    ...base(providerName, `${prefix}.unavailable`),
  },
  pending: {
    kind: "pending",
    reason_code: "awaiting_provider_decision",
    poll_reference: `${prefix}-poll-001`,
    ...base(providerName, `${prefix}.pending`),
  },
  rejected: {
    kind: "rejected",
    reason_code: "provider_refused_request",
    retryable: false,
    detail: "the provider refused this request and retrying it unchanged will not help",
    ...base(providerName, `${prefix}.rejected`),
  },
  duplicate: {
    kind: "duplicate",
    reason_code: "already_processed_idempotency_key",
    ...(existing === undefined ? {} : { existing_value: existing }),
    ...base(providerName, `${prefix}.duplicate`),
  },
  ambiguous: {
    kind: "ambiguous",
    reason_code: "requires_human_decision",
    candidates,
    requires_review: true,
    ...base(providerName, `${prefix}.ambiguous`),
  },
});

const buildFixtureSet = <T>(
  providerName: string,
  prefix: string,
  successValue: T,
  candidates: readonly T[],
): Record<OutcomeKind, AdapterOutcome<T>> => ({
  success: {
    kind: "success",
    value: successValue,
    ...base(providerName, `${prefix}.success`),
  },
  ...nonSuccessOutcomes<T>(providerName, prefix, candidates, successValue),
});

// ---------------------------------------------------------------------------
// Per-capability fixture sets
// ---------------------------------------------------------------------------

export const identityFixtures = buildFixtureSet(
  "simulated-identity",
  "identity",
  {
    provider: "simulated-identity",
    issuer: "Vision simulated identity fixture",
    provider_subject_reference: "demo-subject-001",
    assurance_label: "simulated demonstration credential",
    credential_state: { state: "active" as const, checked_at: FIXTURE_TIME },
    asserted_at: FIXTURE_TIME,
  },
  [],
);

export const recipientDeliveryFixtures = buildFixtureSet(
  "simulated-department-inbox",
  "recipient.delivery",
  {
    delivery_id: FIXTURE_DELIVERY,
    issue_id: FIXTURE_ISSUE,
    department_id: "dept-education-demo",
    accepted_at: FIXTURE_TIME,
    external_reference: "SIM-DELIVERY-0001",
  },
  [],
);

export const recipientAcknowledgmentFixtures = buildFixtureSet(
  "simulated-department-inbox",
  "recipient.acknowledgment",
  {
    delivery_id: FIXTURE_DELIVERY,
    issue_id: FIXTURE_ISSUE,
    acknowledged_at: FIXTURE_TIME,
    external_reference: "SIM-ACK-0001",
    note: "simulated acknowledgment — not a real government confirmation",
  },
  [],
);

export const objectStoreFixtures = buildFixtureSet(
  "filesystem-object-store",
  "object_storage",
  {
    object_reference: "evidence/2026/09/demo-object-001",
    upload_url: "http://127.0.0.1:8080/local-upload/demo-object-001",
    expires_at: unsafeTimestamp("2026-09-09T10:15:00Z"),
    max_bytes: 8 * 1024 * 1024,
    permitted_content_types: ["image/jpeg", "image/png", "audio/webm"],
  },
  [],
);

export const taskDeliveryFixtures = buildFixtureSet(
  "loopback-task-delivery",
  "task_delivery",
  {
    task_id: "task-0001",
    stage_key: "submission:demo:media_processing",
    enqueued_at: FIXTURE_TIME,
  },
  [],
);

export const classificationFixtures = buildFixtureSet(
  "stub-classifier",
  "ai_classification",
  {
    taxonomy_version: "demo-taxonomy.v1",
    proposed_category_id: "structure.window",
    proposed_defect_id: "broken",
    certainty_band: "medium" as const,
    requires_review: false,
    model_name: "stub-classifier",
    prompt_version: "classify.v1",
    input_hash: "sha256:stub-classification-input",
  },
  [
    {
      taxonomy_version: "demo-taxonomy.v1",
      proposed_category_id: "structure.window",
      proposed_defect_id: "broken",
      certainty_band: "low" as const,
      requires_review: true,
      model_name: "stub-classifier",
      prompt_version: "classify.v1",
      input_hash: "sha256:stub-classification-input",
    },
    {
      taxonomy_version: "demo-taxonomy.v1",
      proposed_category_id: "structure.wall",
      proposed_defect_id: "cracked",
      certainty_band: "low" as const,
      requires_review: true,
      model_name: "stub-classifier",
      prompt_version: "classify.v1",
      input_hash: "sha256:stub-classification-input",
    },
  ],
);

export const transcriptionFixtures = buildFixtureSet(
  "stub-transcriber",
  "ai_transcription",
  {
    transcript_text: "demonstration transcript placeholder",
    detected_language: unsafeBcp47("en-IN"),
    model_name: "stub-transcriber",
    input_hash: "sha256:stub-transcription-input",
    processed_externally: false,
  },
  [],
);

export const sourceImportFixtures = buildFixtureSet(
  "synthetic-source-import",
  "source_import",
  [
    {
      source_record_id: FIXTURE_SOURCE,
      source_name: "demo synthetic school register",
      source_url_or_location: "packages/adapters/src/sources.ts#SYNTHETIC_PROJECT_ROWS",
      retrieved_at: FIXTURE_TIME,
      licence_or_permission_status: "synthetic" as const,
      demo_status: "team_created_synthetic" as const,
      raw_snapshot: { asset_id: "demo-school-001", asset_type: "school_building" },
    },
  ],
  [[]],
);

export const uploadOwnerFixture = FIXTURE_OWNER;

/**
 * Capability-indexed fixture coverage. `recipient_acknowledgment` covers both
 * recipient operations; delivery fixtures are exported separately above.
 */
export const CONTRACT_FIXTURES: Readonly<
  Record<CapabilityId, Record<OutcomeKind, AdapterOutcome<unknown>>>
> = {
  citizen_identity: identityFixtures,
  recipient_acknowledgment: recipientAcknowledgmentFixtures,
  ai_classification: classificationFixtures,
  ai_transcription: transcriptionFixtures,
  object_storage: objectStoreFixtures,
  task_delivery: taskDeliveryFixtures,
  source_import: sourceImportFixtures,
} as const;
