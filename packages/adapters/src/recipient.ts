/**
 * Simulated department recipient adapter (roadmap V010).
 *
 * This stands in for a government department inbox. It is explicitly and
 * unavoidably simulated: every response it produces carries
 * `authenticity: "simulated_fixture"`, so `carriesExternalAuthority()` is false
 * for all of them and no caller can present its acknowledgment as official
 * receipt (V002 row 16).
 *
 * It models the awkward cases on purpose, because those are what break
 * workflows later: delayed acknowledgment, rejected routing, transient
 * unavailability, and duplicate delivery.
 */

import {
  newUuid,
  nowIso,
  type AdapterCallContext,
  type AdapterDescriptor,
  type AdapterOutcome,
  type CapabilityDescriptor,
  type GovernmentRecipientAdapter,
  type IsoTimestamp,
  type MutationAdapterCallContext,
  type RecipientAcknowledgment,
  type RecipientDelivery,
  type RecipientSubmission,
  type SimulatedProvenance,
  type Uuid,
} from "@vision/contracts";

export const SIMULATED_RECIPIENT_PROVIDER = "simulated-department-inbox";

export const SIMULATED_RECIPIENT_CAPABILITY: CapabilityDescriptor = {
  capability: "recipient_acknowledgment",
  provider_name: SIMULATED_RECIPIENT_PROVIDER,
  provider_mode: "simulated",
  display_label: "Simulated department inbox — not a real government acknowledgment",
  v002_row: 16,
  may_claim: [
    "Internally routed",
    "Simulated acknowledgment received (not a real government confirmation)",
  ],
  must_not_claim: ["Acknowledged by the government department", "Officially received"],
};

/**
 * Scripted behaviours. `acknowledge_after_polls` is the realistic default:
 * agencies do not answer synchronously, and a workflow that only handles
 * instant acknowledgment is the workflow that breaks in a pilot.
 */
export type RecipientScenario =
  | { readonly kind: "acknowledge_immediately" }
  | { readonly kind: "acknowledge_after_polls"; readonly polls: number }
  | { readonly kind: "never_acknowledge" }
  | { readonly kind: "reject_routing"; readonly reason_code: string; readonly detail: string }
  | { readonly kind: "unavailable"; readonly retry_after_ms: number };

export type SimulatedRecipientOptions = {
  /** Default scenario when no department-specific override matches. */
  readonly defaultScenario?: RecipientScenario;
  /** Per-department overrides, so a demo can show several behaviours at once. */
  readonly scenarioByDepartment?: Readonly<Record<string, RecipientScenario>>;
};

type DeliveryState = {
  readonly delivery: RecipientDelivery;
  readonly scenario: RecipientScenario;
  acknowledgment?: RecipientAcknowledgment;
  pollCount: number;
};

type IdempotencyBinding = {
  readonly deliveryId: Uuid;
  readonly requestFingerprint: string;
};

export class SimulatedDepartmentRecipientAdapter implements GovernmentRecipientAdapter {
  readonly descriptor: AdapterDescriptor = {
    provider_name: SIMULATED_RECIPIENT_PROVIDER,
    provider_mode: "simulated",
    capability: SIMULATED_RECIPIENT_CAPABILITY,
  };

  private readonly deliveries = new Map<string, DeliveryState>();
  /** Scope + key -> committed request binding, so retries cannot double-deliver. */
  private readonly idempotencyBindings = new Map<string, IdempotencyBinding>();
  private readonly defaultScenario: RecipientScenario;
  private readonly scenarioByDepartment: Readonly<Record<string, RecipientScenario>>;
  private readonly clock: () => IsoTimestamp;

  constructor(options: SimulatedRecipientOptions = {}, clock: () => IsoTimestamp = nowIso) {
    this.defaultScenario = options.defaultScenario ?? { kind: "acknowledge_after_polls", polls: 1 };
    this.scenarioByDepartment = options.scenarioByDepartment ?? {};
    this.clock = clock;
  }

  private provenance(fixtureId: string): SimulatedProvenance {
    return {
      provider_mode: "simulated",
      authenticity: "simulated_fixture",
      provider_name: SIMULATED_RECIPIENT_PROVIDER,
      observed_at: this.clock(),
      fixture_id: fixtureId,
    };
  }

  private scenarioFor(departmentId: string): RecipientScenario {
    return this.scenarioByDepartment[departmentId] ?? this.defaultScenario;
  }

  private static idempotencyBindingKey(context: MutationAdapterCallContext): string {
    return `${context.idempotency_scope}\0${context.idempotency_key}`;
  }

  async deliver(
    submission: RecipientSubmission,
    context: MutationAdapterCallContext,
  ): Promise<AdapterOutcome<RecipientDelivery>> {
    const correlation_id = context.correlation_id;
    const bindingKey = SimulatedDepartmentRecipientAdapter.idempotencyBindingKey(context);
    const existingBinding = this.idempotencyBindings.get(bindingKey);

    if (existingBinding !== undefined) {
      if (existingBinding.requestFingerprint !== context.request_fingerprint) {
        return {
          kind: "rejected",
          reason_code: "idempotency_key_reused_with_different_request",
          retryable: false,
          detail: "the idempotency key is already bound to a different request fingerprint",
          provenance: this.provenance("recipient.delivery.idempotency_conflict"),
          correlation_id,
        };
      }

      const existing = this.deliveries.get(existingBinding.deliveryId);
      return {
        kind: "duplicate",
        reason_code: "already_delivered_for_idempotency_key",
        ...(existing === undefined ? {} : { existing_value: existing.delivery }),
        provenance: this.provenance("recipient.delivery.duplicate"),
        correlation_id,
      };
    }

    const scenario = this.scenarioFor(submission.department_id);

    if (scenario.kind === "unavailable") {
      return {
        kind: "unavailable",
        reason_code: "recipient_channel_unreachable",
        retryable: true,
        retry_after_ms: scenario.retry_after_ms,
        provenance: this.provenance("recipient.delivery.unavailable"),
        correlation_id,
      };
    }

    if (scenario.kind === "reject_routing") {
      return {
        kind: "rejected",
        reason_code: scenario.reason_code,
        retryable: false,
        detail: scenario.detail,
        provenance: this.provenance("recipient.delivery.rejected"),
        correlation_id,
      };
    }

    const deliveryId: Uuid = newUuid();
    const delivery: RecipientDelivery = {
      delivery_id: deliveryId,
      issue_id: submission.issue_id,
      department_id: submission.department_id,
      accepted_at: this.clock(),
      external_reference: `SIM-DELIVERY-${deliveryId.slice(0, 8)}`,
    };

    this.deliveries.set(deliveryId, { delivery, scenario, pollCount: 0 });
    this.idempotencyBindings.set(bindingKey, {
      deliveryId,
      requestFingerprint: context.request_fingerprint,
    });

    return {
      kind: "success",
      value: delivery,
      provenance: this.provenance("recipient.delivery.success"),
      correlation_id,
    };
  }

  async fetchAcknowledgment(
    deliveryId: Uuid,
    context: AdapterCallContext,
  ): Promise<AdapterOutcome<RecipientAcknowledgment>> {
    const correlation_id = context.correlation_id;
    const state = this.deliveries.get(deliveryId);

    if (state === undefined) {
      return {
        kind: "rejected",
        reason_code: "unknown_delivery",
        retryable: false,
        detail: "no simulated delivery exists with that identifier",
        provenance: this.provenance("recipient.acknowledgment.rejected"),
        correlation_id,
      };
    }

    state.pollCount += 1;

    const pending = (reasonCode: string): AdapterOutcome<RecipientAcknowledgment> => ({
      kind: "pending",
      reason_code: reasonCode,
      poll_reference: `${deliveryId}:${String(state.pollCount)}`,
      provenance: this.provenance("recipient.acknowledgment.pending"),
      correlation_id,
    });

    switch (state.scenario.kind) {
      case "never_acknowledge":
        return pending("recipient_has_not_acknowledged");
      case "acknowledge_after_polls":
        if (state.pollCount <= state.scenario.polls) {
          return pending("awaiting_recipient_acknowledgment");
        }
        break;
      case "acknowledge_immediately":
        break;
      case "reject_routing":
      case "unavailable":
        // Delivery never succeeded, so there is nothing to acknowledge.
        return pending("no_successful_delivery_to_acknowledge");
    }

    if (state.acknowledgment === undefined) {
      state.acknowledgment = {
        delivery_id: state.delivery.delivery_id,
        issue_id: state.delivery.issue_id,
        acknowledged_at: this.clock(),
        external_reference: `SIM-ACK-${deliveryId.slice(0, 8)}`,
        note: "simulated acknowledgment — not a real government confirmation",
      };
    }

    return {
      kind: "success",
      value: state.acknowledgment,
      provenance: this.provenance("recipient.acknowledgment.success"),
      correlation_id,
    };
  }
}
