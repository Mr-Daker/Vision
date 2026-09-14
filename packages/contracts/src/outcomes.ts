/**
 * Provider-adapter outcome and provenance contracts (roadmap V008).
 *
 * Two rules are enforced by the type system here, because both are claims the
 * project has committed never to blur:
 *
 *  1. Every adapter response carries provenance saying whether it came from a
 *     simulated fixture or an authenticated external system
 *     (V002 rows 1 and 16, V008 "done when").
 *  2. A provenance value cannot be both simulated and
 *     `authenticated_external`; the union makes that combination
 *     unrepresentable. Shared adapter suites separately verify descriptor and
 *     returned-provenance alignment.
 */

import type { CorrelationId, IsoTimestamp } from "./primitives.ts";

/** Configured mode of a provider integration. */
export type ProviderMode = "simulated" | "real" | "stub";

/**
 * How much authority a response actually carries.
 *
 * - `simulated_fixture`: produced by our own fixture/stub. Proves nothing about
 *   any external system.
 * - `authenticated_external`: received from a real external system whose
 *   identity we verified (signature, mTLS, or provider-authenticated channel),
 *   and which returned a provider-side reference.
 * - `unauthenticated_external`: a real external system replied, but the
 *   response was not authenticated. It must never be presented as an official
 *   confirmation.
 */
export type Authenticity =
  "simulated_fixture" | "authenticated_external" | "unauthenticated_external";

export type SimulatedProvenance = {
  readonly provider_mode: "simulated" | "stub";
  readonly authenticity: "simulated_fixture";
  readonly provider_name: string;
  readonly observed_at: IsoTimestamp;
  /** Identifier of the fixture that produced this response, for traceability. */
  readonly fixture_id: string;
};

export type AuthenticatedExternalProvenance = {
  readonly provider_mode: "real";
  readonly authenticity: "authenticated_external";
  readonly provider_name: string;
  readonly observed_at: IsoTimestamp;
  /** Provider-side reference proving the remote system handled the request. */
  readonly provider_request_id: string;
  readonly authentication_method: "signature" | "mtls" | "provider_authenticated_channel";
};

export type UnauthenticatedExternalProvenance = {
  readonly provider_mode: "real";
  readonly authenticity: "unauthenticated_external";
  readonly provider_name: string;
  readonly observed_at: IsoTimestamp;
  readonly provider_request_id?: string;
};

export type Provenance =
  SimulatedProvenance | AuthenticatedExternalProvenance | UnauthenticatedExternalProvenance;

/**
 * True only when a response may be described to a user as confirmed by an
 * external authority. Everything else is internal state or a simulation.
 * V002 row 16 forbids presenting anything else as government acknowledgment.
 */
export const carriesExternalAuthority = (provenance: Provenance): boolean =>
  provenance.authenticity === "authenticated_external";

/** The six outcome kinds every provider adapter must be able to express. */
export type OutcomeKind =
  "success" | "unavailable" | "pending" | "rejected" | "duplicate" | "ambiguous";

export const OUTCOME_KINDS: readonly OutcomeKind[] = [
  "success",
  "unavailable",
  "pending",
  "rejected",
  "duplicate",
  "ambiguous",
] as const;

type Base = { readonly provenance: Provenance; readonly correlation_id: CorrelationId };

/** The operation completed and `value` is authoritative for its provenance. */
export type SuccessOutcome<T> = Base & { readonly kind: "success"; readonly value: T };

/** The provider could not be reached or failed transiently. Retryable. */
export type UnavailableOutcome = Base & {
  readonly kind: "unavailable";
  readonly reason_code: string;
  readonly retryable: true;
  readonly retry_after_ms?: number;
};

/** Accepted but not decided yet. Never a success and never a failure. */
export type PendingOutcome = Base & {
  readonly kind: "pending";
  readonly reason_code: string;
  /** Provider-side handle for later reconciliation, when the provider issues one. */
  readonly poll_reference?: string;
};

/** The provider actively refused. Not retryable without a changed request. */
export type RejectedOutcome = Base & {
  readonly kind: "rejected";
  readonly reason_code: string;
  readonly retryable: false;
  readonly detail: string;
};

/** The provider recognised this request as one it has already handled. */
export type DuplicateOutcome<T> = Base & {
  readonly kind: "duplicate";
  readonly reason_code: string;
  /** The previously committed result, when the provider can return it. */
  readonly existing_value?: T;
};

/** The provider returned something that requires a human decision. */
export type AmbiguousOutcome<T> = Base & {
  readonly kind: "ambiguous";
  readonly reason_code: string;
  readonly candidates: readonly T[];
  readonly requires_review: true;
};

export type AdapterOutcome<T> =
  | SuccessOutcome<T>
  | UnavailableOutcome
  | PendingOutcome
  | RejectedOutcome
  | DuplicateOutcome<T>
  | AmbiguousOutcome<T>;

/**
 * Narrowing helper. Deliberately does NOT treat `duplicate` as success: a
 * duplicate means no new effect occurred, which callers must handle explicitly
 * (V003 idempotency rules).
 */
export const isSuccess = <T>(outcome: AdapterOutcome<T>): outcome is SuccessOutcome<T> =>
  outcome.kind === "success";

export const isRetryable = <T>(outcome: AdapterOutcome<T>): boolean =>
  outcome.kind === "unavailable";
