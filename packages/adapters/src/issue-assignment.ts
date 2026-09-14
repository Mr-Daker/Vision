/**
 * Canonical issue assignment under concurrency (roadmap V028).
 *
 * The failure this exists to prevent is write skew: two citizens report the
 * same problem at the same moment, both candidate searches legitimately find
 * nothing, and two canonical issues are created for one problem. Neither
 * transaction did anything wrong in isolation, which is exactly why no amount
 * of care inside a single transaction fixes it.
 *
 * **Strategy: SERIALIZABLE with a bounded retry, plus a recheck inside the
 * transaction.** The alternative was an explicit advisory lock on a coarse
 * spatial bucket. That was rejected because correctness would then depend on
 * bucket geometry — two reports thirty metres apart can straddle a boundary,
 * take different locks, and reintroduce the bug. Under SERIALIZABLE the read
 * predicate of each transaction covers the other's insert, so PostgreSQL
 * detects the conflict and aborts one; the retry then sees the issue that was
 * created and reports the decision as stale.
 *
 * **Inference stays outside.** The proposal is computed before the transaction
 * and passed in. A transaction held open across a provider call is how a
 * connection pool is exhausted by a slow third party (V006 §5).
 *
 * **Staleness is judged only on candidates that could change the decision.**
 * A candidate in a different category cannot: V027 gates on category before
 * anything else, so a different defect appearing nearby never alters the
 * proposal and must not force a rerun.
 */

import { randomUUID } from "node:crypto";

import { resolveActiveRoot, type AliasEdge, type MatchProposal } from "@vision/domain";

import type { Queryable } from "./outbox.ts";
import { unionParticipationOnMerge } from "./participation-counts.ts";

/** A serialization failure is retried this many times before giving up. */
export const MAX_ASSIGNMENT_ATTEMPTS = 5;

/** PostgreSQL serialization failure and deadlock codes. */
const RETRYABLE_SQLSTATES = new Set(["40001", "40P01"]);

export type AssignmentInput = {
  readonly submissionId: string;
  readonly participantId: string;
  readonly lon: number;
  readonly lat: number;
  readonly accuracyMetres: number | undefined;
  readonly category: string;
  /** Versioned location resolution, when one was unambiguous. */
  readonly jurisdictionId?: string | undefined;
  readonly onlyUnscopedJurisdiction?: boolean;
  readonly assetId?: string | undefined;
  readonly observedAt: string;
  /** Computed outside the transaction; this function never infers anything. */
  readonly proposal: MatchProposal;
  /** Candidate issue ids the proposal was based on. */
  readonly candidateIdsSeen: readonly string[];
  readonly radiusMetres?: number;
  readonly timeWindowHours?: number;
  /** Optimistic guard: fail if the target issue has moved past this version. */
  readonly expectedIssueVersion?: number;
};

export type AssignmentResult =
  | {
      readonly status: "created";
      readonly issueId: string;
      readonly publicReference: string;
      readonly attemptNumber: number;
    }
  | {
      readonly status: "attached";
      readonly issueId: string;
      readonly attemptNumber: number;
      /** True when the proposal named an issue that a merge had retired. */
      readonly resolvedThroughAlias: boolean;
    }
  | { readonly status: "needs_review"; readonly matchId: string; readonly reason: string }
  | {
      readonly status: "stale";
      readonly reason: string;
      readonly candidateIdsNow: readonly string[];
    };

/**
 * What the savepoint variant can return that the self-managing one cannot.
 *
 * `caller_must_retry` exists because of a property of PostgreSQL checked
 * against the database rather than assumed. Rolling back to the savepoint does
 * leave the transaction usable — it can still commit, without the rolled-back
 * work. What it cannot do is succeed at the *same* work: the serialization
 * conflict is recorded against the transaction, so a retry inside it conflicts
 * again. An internal retry loop would therefore burn its attempts and fail
 * anyway, which is why only the caller — who owns the transaction — can retry.
 */
export type ComposedAssignmentResult =
  | AssignmentResult
  | { readonly status: "caller_must_retry"; readonly reason: string; readonly sqlState: string };

export class AssignmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssignmentError";
  }
}

const sqlState = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null ? (error as { code?: string }).code : undefined;

/** Candidates that could still change the decision, re-read inside the transaction. */
const recheckCandidates = async (
  tx: Queryable,
  input: AssignmentInput,
): Promise<readonly string[]> => {
  const { rows } = await tx.query(
    `select issue_id
       from canonical_issue
      where category = $5
        and ($7::uuid is null or jurisdiction_id is null or jurisdiction_id = $7::uuid)
        and (not $8::boolean or jurisdiction_id is null)
        and opened_at >= now() - ($4::numeric * interval '1 hour')
        and (
          (representative_location is not null
           and ST_DWithin(representative_location,
                          ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $3))
          or (asset_id is not null and asset_id = $6)
        )`,
    [
      input.lon,
      input.lat,
      input.radiusMetres ?? 400,
      input.timeWindowHours ?? 24 * 90,
      input.category,
      input.assetId ?? null,
      input.jurisdictionId ?? null,
      input.onlyUnscopedJurisdiction ?? false,
    ],
  );
  return rows.map((row) => String(row["issue_id"]));
};

const nextAttemptNumber = async (tx: Queryable, submissionId: string): Promise<number> => {
  const { rows } = await tx.query(
    "select coalesce(max(attempt_number), 0) + 1 as next from issue_match where submission_id = $1",
    [submissionId],
  );
  return Number(rows[0]?.["next"] ?? 1);
};

const decisionBasis = (proposal: MatchProposal, extra: Record<string, unknown> = {}) => ({
  matcher_version: proposal.matcherVersion,
  taxonomy_version: proposal.taxonomyVersion,
  thresholds: proposal.thresholds,
  reasons: proposal.reasons,
  ...extra,
});

/** Active alias edges, so a proposal naming a retired issue lands on the survivor. */
const aliasEdges = async (tx: Queryable): Promise<readonly AliasEdge[]> => {
  const { rows } = await tx.query(
    `select source_issue_id, target_issue_id from issue_alias where valid_to is null`,
  );
  return rows.map((row) => ({
    source_issue_id: String(row["source_issue_id"]),
    target_issue_id: String(row["target_issue_id"]),
  }));
};

const runAssignment = async (tx: Queryable, input: AssignmentInput): Promise<AssignmentResult> => {
  const attemptNumber = await nextAttemptNumber(tx, input.submissionId);
  const now = new Date().toISOString();

  // Ambiguity is recorded and stops here. No issue, no link, no merge: a merge
  // is the one step that is expensive to undo, so it never happens without a
  // person (V027's `mayMerge: false`).
  if (input.proposal.decision === "ambiguous") {
    const matchId = randomUUID();
    await tx.query(
      `insert into issue_match
         (match_id, submission_id, attempt_number, state, candidate_issue_ids, decision_basis)
       values ($1,$2,$3,'ambiguous',$4::uuid[],$5::jsonb)`,
      [
        matchId,
        input.submissionId,
        attemptNumber,
        input.proposal.candidates.map((candidate) => candidate.issueId),
        JSON.stringify(decisionBasis(input.proposal, { may_merge: false })),
      ],
    );
    return {
      status: "needs_review",
      matchId,
      reason: input.proposal.reasons.join("; "),
    };
  }

  const candidateIdsNow = await recheckCandidates(tx, input);
  const seen = new Set(input.candidateIdsSeen);
  const appeared = candidateIdsNow.filter((issueId) => !seen.has(issueId));

  if (appeared.length > 0) {
    // The world changed under the proposal. Recording the attempt as
    // retryable rather than committing a decision made on old data is the
    // whole point: a rerun with the new candidates may reach a different and
    // correct answer.
    await tx.query(
      `insert into issue_match
         (match_id, submission_id, attempt_number, state, candidate_issue_ids, decision_basis)
       values ($1,$2,$3,'failed_retryable',$4::uuid[],$5::jsonb)`,
      [
        randomUUID(),
        input.submissionId,
        attemptNumber,
        candidateIdsNow,
        JSON.stringify(
          decisionBasis(input.proposal, {
            stale_reason: "candidates changed between the proposal and the recheck",
            candidates_seen: input.candidateIdsSeen,
            candidates_now: candidateIdsNow,
          }),
        ),
      ],
    );
    return {
      status: "stale",
      reason:
        "the candidate set changed between the proposal and the transactional recheck; the decision must be rerun",
      candidateIdsNow,
    };
  }

  const matchId = randomUUID();

  if (input.proposal.decision === "new_issue") {
    const issueId = randomUUID();
    const publicReference = `VIS-${issueId.slice(0, 8).toUpperCase()}`;
    await tx.query(
      `insert into canonical_issue
         (issue_id, public_reference, category, opened_at,
          representative_location, representative_accuracy_m, last_evidence_at, asset_id,
          jurisdiction_id)
       values ($1,$2,$3,$4,
               ST_SetSRID(ST_MakePoint($5,$6),4326)::geography,$7,$4,$8,$9)`,
      [
        issueId,
        publicReference,
        input.category,
        input.observedAt,
        input.lon,
        input.lat,
        input.accuracyMetres ?? null,
        input.assetId ?? null,
        input.jurisdictionId ?? null,
      ],
    );
    await tx.query(
      `insert into issue_match
         (match_id, submission_id, attempt_number, state, candidate_issue_ids,
          resulting_issue_id, decision_basis, decided_by_actor_type, decided_at)
       values ($1,$2,$3,'no_match',$4::uuid[],$5,$6::jsonb,'system',$7)`,
      [
        matchId,
        input.submissionId,
        attemptNumber,
        candidateIdsNow,
        issueId,
        JSON.stringify(decisionBasis(input.proposal)),
        now,
      ],
    );
    await linkEvidence(tx, input, issueId, matchId, now);
    return { status: "created", issueId, publicReference, attemptNumber };
  }

  // Alias resolution at commit: the proposal may name an issue a merge has
  // since retired, and attaching to a tombstone would hide the evidence.
  const edges = await aliasEdges(tx);
  const resolution = resolveActiveRoot(input.proposal.issueId, edges);
  if (!resolution.ok) {
    // A cycle or an over-deep alias chain is a data fault, not a routine
    // outcome: attaching to an arbitrary point in a broken chain would hide
    // the evidence somewhere nobody is looking.
    throw new AssignmentError(
      `alias resolution failed for issue ${input.proposal.issueId}: ${resolution.reason} (${resolution.path.join(" -> ")})`,
    );
  }
  const targetIssueId = resolution.rootIssueId;
  const resolvedThroughAlias = targetIssueId !== input.proposal.issueId;

  const existing = await tx.query(
    "select current_version from canonical_issue where issue_id = $1",
    [targetIssueId],
  );
  if (existing.rows[0] === undefined) {
    throw new AssignmentError(`issue ${targetIssueId} does not exist`);
  }
  if (
    input.expectedIssueVersion !== undefined &&
    Number(existing.rows[0]["current_version"]) !== input.expectedIssueVersion
  ) {
    return {
      status: "stale",
      reason: "the target issue changed version between the proposal and the recheck",
      candidateIdsNow,
    };
  }

  await tx.query(
    `insert into issue_match
       (match_id, submission_id, attempt_number, state, candidate_issue_ids,
        resulting_issue_id, decision_basis, decided_by_actor_type, decided_at)
     values ($1,$2,$3,'match_confirmed',$4::uuid[],$5,$6::jsonb,'system',$7)`,
    [
      matchId,
      input.submissionId,
      attemptNumber,
      candidateIdsNow,
      targetIssueId,
      JSON.stringify(
        decisionBasis(input.proposal, {
          resolved_through_alias: resolvedThroughAlias,
          proposed_issue_id: input.proposal.issueId,
        }),
      ),
      now,
    ],
  );

  await tx.query(
    `update canonical_issue
        set last_evidence_at = greatest(coalesce(last_evidence_at, $2::timestamptz), $2::timestamptz),
            current_version = current_version + 1
      where issue_id = $1`,
    [targetIssueId, input.observedAt],
  );

  await linkEvidence(tx, input, targetIssueId, matchId, now);
  return { status: "attached", issueId: targetIssueId, attemptNumber, resolvedThroughAlias };
};

/** Links every active evidence item of the submission to the issue. */
const linkEvidence = async (
  tx: Queryable,
  input: AssignmentInput,
  issueId: string,
  matchId: string,
  now: string,
): Promise<void> => {
  const { rows } = await tx.query(
    "select evidence_id from evidence_item where submission_id = $1 and privacy_state = 'active'",
    [input.submissionId],
  );
  for (const row of rows) {
    await tx.query(
      `insert into issue_evidence_link
         (issue_evidence_link_id, evidence_id, canonical_issue_id, match_id,
          decision_basis, effective_from)
       values ($1,$2,$3,$4,$5::jsonb,$6)`,
      [
        randomUUID(),
        String(row["evidence_id"]),
        issueId,
        matchId,
        JSON.stringify({ matcher_version: input.proposal.matcherVersion }),
        now,
      ],
    );
  }
};

/**
 * Commits the proposal, retrying a serialization failure.
 *
 * The transaction is deliberately short: a recheck, a few inserts, a commit.
 * Everything expensive already happened.
 */
export const assignSubmissionToIssue = async (
  tx: Queryable,
  input: AssignmentInput,
): Promise<AssignmentResult> => {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ASSIGNMENT_ATTEMPTS; attempt += 1) {
    try {
      await tx.query("begin isolation level serializable");
      const result = await runAssignment(tx, input);
      await tx.query("commit");
      return result;
    } catch (error) {
      await tx.query("rollback").catch(() => undefined);
      lastError = error;
      if (!RETRYABLE_SQLSTATES.has(sqlState(error) ?? "")) throw error;
      // A serialization failure means someone else committed first. The retry
      // re-reads, so the next pass sees their work and reports staleness
      // rather than duplicating it.
    }
  }
  throw new AssignmentError(
    `assignment could not commit after ${String(MAX_ASSIGNMENT_ATTEMPTS)} serializable attempts: ${String(
      sqlState(lastError) ?? "unknown",
    )}`,
  );
};

/**
 * The same assignment, composed inside a transaction the caller owns.
 *
 * V028 recorded that `assignSubmissionToIssue` "manages its own transaction,
 * so it cannot be composed inside a caller's transaction; a caller needing
 * that would need a savepoint variant". This is it.
 *
 * Two preconditions are checked rather than assumed, because getting either
 * wrong produces a silent problem rather than an error:
 *
 *  * **Already in a transaction.** In autocommit every statement commits on
 *    its own, so a caller would believe they had atomicity and not have it.
 *  * **SERIALIZABLE.** The recheck this performs is only sound at that level.
 *    At READ COMMITTED two callers can both recheck, both see no conflict, and
 *    both open an issue for the same problem — the duplicate protection would
 *    look present while doing nothing.
 *
 * It does not retry. See `ComposedAssignmentResult` for why it cannot.
 */
export const assignSubmissionToIssueInTransaction = async (
  tx: Queryable,
  input: AssignmentInput,
): Promise<ComposedAssignmentResult> => {
  const isolation = await tx.query("show transaction_isolation");
  const level = String(isolation.rows[0]?.["transaction_isolation"] ?? "");

  // A savepoint outside a transaction block raises 25P01, so this doubles as
  // the "am I in a transaction" check — but it is asked explicitly, because
  // "read committed" is also what autocommit reports and the two failures need
  // different messages.
  const savepoint = `assign_${randomUUID().replace(/-/g, "")}`;
  try {
    await tx.query(`savepoint ${savepoint}`);
  } catch (error) {
    if (sqlState(error) === "25P01") {
      throw new AssignmentError(
        "assignSubmissionToIssueInTransaction must already be in a transaction; use assignSubmissionToIssue when there is no caller transaction to join",
      );
    }
    throw error;
  }

  if (level !== "serializable") {
    await tx.query(`release savepoint ${savepoint}`).catch(() => undefined);
    throw new AssignmentError(
      `the caller's transaction is '${level}', and this assignment's recheck is only sound at serializable; begin the transaction with 'isolation level serializable'`,
    );
  }

  try {
    const result = await runAssignment(tx, input);
    await tx.query(`release savepoint ${savepoint}`);
    return result;
  } catch (error) {
    // Back to the savepoint so the caller's transaction is usable enough to
    // roll back cleanly, or to record why it is abandoning the work.
    await tx.query(`rollback to savepoint ${savepoint}`).catch(() => undefined);
    const state = sqlState(error);
    if (state !== undefined && RETRYABLE_SQLSTATES.has(state)) {
      return {
        status: "caller_must_retry",
        reason: `another transaction committed first (${state}); this transaction can no longer succeed at the same work, so the caller must retry its own transaction from the beginning`,
        sqlState: state,
      };
    }
    throw error;
  }
};

export type MergeCommand = {
  readonly survivingIssueId: string;
  readonly mergedIssueId: string;
  readonly reason: string;
  readonly decidedByActorType: "reviewer" | "supervisor" | "administrator";
  readonly decidedByActorId: string;
  readonly correlationId?: string;
};

export type MergeRecord = {
  readonly mergeId: string;
  readonly aliasId: string;
  readonly decisionEventId: string;
  /** Participations moved onto the survivor, and those already there. */
  readonly participation: {
    readonly movedParticipations: number;
    readonly alreadyPresent: number;
  };
};

/**
 * Merges two issues, reversibly.
 *
 * A merge is a reviewer command, never a matcher output. It records an event,
 * a merge row and an alias edge, so the retired issue's public reference stays
 * resolvable — a citizen holding that reference must not hit a dead end
 * (V003 CanonicalIssue).
 */
export const mergeIssues = async (tx: Queryable, command: MergeCommand): Promise<MergeRecord> => {
  if (command.reason.trim().length === 0) {
    throw new AssignmentError("a merge requires a recorded reason");
  }
  if (command.survivingIssueId === command.mergedIssueId) {
    throw new AssignmentError("an issue cannot be merged into itself; they must be distinct");
  }

  const eventId = randomUUID();
  const mergeId = randomUUID();
  const aliasId = randomUUID();
  const at = new Date().toISOString();
  let participation = { movedParticipations: 0, alreadyPresent: 0 };

  // One transaction for all three writes. Without it a later failure leaves a
  // committed event asserting a merge that no merge row records — the log and
  // the state would disagree, and the log is what a reviewer trusts.
  await tx.query("begin");
  try {
    const version = await tx.query(
      "select coalesce(max(aggregate_version), 0) + 1 as next from status_event where aggregate_type = 'canonical_issue' and aggregate_id = $1",
      [command.survivingIssueId],
    );

    await tx.query(
      `insert into status_event
       (event_id, aggregate_type, aggregate_id, aggregate_version, event_type,
        actor_type, actor_pseudonym, correlation_id, occurred_at, payload_schema_version, payload)
     values ($1,'canonical_issue',$2,$3,'issue_merged',$4,$5,$6,$7,'1.0.0',$8::jsonb)`,
      [
        eventId,
        command.survivingIssueId,
        Number(version.rows[0]?.["next"] ?? 1),
        command.decidedByActorType,
        command.decidedByActorId,
        command.correlationId ?? randomUUID(),
        at,
        JSON.stringify({ merged_issue_id: command.mergedIssueId, reason: command.reason }),
      ],
    );

    await tx.query(
      `insert into issue_merge
       (merge_id, surviving_issue_id, merged_issue_id, merged_at, reason, decision_event_id)
     values ($1,$2,$3,$4,$5,$6)`,
      [mergeId, command.survivingIssueId, command.mergedIssueId, at, command.reason, eventId],
    );

    await tx.query(
      `insert into issue_alias
       (alias_id, source_issue_id, target_issue_id, merge_id, valid_from)
     values ($1,$2,$3,$4,$5)`,
      [aliasId, command.mergedIssueId, command.survivingIssueId, mergeId, at],
    );

    // Unioning participation is part of merging, not a follow-up call. V029
    // recorded it as separate, which meant a merge without the second call
    // stranded contributions on an issue nobody can reach and left the
    // survivor undercounting the people who reported it.
    participation = await unionParticipationOnMerge(tx, {
      survivingIssueId: command.survivingIssueId,
      mergedIssueId: command.mergedIssueId,
    });

    await tx.query("commit");
  } catch (error) {
    await tx.query("rollback").catch(() => undefined);
    throw error;
  }

  return { mergeId, aliasId, decisionEventId: eventId, participation };
};

export type ReversalCommand = {
  readonly mergeId: string;
  readonly reason: string;
  readonly correlationId?: string;
};

/**
 * Reverses a merge — the "separation" command.
 *
 * The merge row is **kept** and marked reversed, and the alias edge is closed
 * rather than deleted. A reversed merge is history: a reader asking why an
 * issue was briefly unreachable deserves an answer.
 */
export const reverseMerge = async (
  tx: Queryable,
  command: ReversalCommand,
): Promise<{ readonly reversalEventId: string }> => {
  if (command.reason.trim().length === 0) {
    throw new AssignmentError("reversing a merge requires a recorded reason");
  }

  const { rows } = await tx.query(
    "select surviving_issue_id, merged_issue_id, reversed_at from issue_merge where merge_id = $1",
    [command.mergeId],
  );
  const merge = rows[0];
  if (merge === undefined) throw new AssignmentError(`merge ${command.mergeId} does not exist`);
  if (merge["reversed_at"] !== null) {
    throw new AssignmentError(`merge ${command.mergeId} has already been reversed`);
  }

  const eventId = randomUUID();
  const at = new Date().toISOString();

  await tx.query("begin");
  try {
    const version = await tx.query(
      "select coalesce(max(aggregate_version), 0) + 1 as next from status_event where aggregate_type = 'canonical_issue' and aggregate_id = $1",
      [String(merge["surviving_issue_id"])],
    );

    await tx.query(
      `insert into status_event
       (event_id, aggregate_type, aggregate_id, aggregate_version, event_type,
        actor_type, correlation_id, occurred_at, payload_schema_version, payload)
     values ($1,'canonical_issue',$2,$3,'issue_merge_reversed','reviewer',$4,$5,'1.0.0',$6::jsonb)`,
      [
        eventId,
        String(merge["surviving_issue_id"]),
        Number(version.rows[0]?.["next"] ?? 1),
        command.correlationId ?? randomUUID(),
        at,
        JSON.stringify({ merge_id: command.mergeId, reason: command.reason }),
      ],
    );

    await tx.query(
      `update issue_merge
        set reversed_at = $2, reversal_reason = $3, reversal_event_id = $4
      where merge_id = $1`,
      [command.mergeId, at, command.reason, eventId],
    );

    await tx.query(
      `update issue_alias set valid_to = $2, closed_by_event_id = $3
      where merge_id = $1 and valid_to is null`,
      [command.mergeId, at, eventId],
    );

    await tx.query("commit");
  } catch (error) {
    await tx.query("rollback").catch(() => undefined);
    throw error;
  }

  return { reversalEventId: eventId };
};
