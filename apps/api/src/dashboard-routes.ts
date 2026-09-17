/**
 * District dashboard HTTP surface (roadmap V039).
 *
 * Read-only. Nothing on this surface writes, and that is not an omission: a
 * dashboard that could change the thing it measures would make "what does the
 * district look like" depend on who has been looking at it.
 *
 * It rides the V036 supervisor session rather than introducing a sixth role.
 * A supervisor already holds `issue.read_private` and `evidence.read_redacted`
 * inside their jurisdictions, and — importantly — does **not** hold
 * `evidence.read_original`. That is exactly the boundary a district dashboard
 * should sit inside: enough to check a number against its records, never
 * enough to open somebody's unredacted photograph without a named reason
 * through the review queue, where it is recorded.
 *
 * The jurisdiction scope is taken from the server-side grant on every request.
 * The cell key in the URL is a browser-supplied string and is checked against
 * that scope before anything is read — a reader who edits it must not thereby
 * reach a ward they have no grant for.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import {
  DashboardError,
  PrioritizationInputError,
  csrfTokenMatches,
  readCellIssues,
  readComparisonView,
  readDistrictDashboard,
  readIssueDetail,
  type PostgresStaffGrantRepository,
  type Queryable,
  type SessionService,
} from "@vision/adapters";
import { newCorrelationId, type CorrelationId } from "@vision/contracts";
import {
  derivePrincipal,
  UnauthenticatedError,
  type Principal,
  type RecommendationPolicy,
} from "@vision/domain";

import { sendError, sendJson, parseCookies, type ApiConfig } from "./app.ts";

export type DashboardRouteDependencies = {
  readonly client: Queryable;
  readonly sessionService: SessionService;
  readonly staffGrants: PostgresStaffGrantRepository;
  readonly config: ApiConfig;
  /** The categories this deployment tracks, from the taxonomy pack. */
  readonly trackedCategories: readonly string[];
  /** Profile whose V040 context datasets belong to these wards. */
  readonly jurisdictionProfileId: string;
  /** The loaded V042 recommendation policy. Supplied, never defaulted. */
  readonly recommendationPolicy: RecommendationPolicy;
  /** Injected so a test drives the clock rather than sleeping. */
  readonly now?: () => Date;
};

/**
 * Said on every payload.
 *
 * A dashboard is the surface most likely to be screenshotted and quoted with
 * its context stripped, so the context travels inside the data.
 */
export const DASHBOARD_NOTE =
  "Every figure here counts reports this demonstration received. It does not measure how many problems exist, how serious any of them are, or how many people are affected. A ward with no data has not been shown to have no problems.";

export const createDashboardRoutes = (deps: DashboardRouteDependencies) => {
  const { config } = deps;
  const now = deps.now ?? (() => new Date());

  const requireSupervisor = async (
    request: IncomingMessage,
    response: ServerResponse,
    correlationId: CorrelationId,
  ): Promise<Principal | undefined> => {
    const cookies = parseCookies(request.headers.cookie);
    const validation = await deps.sessionService.validate(cookies[config.sessionCookieName]);
    if (!validation.ok) {
      sendError(response, "unauthenticated", "no active supervisor session", correlationId);
      return undefined;
    }
    const grant = await deps.staffGrants.findActiveByParticipant(
      validation.participant.participant_id,
    );
    if (grant === undefined || grant.role !== "supervisor") {
      sendError(
        response,
        "forbidden",
        "the district dashboard requires an active supervisor grant",
        correlationId,
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
    if (!path.startsWith("/v1/dashboard/")) return false;
    const correlationId = newCorrelationId();

    // Read-only by construction: anything that is not a GET is refused before
    // a session is even looked up.
    if (method !== "GET") {
      sendError(
        response,
        "validation_failed",
        "the district dashboard is read-only; it has no endpoint that changes anything",
        correlationId,
      );
      return true;
    }

    // A CSRF token is not required for these reads, but a presented one must
    // still match: a stale tab sending a token from a revoked session should
    // be told so rather than quietly served.
    const presentedCsrf = request.headers["x-csrf-token"];
    const csrfHeader = Array.isArray(presentedCsrf) ? presentedCsrf[0] : presentedCsrf;
    if (csrfHeader !== undefined) {
      const cookies = parseCookies(request.headers.cookie);
      if (!csrfTokenMatches(cookies[config.csrfCookieName], csrfHeader)) {
        sendError(response, "forbidden", "mismatched CSRF token", correlationId);
        return true;
      }
    }

    if (path === "/v1/dashboard/overview") {
      const principal = await requireSupervisor(request, response, correlationId);
      if (principal === undefined) return true;
      try {
        const dashboard = await readDistrictDashboard(deps.client, {
          jurisdictionScope: principal.jurisdictionScope,
          trackedCategories: deps.trackedCategories,
          jurisdictionProfileId: deps.jurisdictionProfileId,
          asOf: now(),
        });
        sendJson(response, 200, { ...dashboard, note: DASHBOARD_NOTE }, correlationId);
      } catch (error) {
        if (error instanceof DashboardError) {
          sendError(response, "validation_failed", error.message, correlationId);
          return true;
        }
        throw error;
      }
      return true;
    }

    // V043. Read-only like the rest of this surface, and it carries the policy
    // version on the payload so switching weightings cannot be mistaken for
    // switching policies.
    if (path === "/v1/dashboard/comparison") {
      const principal = await requireSupervisor(request, response, correlationId);
      if (principal === undefined) return true;
      const detail = Number(url.searchParams.get("detail") ?? "8");
      try {
        const view = await readComparisonView(deps.client, {
          jurisdictionIds: principal.jurisdictionScope,
          asOf: now(),
          policy: deps.recommendationPolicy,
          detailCount: Number.isFinite(detail) ? Math.min(Math.max(detail, 1), 25) : 8,
        });
        sendJson(response, 200, { ...view, note: DASHBOARD_NOTE }, correlationId);
      } catch (error) {
        if (error instanceof PrioritizationInputError) {
          sendError(response, "validation_failed", error.message, correlationId);
          return true;
        }
        if (error instanceof DashboardError) {
          sendError(response, "validation_failed", error.message, correlationId);
          return true;
        }
        throw error;
      }
      return true;
    }

    const cellMatch = /^\/v1\/dashboard\/cells\/([^/]+)\/([^/]+)\/issues$/.exec(path);
    if (cellMatch !== null) {
      const principal = await requireSupervisor(request, response, correlationId);
      if (principal === undefined) return true;
      try {
        const issues = await readCellIssues(deps.client, {
          jurisdictionKey: decodeURIComponent(cellMatch[1] ?? ""),
          category: decodeURIComponent(cellMatch[2] ?? ""),
          jurisdictionScope: principal.jurisdictionScope,
          asOf: now(),
          limit: 100,
        });
        sendJson(response, 200, { issues, note: DASHBOARD_NOTE }, correlationId);
      } catch (error) {
        if (error instanceof DashboardError) {
          sendError(response, "forbidden", error.message, correlationId);
          return true;
        }
        throw error;
      }
      return true;
    }

    const issueMatch = /^\/v1\/dashboard\/issues\/([^/]+)$/.exec(path);
    if (issueMatch !== null) {
      const principal = await requireSupervisor(request, response, correlationId);
      if (principal === undefined) return true;
      try {
        const detail = await readIssueDetail(deps.client, {
          publicReference: decodeURIComponent(issueMatch[1] ?? ""),
          jurisdictionScope: principal.jurisdictionScope,
          asOf: now(),
        });
        sendJson(response, 200, { ...detail, note: DASHBOARD_NOTE }, correlationId);
      } catch (error) {
        if (error instanceof DashboardError) {
          sendError(response, "forbidden", error.message, correlationId);
          return true;
        }
        throw error;
      }
      return true;
    }

    sendError(response, "not_found", "no such dashboard endpoint", correlationId);
    return true;
  };
};
