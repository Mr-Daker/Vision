/**
 * Persisting AI proposals and trust reports, and getting them into the queue
 * (roadmap V023, V025, V032).
 *
 * Run with: npm run db:up && npm run db:migrate && npm run test:db
 *
 * Three labelled gaps meet here:
 *
 *  * V023 said proposals "are not yet persisted against evidence", so an
 *    uncertain classification had nowhere to go and no reviewer ever saw it.
 *  * V025 said "nothing consumes these checks yet" — the trust signals were
 *    computed and discarded.
 *  * V032 said `flagged_evidence` "is declared but not populated".
 *
 * The rule that governs all of it: **an inconsistent check is a reason for a
 * person to look, and nothing more.** A missing timestamp is not a fraud
 * signal, an unknown verdict must never flag anything, and no surface here may
 * produce a number that looks calibrated.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

import type { Principal, TrustSignalReport } from "@vision/domain";

import {
  recordTrustSignalReport,
  recordClassificationProposal,
  pendingClassificationProposals,
} from "./proposals.ts";
import { decideReview, listReviewQueue } from "./review-queue.ts";
import { resolveRouting } from "./routing.ts";

const DATABASE_URL =
  process.env["DATABASE_URL"] ??
  "postgresql://vision:vision_local_dev_only@127.0.0.1:5432/vision_dev";

const ORIGIN = { lon: 75.57, lat: 17.77 };

let client: pg.Client;
let jurisdictionId: string;
const issues: string[] = [];
const participants: string[] = [];
const submissions: string[] = [];
const evidence: string[] = [];
/** Jurisdictions created inside a test, torn down after the issues that reference them. */
const extraJurisdictions: string[] = [];
const decisions: string[] = [];
const responsibilities: string[] = [];

const reviewer = (): Principal => ({
  role: "reviewer",
  staffId: randomUUID() as never,
  jurisdictionScope: [jurisdictionId],
  sessionId: randomUUID() as never,
});

const report = (overrides: Partial<TrustSignalReport> = {}): TrustSignalReport => ({
  checks: [
    {
      signal: "capture_consistency",
      verdict: "consistent",
      reason: "the capture time is within the permitted window",
      doesNotEstablish: [],
      inputIsFixture: false,
    },
  ],
  requiresReview: false,
  reviewReasons: [],
  anyInputIsFixture: false,
  claimsNotEstablished: [
    "that the reporter was dishonest, or that any part of the report is false",
  ],
  calibratedScore: undefined,
  ...overrides,
});

/** A report with one inconsistent check, which is the only thing that flags one. */
const flaggedReport = (): TrustSignalReport =>
  report({
    requiresReview: true,
    checks: [
      {
        signal: "capture_consistency",
        verdict: "inconsistent",
        reason: "the stated capture time is after the report was received",
        doesNotEstablish: [],
        inputIsFixture: false,
      },
    ],
  });

before(async () => {
  client = new pg.Client({ connectionString: DATABASE_URL, statement_timeout: 15_000 });
  await client.connect();
  jurisdictionId = randomUUID();
  await client.query(
    `insert into jurisdiction
       (jurisdiction_id, jurisdiction_profile_id, internal_code, directory_version,
        level_scheme, level_code, effective_from, synthetic_provenance)
     values ($1,'demo-district-a',$2,'demo-routing.v1','test-scheme','district',
             now() - interval '1 year', true)`,
    [jurisdictionId, `pp-${jurisdictionId.slice(0, 8)}`],
  );
});

after(async () => {
  await client.end().catch(() => undefined);
  const cleaner = new pg.Client({ connectionString: DATABASE_URL, statement_timeout: 10_000 });
  await cleaner.connect();
  try {
    if (decisions.length > 0) {
      // A decision references evidence_item, and both proposal tables
      // reference the decision, so this whole chain is unwound before the
      // evidence rows go.
      await cleaner.query(
        "update trust_signal_report set reviewed_at = null, review_decision_id = null where review_decision_id = any($1::uuid[])",
        [decisions],
      );
      await cleaner.query(
        "update classification_proposal set reviewed_at = null, review_decision_id = null where review_decision_id = any($1::uuid[])",
        [decisions],
      );
      await cleaner.query("delete from review_decision where decision_id = any($1::uuid[])", [
        decisions,
      ]);
    }
    if (submissions.length > 0) {
      await cleaner.query("delete from trust_signal_report where submission_id = any($1::uuid[])", [
        submissions,
      ]);
      await cleaner.query(
        "delete from classification_proposal where submission_id = any($1::uuid[])",
        [submissions],
      );
      await cleaner.query("delete from issue_evidence_link where evidence_id = any($1::uuid[])", [
        evidence,
      ]);
      await cleaner.query("delete from evidence_item where submission_id = any($1::uuid[])", [
        submissions,
      ]);
      await cleaner.query("delete from submission where submission_id = any($1::uuid[])", [
        submissions,
      ]);
    }
    if (issues.length > 0) {
      // Accepting a classification now re-routes, so these exist.
      await cleaner.query("delete from routing_decision where issue_id = any($1::uuid[])", [
        issues,
      ]);
      await cleaner.query("delete from status_event where aggregate_id = any($1::text[])", [
        issues,
      ]);
      await cleaner.query("delete from canonical_issue where issue_id = any($1::uuid[])", [issues]);
    }
    if (participants.length > 0) {
      await cleaner.query("delete from participant where participant_id = any($1::uuid[])", [
        participants,
      ]);
    }
    if (responsibilities.length > 0) {
      await cleaner.query(
        "delete from responsibility_directory where responsibility_id = any($1::uuid[])",
        [responsibilities],
      );
    }
    await cleaner.query("delete from jurisdiction where jurisdiction_id = any($1::uuid[])", [
      [jurisdictionId, ...extraJurisdictions],
    ]);
  } finally {
    await cleaner.end();
  }
});

const newIssue = async (): Promise<string> => {
  const issueId = randomUUID();
  await client.query(
    `insert into canonical_issue
       (issue_id, public_reference, category, current_status, opened_at,
        representative_location, last_evidence_at, jurisdiction_id)
     values ($1,$2,'sanitation','created', now() - interval '1 day',
             ST_SetSRID(ST_MakePoint($3,$4),4326)::geography, now(), $5)`,
    [issueId, `VIS-${issueId.slice(0, 8).toUpperCase()}`, ORIGIN.lon, ORIGIN.lat, jurisdictionId],
  );
  issues.push(issueId);
  return issueId;
};

const newSubmission = async (): Promise<string> => {
  const participantId = randomUUID();
  await client.query("insert into participant (participant_id) values ($1)", [participantId]);
  participants.push(participantId);
  const submissionId = randomUUID();
  await client.query(
    `insert into submission
       (submission_id, participant_id, observed_location, observed_accuracy_m,
        observed_location_source, observed_at, interface_locale, locale_pack_version,
        taxonomy_version, idempotency_key)
     values ($1,$2, ST_SetSRID(ST_MakePoint($3,$4),4326)::geography, 12,
             'device_geolocation', now(), 'en-IN','demo-locales.v1','demo-taxonomy.v1',$5)`,
    [submissionId, participantId, ORIGIN.lon, ORIGIN.lat, `pp-${submissionId}`],
  );
  submissions.push(submissionId);
  return submissionId;
};

/** Evidence attached to an issue, which is what makes it jurisdiction-scoped. */
const attachedEvidence = async (submissionId: string, issueId: string): Promise<string> => {
  const evidenceId = randomUUID();
  await client.query(
    `insert into evidence_item (evidence_id, submission_id, media_type, content_text)
     values ($1,$2,'text','The drain by the school gate is blocked.')`,
    [evidenceId, submissionId],
  );
  evidence.push(evidenceId);
  await client.query(
    `insert into issue_evidence_link
       (issue_evidence_link_id, canonical_issue_id, evidence_id, effective_from)
     values ($1,$2,$3, now())`,
    [randomUUID(), issueId, evidenceId],
  );
  return evidenceId;
};

// ---------------------------------------------------------------------------
// Trust reports are stored (V025)
// ---------------------------------------------------------------------------

test("V025: an evaluated report is stored so a reviewer can see the checks", async () => {
  const submissionId = await newSubmission();
  const issueId = await newIssue();

  const stored = await recordTrustSignalReport(client, {
    submissionId,
    canonicalIssueId: issueId,
    report: report(),
  });

  assert.equal(stored.requiresReview, false);
  const { rows } = await client.query(
    "select checks, requires_review from trust_signal_report where submission_id = $1",
    [submissionId],
  );
  assert.equal(rows.length, 1);
  assert.equal((rows[0]?.["checks"] as unknown[]).length, 1);
});

test("V025: recomputing replaces the standing report rather than accumulating", async () => {
  const submissionId = await newSubmission();
  const issueId = await newIssue();

  await recordTrustSignalReport(client, {
    submissionId,
    canonicalIssueId: issueId,
    report: report(),
  });
  await recordTrustSignalReport(client, {
    submissionId,
    canonicalIssueId: issueId,
    report: report({
      requiresReview: true,
      reviewReasons: ["the stated capture time is after the report was received"],
      checks: [
        {
          signal: "capture_consistency",
          verdict: "inconsistent",
          reason: "the stated capture time is after the report was received",
          doesNotEstablish: [],
          inputIsFixture: false,
        },
      ],
    }),
  });

  const { rows } = await client.query(
    "select requires_review from trust_signal_report where submission_id = $1",
    [submissionId],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.["requires_review"], true);
});

test("V025: a report whose every check is unknown is not flagged", async () => {
  // The rule V025 exists for: absence of metadata is not evidence of anything.
  // A stripped photograph is the ordinary case, not a suspicious one.
  const submissionId = await newSubmission();
  const issueId = await newIssue();

  const stored = await recordTrustSignalReport(client, {
    submissionId,
    canonicalIssueId: issueId,
    report: report({
      checks: [
        {
          signal: "capture_consistency",
          verdict: "unknown",
          reason: "the file carries no capture time",
          doesNotEstablish: [],
          inputIsFixture: false,
        },
        {
          signal: "timestamp_availability",
          verdict: "unknown",
          reason: "the file carries no metadata at all",
          doesNotEstablish: [],
          inputIsFixture: false,
        },
      ],
    }),
  });

  assert.equal(stored.requiresReview, false);
});

test("V025: a report claiming review with no inconsistent check is refused", async () => {
  // The flag is derived from the checks, not taken on trust. A caller that
  // passed `requiresReview: true` with nothing inconsistent behind it would be
  // flagging a report for no stated reason — which is how "unknown" quietly
  // becomes suspicion.
  const submissionId = await newSubmission();
  const issueId = await newIssue();

  await assert.rejects(
    () =>
      recordTrustSignalReport(client, {
        submissionId,
        canonicalIssueId: issueId,
        report: report({ requiresReview: true, reviewReasons: ["because"] }),
      }),
    /inconsistent/i,
  );
});

// ---------------------------------------------------------------------------
// Flagged evidence reaches the queue (V032)
// ---------------------------------------------------------------------------

test("V032: a flagged report appears in the review queue as flagged_evidence", async () => {
  const submissionId = await newSubmission();
  const issueId = await newIssue();
  await attachedEvidence(submissionId, issueId);
  await recordTrustSignalReport(client, {
    submissionId,
    canonicalIssueId: issueId,
    report: report({
      requiresReview: true,
      reviewReasons: ["the stated capture time is after the report was received"],
      checks: [
        {
          signal: "capture_consistency",
          verdict: "inconsistent",
          reason: "the stated capture time is after the report was received",
          doesNotEstablish: [],
          inputIsFixture: false,
        },
      ],
    }),
  });

  const queue = await listReviewQueue(client, { principal: reviewer(), jurisdictionId });
  // Scoped to this test's own submission: other tests in this file legitimately
  // leave flags in the same jurisdiction, and counting all of them would make
  // this pass or fail on test order.
  const flagged = queue.items.filter(
    (item) => item.kind === "flagged_evidence" && item.submissionId === submissionId,
  );

  assert.equal(flagged.length, 1);
  assert.match(flagged[0]?.reason ?? "", /capture time/i);
});

test("V032: the queue reason for a flag never implies dishonesty", async () => {
  const submissionId = await newSubmission();
  const issueId = await newIssue();
  await attachedEvidence(submissionId, issueId);
  await recordTrustSignalReport(client, {
    submissionId,
    canonicalIssueId: issueId,
    report: report({
      requiresReview: true,
      reviewReasons: ["the stated capture time is after the report was received"],
      checks: [
        {
          signal: "capture_consistency",
          verdict: "inconsistent",
          reason: "the stated capture time is after the report was received",
          doesNotEstablish: [],
          inputIsFixture: false,
        },
      ],
    }),
  });

  const queue = await listReviewQueue(client, { principal: reviewer(), jurisdictionId });
  const flagged = queue.items.find(
    (item) => item.kind === "flagged_evidence" && item.submissionId === submissionId,
  );
  const reason = flagged?.reason ?? "";
  assert.ok(flagged !== undefined);

  assert.doesNotMatch(reason, /fraud|fake|dishonest|false|lying|suspicious/i);
  // And it says what the flag is for: a person looking, not a conclusion.
  assert.match(reason, /a person|review|look/i);
});

test("V032: an unflagged report does not appear in the queue", async () => {
  const submissionId = await newSubmission();
  const issueId = await newIssue();
  await attachedEvidence(submissionId, issueId);
  await recordTrustSignalReport(client, {
    submissionId,
    canonicalIssueId: issueId,
    report: report(),
  });

  const queue = await listReviewQueue(client, { principal: reviewer(), jurisdictionId });
  assert.equal(queue.items.filter((item) => item.submissionId === submissionId).length, 0);
});

test("V032: a flag in another jurisdiction is not shown", async () => {
  // Every review action is jurisdiction-scoped (V015). A flag visible outside
  // its jurisdiction would be evidence disclosed to someone with no power over
  // it.
  const otherJurisdiction = randomUUID();
  await client.query(
    `insert into jurisdiction
       (jurisdiction_id, jurisdiction_profile_id, internal_code, directory_version,
        level_scheme, level_code, effective_from, synthetic_provenance)
     values ($1,'demo-district-a',$2,'demo-routing.v1','test-scheme','district',
             now() - interval '1 year', true)`,
    [otherJurisdiction, `pp-${otherJurisdiction.slice(0, 8)}`],
  );
  const issueId = randomUUID();
  await client.query(
    `insert into canonical_issue
       (issue_id, public_reference, category, current_status, opened_at,
        representative_location, last_evidence_at, jurisdiction_id)
     values ($1,$2,'sanitation','created', now() - interval '1 day',
             ST_SetSRID(ST_MakePoint($3,$4),4326)::geography, now(), $5)`,
    [
      issueId,
      `VIS-${issueId.slice(0, 8).toUpperCase()}`,
      ORIGIN.lon,
      ORIGIN.lat,
      otherJurisdiction,
    ],
  );
  issues.push(issueId);
  const submissionId = await newSubmission();
  await attachedEvidence(submissionId, issueId);
  await recordTrustSignalReport(client, {
    submissionId,
    canonicalIssueId: issueId,
    report: report({
      requiresReview: true,
      reviewReasons: ["the stated capture time is after the report was received"],
      checks: [
        {
          signal: "capture_consistency",
          verdict: "inconsistent",
          reason: "the stated capture time is after the report was received",
          doesNotEstablish: [],
          inputIsFixture: false,
        },
      ],
    }),
  });

  const queue = await listReviewQueue(client, { principal: reviewer(), jurisdictionId });
  assert.equal(queue.items.filter((item) => item.submissionId === submissionId).length, 0);

  // The issue references this jurisdiction, so the shared cleanup (which
  // deletes issues before jurisdictions) has to do the ordering. Deleting the
  // jurisdiction here would violate the foreign key.
  extraJurisdictions.push(otherJurisdiction);
});

// ---------------------------------------------------------------------------
// Classification proposals are stored (V023)
// ---------------------------------------------------------------------------

test("V023: a proposal is stored beside the evidence, never written into it", async () => {
  const submissionId = await newSubmission();
  const issueId = await newIssue();
  const evidenceId = await attachedEvidence(submissionId, issueId);

  await recordClassificationProposal(client, {
    submissionId,
    evidenceId,
    proposal: {
      taxonomy_version: "demo-taxonomy.v1",
      proposed_category_id: "sanitation",
      proposed_defect_id: "blockage",
      certainty_band: "low",
      requires_review: true,
      model_name: "google-gemini:gemini-3.6-flash",
      prompt_version: "classify.v1",
      input_hash: "a".repeat(64),
    },
  });

  const { rows } = await client.query(
    "select certainty_band, requires_review from classification_proposal where submission_id = $1",
    [submissionId],
  );
  assert.equal(rows[0]?.["certainty_band"], "low");
  assert.equal(rows[0]?.["requires_review"], true);
  // The evidence row itself is untouched: a proposal is advice, not a fact
  // about the evidence.
  const { rows: ev } = await client.query(
    "select content_text from evidence_item where evidence_id = $1",
    [evidenceId],
  );
  assert.match(String(ev[0]?.["content_text"]), /drain by the school gate/);
});

test("V023: an uncertain proposal is listed as pending review", async () => {
  const submissionId = await newSubmission();
  const issueId = await newIssue();
  const evidenceId = await attachedEvidence(submissionId, issueId);
  await recordClassificationProposal(client, {
    submissionId,
    evidenceId,
    proposal: {
      taxonomy_version: "demo-taxonomy.v1",
      proposed_category_id: "sanitation",
      certainty_band: "medium",
      requires_review: true,
      model_name: "google-gemini:gemini-3.6-flash",
      prompt_version: "classify.v1",
      input_hash: "b".repeat(64),
    },
  });

  const pending = await pendingClassificationProposals(client, { jurisdictionId });
  const mine = pending.find((p) => p.submissionId === submissionId);

  assert.ok(mine !== undefined);
  assert.equal(mine.certaintyBand, "medium");
  assert.equal(mine.proposedCategoryId, "sanitation");
});

test("V023: a stored proposal carries no numeric confidence of any kind", async () => {
  // V002 prohibition 9. The column does not exist, and this is the test that
  // stops one being added and populated: a number here would be presented as
  // calibrated when nothing has been calibrated (V046).
  const { rows } = await client.query(
    `select column_name, data_type from information_schema.columns
      where table_name = 'classification_proposal'`,
  );
  const numericColumns = rows
    .filter((row) =>
      ["numeric", "real", "double precision", "integer", "bigint"].includes(
        String(row["data_type"]),
      ),
    )
    .map((row) => String(row["column_name"]));

  assert.deepEqual(numericColumns, []);
});

test("V023: a high-certainty proposal is not put in front of a reviewer", async () => {
  // Sending everything to review makes the queue useless, which is its own way
  // of losing the uncertain ones.
  const submissionId = await newSubmission();
  const issueId = await newIssue();
  const evidenceId = await attachedEvidence(submissionId, issueId);
  await recordClassificationProposal(client, {
    submissionId,
    evidenceId,
    proposal: {
      taxonomy_version: "demo-taxonomy.v1",
      proposed_category_id: "sanitation",
      certainty_band: "high",
      requires_review: false,
      model_name: "google-gemini:gemini-3.6-flash",
      prompt_version: "classify.v1",
      input_hash: "c".repeat(64),
    },
  });

  const pending = await pendingClassificationProposals(client, { jurisdictionId });
  assert.equal(pending.filter((p) => p.submissionId === submissionId).length, 0);
});

test("V023: a proposal claiming certainty it did not earn is refused", async () => {
  // `requires_review` is derived from the band, not supplied independently: a
  // caller that passed `high` with `requires_review: false` for a low-band
  // answer would route an uncertain guess straight past review.
  const submissionId = await newSubmission();
  const issueId = await newIssue();
  const evidenceId = await attachedEvidence(submissionId, issueId);

  await assert.rejects(
    () =>
      recordClassificationProposal(client, {
        submissionId,
        evidenceId,
        proposal: {
          taxonomy_version: "demo-taxonomy.v1",
          proposed_category_id: "sanitation",
          certainty_band: "low",
          requires_review: false,
          model_name: "google-gemini:gemini-3.6-flash",
          prompt_version: "classify.v1",
          input_hash: "d".repeat(64),
        },
      }),
    /requires_review|certainty/i,
  );
});

// ---------------------------------------------------------------------------
// The states a review moves things through
// ---------------------------------------------------------------------------

/** A decision row, so `reviewed_at` can be set (the table requires both or neither). */
const decisionOn = async (options: {
  readonly evidenceId?: string;
  readonly issueId?: string;
  readonly action: string;
}): Promise<string> => {
  const decisionId = randomUUID();
  await client.query(
    `insert into review_decision
       (decision_id, evidence_id, canonical_issue_id, action, reason, reviewer_id,
        prior_state, resulting_state)
     values ($1,$2,$3,$4,'because a person looked at it',$5,'{}'::jsonb,'{}'::jsonb)`,
    [decisionId, options.evidenceId ?? null, options.issueId ?? null, options.action, randomUUID()],
  );
  decisions.push(decisionId);
  return decisionId;
};

test("V025: a report with an inconsistent check may not be stored as unremarkable", async () => {
  // The other half of the derivation guard. A caller passing `requiresReview:
  // false` over an inconsistent check would bury a real discrepancy, which is
  // the opposite failure to flagging an unknown one — and needs its own test,
  // because one check enforces both directions.
  const submissionId = await newSubmission();
  const issueId = await newIssue();

  await assert.rejects(
    () =>
      recordTrustSignalReport(client, {
        submissionId,
        canonicalIssueId: issueId,
        report: report({
          requiresReview: false,
          checks: [
            {
              signal: "capture_consistency",
              verdict: "inconsistent",
              reason: "the stated capture time is after the report was received",
              doesNotEstablish: [],
              inputIsFixture: false,
            },
          ],
        }),
      }),
    /must require review/i,
  );
});

test("V025: recomputing a reviewed report puts it back in front of a person", async () => {
  // A replaced report is a fresh question. Carrying the old review forward
  // would let new evidence of an inconsistency be silently pre-dismissed.
  const submissionId = await newSubmission();
  const issueId = await newIssue();
  const evidenceId = await attachedEvidence(submissionId, issueId);
  const flagged = report({
    requiresReview: true,
    checks: [
      {
        signal: "capture_consistency",
        verdict: "inconsistent",
        reason: "the stated capture time is after the report was received",
        doesNotEstablish: [],
        inputIsFixture: false,
      },
    ],
  });

  await recordTrustSignalReport(client, {
    submissionId,
    canonicalIssueId: issueId,
    report: flagged,
  });
  const decisionId = await decisionOn({ evidenceId, action: "dismiss_trust_flag" });
  await client.query(
    "update trust_signal_report set reviewed_at = now(), review_decision_id = $2 where submission_id = $1",
    [submissionId, decisionId],
  );
  // Confirms the dismissal took it off the queue, so the next assertion is
  // about the recompute and not about the flag never having been there.
  const dismissed = await listReviewQueue(client, { principal: reviewer(), jurisdictionId });
  assert.equal(dismissed.items.filter((i) => i.submissionId === submissionId).length, 0);

  await recordTrustSignalReport(client, {
    submissionId,
    canonicalIssueId: issueId,
    report: flagged,
  });

  const { rows } = await client.query(
    "select reviewed_at, review_decision_id from trust_signal_report where submission_id = $1",
    [submissionId],
  );
  assert.equal(rows[0]?.["reviewed_at"], null);
  assert.equal(rows[0]?.["review_decision_id"], null);
  const queue = await listReviewQueue(client, { principal: reviewer(), jurisdictionId });
  assert.equal(
    queue.items.filter((i) => i.kind === "flagged_evidence" && i.submissionId === submissionId)
      .length,
    1,
  );
});

test("V023: a reviewed proposal stops being pending", async () => {
  const submissionId = await newSubmission();
  const issueId = await newIssue();
  const evidenceId = await attachedEvidence(submissionId, issueId);
  await recordClassificationProposal(client, {
    submissionId,
    evidenceId,
    proposal: {
      taxonomy_version: "demo-taxonomy.v1",
      proposed_category_id: "sanitation",
      certainty_band: "low",
      requires_review: true,
      model_name: "google-gemini:gemini-3.6-flash",
      prompt_version: "classify.v1",
      input_hash: "e".repeat(64),
    },
  });
  assert.equal(
    (await pendingClassificationProposals(client, { jurisdictionId })).filter(
      (p) => p.submissionId === submissionId,
    ).length,
    1,
  );

  const decisionId = await decisionOn({ evidenceId, action: "accept_classification" });
  await client.query(
    "update classification_proposal set reviewed_at = now(), review_decision_id = $2 where submission_id = $1",
    [submissionId, decisionId],
  );

  const pending = await pendingClassificationProposals(client, { jurisdictionId });
  assert.equal(pending.filter((p) => p.submissionId === submissionId).length, 0);
  const queue = await listReviewQueue(client, { principal: reviewer(), jurisdictionId });
  assert.equal(
    queue.items.filter(
      (i) => i.kind === "uncertain_classification" && i.submissionId === submissionId,
    ).length,
    0,
  );
});

test("V032: an unknown check's reason is not quoted as part of the case for a flag", async () => {
  // "The file carries no capture time" read alongside a flag looks like part
  // of the reason for it. It is not one (V025), so only the inconsistent
  // checks' own words appear.
  const submissionId = await newSubmission();
  const issueId = await newIssue();
  await attachedEvidence(submissionId, issueId);
  await recordTrustSignalReport(client, {
    submissionId,
    canonicalIssueId: issueId,
    report: report({
      requiresReview: true,
      checks: [
        {
          signal: "capture_consistency",
          verdict: "inconsistent",
          reason: "the stated capture time is after the report was received",
          doesNotEstablish: [],
          inputIsFixture: false,
        },
        {
          signal: "timestamp_availability",
          verdict: "unknown",
          reason: "the file carries no capture time at all",
          doesNotEstablish: [],
          inputIsFixture: false,
        },
      ],
    }),
  });

  const queue = await listReviewQueue(client, { principal: reviewer(), jurisdictionId });
  const flagged = queue.items.find(
    (item) => item.kind === "flagged_evidence" && item.submissionId === submissionId,
  );

  assert.ok(flagged !== undefined);
  assert.match(flagged.reason, /after the report was received/);
  assert.doesNotMatch(flagged.reason, /no capture time at all/);
});

// ---------------------------------------------------------------------------
// Deciding on a flag or a proposal (V032)
// ---------------------------------------------------------------------------

test("V032: dismissing a flag records a decision and takes it off the queue", async () => {
  // A dismissal is a decision with a stated reason, not a silent clearing: the
  // flag existed, somebody looked, and that has to remain visible.
  const submissionId = await newSubmission();
  const issueId = await newIssue();
  const evidenceId = await attachedEvidence(submissionId, issueId);
  await recordTrustSignalReport(client, {
    submissionId,
    canonicalIssueId: issueId,
    report: report({
      requiresReview: true,
      checks: [
        {
          signal: "capture_consistency",
          verdict: "inconsistent",
          reason: "the stated capture time is after the report was received",
          doesNotEstablish: [],
          inputIsFixture: false,
        },
      ],
    }),
  });

  const decided = await decideReview(client, {
    principal: reviewer(),
    action: "dismiss_trust_flag",
    reason: "the device clock was wrong; the photograph matches the reported location",
    evidenceId,
  });
  decisions.push(decided.decisionId);

  const queue = await listReviewQueue(client, { principal: reviewer(), jurisdictionId });
  assert.equal(
    queue.items.filter((i) => i.kind === "flagged_evidence" && i.submissionId === submissionId)
      .length,
    0,
  );
  const { rows } = await client.query(
    "select action, reason from review_decision where decision_id = $1",
    [decided.decisionId],
  );
  assert.equal(rows[0]?.["action"], "dismiss_trust_flag");
  assert.match(String(rows[0]?.["reason"]), /device clock/);
});

test("V032: a dismissal does not alter the evidence or its processing state", async () => {
  // Dismissing a flag says the discrepancy was explained. It is not an
  // approval of the photograph for publication, and it must not quietly become
  // one.
  const submissionId = await newSubmission();
  const issueId = await newIssue();
  const evidenceId = await attachedEvidence(submissionId, issueId);
  await recordTrustSignalReport(client, {
    submissionId,
    canonicalIssueId: issueId,
    report: report({
      requiresReview: true,
      checks: [
        {
          signal: "capture_consistency",
          verdict: "inconsistent",
          reason: "the stated capture time is after the report was received",
          doesNotEstablish: [],
          inputIsFixture: false,
        },
      ],
    }),
  });
  const { rows: before } = await client.query(
    "select redaction_status, processing_status from evidence_item where evidence_id = $1",
    [evidenceId],
  );

  const decided = await decideReview(client, {
    principal: reviewer(),
    action: "dismiss_trust_flag",
    reason: "the device clock was wrong",
    evidenceId,
  });
  decisions.push(decided.decisionId);

  const { rows: after } = await client.query(
    "select redaction_status, processing_status from evidence_item where evidence_id = $1",
    [evidenceId],
  );
  assert.equal(after[0]?.["redaction_status"], before[0]?.["redaction_status"]);
  assert.equal(after[0]?.["processing_status"], before[0]?.["processing_status"]);
});

test("V032: accepting a classification records it and stops it being pending", async () => {
  const submissionId = await newSubmission();
  const issueId = await newIssue();
  const evidenceId = await attachedEvidence(submissionId, issueId);
  await recordClassificationProposal(client, {
    submissionId,
    evidenceId,
    proposal: {
      taxonomy_version: "demo-taxonomy.v1",
      proposed_category_id: "sanitation",
      certainty_band: "low",
      requires_review: true,
      model_name: "google-gemini:gemini-3.6-flash",
      prompt_version: "classify.v1",
      input_hash: "f".repeat(64),
    },
  });

  const decided = await decideReview(client, {
    principal: reviewer(),
    action: "accept_classification",
    reason: "the photograph shows a blocked drain, so sanitation is right",
    evidenceId,
  });
  decisions.push(decided.decisionId);

  const pending = await pendingClassificationProposals(client, { jurisdictionId });
  assert.equal(pending.filter((p) => p.submissionId === submissionId).length, 0);
  assert.equal(decided.resultingState["reviewed"], true);
});

test("V032: rejecting a classification does not write the category onto the issue", async () => {
  // A rejected proposal leaves the issue's category alone. Writing a category
  // from a rejected proposal is the exact confusion between advice and
  // decision that keeping proposals in their own table exists to prevent.
  const submissionId = await newSubmission();
  const issueId = await newIssue();
  const evidenceId = await attachedEvidence(submissionId, issueId);
  await recordClassificationProposal(client, {
    submissionId,
    evidenceId,
    proposal: {
      taxonomy_version: "demo-taxonomy.v1",
      proposed_category_id: "electrical",
      certainty_band: "low",
      requires_review: true,
      model_name: "google-gemini:gemini-3.6-flash",
      prompt_version: "classify.v1",
      input_hash: "1".repeat(64),
    },
  });

  const decided = await decideReview(client, {
    principal: reviewer(),
    action: "reject_classification",
    reason: "this is a drain, not an electrical fault",
    evidenceId,
  });
  decisions.push(decided.decisionId);

  const { rows } = await client.query("select category from canonical_issue where issue_id = $1", [
    issueId,
  ]);
  assert.equal(rows[0]?.["category"], "sanitation");
});

test("V032: a role with no evidence power may not dismiss a flag", async () => {
  // V015 gives the administrator configuration and audit powers and
  // deliberately no evidence access at all.
  const submissionId = await newSubmission();
  const issueId = await newIssue();
  const evidenceId = await attachedEvidence(submissionId, issueId);
  await recordTrustSignalReport(client, {
    submissionId,
    canonicalIssueId: issueId,
    report: report({
      requiresReview: true,
      checks: [
        {
          signal: "capture_consistency",
          verdict: "inconsistent",
          reason: "the stated capture time is after the report was received",
          doesNotEstablish: [],
          inputIsFixture: false,
        },
      ],
    }),
  });

  await assert.rejects(
    () =>
      decideReview(client, {
        principal: {
          role: "administrator",
          staffId: randomUUID() as never,
          jurisdictionScope: [jurisdictionId],
          sessionId: randomUUID() as never,
        },
        action: "dismiss_trust_flag",
        reason: "tidying the queue",
        evidenceId,
      }),
    /may not dismiss_trust_flag/,
  );
});

test("V032: department staff may read private issues but may not dismiss a flag", async () => {
  // A sharper test than refusing an administrator: `department_staff` *has*
  // `issue.read_private`, so this distinguishes "needs the evidence power"
  // from "needs any private access at all". Deciding a flag is an evidence
  // decision, and staff who do the work are not the people who judge it.
  const submissionId = await newSubmission();
  const issueId = await newIssue();
  const evidenceId = await attachedEvidence(submissionId, issueId);
  await recordTrustSignalReport(client, {
    submissionId,
    canonicalIssueId: issueId,
    report: flaggedReport(),
  });

  await assert.rejects(
    () =>
      decideReview(client, {
        principal: {
          role: "department_staff",
          staffId: randomUUID() as never,
          jurisdictionScope: [jurisdictionId],
          sessionId: randomUUID() as never,
        },
        action: "dismiss_trust_flag",
        reason: "we already know about this one",
        evidenceId,
      }),
    /may not dismiss_trust_flag/,
  );
});

test("V032: the same flag cannot be dismissed twice", async () => {
  // Two dismissals of one flag would write two audit rows for one judgement,
  // and the second would overwrite which decision the report points at — so
  // the record would no longer name the person who actually decided.
  const submissionId = await newSubmission();
  const issueId = await newIssue();
  const evidenceId = await attachedEvidence(submissionId, issueId);
  await recordTrustSignalReport(client, {
    submissionId,
    canonicalIssueId: issueId,
    report: flaggedReport(),
  });

  const first = await decideReview(client, {
    principal: reviewer(),
    action: "dismiss_trust_flag",
    reason: "the device clock was wrong",
    evidenceId,
  });
  decisions.push(first.decisionId);

  await assert.rejects(
    () =>
      decideReview(client, {
        principal: reviewer(),
        action: "dismiss_trust_flag",
        reason: "dismissing it again",
        evidenceId,
      }),
    /already been decided/,
  );
  const { rows } = await client.query(
    "select review_decision_id from trust_signal_report where submission_id = $1",
    [submissionId],
  );
  assert.equal(rows[0]?.["review_decision_id"], first.decisionId);
});

test("V032: a proposal that is not awaiting review cannot be decided", async () => {
  // Two ways to reach this: a high-certainty proposal that was never queued,
  // and one already decided. Both must be refused, because a decision on
  // something nobody was asked about is an audit row with no question behind
  // it.
  const submissionId = await newSubmission();
  const issueId = await newIssue();
  const evidenceId = await attachedEvidence(submissionId, issueId);
  await recordClassificationProposal(client, {
    submissionId,
    evidenceId,
    proposal: {
      taxonomy_version: "demo-taxonomy.v1",
      proposed_category_id: "sanitation",
      certainty_band: "high",
      requires_review: false,
      model_name: "google-gemini:gemini-3.6-flash",
      prompt_version: "classify.v1",
      input_hash: "2".repeat(64),
    },
  });

  await assert.rejects(
    () =>
      decideReview(client, {
        principal: reviewer(),
        action: "accept_classification",
        reason: "agreeing with something nobody asked about",
        evidenceId,
      }),
    /no proposal is awaiting review/,
  );
});

test("V032: a proposal already decided cannot be decided again", async () => {
  const submissionId = await newSubmission();
  const issueId = await newIssue();
  const evidenceId = await attachedEvidence(submissionId, issueId);
  await recordClassificationProposal(client, {
    submissionId,
    evidenceId,
    proposal: {
      taxonomy_version: "demo-taxonomy.v1",
      proposed_category_id: "sanitation",
      certainty_band: "low",
      requires_review: true,
      model_name: "google-gemini:gemini-3.6-flash",
      prompt_version: "classify.v1",
      input_hash: "3".repeat(64),
    },
  });

  const first = await decideReview(client, {
    principal: reviewer(),
    action: "accept_classification",
    reason: "the photograph shows a blocked drain",
    evidenceId,
  });
  decisions.push(first.decisionId);

  await assert.rejects(
    () =>
      decideReview(client, {
        principal: reviewer(),
        action: "reject_classification",
        reason: "changing my mind without a record of why",
        evidenceId,
      }),
    /no proposal is awaiting review/,
  );
});

test("V032: accepting a classification applies it to the issue", async () => {
  // The defect this closes: accepting recorded the reviewer's agreement and
  // changed nothing else, so a reviewer could work through the whole queue and
  // the issues would keep the fallback category they were opened with.
  const submissionId = await newSubmission();
  const issueId = await newIssue();
  const evidenceId = await attachedEvidence(submissionId, issueId);
  await recordClassificationProposal(client, {
    submissionId,
    evidenceId,
    proposal: {
      taxonomy_version: "demo-taxonomy.v1",
      proposed_category_id: "water_supply",
      certainty_band: "low",
      requires_review: true,
      model_name: "google-gemini:gemini-3.6-flash",
      prompt_version: "classify.v1",
      input_hash: "7".repeat(64),
    },
  });

  const decided = await decideReview(client, {
    principal: reviewer(),
    action: "accept_classification",
    reason: "the photograph shows a burst pipe, not a drain",
    evidenceId,
  });
  decisions.push(decided.decisionId);

  const { rows } = await client.query("select category from canonical_issue where issue_id = $1", [
    issueId,
  ]);
  assert.equal(rows[0]?.["category"], "water_supply");
  assert.equal(decided.priorState["issue_category"], "sanitation");
  assert.equal(decided.resultingState["issue_category"], "water_supply");
});

test("V032: a category change re-resolves who owns the issue", async () => {
  // Ownership is looked up by category, so changing the category without
  // re-routing would leave the issue routed to the department responsible for
  // the category it no longer has.
  const submissionId = await newSubmission();
  const issueId = await newIssue();
  const evidenceId = await attachedEvidence(submissionId, issueId);
  for (const [category, department] of [
    ["sanitation", "demo-sanitation"],
    ["water_supply", "demo-water"],
  ] as const) {
    const responsibilityId = randomUUID();
    await client.query(
      `insert into responsibility_directory
         (responsibility_id, directory_version, jurisdiction_id, category,
          department_id, department_label, provider_mode, effective_from)
       values ($1,'demo-routing.v1',$2,$3,$4,$5,'simulated', now())`,
      [responsibilityId, jurisdictionId, category, department, `${department} (simulated)`],
    );
    responsibilities.push(responsibilityId);
  }
  await resolveRouting(client, { issueId, directoryVersion: "demo-routing.v1" });

  await recordClassificationProposal(client, {
    submissionId,
    evidenceId,
    proposal: {
      taxonomy_version: "demo-taxonomy.v1",
      proposed_category_id: "water_supply",
      certainty_band: "low",
      requires_review: true,
      model_name: "google-gemini:gemini-3.6-flash",
      prompt_version: "classify.v1",
      input_hash: "8".repeat(64),
    },
  });
  const decided = await decideReview(client, {
    principal: reviewer(),
    action: "accept_classification",
    reason: "this is a water supply fault",
    evidenceId,
  });
  decisions.push(decided.decisionId);

  const { rows } = await client.query(
    "select category, department_id from routing_decision where issue_id = $1 order by decided_at asc",
    [issueId],
  );
  assert.equal(rows.length, 2, "the re-route is recorded as a new decision, not an edit");
  // The first decision keeps the category it was actually made under, so why
  // the original route was chosen stays readable.
  assert.equal(rows[0]?.["category"], "sanitation");
  assert.equal(rows[0]?.["department_id"], "demo-sanitation");
  assert.equal(rows[1]?.["category"], "water_supply");
  assert.equal(rows[1]?.["department_id"], "demo-water");
});

test("V032: rejecting a classification leaves the category and the routing alone", async () => {
  const submissionId = await newSubmission();
  const issueId = await newIssue();
  const evidenceId = await attachedEvidence(submissionId, issueId);
  await recordClassificationProposal(client, {
    submissionId,
    evidenceId,
    proposal: {
      taxonomy_version: "demo-taxonomy.v1",
      proposed_category_id: "electrical",
      certainty_band: "low",
      requires_review: true,
      model_name: "google-gemini:gemini-3.6-flash",
      prompt_version: "classify.v1",
      input_hash: "9".repeat(64),
    },
  });

  const decided = await decideReview(client, {
    principal: reviewer(),
    action: "reject_classification",
    reason: "this is a drain, not an electrical fault",
    evidenceId,
  });
  decisions.push(decided.decisionId);

  const { rows } = await client.query("select category from canonical_issue where issue_id = $1", [
    issueId,
  ]);
  assert.equal(rows[0]?.["category"], "sanitation");
  // And the audit row says so too. Reporting the rejected category as the
  // issue's would leave a record claiming a change that never happened —
  // worse than no record, because it reads as authoritative.
  assert.equal(decided.resultingState["issue_category"], "sanitation");
  assert.equal(decided.resultingState["accepted"], false);
  const { rows: routes } = await client.query(
    "select count(*)::int as n from routing_decision where issue_id = $1",
    [issueId],
  );
  assert.equal(routes[0]?.["n"], 0);
});

test("V032: accepting a category the taxonomy no longer routes is still recorded, and says so", async () => {
  // A reviewer agreeing with a proposal must not fail because no department
  // owns that category — the agreement is a fact about the report, and the
  // missing owner is an operational gap to surface rather than a reason to
  // refuse the reviewer's decision.
  const submissionId = await newSubmission();
  const issueId = await newIssue();
  const evidenceId = await attachedEvidence(submissionId, issueId);
  await recordClassificationProposal(client, {
    submissionId,
    evidenceId,
    proposal: {
      taxonomy_version: "demo-taxonomy.v1",
      proposed_category_id: "structural",
      certainty_band: "medium",
      requires_review: true,
      model_name: "google-gemini:gemini-3.6-flash",
      prompt_version: "classify.v1",
      input_hash: "a".repeat(63) + "b",
    },
  });

  const decided = await decideReview(client, {
    principal: reviewer(),
    action: "accept_classification",
    reason: "the wall is cracked",
    evidenceId,
  });
  decisions.push(decided.decisionId);

  assert.equal(decided.resultingState["issue_category"], "structural");
  assert.match(String(decided.resultingState["routing_outcome"]), /no_directory_entry/);
});
