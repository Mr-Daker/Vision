/**
 * Browser client for the V039 district dashboard.
 *
 * Every method is a GET. There is no write on this surface and therefore no
 * CSRF token to carry: a dashboard that could change the thing it measures
 * would make "what does the district look like" depend on who has been looking
 * at it.
 *
 * Sign-in is the V036 supervisor flow, reused rather than reimplemented — the
 * dashboard needs exactly the grant a supervisor already has and nothing more,
 * so the session cookie is the same one and a supervisor who is already signed
 * in arrives here signed in.
 */

import type { ApiResult } from "./api.ts";
import type { DashboardCell, DashboardPayload, SummaryState } from "./dashboard-view.ts";

export type DashboardIssueRow = {
  readonly publicReference: string;
  readonly state: SummaryState;
  readonly openedAt: string;
  readonly ageHours: number;
  readonly countedParticipants: number;
  readonly activeEvidenceLinks: number;
};

export type DashboardIssueDetail = {
  readonly publicReference: string;
  readonly category: string;
  readonly state: SummaryState;
  readonly openedAt: string;
  readonly jurisdictionKey: string;
  readonly countedParticipants: number;
  readonly evidence: readonly {
    readonly mediaType: string;
    readonly redactionStatus: string;
    readonly derivativeReference: string | null;
    readonly availability:
      "approved_derivative" | "withheld_pending_redaction" | "text_held_not_displayed" | "erased";
  }[];
  readonly evidenceNote: string;
};

const offline = (): ApiResult<never> => ({
  ok: false,
  status: 0,
  code: "offline",
  message: "The request did not reach the server.",
  issues: [],
  offline: true,
});

const get = async <T>(path: string): Promise<ApiResult<T>> => {
  let response: Response;
  try {
    response = await fetch(path, { method: "GET", credentials: "same-origin" });
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
};

export class DashboardApiClient {
  overview(): Promise<ApiResult<DashboardPayload>> {
    return get("/v1/dashboard/overview");
  }

  /**
   * The records behind one indicator.
   *
   * The cell key travels in the URL and the server checks it against the
   * session's own grant, so editing it here reaches a refusal rather than a
   * ward this reader has no grant for.
   */
  cellIssues(
    cell: DashboardCell,
  ): Promise<ApiResult<{ readonly issues: readonly DashboardIssueRow[] }>> {
    return get(
      `/v1/dashboard/cells/${encodeURIComponent(cell.jurisdictionKey)}/${encodeURIComponent(cell.category)}/issues`,
    );
  }

  issue(publicReference: string): Promise<ApiResult<DashboardIssueDetail>> {
    return get(`/v1/dashboard/issues/${encodeURIComponent(publicReference)}`);
  }
}
