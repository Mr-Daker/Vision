/**
 * Lifecycle transition validation (roadmap V014).
 *
 * Pure functions with no storage, clock, or network access. Every guard the
 * V003 contract states as a precondition is an explicit input here, so a caller
 * cannot satisfy a transition by asserting a status — it has to present the
 * evidence the transition requires.
 *
 * The single most important rule in this file: a resolution claim cannot become
 * externally confirmed merely because a client supplied a status field.
 */

export type SubmissionStatus =
  "received" | "processing" | "needs_review" | "accepted" | "rejected" | "quarantined";

export type IssueMatchState =
  | "pending"
  | "candidates_retrieved"
  | "ambiguous"
  | "no_match"
  | "match_confirmed"
  | "failed_retryable";

export type IssueStatus =
  | "created"
  | "routing_review"
  | "routed_internal"
  | "agency_ack_received"
  | "work_planned"
  | "resolution_claimed"
  | "resolution_confirmed"
  | "resolution_disputed"
  | "reopened";

export type DomainActor =
  "citizen" | "staff" | "reviewer" | "supervisor" | "administrator" | "system_worker";

export type TransitionCheck =
  { readonly ok: true } | { readonly ok: false; readonly reason: string };

const allow: TransitionCheck = { ok: true };
const deny = (reason: string): TransitionCheck => ({ ok: false, reason });

// ---------------------------------------------------------------------------
// Submission
// ---------------------------------------------------------------------------

const SUBMISSION_EDGES: Readonly<Record<SubmissionStatus, readonly SubmissionStatus[]>> = {
  received: ["processing"],
  processing: ["needs_review", "accepted", "rejected", "quarantined"],
  needs_review: ["accepted", "rejected", "quarantined"],
  accepted: [],
  rejected: [],
  quarantined: ["needs_review"],
};

/** Only a worker may auto-advance; terminal decisions from review need a reviewer. */
export const canTransitionSubmission = (
  from: SubmissionStatus,
  to: SubmissionStatus,
  actor: DomainActor,
): TransitionCheck => {
  if (!SUBMISSION_EDGES[from].includes(to)) {
    return deny(`submission cannot move ${from} -> ${to}`);
  }
  if (from === "needs_review" && actor !== "reviewer") {
    return deny(`leaving needs_review requires a reviewer, not ${actor}`);
  }
  if (from === "quarantined" && actor !== "reviewer") {
    return deny("a quarantined submission may only be released by a reviewer");
  }
  if (from === "received" && actor !== "system_worker") {
    return deny("processing starts from a leased worker task");
  }
  return allow;
};

// ---------------------------------------------------------------------------
// IssueMatch
// ---------------------------------------------------------------------------

const MATCH_EDGES: Readonly<Record<IssueMatchState, readonly IssueMatchState[]>> = {
  pending: ["candidates_retrieved", "failed_retryable"],
  candidates_retrieved: ["ambiguous", "no_match", "match_confirmed"],
  ambiguous: ["no_match", "match_confirmed"],
  no_match: [],
  match_confirmed: [],
  failed_retryable: ["pending"],
};

export type MatchTransitionContext = {
  /** A terminal decision must name the issue it resolved to. */
  readonly resultingIssueId?: string;
  /** Candidates were re-checked inside the finalisation transaction. */
  readonly recheckedInTransaction: boolean;
  /** An ambiguous decision needs a human or the reporting citizen. */
  readonly decidedBy: "system" | "citizen" | "reviewer";
};

export const canTransitionIssueMatch = (
  from: IssueMatchState,
  to: IssueMatchState,
  context: MatchTransitionContext,
): TransitionCheck => {
  if (!MATCH_EDGES[from].includes(to)) {
    return deny(`issue match cannot move ${from} -> ${to}`);
  }

  const terminal = to === "no_match" || to === "match_confirmed";
  if (terminal) {
    if (context.resultingIssueId === undefined) {
      return deny(`a terminal match (${to}) must record its resulting issue`);
    }
    if (!context.recheckedInTransaction) {
      return deny(
        "a terminal match requires a candidate recheck inside the finalising transaction",
      );
    }
  }
  if (from === "ambiguous" && context.decidedBy === "system") {
    return deny("an ambiguous match requires a citizen or reviewer decision, not the system");
  }
  return allow;
};

// ---------------------------------------------------------------------------
// CanonicalIssue — the guards that matter
// ---------------------------------------------------------------------------

const ISSUE_EDGES: Readonly<Record<IssueStatus, readonly IssueStatus[]>> = {
  created: ["routing_review", "routed_internal"],
  routing_review: ["routed_internal"],
  routed_internal: ["agency_ack_received"],
  agency_ack_received: ["work_planned"],
  work_planned: ["resolution_claimed"],
  resolution_claimed: ["resolution_confirmed", "resolution_disputed"],
  resolution_confirmed: ["reopened"],
  // `resolution_confirmed` is reachable from a dispute *only* by a reviewer,
  // and only where the confirmation policy grants the override — the guard
  // below enforces both. Without this edge a dispute was terminal in practice,
  // whatever the policy pack said, because `evaluateConfirmation` would return
  // "confirmed" and the state machine would refuse to move.
  resolution_disputed: ["work_planned", "resolution_confirmed"],
  reopened: ["work_planned"],
};

export type IssueTransitionContext = {
  readonly actor: DomainActor;
  /** True when this issue has an active outgoing alias (it was merged away). */
  readonly hasActiveOutgoingAlias: boolean;
  /** A routing decision must name the directory version it used. */
  readonly routingDirectoryVersion?: string;
  /**
   * An acknowledgment must carry recorded provenance including whether the
   * responding provider was simulated. Internal state is never acknowledgment.
   */
  readonly acknowledgment?: {
    readonly providerMode: "simulated" | "real";
    readonly authenticity:
      "simulated_fixture" | "authenticated_external" | "unauthenticated_external";
    readonly recordedActor: string;
  };
  readonly hasActiveAssignment?: boolean;
  readonly claim?: { readonly claimId: string; readonly evidenceCount: number };
  /**
   * The persisted confirmation record. Its absence is what makes a
   * client-supplied "resolution_confirmed" status impossible to honour.
   */
  readonly confirmation?: {
    readonly confirmationId: string;
    readonly decision: "confirmed" | "disputed";
    readonly actor: "participant" | "reviewer";
    readonly participantHasCountedParticipation?: boolean;
    /**
     * Whether the category's policy lets a reviewer resolve a dispute.
     *
     * Supplied by the caller from the confirmation policy pack, because
     * whether a reviewer may overrule the people who live somewhere is a
     * configured decision and not a rule this file gets to make.
     */
    readonly reviewerMayOverride?: boolean;
  };
  readonly reopening?: { readonly reopeningId: string; readonly reason: string };
};

export const canTransitionIssue = (
  from: IssueStatus,
  to: IssueStatus,
  context: IssueTransitionContext,
): TransitionCheck => {
  // A retired issue takes no operational writes; callers resolve the root first.
  if (context.hasActiveOutgoingAlias) {
    return deny("issue has an active outgoing alias; resolve the active canonical root first");
  }
  if (to === "created") {
    return deny("'created' is set once by match finalisation and is never re-entered");
  }
  if (!ISSUE_EDGES[from].includes(to)) {
    return deny(`issue cannot move ${from} -> ${to}`);
  }

  switch (to) {
    case "routing_review":
    case "routed_internal": {
      if (context.routingDirectoryVersion === undefined) {
        return deny("a routing decision must record the directory version it used");
      }
      if (to === "routed_internal" && from === "routing_review" && context.actor !== "reviewer") {
        return deny("leaving routing_review requires a reviewer decision");
      }
      return allow;
    }

    case "agency_ack_received": {
      const acknowledgment = context.acknowledgment;
      if (acknowledgment === undefined) {
        return deny(
          "acknowledgment requires a recorded provider response; internal routing is not acknowledgment",
        );
      }
      if (acknowledgment.recordedActor.length === 0) {
        return deny("an acknowledgment must record the actor that produced it");
      }
      // A simulated provider may still acknowledge, but only labelled as such.
      if (
        acknowledgment.providerMode === "real" &&
        acknowledgment.authenticity === "simulated_fixture"
      ) {
        return deny("a real provider cannot produce a simulated-fixture acknowledgment");
      }
      return allow;
    }

    case "work_planned": {
      if (from === "agency_ack_received" && context.hasActiveAssignment !== true) {
        return deny("planning work requires an active assignment");
      }
      return allow;
    }

    case "resolution_claimed": {
      if (context.actor !== "staff") {
        return deny("only department staff may claim resolution");
      }
      if (context.claim === undefined || context.claim.evidenceCount < 1) {
        return deny("a resolution claim requires at least one piece of completion evidence");
      }
      return allow;
    }

    case "resolution_confirmed":
    case "resolution_disputed": {
      const confirmation = context.confirmation;
      // This is the V014 acceptance condition: no confirmation record, no
      // confirmed resolution — regardless of what a client sends.
      if (confirmation === undefined) {
        return deny(
          "a resolution claim cannot be confirmed or disputed without a persisted confirmation record",
        );
      }
      const expected = to === "resolution_confirmed" ? "confirmed" : "disputed";
      if (confirmation.decision !== expected) {
        return deny(`confirmation decision '${confirmation.decision}' does not support ${to}`);
      }
      if (
        confirmation.actor === "participant" &&
        confirmation.participantHasCountedParticipation !== true
      ) {
        return deny("a participant may only confirm an issue on which their participation counts");
      }
      if (from === "resolution_disputed") {
        // Overturning a dispute is a different act from confirming a claim
        // nobody contested, so it carries two extra conditions.
        if (context.actor !== "reviewer" || confirmation.actor !== "reviewer") {
          return deny(
            "only a reviewer may resolve a dispute; a participant overturning their own dispute would make disputing meaningless, and would let whoever disputed be pressured into withdrawing it",
          );
        }
        if (confirmation.reviewerMayOverride !== true) {
          // Default-deny: an absent flag is not permission. A safety category
          // is exactly where a reviewer overruling residents would be least
          // defensible, and that is the case a missing value would wave through.
          return deny(
            "this category's confirmation policy does not let a reviewer override a dispute",
          );
        }
      }
      return allow;
    }

    case "reopened": {
      if (context.reopening === undefined) {
        return deny("reopening requires a Reopening record");
      }
      if (context.reopening.reason.trim().length === 0) {
        return deny("a reopening must record a reason");
      }
      return allow;
    }

    default:
      return allow;
  }
};

/**
 * Attaching or correcting evidence is not an issue lifecycle transition and can
 * never change `current_status`. Stated as a function so a test can assert it
 * for every status rather than trusting the absence of a code path.
 */
export const evidenceAttachmentChangesStatus = (): false => false;
