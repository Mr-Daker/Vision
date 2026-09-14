/**
 * Authorization, private-data boundaries and request limits (roadmap V015).
 *
 * Pure policy. Three rules shape everything here:
 *
 *  1. A principal is *derived* from a validated session (V009) — never from a
 *     client-supplied identifier. `derivePrincipal` is the only constructor,
 *     and it takes a session validation result, so a forged participant id in
 *     a request body has no path into an authorization decision.
 *  2. Every read/write is scoped by jurisdiction as well as by role.
 *  3. Public representations are produced by a filter that drops restricted
 *     fields, rather than by remembering to omit them at each call site.
 */

import type { Uuid } from "@vision/contracts";
import type { Participant } from "./entities.ts";

export type Role = "citizen" | "reviewer" | "department_staff" | "supervisor" | "administrator";

/**
 * An authenticated actor. Only `derivePrincipal` may build one, so a principal
 * always corresponds to a session the server itself validated.
 */
export type Principal = {
  readonly role: Role;
  /** Present for citizens; the pseudonymous participant behind the session. */
  readonly participantId?: Uuid;
  /** Present for staff roles; the internal staff account. */
  readonly staffId?: Uuid;
  /** Jurisdictions this principal may act in. Empty for a citizen. */
  readonly jurisdictionScope: readonly string[];
  /**
   * Exact jurisdiction/department pairs a department staff member may operate.
   * Optional for roles that do not work through a department inbox.
   */
  readonly responsibilityScope?: readonly {
    readonly jurisdictionId: string;
    readonly departmentId: string;
  }[];
  readonly sessionId: Uuid;
};

export type SessionDerivation =
  | {
      readonly ok: true;
      readonly sessionId: Uuid;
      readonly participant: Participant;
      /** Server-side role/scope grant, looked up by participant, never sent by the client. */
      readonly grant: {
        readonly role: Role;
        readonly staffId?: Uuid;
        readonly jurisdictionScope?: readonly string[];
        readonly responsibilityScope?: readonly {
          readonly jurisdictionId: string;
          readonly departmentId: string;
        }[];
      };
    }
  | { readonly ok: false };

export class UnauthenticatedError extends Error {}

/**
 * Builds a principal from a validated session plus a server-side grant.
 *
 * Note what is *absent*: any parameter a request body could influence. This is
 * the structural reason a forged principal id cannot be honoured.
 */
export const derivePrincipal = (derivation: SessionDerivation): Principal => {
  if (!derivation.ok) {
    throw new UnauthenticatedError("no valid session; a request body cannot supply a principal");
  }
  const { grant } = derivation;
  const isStaffRole = grant.role !== "citizen";

  if (isStaffRole && grant.staffId === undefined) {
    throw new UnauthenticatedError(`role '${grant.role}' requires a staff account`);
  }
  if (
    isStaffRole &&
    (grant.jurisdictionScope ?? []).length === 0 &&
    grant.role !== "administrator"
  ) {
    throw new UnauthenticatedError(`role '${grant.role}' requires a jurisdiction scope`);
  }
  if (grant.role === "department_staff" && (grant.responsibilityScope ?? []).length === 0) {
    throw new UnauthenticatedError(
      "role 'department_staff' requires a jurisdiction and department responsibility scope",
    );
  }

  return {
    role: grant.role,
    ...(grant.role === "citizen" ? { participantId: derivation.participant.participant_id } : {}),
    ...(grant.staffId === undefined ? {} : { staffId: grant.staffId }),
    jurisdictionScope: grant.jurisdictionScope ?? [],
    ...(grant.responsibilityScope === undefined
      ? {}
      : { responsibilityScope: grant.responsibilityScope }),
    sessionId: derivation.sessionId,
  };
};

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

export type Action =
  | "submission.create"
  | "submission.read_own"
  | "issue.read_public"
  | "issue.read_private"
  | "issue.transition"
  | "evidence.read_redacted"
  | "evidence.read_original"
  | "evidence.redaction_decide"
  | "match.review"
  | "assignment.write"
  | "resolution.claim"
  | "resolution.confirm"
  | "identity_mapping.read"
  | "audit.read"
  | "configuration.write";

export type ResourceContext = {
  /** Jurisdiction the resource belongs to, when it has one. */
  readonly jurisdictionId?: string;
  /** Participant that owns the resource, for own-resource reads. */
  readonly ownerParticipantId?: Uuid;
  /** Named purpose for an exceptional access, e.g. a redaction dispute. */
  readonly exceptionalAccessPurpose?: string;
};

export type Decision =
  | { readonly allowed: true; readonly auditRequired: boolean }
  | { readonly allowed: false; readonly reason: string };

const ROLE_ACTIONS: Readonly<Record<Role, readonly Action[]>> = {
  citizen: [
    "submission.create",
    "submission.read_own",
    "issue.read_public",
    "evidence.read_redacted",
    "resolution.confirm",
  ],
  reviewer: [
    "issue.read_public",
    "issue.read_private",
    "evidence.read_redacted",
    "evidence.read_original",
    "evidence.redaction_decide",
    "match.review",
    "issue.transition",
    "resolution.confirm",
  ],
  department_staff: [
    "issue.read_public",
    "issue.read_private",
    "evidence.read_redacted",
    "evidence.read_original",
    "issue.transition",
    "assignment.write",
    "resolution.claim",
  ],
  supervisor: [
    "issue.read_public",
    "issue.read_private",
    "evidence.read_redacted",
    "assignment.write",
  ],
  administrator: ["issue.read_public", "configuration.write", "audit.read"],
};

/** Actions no role may ever perform through the application. */
const NEVER_PERMITTED: readonly Action[] = ["identity_mapping.read"];

/** Actions that are permitted only with a named purpose, and always audited. */
const EXCEPTIONAL: readonly Action[] = ["evidence.read_original"];

const JURISDICTION_SCOPED: readonly Action[] = [
  "issue.read_private",
  "issue.transition",
  "assignment.write",
  "resolution.claim",
  "evidence.read_original",
  "evidence.redaction_decide",
  "match.review",
];

export const authorize = (
  principal: Principal,
  action: Action,
  resource: ResourceContext = {},
): Decision => {
  // The identity mapping is reachable only by the identity service, which is
  // not an application principal at all (V005 §3).
  if (NEVER_PERMITTED.includes(action)) {
    return { allowed: false, reason: `${action} is not reachable by any application role` };
  }

  if (!ROLE_ACTIONS[principal.role].includes(action)) {
    return { allowed: false, reason: `role '${principal.role}' may not ${action}` };
  }

  // Own-resource reads must actually be the principal's own.
  if (action === "submission.read_own") {
    if (principal.participantId === undefined) {
      return { allowed: false, reason: "only a citizen principal has own submissions" };
    }
    if (resource.ownerParticipantId !== principal.participantId) {
      return { allowed: false, reason: "a citizen may only read their own submission" };
    }
  }

  if (JURISDICTION_SCOPED.includes(action)) {
    if (resource.jurisdictionId === undefined) {
      return { allowed: false, reason: `${action} requires a jurisdiction-scoped resource` };
    }
    const inScope =
      principal.role === "administrator" ||
      principal.jurisdictionScope.includes(resource.jurisdictionId);
    if (!inScope) {
      return {
        allowed: false,
        reason: `jurisdiction '${resource.jurisdictionId}' is outside this principal's scope`,
      };
    }
  }

  if (EXCEPTIONAL.includes(action)) {
    const purpose = resource.exceptionalAccessPurpose?.trim() ?? "";
    if (purpose.length < 8) {
      return {
        allowed: false,
        reason: `${action} is exceptional and requires a recorded purpose`,
      };
    }
    return { allowed: true, auditRequired: true };
  }

  return { allowed: true, auditRequired: false };
};

// ---------------------------------------------------------------------------
// Public versus authorized-private representation
// ---------------------------------------------------------------------------

export type IssueRecord = {
  readonly issue_id: string;
  readonly public_reference: string;
  readonly category: string;
  readonly current_status: string;
  readonly jurisdiction_id: string;
  readonly precise_location?: { readonly lon: number; readonly lat: number };
  readonly coarse_location?: { readonly lon: number; readonly lat: number };
  readonly counted_participants: number;
  readonly reporter_participant_id?: string;
  readonly original_object_references?: readonly string[];
  readonly approved_derivative_references?: readonly string[];
  readonly raw_model_output?: Readonly<Record<string, unknown>>;
};

export type PublicIssueView = {
  readonly public_reference: string;
  readonly category: string;
  readonly current_status: string;
  readonly jurisdiction_id: string;
  readonly coarse_location?: { readonly lon: number; readonly lat: number };
  readonly counted_participants: number;
  readonly approved_derivative_references: readonly string[];
};

/**
 * Builds the public view by construction rather than by deletion, so a new
 * restricted field added upstream is excluded by default instead of leaking
 * until someone remembers to filter it (V005 §7).
 */
export const toPublicIssueView = (record: IssueRecord): PublicIssueView => ({
  public_reference: record.public_reference,
  category: record.category,
  current_status: record.current_status,
  jurisdiction_id: record.jurisdiction_id,
  ...(record.coarse_location === undefined ? {} : { coarse_location: record.coarse_location }),
  counted_participants: record.counted_participants,
  approved_derivative_references: record.approved_derivative_references ?? [],
});

/** Field names that must never appear in a public representation. */
export const PUBLIC_FORBIDDEN_FIELDS: readonly string[] = [
  "precise_location",
  "reporter_participant_id",
  "original_object_references",
  "raw_model_output",
  "issue_id",
];

/** Returns forbidden fields present in a candidate public payload. */
export const findPublicLeaks = (payload: Readonly<Record<string, unknown>>): readonly string[] =>
  PUBLIC_FORBIDDEN_FIELDS.filter((field) => Object.hasOwn(payload, field));

// ---------------------------------------------------------------------------
// Quotas and request limits
// ---------------------------------------------------------------------------

export type QuotaWindow = {
  readonly limit: number;
  readonly windowSeconds: number;
};

export type QuotaPolicy = Readonly<Record<string, QuotaWindow>>;

/** Conservative demonstration defaults; owner-tunable per V005/V049. */
export const DEFAULT_QUOTAS: QuotaPolicy = {
  "submission.create": { limit: 10, windowSeconds: 3600 },
  "upload.grant": { limit: 30, windowSeconds: 3600 },
  "resolution.confirm": { limit: 20, windowSeconds: 3600 },
};

export type QuotaUsage = {
  /** Timestamps (ms) of prior accepted requests for this principal and action. */
  readonly recentAtMs: readonly number[];
};

export type QuotaDecision =
  | { readonly allowed: true; readonly remaining: number }
  | {
      readonly allowed: false;
      readonly reason: "quota_exceeded";
      /** Actionable: how long until the caller may retry (V015 requirement). */
      readonly retryAfterMs: number;
      readonly limit: number;
      readonly windowSeconds: number;
    };

/**
 * Sliding-window quota check. Returns a concrete retry delay rather than a
 * bare rejection, so a client can behave correctly instead of hammering.
 */
export const checkQuota = (
  action: string,
  usage: QuotaUsage,
  nowMs: number,
  policy: QuotaPolicy = DEFAULT_QUOTAS,
): QuotaDecision => {
  const window = policy[action];
  if (window === undefined) {
    return { allowed: true, remaining: Number.POSITIVE_INFINITY };
  }

  const windowMs = window.windowSeconds * 1000;
  const inWindow = usage.recentAtMs.filter((at) => at > nowMs - windowMs).sort((a, b) => a - b);

  if (inWindow.length < window.limit) {
    return { allowed: true, remaining: window.limit - inWindow.length };
  }

  // The oldest request in the window is the one whose expiry frees a slot.
  const oldest = inWindow[0]!;
  return {
    allowed: false,
    reason: "quota_exceeded",
    retryAfterMs: Math.max(1, oldest + windowMs - nowMs),
    limit: window.limit,
    windowSeconds: window.windowSeconds,
  };
};
