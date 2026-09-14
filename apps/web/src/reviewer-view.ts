/** Pure presentation rules for the V032 reviewer workspace. */

export type ReviewItemKind =
  | "redaction_decision"
  | "flagged_evidence"
  | "ambiguous_match"
  | "correction_request"
  | "uncertain_classification"
  | "disputed_resolution";

export type ReviewAction =
  | "accept_evidence"
  | "reject_evidence"
  | "approve_redaction"
  | "request_more_evidence"
  | "attach_to_issue"
  | "separate_from_issue"
  | "accept_correction"
  | "reject_correction"
  | "dismiss_trust_flag"
  | "accept_classification"
  | "reject_classification"
  | "return_disputed_work"
  | "confirm_disputed_resolution";

export type ReviewerQueueItem = {
  readonly kind: ReviewItemKind;
  readonly targetId: string;
  readonly submissionId: string;
  readonly reason: string;
  readonly permittedActions: readonly ReviewAction[];
  readonly waitingSince: string;
  readonly citizenNote?: string;
  readonly candidateIssueIds: readonly string[];
};

export type ReviewerQueueView = {
  readonly jurisdictionId: string;
  readonly items: readonly ReviewerQueueItem[];
  readonly appliedLimit: number;
  readonly exhaustive: boolean;
  readonly awaitingJurisdictionCount: number;
  readonly awaitingJurisdictionNote: string;
};

const KINDS = new Set<ReviewItemKind>([
  "redaction_decision",
  "flagged_evidence",
  "ambiguous_match",
  "correction_request",
  "uncertain_classification",
  "disputed_resolution",
]);

const ACTIONS = new Set<ReviewAction>([
  "accept_evidence",
  "reject_evidence",
  "approve_redaction",
  "request_more_evidence",
  "attach_to_issue",
  "separate_from_issue",
  "accept_correction",
  "reject_correction",
  "dismiss_trust_flag",
  "accept_classification",
  "reject_classification",
  "return_disputed_work",
  "confirm_disputed_resolution",
]);

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;

/** Invalid private data fails closed instead of becoming an actionable card. */
export const toReviewerQueueView = (payload: unknown): ReviewerQueueView | undefined => {
  const root = record(payload);
  if (root === undefined || !Array.isArray(root["items"])) return undefined;
  const jurisdictionId = root["jurisdiction_id"];
  const appliedLimit = root["applied_limit"];
  const awaitingCount = root["awaiting_jurisdiction_count"];
  const awaitingNote = root["awaiting_jurisdiction_note"];
  if (
    typeof jurisdictionId !== "string" ||
    typeof appliedLimit !== "number" ||
    typeof awaitingCount !== "number" ||
    typeof awaitingNote !== "string"
  ) {
    return undefined;
  }

  const items: ReviewerQueueItem[] = [];
  for (const raw of root["items"]) {
    const item = record(raw);
    if (item === undefined) return undefined;
    const kind = item["kind"];
    const targetId = item["target_id"];
    const submissionId = item["submission_id"];
    const reason = item["reason"];
    const waitingSince = item["waiting_since"];
    const permitted = item["permitted_actions"];
    const candidates = item["candidate_issue_ids"];
    if (
      typeof kind !== "string" ||
      !KINDS.has(kind as ReviewItemKind) ||
      typeof targetId !== "string" ||
      typeof submissionId !== "string" ||
      typeof reason !== "string" ||
      typeof waitingSince !== "string" ||
      !Array.isArray(permitted) ||
      !permitted.every(
        (action) => typeof action === "string" && ACTIONS.has(action as ReviewAction),
      ) ||
      !Array.isArray(candidates) ||
      !candidates.every((candidate) => typeof candidate === "string")
    ) {
      return undefined;
    }
    items.push({
      kind: kind as ReviewItemKind,
      targetId,
      submissionId,
      reason,
      waitingSince,
      permittedActions: permitted as ReviewAction[],
      candidateIssueIds: candidates as string[],
      ...(typeof item["citizen_note"] === "string" ? { citizenNote: item["citizen_note"] } : {}),
    });
  }

  return {
    jurisdictionId,
    items,
    appliedLimit,
    exhaustive: root["exhaustive"] === true,
    awaitingJurisdictionCount: awaitingCount,
    awaitingJurisdictionNote: awaitingNote,
  };
};

export const KIND_LABELS: Readonly<Record<ReviewItemKind, string>> = {
  redaction_decision: "Redaction decision",
  flagged_evidence: "Evidence consistency",
  ambiguous_match: "Ambiguous match",
  correction_request: "Citizen correction",
  uncertain_classification: "Classification proposal",
  // Not "resolution review". What is in front of the reviewer is a
  // disagreement between a department and the people who live with the
  // problem, and the label says so.
  disputed_resolution: "Disputed repair claim",
};

export const ACTION_LABELS: Readonly<Record<ReviewAction, string>> = {
  accept_evidence: "Accept evidence",
  reject_evidence: "Quarantine evidence",
  approve_redaction: "Approve redaction",
  request_more_evidence: "Request more evidence",
  attach_to_issue: "Attach to selected issue",
  separate_from_issue: "Separate attachment",
  accept_correction: "Accept correction",
  reject_correction: "Reject correction",
  dismiss_trust_flag: "Dismiss explained flag",
  accept_classification: "Accept classification",
  reject_classification: "Reject classification",
  // "Send back", not "reject the citizen". The dispute stays on the record
  // either way; this decides where the work goes.
  return_disputed_work: "Send the work back to the crew",
  // Offered only where the category policy grants it. The label says whose
  // decision it overrides, because that is what makes it a serious act.
  confirm_disputed_resolution: "Resolve the dispute in favour of the claim",
};

export const shortReference = (value: string): string =>
  value.length <= 12 ? value : `${value.slice(0, 8)}…${value.slice(-4)}`;

export const ageLabel = (iso: string, nowMs: number): string => {
  const elapsed = Math.max(0, nowMs - Date.parse(iso));
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${String(minutes)} min waiting`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)} hr waiting`;
  const days = Math.floor(hours / 24);
  return `${String(days)} day${days === 1 ? "" : "s"} waiting`;
};
