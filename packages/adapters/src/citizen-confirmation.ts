/**
 * Citizen duplicate confirmation and correction (roadmap V031).
 *
 * The citizen is asked a question they can actually answer — "is this the same
 * problem you are reporting?" — shown the candidate's location, an approved
 * preview and enough history to judge it. Rejecting carries **their own
 * words**, never a category picked from a government taxonomy, because
 * requiring someone to understand departmental categories in order to
 * disagree is the same as not letting them disagree.
 *
 * Two rules shape the rest.
 *
 * **The answer can go stale.** Between rendering the question and receiving
 * the answer the candidate may have been merged away or removed. An answer
 * about a world that has moved is worse than asking again, so the candidate is
 * re-resolved at the moment of the decision and a vanished one produces
 * `revalidate` rather than a guess.
 *
 * **A citizen may dispute but not undo.** An attachment carries other people's
 * evidence, so disagreement about one that already happened becomes a
 * *request* a reviewer decides (V032). The attachment stands until then: the
 * alternative would let one person detach a report several others had
 * corroborated.
 */

import { randomUUID } from "node:crypto";

import { resolveActiveRoot, type AliasEdge } from "@vision/domain";

import type { Queryable } from "./outbox.ts";
import { recordParticipation } from "./participation-counts.ts";

/** Decimal places kept in a location shown to a citizen. Matches the V030 public view. */
const COARSE_DECIMALS = 3;
const coarsen = (value: number): number => Number(value.toFixed(COARSE_DECIMALS));

export type CorrectionKind = "not_the_same_problem" | "wrong_location" | "wrong_evidence" | "other";

const aliasEdges = async (tx: Queryable): Promise<readonly AliasEdge[]> => {
  const { rows } = await tx.query(
    "select source_issue_id, target_issue_id from issue_alias where valid_to is null",
  );
  return rows.map((row) => ({
    source_issue_id: String(row["source_issue_id"]),
    target_issue_id: String(row["target_issue_id"]),
  }));
};

/** Resolves a candidate to the issue that is actually current. */
const resolveCandidate = async (
  tx: Queryable,
  candidateIssueId: string,
): Promise<{ readonly issueId: string; readonly resolvedThroughAlias: boolean } | undefined> => {
  const resolution = resolveActiveRoot(candidateIssueId, await aliasEdges(tx));
  if (!resolution.ok) return undefined;
  const { rows } = await tx.query("select 1 from canonical_issue where issue_id = $1", [
    resolution.rootIssueId,
  ]);
  if (rows[0] === undefined) return undefined;
  return {
    issueId: resolution.rootIssueId,
    resolvedThroughAlias: resolution.rootIssueId !== candidateIssueId,
  };
};

export type CandidateView = {
  readonly candidate: {
    readonly publicReference: string;
    readonly category: string;
    readonly openedAt: string;
    readonly lastEvidenceAt: string | undefined;
    readonly coarseLocation: { readonly lon: number; readonly lat: number } | undefined;
    readonly distanceMetres: number | undefined;
    readonly countedParticipants: number;
    /** Attached report entries, which is not the same as people. */
    readonly entryCount: number;
    /** Only approved derivatives. A private original is never previewed. */
    readonly previewDerivatives: readonly string[];
  };
  readonly resolvedThroughAlias: boolean;
};

export const presentCandidate = async (
  tx: Queryable,
  options: { readonly submissionId: string; readonly candidateIssueId: string },
): Promise<CandidateView | undefined> => {
  const resolved = await resolveCandidate(tx, options.candidateIssueId);
  if (resolved === undefined) return undefined;

  const { rows } = await tx.query(
    `select
        i.public_reference, i.category, i.opened_at, i.last_evidence_at,
        ST_X(i.representative_location::geometry) as lon,
        ST_Y(i.representative_location::geometry) as lat,
        ST_Distance(i.representative_location, s.observed_location) as distance_m,
        (select count(*)::int from issue_participation p
          where p.canonical_issue_id = i.issue_id and p.counted = true) as counted,
        (select count(*)::int from issue_evidence_link link
          where link.canonical_issue_id = i.issue_id and link.effective_to is null) as entries,
        (select coalesce(array_agg(e.derivative_reference), '{}')
           from issue_evidence_link link
           join evidence_item e on e.evidence_id = link.evidence_id
          where link.canonical_issue_id = i.issue_id
            and link.effective_to is null
            and e.derivative_reference is not null
            -- Redundant with evidence_item_derivative_needs_approval_ck, which
            -- makes an unapproved item with a derivative unstorable. Kept as
            -- intent; the constraint is what a test can actually pin (V030 §4).
            and e.redaction_status in ('approved','not_required')
            and e.privacy_state = 'active') as derivatives
       from canonical_issue i
       cross join submission s
      where i.issue_id = $1 and s.submission_id = $2`,
    [resolved.issueId, options.submissionId],
  );
  const row = rows[0];
  if (row === undefined) return undefined;

  return {
    candidate: {
      publicReference: String(row["public_reference"]),
      category: String(row["category"]),
      openedAt: new Date(String(row["opened_at"])).toISOString(),
      lastEvidenceAt:
        row["last_evidence_at"] === null
          ? undefined
          : new Date(String(row["last_evidence_at"])).toISOString(),
      coarseLocation:
        row["lon"] === null
          ? undefined
          : { lon: coarsen(Number(row["lon"])), lat: coarsen(Number(row["lat"])) },
      distanceMetres: row["distance_m"] === null ? undefined : Number(row["distance_m"]),
      countedParticipants: Number(row["counted"] ?? 0),
      entryCount: Number(row["entries"] ?? 0),
      previewDerivatives: (row["derivatives"] as string[] | null) ?? [],
    },
    resolvedThroughAlias: resolved.resolvedThroughAlias,
  };
};

/** Confirms the submission belongs to this participant, and is still active. */
const ownsSubmission = async (
  tx: Queryable,
  submissionId: string,
  participantId: string,
): Promise<boolean> => {
  const { rows } = await tx.query(
    `select 1 from submission
      where submission_id = $1 and participant_id = $2 and privacy_state = 'active'`,
    [submissionId, participantId],
  );
  return rows[0] !== undefined;
};

/**
 * Retires the active matching attempt this answer resolves.
 *
 * `issue_match_one_active_per_submission_uniq` permits one row per submission
 * with `superseded_at IS NULL`. A citizen is asked *because* the matcher left
 * an `ambiguous` attempt active, so inserting the answer without retiring that
 * attempt violates the index — which is what a browser found, as a 500 on
 * every real reject. Every unit test passed because none of them created the
 * row that makes the question exist in the first place.
 *
 * Superseded, not deleted: the ambiguous attempt is the record that the system
 * was unsure and that a person resolved it. Returns the id so the answer's own
 * row can name the attempt it replaced through `supersedes_match_id` — this
 * table carries only that backward link, so that is where the connection
 * lives.
 */
const supersedeActiveAttempt = async (
  tx: Queryable,
  submissionId: string,
): Promise<string | undefined> => {
  const { rows } = await tx.query(
    `update issue_match
        set superseded_at = now()
      where submission_id = $1 and superseded_at is null
      returning match_id`,
    [submissionId],
  );
  const previous = rows[0]?.["match_id"];
  return previous === undefined ? undefined : String(previous);
};

const nextAttempt = async (tx: Queryable, submissionId: string): Promise<number> => {
  const { rows } = await tx.query(
    "select coalesce(max(attempt_number), 0) + 1 as next from issue_match where submission_id = $1",
    [submissionId],
  );
  return Number(rows[0]?.["next"] ?? 1);
};

export type ConfirmResult =
  | {
      readonly status: "attached";
      readonly issueId: string;
      readonly resolvedThroughAlias: boolean;
      readonly attachedEvidence: number;
    }
  | { readonly status: "already_attached"; readonly issueId: string }
  | { readonly status: "revalidate"; readonly reason: string }
  | { readonly status: "not_yours" };

export const confirmMatch = async (
  tx: Queryable,
  options: {
    readonly submissionId: string;
    readonly participantId: string;
    readonly candidateIssueId: string;
  },
): Promise<ConfirmResult> => {
  if (!(await ownsSubmission(tx, options.submissionId, options.participantId))) {
    return { status: "not_yours" };
  }

  const resolved = await resolveCandidate(tx, options.candidateIssueId);
  if (resolved === undefined) {
    return {
      status: "revalidate",
      reason:
        "the issue you were shown is no longer available, so the question must be asked again",
    };
  }

  // Already attached? Then this is a repeated tap or a replayed request, and
  // the evidence must not be attached a second time.
  const existing = await tx.query(
    `select count(*)::int as n from issue_evidence_link link
      where link.canonical_issue_id = $1
        and link.effective_to is null
        and link.evidence_id in (select evidence_id from evidence_item where submission_id = $2)`,
    [resolved.issueId, options.submissionId],
  );
  if (Number(existing.rows[0]?.["n"] ?? 0) > 0) {
    return { status: "already_attached", issueId: resolved.issueId };
  }

  const matchId = randomUUID();
  const now = new Date().toISOString();
  const attemptNumber = await nextAttempt(tx, options.submissionId);
  // Before the insert, or the unique index rejects it.
  const supersededMatchId = await supersedeActiveAttempt(tx, options.submissionId);
  await tx.query(
    `insert into issue_match
       (match_id, submission_id, attempt_number, state, candidate_issue_ids,
        resulting_issue_id, decision_basis, decided_by_actor_type, decided_by_actor_id,
        decided_at, supersedes_match_id)
     values ($1,$2,$3,'match_confirmed',$4::uuid[],$5,$6::jsonb,'citizen',$7,$8,$9)`,
    [
      matchId,
      options.submissionId,
      attemptNumber,
      [options.candidateIssueId],
      resolved.issueId,
      JSON.stringify({
        decided_by: "citizen",
        proposed_issue_id: options.candidateIssueId,
        resolved_through_alias: resolved.resolvedThroughAlias,
      }),
      options.participantId,
      now,
      supersededMatchId ?? null,
    ],
  );

  const evidence = await tx.query(
    "select evidence_id from evidence_item where submission_id = $1 and privacy_state = 'active'",
    [options.submissionId],
  );
  for (const row of evidence.rows) {
    await tx.query(
      `insert into issue_evidence_link
         (issue_evidence_link_id, evidence_id, canonical_issue_id, match_id,
          decision_basis, effective_from)
       values ($1,$2,$3,$4,$5::jsonb,$6)`,
      [
        randomUUID(),
        String(row["evidence_id"]),
        resolved.issueId,
        matchId,
        JSON.stringify({ decided_by: "citizen" }),
        now,
      ],
    );
  }

  // Counted once, however many times they confirm (V029's constraint).
  await recordParticipation(tx, {
    participantId: options.participantId,
    issueId: resolved.issueId,
    evidenceAt: now,
    eligibility: { verdict: "eligible", reasons: ["the reporter confirmed this match themselves"] },
  });

  await tx.query(
    `update canonical_issue
        set last_evidence_at = greatest(coalesce(last_evidence_at, $2::timestamptz), $2::timestamptz),
            current_version = current_version + 1
      where issue_id = $1`,
    [resolved.issueId, now],
  );

  return {
    status: "attached",
    issueId: resolved.issueId,
    resolvedThroughAlias: resolved.resolvedThroughAlias,
    attachedEvidence: evidence.rows.length,
  };
};

export type RejectResult =
  | { readonly status: "new_issue"; readonly issueId: string; readonly publicReference: string }
  | { readonly status: "revalidate"; readonly reason: string }
  | { readonly status: "not_yours" };

/**
 * Records that the citizen says this is a different problem, and opens an
 * issue for their report.
 *
 * The new issue's category comes from the submission's own taxonomy record,
 * not from the citizen: they were asked whether two problems are the same,
 * which is a question about the world, not about departmental structure.
 */
export const rejectMatch = async (
  tx: Queryable,
  options: {
    readonly submissionId: string;
    readonly participantId: string;
    readonly candidateIssueId: string;
    readonly citizenNote?: string | undefined;
  },
): Promise<RejectResult> => {
  if (!(await ownsSubmission(tx, options.submissionId, options.participantId))) {
    return { status: "not_yours" };
  }

  const submission = await tx.query(
    `select
        ST_X(observed_location::geometry) as lon,
        ST_Y(observed_location::geometry) as lat,
        observed_accuracy_m, observed_at
       from submission where submission_id = $1`,
    [options.submissionId],
  );
  const row = submission.rows[0];
  if (row === undefined) {
    return { status: "revalidate", reason: "the report could not be found" };
  }

  // The candidate's category stands in for the new issue's, because that is
  // the best available label and the citizen was not asked to supply one.
  const candidate = await tx.query("select category from canonical_issue where issue_id = $1", [
    options.candidateIssueId,
  ]);
  const category =
    candidate.rows[0] === undefined ? "uncategorised" : String(candidate.rows[0]["category"]);

  const issueId = randomUUID();
  const publicReference = `VIS-${issueId.slice(0, 8).toUpperCase()}`;
  const now = new Date().toISOString();

  await tx.query(
    `insert into canonical_issue
       (issue_id, public_reference, category, opened_at,
        representative_location, representative_accuracy_m, last_evidence_at)
     values ($1,$2,$3,$4, ST_SetSRID(ST_MakePoint($5,$6),4326)::geography,$7,$4)`,
    [
      issueId,
      publicReference,
      category,
      new Date(String(row["observed_at"])).toISOString(),
      Number(row["lon"]),
      Number(row["lat"]),
      row["observed_accuracy_m"] === null ? null : Number(row["observed_accuracy_m"]),
    ],
  );

  const matchId = randomUUID();
  const attemptNumber = await nextAttempt(tx, options.submissionId);
  const supersededMatchId = await supersedeActiveAttempt(tx, options.submissionId);
  await tx.query(
    `insert into issue_match
       (match_id, submission_id, attempt_number, state, candidate_issue_ids,
        resulting_issue_id, decision_basis, decided_by_actor_type, decided_by_actor_id,
        decided_at, supersedes_match_id)
     values ($1,$2,$3,'no_match',$4::uuid[],$5,$6::jsonb,'citizen',$7,$8,$9)`,
    [
      matchId,
      options.submissionId,
      attemptNumber,
      [options.candidateIssueId],
      issueId,
      JSON.stringify({
        decided_by: "citizen",
        rejected_candidate_issue_id: options.candidateIssueId,
      }),
      options.participantId,
      now,
      supersededMatchId ?? null,
    ],
  );

  const evidence = await tx.query(
    "select evidence_id from evidence_item where submission_id = $1 and privacy_state = 'active'",
    [options.submissionId],
  );
  for (const item of evidence.rows) {
    await tx.query(
      `insert into issue_evidence_link
         (issue_evidence_link_id, evidence_id, canonical_issue_id, match_id,
          decision_basis, effective_from)
       values ($1,$2,$3,$4,$5::jsonb,$6)`,
      [
        randomUUID(),
        String(item["evidence_id"]),
        issueId,
        matchId,
        JSON.stringify({ decided_by: "citizen" }),
        now,
      ],
    );
  }

  await recordParticipation(tx, {
    participantId: options.participantId,
    issueId,
    evidenceAt: now,
    eligibility: { verdict: "eligible", reasons: ["opened by the reporter's own rejection"] },
  });

  // The disagreement itself goes to a reviewer: the system proposed a match
  // and a person said it was wrong, which is worth someone looking at even
  // though the citizen's answer is honoured immediately.
  await tx
    .query(
      `insert into correction_request
         (request_id, kind, submission_id, canonical_issue_id,
          requested_by_participant_id, citizen_note)
       values ($1,'not_the_same_problem',$2,$3,$4,$5)`,
      [
        randomUUID(),
        options.submissionId,
        options.candidateIssueId,
        options.participantId,
        options.citizenNote ?? null,
      ],
    )
    .catch(() => undefined);

  return { status: "new_issue", issueId, publicReference };
};

export type CorrectionRequestResult =
  | { readonly status: "open"; readonly requestId: string }
  | { readonly status: "already_open" }
  | { readonly status: "not_yours" };

/**
 * Opens a citizen's dispute about an attachment that already happened.
 *
 * Deliberately does not change the attachment. It carries other people's
 * evidence and their counted participation, so separating it is a reviewer's
 * decision (V032) — otherwise one person could detach a report several others
 * had corroborated.
 */
export const openCorrectionRequest = async (
  tx: Queryable,
  options: {
    readonly submissionId: string;
    readonly participantId: string;
    readonly canonicalIssueId: string | undefined;
    readonly kind: CorrectionKind;
    readonly citizenNote?: string | undefined;
  },
): Promise<CorrectionRequestResult> => {
  if (!(await ownsSubmission(tx, options.submissionId, options.participantId))) {
    return { status: "not_yours" };
  }

  const requestId = randomUUID();
  try {
    await tx.query(
      `insert into correction_request
         (request_id, kind, submission_id, canonical_issue_id,
          requested_by_participant_id, citizen_note)
       values ($1,$2,$3,$4,$5,$6)`,
      [
        requestId,
        options.kind,
        options.submissionId,
        options.canonicalIssueId ?? null,
        options.participantId,
        options.citizenNote ?? null,
      ],
    );
  } catch (error) {
    // The exclusion constraint means one open request per person per report:
    // tapping twice is not two disagreements.
    if (
      typeof error === "object" &&
      error !== null &&
      (error as { code?: string }).code === "23P01"
    ) {
      return { status: "already_open" };
    }
    throw error;
  }
  return { status: "open", requestId };
};
