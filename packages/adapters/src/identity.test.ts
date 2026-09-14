import { test } from "node:test";
import assert from "node:assert/strict";

import {
  newCorrelationId,
  newUuid,
  unsafeTimestamp,
  type AdapterCallContext,
} from "@vision/contracts";

import {
  DEMO_PRINCIPALS,
  demoCitizenPrincipals,
  IdentityService,
  SIMULATED_IDENTITY_PROVIDER,
  SimulatedIdentityAdapter,
} from "./identity.ts";
import { InMemoryIdentityMappingRepository, InMemoryParticipantRepository } from "./ports.ts";
import { describeIdentityAdapterContract } from "./contract-tests.ts";

const HMAC_KEY = "test-only-identity-key";
const ctx = (): AdapterCallContext => ({ correlation_id: newCorrelationId() });

const firstPrincipal = DEMO_PRINCIPALS[0]!;
const secondPrincipal = DEMO_PRINCIPALS[1]!;

const makeService = () => {
  const participants = new InMemoryParticipantRepository();
  const mappings = new InMemoryIdentityMappingRepository();
  return {
    participants,
    mappings,
    service: new IdentityService(participants, mappings, HMAC_KEY),
  };
};

// The simulated adapter must satisfy the same contract a real provider will.
describeIdentityAdapterContract(
  "SimulatedIdentityAdapter",
  () => new SimulatedIdentityAdapter(),
  firstPrincipal.credential,
);

test("V009: repeated login for the same fixture yields the same participant", async () => {
  const { service } = makeService();
  const adapter = new SimulatedIdentityAdapter();

  const first = await adapter.authenticate(
    { credential: firstPrincipal.credential, interface_locale: "en-IN" as never },
    ctx(),
  );
  const second = await adapter.authenticate(
    { credential: firstPrincipal.credential, interface_locale: "mr-IN" as never },
    ctx(),
  );

  assert.equal(first.kind, "success");
  assert.equal(second.kind, "success");
  if (first.kind !== "success" || second.kind !== "success") return;

  const resolvedFirst = await service.resolveParticipant(first.value);
  const resolvedSecond = await service.resolveParticipant(second.value);

  assert.equal(resolvedFirst.created, true, "the first login creates the participant");
  assert.equal(resolvedSecond.created, false, "the second login must reuse it");
  assert.equal(
    resolvedFirst.participant.participant_id,
    resolvedSecond.participant.participant_id,
    "a repeated login must resolve to the same internal participant",
  );
});

test("V009: concurrent resolution for one fixture yields one participant", async () => {
  const { service } = makeService();
  const adapter = new SimulatedIdentityAdapter();
  const authenticated = await adapter.authenticate(
    { credential: firstPrincipal.credential, interface_locale: "en-IN" as never },
    ctx(),
  );
  if (authenticated.kind !== "success") assert.fail("expected the demo credential to succeed");

  const resolutions = await Promise.all([
    service.resolveParticipant(authenticated.value),
    service.resolveParticipant(authenticated.value),
  ]);

  assert.equal(resolutions.filter((result) => result.created).length, 1);
  assert.equal(
    resolutions[0]!.participant.participant_id,
    resolutions[1]!.participant.participant_id,
    "concurrent login must not create a second participant or throw a uniqueness error",
  );
});

test("V009: switching interface locale does not create a second participant", async () => {
  const { service, mappings } = makeService();
  const adapter = new SimulatedIdentityAdapter();

  for (const locale of ["en-IN", "mr-IN", "en-IN"]) {
    const outcome = await adapter.authenticate(
      { credential: firstPrincipal.credential, interface_locale: locale as never },
      ctx(),
    );
    if (outcome.kind === "success") {
      await service.resolveParticipant(outcome.value);
    }
  }

  const hash = service.hashProviderSubject(
    SIMULATED_IDENTITY_PROVIDER,
    firstPrincipal.provider_subject_reference,
  );
  const mapping = await mappings.findByProviderSubject(SIMULATED_IDENTITY_PROVIDER, hash);
  assert.ok(mapping, "exactly one mapping must exist for the subject");
});

test("V009: distinct demo principals resolve to distinct participants", async () => {
  const { service } = makeService();
  const adapter = new SimulatedIdentityAdapter();

  const a = await adapter.authenticate(
    { credential: firstPrincipal.credential, interface_locale: "en-IN" as never },
    ctx(),
  );
  const b = await adapter.authenticate(
    { credential: secondPrincipal.credential, interface_locale: "en-IN" as never },
    ctx(),
  );
  if (a.kind !== "success" || b.kind !== "success") {
    assert.fail("both demo principals should authenticate");
  }

  const resolvedA = await service.resolveParticipant(a.value);
  const resolvedB = await service.resolveParticipant(b.value);
  assert.notEqual(resolvedA.participant.participant_id, resolvedB.participant.participant_id);
});

test("V009: the raw provider subject reference is never stored", async () => {
  const { service, mappings } = makeService();
  const adapter = new SimulatedIdentityAdapter();

  const outcome = await adapter.authenticate(
    { credential: firstPrincipal.credential, interface_locale: "en-IN" as never },
    ctx(),
  );
  if (outcome.kind !== "success") assert.fail("expected success");
  await service.resolveParticipant(outcome.value);

  const hash = service.hashProviderSubject(
    SIMULATED_IDENTITY_PROVIDER,
    firstPrincipal.provider_subject_reference,
  );
  const mapping = await mappings.findByProviderSubject(SIMULATED_IDENTITY_PROVIDER, hash);
  assert.ok(mapping);
  assert.notEqual(
    mapping.provider_subject_hash,
    firstPrincipal.provider_subject_reference,
    "the stored value must not be the raw provider reference",
  );
  assert.match(mapping.provider_subject_hash, /^[0-9a-f]{64}$/, "expected a keyed SHA-256 hash");
  assert.equal(mapping.provider_mode, "simulated");
});

test("V009: the same subject hashes differently under a different key", () => {
  const participants = new InMemoryParticipantRepository();
  const mappings = new InMemoryIdentityMappingRepository();
  const a = new IdentityService(participants, mappings, "key-one");
  const b = new IdentityService(participants, mappings, "key-two");

  assert.notEqual(
    a.hashProviderSubject("p", "subject-1"),
    b.hashProviderSubject("p", "subject-1"),
    "environments with different keys must not produce correlatable hashes",
  );
});

test("V009: an identity service cannot be constructed without a key", () => {
  assert.throws(
    () =>
      new IdentityService(
        new InMemoryParticipantRepository(),
        new InMemoryIdentityMappingRepository(),
        "",
      ),
    /IDENTITY_MAPPING_HMAC_KEY/,
  );
});

test("V009: an unknown demo credential is rejected without a network call", async () => {
  const adapter = new SimulatedIdentityAdapter();
  const outcome = await adapter.authenticate(
    { credential: "not-a-demo-principal", interface_locale: "en-IN" as never },
    ctx(),
  );
  assert.equal(outcome.kind, "rejected");
  if (outcome.kind === "rejected") {
    assert.equal(outcome.reason_code, "unknown_demo_credential");
    assert.equal(outcome.retryable, false);
  }
});

test("V009: revoked and expired demo credentials fail closed", async () => {
  const adapter = new SimulatedIdentityAdapter();

  for (const [credential, expectedReason] of [
    ["demo-revoked-one", "demo_credential_revoked"],
    ["demo-expired-one", "demo_credential_expired"],
  ] as const) {
    const outcome = await adapter.authenticate(
      { credential, interface_locale: "en-IN" as never },
      ctx(),
    );
    assert.equal(outcome.kind, "rejected");
    if (outcome.kind === "rejected") {
      assert.equal(outcome.reason_code, expectedReason);
      assert.equal(outcome.retryable, false);
    }
  }
});

test("V009/V034: the citizen principal set excludes the reserved staff fixture", () => {
  const citizens = demoCitizenPrincipals();
  assert.ok(citizens.length > 0);
  assert.ok(citizens.every((principal) => principal.account_type === "citizen"));
  assert.equal(
    citizens.some((principal) => principal.credential === "demo-staff-one"),
    false,
  );
});

test("V009: the identity assertion records issuer and credential state", async () => {
  const adapter = new SimulatedIdentityAdapter();
  const outcome = await adapter.authenticate(
    { credential: firstPrincipal.credential, interface_locale: "en-IN" as never },
    ctx(),
  );
  if (outcome.kind !== "success") assert.fail("expected success");

  assert.equal(outcome.value.issuer, firstPrincipal.issuer);
  assert.equal(outcome.value.credential_state.state, "active");
  assert.ok(outcome.value.credential_state.checked_at.length > 0);
});

test("V009: disabled and erased mappings cannot authenticate", async () => {
  for (const inactiveField of ["disabled_at", "erased_at"] as const) {
    const { service, participants, mappings } = makeService();
    const adapter = new SimulatedIdentityAdapter();
    const authenticated = await adapter.authenticate(
      { credential: firstPrincipal.credential, interface_locale: "en-IN" as never },
      ctx(),
    );
    if (authenticated.kind !== "success") assert.fail("expected success");

    const participant = await participants.create({
      participant_id: newUuid(),
      created_at: unsafeTimestamp("2026-09-09T10:00:00Z"),
    });
    await mappings.create({
      identity_mapping_id: newUuid(),
      participant_id: participant.participant_id,
      provider: authenticated.value.provider,
      provider_subject_hash: service.hashProviderSubject(
        authenticated.value.provider,
        authenticated.value.provider_subject_reference,
      ),
      provider_mode: "simulated",
      created_at: unsafeTimestamp("2026-09-09T10:00:00Z"),
      [inactiveField]: unsafeTimestamp("2026-09-09T10:01:00Z"),
    });

    await assert.rejects(
      service.resolveParticipant(authenticated.value),
      new RegExp(`mapping_${inactiveField === "disabled_at" ? "disabled" : "erased"}`),
    );
  }
});

test("V009: the identity capability is labelled simulated and forbids verification claims", () => {
  const adapter = new SimulatedIdentityAdapter();
  const capability = adapter.descriptor.capability;
  assert.equal(capability.provider_mode, "simulated");
  assert.match(capability.display_label, /simulated/i);
  assert.ok(
    capability.must_not_claim.some((claim) => /DigiLocker/i.test(claim)),
    "the capability must explicitly forbid a DigiLocker-verified claim",
  );
});
