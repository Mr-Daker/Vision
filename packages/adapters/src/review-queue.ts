/**
 * Evidence and matching review queue (roadmap V032).
 *
 * A reviewer is the first actor in this system with power over someone else's
 * report, so three rules run through everything here.
 *
 * **Every decision carries a reason.** Not a code — prose a person wrote. A
 * decision nobody has to explain is one nobody can question, and the citizen
 * whose report it was has the strongest claim to an explanation.
 *
 * **Nothing is erased.** A rejected photograph is quarantined, not deleted; a
 * separated attachment is superseded with its correction reason, not removed;
 * a refused correction request is closed with its reasoning intact. The public
 * display changes — that is the point of review — but the history behind it
 * stays readable.
 *
 * **Permissions come from V015, not from opinions here.** Every action maps to
 * an `Action` in the authorization model and is checked with `authorize`, so a
 * role change is made in one place.
 *
 * That model turned out to say something this task had to be built around:
 * *every* review action is jurisdiction-scoped. A reviewer's powers exist only
 * inside their jurisdiction scope, so a queue that ignored jurisdiction would
 * be a permission bypass rather than a convenience. Hence `jurisdictionId` is
 * required to list the working queue.
 *
 * An item is jurisdiction-scoped once it is attached to an issue whose point
 * V033 resolved inside a configured boundary. Outside-profile, sibling-overlap
 * and accuracy-edge cases deliberately remain unscoped. They cannot be
 * authorised to *anyone* automatically — the administrator role has
 * configuration and audit access and deliberately no evidence access — so
 * they are reported as a count without disclosing anyone's report.
 *
 * The Hackathon surface authenticates an explicitly simulated reviewer, then
 * derives role and jurisdiction scope from durable staff grants. These
 * services still take a `Principal` directly so the authorization boundary is
 * independent of the identity provider that V057 will replace.
 */

import { randomUUID } from "node:crypto";

import {
  authorize,
  DEFAULT_CONFIRMATION_RULE,
  type Action,
  type ConfirmationPolicyPack,
  type Principal,
} from "@vision/domain";

import type { Queryable } from "./outbox.ts";
import { resolveDispute, respondToClaim } from "./resolution.ts";
import { resolveRouting } from "./routing.ts";

export class ReviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewError";
  }
}

export const REVIEW_QUEUE_LIMIT = 50;

export type ReviewItemKind =
  | "redaction_decision"
  | "flagged_evidence"
  | "ambiguous_match"
  | "correction_request"
  | "uncertain_classification"
  /**
   * A citizen disputed a repair claim (V035).
   *
   * This is the one kind whose subject is an issue rather than a piece of
   * evidence: the disagreement is about whether work was done, and the
   * reviewer is deciding between a department's claim and the people who live
   * with the problem.
   */
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
  | "claim_jurisdiction"
  /** Send the disputed work back to the crew, with the dispute left standing. */
  | "return_disputed_work"
  /**
   * Resolve a dispute in favour of the claim.
   *
   * Offered only where the loaded category policy sets `reviewerMayOverride`.
   * An absent flag is not permission — a safety category is exactly where a
   * reviewer overruling residents would be least defensible.
   */
  | "confirm_disputed_resolution";

export type ReviewItem = {
  readonly kind: ReviewItemKind;
  readonly targetId: string;
  readonly submissionId: string;
  readonly reason: string;
  readonly permittedActions: readonly ReviewAction[];
  readonly waitingSince: string;
  /** Present for a correction request: the citizen's own words. */
  readonly citizenNote: string | undefined;
  readonly candidateIssueIds: readonly string[];
  /**
   * Server-resolved identifiers needed to apply one of this row's permitted
   * actions. The browser never constructs these from a submission id.
   */
  readonly decisionTarget: {
    readonly evidenceId?: string;
    readonly matchId?: string;
    readonly correctionRequestId?: string;
    readonly canonicalIssueId?: string;
  };
};

export type ReviewQueue = {
  readonly items: readonly ReviewItem[];
  readonly appliedLimit: number;
  /** False when the limit was hit, so an empty tail is not read as "nothing left". */
  readonly exhaustive: boolean;
  readonly jurisdictionId: string;
  /**
   * How many items nobody can be authorised for yet, because their
   * jurisdiction is unknown.
   *
   * A **count**, not a list. V015 gives no role evidence powers without a
   * jurisdiction — an administrator has `configuration.write` and `audit.read`
   * and deliberately no evidence access at all — so there is no principal to
   * whom these items could be shown. A count makes the backlog visible while
   * disclosing nothing about anyone's report.
   */
  readonly awaitingJurisdictionCount: number;
  readonly awaitingJurisdictionNote: string;
};

/** Which authorization action each review action requires. */
const ACTION_PERMISSION: Readonly<Record<ReviewAction, Action>> = {
  accept_evidence: "evidence.redaction_decide",
  reject_evidence: "evidence.redaction_decide",
  approve_redaction: "evidence.redaction_decide",
  request_more_evidence: "evidence.redaction_decide",
  attach_to_issue: "match.review",
  separate_from_issue: "match.review",
  accept_correction: "match.review",
  reject_correction: "match.review",
  // Dismissing a flag is a decision about a piece of evidence, so it needs the
  // evidence power rather than the matching one.
  dismiss_trust_flag: "evidence.redaction_decide",
  accept_classification: "evidence.redaction_decide",
  reject_classification: "evidence.redaction_decide",
  // Reading other people's private reports is what claiming one implies, so
  // this is the power it needs — held *in the jurisdiction being claimed into*,
  // which is the whole point of the check.
  claim_jurisdiction: "issue.read_private",
  // Both move an issue between lifecycle states, so both need the transition
  // power held in the issue's own jurisdiction.
  return_disputed_work: "issue.transition",
  confirm_disputed_resolution: "issue.transition",
};

/**
 * The reasons from the checks that actually came back inconsistent.
 *
 * Filtered rather than joined wholesale: an `unknown` check's reason ("the
 * file carries no capture time") read alongside a flag would look like part of
 * the case for the flag, and it is not one (V025).
 */
const inconsistentReasons = (checks: unknown): readonly string[] => {
  if (!Array.isArray(checks)) return ["the stored checks could not be read"];
  const reasons = checks
    .filter(
      (check): check is { verdict: string; reason: string } =>
        typeof check === "object" &&
        check !== null &&
        (check as { verdict?: unknown }).verdict === "inconsistent",
    )
    .map((check) => String(check.reason));
  return reasons.length === 0 ? ["the stored checks name no inconsistency"] : reasons;
};

const AWAITING_NOTE =
  "every review action is jurisdiction-scoped (V015); V033 resolves reports inside the active synthetic boundary pack, while outside-profile, overlapping-boundary and accuracy-edge cases deliberately remain unscoped for manual jurisdiction review";

const requirePermission = (
  principal: Principal,
  action: ReviewAction,
  jurisdictionId: string | undefined,
): void => {
  // `claim_jurisdiction` is the one action whose scope is not the item's — the
  // item has none, which is why it is stuck. It is checked against the
  // jurisdiction the reviewer is claiming *into*, so a reviewer can only ever
  // pull work towards themselves and never push it into somebody else's queue.
  if (jurisdictionId === undefined) {
    // Not defaulted to "allowed" and not defaulted to a jurisdiction: an
    // unscoped review action is exactly the permission bypass V015 forbids.
    throw new ReviewError(
      `${action} is jurisdiction-scoped, and this item's jurisdiction is not known; the report may be outside the configured profile or too close to a boundary to assign safely`,
    );
  }
  const decision = authorize(principal, ACTION_PERMISSION[action], { jurisdictionId });
  if (!decision.allowed) {
    throw new ReviewError(`role '${principal.role}' may not ${action}: ${decision.reason}`);
  }
};

export const listReviewQueue = async (
  tx: Queryable,
  options: {
    readonly principal: Principal;
    /** The jurisdiction being worked. Required: review powers are scoped to one. */
    readonly jurisdictionId: string;
    readonly limit?: number;
    /**
     * The loaded confirmation policy (V035).
     *
     * Required to list disputed resolutions, because whether a reviewer may
     * resolve a dispute in favour of the claim is a configured decision per
     * category — not one this file gets to make. Absent, disputes are simply
     * not listed rather than listed with a guessed set of actions.
     */
    readonly confirmationPolicy?: ConfirmationPolicyPack;
  },
): Promise<ReviewQueue> => {
  const resource = { jurisdictionId: options.jurisdictionId };
  // Reading the queue needs the private-issue read *in this jurisdiction*,
  // plus at least one decision power there. A role that can act on nothing has
  // no business reading other people's evidence.
  const canRead = authorize(options.principal, "issue.read_private", resource);
  const canDecide =
    authorize(options.principal, "evidence.redaction_decide", resource).allowed ||
    authorize(options.principal, "match.review", resource).allowed;
  if (!canRead.allowed || !canDecide) {
    throw new ReviewError(
      `role '${options.principal.role}' may not read the review queue for jurisdiction '${options.jurisdictionId}'`,
    );
  }

  const limit = Math.min(Math.max(options.limit ?? REVIEW_QUEUE_LIMIT, 1), REVIEW_QUEUE_LIMIT);

  // Three sources, one list. Note that no query selects `object_reference`:
  // the queue is a worklist, and reading a private original is a separate
  // audited act (V015, V021 §5).
  const redactions = await tx.query(
    `select e.evidence_id, e.submission_id, e.ingested_at, e.media_type,
            i.issue_id, i.jurisdiction_id
       from evidence_item e
       join issue_evidence_link link
              on link.evidence_id = e.evidence_id and link.effective_to is null
       join canonical_issue i on i.issue_id = link.canonical_issue_id
      where e.privacy_state = 'active'
        and e.media_type = 'photo'
        and e.redaction_status = 'needs_review'
        and i.jurisdiction_id = $2
      order by e.ingested_at asc
      limit $1`,
    [limit + 1, options.jurisdictionId],
  );

  // An ambiguous match is in scope when *any* of its candidates is: the
  // reviewer is choosing between them, so seeing one and not the others would
  // make the choice impossible.
  const matches = await tx.query(
    `select m.match_id, m.submission_id, m.candidate_issue_ids, m.decision_basis,
            -- issue_match records no creation time, so the queue ages an
            -- ambiguous match by when the citizen's report arrived. That is
            -- the number that matters anyway: how long they have waited.
            s.server_received_at as waiting_since
       from issue_match m
       join submission s on s.submission_id = m.submission_id
      where m.state = 'ambiguous'
        and m.superseded_at is null
        and exists (
          select 1 from canonical_issue i
           where i.issue_id = any(m.candidate_issue_ids)
             and i.jurisdiction_id = $2
        )
      order by m.match_id asc
      limit $1`,
    [limit + 1, options.jurisdictionId],
  );

  const corrections = await tx.query(
    `select r.request_id, r.submission_id, r.canonical_issue_id, r.citizen_note,
            r.kind, r.created_at, attached.evidence_id
       from correction_request r
       join canonical_issue i on i.issue_id = r.canonical_issue_id
       left join lateral (
         select e.evidence_id
           from evidence_item e
           join issue_evidence_link link
                  on link.evidence_id = e.evidence_id
                 and link.canonical_issue_id = r.canonical_issue_id
                 and link.effective_to is null
          where e.submission_id = r.submission_id
            and e.privacy_state = 'active'
          order by e.evidence_id
          limit 1
       ) attached on true
      where r.state = 'open'
        and i.jurisdiction_id = $2
      order by r.created_at asc
      limit $1`,
    [limit + 1, options.jurisdictionId],
  );

  // V032's `flagged_evidence`, which was declared but never populated. Only
  // reports whose `requires_review` is set reach here, and that column is set
  // only by an inconsistent check — never by an `unknown` one, because missing
  // metadata is not evidence of anything (V025).
  const flags = await tx.query(
    `select t.report_id, t.submission_id, t.checks, t.evaluated_at,
            t.any_input_is_fixture, attached.evidence_id
       from trust_signal_report t
       join canonical_issue i on i.issue_id = t.canonical_issue_id
       join lateral (
         select e.evidence_id
           from evidence_item e
           join issue_evidence_link link
                  on link.evidence_id = e.evidence_id
                 and link.canonical_issue_id = t.canonical_issue_id
                 and link.effective_to is null
          where e.submission_id = t.submission_id
            and e.privacy_state = 'active'
          order by e.evidence_id
          limit 1
       ) attached on true
      where t.requires_review
        and t.reviewed_at is null
        and i.jurisdiction_id = $2
      order by t.evaluated_at asc
      limit $1`,
    [limit + 1, options.jurisdictionId],
  );

  // V023's uncertain classifications. A `high` band never appears: sending
  // every proposal to review would bury the ones that need it.
  const proposals = await tx.query(
    `select p.proposal_id, p.submission_id, p.proposed_category_id,
            p.proposed_defect_id, p.certainty_band, p.model_name, p.created_at
       from classification_proposal p
       join issue_evidence_link link
              on link.evidence_id = p.evidence_id and link.effective_to is null
       join canonical_issue i on i.issue_id = link.canonical_issue_id
      where p.requires_review
        and p.reviewed_at is null
        and i.jurisdiction_id = $2
      order by p.created_at asc
      limit $1`,
    [limit + 1, options.jurisdictionId],
  );

  // V035 disputed resolutions. The subject is the issue, and the reviewer is
  // choosing between a department's claim and the people living with the
  // problem — so the citizen's own words travel with the row.
  const disputes =
    options.confirmationPolicy === undefined
      ? { rows: [] as Record<string, unknown>[] }
      : await tx.query(
          `select i.issue_id, i.category, i.public_reference,
                  k.claim_id, k.description, k.staff_id,
                  c.decided_at, c.comment, c.responding_participant_id,
                  (select submission_id
                     from evidence_item e
                     join issue_evidence_link l
                            on l.evidence_id = e.evidence_id and l.effective_to is null
                    where l.canonical_issue_id = i.issue_id
                    order by e.ingested_at asc limit 1) as submission_id
             from canonical_issue i
             join lateral (
               select claim_id, description, staff_id from resolution_claim
                where issue_id = i.issue_id order by claimed_at desc limit 1
             ) k on true
             join lateral (
               select decided_at, comment, responding_participant_id
                 from resolution_confirmation
                where claim_id = k.claim_id and decision = 'disputed'
                order by decided_at asc limit 1
             ) c on true
            where i.current_status = 'resolution_disputed'
              and i.jurisdiction_id = $2
            order by c.decided_at asc
            limit $1`,
          [limit + 1, options.jurisdictionId],
        );

  const items: ReviewItem[] = [
    ...redactions.rows.map((row) => ({
      kind: "redaction_decision" as const,
      targetId: String(row["evidence_id"]),
      submissionId: String(row["submission_id"]),
      reason:
        "a photograph is waiting for a redaction decision; no detector has checked it for faces or number plates",
      permittedActions: [
        "approve_redaction",
        "reject_evidence",
        "request_more_evidence",
      ] as readonly ReviewAction[],
      waitingSince: new Date(String(row["ingested_at"])).toISOString(),
      citizenNote: undefined,
      candidateIssueIds: [] as readonly string[],
      decisionTarget: {
        evidenceId: String(row["evidence_id"]),
        canonicalIssueId: String(row["issue_id"]),
      },
    })),
    ...matches.rows.map((row) => ({
      kind: "ambiguous_match" as const,
      targetId: String(row["match_id"]),
      submissionId: String(row["submission_id"]),
      reason:
        "the matcher could not choose between the candidates, so a person must decide which issue this report belongs to",
      permittedActions: ["attach_to_issue"] as readonly ReviewAction[],
      waitingSince: new Date(String(row["waiting_since"])).toISOString(),
      citizenNote: undefined,
      candidateIssueIds: ((row["candidate_issue_ids"] as string[] | null) ?? []).map(String),
      decisionTarget: { matchId: String(row["match_id"]) },
    })),
    ...corrections.rows.map((row) => ({
      kind: "correction_request" as const,
      targetId: String(row["request_id"]),
      submissionId: String(row["submission_id"]),
      reason: `the reporter says this is ${String(row["kind"]).replace(/_/g, " ")}, and only a reviewer may separate an attachment`,
      permittedActions: [
        "accept_correction",
        "reject_correction",
        ...(row["evidence_id"] === null ? [] : (["separate_from_issue"] as const)),
      ] as readonly ReviewAction[],
      waitingSince: new Date(String(row["created_at"])).toISOString(),
      citizenNote: row["citizen_note"] === null ? undefined : String(row["citizen_note"]),
      candidateIssueIds:
        row["canonical_issue_id"] === null ? [] : [String(row["canonical_issue_id"])],
      decisionTarget: {
        correctionRequestId: String(row["request_id"]),
        ...(row["evidence_id"] === null ? {} : { evidenceId: String(row["evidence_id"]) }),
        ...(row["canonical_issue_id"] === null
          ? {}
          : { canonicalIssueId: String(row["canonical_issue_id"]) }),
      },
    })),
    ...flags.rows.map((row) => ({
      kind: "flagged_evidence" as const,
      targetId: String(row["report_id"]),
      submissionId: String(row["submission_id"]),
      // The reasons are the checks' own words. Nothing here characterises the
      // reporter: an inconsistency is a discrepancy to look into, and saying
      // more than that would be asserting dishonesty the checks cannot
      // establish (V025).
      reason: `a consistency check did not line up, so a person should look: ${inconsistentReasons(
        row["checks"],
      ).join("; ")}`,
      permittedActions: [
        "dismiss_trust_flag",
        "request_more_evidence",
        "reject_evidence",
      ] as readonly ReviewAction[],
      waitingSince: new Date(String(row["evaluated_at"])).toISOString(),
      citizenNote: undefined,
      candidateIssueIds: [] as readonly string[],
      decisionTarget: { evidenceId: String(row["evidence_id"]) },
    })),
    ...proposals.rows.map((row) => ({
      kind: "uncertain_classification" as const,
      targetId: String(row["proposal_id"]),
      submissionId: String(row["submission_id"]),
      // The band is named as a band. There is no score to report, and
      // rendering one would be presenting an uncalibrated number as calibrated
      // (V002 prohibition 9).
      reason: `a model proposed the category '${String(row["proposed_category_id"])}' with ${String(row["certainty_band"])} certainty, which is a proposal for a person to confirm and not a classification`,
      permittedActions: [
        "accept_classification",
        "reject_classification",
      ] as readonly ReviewAction[],
      waitingSince: new Date(String(row["created_at"])).toISOString(),
      citizenNote: undefined,
      candidateIssueIds: [] as readonly string[],
      decisionTarget: { evidenceId: String(row["evidence_id"]) },
    })),
    ...disputes.rows.map((row) => {
      const category = String(row["category"]);
      const rule = options.confirmationPolicy?.rules[category] ?? DEFAULT_CONFIRMATION_RULE;
      return {
        kind: "disputed_resolution" as const,
        targetId: String(row["issue_id"]),
        // An issue may carry no evidence of its own; the row is still
        // actionable, so the reference falls back to the issue itself rather
        // than dropping the item.
        submissionId:
          row["submission_id"] === null
            ? String(row["public_reference"])
            : String(row["submission_id"]),
        reason: `a participant disputes the repair claim for ${String(row["public_reference"])}; the claim says: ${String(row["description"])}`,
        permittedActions: [
          "return_disputed_work",
          // Offered only where the policy grants the override. Omitting it is
          // what makes a safety category's dispute final for a reviewer, and
          // `canTransitionIssue` refuses it again underneath.
          ...(rule.reviewerMayOverride === true ? (["confirm_disputed_resolution"] as const) : []),
        ] as readonly ReviewAction[],
        waitingSince: new Date(String(row["decided_at"])).toISOString(),
        citizenNote: row["comment"] === null ? undefined : String(row["comment"]),
        candidateIssueIds: [] as readonly string[],
        decisionTarget: { canonicalIssueId: String(row["issue_id"]) },
      };
    }),
  ];

  // Oldest first across every kind: a worklist ordered by anything else lets
  // an awkward item sit forever.
  items.sort((a, b) => a.waitingSince.localeCompare(b.waitingSince));

  // How many items are stuck outside every jurisdiction. A count only: see
  // `awaitingJurisdictionCount` for why there is no principal who could be
  // shown the items themselves.
  const orphans = await tx.query(
    `select count(*)::int as n
       from evidence_item e
      where e.privacy_state = 'active'
        and e.media_type = 'photo'
        and e.redaction_status = 'needs_review'
        and not exists (
          select 1 from issue_evidence_link link
           join canonical_issue i on i.issue_id = link.canonical_issue_id
          where link.evidence_id = e.evidence_id
            and link.effective_to is null
            and i.jurisdiction_id is not null
        )`,
  );

  return {
    items: items.slice(0, limit),
    appliedLimit: limit,
    exhaustive: items.length <= limit,
    jurisdictionId: options.jurisdictionId,
    awaitingJurisdictionCount: Number(orphans.rows[0]?.["n"] ?? 0),
    awaitingJurisdictionNote: AWAITING_NOTE,
  };
};

export type ReviewDecisionInput = {
  readonly principal: Principal;
  readonly action: ReviewAction;
  readonly reason: string;
  readonly evidenceId?: string;
  readonly matchId?: string;
  readonly correctionRequestId?: string;
  readonly canonicalIssueId?: string;
  /**
   * The jurisdiction being claimed into (`claim_jurisdiction` only).
   *
   * Separate from the item's own jurisdiction, because the item has none —
   * that is what makes it unactionable and what this claim fixes.
   */
  readonly jurisdictionId?: string;
  /** The loaded confirmation policy, required for the V035 dispute actions. */
  readonly confirmationPolicy?: ConfirmationPolicyPack;
};

/**
 * The jurisdiction a decision falls in.
 *
 * Taken from the issue the item belongs to, because that is the only place a
 * jurisdiction is recorded today. `undefined` means no scoped permission can
 * be evaluated, and `requirePermission` refuses rather than defaulting to
 * "allowed".
 */
const jurisdictionOf = async (
  tx: Queryable,
  input: ReviewDecisionInput,
): Promise<string | undefined> => {
  // A claim is authorised against the jurisdiction being claimed *into*. The
  // item's own is undefined — that is the condition being repaired — so
  // looking it up would deny every claim and leave the backlog exactly as
  // stuck as before.
  if (input.action === "claim_jurisdiction") return input.jurisdictionId;
  if (input.canonicalIssueId !== undefined) {
    const { rows } = await tx.query(
      "select jurisdiction_id from canonical_issue where issue_id = $1",
      [input.canonicalIssueId],
    );
    const value = rows[0]?.["jurisdiction_id"];
    return value === null || value === undefined ? undefined : String(value);
  }
  if (input.evidenceId !== undefined) {
    const { rows } = await tx.query(
      `select i.jurisdiction_id
         from issue_evidence_link link
         join canonical_issue i on i.issue_id = link.canonical_issue_id
        where link.evidence_id = $1 and link.effective_to is null
          and i.jurisdiction_id is not null
        limit 1`,
      [input.evidenceId],
    );
    const value = rows[0]?.["jurisdiction_id"];
    return value === null || value === undefined ? undefined : String(value);
  }
  if (input.matchId !== undefined) {
    const { rows } = await tx.query(
      `select i.jurisdiction_id
         from issue_match m
         join canonical_issue i on i.issue_id = any(m.candidate_issue_ids)
        where m.match_id = $1 and i.jurisdiction_id is not null
        limit 1`,
      [input.matchId],
    );
    const value = rows[0]?.["jurisdiction_id"];
    return value === null || value === undefined ? undefined : String(value);
  }
  if (input.correctionRequestId !== undefined) {
    const { rows } = await tx.query(
      `select i.jurisdiction_id
         from correction_request r
         join canonical_issue i on i.issue_id = r.canonical_issue_id
        where r.request_id = $1`,
      [input.correctionRequestId],
    );
    const value = rows[0]?.["jurisdiction_id"];
    return value === null || value === undefined ? undefined : String(value);
  }
  return undefined;
};

export type ReviewDecisionResult = {
  readonly decisionId: string;
  readonly priorState: Readonly<Record<string, unknown>>;
  readonly resultingState: Readonly<Record<string, unknown>>;
};

const recordDecision = async (
  tx: Queryable,
  input: ReviewDecisionInput,
  priorState: Record<string, unknown>,
  resultingState: Record<string, unknown>,
): Promise<ReviewDecisionResult> => {
  const decisionId = randomUUID();
  await tx.query(
    `insert into review_decision
       (decision_id, evidence_id, match_id, correction_request_id, canonical_issue_id,
        action, reason, reviewer_id, prior_state, resulting_state)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb)`,
    [
      decisionId,
      input.evidenceId ?? null,
      input.matchId ?? null,
      input.correctionRequestId ?? null,
      input.canonicalIssueId ?? null,
      input.action,
      input.reason,
      input.principal.staffId ?? null,
      JSON.stringify(priorState),
      JSON.stringify(resultingState),
    ],
  );
  return { decisionId, priorState, resultingState };
};

/**
 * Applies one reviewer decision.
 *
 * The reason is validated before anything is read, so a decision that cannot
 * be explained never touches the record at all.
 */
export const decideReview = async (
  tx: Queryable,
  input: ReviewDecisionInput,
): Promise<ReviewDecisionResult> => {
  // Checked here for the error message; the enforcing mechanism is
  // review_decision_reason_nonempty_ck together with the transaction below,
  // which is what mutation testing can actually distinguish.
  if (input.reason.trim().length === 0) {
    throw new ReviewError("a review decision requires a recorded reason");
  }
  // One transaction around the state change and its audit record. Without it,
  // a decision that fails to record — a missing reason caught by the
  // constraint, say — would leave the evidence already changed with nothing
  // explaining why. A state change with no audit row is exactly what this
  // task exists to prevent.
  // The two V035 dispute actions are handled before the transaction below,
  // because `resolveDispute` and `respondToClaim` open their own. Nesting
  // `begin` inside `begin` does not nest in PostgreSQL — the inner `commit`
  // would commit the outer one, so a later failure could not be rolled back.
  if (input.action === "return_disputed_work" || input.action === "confirm_disputed_resolution") {
    return applyDisputeDecision(tx, input);
  }

  await tx.query("begin");
  try {
    const result = await applyDecision(tx, input);
    await tx.query("commit");
    return result;
  } catch (error) {
    await tx.query("rollback").catch(() => undefined);
    throw error;
  }
};

/**
 * A reviewer's answer to a disputed repair claim (V035 §C).
 *
 * Both outcomes keep the citizen's dispute on the record: returning the work
 * leaves the disputed confirmation row exactly where it is, and an override is
 * written as an additional reviewer row rather than by editing theirs. Nothing
 * here deletes or rewrites what the participant said.
 */
const applyDisputeDecision = async (
  tx: Queryable,
  input: ReviewDecisionInput,
): Promise<ReviewDecisionResult> => {
  const issueId = input.canonicalIssueId;
  if (issueId === undefined) {
    throw new ReviewError(`${input.action} requires the disputed issue`);
  }
  const jurisdictionId = await jurisdictionOf(tx, input);
  requirePermission(input.principal, input.action, jurisdictionId);
  if (input.principal.staffId === undefined) {
    throw new ReviewError("a review decision must be attributable to a staff identity");
  }

  const before = await tx.query("select current_status from canonical_issue where issue_id = $1", [
    issueId,
  ]);
  const priorStatus = String(before.rows[0]?.["current_status"] ?? "");
  if (priorStatus !== "resolution_disputed") {
    // 'conflict', not 'forbidden': somebody else acted first, and the reviewer
    // should re-read rather than be told they lack permission.
    throw new ReviewError(
      `this issue is '${priorStatus}', not a standing dispute; refresh the queue before deciding`,
    );
  }

  if (input.action === "return_disputed_work") {
    const returned = await resolveDispute(tx, {
      principal: input.principal,
      issueId,
      reason: input.reason,
    });
    return {
      decisionId: returned.decisionId,
      priorState: { issue_status: priorStatus },
      resultingState: { issue_status: "work_planned" },
    };
  }

  const policy = input.confirmationPolicy;
  if (policy === undefined) {
    // Refused rather than defaulted. `DEFAULT_CONFIRMATION_RULE` withholds the
    // override, so defaulting would merely produce a confusing refusal — but
    // an override decided against a policy nobody loaded is worse than either.
    throw new ReviewError(
      "resolving a dispute in favour of a claim requires the loaded confirmation policy",
    );
  }
  const claim = await tx.query(
    "select claim_id from resolution_claim where issue_id = $1 order by claimed_at desc limit 1",
    [issueId],
  );
  const claimId = claim.rows[0]?.["claim_id"];
  if (claimId === undefined) {
    throw new ReviewError("this issue carries no repair claim to confirm");
  }

  // The audit row is written inside the response's own transaction, so the
  // override and the record of who made it commit or fail together. Written
  // afterwards, a failing insert left a confirmed resolution standing with
  // nothing saying a reviewer had decided it.
  let decision: ReviewDecisionResult | undefined;
  const outcome = await respondToClaim(tx, {
    claimId: String(claimId),
    decision: "confirmed",
    policy,
    reviewerPrincipal: input.principal,
    comment: input.reason,
    alsoRecord: async (inner) => {
      decision = await recordDecision(
        inner,
        { ...input, canonicalIssueId: issueId },
        { issue_status: priorStatus },
        { issue_status: "resolution_confirmed" },
      );
    },
  });
  if (decision === undefined) {
    throw new ReviewError("the reviewer decision was not recorded");
  }
  return {
    ...decision,
    resultingState: { issue_status: outcome.resultingStatus },
  };
};

const applyDecision = async (
  tx: Queryable,
  input: ReviewDecisionInput,
): Promise<ReviewDecisionResult> => {
  const jurisdictionId = await jurisdictionOf(tx, input);
  requirePermission(input.principal, input.action, jurisdictionId);
  if (input.principal.staffId === undefined) {
    throw new ReviewError("a review decision must be attributable to a staff identity");
  }

  switch (input.action) {
    case "approve_redaction":
    case "reject_evidence":
    case "accept_evidence":
    case "request_more_evidence": {
      const evidenceId = input.evidenceId;
      if (evidenceId === undefined)
        throw new ReviewError(`${input.action} requires an evidence id`);

      const before = await tx.query(
        "select redaction_status, processing_status from evidence_item where evidence_id = $1",
        [evidenceId],
      );
      const prior = before.rows[0];
      if (prior === undefined) throw new ReviewError(`evidence ${evidenceId} does not exist`);

      const next =
        input.action === "approve_redaction"
          ? { redaction_status: "approved", processing_status: "usable" }
          : input.action === "accept_evidence"
            ? { redaction_status: String(prior["redaction_status"]), processing_status: "usable" }
            : input.action === "reject_evidence"
              ? // Quarantined, not erased: erasure is a V005 retention act with
                // its own ledger, not a review outcome.
                {
                  redaction_status: String(prior["redaction_status"]),
                  processing_status: "quarantined",
                }
              : { redaction_status: "needs_review", processing_status: "needs_review" };

      await tx.query(
        `update evidence_item
            set redaction_status = $2, processing_status = $3,
                current_version = current_version + 1
          where evidence_id = $1`,
        [evidenceId, next.redaction_status, next.processing_status],
      );

      return recordDecision(
        tx,
        input,
        {
          redaction_status: String(prior["redaction_status"]),
          processing_status: String(prior["processing_status"]),
        },
        next,
      );
    }

    case "attach_to_issue": {
      const matchId = input.matchId;
      const issueId = input.canonicalIssueId;
      if (matchId === undefined || issueId === undefined) {
        throw new ReviewError("attach_to_issue requires a match id and a canonical issue id");
      }

      const before = await tx.query(
        "select submission_id, state, candidate_issue_ids, resulting_issue_id from issue_match where match_id = $1",
        [matchId],
      );
      const prior = before.rows[0];
      if (prior === undefined) throw new ReviewError(`match ${matchId} does not exist`);

      // A reviewer chooses among the candidates the system found. Redirecting
      // a report to an unrelated issue is a different act and must be recorded
      // as one, not slipped through this path.
      const candidates = ((prior["candidate_issue_ids"] as string[] | null) ?? []).map(String);
      if (!candidates.includes(issueId)) {
        throw new ReviewError(
          `issue ${issueId} was not among the candidates for this match; attaching to an unrelated issue is a separate decision`,
        );
      }

      const now = new Date().toISOString();
      await tx.query(
        `update issue_match
            set state = 'match_confirmed', resulting_issue_id = $2,
                decided_by_actor_type = 'reviewer', decided_by_actor_id = $3,
                decided_at = $4, current_version = current_version + 1
          where match_id = $1`,
        [matchId, issueId, input.principal.staffId, now],
      );

      const evidence = await tx.query(
        "select evidence_id from evidence_item where submission_id = $1 and privacy_state = 'active'",
        [String(prior["submission_id"])],
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
            issueId,
            matchId,
            JSON.stringify({ decided_by: "reviewer" }),
            now,
          ],
        );
      }

      return recordDecision(
        tx,
        input,
        { state: String(prior["state"]), resulting_issue_id: prior["resulting_issue_id"] },
        { state: "match_confirmed", resulting_issue_id: issueId },
      );
    }

    case "separate_from_issue": {
      const evidenceId = input.evidenceId;
      const issueId = input.canonicalIssueId;
      if (evidenceId === undefined || issueId === undefined) {
        throw new ReviewError("separate_from_issue requires an evidence id and an issue id");
      }

      const before = await tx.query(
        `select issue_evidence_link_id from issue_evidence_link
          where evidence_id = $1 and canonical_issue_id = $2 and effective_to is null`,
        [evidenceId, issueId],
      );
      if (before.rows[0] === undefined) {
        throw new ReviewError("there is no active attachment to separate");
      }

      // Superseded with its reason, never deleted: why the evidence was ever
      // attached is part of the record (V003 effective dating).
      await tx.query(
        `update issue_evidence_link
            set effective_to = now(), correction_reason = $3, corrected_by_actor_id = $4
          where issue_evidence_link_id = $1 and canonical_issue_id = $2`,
        [
          String(before.rows[0]["issue_evidence_link_id"]),
          issueId,
          input.reason,
          input.principal.staffId,
        ],
      );

      return recordDecision(
        tx,
        input,
        { attached: true, canonical_issue_id: issueId },
        { attached: false, canonical_issue_id: issueId, superseded: true },
      );
    }

    case "accept_correction":
    case "reject_correction": {
      const requestId = input.correctionRequestId;
      if (requestId === undefined) {
        throw new ReviewError(`${input.action} requires a correction request id`);
      }

      const before = await tx.query(
        "select state, kind, canonical_issue_id from correction_request where request_id = $1",
        [requestId],
      );
      const prior = before.rows[0];
      if (prior === undefined) throw new ReviewError(`request ${requestId} does not exist`);
      if (String(prior["state"]) !== "open") {
        throw new ReviewError("this correction request has already been decided");
      }

      const decision = input.action === "accept_correction" ? "accepted" : "rejected";
      await tx.query(
        `update correction_request
            set state = $2, decision = $2, decision_reason = $3,
                decided_by_reviewer_id = $4, decided_at = now()
          where request_id = $1`,
        [requestId, decision, input.reason, input.principal.staffId],
      );

      return recordDecision(
        tx,
        input,
        { state: String(prior["state"]) },
        { state: decision, decision },
      );
    }

    case "claim_jurisdiction": {
      const issueId = input.canonicalIssueId;
      const claimed = input.jurisdictionId;
      if (issueId === undefined || claimed === undefined) {
        throw new ReviewError(
          "claim_jurisdiction requires the issue and the jurisdiction being claimed into",
        );
      }

      const before = await tx.query(
        "select jurisdiction_id from canonical_issue where issue_id = $1",
        [issueId],
      );
      const prior = before.rows[0];
      if (prior === undefined) throw new ReviewError(`issue ${issueId} does not exist`);
      if (prior["jurisdiction_id"] !== null) {
        // Moving an issue between jurisdictions changes who owns work already
        // in progress. That is a different act with different consequences and
        // must not happen through an action meant for unassigned items.
        throw new ReviewError(
          "this issue already has a jurisdiction; moving an issue between jurisdictions is a separate decision",
        );
      }

      await tx.query(
        `update canonical_issue
            set jurisdiction_id = $2, current_version = current_version + 1
          where issue_id = $1`,
        [issueId, claimed],
      );

      return recordDecision(
        tx,
        input,
        { jurisdiction_id: null },
        // Recorded as a claim, not as a derivation: nothing computed this from
        // a boundary, a person asserted it (V059 is where boundaries come from).
        { jurisdiction_id: claimed, claimed_by_reviewer: true },
      );
    }

    case "dismiss_trust_flag": {
      const evidenceId = input.evidenceId;
      if (evidenceId === undefined) {
        throw new ReviewError("dismiss_trust_flag requires an evidence id");
      }

      const before = await tx.query(
        `select t.submission_id, t.requires_review, t.reviewed_at
           from trust_signal_report t
           join evidence_item e on e.submission_id = t.submission_id
          where e.evidence_id = $1`,
        [evidenceId],
      );
      const prior = before.rows[0];
      if (prior === undefined) {
        throw new ReviewError(`no trust report exists for evidence ${evidenceId}`);
      }
      if (prior["reviewed_at"] !== null) {
        throw new ReviewError("this trust flag has already been decided");
      }

      const result = await recordDecision(
        tx,
        input,
        { requires_review: prior["requires_review"], reviewed: false },
        // Note what this does *not* say: nothing about the evidence itself.
        // A dismissal means the discrepancy was explained, not that the
        // photograph is approved for publication — that is a redaction
        // decision, with its own action and its own audit row. The evidence
        // row is deliberately left untouched.
        { requires_review: prior["requires_review"], reviewed: true, flag_dismissed: true },
      );
      await tx.query(
        `update trust_signal_report
            set reviewed_at = now(), review_decision_id = $2
          where submission_id = $1`,
        [String(prior["submission_id"]), result.decisionId],
      );
      return result;
    }

    case "accept_classification":
    case "reject_classification": {
      const evidenceId = input.evidenceId;
      if (evidenceId === undefined) {
        throw new ReviewError(`${input.action} requires an evidence id`);
      }

      const before = await tx.query(
        `select proposal_id, proposed_category_id, proposed_defect_id, certainty_band
           from classification_proposal
          where evidence_id = $1 and requires_review and reviewed_at is null
          order by created_at asc`,
        [evidenceId],
      );
      const prior = before.rows[0];
      if (prior === undefined) {
        throw new ReviewError(`no proposal is awaiting review for evidence ${evidenceId}`);
      }

      const accepted = input.action === "accept_classification";
      const proposedCategory = String(prior["proposed_category_id"]);

      // The issue this evidence belongs to, which is what an accepted
      // classification changes.
      const issueRow = await tx.query(
        `select i.issue_id, i.category,
                -- The directory version is configured per jurisdiction, so the
                -- re-route consults the same directory the original route did
                -- rather than whatever is newest.
                j.directory_version
           from canonical_issue i
           join issue_evidence_link link
                  on link.canonical_issue_id = i.issue_id and link.effective_to is null
           left join jurisdiction j on j.jurisdiction_id = i.jurisdiction_id
          where link.evidence_id = $1`,
        [evidenceId],
      );
      const issue = issueRow.rows[0];
      const priorCategory = issue === undefined ? undefined : String(issue["category"]);

      let routingOutcome: string | undefined;
      if (accepted && issue !== undefined && priorCategory !== proposedCategory) {
        // Applied, not merely agreed with. Recording the agreement and leaving
        // the category alone meant a reviewer could work the whole queue while
        // every issue kept the fallback category it was opened with.
        await tx.query(
          `update canonical_issue
              set category = $2, current_version = current_version + 1
            where issue_id = $1`,
          [String(issue["issue_id"]), proposedCategory],
        );
        // Ownership is looked up by category, so the route has to be resolved
        // again. `routing_decision` records the category each decision was
        // made under, so this appends rather than rewriting why the original
        // route was chosen.
        const rerouted = await resolveRouting(tx, {
          issueId: String(issue["issue_id"]),
          // No jurisdiction means no directory to consult; `resolveRouting`
          // reports `unknown_owner_review` for that case rather than guessing
          // an owner, so the version passed here is immaterial to the outcome.
          directoryVersion:
            issue["directory_version"] === null || issue["directory_version"] === undefined
              ? "demo-routing.v1"
              : String(issue["directory_version"]),
        });
        routingOutcome = rerouted.outcome;
      }

      const result = await recordDecision(
        tx,
        input,
        {
          proposed_category_id: proposedCategory,
          certainty_band: String(prior["certainty_band"]),
          reviewed: false,
          ...(priorCategory === undefined ? {} : { issue_category: priorCategory }),
        },
        {
          proposed_category_id: proposedCategory,
          accepted,
          reviewed: true,
          // What the issue's category is *now* — unchanged on a rejection, and
          // unchanged on an acceptance that agreed with what it already said.
          ...(priorCategory === undefined
            ? {}
            : { issue_category: accepted ? proposedCategory : priorCategory }),
          // A re-route that found no owner is reported rather than swallowed:
          // the reviewer's decision stands, and the missing owner is an
          // operational gap for someone to close.
          ...(routingOutcome === undefined ? {} : { routing_outcome: routingOutcome }),
        },
      );
      await tx.query(
        `update classification_proposal
            set reviewed_at = now(), review_decision_id = $2
          where proposal_id = $1`,
        [String(prior["proposal_id"]), result.decisionId],
      );
      return result;
    }

    // The V035 dispute actions never reach here: `decideReview` routes them to
    // `applyDisputeDecision`, which manages its own transactions. Named rather
    // than left to fall through, so adding an action to the union without a
    // handler is a compile error instead of a silent no-op.
    case "return_disputed_work":
    case "confirm_disputed_resolution":
      throw new ReviewError(
        `${input.action} is applied outside the shared review transaction and must not reach applyDecision`,
      );
  }
};
