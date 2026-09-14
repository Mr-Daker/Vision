import { test } from "node:test";
import assert from "node:assert/strict";

import { unsafeTimestamp, unsafeUuid } from "@vision/contracts";

import {
  canTransitionIssue,
  canTransitionIssueMatch,
  canTransitionSubmission,
  evidenceAttachmentChangesStatus,
  type IssueStatus,
  type IssueTransitionContext,
} from "./transitions.ts";
import { aliasClosureOf, isRetiredByAlias, resolveActiveRoot, wouldCreateCycle } from "./alias.ts";
import {
  CorrectionError,
  classifyRecurrence,
  evaluateParticipationEligibility,
  planCorrection,
} from "./participation.ts";

const ACTOR = unsafeUuid("6ba7b810-9dad-41d1-80b4-00c04fd430c8");
const at = (iso: string) => unsafeTimestamp(iso);

const issueContext = (overrides: Partial<IssueTransitionContext> = {}): IssueTransitionContext => ({
  actor: "staff",
  hasActiveOutgoingAlias: false,
  ...overrides,
});

// ---------------------------------------------------------------------------
// Submission transitions
// ---------------------------------------------------------------------------

test("V014: submission transitions follow the contract matrix", () => {
  assert.equal(canTransitionSubmission("received", "processing", "system_worker").ok, true);
  assert.equal(canTransitionSubmission("processing", "accepted", "system_worker").ok, true);
  assert.equal(canTransitionSubmission("needs_review", "accepted", "reviewer").ok, true);
  assert.equal(canTransitionSubmission("quarantined", "needs_review", "reviewer").ok, true);

  // Invalid edges
  assert.equal(canTransitionSubmission("accepted", "processing", "system_worker").ok, false);
  assert.equal(canTransitionSubmission("rejected", "accepted", "reviewer").ok, false);
  assert.equal(canTransitionSubmission("received", "accepted", "system_worker").ok, false);
});

test("V014: leaving review or quarantine requires a reviewer", () => {
  assert.equal(canTransitionSubmission("needs_review", "accepted", "system_worker").ok, false);
  assert.equal(canTransitionSubmission("quarantined", "needs_review", "citizen").ok, false);
  assert.equal(canTransitionSubmission("received", "processing", "citizen").ok, false);
});

// ---------------------------------------------------------------------------
// Match transitions
// ---------------------------------------------------------------------------

test("V014: a terminal match needs a result and a transactional recheck", () => {
  const base = { recheckedInTransaction: true, decidedBy: "system" as const };

  assert.equal(
    canTransitionIssueMatch("candidates_retrieved", "no_match", {
      ...base,
      resultingIssueId: "issue-1",
    }).ok,
    true,
  );

  // No result recorded.
  assert.equal(canTransitionIssueMatch("candidates_retrieved", "no_match", base).ok, false);

  // No recheck: a stale candidate decision could commit against changed data.
  assert.equal(
    canTransitionIssueMatch("candidates_retrieved", "match_confirmed", {
      ...base,
      recheckedInTransaction: false,
      resultingIssueId: "issue-1",
    }).ok,
    false,
  );
});

test("V014: an ambiguous match cannot be resolved by the system alone", () => {
  const context = {
    recheckedInTransaction: true,
    resultingIssueId: "issue-1",
  };
  assert.equal(
    canTransitionIssueMatch("ambiguous", "match_confirmed", { ...context, decidedBy: "system" }).ok,
    false,
  );
  assert.equal(
    canTransitionIssueMatch("ambiguous", "match_confirmed", { ...context, decidedBy: "reviewer" })
      .ok,
    true,
  );
  assert.equal(
    canTransitionIssueMatch("ambiguous", "no_match", { ...context, decidedBy: "citizen" }).ok,
    true,
  );
});

test("V014: terminal match states are terminal", () => {
  const context = { recheckedInTransaction: true, decidedBy: "reviewer" as const };
  assert.equal(canTransitionIssueMatch("no_match", "match_confirmed", context).ok, false);
  assert.equal(canTransitionIssueMatch("match_confirmed", "ambiguous", context).ok, false);
});

// ---------------------------------------------------------------------------
// The central guard: a claim cannot be confirmed by asserting a status
// ---------------------------------------------------------------------------

test("V014: a resolution claim cannot become confirmed without a confirmation record", () => {
  // A client supplying the desired end state is not enough.
  const denied = canTransitionIssue("resolution_claimed", "resolution_confirmed", issueContext());
  assert.equal(denied.ok, false);
  if (!denied.ok) {
    assert.match(denied.reason, /without a persisted confirmation record/);
  }

  const allowed = canTransitionIssue(
    "resolution_claimed",
    "resolution_confirmed",
    issueContext({
      confirmation: {
        confirmationId: "conf-1",
        decision: "confirmed",
        actor: "participant",
        participantHasCountedParticipation: true,
      },
    }),
  );
  assert.equal(allowed.ok, true);
});

test("V014: a confirmation record must actually say confirmed", () => {
  const mismatched = canTransitionIssue(
    "resolution_claimed",
    "resolution_confirmed",
    issueContext({
      confirmation: { confirmationId: "conf-1", decision: "disputed", actor: "reviewer" },
    }),
  );
  assert.equal(mismatched.ok, false);
});

test("V014: a participant may only confirm where their participation counts", () => {
  const uncounted = canTransitionIssue(
    "resolution_claimed",
    "resolution_confirmed",
    issueContext({
      confirmation: {
        confirmationId: "conf-1",
        decision: "confirmed",
        actor: "participant",
        participantHasCountedParticipation: false,
      },
    }),
  );
  assert.equal(uncounted.ok, false);

  // A reviewer needs no participation.
  const reviewer = canTransitionIssue(
    "resolution_claimed",
    "resolution_confirmed",
    issueContext({
      confirmation: { confirmationId: "conf-1", decision: "confirmed", actor: "reviewer" },
    }),
  );
  assert.equal(reviewer.ok, true);
});

test("V014: internal routing is never acknowledgment", () => {
  const noRecord = canTransitionIssue(
    "routed_internal",
    "agency_ack_received",
    issueContext({ actor: "system_worker" }),
  );
  assert.equal(noRecord.ok, false);
  if (!noRecord.ok) assert.match(noRecord.reason, /internal routing is not acknowledgment/);

  // A simulated provider may acknowledge, but only as a simulated fixture.
  const simulated = canTransitionIssue(
    "routed_internal",
    "agency_ack_received",
    issueContext({
      acknowledgment: {
        providerMode: "simulated",
        authenticity: "simulated_fixture",
        recordedActor: "simulated-department-inbox",
      },
    }),
  );
  assert.equal(simulated.ok, true);

  // A real provider cannot produce a simulated-fixture acknowledgment.
  const inconsistent = canTransitionIssue(
    "routed_internal",
    "agency_ack_received",
    issueContext({
      acknowledgment: {
        providerMode: "real",
        authenticity: "simulated_fixture",
        recordedActor: "x",
      },
    }),
  );
  assert.equal(inconsistent.ok, false);
});

test("V014: other issue guards are enforced", () => {
  // 'created' is never re-entered.
  for (const from of ["routed_internal", "work_planned", "reopened"] as IssueStatus[]) {
    assert.equal(canTransitionIssue(from, "created", issueContext()).ok, false);
  }

  // Routing must record its directory version.
  assert.equal(canTransitionIssue("created", "routed_internal", issueContext()).ok, false);
  assert.equal(
    canTransitionIssue(
      "created",
      "routed_internal",
      issueContext({ routingDirectoryVersion: "demo-routing.v1" }),
    ).ok,
    true,
  );

  // Claiming resolution needs staff and at least one piece of evidence.
  assert.equal(
    canTransitionIssue(
      "work_planned",
      "resolution_claimed",
      issueContext({ claim: { claimId: "c1", evidenceCount: 0 } }),
    ).ok,
    false,
  );
  assert.equal(
    canTransitionIssue(
      "work_planned",
      "resolution_claimed",
      issueContext({ actor: "citizen", claim: { claimId: "c1", evidenceCount: 1 } }),
    ).ok,
    false,
  );

  // Reopening needs a record with a reason.
  assert.equal(
    canTransitionIssue(
      "resolution_confirmed",
      "reopened",
      issueContext({ reopening: { reopeningId: "r1", reason: "  " } }),
    ).ok,
    false,
  );
  assert.equal(
    canTransitionIssue(
      "resolution_confirmed",
      "reopened",
      issueContext({ reopening: { reopeningId: "r1", reason: "recurred within a week" } }),
    ).ok,
    true,
  );
});

test("V014: a merged-away issue takes no operational writes", () => {
  const denied = canTransitionIssue(
    "work_planned",
    "resolution_claimed",
    issueContext({
      hasActiveOutgoingAlias: true,
      claim: { claimId: "c1", evidenceCount: 2 },
    }),
  );
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.match(denied.reason, /active outgoing alias/);
});

test("V014: attaching evidence never changes issue status", () => {
  assert.equal(evidenceAttachmentChangesStatus(), false);
});

// ---------------------------------------------------------------------------
// Alias rules
// ---------------------------------------------------------------------------

test("V014: an issue with no active edge is its own root", () => {
  const resolved = resolveActiveRoot("A", []);
  assert.equal(resolved.ok, true);
  if (resolved.ok) {
    assert.equal(resolved.rootIssueId, "A");
    assert.equal(resolved.hops, 0);
  }
});

test("V014: resolution follows a chain of active edges", () => {
  const edges = [
    { source_issue_id: "C", target_issue_id: "B" },
    { source_issue_id: "B", target_issue_id: "A" },
  ];
  const resolved = resolveActiveRoot("C", edges);
  assert.equal(resolved.ok, true);
  if (resolved.ok) {
    assert.equal(resolved.rootIssueId, "A");
    assert.equal(resolved.hops, 2);
  }
});

test("V014: a closed edge stops participating, restoring the original issue", () => {
  // This is what makes merge reversal need no replacement issue.
  const edges = [{ source_issue_id: "B", target_issue_id: "A", valid_to: "2026-09-09T00:00:00Z" }];
  const resolved = resolveActiveRoot("B", edges);
  assert.equal(resolved.ok, true);
  if (resolved.ok) assert.equal(resolved.rootIssueId, "B");
  assert.equal(isRetiredByAlias("B", edges), false);
});

test("V014: a cycle is detected rather than followed forever", () => {
  const edges = [
    { source_issue_id: "A", target_issue_id: "B" },
    { source_issue_id: "B", target_issue_id: "A" },
  ];
  const resolved = resolveActiveRoot("A", edges);
  assert.equal(resolved.ok, false);
  if (!resolved.ok) assert.equal(resolved.reason, "cycle_detected");
});

test("V014: depth beyond the bound fails safely instead of resolving", () => {
  const edges = Array.from({ length: 20 }, (_, index) => ({
    source_issue_id: `n${String(index)}`,
    target_issue_id: `n${String(index + 1)}`,
  }));
  const resolved = resolveActiveRoot("n0", edges);
  assert.equal(resolved.ok, false);
  if (!resolved.ok) assert.equal(resolved.reason, "depth_exceeded");

  // Within the bound it resolves.
  assert.equal(resolveActiveRoot("n17", edges).ok, true);
});

test("V014: a merge that would cycle is rejected before it commits", () => {
  const edges = [{ source_issue_id: "B", target_issue_id: "A" }];
  assert.equal(wouldCreateCycle("A", "B", edges), true, "A -> B would close the loop");
  assert.equal(wouldCreateCycle("A", "A", []), true, "self-merge");
  assert.equal(wouldCreateCycle("C", "A", edges), false);
});

test("V014: the alias closure is what analytics counts over", () => {
  const edges = [
    { source_issue_id: "B", target_issue_id: "A" },
    { source_issue_id: "C", target_issue_id: "B" },
    { source_issue_id: "D", target_issue_id: "Z", valid_to: "2026-09-01T00:00:00Z" },
  ];
  assert.deepEqual(aliasClosureOf("A", edges), ["A", "B", "C"]);
  assert.deepEqual(aliasClosureOf("Z", edges), ["Z"], "a closed edge is not in the closure");
});

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

test("V014: participation eligibility requires session and consent", () => {
  const participant = { participant_id: ACTOR, created_at: at("2026-09-01T00:00:00Z") };
  const base = {
    participant,
    hasValidSession: true,
    grantedPurposes: ["demo_processing"],
    identityProviderMode: "simulated" as const,
  };

  assert.equal(evaluateParticipationEligibility(base).counted, true);

  const noSession = evaluateParticipationEligibility({ ...base, hasValidSession: false });
  assert.equal(noSession.counted, false);

  const noConsent = evaluateParticipationEligibility({ ...base, grantedPurposes: [] });
  assert.equal(noConsent.counted, false);
  if (!noConsent.counted) assert.match(noConsent.reason, /consent/);

  const tombstoned = evaluateParticipationEligibility({
    ...base,
    participant: { ...participant, tombstoned_at: at("2026-09-05T00:00:00Z") },
  });
  assert.equal(tombstoned.counted, false);
  if (!tombstoned.counted) assert.match(tombstoned.reason, /tombstoned/);
});

// ---------------------------------------------------------------------------
// Recurrence
// ---------------------------------------------------------------------------

test("V014: recurrence after a confirmed resolution always needs a human decision", () => {
  const result = classifyRecurrence({
    assetId: "demo-asset-005",
    priorIssueStatus: "resolution_confirmed",
    priorConfirmedAt: at("2026-06-15T00:00:00Z"),
    newObservedAt: at("2026-09-07T05:30:00Z"),
    sameCategory: true,
    sameDefect: true,
  });

  assert.equal(result.isRecurrenceCandidate, true);
  assert.equal(result.requiresHumanDecision, true, "the system must never decide this alone");
  assert.deepEqual(result.permittedTreatments, [
    "reopening_of_prior_issue",
    "new_issue_on_same_asset",
  ]);
});

test("V014: non-recurrence situations are not treated as recurrence", () => {
  const stillOpen = classifyRecurrence({
    assetId: "a",
    priorIssueStatus: "work_planned",
    newObservedAt: at("2026-09-07T00:00:00Z"),
    sameCategory: true,
    sameDefect: true,
  });
  assert.equal(stillOpen.isRecurrenceCandidate, false);

  const differentSubsystem = classifyRecurrence({
    assetId: "a",
    priorIssueStatus: "resolution_confirmed",
    priorConfirmedAt: at("2026-06-15T00:00:00Z"),
    newObservedAt: at("2026-09-07T00:00:00Z"),
    sameCategory: false,
    sameDefect: false,
  });
  assert.equal(differentSubsystem.isRecurrenceCandidate, false);

  const beforeConfirmation = classifyRecurrence({
    assetId: "a",
    priorIssueStatus: "resolution_confirmed",
    priorConfirmedAt: at("2026-09-10T00:00:00Z"),
    newObservedAt: at("2026-09-07T00:00:00Z"),
    sameCategory: true,
    sameDefect: true,
  });
  assert.equal(beforeConfirmation.isRecurrenceCandidate, false);
});

// ---------------------------------------------------------------------------
// Correction semantics
// ---------------------------------------------------------------------------

test("V014: a correction closes the active row and supersedes it", () => {
  const rows = [
    { id: "link-1", effective_from: at("2026-09-01T00:00:00Z") },
    {
      id: "link-0",
      effective_from: at("2026-08-01T00:00:00Z"),
      effective_to: at("2026-09-01T00:00:00Z"),
    },
  ];

  const plan = planCorrection(
    rows,
    at("2026-09-09T00:00:00Z"),
    "attached to the wrong issue",
    ACTOR,
  );
  assert.equal(plan.close.id, "link-1");
  assert.equal(plan.successor.supersedes_id, "link-1");
  assert.equal(plan.successor.effective_from, plan.close.effective_to);
  assert.equal(plan.superseded.id, "link-1", "the superseded row's own facts are untouched");
});

test("V014: corrections refuse impossible inputs", () => {
  const active = [{ id: "link-1", effective_from: at("2026-09-01T00:00:00Z") }];

  assert.throws(() => planCorrection([], at("2026-09-09T00:00:00Z"), "r", ACTOR), CorrectionError);
  assert.throws(
    () => planCorrection(active, at("2026-08-01T00:00:00Z"), "backdated", ACTOR),
    /cannot take effect before/,
  );
  assert.throws(() => planCorrection(active, at("2026-09-09T00:00:00Z"), "   ", ACTOR), /reason/);

  // Two active rows means the uniqueness invariant is already broken.
  assert.throws(
    () =>
      planCorrection(
        [
          { id: "a", effective_from: at("2026-09-01T00:00:00Z") },
          { id: "b", effective_from: at("2026-09-02T00:00:00Z") },
        ],
        at("2026-09-09T00:00:00Z"),
        "r",
        ACTOR,
      ),
    /invariant violated/,
  );
});

// ---------------------------------------------------------------------------
// A reviewer resolving a dispute the policy lets them resolve (V035)
// ---------------------------------------------------------------------------

test("V035: a reviewer may resolve a dispute where the policy permits it", () => {
  // The defect this closes: `evaluateConfirmation` has always supported
  // `reviewerMayOverride`, and the demo pack sets it for routine categories —
  // but the lifecycle had no `resolution_disputed -> resolution_confirmed`
  // edge, so the domain said yes and the state machine said no. A dispute was
  // therefore terminal in practice, whatever the pack said.
  const allowed = canTransitionIssue("resolution_disputed", "resolution_confirmed", {
    ...issueContext({
      confirmation: {
        confirmationId: "conf-1",
        decision: "confirmed",
        actor: "reviewer",
        reviewerMayOverride: true,
      },
    }),
    actor: "reviewer",
  });

  assert.equal(allowed.ok, true);
});

test("V035: a reviewer may not resolve a dispute where the policy forbids it", () => {
  // A safety category is exactly where a reviewer overruling the people who
  // live there would be least defensible, so the pack withholds it.
  const denied = canTransitionIssue("resolution_disputed", "resolution_confirmed", {
    ...issueContext({
      confirmation: {
        confirmationId: "conf-1",
        decision: "confirmed",
        actor: "reviewer",
        reviewerMayOverride: false,
      },
    }),
    actor: "reviewer",
  });

  assert.equal(denied.ok, false);
  if (!denied.ok) assert.match(denied.reason, /policy|may not override/i);
});

test("V035: a participant cannot overturn their own dispute", () => {
  // Only a reviewer may resolve a dispute. A participant flipping their own
  // answer would make the dispute meaningless — and would let the person who
  // disputed be pressured into withdrawing it.
  const denied = canTransitionIssue("resolution_disputed", "resolution_confirmed", {
    ...issueContext({
      confirmation: {
        confirmationId: "conf-1",
        decision: "confirmed",
        actor: "participant",
        participantHasCountedParticipation: true,
        reviewerMayOverride: true,
      },
    }),
    actor: "citizen",
  });

  assert.equal(denied.ok, false);
  if (!denied.ok) assert.match(denied.reason, /reviewer/i);
});

test("V035: a dispute can still be returned to the crew as work", () => {
  // Adding the override edge must not remove the ordinary path: returning the
  // work is what happens when the dispute is accepted, and it stays available.
  const allowed = canTransitionIssue("resolution_disputed", "work_planned", issueContext());

  assert.equal(allowed.ok, true);
});

test("V035: an absent override flag is not permission", () => {
  // Default-deny. A caller that simply forgot to pass the policy's flag must
  // not thereby grant the override — the field is absent far more often than
  // it is deliberately false, so `!== true` and `=== false` are very different
  // rules here.
  const denied = canTransitionIssue("resolution_disputed", "resolution_confirmed", {
    ...issueContext({
      confirmation: {
        confirmationId: "conf-1",
        decision: "confirmed",
        actor: "reviewer",
      },
    }),
    actor: "reviewer",
  });

  assert.equal(denied.ok, false);
  if (!denied.ok) assert.match(denied.reason, /policy/i);
});
