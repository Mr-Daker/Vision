import type { ApiResult } from "./api.ts";

export type StaffSessionPayload = {
  readonly authenticated: boolean;
  readonly role?: string;
  readonly identity_mode?: string;
  readonly identity_label?: string;
  readonly csrf_token?: string;
  readonly workspaces?: unknown;
};

/** What the server says about a recorded claim. Never "resolved". */
export type StaffClaimResult = {
  readonly claim_id?: string;
  readonly replayed?: boolean;
  readonly issue_status?: string;
  readonly is_verified_resolution?: boolean;
  readonly awaiting_confirmation?: boolean;
  readonly required_confirmations?: number | null;
  readonly disclosures?: readonly string[];
};

type StaffCapabilities = {
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

export class StaffApiClient {
  private csrfToken: string | undefined;

  constructor(cookieValue = document.cookie) {
    this.csrfToken = cookieValue
      .split(";")
      .map((pair) => pair.trim())
      .find((pair) => pair.startsWith("vision_staff_csrf="))
      ?.slice("vision_staff_csrf=".length);
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

  capabilities(): Promise<ApiResult<StaffCapabilities>> {
    return this.send("GET", "/v1/staff/capabilities");
  }

  session(): Promise<ApiResult<StaffSessionPayload>> {
    return this.send("GET", "/v1/staff/auth/session");
  }

  async login(credential: string): Promise<ApiResult<StaffSessionPayload>> {
    const result = await this.send<StaffSessionPayload>("POST", "/v1/staff/auth/demo-login", {
      credential,
    });
    if (result.ok) this.csrfToken = result.value.csrf_token;
    return result;
  }

  async logout(): Promise<ApiResult<StaffSessionPayload>> {
    const result = await this.send<StaffSessionPayload>(
      "POST",
      "/v1/staff/auth/logout",
      undefined,
      true,
    );
    this.csrfToken = undefined;
    return result;
  }

  inbox(jurisdictionId: string, departmentId: string): Promise<ApiResult<unknown>> {
    return this.send(
      "GET",
      `/v1/staff/inbox?jurisdiction_id=${encodeURIComponent(jurisdictionId)}&department_id=${encodeURIComponent(departmentId)}`,
    );
  }

  act(input: {
    readonly issueId: string;
    readonly action:
      | "accept_internal"
      | "assign_to_self"
      | "simulate_recipient_acknowledgment"
      | "claim_resolution";
    readonly jurisdictionId: string;
    readonly departmentId: string;
    readonly note: string;
    /** V035: object references for completion photographs already uploaded. */
    readonly completionEvidence?: readonly string[];
    /** V035: so a retried claim returns the first one instead of making a second. */
    readonly idempotencyKey?: string;
  }): Promise<ApiResult<StaffClaimResult>> {
    return this.send(
      "POST",
      `/v1/staff/issues/${encodeURIComponent(input.issueId)}/actions`,
      {
        action: input.action,
        jurisdiction_id: input.jurisdictionId,
        department_id: input.departmentId,
        note: input.note,
        ...(input.completionEvidence === undefined
          ? {}
          : {
              completion_evidence: input.completionEvidence.map((reference) => ({
                object_reference: reference,
              })),
            }),
        ...(input.idempotencyKey === undefined ? {} : { idempotency_key: input.idempotencyKey }),
      },
      true,
    );
  }

  /**
   * Uploads one completion photograph (V035).
   *
   * The same grant → bytes → finalize path citizen evidence uses, against the
   * staff session. Returns the object reference the claim will name; the bytes
   * are in the store before any claim mentions them, which is what stops a
   * claim recording a photograph that does not exist.
   */
  async uploadCompletionPhoto(
    file: File,
  ): Promise<ApiResult<{ readonly objectReference: string }>> {
    const grant = await this.send<{
      readonly object_reference: string;
      readonly upload_url: string;
    }>("POST", "/v1/staff/uploads", { content_type: file.type, max_bytes: file.size }, true);
    if (!grant.ok) return grant;

    const url = grant.value.upload_url.replace("/v1/uploads/", "/v1/staff/uploads/");
    let put: Response;
    try {
      put = await fetch(url, {
        method: "PUT",
        headers: { "content-type": file.type },
        credentials: "same-origin",
        body: file,
      });
    } catch {
      return offline();
    }
    if (!put.ok) {
      return {
        ok: false,
        status: put.status,
        code: "upload_failed",
        message: "The photograph did not finish uploading.",
        issues: [],
        offline: false,
      };
    }

    const finalized = await this.send<{ readonly accepted: boolean }>(
      "POST",
      `/v1/staff/uploads/${encodeURIComponent(grant.value.object_reference)}/finalize`,
      undefined,
      true,
    );
    if (!finalized.ok) return finalized;
    return {
      ok: true,
      status: finalized.status,
      value: { objectReference: grant.value.object_reference },
    };
  }
}
