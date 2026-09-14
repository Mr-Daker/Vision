import { test } from "node:test";
import assert from "node:assert/strict";

import {
  categoryLabel,
  confirmationProgressLabel,
  daysWaitingLabel,
  resolutionStageLabel,
  resolutionStageOf,
  toStaffInboxView,
  toStaffWorkspaces,
} from "./staff-view.ts";

const workspace = {
  jurisdiction_id: "11111111-1111-4111-8111-111111111111",
  internal_code: "DDA-B1",
  level_code: "block",
  synthetic: true,
  department_id: "demo-sanitation",
  department_label: "Sanitation (simulated)",
  recipient_mode: "simulated",
  directory_version: "demo-routing.v1",
};

const item = {
  issue_id: "22222222-2222-4222-8222-222222222222",
  public_reference: "VIS-TEST0001",
  category: "water_supply",
  current_status: "routed_internal",
  opened_at: "2026-09-01T00:00:00.000Z",
  age_days: 3.4,
  queue_position: 1,
  counted_participants: 4,
  evidence_count: 2,
  assigned_staff_id: null,
  assigned_at: null,
  assignment_reason: null,
  delivery_attempted: false,
  delivery_attempted_at: null,
  delivery_accepted: false,
  delivery_accepted_at: null,
  internally_accepted: false,
  internally_accepted_at: null,
  internally_accepted_by: null,
  internal_acceptance_note: null,
  recipient_acknowledged: false,
  recipient_acknowledgment_is_simulated: false,
  recipient_acknowledged_at: null,
  recipient_acknowledgment_reference: null,
  recipient_acknowledgment_note: null,
  status_label: "routed internally, not yet accepted by anyone",
  ordering_basis: ["waiting 3 days"],
};

test("V034: staff workspaces preserve exact jurisdiction and department pairs", () => {
  assert.deepEqual(toStaffWorkspaces([workspace]), [
    {
      jurisdictionId: workspace.jurisdiction_id,
      internalCode: "DDA-B1",
      levelCode: "block",
      synthetic: true,
      departmentId: "demo-sanitation",
      departmentLabel: "Sanitation (simulated)",
      recipientMode: "simulated",
      directoryVersion: "demo-routing.v1",
    },
  ]);
});

test("V034: an incomplete responsibility option fails closed", () => {
  assert.equal(toStaffWorkspaces([{ ...workspace, department_id: undefined }]), undefined);
});

test("V034: the inbox parser keeps all three workflow facts separate", () => {
  const parsed = toStaffInboxView({
    jurisdiction_id: workspace.jurisdiction_id,
    department_id: workspace.department_id,
    applied_limit: 100,
    exhaustive: true,
    ordering_policy_version: "demo-triage.v1",
    ordering_note: "Not a severity, risk or urgency assessment.",
    items: [
      {
        ...item,
        delivery_attempted: true,
        delivery_accepted: true,
        internally_accepted: true,
        recipient_acknowledged: true,
        recipient_acknowledgment_is_simulated: true,
        recipient_acknowledgment_reference: "SIM-ACK-ONE",
      },
    ],
  });
  assert.equal(parsed?.items[0]?.deliveryAccepted, true);
  assert.equal(parsed?.items[0]?.internallyAccepted, true);
  assert.equal(parsed?.items[0]?.recipientAcknowledged, true);
  assert.equal(parsed?.items[0]?.recipientAcknowledgmentIsSimulated, true);
  assert.equal(parsed?.items[0]?.recipientAcknowledgmentReference, "SIM-ACK-ONE");
});

test("V034: an actionable inbox item with a missing audit flag fails closed", () => {
  const { internally_accepted: _removed, ...incomplete } = item;
  assert.equal(
    toStaffInboxView({
      jurisdiction_id: workspace.jurisdiction_id,
      department_id: workspace.department_id,
      applied_limit: 100,
      exhaustive: true,
      ordering_note: "Not an urgency score.",
      items: [incomplete],
    }),
    undefined,
  );
});

test("V034: staff labels are plain-language and deterministic", () => {
  assert.equal(categoryLabel("water_supply"), "Water Supply");
  assert.equal(daysWaitingLabel(0.4), "Opened today");
  assert.equal(daysWaitingLabel(2.9), "2 days open");
});

// ---------------------------------------------------------------------------
// V035 — a claim is a claim
//
// The staff screen is where "resolved" would be most tempting and most wrong,
// so the vocabulary is asserted directly rather than left to review.
// ---------------------------------------------------------------------------

/**
 * Words this system cannot support as a positive claim.
 *
 * "Verified" is allowed only inside a negation — "not a verified resolution"
 * is the sentence V035 exists to make people read — so the check strips
 * negated clauses first and then looks for what is left asserting.
 */
const ASSERTED = /\b(resolved|verified|inspected|certified|guaranteed|safe)\b/i;
const withoutNegations = (label: string): string =>
  label.replace(
    /\bnot (?:a |an |yet )?[\w\s]*?(resolution|inspection|certification|guarantee|verified|resolved)\b/gi,
    "",
  );

const inboxItem = (overrides: Record<string, unknown> = {}) => ({
  issue_id: "22222222-2222-4222-8222-222222222222",
  public_reference: "VIS-V035-TEST",
  category: "water_supply",
  current_status: "work_planned",
  opened_at: "2026-09-01T00:00:00.000Z",
  age_days: 9,
  queue_position: 1,
  counted_participants: 2,
  evidence_count: 2,
  delivery_attempted: true,
  delivery_accepted: true,
  internally_accepted: true,
  recipient_acknowledged: true,
  recipient_acknowledgment_is_simulated: true,
  status_label: "acknowledged by a simulated recipient",
  ordering_basis: [],
  resolution_claimed_at: null,
  resolution_claim_description: null,
  completion_evidence_count: 0,
  resolution_confirmations: 0,
  resolution_disputes: 0,
  required_confirmations: 1,
  is_verified_resolution: false,
  ...overrides,
});

const parseOne = (overrides: Record<string, unknown> = {}) => {
  const view = toStaffInboxView({
    jurisdiction_id: "11111111-1111-4111-8111-111111111111",
    department_id: "demo-water-supply",
    applied_limit: 100,
    ordering_note: "not a severity, risk or urgency assessment",
    items: [inboxItem(overrides)],
  });
  const item = view?.items[0];
  assert.notEqual(item, undefined);
  return item!;
};

test("V035: no resolution state is ever described as resolved or verified", () => {
  for (const stage of [
    "not_claimable",
    "claimable",
    "awaiting_confirmation",
    "disputed",
    "confirmed",
    "reopened",
  ] as const) {
    const label = resolutionStageLabel(stage);
    assert.doesNotMatch(
      withoutNegations(label),
      ASSERTED,
      `the '${stage}' label asserts something the system cannot support: ${label}`,
    );
    // "Resolved" has no legitimate use on this screen at all, negated or not:
    // the lifecycle state is `resolution_confirmed`, and what it means is that
    // people agreed, which the label says in those words.
    assert.doesNotMatch(label, /\bresolved\b/i);
  }
});

test("V035: a claimed issue reads as awaiting confirmation, not as finished", () => {
  const item = parseOne({
    current_status: "resolution_claimed",
    resolution_claimed_at: "2026-09-10T00:00:00.000Z",
    resolution_claim_description: "Replaced the washer and resealed the joint.",
    completion_evidence_count: 1,
  });

  assert.equal(resolutionStageOf(item), "awaiting_confirmation");
  assert.match(resolutionStageLabel(resolutionStageOf(item)), /awaiting confirmation/i);
  // The flag comes from the payload, never from reading the status name.
  assert.equal(item.isVerifiedResolution, false);
});

test("V035: only a work-planned issue offers a claim", () => {
  for (const [status, stage] of [
    ["routed_internal", "not_claimable"],
    ["agency_ack_received", "not_claimable"],
    ["work_planned", "claimable"],
    ["resolution_claimed", "awaiting_confirmation"],
    ["resolution_disputed", "disputed"],
    ["resolution_confirmed", "confirmed"],
    ["reopened", "reopened"],
  ] as const) {
    assert.equal(resolutionStageOf(parseOne({ current_status: status })), stage);
  }
});

test("V035: confirmation progress is counts against a configured bar, not a score", () => {
  const item = parseOne({
    current_status: "resolution_claimed",
    resolution_claimed_at: "2026-09-10T00:00:00.000Z",
    resolution_confirmations: 1,
    required_confirmations: 2,
  });
  assert.equal(confirmationProgressLabel(item), "1 of 2 confirmations recorded");
  // No percentage anywhere: there is no calibrated number behind one.
  assert.doesNotMatch(confirmationProgressLabel(item) ?? "", /%/);
});

test("V035: a dispute is reported as a dispute, not as a lower score", () => {
  const item = parseOne({
    current_status: "resolution_disputed",
    resolution_claimed_at: "2026-09-10T00:00:00.000Z",
    resolution_disputes: 1,
    required_confirmations: 1,
  });
  assert.equal(confirmationProgressLabel(item), "1 dispute recorded");
});

test("V035: with no policy loaded, no confirmation bar is invented", () => {
  const item = parseOne({
    current_status: "resolution_claimed",
    resolution_claimed_at: "2026-09-10T00:00:00.000Z",
    required_confirmations: null,
  });
  assert.equal(item.requiredConfirmations, undefined);
  // Silent rather than guessing "1 of 1": a staff member reading a bar must be
  // reading a policy somebody configured.
  assert.equal(confirmationProgressLabel(item), undefined);
});
