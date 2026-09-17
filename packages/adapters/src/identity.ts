/**
 * Simulated identity adapter and identity resolution service (roadmap V009).
 *
 * Two separate things live here:
 *
 *  - `SimulatedIdentityAdapter` implements the V008 `IdentityProviderAdapter`
 *    port using fixed demo principals. It requires no network call and no
 *    provider approval, and it can only ever return simulated provenance.
 *  - `IdentityService` turns a provider assertion into a stable pseudonymous
 *    `Participant`. It keyed-hashes the provider subject immediately, so the
 *    raw provider reference never reaches the application domain, a log, an
 *    event, or the AI path (V003 IdentityMapping, V005 §2).
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import {
  newUuid,
  nowIso,
  type AdapterCallContext,
  type AdapterDescriptor,
  type AdapterOutcome,
  type CapabilityDescriptor,
  type IdentityAssertion,
  type IdentityChallenge,
  type IdentityProviderAdapter,
  type IsoTimestamp,
  type Uuid,
} from "@vision/contracts";
import type { IdentityMapping, Participant } from "@vision/domain";

import type { IdentityMappingRepository, ParticipantRepository } from "./ports.ts";

export const SIMULATED_IDENTITY_PROVIDER = "simulated-identity";

/**
 * Capability metadata for the identity provider. The display label states that
 * identity is simulated, which V002 row 1 requires wherever it is surfaced.
 */
export const SIMULATED_IDENTITY_CAPABILITY: CapabilityDescriptor = {
  capability: "citizen_identity",
  provider_name: SIMULATED_IDENTITY_PROVIDER,
  provider_mode: "simulated",
  display_label: "Simulated demonstration identity — not a real identity check",
  v002_row: 1,
  may_claim: ["This is a simulated demo account", "Your session expired or you were logged out"],
  must_not_claim: [
    "Verified real citizen identity",
    "DigiLocker-verified",
    "Session logout or expiry affected the underlying participant",
  ],
};

/** A fixed demo principal. Credentials are non-secret demonstration values. */
export type DemoPrincipal = {
  readonly credential: string;
  readonly provider_subject_reference: string;
  readonly issuer: string;
  readonly credential_state: "active" | "revoked" | "expired";
  readonly label: string;
  /** Which application login surface may offer this fixture. */
  readonly account_type: "citizen" | "reviewer" | "department_staff" | "supervisor";
};

/**
 * Fixed demo principals. Deliberately generic: no real person, and no
 * jurisdiction- or language-specific literal, so the CI scope check
 * (V001 Appendix G rule 7) stays satisfied.
 */
export const DEMO_PRINCIPALS: readonly DemoPrincipal[] = [
  {
    credential: "demo-citizen-one",
    provider_subject_reference: "demo-subject-0001",
    issuer: "vision-simulated-demo-issuer",
    credential_state: "active",
    label: "Demo citizen 1",
    account_type: "citizen",
  },
  {
    credential: "demo-citizen-two",
    provider_subject_reference: "demo-subject-0002",
    issuer: "vision-simulated-demo-issuer",
    credential_state: "active",
    label: "Demo citizen 2",
    account_type: "citizen",
  },
  {
    credential: "demo-reviewer-one",
    provider_subject_reference: "demo-subject-0003",
    issuer: "vision-simulated-demo-issuer",
    credential_state: "active",
    label: "Demo evidence reviewer 1",
    account_type: "reviewer",
  },
  {
    credential: "demo-staff-one",
    provider_subject_reference: "demo-subject-0004",
    issuer: "vision-simulated-demo-issuer",
    credential_state: "active",
    label: "Demo department staff 1",
    account_type: "department_staff",
  },
  {
    credential: "demo-supervisor-one",
    provider_subject_reference: "demo-subject-0007",
    issuer: "vision-simulated-demo-issuer",
    credential_state: "active",
    label: "Demo supervisor 1",
    account_type: "supervisor",
  },
  {
    credential: "demo-revoked-one",
    provider_subject_reference: "demo-subject-0005",
    issuer: "vision-simulated-demo-issuer",
    credential_state: "revoked",
    label: "Revoked demo credential (negative test)",
    account_type: "citizen",
  },
  {
    credential: "demo-expired-one",
    provider_subject_reference: "demo-subject-0006",
    issuer: "vision-simulated-demo-issuer",
    credential_state: "expired",
    label: "Expired demo credential (negative test)",
    account_type: "citizen",
  },
] as const;

/**
 * Principals accepted by the current application login endpoint.
 *
 * The endpoint derives citizen permissions for every accepted session. A
 * reserved staff fixture must therefore stay out until a server-side staff
 * grant and staff surface exist; accepting it here would turn only its label
 * into "staff" while retaining citizen authority.
 */
export const demoCitizenPrincipals = (): readonly DemoPrincipal[] =>
  DEMO_PRINCIPALS.filter((principal) => principal.account_type === "citizen");

/** Principals accepted only by the private reviewer login surface (V032). */
export const demoReviewerPrincipals = (): readonly DemoPrincipal[] =>
  DEMO_PRINCIPALS.filter((principal) => principal.account_type === "reviewer");

/** Principals accepted only by the private department-staff surface (V034). */
export const demoDepartmentStaffPrincipals = (): readonly DemoPrincipal[] =>
  DEMO_PRINCIPALS.filter((principal) => principal.account_type === "department_staff");

/** Principals accepted only by the private supervisor surface (V036). */
export const demoSupervisorPrincipals = (): readonly DemoPrincipal[] =>
  DEMO_PRINCIPALS.filter((principal) => principal.account_type === "supervisor");

export class SimulatedIdentityAdapter implements IdentityProviderAdapter {
  readonly descriptor: AdapterDescriptor = {
    provider_name: SIMULATED_IDENTITY_PROVIDER,
    provider_mode: "simulated",
    capability: SIMULATED_IDENTITY_CAPABILITY,
  };

  private readonly principals: readonly DemoPrincipal[];

  constructor(principals: readonly DemoPrincipal[] = DEMO_PRINCIPALS) {
    this.principals = principals;
  }

  async authenticate(
    challenge: IdentityChallenge,
    context: AdapterCallContext,
  ): Promise<AdapterOutcome<IdentityAssertion>> {
    const observedAt = nowIso();
    const provenance = {
      provider_mode: "simulated",
      authenticity: "simulated_fixture",
      provider_name: SIMULATED_IDENTITY_PROVIDER,
      observed_at: observedAt,
      fixture_id: "demo-principal:authentication-attempt",
    } as const;

    const principal = this.principals.find(
      (candidate) => candidate.credential === challenge.credential,
    );

    if (principal === undefined) {
      return {
        kind: "rejected",
        reason_code: "unknown_demo_credential",
        retryable: false,
        detail: "the supplied demonstration credential is not a configured demo principal",
        provenance,
        correlation_id: context.correlation_id,
      };
    }

    if (principal.credential_state !== "active") {
      return {
        kind: "rejected",
        reason_code: `demo_credential_${principal.credential_state}`,
        retryable: false,
        detail: `the configured demonstration credential is ${principal.credential_state}`,
        provenance: {
          ...provenance,
          fixture_id: `demo-principal:${principal.provider_subject_reference}:${principal.credential_state}`,
        },
        correlation_id: context.correlation_id,
      };
    }

    return {
      kind: "success",
      value: {
        provider: SIMULATED_IDENTITY_PROVIDER,
        provider_subject_reference: principal.provider_subject_reference,
        issuer: principal.issuer,
        credential_state: { state: "active", checked_at: observedAt },
        assurance_label: "simulated demonstration credential",
        asserted_at: observedAt,
      },
      provenance,
      correlation_id: context.correlation_id,
    };
  }
}

export type IdentityResolution = {
  readonly participant: Participant;
  /** True when this call created the participant rather than reusing one. */
  readonly created: boolean;
};

export type InactiveIdentityReason =
  "credential_revoked" | "credential_expired" | "mapping_disabled" | "mapping_erased";

export class InactiveIdentityError extends Error {
  readonly reason: InactiveIdentityReason;

  constructor(reason: InactiveIdentityReason) {
    super(`identity cannot be used: ${reason}`);
    this.name = "InactiveIdentityError";
    this.reason = reason;
  }
}

/**
 * Resolves provider assertions to stable participants.
 *
 * The HMAC key is an L3c secret (V005 §1). It is required: there is no default,
 * because a default would silently make every deployment's hashes identical.
 */
export class IdentityService {
  private readonly participants: ParticipantRepository;
  private readonly mappings: IdentityMappingRepository;
  private readonly providerSubjectHmacKey: string;
  private readonly clock: () => IsoTimestamp;
  /** Per-subject single-flight guard for the V009 in-memory implementation. */
  private readonly resolutionTails = new Map<string, Promise<void>>();

  constructor(
    participants: ParticipantRepository,
    mappings: IdentityMappingRepository,
    providerSubjectHmacKey: string,
    clock: () => IsoTimestamp = nowIso,
  ) {
    if (providerSubjectHmacKey.length === 0) {
      throw new Error("IDENTITY_MAPPING_HMAC_KEY must be configured");
    }
    this.participants = participants;
    this.mappings = mappings;
    this.providerSubjectHmacKey = providerSubjectHmacKey;
    this.clock = clock;
  }

  /**
   * Keyed hash of a provider subject reference. Keyed rather than plain so the
   * stored value is not brute-forceable from a known subject-id space, and so
   * one environment's mappings cannot be correlated with another's.
   */
  hashProviderSubject(provider: string, providerSubjectReference: string): string {
    return createHmac("sha256", this.providerSubjectHmacKey)
      .update(`${provider} ${providerSubjectReference}`)
      .digest("hex");
  }

  /**
   * Repeated authentication for the same provider subject resolves to the same
   * participant — the V009 uniqueness requirement — because the mapping is
   * keyed on the subject hash, not on the session.
   */
  async resolveParticipant(assertion: IdentityAssertion): Promise<IdentityResolution> {
    if (assertion.credential_state.state !== "active") {
      throw new InactiveIdentityError(
        assertion.credential_state.state === "revoked"
          ? "credential_revoked"
          : "credential_expired",
      );
    }

    const providerSubjectHash = this.hashProviderSubject(
      assertion.provider,
      assertion.provider_subject_reference,
    );

    return this.withSubjectLock(`${assertion.provider}\u0000${providerSubjectHash}`, async () => {
      const existing = await this.mappings.findByProviderSubject(
        assertion.provider,
        providerSubjectHash,
      );

      if (existing !== undefined) {
        if (existing.erased_at !== undefined) {
          throw new InactiveIdentityError("mapping_erased");
        }
        if (existing.disabled_at !== undefined) {
          throw new InactiveIdentityError("mapping_disabled");
        }

        const participant = await this.participants.findById(existing.participant_id);
        if (participant === undefined) {
          throw new Error("identity mapping references a missing participant");
        }
        return { participant, created: false };
      }

      const createdAt = this.clock();
      const participant = await this.participants.create({
        participant_id: newUuid(),
        created_at: createdAt,
      });

      const mapping: IdentityMapping = {
        identity_mapping_id: newUuid(),
        participant_id: participant.participant_id,
        provider: assertion.provider,
        provider_subject_hash: providerSubjectHash,
        provider_mode: "simulated",
        created_at: createdAt,
      };
      await this.mappings.create(mapping);

      return { participant, created: true };
    });
  }

  private async withSubjectLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const predecessor = this.resolutionTails.get(key) ?? Promise.resolve();
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = predecessor.then(() => gate);
    this.resolutionTails.set(key, tail);

    await predecessor;
    try {
      return await operation();
    } finally {
      release();
      if (this.resolutionTails.get(key) === tail) {
        this.resolutionTails.delete(key);
      }
    }
  }

  /** Constant-time comparison helper for callers verifying a stored hash. */
  static hashesMatch(left: string, right: string): boolean {
    const a = Buffer.from(left, "utf8");
    const b = Buffer.from(right, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
  }
}

/** Convenience for tests and the demo login screen. Contains no secret. */
export const demoPrincipalLabels = (): readonly {
  credential: string;
  label: string;
  credential_state: DemoPrincipal["credential_state"];
  issuer: string;
}[] =>
  demoCitizenPrincipals().map((principal) => ({
    credential: principal.credential,
    label: principal.label,
    credential_state: principal.credential_state,
    issuer: principal.issuer,
  }));

export type { Uuid };
