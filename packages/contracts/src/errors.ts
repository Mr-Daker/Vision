/**
 * Versioned API error envelope (roadmap V008).
 *
 * Error codes are stable, machine-readable, and deliberately coarse. Detail
 * strings are safe to show a caller: they must never contain another citizen's
 * evidence, a provider identity reference, a session token, exact coordinates,
 * or a secret (V005 §8).
 */

import type { CorrelationId, FieldIssue } from "./primitives.ts";

export type ErrorCode =
  | "validation_failed"
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "version_conflict"
  | "idempotency_key_reused"
  | "quota_exceeded"
  | "rate_limited"
  | "consent_required"
  | "dependency_unavailable"
  | "unsupported_locale"
  | "unsupported_contract_version"
  | "internal_error";

/** HTTP status mapping kept beside the codes so transports cannot drift. */
export const ERROR_STATUS: Readonly<Record<ErrorCode, number>> = {
  validation_failed: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  version_conflict: 409,
  idempotency_key_reused: 409,
  quota_exceeded: 429,
  rate_limited: 429,
  consent_required: 403,
  dependency_unavailable: 503,
  unsupported_locale: 400,
  unsupported_contract_version: 400,
  internal_error: 500,
} as const;

export type ApiError = {
  readonly error: {
    readonly code: ErrorCode;
    /** Caller-safe summary. Not localized copy; the client localizes by code. */
    readonly message: string;
    readonly correlation_id: CorrelationId;
    readonly contract_version: string;
    readonly issues?: readonly FieldIssue[];
    /** Present when the caller can usefully retry. */
    readonly retry_after_ms?: number;
  };
};

export const isRetryableError = (code: ErrorCode): boolean =>
  code === "dependency_unavailable" || code === "rate_limited" || code === "internal_error";
