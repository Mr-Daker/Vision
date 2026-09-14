/**
 * Evidence and matching review queue (roadmap V032).
 *
 * Run with: npm run db:up && npm run db:migrate && npm run test:db
 *
 * A reviewer is the first person in this system with power over someone else's
 * report, so every decision here must carry a reason, an author, and the state
 * it replaced. A public display may change afterwards — that is the point of
 * review — but the history behind it is never erased.
 *
 * The permission model is V015's. Note the constraint this runs under: no
 * staff or reviewer can authenticate yet (V057 supplies that), so these
 * services take a principal directly and the HTTP layer's job is to refuse
 * citizens.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

import type { Principal } from "@vision/domain";

import { listReviewQueue, decideReview, ReviewError } from "./review-queue.ts";

const DATABASE_URL =
  process.env["DATABASE_URL"] ??
  "postgresql://vision:vision_local_dev_only@127.0.0.1:5432/vision_dev";

let client: pg.Client;
let jurisdictionId: string;
const issues: string[] = [];
const submissions: string[] = [];
const participants: string[] = [];
const decisions: string[] = [];
const extraJurisdictions: string[] = [];

const ORIGIN = { lon: 75.21, lat: 17.41 };

/** A reviewer scoped to the test jurisdiction. Review powers exist only there. */
const reviewer = (): Principal => ({
  role: "reviewer",
  staffId: randomUUID() as never,
  jurisdictionScope: [jurisdictionId],
  sessionId: randomUUID() as never,
});

/** A reviewer with no scope, to prove the scope is load-bearing. */
const outOfScopeReviewer = (): Principal => ({
  role: "reviewer",
  staffId: randomUUID() as never,
  jurisdictionScope: [randomUUID()],
  sessionId: randomUUID() as never,
});

const administrator = (): Principal => ({
  role: "administrator",
  staffId: randomUUID() as never,
  jurisdictionScope: [],
  sessionId: randomUUID() as never,
});

const citizen = (participantId: string): Principal => ({
  role: "citizen",
  participantId: participantId as never,
  jurisdictionScope: [],
  sessionId: randomUUID() as never,
});

before(async () => {
  client = new pg.Client({ connectionString: DATABASE_URL, statement_timeout: 15_000 });
  await client.connect();
  jurisdictionId = randomUUID();
  await client.query(
    `insert into jurisdiction
       (jurisdiction_id, jurisdiction_profile_id, internal_code, directory_version,
        level_scheme, level_code, effective_from, synthetic_provenance)
     values ($1,'test-profile',$2,'test-directory.v1','test-scheme','district',
             now() - interval '1 year', true)`,
    [jurisdictionId, `code-${jurisdictionId.slice(0, 8)}`],
  );
});

after(async () => {
  await client.end().catch(() => undefined);
  const cleaner = new pg.Client({ connectionString: DATABASE_URL, statement_timeout: 10_000 });
  await cleaner.connect();
  try {
    if (submissions.length > 0) {
      await cleaner.query(
        "delete from review_decision where evidence_id in (select evidence_id from evidence_item where submission_id = any($1::uuid[])) or match_id in (select match_id from issue_match where submission_id = any($1::uuid[])) or correction_request_id in (select request_id from correction_request where submission_id = any($1::uuid[]))",
        [submissions],
      );
      await cleaner.query("delete from correction_request where submission_id = any($1::uuid[])", [
        submissions,
      ]);
      await cleaner.query(
        "delete from issue_evidence_link where evidence_id in (select evidence_id from evidence_item where submission_id = any($1::uuid[]))",
        [submissions],
      );
      await cleaner.query("delete from issue_match where submission_id = any($1::uuid[])", [
        submissions,
      ]);
      await cleaner.query("delete from evidence_item where submission_id = any($1::uuid[])", [
        submissions,
      ]);
    }
    if (issues.length > 0) {
      await cleaner.query(
        "delete from review_decision where canonical_issue_id = any($1::uuid[])",
        [issues],
      );
      await cleaner.query(
        "delete from issue_participation where canonical_issue_id = any($1::uuid[])",
        [issues],
      );
    }
    if (submissions.length > 0) {
      await cleaner.query("delete from submission where submission_id = any($1::uuid[])", [
        submissions,
      ]);
    }
    if (issues.length > 0) {
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
    await cleaner.query("delete from jurisdiction where jurisdiction_id = any($1::uuid[])", [
      [jurisdictionId, ...extraJurisdictions],
    ]);
  } finally {
    await cleaner.end();
  }
});

const newParticipant = async (): Promise<string> => {
  const id = randomUUID();
  await client.query("insert into participant (participant_id) values ($1)", [id]);
  participants.push(id);
  return id;
};

const newIssue = async (): Promise<string> => {
  const issueId = randomUUID();
  await client.query(
    `insert into canonical_issue
       (issue_id, public_reference, category, current_status, opened_at,
        representative_location, last_evidence_at, jurisdiction_id)
     values ($1,$2,'sanitation','created', now(),
             ST_SetSRID(ST_MakePoint($3,$4),4326)::geography, now(), $5)`,
    [issueId, `VIS-${issueId.slice(0, 8).toUpperCase()}`, ORIGIN.lon, ORIGIN.lat, jurisdictionId],
  );
  issues.push(issueId);
  return issueId;
};

/** An issue whose jurisdiction is not known — what V059 would otherwise resolve. */
const newIssueWithoutJurisdiction = async (): Promise<string> => {
  const issueId = randomUUID();
  await client.query(
    `insert into canonical_issue
       (issue_id, public_reference, category, current_status, opened_at,
        representative_location, last_evidence_at)
     values ($1,$2,'sanitation','created', now(),
             ST_SetSRID(ST_MakePoint($3,$4),4326)::geography, now())`,
    [issueId, `VIS-${issueId.slice(0, 8).toUpperCase()}`, ORIGIN.lon, ORIGIN.lat],
  );
  issues.push(issueId);
  return issueId;
};

/** A photograph awaiting redaction, attached to the given issue. */
const needsReviewPhotoOn = async (issueId: string): Promise<string> => {
  const participantId = await newParticipant();
  const submissionId = await newSubmission(participantId);
  return pendingPhoto(submissionId, issueId);
};

const newSubmission = async (participantId: string): Promise<string> => {
  const submissionId = randomUUID();
  await client.query(
    `insert into submission
       (submission_id, participant_id, observed_location, observed_accuracy_m,
        observed_location_source, observed_at, interface_locale, locale_pack_version,
        taxonomy_version, idempotency_key)
     values ($1,$2, ST_SetSRID(ST_MakePoint($3,$4),4326)::geography, 12,
             'device_geolocation', now(), 'en-IN','demo-locales.v1','demo-taxonomy.v1',$5)`,
    [submissionId, participantId, ORIGIN.lon, ORIGIN.lat, `v32-${submissionId}`],
  );
  submissions.push(submissionId);
  return submissionId;
};

/**
 * A photograph awaiting a redaction decision — V021's normal state.
 *
 * Attached to an issue on purpose: every review action is jurisdiction-scoped
 * and an item's jurisdiction comes from the issue it belongs to, so an
 * unattached photograph cannot be authorised to any reviewer.
 */
const pendingPhoto = async (submissionId: string, issueId?: string): Promise<string> => {
  const evidenceId = randomUUID();
  await client.query(
    `insert into evidence_item
       (evidence_id, submission_id, media_type, object_reference, fingerprint_hash,
        redaction_status, processing_status)
     values ($1,$2,'photo',$3,$4,'needs_review','needs_review')`,
    [evidenceId, submissionId, `originals/t/${randomUUID()}`, "a".repeat(64)],
  );
  if (issueId !== undefined) {
    await client.query(
      `insert into issue_evidence_link
         (issue_evidence_link_id, evidence_id, canonical_issue_id, effective_from)
       values ($1,$2,$3, now())`,
      [randomUUID(), evidenceId, issueId],
    );
  }
  return evidenceId;
};

const ambiguousMatch = async (
  submissionId: string,
  candidates: readonly string[],
): Promise<string> => {
  const matchId = randomUUID();
  await client.query(
    `insert into issue_match
       (match_id, submission_id, attempt_number, state, candidate_issue_ids, decision_basis)
     values ($1,$2,1,'ambiguous',$3::uuid[],'{"matcher_version":"matcher.v1"}'::jsonb)`,
    [matchId, submissionId, candidates],
  );
  return matchId;
};

const openCorrection = async (
  submissionId: string,
  participantId: string,
  issueId: string,
): Promise<string> => {
  const requestId = randomUUID();
  await client.query(
    `insert into correction_request
       (request_id, kind, submission_id, canonical_issue_id,
        requested_by_participant_id, citizen_note)
     values ($1,'not_the_same_problem',$2,$3,$4,'Different tap.')`,
    [requestId, submissionId, issueId, participantId],
  );
  return requestId;
};

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

test("V032: the queue surfaces flagged evidence, ambiguous matches and corrections", async () => {
  const participantId = await newParticipant();
  const issueId = await newIssue();
  const submissionId = await newSubmission(participantId);
  const evidenceId = await pendingPhoto(submissionId, issueId);
  const matchId = await ambiguousMatch(submissionId, [issueId]);
  const requestId = await openCorrection(submissionId, participantId, issueId);

  const queue = await listReviewQueue(client, { principal: reviewer(), jurisdictionId });

  const ids = queue.items.map((item) => item.targetId);
  assert.ok(ids.includes(evidenceId), "a photograph awaiting redaction must be reviewable");
  assert.ok(ids.includes(matchId), "an ambiguous match must be reviewable");
  assert.ok(ids.includes(requestId), "a citizen's correction request must be reviewable");
});

test("V032: every queue item says why it is there and what may be done", async () => {
  const participantId = await newParticipant();
  const issueId = await newIssue();
  const submissionId = await newSubmission(participantId);
  await pendingPhoto(submissionId, issueId);

  const queue = await listReviewQueue(client, { principal: reviewer(), jurisdictionId });

  const item = queue.items.find((candidate) => candidate.kind === "redaction_decision");
  assert.notEqual(item, undefined);
  assert.ok((item?.reason.length ?? 0) > 10, "a queue entry must explain itself");
  assert.ok((item?.permittedActions.length ?? 0) > 0);
  assert.ok(item?.permittedActions.includes("approve_redaction"));
});

test("V032: the queue never exposes a private original", async () => {
  const participantId = await newParticipant();
  const issueId = await newIssue();
  const submissionId = await newSubmission(participantId);
  await pendingPhoto(submissionId, issueId);

  const queue = await listReviewQueue(client, { principal: reviewer(), jurisdictionId });

  assert.doesNotMatch(JSON.stringify(queue), /originals\//);
});

test("V032: a citizen cannot read the review queue", async () => {
  const participantId = await newParticipant();

  await assert.rejects(
    () => listReviewQueue(client, { principal: citizen(participantId), jurisdictionId }),
    ReviewError,
  );
});

test("V032: the queue is bounded and reports its bound", async () => {
  const participantId = await newParticipant();
  const issueId = await newIssue();
  const submissionId = await newSubmission(participantId);
  for (let index = 0; index < 3; index += 1) await pendingPhoto(submissionId, issueId);

  const queue = await listReviewQueue(client, { principal: reviewer(), jurisdictionId, limit: 2 });

  assert.equal(queue.items.length, 2);
  assert.equal(queue.appliedLimit, 2);
  assert.equal(queue.exhaustive, false);
});

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

test("V032: a decision without a reason is refused", async () => {
  const participantId = await newParticipant();
  const issueId = await newIssue();
  const submissionId = await newSubmission(participantId);
  const evidenceId = await pendingPhoto(submissionId, issueId);

  await assert.rejects(
    () =>
      decideReview(client, {
        principal: reviewer(),
        action: "approve_redaction",
        evidenceId,
        reason: "   ",
      }),
    /reason/i,
  );
});

test("V032: approving a redaction records the prior state and the reviewer", async () => {
  const participantId = await newParticipant();
  const issueId = await newIssue();
  const submissionId = await newSubmission(participantId);
  const evidenceId = await pendingPhoto(submissionId, issueId);
  const principal = reviewer();

  const decision = await decideReview(client, {
    principal,
    action: "approve_redaction",
    evidenceId,
    reason: "Reviewed the original; no face or number plate is visible.",
  });

  const { rows } = await client.query(
    "select redaction_status from evidence_item where evidence_id = $1",
    [evidenceId],
  );
  assert.equal(rows[0]?.["redaction_status"], "approved");

  const audit = await client.query(
    "select action, reason, reviewer_id, prior_state, resulting_state from review_decision where decision_id = $1",
    [decision.decisionId],
  );
  assert.equal(audit.rows[0]?.["action"], "approve_redaction");
  assert.equal(audit.rows[0]?.["reviewer_id"], principal.staffId);
  // The state it replaced is preserved, not overwritten: a public display may
  // change, the history behind it may not be erased.
  assert.equal(
    (audit.rows[0]?.["prior_state"] as Record<string, unknown>)["redaction_status"],
    "needs_review",
  );
  assert.equal(
    (audit.rows[0]?.["resulting_state"] as Record<string, unknown>)["redaction_status"],
    "approved",
  );
});

test("V032: rejecting evidence quarantines it rather than deleting it", async () => {
  const participantId = await newParticipant();
  const issueId = await newIssue();
  const submissionId = await newSubmission(participantId);
  const evidenceId = await pendingPhoto(submissionId, issueId);

  await decideReview(client, {
    principal: reviewer(),
    action: "reject_evidence",
    evidenceId,
    reason: "The photograph shows a person's face and cannot be redacted usefully.",
  });

  const { rows } = await client.query(
    "select processing_status, privacy_state from evidence_item where evidence_id = $1",
    [evidenceId],
  );
  assert.equal(rows[0]?.["processing_status"], "quarantined");
  // Not erased: erasure is a V005 retention act with its own ledger, not a
  // review outcome.
  assert.equal(rows[0]?.["privacy_state"], "active");
});

test("V032: requesting more evidence leaves the item reviewable", async () => {
  const participantId = await newParticipant();
  const issueId = await newIssue();
  const submissionId = await newSubmission(participantId);
  const evidenceId = await pendingPhoto(submissionId, issueId);

  await decideReview(client, {
    principal: reviewer(),
    action: "request_more_evidence",
    evidenceId,
    reason: "The photograph does not show the tap itself; a wider view would help.",
  });

  const { rows } = await client.query(
    "select processing_status, redaction_status from evidence_item where evidence_id = $1",
    [evidenceId],
  );
  assert.equal(rows[0]?.["processing_status"], "needs_review");
  assert.equal(rows[0]?.["redaction_status"], "needs_review");
});

test("V032: a reviewer resolves an ambiguous match by attaching it", async () => {
  const participantId = await newParticipant();
  const issueId = await newIssue();
  const other = await newIssue();
  const submissionId = await newSubmission(participantId);
  await client.query(
    `insert into evidence_item (evidence_id, submission_id, media_type, content_text)
     values ($1,$2,'text','The drain is blocked.')`,
    [randomUUID(), submissionId],
  );
  const matchId = await ambiguousMatch(submissionId, [issueId, other]);

  await decideReview(client, {
    principal: reviewer(),
    action: "attach_to_issue",
    matchId,
    canonicalIssueId: issueId,
    reason: "Both candidates are the same street, but the photograph shows the school gate drain.",
  });

  const match = await client.query(
    "select state, resulting_issue_id, decided_by_actor_type from issue_match where match_id = $1",
    [matchId],
  );
  assert.equal(match.rows[0]?.["state"], "match_confirmed");
  assert.equal(match.rows[0]?.["resulting_issue_id"], issueId);
  assert.equal(match.rows[0]?.["decided_by_actor_type"], "reviewer");

  const links = await client.query(
    `select count(*)::int as n from issue_evidence_link
      where canonical_issue_id = $1 and effective_to is null
        and evidence_id in (select evidence_id from evidence_item where submission_id = $2)`,
    [issueId, submissionId],
  );
  assert.equal(links.rows[0]?.["n"], 1);
});

test("V032: attaching to an issue that is not a candidate is refused", async () => {
  // A reviewer may choose between the candidates the system found, not
  // redirect a report to an unrelated issue without that being recorded as a
  // separate act.
  const participantId = await newParticipant();
  const candidate = await newIssue();
  const unrelated = await newIssue();
  const submissionId = await newSubmission(participantId);
  const matchId = await ambiguousMatch(submissionId, [candidate]);

  await assert.rejects(
    () =>
      decideReview(client, {
        principal: reviewer(),
        action: "attach_to_issue",
        matchId,
        canonicalIssueId: unrelated,
        reason: "a genuine reason that is long enough",
      }),
    /candidate/i,
  );
});

test("V032: separating an attachment supersedes the link without deleting it", async () => {
  const participantId = await newParticipant();
  const issueId = await newIssue();
  const submissionId = await newSubmission(participantId);
  const evidenceId = randomUUID();
  await client.query(
    `insert into evidence_item (evidence_id, submission_id, media_type, content_text)
     values ($1,$2,'text','The drain is blocked.')`,
    [evidenceId, submissionId],
  );
  const linkId = randomUUID();
  await client.query(
    `insert into issue_evidence_link
       (issue_evidence_link_id, evidence_id, canonical_issue_id, effective_from)
     values ($1,$2,$3, now())`,
    [linkId, evidenceId, issueId],
  );

  await decideReview(client, {
    principal: reviewer(),
    action: "separate_from_issue",
    evidenceId,
    canonicalIssueId: issueId,
    reason: "The reporter is right: this is a different tap on the far side.",
  });

  const { rows } = await client.query(
    "select effective_to, correction_reason, corrected_by_actor_id from issue_evidence_link where issue_evidence_link_id = $1",
    [linkId],
  );
  // Superseded, not deleted: the reason it was ever attached is part of the
  // record (V003 effective dating).
  assert.notEqual(rows[0]?.["effective_to"], null);
  assert.match(String(rows[0]?.["correction_reason"]), /different tap/);
  assert.notEqual(rows[0]?.["corrected_by_actor_id"], null);
});

test("V032: deciding a correction request records the outcome and the reason", async () => {
  const participantId = await newParticipant();
  const issueId = await newIssue();
  const submissionId = await newSubmission(participantId);
  const requestId = await openCorrection(submissionId, participantId, issueId);

  await decideReview(client, {
    principal: reviewer(),
    action: "accept_correction",
    correctionRequestId: requestId,
    reason: "Checked both locations; the reporter is describing a different asset.",
  });

  const { rows } = await client.query(
    "select state, decision, decision_reason, decided_by_reviewer_id from correction_request where request_id = $1",
    [requestId],
  );
  assert.equal(rows[0]?.["state"], "accepted");
  assert.equal(rows[0]?.["decision"], "accepted");
  assert.match(String(rows[0]?.["decision_reason"]), /different asset/);
  assert.notEqual(rows[0]?.["decided_by_reviewer_id"], null);
});

test("V032: a rejected correction request is closed with its reason, not deleted", async () => {
  const participantId = await newParticipant();
  const issueId = await newIssue();
  const submissionId = await newSubmission(participantId);
  const requestId = await openCorrection(submissionId, participantId, issueId);

  await decideReview(client, {
    principal: reviewer(),
    action: "reject_correction",
    correctionRequestId: requestId,
    reason: "The two reports describe the same drain from opposite sides of the road.",
  });

  const { rows } = await client.query(
    "select state, decision, decision_reason from correction_request where request_id = $1",
    [requestId],
  );
  assert.equal(rows[0]?.["state"], "rejected");
  assert.ok(String(rows[0]?.["decision_reason"]).length > 0);
});

test("V032: a decided request leaves the queue", async () => {
  const participantId = await newParticipant();
  const issueId = await newIssue();
  const submissionId = await newSubmission(participantId);
  const requestId = await openCorrection(submissionId, participantId, issueId);

  await decideReview(client, {
    principal: reviewer(),
    action: "reject_correction",
    correctionRequestId: requestId,
    reason: "The two reports describe the same drain.",
  });

  const queue = await listReviewQueue(client, { principal: reviewer(), jurisdictionId });
  assert.equal(
    queue.items.some((item) => item.targetId === requestId),
    false,
  );
});

test("V032: a citizen cannot make a review decision", async () => {
  const participantId = await newParticipant();
  const issueId = await newIssue();
  const submissionId = await newSubmission(participantId);
  const evidenceId = await pendingPhoto(submissionId, issueId);

  await assert.rejects(
    () =>
      decideReview(client, {
        principal: citizen(participantId),
        action: "approve_redaction",
        evidenceId,
        reason: "I would like my own photograph approved.",
      }),
    ReviewError,
  );
});

test("V032: a supervisor cannot decide a redaction they are not permitted to", async () => {
  // V015 gives redaction decisions to reviewers, not supervisors. The role
  // model is the authority here, not this service's own opinion.
  const participantId = await newParticipant();
  const issueId = await newIssue();
  const submissionId = await newSubmission(participantId);
  const evidenceId = await pendingPhoto(submissionId, issueId);

  await assert.rejects(
    () =>
      decideReview(client, {
        principal: {
          role: "supervisor",
          staffId: randomUUID() as never,
          jurisdictionScope: [],
          sessionId: randomUUID() as never,
        },
        action: "approve_redaction",
        evidenceId,
        reason: "a genuine reason that is long enough",
      }),
    ReviewError,
  );
});

// ---------------------------------------------------------------------------
// Jurisdiction scoping — the constraint V015 imposes on this whole task
// ---------------------------------------------------------------------------

test("V032: a reviewer scoped to another jurisdiction cannot read this queue", async () => {
  const participantId = await newParticipant();
  const issueId = await newIssue();
  const submissionId = await newSubmission(participantId);
  await pendingPhoto(submissionId, issueId);

  await assert.rejects(
    () => listReviewQueue(client, { principal: outOfScopeReviewer(), jurisdictionId }),
    ReviewError,
  );
});

test("V032: a reviewer scoped elsewhere cannot decide an item in this jurisdiction", async () => {
  const participantId = await newParticipant();
  const issueId = await newIssue();
  const submissionId = await newSubmission(participantId);
  const evidenceId = await pendingPhoto(submissionId, issueId);

  await assert.rejects(
    () =>
      decideReview(client, {
        principal: outOfScopeReviewer(),
        action: "approve_redaction",
        evidenceId,
        reason: "a genuine reason that is long enough to pass the check",
      }),
    /outside this principal's scope/,
  );
});

test("V032: an item with no jurisdiction cannot be decided by anyone", async () => {
  // The honest consequence of V015: until a submission's own jurisdiction can
  // be resolved (V033, needing V059's boundaries), an unattached photograph is
  // outside every reviewer's scope. Refusing is correct; defaulting to a
  // jurisdiction or to "allowed" would be the bypass.
  const participantId = await newParticipant();
  const submissionId = await newSubmission(participantId);
  const evidenceId = await pendingPhoto(submissionId);

  await assert.rejects(
    () =>
      decideReview(client, {
        principal: reviewer(),
        action: "approve_redaction",
        evidenceId,
        reason: "a genuine reason that is long enough to pass the check",
      }),
    /jurisdiction-scoped/,
  );
});

test("V032: an unscoped item is invisible in the queue but counted", async () => {
  const participantId = await newParticipant();
  const submissionId = await newSubmission(participantId);
  const evidenceId = await pendingPhoto(submissionId);

  const queue = await listReviewQueue(client, { principal: reviewer(), jurisdictionId });

  assert.equal(
    queue.items.some((item) => item.targetId === evidenceId),
    false,
    "a reviewer must not see an item they cannot be authorised for",
  );
  // A count, not a list. V015 gives no role evidence powers without a
  // jurisdiction — an administrator has configuration and audit access and
  // deliberately no evidence access — so there is nobody to show the items to.
  // The count makes the backlog visible while disclosing nothing.
  assert.ok(queue.awaitingJurisdictionCount >= 1);
  assert.match(queue.awaitingJurisdictionNote, /jurisdiction-scoped|V033|V059/);
  assert.doesNotMatch(JSON.stringify(queue), new RegExp(evidenceId));
});

test("V032: an administrator has no evidence powers, so cannot read the queue at all", async () => {
  // Separation of duties in V015: configuration and audit, never evidence.
  // Discovering this is what turned the unscoped backlog into a count.
  await assert.rejects(
    () => listReviewQueue(client, { principal: administrator(), jurisdictionId }),
    ReviewError,
  );
});

test("V032: a decision that cannot be recorded changes nothing", async () => {
  // The reason check happens before anything is read, and the state change
  // plus its audit row commit together. Without both, a decision the audit
  // trail rejects would still have altered the evidence — a change with
  // nothing explaining it, which is the one outcome this task forbids.
  const participantId = await newParticipant();
  const issueId = await newIssue();
  const submissionId = await newSubmission(participantId);
  const evidenceId = await pendingPhoto(submissionId, issueId);

  await assert.rejects(
    () =>
      decideReview(client, {
        principal: reviewer(),
        action: "approve_redaction",
        evidenceId,
        reason: "   ",
      }),
    /reason/i,
  );

  const { rows } = await client.query(
    "select redaction_status, processing_status, current_version from evidence_item where evidence_id = $1",
    [evidenceId],
  );
  assert.equal(rows[0]?.["redaction_status"], "needs_review", "the evidence must be untouched");
  assert.equal(rows[0]?.["processing_status"], "needs_review");
  assert.equal(rows[0]?.["current_version"], 1);

  const audit = await client.query(
    "select count(*)::int as n from review_decision where evidence_id = $1",
    [evidenceId],
  );
  assert.equal(audit.rows[0]?.["n"], 0);
});

test("V032: rejected evidence is quarantined, never marked rejected-and-gone", async () => {
  // 'quarantined' keeps it reviewable and recoverable; 'rejected' reads as a
  // final disposal that only the V005 retention path may perform.
  const participantId = await newParticipant();
  const issueId = await newIssue();
  const submissionId = await newSubmission(participantId);
  const evidenceId = await pendingPhoto(submissionId, issueId);

  await decideReview(client, {
    principal: reviewer(),
    action: "reject_evidence",
    evidenceId,
    reason: "A person's face fills the frame and cannot be usefully redacted.",
  });

  const { rows } = await client.query(
    "select processing_status from evidence_item where evidence_id = $1",
    [evidenceId],
  );
  assert.equal(rows[0]?.["processing_status"], "quarantined");
  assert.notEqual(rows[0]?.["processing_status"], "rejected");
});

test("V032: a decision whose audit row is rejected rolls back the state change", async () => {
  // Two targets at once violates review_decision_one_target_ck, and it does so
  // *after* the evidence has been updated. Without one transaction around both,
  // the evidence would stay changed with no audit row to explain it.
  const participantId = await newParticipant();
  const issueId = await newIssue();
  const submissionId = await newSubmission(participantId);
  const evidenceId = await pendingPhoto(submissionId, issueId);
  const matchId = await ambiguousMatch(submissionId, [issueId]);

  await assert.rejects(
    () =>
      decideReview(client, {
        principal: reviewer(),
        action: "approve_redaction",
        evidenceId,
        // A caller mistake, not a hostile input: passing both targets is easy
        // to do and must not leave a half-applied decision behind.
        matchId,
        reason: "Reviewed the original; nothing identifiable is visible.",
      }),
    /review_decision_one_target_ck/,
  );

  const { rows } = await client.query(
    "select redaction_status, current_version from evidence_item where evidence_id = $1",
    [evidenceId],
  );
  assert.equal(rows[0]?.["redaction_status"], "needs_review", "the change must have rolled back");
  assert.equal(rows[0]?.["current_version"], 1);
});

// ---------------------------------------------------------------------------
// Making the unscoped backlog actionable (V032)
// ---------------------------------------------------------------------------

test("V032: a reviewer may claim an unscoped issue into their own jurisdiction", async () => {
  // The defect this closes: `awaitingJurisdictionCount` reported a backlog
  // that no principal could ever act on, because every review action is
  // jurisdiction-scoped (V015) and these items have no jurisdiction. The count
  // made the problem visible and left it permanently stuck.
  //
  // V033 now resolves points that safely fall inside the configured synthetic
  // boundaries. This manual path remains for outside-profile, overlap and
  // accuracy-edge cases; it lets a *person* make an accountable scope claim
  // instead of the system guessing one.
  const issueId = await newIssueWithoutJurisdiction();
  const evidenceId = await needsReviewPhotoOn(issueId);

  const before = await listReviewQueue(client, { principal: reviewer(), jurisdictionId });
  assert.ok(before.awaitingJurisdictionCount >= 1);
  assert.equal(before.items.filter((i) => i.targetId === evidenceId).length, 0);

  const decided = await decideReview(client, {
    principal: reviewer(),
    action: "claim_jurisdiction",
    reason: "the school in this photograph is inside this ward",
    canonicalIssueId: issueId,
    jurisdictionId,
  });
  decisions.push(decided.decisionId);

  const after = await listReviewQueue(client, { principal: reviewer(), jurisdictionId });
  assert.equal(after.items.filter((i) => i.targetId === evidenceId).length, 1);
  assert.equal(after.awaitingJurisdictionCount, before.awaitingJurisdictionCount - 1);
});

test("V032: a reviewer may not claim an issue into a jurisdiction they do not hold", async () => {
  // Otherwise the claim is not "this is my area", it is "I decide whose area
  // this is" — and one reviewer could sweep reports into somebody else's
  // queue.
  const issueId = await newIssueWithoutJurisdiction();
  await needsReviewPhotoOn(issueId);
  const elsewhere = randomUUID();
  await client.query(
    `insert into jurisdiction
       (jurisdiction_id, jurisdiction_profile_id, internal_code, directory_version,
        level_scheme, level_code, effective_from, synthetic_provenance)
     values ($1,'demo-district-a',$2,'demo-routing.v1','test-scheme','district',
             now() - interval '1 year', true)`,
    [elsewhere, `rq-${elsewhere.slice(0, 8)}`],
  );
  extraJurisdictions.push(elsewhere);

  await assert.rejects(
    () =>
      decideReview(client, {
        principal: reviewer(),
        action: "claim_jurisdiction",
        reason: "putting it somewhere else",
        canonicalIssueId: issueId,
        jurisdictionId: elsewhere,
      }),
    /may not claim_jurisdiction/,
  );
});

test("V032: claiming an issue that already has a jurisdiction is refused", async () => {
  // Moving an issue between jurisdictions is a different act with different
  // consequences — it changes who owns the work already in progress — and it
  // must not happen through an action meant for unassigned items.
  const issueId = await newIssueWithoutJurisdiction();
  await needsReviewPhotoOn(issueId);
  const first = await decideReview(client, {
    principal: reviewer(),
    action: "claim_jurisdiction",
    reason: "this is inside this ward",
    canonicalIssueId: issueId,
    jurisdictionId,
  });
  decisions.push(first.decisionId);

  await assert.rejects(
    () =>
      decideReview(client, {
        principal: reviewer(),
        action: "claim_jurisdiction",
        reason: "claiming it again",
        canonicalIssueId: issueId,
        jurisdictionId,
      }),
    /already has a jurisdiction/i,
  );
});

test("V032: a claim records who made it and what it changed", async () => {
  const issueId = await newIssueWithoutJurisdiction();
  await needsReviewPhotoOn(issueId);

  const decided = await decideReview(client, {
    principal: reviewer(),
    action: "claim_jurisdiction",
    reason: "the school in this photograph is inside this ward",
    canonicalIssueId: issueId,
    jurisdictionId,
  });
  decisions.push(decided.decisionId);

  const { rows } = await client.query(
    "select action, reason, reviewer_id, canonical_issue_id from review_decision where decision_id = $1",
    [decided.decisionId],
  );
  assert.equal(rows[0]?.["action"], "claim_jurisdiction");
  assert.match(String(rows[0]?.["reason"]), /inside this ward/);
  assert.notEqual(rows[0]?.["reviewer_id"], null);
  assert.equal(decided.priorState["jurisdiction_id"], null);
  assert.equal(decided.resultingState["jurisdiction_id"], jurisdictionId);
});
