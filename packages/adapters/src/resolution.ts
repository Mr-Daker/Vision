/**
 * Resolution claims, confirmation, dispute and reopening (roadmap V035).
 *
 * The rule this exists to enforce: **a repair claim is not a verified
 * resolution.** A claim moves the issue to `resolution_claimed` and no
 * further. Whether it becomes confirmed is decided by the category's
 * confirmation policy, applied to confirmations from people entitled to speak
 * for the issue, and enforced by `canTransitionIssue` — which refuses a
 * confirmed status with no persisted confirmation record whatever a caller
 * sends.
 *
 * Two rules from the contracts shape this, and both are stronger than anything
 * this file could add:
 *
 * **One answer per actor, not one per claim.** Migration 0016 replaced 0008's
 * `claim_id UNIQUE` with a uniqueness per participant, plus a partial index
 * allowing at most one reviewer decision. A category requiring two
 * confirmations is therefore satisfiable — by two different people, never by
 * one answering twice.
 *
 * **A reviewer may overrule a dispute only where the policy says so.** The
 * V003 lifecycle now carries a `resolution_disputed -> resolution_confirmed`
 * edge, guarded so that only a reviewer may use it and only where the loaded
 * category policy sets `reviewerMayOverride`. An absent flag is not
 * permission. Where the policy withholds it, the only way out is
 * `resolveDispute`, which returns the work and leaves the dispute on record.
 *
 * **Completion evidence is stored, never invented.** `claimResolution` takes
 * object references that a caller has already finalised through the object
 * store and refuses any it cannot confirm are there. An earlier version
 * generated `originals/resolution/<uuid>` strings inline, so the table
 * recorded photographs that did not exist and a reader had no way to tell.
 *
 * Reopening genuinely reverses the closure: `countsAsClosed` becomes false, so
 * a metric cannot keep counting a reopened issue as resolved.
 */

import { randomUUID } from "node:crypto";

import {
  authorize,
  canTransitionIssue,
  evaluateConfirmation,
  DEFAULT_CONFIRMATION_RULE,
  type ConfirmationPolicyPack,
  type ConfirmationResult,
  type IssueStatus,
  type Principal,
} from "@vision/domain";

import { appendIssueEvent } from "./issue-lifecycle.ts";
import type { Queryable } from "./outbox.ts";

export class ResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResolutionError";
  }
}

const issueRow = async (
  tx: Queryable,
  issueId: string,
): Promise<{
  readonly status: IssueStatus;
  readonly category: string;
  readonly jurisdictionId: string | undefined;
}> => {
  const { rows } = await tx.query(
    `select i.current_status, i.category, i.jurisdiction_id,
            exists (select 1 from issue_alias a
                     where a.source_issue_id = i.issue_id and a.valid_to is null) as retired
       from canonical_issue i where i.issue_id = $1`,
    [issueId],
  );
  const row = rows[0];
  if (row === undefined) throw new ResolutionError(`issue ${issueId} does not exist`);
  if (row["retired"] === true) {
    throw new ResolutionError("this issue was merged away; act on the surviving issue instead");
  }
  return {
    status: String(row["current_status"]) as IssueStatus,
    category: String(row["category"]),
    jurisdictionId: row["jurisdiction_id"] === null ? undefined : String(row["jurisdiction_id"]),
  };
};

/** Moves the issue, refusing anything the V003 lifecycle does not permit. */
const transition = async (
  tx: Queryable,
  issueId: string,
  from: IssueStatus,
  to: IssueStatus,
  context: Parameters<typeof canTransitionIssue>[2],
): Promise<void> => {
  const check = canTransitionIssue(from, to, context);
  if (!check.ok) {
    throw new ResolutionError(`refusing ${from} -> ${to}: ${check.reason}`);
  }
  const moved = await tx.query(
    `update canonical_issue set current_status = $2, current_version = current_version + 1
      where issue_id = $1 and current_status = $3
      returning issue_id`,
    [issueId, to, from],
  );
  if (moved.rows.length === 0) {
    throw new ResolutionError(
      `issue state changed while this action was being recorded; expected '${from}', so the caller must refresh and retry`,
    );
  }
};

/**
 * One piece of completion evidence, already committed to the object store.
 *
 * Every field here describes something that exists. `objectReference` names a
 * finalised object, `fingerprintHash` is the digest of the bytes that were
 * actually stored, and `derivativeReference` is present only when a redaction
 * decision resolved — which the database also enforces with
 * `resolution_evidence_derivative_needs_approval_ck`.
 */
export type CompletionEvidence = {
  readonly mediaType: "photo" | "document";
  /** A finalised object in the store. Never constructed inside this module. */
  readonly objectReference: string;
  /** The digest of the stored bytes, from the media pipeline that read them. */
  readonly fingerprintHash: string;
  readonly redactionStatus: "pending" | "approved" | "not_required" | "needs_review";
  /** Present only for a resolved redaction decision, so it may be published. */
  readonly derivativeReference?: string | undefined;
  readonly captureMetadata?: Readonly<Record<string, unknown>> | undefined;
};

export type ClaimInput = {
  readonly principal: Principal;
  readonly issueId: string;
  readonly idempotencyKey: string;
  readonly description: string;
  readonly completionEvidence: readonly CompletionEvidence[];
  /**
   * Confirms the bytes behind an object reference are really in the store.
   *
   * Injected rather than imported so this module stays free of filesystem
   * access and a test can drive both answers. When it is absent the check is
   * skipped, which is the case for callers that have just written the object
   * themselves inside the same request.
   */
  readonly hasStoredObject?: (objectReference: string) => Promise<boolean>;
};

export type ClaimResult =
  | { readonly status: "claimed"; readonly claimId: string }
  | { readonly status: "already_claimed"; readonly claimId: string };

const evidenceReplayKey = (item: {
  readonly mediaType: string;
  readonly objectReference: string;
  readonly fingerprintHash: string;
  readonly redactionStatus: string;
  readonly derivativeReference?: string | undefined;
}): string =>
  [
    item.mediaType,
    item.objectReference,
    item.fingerprintHash,
    item.redactionStatus,
    item.derivativeReference ?? "",
  ].join("\u0000");

export const claimResolution = async (tx: Queryable, input: ClaimInput): Promise<ClaimResult> => {
  // Also enforced by `canTransitionIssue`, which requires claim.evidenceCount
  // >= 1 — that is the layer a test can distinguish; this one exists for the
  // message and to avoid writing rows that would then roll back.
  if (input.completionEvidence.length === 0) {
    // A claim with nothing to look at gives a citizen nothing to confirm, so
    // it is refused rather than recorded as an unevidenced assertion.
    throw new ResolutionError(
      "a resolution claim requires at least one piece of completion evidence",
    );
  }
  if (input.description.trim().length === 0) {
    throw new ResolutionError("a resolution claim requires a description of the work");
  }
  // A citizen is being asked whether a described repair matches what they can
  // see. "Fixed" tells them nothing to check against, so the description has
  // to say what was actually done.
  if (input.description.trim().length < 12) {
    throw new ResolutionError(
      "a resolution claim requires a specific description of the completed work, not a single word",
    );
  }
  if (!input.completionEvidence.some((item) => item.mediaType === "photo")) {
    throw new ResolutionError(
      "a resolution claim requires at least one completion photograph; a document alone gives a citizen nothing to look at",
    );
  }

  for (const item of input.completionEvidence) {
    if (item.objectReference.trim().length === 0 || item.fingerprintHash.trim().length === 0) {
      // The alternative — inventing a reference here — is what the previous
      // version did, and it produced rows naming photographs nobody had
      // uploaded, indistinguishable from rows naming ones they had.
      throw new ResolutionError(
        "completion evidence must name a stored object and the fingerprint of its bytes",
      );
    }
    if (item.derivativeReference !== undefined && item.redactionStatus === "pending") {
      throw new ResolutionError(
        "a derivative may not be published while its redaction decision is unresolved",
      );
    }
    if (
      input.hasStoredObject !== undefined &&
      !(await input.hasStoredObject(item.objectReference))
    ) {
      throw new ResolutionError(
        `completion evidence names object '${item.objectReference}', which is not in the store`,
      );
    }
  }

  const issue = await issueRow(tx, input.issueId);
  if (issue.jurisdictionId === undefined) {
    throw new ResolutionError("a resolution claim is jurisdiction-scoped and this issue has none");
  }
  const permission = authorize(input.principal, "resolution.claim", {
    jurisdictionId: issue.jurisdictionId,
  });
  if (!permission.allowed) {
    throw new ResolutionError(
      `role '${input.principal.role}' may not claim a resolution: ${permission.reason}`,
    );
  }
  const staffId = input.principal.staffId;
  if (staffId === undefined) {
    throw new ResolutionError("a resolution claim must be attributable to a staff identity");
  }

  const existing = await tx.query(
    `select claim_id, issue_id, description
       from resolution_claim where staff_id = $1 and idempotency_key = $2`,
    [staffId, input.idempotencyKey],
  );
  const prior = existing.rows[0];
  if (prior !== undefined) {
    const priorClaimId = String(prior["claim_id"]);
    const priorEvidence = await tx.query(
      `select media_type, object_reference, fingerprint_hash, redaction_status,
              derivative_reference
         from resolution_evidence_item
        where claim_id = $1 and privacy_state = 'active'`,
      [priorClaimId],
    );
    const expectedEvidence = input.completionEvidence.map(evidenceReplayKey).sort();
    const recordedEvidence = priorEvidence.rows
      .map((row) =>
        evidenceReplayKey({
          mediaType: String(row["media_type"]),
          objectReference: String(row["object_reference"] ?? ""),
          fingerprintHash: String(row["fingerprint_hash"] ?? ""),
          redactionStatus: String(row["redaction_status"]),
          ...(row["derivative_reference"] === null
            ? {}
            : { derivativeReference: String(row["derivative_reference"]) }),
        }),
      )
      .sort();
    if (
      String(prior["issue_id"]) !== input.issueId ||
      String(prior["description"]).trim() !== input.description.trim() ||
      JSON.stringify(recordedEvidence) !== JSON.stringify(expectedEvidence)
    ) {
      throw new ResolutionError(
        "this idempotency key was already used for a different resolution claim request",
      );
    }
    return { status: "already_claimed", claimId: priorClaimId };
  }

  const claimId = randomUUID();
  await tx.query("begin");
  try {
    await tx.query(
      `insert into resolution_claim
         (claim_id, issue_id, staff_id, idempotency_key, claimed_at, description)
       values ($1,$2,$3,$4, now(), $5)`,
      [claimId, input.issueId, staffId, input.idempotencyKey, input.description.trim()],
    );

    for (const item of input.completionEvidence) {
      await tx.query(
        `insert into resolution_evidence_item
           (resolution_evidence_id, claim_id, media_type, object_reference,
            fingerprint_hash, capture_metadata, redaction_status, derivative_reference)
         values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
        [
          randomUUID(),
          claimId,
          item.mediaType,
          item.objectReference,
          item.fingerprintHash,
          item.captureMetadata === undefined ? null : JSON.stringify(item.captureMetadata),
          item.redactionStatus,
          item.derivativeReference ?? null,
        ],
      );
    }

    await transition(tx, input.issueId, issue.status, "resolution_claimed", {
      actor: "staff",
      hasActiveOutgoingAlias: false,
      claim: { claimId, evidenceCount: input.completionEvidence.length },
    });

    await appendIssueEvent(tx, {
      issueId: input.issueId,
      eventType: "resolution_claimed",
      actorType: "staff",
      actorId: staffId,
      payload: {
        claim_id: claimId,
        evidence_count: input.completionEvidence.length,
        // Said explicitly in the event itself, because an event stream is read
        // by things that will not have read this file.
        is_verified_resolution: false,
      },
    });
    await tx.query("commit");
  } catch (error) {
    await tx.query("rollback").catch(() => undefined);
    throw error;
  }

  return { status: "claimed", claimId };
};

export type RespondInput = {
  readonly claimId: string;
  readonly decision: "confirmed" | "disputed";
  readonly policy: ConfirmationPolicyPack;
  readonly participantId?: string;
  readonly reviewerPrincipal?: Principal;
  readonly comment?: string;
  /**
   * Extra writes to commit with this response, inside its transaction.
   *
   * Exists because a reviewer's answer has to be recorded in V032's audit
   * table as well, and the two must be atomic. Writing the audit row after
   * this function returned left a confirmed resolution with nothing saying
   * who decided it or why the first time the audit insert failed — a state
   * change with no audit row, which is precisely what V032 exists to prevent.
   *
   * A callback rather than a parameter so this module stays ignorant of the
   * review tables; `review-queue.ts` supplies the write it needs.
   */
  readonly alsoRecord?: (tx: Queryable) => Promise<void>;
};

export const respondToClaim = async (
  tx: Queryable,
  input: RespondInput,
): Promise<{ readonly recorded: true; readonly resultingStatus: IssueStatus }> => {
  const claim = await tx.query("select issue_id from resolution_claim where claim_id = $1", [
    input.claimId,
  ]);
  if (claim.rows[0] === undefined) {
    throw new ResolutionError(`claim ${input.claimId} does not exist`);
  }
  const issueId = String(claim.rows[0]["issue_id"]);
  const issue = await issueRow(tx, issueId);

  // One answer per *actor*, not one per claim (migration 0016). The earlier
  // rule refused every second response, so a category whose policy requires
  // two confirmations could never be closed — and the second person to
  // confirm was told nothing had happened.
  if (input.participantId !== undefined) {
    const answered = await tx.query(
      "select 1 from resolution_confirmation where claim_id = $1 and responding_participant_id = $2",
      [input.claimId, input.participantId],
    );
    if (answered.rows[0] !== undefined) {
      throw new ResolutionError(
        "this person has already answered this claim once; a second answer would let one person satisfy a two-confirmation category alone",
      );
    }
  } else {
    const reviewed = await tx.query(
      "select 1 from resolution_confirmation where claim_id = $1 and reviewer_id is not null",
      [input.claimId],
    );
    if (reviewed.rows[0] !== undefined) {
      throw new ResolutionError(
        "this claim already carries a reviewer decision; a second would leave two on record with nothing saying which stands",
      );
    }
  }

  let hasCountedParticipation = false;
  if (input.participantId !== undefined) {
    const counted = await tx.query(
      `select 1 from issue_participation
        where canonical_issue_id = $1 and participant_id = $2 and counted = true`,
      [issueId, input.participantId],
    );
    hasCountedParticipation = counted.rows[0] !== undefined;
    if (!hasCountedParticipation) {
      throw new ResolutionError(
        "only a participant whose participation is counted on this issue may respond to its claim",
      );
    }
  } else if (input.reviewerPrincipal === undefined) {
    throw new ResolutionError("a response must come from a participant or a reviewer");
  }

  // A reviewer asking to overturn a dispute the policy protects is refused
  // here, with the policy named. Letting it through produced "cannot move
  // resolution_disputed -> resolution_disputed", which tells the reviewer
  // nothing about why, and would have left a row reading "reviewer confirmed"
  // on a claim that stays disputed.
  if (
    input.reviewerPrincipal !== undefined &&
    input.decision === "confirmed" &&
    issue.status === "resolution_disputed"
  ) {
    const rule = input.policy.rules[issue.category] ?? DEFAULT_CONFIRMATION_RULE;
    if (rule.reviewerMayOverride !== true) {
      throw new ResolutionError(
        `this category's confirmation policy does not let a reviewer override a dispute, so the dispute stands`,
      );
    }
  }

  const evidenceCount = await tx.query(
    "select count(*)::int as n from resolution_evidence_item where claim_id = $1 and privacy_state = 'active'",
    [input.claimId],
  );

  const confirmationId = randomUUID();
  await tx.query("begin");
  try {
    await tx.query(
      `insert into resolution_confirmation
         (confirmation_id, claim_id, responding_participant_id, reviewer_id,
          decision, decided_at, comment)
       values ($1,$2,$3,$4,$5, now(), $6)`,
      [
        confirmationId,
        input.claimId,
        input.participantId ?? null,
        input.participantId === undefined ? (input.reviewerPrincipal?.staffId ?? null) : null,
        input.decision,
        input.comment ?? null,
      ],
    );

    // Every answer on this claim, not just the one being made.
    //
    // This previously passed a single-element array holding the current
    // response, which made `requiredConfirmations: 2` unsatisfiable no matter
    // what the pack said — the evaluation was never shown more than one
    // confirmation, so it could not count to two. The row inserted above is
    // included, because it is part of the answer being assessed.
    const recorded = await tx.query(
      `select c.responding_participant_id, c.reviewer_id, c.decision,
              exists (
                select 1 from issue_participation p
                 where p.canonical_issue_id = $2
                   and p.participant_id = c.responding_participant_id
                   and p.counted = true
              ) as counted
         from resolution_confirmation c
        where c.claim_id = $1
        order by c.decided_at asc`,
      [input.claimId, issueId],
    );

    const assessment = evaluateConfirmation({
      category: issue.category,
      policy: input.policy,
      claimEvidenceCount: Number(evidenceCount.rows[0]?.["n"] ?? 0),
      confirmations: recorded.rows.map((row) => ({
        actor: row["responding_participant_id"] === null ? "reviewer" : "participant",
        decision: String(row["decision"]) === "confirmed" ? "confirmed" : "disputed",
        ...(row["responding_participant_id"] === null
          ? {}
          : { hasCountedParticipation: row["counted"] === true }),
      })),
    });

    let resultingStatus: IssueStatus = issue.status;
    if (assessment.status === "confirmed" || assessment.status === "disputed") {
      const to: IssueStatus =
        assessment.status === "confirmed" ? "resolution_confirmed" : "resolution_disputed";
      await transition(tx, issueId, issue.status, to, {
        actor: input.participantId === undefined ? "reviewer" : "citizen",
        hasActiveOutgoingAlias: false,
        confirmation: {
          confirmationId,
          decision: assessment.status === "confirmed" ? "confirmed" : "disputed",
          actor: input.participantId === undefined ? "reviewer" : "participant",
          // From the applied rule, not from this file: whether a reviewer may
          // overrule the people who live somewhere is a configured decision
          // (V035), and the lifecycle default-denies when it is absent.
          //
          // Redundant with the guard above, which refuses a forbidden override
          // before anything is written and gives a far better message — so no
          // test can distinguish this value from a hard-coded `true`. It is
          // sent anyway because the lifecycle is the layer that must not be
          // bypassable, and `canTransitionIssue` is pinned directly for both
          // the permitted and the forbidden case in `domain-policy.test.ts`.
          reviewerMayOverride: assessment.appliedRule.reviewerMayOverride,
          ...(input.participantId === undefined
            ? {}
            : { participantHasCountedParticipation: true }),
        },
      });
      resultingStatus = to;
      await appendIssueEvent(tx, {
        issueId,
        eventType: to,
        actorType: input.participantId === undefined ? "reviewer" : "citizen",
        ...(input.participantId === undefined
          ? { actorId: input.reviewerPrincipal?.staffId }
          : { actorId: input.participantId }),
        payload: {
          claim_id: input.claimId,
          confirmation_id: confirmationId,
          policy_version: assessment.policyVersion,
          reason: assessment.reason,
        },
      });
    }
    if (input.alsoRecord !== undefined) await input.alsoRecord(tx);
    await tx.query("commit");
    return { recorded: true, resultingStatus };
  } catch (error) {
    await tx.query("rollback").catch(() => undefined);
    throw error;
  }
};

/**
 * A reviewer returns disputed work to the crew.
 *
 * Not an override: the lifecycle has no edge from `resolution_disputed` to
 * `resolution_confirmed`, so a reviewer cannot convert a citizen's dispute
 * into a confirmation. The dispute stays on the record and the work goes back.
 */
export const resolveDispute = async (
  tx: Queryable,
  input: { readonly principal: Principal; readonly issueId: string; readonly reason: string },
): Promise<{ readonly returnedToWork: true; readonly decisionId: string }> => {
  if (input.reason.trim().length === 0) {
    throw new ResolutionError("returning disputed work requires a recorded reason");
  }
  const issue = await issueRow(tx, input.issueId);
  if (issue.jurisdictionId === undefined) {
    throw new ResolutionError("this decision is jurisdiction-scoped and the issue has none");
  }
  const permission = authorize(input.principal, "issue.transition", {
    jurisdictionId: issue.jurisdictionId,
  });
  if (!permission.allowed) {
    throw new ResolutionError(
      `role '${input.principal.role}' may not transition this issue: ${permission.reason}`,
    );
  }

  const decisionId = randomUUID();
  await tx.query("begin");
  try {
    await transition(tx, input.issueId, issue.status, "work_planned", {
      actor: "reviewer",
      hasActiveOutgoingAlias: false,
      hasActiveAssignment: true,
    });
    const eventId = await appendIssueEvent(tx, {
      issueId: input.issueId,
      eventType: "disputed_work_returned",
      actorType: "reviewer",
      actorId: input.principal.staffId,
      payload: { reason: input.reason },
    });

    // Also in V032's audit table, with the issue as its target. That table is
    // the one place built for "which reviewer decided what, and why", and a
    // returned dispute was invisible there.
    await tx.query(
      `insert into review_decision
         (decision_id, canonical_issue_id, action, reason, reviewer_id,
          prior_state, resulting_state, decision_event_id)
       values ($1,$2,'return_disputed_work',$3,$4,$5::jsonb,$6::jsonb,$7)`,
      [
        decisionId,
        input.issueId,
        input.reason,
        input.principal.staffId ?? null,
        JSON.stringify({ issue_status: issue.status }),
        JSON.stringify({ issue_status: "work_planned" }),
        eventId,
      ],
    );
    await tx.query("commit");
  } catch (error) {
    await tx.query("rollback").catch(() => undefined);
    throw error;
  }
  return { returnedToWork: true, decisionId };
};

export const reopenIssue = async (
  tx: Queryable,
  input: {
    readonly issueId: string;
    readonly actorType: "citizen" | "staff" | "reviewer" | "supervisor";
    readonly actorId: string;
    readonly reason: string;
  },
): Promise<{ readonly reopened: true; readonly reopeningId: string }> => {
  // Also enforced by `canTransitionIssue`, which denies a reopening whose
  // reason is blank; this is for the message.
  if (input.reason.trim().length === 0) {
    throw new ResolutionError("reopening an issue requires a recorded reason");
  }
  const issue = await issueRow(tx, input.issueId);
  if (issue.status !== "resolution_confirmed") {
    throw new ResolutionError(
      `only a confirmed resolution can be reopened; this issue is '${issue.status}'`,
    );
  }

  // A citizen may reopen only an issue they are counted on. Without this, the
  // reopening endpoint would let any signed-in account reverse a closure on
  // any issue — a stranger undoing a decision the people living there made.
  // Staff and reviewer actors are scoped by their own authorization before
  // they reach this function.
  if (input.actorType === "citizen") {
    const counted = await tx.query(
      `select 1 from issue_participation
        where canonical_issue_id = $1 and participant_id = $2 and counted = true`,
      [input.issueId, input.actorId],
    );
    if (counted.rows[0] === undefined) {
      throw new ResolutionError(
        "only a participant whose participation is counted on this issue may reopen it",
      );
    }
  }

  const confirmation = await tx.query(
    `select c.confirmation_id
       from resolution_confirmation c
       join resolution_claim k on k.claim_id = c.claim_id
      where k.issue_id = $1 and c.decision = 'confirmed'
      order by c.decided_at desc limit 1`,
    [input.issueId],
  );
  if (confirmation.rows[0] === undefined) {
    throw new ResolutionError("there is no confirmed resolution to reopen");
  }

  const reopeningId = randomUUID();
  await tx.query("begin");
  try {
    await tx.query(
      `insert into reopening
         (reopening_id, issue_id, prior_confirmation_id, reopened_at, reason,
          actor_type, actor_id)
       values ($1,$2,$3, now(), $4,$5,$6)`,
      [
        reopeningId,
        input.issueId,
        String(confirmation.rows[0]["confirmation_id"]),
        input.reason,
        input.actorType,
        input.actorId,
      ],
    );
    await transition(tx, input.issueId, issue.status, "reopened", {
      actor: input.actorType === "citizen" ? "citizen" : "reviewer",
      hasActiveOutgoingAlias: false,
      reopening: { reopeningId, reason: input.reason },
    });
    await appendIssueEvent(tx, {
      issueId: input.issueId,
      eventType: "issue_reopened",
      actorType: input.actorType,
      actorId: input.actorId,
      payload: { reopening_id: reopeningId, reason: input.reason, counts_as_closed: false },
    });
    await tx.query("commit");
  } catch (error) {
    await tx.query("rollback").catch(() => undefined);
    throw error;
  }
  return { reopened: true, reopeningId };
};

export type ResolutionState = ConfirmationResult & {
  readonly issueStatus: IssueStatus;
  readonly claimEvidenceCount: number;
  /**
   * False for anything other than a standing confirmed resolution — including
   * a reopened issue, so a closure metric cannot keep counting it.
   */
  readonly countsAsClosed: boolean;
};

export const readResolutionState = async (
  tx: Queryable,
  options: { readonly issueId: string; readonly policy: ConfirmationPolicyPack },
): Promise<ResolutionState | undefined> => {
  const { rows } = await tx.query(
    "select current_status, category from canonical_issue where issue_id = $1",
    [options.issueId],
  );
  const row = rows[0];
  if (row === undefined) return undefined;
  const status = String(row["current_status"]) as IssueStatus;

  // The latest claim, then *all* of its confirmations.
  //
  // This was one query joining confirmations and taking `limit 1`, which could
  // only ever see a single answer — so a category requiring two could never be
  // reported as resolved, and with several rows the join picked an arbitrary
  // one. It also hard-coded `hasCountedParticipation: true`, which would have
  // treated an uncounted participant's answer as counting.
  const claim = await tx.query(
    `select k.claim_id,
            (select count(*)::int from resolution_evidence_item e
              where e.claim_id = k.claim_id and e.privacy_state = 'active') as evidence
       from resolution_claim k
      where k.issue_id = $1
      order by k.claimed_at desc limit 1`,
    [options.issueId],
  );
  const latest = claim.rows[0];
  const evidenceCount = latest === undefined ? 0 : Number(latest["evidence"] ?? 0);

  const confirmations =
    latest === undefined
      ? { rows: [] as Record<string, unknown>[] }
      : await tx.query(
          `select c.responding_participant_id, c.decision,
                  exists (
                    select 1 from issue_participation p
                     where p.canonical_issue_id = $2
                       and p.participant_id = c.responding_participant_id
                       and p.counted = true
                  ) as counted
             from resolution_confirmation c
            where c.claim_id = $1
            order by c.decided_at asc`,
          [String(latest["claim_id"]), options.issueId],
        );

  const assessment = evaluateConfirmation({
    category: String(row["category"]),
    policy: options.policy,
    claimEvidenceCount: evidenceCount,
    confirmations: confirmations.rows.map((confirmation) => ({
      actor: confirmation["responding_participant_id"] === null ? "reviewer" : "participant",
      decision: String(confirmation["decision"]) as "confirmed" | "disputed",
      ...(confirmation["responding_participant_id"] === null
        ? {}
        : { hasCountedParticipation: confirmation["counted"] === true }),
    })),
  });

  // A reopened issue is not closed, whatever the confirmation said. Reporting
  // otherwise would let a metric count a live problem as resolved.
  const reopened = status === "reopened";
  return {
    ...assessment,
    ...(reopened
      ? {
          isVerifiedResolution: false,
          reason: `this issue was reopened after being confirmed, so it is not a standing resolution: ${assessment.reason}`,
        }
      : {}),
    issueStatus: status,
    claimEvidenceCount: evidenceCount,
    countsAsClosed: status === "resolution_confirmed",
  };
};

// ---------------------------------------------------------------------------
// The citizen-facing view of a resolution (roadmap V035 §B)
//
// Everything a signed-in participant is shown about a repair claim, and
// nothing else. Three rules govern what leaves this function:
//
//   * **No private original ever appears.** Only `derivative_reference` is
//     selected for completion evidence; `object_reference` is not read at all,
//     so there is no field that could carry one by accident.
//   * **The responder is the session, never the request.** This takes a
//     `participantId` the caller resolved from a validated session and reports
//     what *that* person may do. Nothing here accepts an identity as data.
//   * **A claim is never described as a resolution.** The status vocabulary is
//     the lifecycle's own, and the disclosures travel with every state.
// ---------------------------------------------------------------------------

/** Why a signed-in participant cannot answer, when they cannot. */
export type ResponseBlockReason =
  | "not_a_counted_participant"
  | "already_answered"
  | "no_claim_awaiting_an_answer"
  | "policy_excludes_citizens";

export type ResolutionEvidenceView = {
  readonly mediaType: string;
  /** Present only for a published, redaction-approved derivative. */
  readonly derivativeReference: string | undefined;
  readonly viewable: boolean;
  /** Why there is nothing to show, in words a reader can act on. */
  readonly whyNotViewable: string | undefined;
};

export type ResolutionHistoryEntry = {
  readonly at: string;
  readonly kind: "resolution_claimed" | "confirmed" | "disputed" | "reopened";
  readonly what: string;
  /** A dispute or reopening reason, kept verbatim. */
  readonly comment: string | undefined;
  readonly byReviewer: boolean;
};

export type CitizenResolutionView = {
  readonly issueStatus: IssueStatus;
  readonly claim:
    | {
        readonly claimId: string;
        readonly claimedAt: string;
        readonly description: string;
        readonly evidence: readonly ResolutionEvidenceView[];
      }
    | undefined;
  readonly policyVersion: string;
  readonly requiredConfirmations: number;
  readonly confirmationsRecorded: number;
  readonly disputesRecorded: number;
  readonly status: ConfirmationResult["status"];
  readonly isVerifiedResolution: boolean;
  readonly countsAsClosed: boolean;
  /**
   * True when the confirmation came from a reviewer overruling a dispute.
   *
   * Carried separately because "confirmed" reads very differently depending on
   * who did it: saying "people who reported this agreed" over the top of their
   * dispute would be the plainest overstatement this whole deliverable exists
   * to prevent.
   */
  readonly resolvedByReviewer: boolean;
  readonly requiresQualifiedInspection: boolean;
  readonly disclosures: readonly string[];
  readonly mayRespond: boolean;
  readonly mayRespondBlockedBy: ResponseBlockReason | undefined;
  readonly mayReopen: boolean;
  readonly history: readonly ResolutionHistoryEntry[];
};

export const readCitizenResolutionView = async (
  tx: Queryable,
  options: {
    readonly issueId: string;
    readonly policy: ConfirmationPolicyPack;
    /** Resolved from the session by the caller. Never taken from a request body. */
    readonly participantId: string | undefined;
  },
): Promise<CitizenResolutionView | undefined> => {
  const state = await readResolutionState(tx, {
    issueId: options.issueId,
    policy: options.policy,
  });
  if (state === undefined) return undefined;

  const claimRow = await tx.query(
    `select claim_id, claimed_at, description
       from resolution_claim where issue_id = $1
      order by claimed_at desc limit 1`,
    [options.issueId],
  );
  const latest = claimRow.rows[0];

  // `object_reference` is deliberately absent from this select list. A field
  // that is never read cannot be serialised by a later edit to the payload.
  const evidence =
    latest === undefined
      ? { rows: [] as Record<string, unknown>[] }
      : await tx.query(
          `select media_type, derivative_reference, redaction_status
             from resolution_evidence_item
            where claim_id = $1 and privacy_state = 'active'
            order by resolution_evidence_id`,
          [String(latest["claim_id"])],
        );

  const evidenceView: readonly ResolutionEvidenceView[] = evidence.rows.map((row) => {
    const derivative =
      row["derivative_reference"] === null ? undefined : String(row["derivative_reference"]);
    return {
      mediaType: String(row["media_type"]),
      derivativeReference: derivative,
      viewable: derivative !== undefined,
      whyNotViewable:
        derivative !== undefined
          ? undefined
          : `this photograph has no approved derivative yet (redaction status: ${String(row["redaction_status"])}), so there is nothing that may be shown; the description above is what the claim says was done`,
    };
  });

  const answers =
    latest === undefined
      ? { rows: [] as Record<string, unknown>[] }
      : await tx.query(
          `select c.responding_participant_id, c.reviewer_id, c.decision, c.decided_at, c.comment
             from resolution_confirmation c
            where c.claim_id = $1
            order by c.decided_at asc`,
          [String(latest["claim_id"])],
        );

  const confirmationsRecorded = answers.rows.filter(
    (row) => String(row["decision"]) === "confirmed",
  ).length;
  const disputesRecorded = answers.rows.length - confirmationsRecorded;

  // May this person answer? Each refusal names its own cause, because
  // "you cannot respond" with no reason is indistinguishable from a fault.
  let mayRespondBlockedBy: ResponseBlockReason | undefined;
  if (latest === undefined || state.issueStatus !== "resolution_claimed") {
    mayRespondBlockedBy = "no_claim_awaiting_an_answer";
  } else if (state.appliedRule.citizenMayConfirm !== true) {
    mayRespondBlockedBy = "policy_excludes_citizens";
  } else if (options.participantId === undefined) {
    mayRespondBlockedBy = "not_a_counted_participant";
  } else {
    const counted = await tx.query(
      `select 1 from issue_participation
        where canonical_issue_id = $1 and participant_id = $2 and counted = true`,
      [options.issueId, options.participantId],
    );
    if (counted.rows[0] === undefined) {
      mayRespondBlockedBy = "not_a_counted_participant";
    } else if (
      answers.rows.some(
        (row) => String(row["responding_participant_id"] ?? "") === options.participantId,
      )
    ) {
      mayRespondBlockedBy = "already_answered";
    }
  }

  // Reopening needs a standing confirmed resolution and counted participation.
  let mayReopen = false;
  if (state.issueStatus === "resolution_confirmed" && options.participantId !== undefined) {
    const counted = await tx.query(
      `select 1 from issue_participation
        where canonical_issue_id = $1 and participant_id = $2 and counted = true`,
      [options.issueId, options.participantId],
    );
    mayReopen = counted.rows[0] !== undefined;
  }

  const reopenings = await tx.query(
    `select reopened_at, reason from reopening where issue_id = $1 order by reopened_at asc`,
    [options.issueId],
  );

  const history: readonly ResolutionHistoryEntry[] = [
    ...(latest === undefined
      ? []
      : [
          {
            at: new Date(String(latest["claimed_at"])).toISOString(),
            kind: "resolution_claimed" as const,
            what: "Department staff recorded a repair claim awaiting confirmation",
            comment: String(latest["description"]),
            byReviewer: false,
          },
        ]),
    ...answers.rows.map((row) => {
      const byReviewer = row["responding_participant_id"] === null;
      const confirmed = String(row["decision"]) === "confirmed";
      return {
        at: new Date(String(row["decided_at"])).toISOString(),
        kind: (confirmed ? "confirmed" : "disputed") as "confirmed" | "disputed",
        what: confirmed
          ? byReviewer
            ? "A reviewer resolved the dispute in favour of the claim, as this category's policy permits"
            : "A participant agreed the visible problem appears fixed"
          : byReviewer
            ? "A reviewer recorded a dispute against the claim"
            : "A participant said the problem is not fixed",
        comment: row["comment"] === null ? undefined : String(row["comment"]),
        byReviewer,
      };
    }),
    ...reopenings.rows.map((row) => ({
      at: new Date(String(row["reopened_at"])).toISOString(),
      kind: "reopened" as const,
      what: "The confirmed resolution was reopened, so this issue is open again",
      comment: String(row["reason"]),
      byReviewer: false,
    })),
  ].sort((a, b) => a.at.localeCompare(b.at));

  return {
    issueStatus: state.issueStatus,
    claim:
      latest === undefined
        ? undefined
        : {
            claimId: String(latest["claim_id"]),
            claimedAt: new Date(String(latest["claimed_at"])).toISOString(),
            description: String(latest["description"]),
            evidence: evidenceView,
          },
    policyVersion: state.policyVersion,
    requiredConfirmations: state.appliedRule.requiredConfirmations,
    confirmationsRecorded,
    disputesRecorded,
    status: state.status,
    isVerifiedResolution: state.isVerifiedResolution,
    countsAsClosed: state.countsAsClosed,
    resolvedByReviewer: state.resolvedByReviewer,
    requiresQualifiedInspection: state.requiresQualifiedInspection,
    disclosures: state.disclosures,
    mayRespond: mayRespondBlockedBy === undefined,
    mayRespondBlockedBy,
    history,
    ...(mayReopen ? { mayReopen: true } : { mayReopen: false }),
  };
};
