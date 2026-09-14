/**
 * Public API request handler (roadmap V009).
 *
 * Scope: capability metadata plus the session endpoints. Submission, evidence,
 * issue and analytics endpoints belong to V018 and later, and an HTTP framework
 * is deliberately not chosen yet (V006 D14) — this thin handler over Node's
 * built-in server keeps the session work testable without pre-committing that
 * decision.
 *
 * Cookie policy:
 *  - session cookie: HttpOnly, SameSite=Strict, Path=/, Secure when configured.
 *    It is a bearer credential and is never logged (V005 §8).
 *  - CSRF cookie: readable by the client on purpose, because the client must
 *    echo it in a request header (double-submit).
 */

import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";

import {
  ERROR_STATUS,
  CONTRACT_VERSION,
  newCorrelationId,
  type ApiError,
  type CapabilityMetadataDocument,
  type CorrelationId,
  type ErrorCode,
  type IdentityProviderAdapter,
} from "@vision/contracts";
import {
  IdentityService,
  InactiveIdentityError,
  SessionService,
  csrfTokenMatches,
  demoPrincipalLabels,
  newCsrfToken,
} from "@vision/adapters";

export type ApiConfig = {
  readonly sessionCookieName: string;
  readonly csrfCookieName: string;
  readonly cookieSecure: boolean;
  readonly sessionTtlSeconds: number;
};

export type ApiDependencies = {
  readonly identityAdapter: IdentityProviderAdapter;
  readonly identityService: IdentityService;
  readonly sessionService: SessionService;
  readonly capabilities: CapabilityMetadataDocument;
  readonly config: ApiConfig;
  /**
   * Additional routers, tried before the 404. Upload and submission routes
   * (V016/V018) live here because they need a database, which the session
   * routes deliberately do not — so a clean checkout can still run the API.
   * Returns true when the request was handled.
   */
  readonly extraRoutes?: (request: IncomingMessage, response: ServerResponse) => Promise<boolean>;
};

const MAX_BODY_BYTES = 16 * 1024;

export const parseCookies = (header: string | undefined): Readonly<Record<string, string>> => {
  if (header === undefined) return {};
  const jar: Record<string, string> = {};
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name.length === 0) continue;
    try {
      jar[name] = decodeURIComponent(value);
    } catch {
      // A malformed percent escape is an invalid credential, not an internal
      // server error. Ignore it so the normal unauthenticated path clears it.
    }
  }
  return jar;
};

export const readJsonBody = async (
  request: IncomingMessage,
): Promise<Readonly<Record<string, unknown>> | undefined> => {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buffer.byteLength;
    if (total > MAX_BODY_BYTES) return undefined;
    chunks.push(buffer);
  }
  if (total === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

export const cookie = (
  name: string,
  value: string,
  options: { maxAgeSeconds: number; httpOnly: boolean; secure: boolean },
): string => {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "SameSite=Strict",
    `Max-Age=${String(options.maxAgeSeconds)}`,
  ];
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
};

export const sendJson = (
  response: ServerResponse,
  status: number,
  body: unknown,
  correlationId: CorrelationId,
  cookies: readonly string[] = [],
): void => {
  const payload = JSON.stringify(body);
  const headers: OutgoingHttpHeaders = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-correlation-id": correlationId,
  };
  if (cookies.length > 0) {
    headers["set-cookie"] = [...cookies];
  }
  response.writeHead(status, headers);
  response.end(payload);
};

export const sendError = (
  response: ServerResponse,
  code: ErrorCode,
  message: string,
  correlationId: CorrelationId,
  cookies: readonly string[] = [],
): void => {
  const body: ApiError = {
    error: { code, message, correlation_id: correlationId, contract_version: CONTRACT_VERSION },
  };
  sendJson(response, ERROR_STATUS[code], body, correlationId, cookies);
};

export const createRequestHandler = (deps: ApiDependencies) => {
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

  const route = async (
    request: IncomingMessage,
    response: ServerResponse,
    correlationId: CorrelationId,
  ): Promise<void> => {
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", "http://localhost");
    const path = url.pathname;
    const cookies = parseCookies(request.headers.cookie);

    // GET /v1/capabilities — public; states which providers are simulated.
    if (method === "GET" && path === "/v1/capabilities") {
      sendJson(
        response,
        200,
        { ...deps.capabilities, demo_principals: demoPrincipalLabels() },
        correlationId,
      );
      return;
    }

    if (method === "GET" && path === "/v1/health") {
      sendJson(response, 200, { status: "ok" }, correlationId);
      return;
    }

    // GET /v1/auth/session — the citizen's own session status only.
    if (method === "GET" && path === "/v1/auth/session") {
      const validation = await deps.sessionService.validate(cookies[config.sessionCookieName]);
      if (!validation.ok) {
        sendJson(
          response,
          200,
          { authenticated: false, reason: validation.reason },
          correlationId,
          clearedCookies(),
        );
        return;
      }
      sendJson(
        response,
        200,
        {
          authenticated: true,
          // participant_id is L2 and is deliberately not returned (V005 §2).
          session_expires_at: validation.session.expires_at,
          identity_mode: "simulated",
          identity_label: deps.identityAdapter.descriptor.capability.display_label,
        },
        correlationId,
      );
      return;
    }

    // POST /v1/auth/demo-login — exchanges a demo credential for a session.
    if (method === "POST" && path === "/v1/auth/demo-login") {
      const body = await readJsonBody(request);
      if (body === undefined) {
        sendError(response, "validation_failed", "request body must be small JSON", correlationId);
        return;
      }
      const credential = body["credential"];
      if (typeof credential !== "string" || credential.length === 0) {
        sendError(response, "validation_failed", "credential is required", correlationId);
        return;
      }

      const outcome = await deps.identityAdapter.authenticate(
        { credential, interface_locale: "en-IN" as never },
        { correlation_id: correlationId },
      );

      if (outcome.kind === "unavailable") {
        sendError(
          response,
          "dependency_unavailable",
          "the identity provider is unavailable",
          correlationId,
        );
        return;
      }
      if (outcome.kind !== "success") {
        sendError(
          response,
          "unauthenticated",
          "the supplied demonstration credential was not accepted",
          correlationId,
        );
        return;
      }

      let participant;
      try {
        ({ participant } = await deps.identityService.resolveParticipant(outcome.value));
      } catch (error) {
        if (error instanceof InactiveIdentityError) {
          sendError(
            response,
            "unauthenticated",
            "the demonstration identity is inactive",
            correlationId,
          );
          return;
        }
        throw error;
      }
      const issued = await deps.sessionService.issue(participant.participant_id);
      const csrf = newCsrfToken();

      sendJson(
        response,
        200,
        {
          authenticated: true,
          session_expires_at: issued.session.expires_at,
          csrf_token: csrf,
          identity_mode: "simulated",
          identity_label: deps.identityAdapter.descriptor.capability.display_label,
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
      return;
    }

    // State-changing session endpoints require the double-submit CSRF token.
    if (method === "POST" && (path === "/v1/auth/logout" || path === "/v1/auth/rotate")) {
      const headerToken = request.headers["x-csrf-token"];
      const presented = Array.isArray(headerToken) ? headerToken[0] : headerToken;
      if (!csrfTokenMatches(cookies[config.csrfCookieName], presented)) {
        sendError(response, "forbidden", "missing or mismatched CSRF token", correlationId);
        return;
      }

      const validation = await deps.sessionService.validate(cookies[config.sessionCookieName]);
      if (!validation.ok) {
        sendError(
          response,
          "unauthenticated",
          "no active session",
          correlationId,
          clearedCookies(),
        );
        return;
      }

      if (path === "/v1/auth/logout") {
        await deps.sessionService.revoke(validation.session.session_id, "logout");
        // Clearing cookies is what "logout clears protected local state" means
        // on the server side; the client additionally clears its own drafts
        // under the V005 device-draft policy.
        sendJson(response, 200, { authenticated: false }, correlationId, clearedCookies());
        return;
      }

      const rotated = await deps.sessionService.rotate(cookies[config.sessionCookieName]);
      if (rotated === undefined) {
        sendError(
          response,
          "unauthenticated",
          "no active session",
          correlationId,
          clearedCookies(),
        );
        return;
      }
      const csrf = newCsrfToken();
      sendJson(
        response,
        200,
        { authenticated: true, session_expires_at: rotated.session.expires_at, csrf_token: csrf },
        correlationId,
        [
          cookie(config.sessionCookieName, rotated.cookieValue, {
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
      return;
    }

    if (deps.extraRoutes !== undefined && (await deps.extraRoutes(request, response))) {
      return;
    }

    sendError(response, "not_found", "unknown route", correlationId);
  };

  /**
   * Every request gets a response, including one that throws.
   *
   * This wrapper exists because of a real defect: an unexpected throw inside a
   * route left the request without any response at all, so a caller that
   * invokes the handler directly (which the tests do) waited forever. A hang
   * is a worse failure than a 500 — it hides the fault instead of reporting
   * it. No error detail is echoed to the caller and nothing is logged here,
   * because a body, cookie or location could be inside it (V005 §8).
   */
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const correlationId = newCorrelationId();
    try {
      await route(request, response, correlationId);
    } catch {
      if (response.headersSent || response.writableEnded) {
        response.end();
        return;
      }
      sendError(response, "internal_error", "an unexpected error occurred", correlationId);
    }
  };
};
