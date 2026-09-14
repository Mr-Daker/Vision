/**
 * Request/response and domain-event envelopes (roadmap V008).
 *
 * Every envelope carries a contract version, a correlation id, and both event
 * time and ingestion time where those differ (V003 §3, V006 §7).
 */

import type {
  CorrelationId,
  IdempotencyKey,
  IdempotencyScope,
  IsoTimestamp,
  RequestFingerprint,
  Uuid,
} from "./primitives.ts";

export type ActorType =
  "citizen" | "staff" | "reviewer" | "supervisor" | "administrator" | "system_worker";

export type RequestEnvelope<T> = {
  readonly contract_version: string;
  readonly correlation_id: CorrelationId;
  readonly client_sent_at?: IsoTimestamp;
  readonly body: T;
};

/**
 * A state-changing request after the server has bound the caller's opaque key
 * to a trusted scope and canonical request fingerprint. All three fields are
 * required: the key alone cannot detect reuse for a different actor, operation,
 * or body (V008).
 */
export type MutationRequestEnvelope<T> = RequestEnvelope<T> & {
  readonly idempotency_key: IdempotencyKey;
  readonly idempotency_scope: IdempotencyScope;
  readonly request_fingerprint: RequestFingerprint;
};

export type ResponseEnvelope<T> = {
  readonly contract_version: string;
  readonly correlation_id: CorrelationId;
  readonly server_time: IsoTimestamp;
  readonly body: T;
};

/**
 * Domain-event envelope. The payload is restricted to identifiers, enum values,
 * reason codes and version strings — never evidence content, descriptions,
 * transcripts, exact coordinates, provider identity references, or secrets
 * (V003 StatusEvent constraints, V005 §8).
 */
export type EventEnvelope = {
  readonly event_id: Uuid;
  readonly aggregate_type: string;
  readonly aggregate_id: string;
  readonly aggregate_version: number;
  readonly event_type: string;
  readonly actor_type: ActorType;
  /** Restricted internal pseudonym; never published in a public timeline. */
  readonly actor_pseudonym?: Uuid;
  readonly correlation_id: CorrelationId;
  readonly occurred_at: IsoTimestamp;
  readonly recorded_at: IsoTimestamp;
  readonly payload_schema_version: string;
  readonly payload: Readonly<Record<string, JsonScalar | readonly JsonScalar[]>>;
};

export type JsonScalar = string | number | boolean | null;

/**
 * Keys that must never appear in an event payload. This is a defence in depth
 * check: the payload type already forbids nested objects, but a caller can
 * still put a transcript in a string field.
 */
const FORBIDDEN_PAYLOAD_KEYS = [
  "transcript",
  "transcript_text",
  "description",
  "content_text",
  "object_reference",
  "provider_subject_reference",
  "token",
  "token_hash",
  "session_token",
  "api_key",
  "secret",
  "password",
  "latitude",
  "longitude",
  "coordinates",
  "precise_location",
] as const;

/**
 * Returns the forbidden keys present in a payload. Used by a contract test and
 * by the event writer so a privacy violation fails closed instead of being
 * discovered in a log review.
 */
export const findForbiddenPayloadKeys = (
  payload: Readonly<Record<string, unknown>>,
): readonly string[] => {
  const lowerKeys = Object.keys(payload).map((key) => key.toLowerCase());
  return FORBIDDEN_PAYLOAD_KEYS.filter((forbidden) =>
    lowerKeys.some((key) => key === forbidden || key.endsWith(`_${forbidden}`)),
  );
};
