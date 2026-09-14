/**
 * Upload and submission endpoints (roadmap V016 HTTP surface + V018).
 *
 * Kept in its own module so the session handler stays small. Every route here
 * derives its principal from a validated session (V009) and checks it against
 * the V015 authorization policy — never from anything in the request body.
 *
 * This module also supplies the per-principal quota *store* that V015's pure
 * policy takes as input.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { newCorrelationId, type CorrelationId, type IsoTimestamp } from "@vision/contracts";
import {
  authorize,
  checkQuota,
  derivePrincipal,
  UnauthenticatedError,
  type Principal,
  type QuotaPolicy,
} from "@vision/domain";
import {
  csrfTokenMatches,
  type FilesystemObjectStoreAdapter,
  type SessionService,
  type SubmissionService,
} from "@vision/adapters";

import { parseCookies, readJsonBody, sendError, sendJson, type ApiConfig } from "./app.ts";

export type SubmissionRouteDependencies = {
  readonly sessionService: SessionService;
  readonly submissionService: SubmissionService;
  readonly objectStore: FilesystemObjectStoreAdapter;
  readonly config: ApiConfig;
  readonly quotaPolicy?: QuotaPolicy;
};

/** Per-principal request history backing the V015 sliding-window quota. */
class QuotaStore {
  private readonly usage = new Map<string, number[]>();

  recent(principalKey: string, action: string): readonly number[] {
    return this.usage.get(`${principalKey}:${action}`) ?? [];
  }

  record(principalKey: string, action: string, atMs: number): void {
    const key = `${principalKey}:${action}`;
    const existing = this.usage.get(key) ?? [];
    // Bounded: only the most recent window matters, so the list cannot grow
    // without limit for a long-lived process.
    this.usage.set(key, [...existing.slice(-200), atMs]);
  }
}

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

/** Reads a raw body with a hard ceiling, so an oversized PUT cannot exhaust memory. */
const readRawBody = async (
  request: IncomingMessage,
  limit: number,
): Promise<Buffer | undefined> => {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buffer.byteLength;
    if (total > limit) return undefined;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
};

export const createSubmissionRoutes = (deps: SubmissionRouteDependencies) => {
  const quotas = new QuotaStore();
  const { config } = deps;

  /** Resolves the citizen principal, or writes the error response itself. */
  const requirePrincipal = async (
    request: IncomingMessage,
    response: ServerResponse,
    correlationId: CorrelationId,
    options: { readonly requireCsrf: boolean },
  ): Promise<{ readonly principal: Principal; readonly participantId: string } | undefined> => {
    const cookies = parseCookies(request.headers.cookie);

    if (options.requireCsrf) {
      const header = request.headers["x-csrf-token"];
      const presented = Array.isArray(header) ? header[0] : header;
      if (!csrfTokenMatches(cookies[config.csrfCookieName], presented)) {
        sendError(response, "forbidden", "missing or mismatched CSRF token", correlationId);
        return undefined;
      }
    }

    const validation = await deps.sessionService.validate(cookies[config.sessionCookieName]);
    if (!validation.ok) {
      sendError(response, "unauthenticated", "no active session", correlationId);
      return undefined;
    }

    try {
      // The grant is server-side. Demo sessions are citizens; staff roles
      // arrive with V057 staff authentication.
      const principal = derivePrincipal({
        ok: true,
        sessionId: validation.session.session_id,
        participant: validation.participant,
        grant: { role: "citizen" },
      });
      return { principal, participantId: validation.participant.participant_id };
    } catch (error) {
      if (error instanceof UnauthenticatedError) {
        sendError(response, "unauthenticated", "session cannot be used", correlationId);
        return undefined;
      }
      throw error;
    }
  };

  /** Applies the V015 quota, writing a Retry-After-style response on refusal. */
  const withinQuota = (
    response: ServerResponse,
    correlationId: CorrelationId,
    principalKey: string,
    action: string,
  ): boolean => {
    const nowMs = Date.now();
    const decision = checkQuota(
      action,
      { recentAtMs: quotas.recent(principalKey, action) },
      nowMs,
      deps.quotaPolicy,
    );
    if (!decision.allowed) {
      // Actionable: the client is told when it may retry (V015 §4).
      response.setHeader("retry-after", String(Math.ceil(decision.retryAfterMs / 1000)));
      sendJson(
        response,
        429,
        {
          error: {
            code: "quota_exceeded",
            message: `at most ${String(decision.limit)} per ${String(decision.windowSeconds)}s`,
            retry_after_ms: decision.retryAfterMs,
            correlation_id: correlationId,
          },
        },
        correlationId,
      );
      return false;
    }
    quotas.record(principalKey, action, nowMs);
    return true;
  };

  /**
   * Handles a request if it belongs to this router.
   * Returns false when the path is not ours, so the caller can continue.
   */
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const correlationId = newCorrelationId();
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", "http://localhost");
    const path = url.pathname;

    // ---- POST /v1/uploads : request a scoped upload grant ----
    if (method === "POST" && path === "/v1/uploads") {
      const actor = await requirePrincipal(request, response, correlationId, { requireCsrf: true });
      if (actor === undefined) return true;

      const decision = authorize(actor.principal, "submission.create");
      if (!decision.allowed) {
        sendError(response, "forbidden", decision.reason, correlationId);
        return true;
      }
      if (!withinQuota(response, correlationId, actor.participantId, "upload.grant")) return true;

      const body = await readJsonBody(request);
      if (body === undefined) {
        sendError(response, "validation_failed", "request body must be small JSON", correlationId);
        return true;
      }
      const contentType = body["content_type"];
      const maxBytes = body["max_bytes"];
      if (typeof contentType !== "string" || typeof maxBytes !== "number") {
        sendError(
          response,
          "validation_failed",
          "content_type and max_bytes are required",
          correlationId,
        );
        return true;
      }

      const outcome = await deps.objectStore.createUploadGrant(
        {
          intended_content_type: contentType,
          max_bytes: maxBytes,
          owner_pseudonym: actor.principal.participantId!,
        },
        {
          correlation_id: correlationId,
          idempotency_key: `upload-${correlationId}` as never,
          idempotency_scope: `citizen:${actor.participantId}:uploads.create` as never,
          request_fingerprint: `sha256:${"0".repeat(64)}` as never,
        },
      );

      if (outcome.kind !== "success") {
        sendError(
          response,
          "validation_failed",
          outcome.kind === "rejected" ? outcome.detail : "upload grant unavailable",
          correlationId,
        );
        return true;
      }
      sendJson(response, 201, outcome.value, correlationId);
      return true;
    }

    // ---- PUT /v1/uploads/:reference : send the bytes ----
    if (method === "PUT" && path.startsWith("/v1/uploads/")) {
      const reference = decodeURIComponent(path.slice("/v1/uploads/".length));
      const actor = await requirePrincipal(request, response, correlationId, {
        requireCsrf: false,
      });
      if (actor === undefined) return true;

      const token = url.searchParams.get("token");
      const contentType = String(request.headers["content-type"] ?? "");
      if (token === null) {
        sendError(response, "forbidden", "upload token is required", correlationId);
        return true;
      }

      const bytes = await readRawBody(request, MAX_UPLOAD_BYTES);
      if (bytes === undefined) {
        sendError(response, "validation_failed", "upload exceeds the maximum size", correlationId);
        return true;
      }

      const result = await deps.objectStore.putStagedObject(reference, token, bytes, contentType);
      if (!result.ok) {
        const code = result.reason === "grant_token_mismatch" ? "forbidden" : "validation_failed";
        sendError(response, code, result.reason, correlationId);
        return true;
      }
      sendJson(response, 200, { staged: true, byte_size: bytes.byteLength }, correlationId);
      return true;
    }

    // ---- POST /v1/uploads/:reference/finalize : validate completion ----
    if (method === "POST" && /^\/v1\/uploads\/.+\/finalize$/.test(path)) {
      const reference = decodeURIComponent(
        path.slice("/v1/uploads/".length, path.length - "/finalize".length),
      );
      const actor = await requirePrincipal(request, response, correlationId, { requireCsrf: true });
      if (actor === undefined) return true;

      const outcome = await deps.objectStore.finalizeUpload(reference, {
        correlation_id: correlationId,
        idempotency_key: `finalize-${reference}` as never,
        idempotency_scope: `citizen:${actor.participantId}:uploads.finalize` as never,
        request_fingerprint: `sha256:${"0".repeat(64)}` as never,
      });

      if (outcome.kind === "success") {
        sendJson(response, 200, { ...outcome.value, accepted: true }, correlationId);
        return true;
      }
      if (outcome.kind === "duplicate") {
        // A retried finalize returns the committed result, not a new object.
        sendJson(
          response,
          200,
          { ...(outcome.existing_value ?? {}), accepted: true, replayed: true },
          correlationId,
        );
        return true;
      }
      sendError(
        response,
        "validation_failed",
        outcome.kind === "rejected" ? outcome.detail : "upload could not be validated",
        correlationId,
      );
      return true;
    }

    // ---- POST /v1/submissions : accept a report, return a durable receipt ----
    if (method === "POST" && path === "/v1/submissions") {
      const actor = await requirePrincipal(request, response, correlationId, { requireCsrf: true });
      if (actor === undefined) return true;

      const decision = authorize(actor.principal, "submission.create");
      if (!decision.allowed) {
        sendError(response, "forbidden", decision.reason, correlationId);
        return true;
      }

      const headerKey = request.headers["idempotency-key"];
      const idempotencyKey = Array.isArray(headerKey) ? headerKey[0] : headerKey;
      if (idempotencyKey === undefined || idempotencyKey.length === 0) {
        sendError(
          response,
          "validation_failed",
          "an Idempotency-Key header is required so a retry cannot create a second report",
          correlationId,
        );
        return true;
      }

      const body = await readJsonBody(request);
      if (body === undefined) {
        sendError(response, "validation_failed", "request body must be small JSON", correlationId);
        return true;
      }

      // The quota is charged only for a request that will actually be
      // processed, and after the idempotency key is known, so a retry of an
      // accepted report is not charged twice.
      const observed = (body["observed"] ?? {}) as Record<string, unknown>;
      const evidence = Array.isArray(body["evidence"]) ? body["evidence"] : [];

      const result = await deps.submissionService.create(
        {
          participantId: actor.participantId,
          observed: {
            lon: Number(observed["lon"]),
            lat: Number(observed["lat"]),
            // Only forwarded when the client actually sent a number. A null or
            // missing accuracy stays missing rather than becoming 0, which
            // would read as a perfect measurement (see SubmissionInput).
            ...(typeof observed["accuracy_m"] === "number"
              ? { accuracyMetres: observed["accuracy_m"] }
              : {}),
            source: observed["source"] === "manual_pin" ? "manual_pin" : "device_geolocation",
            observedAt: String(observed["observed_at"] ?? new Date().toISOString()),
          },
          interfaceLocale: String(body["interface_locale"] ?? ""),
          ...(typeof body["language_hint"] === "string"
            ? { languageHint: body["language_hint"] }
            : {}),
          ...(typeof body["text"] === "string" ? { text: body["text"] } : {}),
          evidence: (evidence as Record<string, unknown>[]).map((item) => ({
            objectReference: String(item["object_reference"]),
            mediaType: item["media_type"] === "voice" ? "voice" : "photo",
          })),
        },
        { idempotencyKey, correlationId },
      );

      if (!result.ok) {
        if (result.code === "validation_failed") {
          sendJson(
            response,
            400,
            {
              error: {
                code: "validation_failed",
                message: "the report could not be accepted",
                correlation_id: correlationId,
                issues: result.issues,
              },
            },
            correlationId,
          );
          return true;
        }
        sendError(response, "conflict", result.detail, correlationId);
        return true;
      }

      if (!result.receipt.replayed) {
        quotas.record(actor.participantId, "submission.create", Date.now());
      }
      // 202: accepted for processing. Not "resolved", not "received by a
      // department" — the receipt says only that the report is saved.
      sendJson(response, result.receipt.replayed ? 200 : 202, result.receipt, correlationId);
      return true;
    }

    // ---- GET /v1/submissions/:id : the citizen's own receipt ----
    if (method === "GET" && /^\/v1\/submissions\/[^/]+$/.test(path)) {
      const submissionId = decodeURIComponent(path.slice("/v1/submissions/".length));
      const actor = await requirePrincipal(request, response, correlationId, {
        requireCsrf: false,
      });
      if (actor === undefined) return true;

      const receipt = await deps.submissionService.readReceipt(submissionId, actor.participantId);
      if (receipt === undefined) {
        // Indistinguishable from "not yours", deliberately: a stranger must
        // not be able to probe which submission ids exist.
        sendError(response, "not_found", "no such receipt", correlationId);
        return true;
      }

      // The receipt was already scoped to this participant by the query, so
      // the owner is the principal itself; the check makes that explicit.
      const decision = authorize(actor.principal, "submission.read_own", {
        ...(actor.principal.participantId === undefined
          ? {}
          : { ownerParticipantId: actor.principal.participantId }),
      });
      if (!decision.allowed) {
        sendError(response, "forbidden", decision.reason, correlationId);
        return true;
      }
      sendJson(response, 200, receipt, correlationId);
      return true;
    }

    return false;
  };
};

export type ServerTime = IsoTimestamp;
