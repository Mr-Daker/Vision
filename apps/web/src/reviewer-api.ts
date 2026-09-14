import type { ApiResult } from "./api.ts";

type ReviewerJurisdiction = {
  readonly jurisdiction_id: string;
  readonly internal_code: string;
  readonly level_code: string;
  readonly synthetic: boolean;
};

export type ReviewerSession = {
  readonly authenticated: boolean;
  readonly role?: string;
  readonly identity_mode?: string;
  readonly identity_label?: string;
  readonly csrf_token?: string;
  readonly jurisdictions?: readonly ReviewerJurisdiction[];
};

type ReviewerCapabilities = {
  readonly identity_mode: string;
  readonly identity_label: string;
  readonly demo_principals: readonly { readonly credential: string; readonly label: string }[];
};

const offline = (): ApiResult<never> => ({
  ok: false,
  status: 0,
  code: "offline",
  message: "The request did not reach the server.",
  issues: [],
  offline: true,
});

export class ReviewerApiClient {
  private csrfToken: string | undefined;

  constructor(cookieValue = document.cookie) {
    this.csrfToken = cookieValue
      .split(";")
      .map((pair) => pair.trim())
      .find((pair) => pair.startsWith("vision_reviewer_csrf="))
      ?.slice("vision_reviewer_csrf=".length);
  }

  private async send<T>(
    method: string,
    path: string,
    body?: unknown,
    withCsrf = false,
  ): Promise<ApiResult<T>> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (withCsrf && this.csrfToken !== undefined) headers["x-csrf-token"] = this.csrfToken;
    let response: Response;
    try {
      response = await fetch(path, {
        method,
        headers,
        credentials: "same-origin",
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      return offline();
    }
    const text = await response.text();
    let payload: unknown;
    try {
      payload = text.length === 0 ? undefined : JSON.parse(text);
    } catch {
      payload = undefined;
    }
    if (!response.ok) {
      const envelope = payload as { error?: { code?: unknown; message?: unknown } } | undefined;
      return {
        ok: false,
        status: response.status,
        code: String(envelope?.error?.code ?? "unknown"),
        message: String(envelope?.error?.message ?? "The request was refused."),
        issues: [],
        offline: false,
      };
    }
    return { ok: true, status: response.status, value: payload as T };
  }

  capabilities(): Promise<ApiResult<ReviewerCapabilities>> {
    return this.send("GET", "/v1/reviewer/capabilities");
  }

  session(): Promise<ApiResult<ReviewerSession>> {
    return this.send("GET", "/v1/reviewer/auth/session");
  }

  async login(credential: string): Promise<ApiResult<ReviewerSession>> {
    const result = await this.send<ReviewerSession>("POST", "/v1/reviewer/auth/demo-login", {
      credential,
    });
    if (result.ok) this.csrfToken = result.value.csrf_token;
    return result;
  }

  async logout(): Promise<ApiResult<ReviewerSession>> {
    const result = await this.send<ReviewerSession>(
      "POST",
      "/v1/reviewer/auth/logout",
      undefined,
      true,
    );
    this.csrfToken = undefined;
    return result;
  }

  queue(jurisdictionId: string): Promise<ApiResult<unknown>> {
    return this.send(
      "GET",
      `/v1/reviewer/queue?jurisdiction_id=${encodeURIComponent(jurisdictionId)}`,
    );
  }

  async original(input: {
    readonly kind: string;
    readonly targetId: string;
    readonly jurisdictionId: string;
  }): Promise<ApiResult<{ readonly objectUrl: string }>> {
    let response: Response;
    try {
      response = await fetch(
        `/v1/reviewer/queue/${encodeURIComponent(input.kind)}/${encodeURIComponent(input.targetId)}/original?jurisdiction_id=${encodeURIComponent(input.jurisdictionId)}`,
        {
          method: "GET",
          headers: { "x-access-purpose": `Reviewing pending ${input.kind.replaceAll("_", " ")}` },
          credentials: "same-origin",
        },
      );
    } catch {
      return offline();
    }
    if (!response.ok) {
      let payload: { error?: { code?: unknown; message?: unknown } } | undefined;
      try {
        payload = (await response.json()) as typeof payload;
      } catch {
        payload = undefined;
      }
      return {
        ok: false,
        status: response.status,
        code: String(payload?.error?.code ?? "unknown"),
        message: String(payload?.error?.message ?? "The private original could not be opened."),
        issues: [],
        offline: false,
      };
    }
    return {
      ok: true,
      status: response.status,
      value: { objectUrl: URL.createObjectURL(await response.blob()) },
    };
  }

  decide(input: {
    readonly kind: string;
    readonly targetId: string;
    readonly jurisdictionId: string;
    readonly action: string;
    readonly reason: string;
    readonly candidateIssueId?: string;
  }): Promise<ApiResult<unknown>> {
    return this.send(
      "POST",
      `/v1/reviewer/queue/${encodeURIComponent(input.kind)}/${encodeURIComponent(input.targetId)}/decisions`,
      {
        action: input.action,
        reason: input.reason,
        jurisdiction_id: input.jurisdictionId,
        ...(input.candidateIssueId === undefined
          ? {}
          : { candidate_issue_id: input.candidateIssueId }),
      },
      true,
    );
  }
}
