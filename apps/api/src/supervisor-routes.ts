/**
 * Authenticated supervisor HTTP surface (roadmap V036).
 *
 * The role and its jurisdiction scope come from a durable server-side grant
 * after the session is validated, never from a request body — the same rule
 * V032 and V034 follow for reviewers and department staff.
 *
 * Two things this surface deliberately does not do:
 *
 * **The queue read never writes.** Ageing alerts are raised by the worker
 * sweep, not as a side effect of somebody opening a page. A GET that raised
 * alerts would make "when did this alert fire" mean "when did a supervisor
 * happen to look", which is not a clock.
 *
 * **Nothing here sends anything.** Every payload carries the note saying these
 * alerts are internal records in a demonstration and were not delivered to any
 * official or external system. V036 requires that to be true; V070 is the task
 * that would make delivery real.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import {
  acknowledgeAlert,
  csrfTokenMatches,
  demoSupervisorPrincipals,
  InactiveIdentityError,
  INTERNAL_ONLY_NOTE,
  listSupervisorQueues,
  newCsrfToken,
  recordAgeingOverride,
  StaffGrantError,
  SupervisorError,
  type IdentityService,
  type PostgresStaffGrantRepository,
  type Queryable,
  type SessionService,
} from "@vision/adapters";
import {
  type CorrelationId,
  type IdentityProviderAdapter,
  newCorrelationId,
} from "@vision/contracts";
import {
  derivePrincipal,
  UnauthenticatedError,
  type AgeingPolicyPack,
  type Principal,
} from "@vision/domain";

import { cookie, parseCookies, readJsonBody, sendError, sendJson, type ApiConfig } from "./app.ts";

export type SupervisorRouteDependencies = {
  readonly client: Queryable;
  readonly identityAdapter: IdentityProviderAdapter;
  readonly identityService: IdentityService;
  readonly sessionService: SessionService;
  readonly staffGrants: PostgresStaffGrantRepository;
  readonly config: ApiConfig;
  readonly jurisdictionProfileId: string;
  readonly jurisdictionInternalCodes: readonly string[];
  /** The loaded ageing policy. Supplied, never defaulted (V036). */
  readonly ageingPolicy: AgeingPolicyPack;
  /** Injected so a test can drive the clock rather than sleep. */
  readonly now?: () => Date;
};

const jurisdictionOptions = async (
  client: Queryable,
  scope: readonly string[],
): Promise<readonly Record<string, unknown>[]> => {
  if (scope.length === 0) return [];
  const { rows } = await client.query(
    `select jurisdiction_id, internal_code, level_code, synthetic_provenance
       from jurisdiction where jurisdiction_id = any($1::uuid[])
      order by level_code, internal_code`,
    [scope],
  );
  return rows.map((row) => ({
    jurisdiction_id: String(row["jurisdiction_id"]),
    internal_code: String(row["internal_code"]),
    level_code: String(row["level_code"]),
    synthetic: row["synthetic_provenance"] === true,
  }));
};

export const createSupervisorRoutes = (deps: SupervisorRouteDependencies) => {
  const { config } = deps;
  const now = deps.now ?? (() => new Date());

  const clearedCookies = (): readonly string[] => [
    cookie(config.sessionCookieName, "", {
      maxAgeSeconds: 0,
      httpOnly: true,
      secure: config.cookieSecure,
    }),
    cookie(config.csrfCookieName, "", {
      maxAgeSeconds: 0,
      httpOnly: false,
      secure: config.cookieSecure,
    }),
  ];

  const requireSupervisor = async (
    request: IncomingMessage,
    response: ServerResponse,
    correlationId: CorrelationId,
    requireCsrf: boolean,
  ): Promise<Principal | undefined> => {
    const cookies = parseCookies(request.headers.cookie);
    if (requireCsrf) {
      const header = request.headers["x-csrf-token"];
      const presented = Array.isArray(header) ? header[0] : header;
      if (!csrfTokenMatches(cookies[config.csrfCookieName], presented)) {
        sendError(response, "forbidden", "missing or mismatched CSRF token", correlationId);
        return undefined;
      }
    }
    const validation = await deps.sessionService.validate(cookies[config.sessionCookieName]);
    if (!validation.ok) {
      sendError(
        response,
        "unauthenticated",
        "no active supervisor session",
        correlationId,
        clearedCookies(),
      );
      return undefined;
    }
    const grant = await deps.staffGrants.findActiveByParticipant(
      validation.participant.participant_id,
    );
    if (grant === undefined || grant.role !== "supervisor") {
      sendError(
        response,
        "forbidden",
        "this session has no active supervisor grant",
        correlationId,
        clearedCookies(),
      );
      return undefined;
    }
    try {
      return derivePrincipal({
        ok: true,
        sessionId: validation.session.session_id,
        participant: validation.participant,
        grant: {
          role: grant.role,
          staffId: grant.staffId,
          jurisdictionScope: grant.jurisdictionScope,
        },
      });
    } catch (error) {
      if (error instanceof UnauthenticatedError) {
        sendError(response, "unauthenticated", "supervisor grant cannot be used", correlationId);
        return undefined;
      }
      throw error;
    }
  };

  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", "http://localhost");
    const path = url.pathname;
    if (!path.startsWith("/v1/supervisor/")) return false;
    const correlationId = newCorrelationId();

    if (method === "GET" && path === "/v1/supervisor/capabilities") {
      sendJson(
        response,
        200,
        {
          identity_mode: "simulated",
          identity_label: deps.identityAdapter.descriptor.capability.display_label,
          demo_principals: demoSupervisorPrincipals().map((principal) => ({
            credential: principal.credential,
            label: principal.label,
            credential_state: principal.credential_state,
          })),
          delivery_note: INTERNAL_ONLY_NOTE,
        },
        correlationId,
      );
      return true;
    }

    if (method === "POST" && path === "/v1/supervisor/auth/demo-login") {
      const body = await readJsonBody(request);
      const credential = body?.["credential"];
      if (typeof credential !== "string" || credential.length === 0) {
        sendError(response, "validation_failed", "credential is required", correlationId);
        return true;
      }
      const outcome = await deps.identityAdapter.authenticate(
        { credential, interface_locale: "en-IN" as never },
        { correlation_id: correlationId },
      );
      if (outcome.kind === "unavailable") {
        sendError(
          response,
          "dependency_unavailable",
          "identity provider unavailable",
          correlationId,
        );
        return true;
      }
      if (outcome.kind !== "success") {
        sendError(
          response,
          "unauthenticated",
          "the demonstration supervisor credential was not accepted",
          correlationId,
        );
        return true;
      }
      try {
        const { participant } = await deps.identityService.resolveParticipant(outcome.value);
        const grant = await deps.staffGrants.ensureSimulatedSupervisor(
          participant.participant_id,
          deps.jurisdictionProfileId,
          deps.jurisdictionInternalCodes,
        );
        const issued = await deps.sessionService.issue(participant.participant_id);
        const csrf = newCsrfToken();
        sendJson(
          response,
          200,
          {
            authenticated: true,
            role: "supervisor",
            identity_mode: "simulated",
            identity_label: deps.identityAdapter.descriptor.capability.display_label,
            session_expires_at: issued.session.expires_at,
            csrf_token: csrf,
            jurisdictions: await jurisdictionOptions(deps.client, grant.jurisdictionScope),
          },
          correlationId,
          [
            cookie(config.sessionCookieName, issued.cookieValue, {
              maxAgeSeconds: config.sessionTtlSeconds,
              httpOnly: true,
              secure: config.cookieSecure,
            }),
            cookie(config.csrfCookieName, csrf, {
              maxAgeSeconds: config.sessionTtlSeconds,
              httpOnly: false,
              secure: config.cookieSecure,
            }),
          ],
        );
      } catch (error) {
        if (error instanceof InactiveIdentityError) {
          sendError(
            response,
            "unauthenticated",
            "the supervisor identity is inactive",
            correlationId,
          );
          return true;
        }
        if (error instanceof StaffGrantError) {
          sendError(response, "dependency_unavailable", error.message, correlationId);
          return true;
        }
        throw error;
      }
      return true;
    }

    if (method === "GET" && path === "/v1/supervisor/auth/session") {
      const principal = await requireSupervisor(request, response, correlationId, false);
      if (principal === undefined) return true;
      sendJson(
        response,
        200,
        {
          authenticated: true,
          role: principal.role,
          identity_mode: "simulated",
          identity_label: deps.identityAdapter.descriptor.capability.display_label,
          jurisdictions: await jurisdictionOptions(deps.client, principal.jurisdictionScope),
        },
        correlationId,
      );
      return true;
    }

    if (method === "POST" && path === "/v1/supervisor/auth/logout") {
      const principal = await requireSupervisor(request, response, correlationId, true);
      if (principal === undefined) return true;
      await deps.sessionService.revoke(principal.sessionId, "logout");
      sendJson(response, 200, { authenticated: false }, correlationId, clearedCookies());
      return true;
    }

    if (method === "GET" && path === "/v1/supervisor/queues") {
      const principal = await requireSupervisor(request, response, correlationId, false);
      if (principal === undefined) return true;
      const jurisdictionId = url.searchParams.get("jurisdiction_id");
      if (jurisdictionId === null || jurisdictionId.length === 0) {
        sendError(response, "validation_failed", "jurisdiction_id is required", correlationId);
        return true;
      }
      try {
        const queues = await listSupervisorQueues(deps.client, {
          principal,
          jurisdictionId,
          policy: deps.ageingPolicy,
          asOf: now(),
        });
        sendJson(
          response,
          200,
          {
            jurisdiction_id: queues.jurisdictionId,
            as_of: queues.asOf,
            policy_version: queues.policyVersion,
            policy_note: queues.policyNote,
            counts: queues.counts,
            applied_limit: queues.appliedLimit,
            exhaustive: queues.exhaustive,
            delivery_note: queues.deliveryNote,
            issues: queues.issues.map((issue) => ({
              issue_id: issue.issueId,
              public_reference: issue.publicReference,
              category: issue.category,
              current_status: issue.currentStatus,
              department_id: issue.departmentId ?? null,
              assigned_staff_id: issue.assignedStaffId ?? null,
              opened_at: issue.openedAt,
              department_since: issue.departmentSince ?? null,
              queues: issue.queues,
              // Two clocks, always together. Reporting only the department one
              // would let a re-route hide how long the person has waited.
              department_age_days: issue.assessment?.departmentAgeDays ?? null,
              citizen_age_days: issue.assessment?.citizenAgeDays ?? null,
              paused_days: issue.assessment?.pausedDays ?? null,
              alert_after_days: issue.assessment?.appliedRule.alertAfterDays ?? null,
              escalate_after_days: issue.assessment?.appliedRule.escalateAfterDays ?? null,
              rule_source: issue.assessment?.ruleSource ?? null,
              reasons: issue.assessment?.reasons ?? [],
              alerts: issue.alerts.map((alert) => ({
                alert_id: alert.alertId,
                rule_id: alert.ruleId,
                raised_at: alert.raisedAt,
                acknowledged_at: alert.acknowledgedAt ?? null,
              })),
              override:
                issue.override === undefined
                  ? null
                  : {
                      alert_after_days: issue.override.alertAfterDays,
                      escalate_after_days: issue.override.escalateAfterDays,
                      reason: issue.override.reason,
                      recorded_at: issue.override.recordedAt,
                    },
            })),
          },
          correlationId,
        );
      } catch (error) {
        if (error instanceof SupervisorError) {
          sendError(response, "forbidden", error.message, correlationId);
          return true;
        }
        throw error;
      }
      return true;
    }

    const overridePath = /^\/v1\/supervisor\/issues\/([^/]+)\/ageing-override$/.exec(path);
    if (method === "POST" && overridePath !== null) {
      const principal = await requireSupervisor(request, response, correlationId, true);
      if (principal === undefined) return true;
      const issueId = decodeURIComponent(overridePath[1] ?? "");
      const body = await readJsonBody(request);
      const alertAfterDays = body?.["alert_after_days"];
      const escalateAfterDays = body?.["escalate_after_days"];
      const reason = body?.["reason"];
      if (
        typeof alertAfterDays !== "number" ||
        typeof escalateAfterDays !== "number" ||
        typeof reason !== "string" ||
        reason.trim().length < 8
      ) {
        sendError(
          response,
          "validation_failed",
          "alert_after_days, escalate_after_days and a specific reason are required",
          correlationId,
        );
        return true;
      }
      try {
        const result = await recordAgeingOverride(deps.client, {
          principal,
          issueId,
          alertAfterDays,
          escalateAfterDays,
          reason,
        });
        sendJson(
          response,
          200,
          {
            override_id: result.overrideId,
            // Said in the payload: this changed a clock, not a judgement about
            // how serious the problem is.
            is_severity_assessment: false,
            delivery_note: INTERNAL_ONLY_NOTE,
          },
          correlationId,
        );
      } catch (error) {
        if (error instanceof SupervisorError) {
          sendError(response, "forbidden", error.message, correlationId);
          return true;
        }
        throw error;
      }
      return true;
    }

    const ackPath = /^\/v1\/supervisor\/alerts\/([^/]+)\/acknowledge$/.exec(path);
    if (method === "POST" && ackPath !== null) {
      const principal = await requireSupervisor(request, response, correlationId, true);
      if (principal === undefined) return true;
      const alertId = decodeURIComponent(ackPath[1] ?? "");
      const body = await readJsonBody(request);
      const jurisdictionId = body?.["jurisdiction_id"];
      if (typeof jurisdictionId !== "string" || jurisdictionId.length === 0) {
        sendError(response, "validation_failed", "jurisdiction_id is required", correlationId);
        return true;
      }
      try {
        const result = await acknowledgeAlert(deps.client, {
          principal,
          alertId,
          jurisdictionId,
        });
        if (!result.acknowledged) {
          sendError(
            response,
            "conflict",
            "this alert is not waiting in the selected jurisdiction; refresh before acting",
            correlationId,
          );
          return true;
        }
        sendJson(response, 200, { acknowledged: true }, correlationId);
      } catch (error) {
        if (error instanceof SupervisorError) {
          sendError(response, "forbidden", error.message, correlationId);
          return true;
        }
        throw error;
      }
      return true;
    }

    return false;
  };
};
