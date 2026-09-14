/**
 * Authenticated reviewer HTTP surface (roadmap V032).
 *
 * The reviewer role and its jurisdiction scope are resolved from a durable
 * server-side grant after validating the session. Neither is accepted from a
 * request body. Decision targets are also resolved from the current queue, so
 * a caller cannot use this endpoint to act on an arbitrary in-scope row that
 * is not actually awaiting the selected action.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

import {
  csrfTokenMatches,
  decideReview,
  demoReviewerPrincipals,
  InactiveIdentityError,
  grantOriginalAccess,
  listReviewQueue,
  newCsrfToken,
  ObjectStoreError,
  ReviewError,
  StaffGrantError,
  type IdentityService,
  type FilesystemObjectStoreAdapter,
  type PostgresStaffGrantRepository,
  type Queryable,
  type ReviewAction,
  type SessionService,
} from "@vision/adapters";
import {
  type IdentityProviderAdapter,
  newCorrelationId,
  type CorrelationId,
} from "@vision/contracts";
import {
  derivePrincipal,
  UnauthenticatedError,
  type ConfirmationPolicyPack,
  type Principal,
} from "@vision/domain";
import { authorize } from "@vision/domain";

import { cookie, parseCookies, readJsonBody, sendError, sendJson, type ApiConfig } from "./app.ts";

export type ReviewerRouteDependencies = {
  readonly client: Queryable;
  readonly identityAdapter: IdentityProviderAdapter;
  readonly identityService: IdentityService;
  readonly sessionService: SessionService;
  readonly staffGrants: PostgresStaffGrantRepository;
  readonly objectStore: FilesystemObjectStoreAdapter;
  readonly config: ApiConfig;
  readonly jurisdictionProfileId: string;
  readonly jurisdictionInternalCodes: readonly string[];
  /**
   * The loaded confirmation policy (V035).
   *
   * Required to list disputed resolutions at all: whether a reviewer may
   * resolve a dispute in favour of the claim is a configured decision per
   * category, and a queue offering that action without having read a policy
   * would be offering a power nobody granted.
   */
  readonly confirmationPolicy: ConfirmationPolicyPack;
};

type JurisdictionOption = {
  readonly jurisdiction_id: string;
  readonly internal_code: string;
  readonly level_code: string;
  readonly synthetic: boolean;
};

const jurisdictionOptions = async (
  client: Queryable,
  scope: readonly string[],
): Promise<readonly JurisdictionOption[]> => {
  if (scope.length === 0) return [];
  const { rows } = await client.query(
    `select jurisdiction_id, internal_code, level_code, synthetic_provenance
       from jurisdiction
      where jurisdiction_id = any($1::uuid[])
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

export const createReviewerRoutes = (deps: ReviewerRouteDependencies) => {
  const { config } = deps;

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

  const requireReviewer = async (
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
        "no active reviewer session",
        correlationId,
        clearedCookies(),
      );
      return undefined;
    }
    const grant = await deps.staffGrants.findActiveByParticipant(
      validation.participant.participant_id,
    );
    if (grant === undefined || grant.role !== "reviewer") {
      sendError(
        response,
        "forbidden",
        "this session has no active reviewer grant",
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
        sendError(response, "unauthenticated", "reviewer grant cannot be used", correlationId);
        return undefined;
      }
      throw error;
    }
  };

  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", "http://localhost");
    const path = url.pathname;
    if (!path.startsWith("/v1/reviewer/")) return false;
    const correlationId = newCorrelationId();

    if (method === "GET" && path === "/v1/reviewer/capabilities") {
      sendJson(
        response,
        200,
        {
          identity_mode: "simulated",
          identity_label: deps.identityAdapter.descriptor.capability.display_label,
          demo_principals: demoReviewerPrincipals().map((principal) => ({
            credential: principal.credential,
            label: principal.label,
            credential_state: principal.credential_state,
          })),
        },
        correlationId,
      );
      return true;
    }

    if (method === "POST" && path === "/v1/reviewer/auth/demo-login") {
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
          "the demonstration reviewer credential was not accepted",
          correlationId,
        );
        return true;
      }

      try {
        const { participant } = await deps.identityService.resolveParticipant(outcome.value);
        const grant = await deps.staffGrants.ensureSimulatedReviewer(
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
            role: "reviewer",
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
            "the reviewer identity is inactive",
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

    if (method === "GET" && path === "/v1/reviewer/auth/session") {
      const principal = await requireReviewer(request, response, correlationId, false);
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

    if (method === "POST" && path === "/v1/reviewer/auth/logout") {
      const principal = await requireReviewer(request, response, correlationId, true);
      if (principal === undefined) return true;
      await deps.sessionService.revoke(principal.sessionId, "logout");
      sendJson(response, 200, { authenticated: false }, correlationId, clearedCookies());
      return true;
    }

    if (method === "GET" && path === "/v1/reviewer/queue") {
      const principal = await requireReviewer(request, response, correlationId, false);
      if (principal === undefined) return true;
      const jurisdictionId = url.searchParams.get("jurisdiction_id");
      if (jurisdictionId === null || jurisdictionId.length === 0) {
        sendError(response, "validation_failed", "jurisdiction_id is required", correlationId);
        return true;
      }
      const rawLimit = url.searchParams.get("limit");
      const limit = rawLimit === null ? undefined : Number(rawLimit);
      if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
        sendError(response, "validation_failed", "limit must be a positive integer", correlationId);
        return true;
      }
      try {
        const queue = await listReviewQueue(deps.client, {
          principal,
          jurisdictionId,
          confirmationPolicy: deps.confirmationPolicy,
          ...(limit === undefined ? {} : { limit }),
        });
        sendJson(
          response,
          200,
          {
            jurisdiction_id: queue.jurisdictionId,
            applied_limit: queue.appliedLimit,
            exhaustive: queue.exhaustive,
            awaiting_jurisdiction_count: queue.awaitingJurisdictionCount,
            awaiting_jurisdiction_note: queue.awaitingJurisdictionNote,
            items: queue.items.map((item) => ({
              kind: item.kind,
              target_id: item.targetId,
              submission_id: item.submissionId,
              reason: item.reason,
              permitted_actions: item.permittedActions,
              waiting_since: item.waitingSince,
              citizen_note: item.citizenNote ?? null,
              candidate_issue_ids: item.candidateIssueIds,
            })),
          },
          correlationId,
        );
      } catch (error) {
        if (error instanceof ReviewError) {
          sendError(response, "forbidden", error.message, correlationId);
          return true;
        }
        throw error;
      }
      return true;
    }

    const originalPath = /^\/v1\/reviewer\/queue\/([^/]+)\/([^/]+)\/original$/.exec(path);
    if (method === "GET" && originalPath !== null) {
      const principal = await requireReviewer(request, response, correlationId, false);
      if (principal === undefined) return true;
      const jurisdictionId = url.searchParams.get("jurisdiction_id");
      const purposeHeader = request.headers["x-access-purpose"];
      const purpose = Array.isArray(purposeHeader) ? purposeHeader[0] : purposeHeader;
      if (
        jurisdictionId === null ||
        jurisdictionId.length === 0 ||
        purpose === undefined ||
        purpose.trim().length < 8
      ) {
        sendError(
          response,
          "validation_failed",
          "jurisdiction_id and a specific access purpose are required",
          correlationId,
        );
        return true;
      }
      const kind = decodeURIComponent(originalPath[1] ?? "");
      const targetId = decodeURIComponent(originalPath[2] ?? "");
      try {
        const queue = await listReviewQueue(deps.client, {
          principal,
          jurisdictionId,
          confirmationPolicy: deps.confirmationPolicy,
        });
        const item = queue.items.find(
          (candidate) => candidate.kind === kind && candidate.targetId === targetId,
        );
        const evidenceId = item?.decisionTarget.evidenceId;
        if (item === undefined || evidenceId === undefined) {
          sendError(
            response,
            "not_found",
            "no private original is available for this queue item",
            correlationId,
          );
          return true;
        }
        const evidence = await deps.client.query(
          `select e.object_reference, e.media_type
             from evidence_item e
             join issue_evidence_link link
                    on link.evidence_id = e.evidence_id and link.effective_to is null
             join canonical_issue i on i.issue_id = link.canonical_issue_id
            where e.evidence_id = $1
              and e.privacy_state = 'active'
              and i.jurisdiction_id = $2`,
          [evidenceId, jurisdictionId],
        );
        const row = evidence.rows[0];
        if (
          row === undefined ||
          row["object_reference"] === null ||
          row["media_type"] !== "photo"
        ) {
          sendError(response, "not_found", "no private photograph is available", correlationId);
          return true;
        }
        const authorization = authorize(principal, "evidence.read_original", {
          jurisdictionId,
          exceptionalAccessPurpose: purpose,
        });
        if (!authorization.allowed) {
          sendError(response, "forbidden", authorization.reason, correlationId);
          return true;
        }
        const bytes = await deps.objectStore.readOriginal(
          String(row["object_reference"]),
          grantOriginalAccess(authorization, purpose),
        );
        const isPng =
          bytes.length >= 8 &&
          [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
            (byte, index) => bytes[index] === byte,
          );
        const isJpeg =
          bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
        if (!isPng && !isJpeg) {
          sendError(
            response,
            "conflict",
            "the stored original is not a supported photograph",
            correlationId,
          );
          return true;
        }
        await deps.client.query(
          `insert into private_evidence_access_log
             (access_id, evidence_id, staff_id, session_id, jurisdiction_id, purpose)
           values ($1,$2,$3,$4,$5,$6)`,
          [
            randomUUID(),
            evidenceId,
            principal.staffId,
            principal.sessionId,
            jurisdictionId,
            purpose.trim(),
          ],
        );
        response.writeHead(200, {
          "content-type": isPng ? "image/png" : "image/jpeg",
          "content-length": String(bytes.byteLength),
          "cache-control": "no-store, private",
          "content-security-policy": "default-src 'none'; sandbox",
          "x-content-type-options": "nosniff",
          "x-correlation-id": correlationId,
        });
        response.end(bytes);
      } catch (error) {
        if (error instanceof ReviewError) {
          sendError(response, "forbidden", error.message, correlationId);
          return true;
        }
        if (error instanceof ObjectStoreError) {
          sendError(response, "not_found", "the private original could not be read", correlationId);
          return true;
        }
        throw error;
      }
      return true;
    }

    const decisionPath = /^\/v1\/reviewer\/queue\/([^/]+)\/([^/]+)\/decisions$/.exec(path);
    if (method === "POST" && decisionPath !== null) {
      const principal = await requireReviewer(request, response, correlationId, true);
      if (principal === undefined) return true;
      const kind = decodeURIComponent(decisionPath[1] ?? "");
      const targetId = decodeURIComponent(decisionPath[2] ?? "");
      const body = await readJsonBody(request);
      const action = body?.["action"];
      const reason = body?.["reason"];
      const jurisdictionId = body?.["jurisdiction_id"];
      if (
        typeof action !== "string" ||
        typeof reason !== "string" ||
        typeof jurisdictionId !== "string" ||
        jurisdictionId.length === 0
      ) {
        sendError(
          response,
          "validation_failed",
          "action, reason and jurisdiction_id are required",
          correlationId,
        );
        return true;
      }

      try {
        const queue = await listReviewQueue(deps.client, {
          principal,
          jurisdictionId,
          confirmationPolicy: deps.confirmationPolicy,
        });
        const item = queue.items.find(
          (candidate) => candidate.kind === kind && candidate.targetId === targetId,
        );
        if (item === undefined) {
          sendError(
            response,
            "conflict",
            "this item is no longer waiting in the selected queue; refresh before deciding",
            correlationId,
          );
          return true;
        }
        if (!item.permittedActions.includes(action as ReviewAction)) {
          sendError(
            response,
            "forbidden",
            "this action is not permitted for the queue item",
            correlationId,
          );
          return true;
        }

        const candidateIssueId = body?.["candidate_issue_id"];
        if (
          action === "attach_to_issue" &&
          (typeof candidateIssueId !== "string" ||
            !item.candidateIssueIds.includes(candidateIssueId))
        ) {
          sendError(
            response,
            "validation_failed",
            "candidate_issue_id must name one of this item's candidates",
            correlationId,
          );
          return true;
        }

        // A reason is required for every decision, and a dispute decision is
        // where that matters most: the citizen whose dispute is being answered
        // has the strongest claim to an explanation.
        if (reason.trim().length < 8) {
          sendError(
            response,
            "validation_failed",
            "a review decision requires a recorded reason",
            correlationId,
          );
          return true;
        }
        const decision = await decideReview(deps.client, {
          principal,
          action: action as ReviewAction,
          reason,
          confirmationPolicy: deps.confirmationPolicy,
          ...item.decisionTarget,
          ...(action === "attach_to_issue" ? { canonicalIssueId: String(candidateIssueId) } : {}),
        });
        sendJson(
          response,
          200,
          {
            decision_id: decision.decisionId,
            prior_state: decision.priorState,
            resulting_state: decision.resultingState,
          },
          correlationId,
        );
      } catch (error) {
        if (error instanceof ReviewError) {
          sendError(response, "conflict", error.message, correlationId);
          return true;
        }
        throw error;
      }
      return true;
    }

    return false;
  };
};
