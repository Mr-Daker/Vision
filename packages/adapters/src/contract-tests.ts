/**
 * Reusable adapter contract suites (roadmap V008/V010).
 *
 * These assertions are provider-agnostic: they must hold for the simulated
 * adapters today and for a real DigiLocker or department integration later
 * (V057/V058). That is what makes "replaceable without changing the citizen or
 * staff workflow" checkable instead of aspirational — the real adapter is
 * expected to be handed to the same suite.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  OUTCOME_KINDS,
  carriesExternalAuthority,
  findUnlabelledSimulations,
  isIngestible,
  newCorrelationId,
  nowIso,
  unsafeIdempotencyKey,
  unsafeIdempotencyScope,
  unsafeRequestFingerprint,
  unsafeUuid,
  type AdapterCallContext,
  type AdapterDescriptor,
  type AdapterOutcome,
  type GovernmentRecipientAdapter,
  type IdempotencyScope,
  type IdentityProviderAdapter,
  type MutationAdapterCallContext,
  type Provenance,
  type RecipientSubmission,
  type RequestFingerprint,
  type SourceImportAdapter,
  type SourceImportQuery,
  type Uuid,
} from "@vision/contracts";

const context = (): AdapterCallContext => ({ correlation_id: newCorrelationId() });

const mutationContext = (
  idempotencyKey: string,
  idempotencyScope: IdempotencyScope,
  requestFingerprint: RequestFingerprint,
): MutationAdapterCallContext => ({
  correlation_id: newCorrelationId(),
  idempotency_key: unsafeIdempotencyKey(idempotencyKey),
  idempotency_scope: idempotencyScope,
  request_fingerprint: requestFingerprint,
});

const assertDescriptorConsistentAndLabelled = (
  descriptor: AdapterDescriptor,
  label: string,
): void => {
  assert.equal(
    descriptor.capability.provider_name,
    descriptor.provider_name,
    `${label}: capability and adapter must name the same provider`,
  );
  assert.equal(
    descriptor.capability.provider_mode,
    descriptor.provider_mode,
    `${label}: capability and adapter must declare the same provider mode`,
  );

  const unlabelled = findUnlabelledSimulations({
    contract_version: "1.0.0",
    generated_at: nowIso(),
    capabilities: [descriptor.capability],
  });
  assert.deepEqual(
    unlabelled,
    [],
    `${label}: a non-real provider must say so in its display label (V002)`,
  );
};

const assertProvenanceHonest = (
  provenance: Provenance,
  descriptor: AdapterDescriptor,
  label: string,
): void => {
  assert.equal(
    provenance.provider_name,
    descriptor.provider_name,
    `${label}: provenance must name the provider that produced it`,
  );
  assert.equal(
    provenance.provider_mode,
    descriptor.provider_mode,
    `${label}: provenance and descriptor must declare the same provider mode`,
  );
  if (descriptor.provider_mode !== "real") {
    assert.equal(
      provenance.authenticity,
      "simulated_fixture",
      `${label}: a simulated provider must not claim an external authenticity`,
    );
    assert.equal(
      carriesExternalAuthority(provenance),
      false,
      `${label}: a simulated provider must never carry external authority`,
    );
  }
};

const assertOutcomeContract = (
  outcome: AdapterOutcome<unknown>,
  callContext: AdapterCallContext,
  descriptor: AdapterDescriptor,
  label: string,
): void => {
  assert.ok(OUTCOME_KINDS.includes(outcome.kind), `${label}: undeclared outcome kind`);
  assert.equal(
    outcome.correlation_id,
    callContext.correlation_id,
    `${label}: the adapter must echo the call correlation id`,
  );
  assertProvenanceHonest(outcome.provenance, descriptor, label);
};

export type RecipientAdapterContractCases = {
  /** A provider-specific sandbox/fixture submission that must be deliverable. */
  readonly acceptedSubmission: RecipientSubmission;
  /** A different request used to prove that an idempotency key cannot be rebound. */
  readonly conflictingSubmission: RecipientSubmission;
  /** A delivery id guaranteed not to exist in the provider fixture. */
  readonly unknownDeliveryId: Uuid;
  readonly idempotencyScope: IdempotencyScope;
  readonly requestFingerprint: RequestFingerprint;
  readonly conflictingRequestFingerprint: RequestFingerprint;
};

const DEFAULT_RECIPIENT_CASES: RecipientAdapterContractCases = {
  acceptedSubmission: {
    issue_id: unsafeUuid("6ba7b810-9dad-41d1-80b4-00c04fd430c8"),
    department_id: "dept-demo",
    routing_directory_version: "demo-routing.v1",
    category: "demo.category",
    summary_reference: "issue-summary-1",
    submitted_at: nowIso(),
  },
  conflictingSubmission: {
    issue_id: unsafeUuid("6ba7b810-9dad-41d1-80b4-00c04fd430c8"),
    department_id: "dept-demo",
    routing_directory_version: "demo-routing.v1",
    category: "different.demo.category",
    summary_reference: "issue-summary-1",
    submitted_at: nowIso(),
  },
  unknownDeliveryId: unsafeUuid("00000000-0000-4000-8000-000000000000"),
  idempotencyScope: unsafeIdempotencyScope("contract-test:recipient.deliver"),
  requestFingerprint: unsafeRequestFingerprint(`sha256:${"a".repeat(64)}`),
  conflictingRequestFingerprint: unsafeRequestFingerprint(`sha256:${"b".repeat(64)}`),
};

/** Contract every government-recipient adapter must satisfy. */
export const describeRecipientAdapterContract = (
  label: string,
  makeAdapter: () => GovernmentRecipientAdapter,
  cases: RecipientAdapterContractCases = DEFAULT_RECIPIENT_CASES,
): void => {
  test(`${label}: declares the recipient capability and labels simulation`, () => {
    const adapter = makeAdapter();
    assert.equal(adapter.descriptor.capability.capability, "recipient_acknowledgment");
    assertDescriptorConsistentAndLabelled(adapter.descriptor, label);
  });

  test(`${label}: the configured delivery case succeeds and echoes correlation`, async () => {
    const adapter = makeAdapter();
    const callContext = mutationContext(
      "contract-delivery-key-001",
      cases.idempotencyScope,
      cases.requestFingerprint,
    );
    const outcome = await adapter.deliver(cases.acceptedSubmission, callContext);

    assertOutcomeContract(outcome, callContext, adapter.descriptor, label);
    assert.equal(outcome.kind, "success", `${label}: the configured valid case must succeed`);
  });

  test(`${label}: acknowledgment for an unknown delivery is never a success`, async () => {
    const adapter = makeAdapter();
    const callContext = context();
    const outcome = await adapter.fetchAcknowledgment(cases.unknownDeliveryId, callContext);
    assertOutcomeContract(outcome, callContext, adapter.descriptor, label);
    assert.notEqual(
      outcome.kind,
      "success",
      `${label}: an unknown delivery must not produce an acknowledgment`,
    );
  });

  test(`${label}: repeated delivery with one idempotency key does not deliver twice`, async () => {
    const adapter = makeAdapter();
    const firstContext = mutationContext(
      "shared-idempotency-key-001",
      cases.idempotencyScope,
      cases.requestFingerprint,
    );
    const secondContext = mutationContext(
      "shared-idempotency-key-001",
      cases.idempotencyScope,
      cases.requestFingerprint,
    );
    const first = await adapter.deliver(cases.acceptedSubmission, firstContext);
    const second = await adapter.deliver(cases.acceptedSubmission, secondContext);

    assertOutcomeContract(first, firstContext, adapter.descriptor, label);
    assertOutcomeContract(second, secondContext, adapter.descriptor, label);
    assert.equal(first.kind, "success", `${label}: the first delivery must succeed`);
    assert.equal(
      second.kind,
      "duplicate",
      `${label}: the second delivery must be reported as a duplicate`,
    );
    if (first.kind === "success" && second.kind === "duplicate") {
      assert.equal(
        second.existing_value?.delivery_id,
        first.value.delivery_id,
        `${label}: duplicate must reference the committed delivery`,
      );
    }
  });

  test(`${label}: one idempotency key cannot be rebound to another request`, async () => {
    const adapter = makeAdapter();
    const firstContext = mutationContext(
      "conflicting-idempotency-key-001",
      cases.idempotencyScope,
      cases.requestFingerprint,
    );
    const conflictContext = mutationContext(
      "conflicting-idempotency-key-001",
      cases.idempotencyScope,
      cases.conflictingRequestFingerprint,
    );
    const first = await adapter.deliver(cases.acceptedSubmission, firstContext);
    const conflict = await adapter.deliver(cases.conflictingSubmission, conflictContext);

    assertOutcomeContract(first, firstContext, adapter.descriptor, label);
    assertOutcomeContract(conflict, conflictContext, adapter.descriptor, label);
    assert.equal(first.kind, "success", `${label}: the first delivery must succeed`);
    assert.equal(
      conflict.kind,
      "rejected",
      `${label}: a changed request under a committed key must be rejected`,
    );
  });
};

export type SourceImportAdapterContractCases = {
  /** A provider-specific query that must be supported by the configured fixture. */
  readonly supportedQuery: SourceImportQuery;
  /** A query whose dataset is guaranteed to be unsupported. */
  readonly unknownQuery: SourceImportQuery;
};

const DEFAULT_SOURCE_CASES: SourceImportAdapterContractCases = {
  supportedQuery: { dataset: "projects", jurisdiction_profile_id: "demo-district-a" },
  unknownQuery: {
    dataset: "dataset-that-does-not-exist",
    jurisdiction_profile_id: "demo-district-a",
  },
};

/** Contract every source-import adapter must satisfy. */
export const describeSourceImportAdapterContract = (
  label: string,
  makeAdapter: () => SourceImportAdapter,
  cases: SourceImportAdapterContractCases = DEFAULT_SOURCE_CASES,
): void => {
  test(`${label}: declares the source-import capability and labels simulation`, () => {
    const adapter = makeAdapter();
    assert.equal(adapter.descriptor.capability.capability, "source_import");
    assertDescriptorConsistentAndLabelled(adapter.descriptor, label);
  });

  test(`${label}: an unknown dataset never returns success`, async () => {
    const adapter = makeAdapter();
    const callContext = context();
    const outcome = await adapter.fetchRecords(cases.unknownQuery, callContext);
    assertOutcomeContract(outcome, callContext, adapter.descriptor, label);
    assert.notEqual(outcome.kind, "success");
  });

  test(`${label}: the supported query succeeds with labelled, usable rows`, async () => {
    const adapter = makeAdapter();
    const callContext = context();
    const outcome = await adapter.fetchRecords(cases.supportedQuery, callContext);
    assertOutcomeContract(outcome, callContext, adapter.descriptor, label);
    assert.equal(outcome.kind, "success", `${label}: the configured supported query must succeed`);
    if (outcome.kind !== "success") return;

    for (const row of outcome.value) {
      assert.ok(row.source_url_or_location.length > 0, `${label}: row is missing provenance`);
      assert.ok(row.retrieved_at.length > 0, `${label}: row is missing retrieved_at`);

      // A row that is not ingestible must not be carrying a snapshot, and must
      // not be labelled as permitted demo data (V003 SourceRecord, V004 §5).
      if (!isIngestible(row)) {
        assert.equal(
          row.raw_snapshot,
          undefined,
          `${label}: a non-ingestible row must not carry a raw snapshot`,
        );
        assert.notEqual(row.demo_status, "permitted_source_data");
      }

      if (adapter.descriptor.provider_mode !== "real") {
        assert.equal(
          row.licence_or_permission_status,
          "synthetic",
          `${label}: a simulated source adapter must emit synthetic rows only`,
        );
        assert.equal(
          row.demo_status,
          "team_created_synthetic",
          `${label}: a simulated source row must be visibly labelled`,
        );
      }
    }
  });
};

/** Contract every identity adapter must satisfy. */
export const describeIdentityAdapterContract = (
  label: string,
  makeAdapter: () => IdentityProviderAdapter,
  validCredential: string,
): void => {
  test(`${label}: declares the identity capability and labels simulation`, () => {
    const adapter = makeAdapter();
    assert.equal(adapter.descriptor.capability.capability, "citizen_identity");
    assertDescriptorConsistentAndLabelled(adapter.descriptor, label);
  });

  test(`${label}: an unknown credential is rejected, not accepted`, async () => {
    const adapter = makeAdapter();
    const outcome = await adapter.authenticate(
      { credential: "definitely-not-a-configured-credential", interface_locale: "en-IN" as never },
      context(),
    );
    assert.notEqual(outcome.kind, "success");
    assertProvenanceHonest(outcome.provenance, adapter.descriptor, label);
  });

  test(`${label}: a valid credential yields an assertion with honest provenance`, async () => {
    const adapter = makeAdapter();
    const outcome = await adapter.authenticate(
      { credential: validCredential, interface_locale: "en-IN" as never },
      context(),
    );
    assert.equal(outcome.kind, "success");
    assertProvenanceHonest(outcome.provenance, adapter.descriptor, label);
    if (outcome.kind === "success") {
      assert.ok(outcome.value.provider_subject_reference.length > 0);
      assert.ok(outcome.value.assurance_label.length > 0);
    }
  });
};
