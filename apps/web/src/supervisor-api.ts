import type { ApiResult } from "./api.ts";

type SupervisorJurisdiction = {
  readonly jurisdiction_id: string;
  readonly internal_code: string;
  readonly level_code: string;
  readonly synthetic: boolean;
};

export type SupervisorSession = {
  readonly authenticated: boolean;
  readonly role?: string;
  readonly identity_mode?: string;
  readonly identity_label?: string;
  readonly csrf_token?: string;
  readonly jurisdictions?: readonly SupervisorJurisdiction[];
};

export type SupervisorCapabilities = {
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

export class SupervisorApiClient {
  private csrfToken: string | undefined;

  constructor(cookieValue = document.cookie) {
    this.csrfToken = cookieValue
      .split(";")
      .map((pair) => pair.trim())
      .find((pair) => pair.startsWith("vision_supervisor_csrf="))
      ?.slice("vision_supervisor_csrf=".length);
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

  capabilities(): Promise<ApiResult<SupervisorCapabilities>> {
    return this.send("GET", "/v1/supervisor/capabilities");
  }

  session(): Promise<ApiResult<SupervisorSession>> {
    return this.send("GET", "/v1/supervisor/auth/session");
  }

  async login(credential: string): Promise<ApiResult<SupervisorSession>> {
    const result = await this.send<SupervisorSession>("POST", "/v1/supervisor/auth/demo-login", {
      credential,
    });
    if (result.ok) this.csrfToken = result.value.csrf_token;
    return result;
  }

  async logout(): Promise<ApiResult<SupervisorSession>> {
    const result = await this.send<SupervisorSession>(
      "POST",
      "/v1/supervisor/auth/logout",
      undefined,
      true,
    );
    this.csrfToken = undefined;
    return result;
  }

  queues(jurisdictionId: string): Promise<ApiResult<unknown>> {
    return this.send(
      "GET",
      `/v1/supervisor/queues?jurisdiction_id=${encodeURIComponent(jurisdictionId)}`,
    );
  }

  /**
   * Records a reviewed override of the ageing clock for one issue (V036).
   *
   * Not a severity: the payload carries days and a reason, and the server
   * answers with `is_severity_assessment: false`.
   */
  override(input: {
    readonly issueId: string;
    readonly alertAfterDays: number;
    readonly escalateAfterDays: number;
    readonly reason: string;
  }): Promise<ApiResult<unknown>> {
    return this.send(
      "POST",
      `/v1/supervisor/issues/${encodeURIComponent(input.issueId)}/ageing-override`,
      {
        alert_after_days: input.alertAfterDays,
        escalate_after_days: input.escalateAfterDays,
        reason: input.reason,
      },
      true,
    );
  }

  acknowledge(input: {
    readonly alertId: string;
    readonly jurisdictionId: string;
  }): Promise<ApiResult<unknown>> {
    return this.send(
      "POST",
      `/v1/supervisor/alerts/${encodeURIComponent(input.alertId)}/acknowledge`,
      { jurisdiction_id: input.jurisdictionId },
      true,
    );
  }
}
