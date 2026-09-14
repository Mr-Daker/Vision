/** Pure parsing and presentation rules for the V034 department inbox. */

export type StaffWorkspace = {
  readonly jurisdictionId: string;
  readonly internalCode: string;
  readonly levelCode: string;
  readonly synthetic: boolean;
  readonly departmentId: string;
  readonly departmentLabel: string;
  readonly recipientMode: "simulated" | "real";
  readonly directoryVersion: string;
};

export type StaffInboxItem = {
  readonly issueId: string;
  readonly publicReference: string;
  readonly category: string;
  readonly currentStatus: string;
  readonly openedAt: string;
  readonly ageDays: number;
  readonly queuePosition: number;
  readonly countedParticipants: number;
  readonly evidenceCount: number;
  readonly assignedStaffId?: string;
  readonly assignedAt?: string;
  readonly assignmentReason?: string;
  readonly deliveryAttempted: boolean;
  readonly deliveryAttemptedAt?: string;
  readonly deliveryAccepted: boolean;
  readonly deliveryAcceptedAt?: string;
  readonly internallyAccepted: boolean;
  readonly internallyAcceptedAt?: string;
  readonly internallyAcceptedBy?: string;
  readonly internalAcceptanceNote?: string;
  readonly recipientAcknowledged: boolean;
  readonly recipientAcknowledgmentIsSimulated: boolean;
  readonly recipientAcknowledgedAt?: string;
  readonly recipientAcknowledgmentReference?: string;
  readonly recipientAcknowledgmentNote?: string;
  readonly statusLabel: string;
  readonly orderingBasis: readonly string[];
  // ── V035 ─────────────────────────────────────────────────────────────────
  readonly resolutionClaimedAt?: string;
  readonly resolutionClaimDescription?: string;
  readonly completionEvidenceCount: number;
  readonly resolutionConfirmations: number;
  readonly resolutionDisputes: number;
  readonly requiredConfirmations?: number;
  /** True only for a standing confirmed resolution. Never for a claim. */
  readonly isVerifiedResolution: boolean;
};

export type StaffInboxView = {
  readonly jurisdictionId: string;
  readonly departmentId: string;
  readonly appliedLimit: number;
  readonly exhaustive: boolean;
  readonly orderingPolicyVersion?: string;
  readonly orderingNote: string;
  readonly items: readonly StaffInboxItem[];
};

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;

const optionalString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

export const toStaffWorkspaces = (value: unknown): readonly StaffWorkspace[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const result: StaffWorkspace[] = [];
  for (const raw of value) {
    const item = record(raw);
    if (item === undefined) return undefined;
    const recipientMode = item["recipient_mode"];
    if (
      typeof item["jurisdiction_id"] !== "string" ||
      typeof item["internal_code"] !== "string" ||
      typeof item["level_code"] !== "string" ||
      typeof item["synthetic"] !== "boolean" ||
      typeof item["department_id"] !== "string" ||
      typeof item["department_label"] !== "string" ||
      (recipientMode !== "simulated" && recipientMode !== "real") ||
      typeof item["directory_version"] !== "string"
    ) {
      return undefined;
    }
    result.push({
      jurisdictionId: item["jurisdiction_id"],
      internalCode: item["internal_code"],
      levelCode: item["level_code"],
      synthetic: item["synthetic"],
      departmentId: item["department_id"],
      departmentLabel: item["department_label"],
      recipientMode,
      directoryVersion: item["directory_version"],
    });
  }
  return result;
};

export const toStaffInboxView = (payload: unknown): StaffInboxView | undefined => {
  const root = record(payload);
  if (root === undefined || !Array.isArray(root["items"])) return undefined;
  if (
    typeof root["jurisdiction_id"] !== "string" ||
    typeof root["department_id"] !== "string" ||
    typeof root["applied_limit"] !== "number" ||
    typeof root["ordering_note"] !== "string"
  ) {
    return undefined;
  }

  const items: StaffInboxItem[] = [];
  for (const raw of root["items"]) {
    const item = record(raw);
    if (item === undefined || !Array.isArray(item["ordering_basis"])) return undefined;
    if (
      typeof item["issue_id"] !== "string" ||
      typeof item["public_reference"] !== "string" ||
      typeof item["category"] !== "string" ||
      typeof item["current_status"] !== "string" ||
      typeof item["opened_at"] !== "string" ||
      typeof item["age_days"] !== "number" ||
      typeof item["queue_position"] !== "number" ||
      typeof item["counted_participants"] !== "number" ||
      typeof item["evidence_count"] !== "number" ||
      typeof item["delivery_attempted"] !== "boolean" ||
      typeof item["delivery_accepted"] !== "boolean" ||
      typeof item["internally_accepted"] !== "boolean" ||
      typeof item["recipient_acknowledged"] !== "boolean" ||
      typeof item["recipient_acknowledgment_is_simulated"] !== "boolean" ||
      typeof item["status_label"] !== "string" ||
      !item["ordering_basis"].every((basis) => typeof basis === "string")
    ) {
      return undefined;
    }
    const assignedStaffId = optionalString(item["assigned_staff_id"]);
    const assignedAt = optionalString(item["assigned_at"]);
    const assignmentReason = optionalString(item["assignment_reason"]);
    const deliveryAttemptedAt = optionalString(item["delivery_attempted_at"]);
    const deliveryAcceptedAt = optionalString(item["delivery_accepted_at"]);
    const internallyAcceptedAt = optionalString(item["internally_accepted_at"]);
    const internallyAcceptedBy = optionalString(item["internally_accepted_by"]);
    const internalAcceptanceNote = optionalString(item["internal_acceptance_note"]);
    const recipientAcknowledgedAt = optionalString(item["recipient_acknowledged_at"]);
    const recipientAcknowledgmentReference = optionalString(
      item["recipient_acknowledgment_reference"],
    );
    const recipientAcknowledgmentNote = optionalString(item["recipient_acknowledgment_note"]);
    items.push({
      issueId: item["issue_id"],
      publicReference: item["public_reference"],
      category: item["category"],
      currentStatus: item["current_status"],
      openedAt: item["opened_at"],
      ageDays: item["age_days"],
      queuePosition: item["queue_position"],
      countedParticipants: item["counted_participants"],
      evidenceCount: item["evidence_count"],
      ...(assignedStaffId === undefined ? {} : { assignedStaffId }),
      ...(assignedAt === undefined ? {} : { assignedAt }),
      ...(assignmentReason === undefined ? {} : { assignmentReason }),
      deliveryAttempted: item["delivery_attempted"],
      ...(deliveryAttemptedAt === undefined ? {} : { deliveryAttemptedAt }),
      deliveryAccepted: item["delivery_accepted"],
      ...(deliveryAcceptedAt === undefined ? {} : { deliveryAcceptedAt }),
      internallyAccepted: item["internally_accepted"],
      ...(internallyAcceptedAt === undefined ? {} : { internallyAcceptedAt }),
      ...(internallyAcceptedBy === undefined ? {} : { internallyAcceptedBy }),
      ...(internalAcceptanceNote === undefined ? {} : { internalAcceptanceNote }),
      recipientAcknowledged: item["recipient_acknowledged"],
      recipientAcknowledgmentIsSimulated: item["recipient_acknowledgment_is_simulated"],
      ...(recipientAcknowledgedAt === undefined ? {} : { recipientAcknowledgedAt }),
      ...(recipientAcknowledgmentReference === undefined
        ? {}
        : { recipientAcknowledgmentReference }),
      ...(recipientAcknowledgmentNote === undefined ? {} : { recipientAcknowledgmentNote }),
      statusLabel: item["status_label"],
      ...(optionalString(item["resolution_claimed_at"]) === undefined
        ? {}
        : { resolutionClaimedAt: String(item["resolution_claimed_at"]) }),
      ...(optionalString(item["resolution_claim_description"]) === undefined
        ? {}
        : { resolutionClaimDescription: String(item["resolution_claim_description"]) }),
      completionEvidenceCount: Number(item["completion_evidence_count"] ?? 0),
      resolutionConfirmations: Number(item["resolution_confirmations"] ?? 0),
      resolutionDisputes: Number(item["resolution_disputes"] ?? 0),
      ...(typeof item["required_confirmations"] === "number"
        ? { requiredConfirmations: item["required_confirmations"] }
        : {}),
      // Taken from the payload rather than inferred from the status string, so
      // a client cannot start treating `resolution_claimed` as resolved by
      // reading the name.
      isVerifiedResolution: item["is_verified_resolution"] === true,
      orderingBasis: item["ordering_basis"] as string[],
    });
  }

  const orderingPolicyVersion = optionalString(root["ordering_policy_version"]);
  return {
    jurisdictionId: root["jurisdiction_id"],
    departmentId: root["department_id"],
    appliedLimit: root["applied_limit"],
    exhaustive: root["exhaustive"] === true,
    ...(orderingPolicyVersion === undefined ? {} : { orderingPolicyVersion }),
    orderingNote: root["ordering_note"],
    items,
  };
};

export const categoryLabel = (category: string): string =>
  category
    .split("_")
    .filter((part) => part.length > 0)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");

export const daysWaitingLabel = (ageDays: number): string => {
  if (ageDays < 1) return "Opened today";
  const days = Math.max(1, Math.floor(ageDays));
  return `${String(days)} day${days === 1 ? "" : "s"} open`;
};

export const shortStaffId = (value: string): string =>
  value.length <= 12 ? value : `${value.slice(0, 8)}…`;

/**
 * What a staff member reads about a repair claim (roadmap V035).
 *
 * The words "resolved", "verified", "inspected", "safe" and "certified" appear
 * nowhere below, and `staff-view.test.ts` asserts that for every state. A claim
 * is a claim until people who live with the problem say otherwise, and the
 * screen that lets staff make one is exactly where that must not blur.
 */
export type ResolutionStage =
  "not_claimable" | "claimable" | "awaiting_confirmation" | "disputed" | "confirmed" | "reopened";

export const resolutionStageOf = (item: StaffInboxItem): ResolutionStage => {
  switch (item.currentStatus) {
    case "resolution_claimed":
      return "awaiting_confirmation";
    case "resolution_disputed":
      return "disputed";
    case "resolution_confirmed":
      return "confirmed";
    case "reopened":
      return "reopened";
    case "work_planned":
      return "claimable";
    default:
      return "not_claimable";
  }
};

export const resolutionStageLabel = (stage: ResolutionStage): string => {
  switch (stage) {
    case "claimable":
      return "Work planned — a completion claim can be recorded";
    case "awaiting_confirmation":
      return "Claimed, awaiting confirmation — not a verified resolution";
    case "disputed":
      return "A participant disputes this claim; a reviewer decides what happens next";
    case "confirmed":
      return "Participants agreed the visible problem appears fixed";
    case "reopened":
      return "Reopened after confirmation, so this issue is open again";
    default:
      return "A completion claim needs an acknowledged, assigned issue with work planned";
  }
};

/** "1 of 2 confirmations recorded" — never a percentage, never a score. */
export const confirmationProgressLabel = (item: StaffInboxItem): string | undefined => {
  if (item.requiredConfirmations === undefined || item.resolutionClaimedAt === undefined) {
    return undefined;
  }
  if (item.resolutionDisputes > 0) {
    return `${String(item.resolutionDisputes)} dispute${item.resolutionDisputes === 1 ? "" : "s"} recorded`;
  }
  return `${String(item.resolutionConfirmations)} of ${String(item.requiredConfirmations)} confirmations recorded`;
};
