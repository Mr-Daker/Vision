/**
 * Shared primitive types and validators (roadmap V008).
 *
 * Contract note: identifiers are branded so a submission id cannot be passed
 * where a participant id is expected. Validation is explicit and returns a
 * Result rather than throwing, because adapter boundaries must be able to
 * report a rejected input as data (see outcomes.ts).
 */

export const CONTRACT_VERSION = "1.0.0" as const;

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type Uuid = Brand<string, "Uuid">;
export type IsoTimestamp = Brand<string, "IsoTimestamp">;
export type Bcp47 = Brand<string, "Bcp47">;
export type IdempotencyKey = Brand<string, "IdempotencyKey">;
export type IdempotencyScope = Brand<string, "IdempotencyScope">;
export type RequestFingerprint = Brand<string, "RequestFingerprint">;
export type CorrelationId = Brand<string, "CorrelationId">;

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export type FieldIssue = { field: string; code: string; detail: string };

const issue = (field: string, code: string, detail: string): FieldIssue => ({
  field,
  code,
  detail,
});

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * BCP 47 subset actually used by the locale packs: language, optional script,
 * optional region. Deliberately not a full RFC 5646 parser — the packs declare
 * their supported tags and unknown tags must fail closed (V003 §8).
 */
const BCP47_PATTERN = /^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|\d{3}))?$/;

export const parseUuid = (raw: string, field = "id"): Result<Uuid, FieldIssue> =>
  UUID_PATTERN.test(raw)
    ? ok(raw as Uuid)
    : err(issue(field, "invalid_uuid", "expected a canonical UUID"));

const RFC3339_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?([Zz]|([+-])(\d{2}):(\d{2}))$/;

const isLeapYear = (year: number): boolean =>
  year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);

const daysInMonth = (year: number, month: number): number => {
  const days = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return days[month - 1] ?? 0;
};

/**
 * Parses the application timestamp profile: a complete RFC 3339 date-time with
 * an explicit UTC designator or numeric offset. Leap seconds are deliberately
 * rejected because JavaScript date arithmetic cannot preserve them reliably.
 */
export const parseIsoTimestamp = (
  raw: string,
  field = "timestamp",
): Result<IsoTimestamp, FieldIssue> => {
  const match = RFC3339_PATTERN.exec(raw);
  if (match === null) {
    return err(
      issue(
        field,
        "invalid_timestamp",
        "expected a complete RFC 3339 timestamp with an explicit UTC offset",
      ),
    );
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[9] === undefined ? 0 : Number(match[9]);
  const offsetMinute = match[10] === undefined ? 0 : Number(match[10]);

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59 ||
    Number.isNaN(Date.parse(raw))
  ) {
    return err(issue(field, "invalid_timestamp", "timestamp contains an invalid date or time"));
  }

  return ok(raw as IsoTimestamp);
};

export const parseBcp47 = (raw: string, field = "locale"): Result<Bcp47, FieldIssue> =>
  BCP47_PATTERN.test(raw)
    ? ok(raw as Bcp47)
    : err(issue(field, "invalid_locale", "expected a BCP 47 tag such as en-IN"));

/**
 * Idempotency keys are client-generated. They are bounded and opaque; the
 * server binds them to (actor, endpoint, request hash) per V008.
 */
export const parseIdempotencyKey = (
  raw: string,
  field = "idempotency_key",
): Result<IdempotencyKey, FieldIssue> => {
  if (raw.length < 8 || raw.length > 128) {
    return err(issue(field, "invalid_length", "idempotency key must be 8-128 characters"));
  }
  if (!/^[A-Za-z0-9._:-]+$/.test(raw)) {
    return err(issue(field, "invalid_characters", "idempotency key must be URL-safe"));
  }
  return ok(raw as IdempotencyKey);
};

/**
 * Server-derived idempotency namespace, normally actor/tenant plus operation.
 * Keeping it separate from the client key prevents unrelated operations from
 * colliding even when a client happens to reuse the same opaque key.
 */
export const parseIdempotencyScope = (
  raw: string,
  field = "idempotency_scope",
): Result<IdempotencyScope, FieldIssue> => {
  if (raw.length < 3 || raw.length > 256) {
    return err(issue(field, "invalid_length", "idempotency scope must be 3-256 characters"));
  }
  if (!/^[A-Za-z0-9._:/-]+$/.test(raw)) {
    return err(issue(field, "invalid_characters", "idempotency scope must be URL-safe"));
  }
  return ok(raw as IdempotencyScope);
};

/** SHA-256 of the server-canonicalized operation request. */
export const parseRequestFingerprint = (
  raw: string,
  field = "request_fingerprint",
): Result<RequestFingerprint, FieldIssue> =>
  /^sha256:[0-9a-f]{64}$/i.test(raw)
    ? ok(raw.toLowerCase() as RequestFingerprint)
    : err(issue(field, "invalid_request_fingerprint", "expected sha256:<64 hexadecimal digits>"));

export const parseCorrelationId = (
  raw: string,
  field = "correlation_id",
): Result<CorrelationId, FieldIssue> => {
  const parsed = parseUuid(raw, field);
  return parsed.ok ? ok(parsed.value as string as CorrelationId) : err(parsed.error);
};

/** Test/fixture helper. Never use on unvalidated input. */
export const unsafeUuid = (raw: string): Uuid => raw as Uuid;
export const unsafeTimestamp = (raw: string): IsoTimestamp => raw as IsoTimestamp;
export const unsafeBcp47 = (raw: string): Bcp47 => raw as Bcp47;
export const unsafeCorrelationId = (raw: string): CorrelationId => raw as CorrelationId;
export const unsafeIdempotencyKey = (raw: string): IdempotencyKey => raw as IdempotencyKey;
export const unsafeIdempotencyScope = (raw: string): IdempotencyScope => raw as IdempotencyScope;
export const unsafeRequestFingerprint = (raw: string): RequestFingerprint =>
  raw as RequestFingerprint;

export const newUuid = (): Uuid => crypto.randomUUID() as Uuid;
export const newCorrelationId = (): CorrelationId => crypto.randomUUID() as CorrelationId;
export const nowIso = (): IsoTimestamp => new Date().toISOString() as IsoTimestamp;
