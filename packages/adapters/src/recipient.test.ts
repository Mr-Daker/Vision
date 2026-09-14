import { test } from "node:test";
import assert from "node:assert/strict";

import {
  carriesExternalAuthority,
  newCorrelationId,
  nowIso,
  unsafeIdempotencyKey,
  unsafeIdempotencyScope,
  unsafeRequestFingerprint,
  unsafeTimestamp,
  unsafeUuid,
  type AdapterCallContext,
  type MutationAdapterCallContext,
  type RecipientSubmission,
} from "@vision/contracts";

import { SimulatedDepartmentRecipientAdapter } from "./recipient.ts";
import { describeRecipientAdapterContract } from "./contract-tests.ts";

const ctx = (): AdapterCallContext => ({ correlation_id: newCorrelationId() });

const mutationCtx = (
  idempotencyKey: string,
  fingerprintHex = "a",
  scope = "demo:recipient.deliver",
): MutationAdapterCallContext => ({
  correlation_id: newCorrelationId(),
  idempotency_key: unsafeIdempotencyKey(idempotencyKey),
  idempotency_scope: unsafeIdempotencyScope(scope),
  request_fingerprint: unsafeRequestFingerprint(`sha256:${fingerprintHex.repeat(64)}`),
});

const submission = (departmentId: string): RecipientSubmission => ({
  issue_id: unsafeUuid("6ba7b810-9dad-41d1-80b4-00c04fd430c8"),
  department_id: departmentId,
  routing_directory_version: "demo-routing.v1",
  category: "demo.category",
  summary_reference: "issue-summary-1",
  submitted_at: nowIso(),
});

// The simulated adapter must satisfy the same suite a real recipient will.
describeRecipientAdapterContract(
  "SimulatedDepartmentRecipientAdapter",
  () => new SimulatedDepartmentRecipientAdapter(),
);

test("V010: delayed acknowledgment reports pending before it reports success", async () => {
  const adapter = new SimulatedDepartmentRecipientAdapter({
    defaultScenario: { kind: "acknowledge_after_polls", polls: 2 },
  });

  const delivery = await adapter.deliver(
    submission("dept-demo"),
    mutationCtx("delayed-delivery-key"),
  );
  assert.equal(delivery.kind, "success");
  if (delivery.kind !== "success") return;

  const first = await adapter.fetchAcknowledgment(delivery.value.delivery_id, ctx());
  const second = await adapter.fetchAcknowledgment(delivery.value.delivery_id, ctx());
  const third = await adapter.fetchAcknowledgment(delivery.value.delivery_id, ctx());

  assert.equal(first.kind, "pending", "an agency does not answer instantly");
  assert.equal(second.kind, "pending");
  assert.equal(third.kind, "success");
});

test("V010: delivery success is not acknowledgment", async () => {
  const adapter = new SimulatedDepartmentRecipientAdapter({
    defaultScenario: { kind: "never_acknowledge" },
  });

  const delivery = await adapter.deliver(
    submission("dept-demo"),
    mutationCtx("never-ack-delivery-key"),
  );
  assert.equal(delivery.kind, "success", "the channel accepted the delivery");
  if (delivery.kind !== "success") return;

  const acknowledgment = await adapter.fetchAcknowledgment(delivery.value.delivery_id, ctx());
  assert.equal(
    acknowledgment.kind,
    "pending",
    "a delivered issue must not be reported as acknowledged",
  );
});

test("V010: rejected routing is reported as rejected and not retryable", async () => {
  const adapter = new SimulatedDepartmentRecipientAdapter({
    scenarioByDepartment: {
      "dept-wrong-owner": {
        kind: "reject_routing",
        reason_code: "not_this_departments_responsibility",
        detail: "the simulated recipient does not own this category",
      },
    },
  });

  const outcome = await adapter.deliver(
    submission("dept-wrong-owner"),
    mutationCtx("rejected-routing-key"),
  );
  assert.equal(outcome.kind, "rejected");
  if (outcome.kind === "rejected") {
    assert.equal(outcome.retryable, false);
    assert.equal(outcome.reason_code, "not_this_departments_responsibility");
  }
});

test("V010: a transient channel failure is retryable", async () => {
  const adapter = new SimulatedDepartmentRecipientAdapter({
    defaultScenario: { kind: "unavailable", retry_after_ms: 1500 },
  });

  const outcome = await adapter.deliver(
    submission("dept-demo"),
    mutationCtx("unavailable-delivery-key"),
  );
  assert.equal(outcome.kind, "unavailable");
  if (outcome.kind === "unavailable") {
    assert.equal(outcome.retryable, true);
    assert.equal(outcome.retry_after_ms, 1500);
  }
});

test("V010: a retried delivery is a duplicate, not a second delivery", async () => {
  const adapter = new SimulatedDepartmentRecipientAdapter({
    defaultScenario: { kind: "acknowledge_immediately" },
  });

  const first = await adapter.deliver(submission("dept-demo"), mutationCtx("delivery-key-0001"));
  const second = await adapter.deliver(submission("dept-demo"), mutationCtx("delivery-key-0001"));

  assert.equal(first.kind, "success");
  assert.equal(second.kind, "duplicate");
  if (first.kind === "success" && second.kind === "duplicate") {
    assert.deepEqual(
      second.existing_value?.delivery_id,
      first.value.delivery_id,
      "the duplicate must point at the already-committed delivery",
    );
  }
});

test("V010: one idempotency key cannot be rebound to a different request", async () => {
  const adapter = new SimulatedDepartmentRecipientAdapter({
    defaultScenario: { kind: "acknowledge_immediately" },
  });

  const first = await adapter.deliver(
    submission("dept-demo"),
    mutationCtx("delivery-conflict-key", "a"),
  );
  const conflict = await adapter.deliver(
    { ...submission("dept-demo"), category: "different.category" },
    mutationCtx("delivery-conflict-key", "b"),
  );

  assert.equal(first.kind, "success");
  assert.equal(conflict.kind, "rejected");
  if (conflict.kind === "rejected") {
    assert.equal(conflict.reason_code, "idempotency_key_reused_with_different_request");
    assert.equal(conflict.retryable, false);
  }
});

test("V010: the same client key is independent across idempotency scopes", async () => {
  const adapter = new SimulatedDepartmentRecipientAdapter({
    defaultScenario: { kind: "acknowledge_immediately" },
  });

  const first = await adapter.deliver(
    submission("dept-demo"),
    mutationCtx("shared-client-key", "a", "participant-a:recipient.deliver"),
  );
  const independent = await adapter.deliver(
    submission("dept-demo"),
    mutationCtx("shared-client-key", "a", "participant-b:recipient.deliver"),
  );

  assert.equal(first.kind, "success");
  assert.equal(independent.kind, "success");
  if (first.kind === "success" && independent.kind === "success") {
    assert.notEqual(first.value.delivery_id, independent.value.delivery_id);
  }
});

test("V010: every simulated agency event is labelled and carries no external authority", async () => {
  const adapter = new SimulatedDepartmentRecipientAdapter({
    defaultScenario: { kind: "acknowledge_immediately" },
  });

  const delivery = await adapter.deliver(
    submission("dept-demo"),
    mutationCtx("labelled-delivery-key"),
  );
  assert.equal(delivery.kind, "success");
  if (delivery.kind !== "success") return;

  const acknowledgment = await adapter.fetchAcknowledgment(delivery.value.delivery_id, ctx());
  assert.equal(acknowledgment.kind, "success");
  if (acknowledgment.kind !== "success") return;

  for (const outcome of [delivery, acknowledgment]) {
    assert.equal(outcome.provenance.authenticity, "simulated_fixture");
    assert.equal(carriesExternalAuthority(outcome.provenance), false);
    assert.equal(outcome.provenance.provider_name, "simulated-department-inbox");
  }

  assert.match(
    acknowledgment.value.note ?? "",
    /simulated/i,
    "the acknowledgment must say it is simulated",
  );
  assert.match(adapter.descriptor.capability.display_label, /not a real government/i);
});

test("V010: failure, pending, duplicate, and conflict outcomes are also labelled", async () => {
  const pendingAdapter = new SimulatedDepartmentRecipientAdapter({
    defaultScenario: { kind: "never_acknowledge" },
  });
  const pendingDelivery = await pendingAdapter.deliver(
    submission("dept-pending"),
    mutationCtx("pending-label-key"),
  );
  assert.equal(pendingDelivery.kind, "success");
  if (pendingDelivery.kind !== "success") return;
  const pending = await pendingAdapter.fetchAcknowledgment(
    pendingDelivery.value.delivery_id,
    ctx(),
  );

  const rejectedAdapter = new SimulatedDepartmentRecipientAdapter({
    defaultScenario: { kind: "reject_routing", reason_code: "wrong_owner", detail: "not ours" },
  });
  const rejected = await rejectedAdapter.deliver(
    submission("dept-rejected"),
    mutationCtx("rejected-label-key"),
  );

  const unavailableAdapter = new SimulatedDepartmentRecipientAdapter({
    defaultScenario: { kind: "unavailable", retry_after_ms: 1000 },
  });
  const unavailable = await unavailableAdapter.deliver(
    submission("dept-unavailable"),
    mutationCtx("unavailable-label-key"),
  );

  const idempotentAdapter = new SimulatedDepartmentRecipientAdapter({
    defaultScenario: { kind: "acknowledge_immediately" },
  });
  const committed = await idempotentAdapter.deliver(
    submission("dept-idempotent"),
    mutationCtx("idempotency-label-key", "a"),
  );
  const duplicate = await idempotentAdapter.deliver(
    submission("dept-idempotent"),
    mutationCtx("idempotency-label-key", "a"),
  );
  const conflict = await idempotentAdapter.deliver(
    { ...submission("dept-idempotent"), category: "changed.category" },
    mutationCtx("idempotency-label-key", "b"),
  );
  const unknown = await idempotentAdapter.fetchAcknowledgment(
    unsafeUuid("22222222-2222-4222-8222-222222222222"),
    ctx(),
  );

  assert.equal(pending.kind, "pending");
  assert.equal(rejected.kind, "rejected");
  assert.equal(unavailable.kind, "unavailable");
  assert.equal(committed.kind, "success");
  assert.equal(duplicate.kind, "duplicate");
  assert.equal(conflict.kind, "rejected");
  assert.equal(unknown.kind, "rejected");

  for (const outcome of [pending, rejected, unavailable, committed, duplicate, conflict, unknown]) {
    assert.equal(outcome.provenance.authenticity, "simulated_fixture");
    assert.equal(outcome.provenance.provider_mode, "simulated");
    assert.equal(carriesExternalAuthority(outcome.provenance), false);
  }
});

test("V010: a successful acknowledgment remains stable across repeat polls", async () => {
  let currentTime = unsafeTimestamp("2026-09-09T10:00:00Z");
  const adapter = new SimulatedDepartmentRecipientAdapter(
    { defaultScenario: { kind: "acknowledge_immediately" } },
    () => currentTime,
  );

  const delivery = await adapter.deliver(
    submission("dept-demo"),
    mutationCtx("stable-acknowledgment-key"),
  );
  assert.equal(delivery.kind, "success");
  if (delivery.kind !== "success") return;

  const first = await adapter.fetchAcknowledgment(delivery.value.delivery_id, ctx());
  currentTime = unsafeTimestamp("2026-09-10T10:00:00Z");
  const repeated = await adapter.fetchAcknowledgment(delivery.value.delivery_id, ctx());

  assert.equal(first.kind, "success");
  assert.equal(repeated.kind, "success");
  if (first.kind === "success" && repeated.kind === "success") {
    assert.deepEqual(repeated.value, first.value);
  }
});

test("V010: an unknown delivery cannot be acknowledged", async () => {
  const adapter = new SimulatedDepartmentRecipientAdapter();
  const outcome = await adapter.fetchAcknowledgment(
    unsafeUuid("11111111-1111-4111-8111-111111111111"),
    ctx(),
  );
  assert.equal(outcome.kind, "rejected");
});

test("V010: different departments can exhibit different behaviour in one demo", async () => {
  const adapter = new SimulatedDepartmentRecipientAdapter({
    defaultScenario: { kind: "acknowledge_immediately" },
    scenarioByDepartment: {
      "dept-slow": { kind: "acknowledge_after_polls", polls: 1 },
      "dept-refuses": { kind: "reject_routing", reason_code: "refused", detail: "not ours" },
    },
  });

  const fast = await adapter.deliver(submission("dept-fast"), mutationCtx("fast-delivery-key"));
  const slow = await adapter.deliver(submission("dept-slow"), mutationCtx("slow-delivery-key"));
  const refused = await adapter.deliver(
    submission("dept-refuses"),
    mutationCtx("refused-delivery-key"),
  );

  assert.equal(fast.kind, "success");
  assert.equal(slow.kind, "success");
  assert.equal(refused.kind, "rejected");

  if (fast.kind === "success" && slow.kind === "success") {
    assert.equal(
      (await adapter.fetchAcknowledgment(fast.value.delivery_id, ctx())).kind,
      "success",
    );
    assert.equal(
      (await adapter.fetchAcknowledgment(slow.value.delivery_id, ctx())).kind,
      "pending",
    );
  }
});
