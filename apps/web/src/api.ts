/**
 * Browser client for the public API (roadmap V019).
 *
 * Same-origin on purpose: the session cookie is `SameSite=Strict` and the CSRF
 * defence is a double-submit token, so serving the interface from the API's
 * origin is what makes both work without weakening either.
 *
 * The CSRF token is held in memory here and echoed in `X-CSRF-Token`. It is
 * also in a readable cookie by design ([V009](../../../docs/foundation/V009-sessions-and-simulated-identity.md));
 * the session cookie itself is HttpOnly and this code never touches it.
 */

export type ApiFailure = {
  readonly ok: false;
  readonly status: number;
  readonly code: string;
  readonly message: string;
  /** Per-field problems, when the server returned them (V018 §3). */
  readonly issues: readonly {
    readonly field: string;
    readonly code: string;
    readonly detail: string;
  }[];
  readonly retryAfterSeconds?: number;
  /** True when the request never reached the server, so nothing was saved. */
  readonly offline: boolean;
};

export type ApiSuccess<T> = { readonly ok: true; readonly status: number; readonly value: T };
export type ApiResult<T> = ApiSuccess<T> | ApiFailure;

export type CapabilityMetadata = {
  readonly contract_version: string;
  readonly generated_at: string;
  readonly capabilities: readonly {
    readonly capability: string;
    readonly provider_mode: string;
    readonly display_label: string;
  }[];
  readonly demo_principals: readonly {
    readonly credential: string;
    readonly label: string;
    readonly credential_state: string;
  }[];
};

export type SessionInfo = {
  readonly authenticated: boolean;
  readonly session_expires_at?: string;
  readonly csrf_token?: string;
  readonly identity_mode?: string;
  readonly identity_label?: string;
  readonly reason?: string;
};

export type UploadGrant = {
  readonly object_reference: string;
  readonly upload_url: string;
  readonly expires_at: string;
  readonly max_bytes: number;
};

export type Receipt = {
  readonly submission_id: string;
  readonly status_url: string;
  readonly processing_status: string;
  readonly server_received_at: string;
  readonly replayed: boolean;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const failureFrom = (status: number, payload: unknown, retryAfter: string | null): ApiFailure => {
  const error = isRecord(payload) && isRecord(payload["error"]) ? payload["error"] : {};
  const rawIssues = error["issues"];
  const issues = Array.isArray(rawIssues)
    ? rawIssues.filter(isRecord).map((issue) => ({
        field: String(issue["field"] ?? ""),
        code: String(issue["code"] ?? ""),
        detail: String(issue["detail"] ?? ""),
      }))
    : [];

  const seconds = retryAfter === null ? Number.NaN : Number(retryAfter);
  return {
    ok: false,
    status,
    code: String(error["code"] ?? "unknown"),
    message: String(error["message"] ?? "the request was refused"),
    issues,
    ...(Number.isFinite(seconds) ? { retryAfterSeconds: seconds } : {}),
    offline: false,
  };
};

/** A request that never reached the server. Nothing was saved — say so. */
const offlineFailure = (): ApiFailure => ({
  ok: false,
  status: 0,
  code: "offline",
  message: "the request did not reach the server",
  issues: [],
  offline: true,
});

export class ApiClient {
  private csrfToken: string | undefined;

  /** Set after login or rotation; cleared on sign-out. */
  setCsrfToken(token: string | undefined): void {
    this.csrfToken = token;
  }

  get hasCsrfToken(): boolean {
    return this.csrfToken !== undefined;
  }

  private async send<T>(
    method: string,
    path: string,
    options: {
      readonly body?: unknown;
      readonly idempotencyKey?: string;
      readonly withCsrf?: boolean;
    } = {},
  ): Promise<ApiResult<T>> {
    const headers: Record<string, string> = {};
    if (options.body !== undefined) headers["content-type"] = "application/json";
    if (options.withCsrf === true && this.csrfToken !== undefined) {
      headers["x-csrf-token"] = this.csrfToken;
    }
    if (options.idempotencyKey !== undefined) {
      headers["idempotency-key"] = options.idempotencyKey;
    }

    let response: Response;
    try {
      response = await fetch(path, {
        method,
        headers,
        // Same-origin cookies only; never send credentials cross-origin.
        credentials: "same-origin",
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
    } catch {
      return offlineFailure();
    }

    const text = await response.text();
    let payload: unknown = undefined;
    if (text.length > 0) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = undefined;
      }
    }

    if (!response.ok) {
      return failureFrom(response.status, payload, response.headers.get("retry-after"));
    }
    return { ok: true, status: response.status, value: payload as T };
  }

  capabilities(): Promise<ApiResult<CapabilityMetadata>> {
    return this.send("GET", "/v1/capabilities");
  }

  // ---- V030 reads. All GETs, so none carries a CSRF token. ----

  myReports(cursor?: string): Promise<ApiResult<unknown>> {
    const query = cursor === undefined ? "" : `?cursor=${encodeURIComponent(cursor)}`;
    return this.send("GET", `/v1/me/reports${query}`);
  }

  nearbyIssues(options: {
    readonly lon: number;
    readonly lat: number;
    readonly radiusMetres?: number;
    readonly category?: string;
    readonly cursor?: string;
  }): Promise<ApiResult<unknown>> {
    const params = new URLSearchParams({
      lon: String(options.lon),
      lat: String(options.lat),
    });
    if (options.radiusMetres !== undefined) params.set("radius_m", String(options.radiusMetres));
    if (options.category !== undefined && options.category.length > 0) {
      params.set("category", options.category);
    }
    if (options.cursor !== undefined) params.set("cursor", options.cursor);
    return this.send("GET", `/v1/issues/nearby?${params.toString()}`);
  }

  /** The candidate the matcher found, for the citizen to confirm or reject (V031). */
  matchCandidate(submissionId: string, candidateIssueId: string): Promise<ApiResult<unknown>> {
    return this.send(
      "GET",
      `/v1/me/submissions/${encodeURIComponent(submissionId)}/candidate/${encodeURIComponent(candidateIssueId)}`,
    );
  }

  /**
   * Answers the question.
   *
   * No category travels with the answer — the endpoint refuses one, and this
   * deliberately has no parameter for it (V018 §2).
   */
  decideMatch(
    submissionId: string,
    decision: "confirm-match" | "reject-match",
    candidateIssueId: string,
  ): Promise<ApiResult<unknown>> {
    return this.send(
      "POST",
      `/v1/me/submissions/${encodeURIComponent(submissionId)}/${decision}`,
      // A citizen write needs the CSRF token (V009); the endpoint refuses
      // without it.
      { body: { candidate_issue_id: candidateIssueId }, withCsrf: true },
    );
  }

  /** The categories this deployment will classify, for discovery's filter (V030). */
  taxonomy(): Promise<ApiResult<unknown>> {
    return this.send("GET", "/v1/taxonomy");
  }

  issueDetail(publicReference: string): Promise<ApiResult<unknown>> {
    return this.send("GET", `/v1/issues/${encodeURIComponent(publicReference)}`);
  }

  /** The repair claim on an issue, and what this session may do about it (V035). */
  issueResolution(publicReference: string): Promise<ApiResult<unknown>> {
    return this.send("GET", `/v1/me/issues/${encodeURIComponent(publicReference)}/resolution`);
  }

  /**
   * Answers a repair claim.
   *
   * No participant is sent. The server reads the responder from the session,
   * and refuses a body that names one — so a client cannot answer for someone
   * else even by accident.
   */
  respondToResolution(
    publicReference: string,
    decision: "confirmed" | "disputed",
    comment?: string,
  ): Promise<ApiResult<unknown>> {
    return this.send(
      "POST",
      `/v1/me/issues/${encodeURIComponent(publicReference)}/resolution/respond`,
      { body: { decision, ...(comment === undefined ? {} : { comment }) }, withCsrf: true },
    );
  }

  reopenIssue(publicReference: string, reason: string): Promise<ApiResult<unknown>> {
    return this.send("POST", `/v1/me/issues/${encodeURIComponent(publicReference)}/reopen`, {
      body: { reason },
      withCsrf: true,
    });
  }

  session(): Promise<ApiResult<SessionInfo>> {
    return this.send("GET", "/v1/auth/session");
  }

  async demoLogin(credential: string): Promise<ApiResult<SessionInfo>> {
    const result = await this.send<SessionInfo>("POST", "/v1/auth/demo-login", {
      body: { credential },
    });
    if (result.ok) this.setCsrfToken(result.value.csrf_token);
    return result;
  }

  async logout(): Promise<ApiResult<SessionInfo>> {
    const result = await this.send<SessionInfo>("POST", "/v1/auth/logout", { withCsrf: true });
    this.setCsrfToken(undefined);
    return result;
  }

  requestUploadGrant(contentType: string, maxBytes: number): Promise<ApiResult<UploadGrant>> {
    return this.send("POST", "/v1/uploads", {
      body: { content_type: contentType, max_bytes: maxBytes },
      withCsrf: true,
    });
  }

  finalizeUpload(objectReference: string): Promise<ApiResult<{ readonly accepted: boolean }>> {
    return this.send("POST", `/v1/uploads/${encodeURIComponent(objectReference)}/finalize`, {
      withCsrf: true,
    });
  }

  createSubmission(body: unknown, idempotencyKey: string): Promise<ApiResult<Receipt>> {
    return this.send("POST", "/v1/submissions", { body, idempotencyKey, withCsrf: true });
  }

  receipt(submissionId: string): Promise<ApiResult<Receipt>> {
    return this.send("GET", `/v1/submissions/${encodeURIComponent(submissionId)}`);
  }

  /**
   * Sends the bytes with real progress.
   *
   * `XMLHttpRequest` rather than `fetch`, because upload progress events are
   * not available on a `fetch` request body in browsers. Progress here is the
   * bytes the browser has handed to the network — the interface must not call
   * that "uploaded" until the server has finalized the object.
   */
  putBytes(
    grant: UploadGrant,
    blob: Blob,
    onProgress: (percent: number) => void,
  ): Promise<ApiResult<{ readonly staged: boolean }>> {
    return new Promise((resolve) => {
      const request = new XMLHttpRequest();
      request.open("PUT", grant.upload_url, true);
      request.withCredentials = true;
      request.setRequestHeader("content-type", blob.type);

      request.upload.addEventListener("progress", (event) => {
        if (event.lengthComputable && event.total > 0) {
          onProgress((event.loaded / event.total) * 100);
        }
      });
      request.addEventListener("error", () => resolve(offlineFailure()));
      request.addEventListener("abort", () => resolve(offlineFailure()));
      request.addEventListener("timeout", () => resolve(offlineFailure()));
      request.addEventListener("load", () => {
        let payload: unknown = undefined;
        try {
          payload = JSON.parse(request.responseText);
        } catch {
          payload = undefined;
        }
        if (request.status >= 200 && request.status < 300) {
          resolve({ ok: true, status: request.status, value: payload as { staged: boolean } });
          return;
        }
        resolve(failureFrom(request.status, payload, request.getResponseHeader("retry-after")));
      });

      request.send(blob);
    });
  }
}
