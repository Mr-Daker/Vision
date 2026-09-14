/**
 * Persisting AI proposals and evaluated trust reports (roadmap V023, V025, V032).
 *
 * Before this, both were computed and thrown away: V023 recorded that proposals
 * "are not yet persisted against evidence", V025 that "nothing consumes these
 * checks yet", and V032 that the queue's `flagged_evidence` kind "is declared
 * but not populated". A check nobody ever sees is not a safeguard.
 *
 * The rule that shapes every function here: **an inconsistent check is a reason
 * for a person to look, and nothing more.** So:
 *
 *  * `requires_review` is *derived from the checks*, never accepted from the
 *    caller. A flag with nothing inconsistent behind it is refused, because
 *    that is precisely how an `unknown` verdict turns into suspicion.
 *  * An all-`unknown` report is not flagged. A photograph with its metadata
 *    stripped is the ordinary case (V025), not a suspicious one.
 *  * Nothing here produces a number. `classification_proposal` has no numeric
 *    column at all, and a proposal's `requires_review` follows from its
 *    ordinal band (V002 prohibition 9).
 */

import { randomUUID } from "node:crypto";

import type { ClassificationProposal } from "@vision/contracts";
import type { TrustSignalReport } from "@vision/domain";

import type { Queryable } from "./outbox.ts";

export class ProposalError extends Error {}

export type StoredTrustReport = {
  readonly reportId: string;
  readonly requiresReview: boolean;
  readonly reviewReasons: readonly string[];
};

/**
 * Stores the evaluated checks for one submission, replacing any earlier report.
 *
 * One standing report per submission (`trust_signal_report_submission_uniq`):
 * a recomputation is a new answer to the same question, not an additional
 * flag, and accumulating rows would make one submission look repeatedly
 * suspect.
 */
export const recordTrustSignalReport = async (
  tx: Queryable,
  input: {
    readonly submissionId: string;
    readonly canonicalIssueId?: string | undefined;
    readonly report: TrustSignalReport;
  },
): Promise<StoredTrustReport> => {
  const inconsistent = input.report.checks.filter((check) => check.verdict === "inconsistent");

  // Derived, not trusted. The caller's `requiresReview` is cross-checked
  // rather than stored: a flag with no inconsistent check behind it has no
  // stated reason, and an unflagged report with one would hide a real
  // discrepancy.
  if (input.report.requiresReview && inconsistent.length === 0) {
    throw new ProposalError(
      "a trust report may only require review when at least one check came back inconsistent; an unknown verdict is not a reason to flag anything",
    );
  }
  if (!input.report.requiresReview && inconsistent.length > 0) {
    throw new ProposalError(
      "a trust report with an inconsistent check must require review rather than being stored as unremarkable",
    );
  }

  // Recomputed from the checks rather than taken from `input.report`. With
  // both guards above in place the two are provably equal, so no test can
  // distinguish this line from `input.report.requiresReview` — the guards are
  // the enforcing layer, and they are what the two tests above pin. It is
  // written this way because the guards are the part a later change is likely
  // to relax, and if one goes, the column should still follow the evidence.
  const requiresReview = inconsistent.length > 0;
  const anyInputIsFixture = input.report.checks.some((check) => check.inputIsFixture);
  const reportId = randomUUID();

  const { rows } = await tx.query(
    `insert into trust_signal_report
       (report_id, submission_id, canonical_issue_id, requires_review, checks,
        any_input_is_fixture)
     values ($1,$2,$3,$4,$5::jsonb,$6)
     on conflict (submission_id) do update
        set report_id = excluded.report_id,
            canonical_issue_id = excluded.canonical_issue_id,
            requires_review = excluded.requires_review,
            checks = excluded.checks,
            any_input_is_fixture = excluded.any_input_is_fixture,
            evaluated_at = now(),
            -- A replaced report is a fresh question, so an earlier review of
            -- the old one does not carry over.
            reviewed_at = null,
            review_decision_id = null
     returning report_id`,
    [
      reportId,
      input.submissionId,
      input.canonicalIssueId ?? null,
      requiresReview,
      JSON.stringify(input.report.checks),
      anyInputIsFixture,
    ],
  );

  return {
    reportId: String(rows[0]?.["report_id"] ?? reportId),
    requiresReview,
    reviewReasons: inconsistent.map((check) => check.reason),
  };
};

export type StoredProposal = {
  readonly proposalId: string;
  readonly submissionId: string;
  readonly evidenceId: string | undefined;
  readonly proposedCategoryId: string;
  readonly proposedDefectId: string | undefined;
  readonly certaintyBand: "low" | "medium" | "high";
  readonly taxonomyVersion: string;
  readonly modelName: string;
  readonly waitingSince: string;
};

/**
 * Stores an AI category proposal beside the evidence.
 *
 * Beside, not in: the proposal is advice pending review, so it never becomes a
 * field on `evidence_item` where a surface could read it as the evidence's own
 * category.
 */
export const recordClassificationProposal = async (
  tx: Queryable,
  input: {
    readonly submissionId: string;
    readonly evidenceId?: string | undefined;
    readonly proposal: ClassificationProposal;
  },
): Promise<{ readonly proposalId: string }> => {
  const proposal = input.proposal;

  // Derived from the band, not supplied alongside it. A `low` band with
  // `requires_review: false` would send an uncertain guess straight past the
  // only person who can tell whether it is right.
  const shouldReview = proposal.certainty_band !== "high";
  if (proposal.requires_review !== shouldReview) {
    throw new ProposalError(
      `a '${proposal.certainty_band}' proposal must have requires_review ${String(shouldReview)}; certainty and review cannot be stated independently`,
    );
  }

  const proposalId = randomUUID();
  await tx.query(
    `insert into classification_proposal
       (proposal_id, submission_id, evidence_id, taxonomy_version,
        proposed_category_id, proposed_defect_id, certainty_band, requires_review,
        model_name, prompt_version, input_hash)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      proposalId,
      input.submissionId,
      input.evidenceId ?? null,
      proposal.taxonomy_version,
      proposal.proposed_category_id,
      proposal.proposed_defect_id ?? null,
      proposal.certainty_band,
      proposal.requires_review,
      proposal.model_name,
      proposal.prompt_version,
      proposal.input_hash,
    ],
  );

  return { proposalId };
};

/**
 * Proposals still waiting for a person, scoped to one jurisdiction.
 *
 * Jurisdiction-scoped like every other review surface (V015): a proposal is
 * attached to evidence, and evidence belongs to somebody's report.
 */
export const pendingClassificationProposals = async (
  tx: Queryable,
  options: { readonly jurisdictionId: string; readonly limit?: number },
): Promise<readonly StoredProposal[]> => {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const { rows } = await tx.query(
    `select p.proposal_id, p.submission_id, p.evidence_id, p.proposed_category_id,
            p.proposed_defect_id, p.certainty_band, p.taxonomy_version, p.model_name,
            p.created_at
       from classification_proposal p
       join issue_evidence_link link
              on link.evidence_id = p.evidence_id and link.effective_to is null
       join canonical_issue i on i.issue_id = link.canonical_issue_id
      where p.requires_review
        and p.reviewed_at is null
        and i.jurisdiction_id = $2
      order by p.created_at asc
      limit $1`,
    [limit, options.jurisdictionId],
  );

  return rows.map((row) => {
    const defectId = row["proposed_defect_id"];
    const evidenceId = row["evidence_id"];
    return {
      proposalId: String(row["proposal_id"]),
      submissionId: String(row["submission_id"]),
      evidenceId: evidenceId === null ? undefined : String(evidenceId),
      proposedCategoryId: String(row["proposed_category_id"]),
      proposedDefectId: defectId === null ? undefined : String(defectId),
      certaintyBand: String(row["certainty_band"]) as "low" | "medium" | "high",
      taxonomyVersion: String(row["taxonomy_version"]),
      modelName: String(row["model_name"]),
      waitingSince: new Date(String(row["created_at"])).toISOString(),
    };
  });
};
