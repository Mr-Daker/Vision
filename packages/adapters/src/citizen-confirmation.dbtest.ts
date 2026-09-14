/**
 * Citizen duplicate confirmation and correction (roadmap V031).
 *
 * Run with: npm run db:up && npm run db:migrate && npm run test:db
 *
 * The citizen is being asked a question they can actually answer — "is this
 * the same problem you are reporting?" — not asked to pick a government
 * category. So rejection carries their own words and never a taxonomy value.
 *
 * The hard part is that the answer can go stale. Between the moment the
 * question is rendered and the moment it is answered, the candidate may have
 * been merged away, or the citizen's evidence may already have been attached
 * elsewhere. Answering a question about a world that has moved is worse than
 * asking again.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

import {
  presentCandidate,
  confirmMatch,
  rejectMatch,
  openCorrectionRequest,
} from "./citizen-confirmation.ts";
import { mergeIssues } from "./issue-assignment.ts";

const DATABASE_URL =
  process.env["DATABASE_URL"] ??
  "postgresql://vision:vision_local_dev_only@127.0.0.1:5432/vision_dev";

let client: pg.Client;
const issues: string[] = [];
const submissions: string[] = [];
const participants: string[] = [];

const ORIGIN = { lon: 75.01, lat: 17.21 };

before(async () => {
  client = new pg.Client({ connectionString: DATABASE_URL, statement_timeout: 15_000 });
  await client.connect();
});

after(async () => {
  await client.end().catch(() => undefined);
  const cleaner = new pg.Client({ connectionString: DATABASE_URL, statement_timeout: 10_000 });
  await cleaner.connect();
  try {
    if (submissions.length > 0) {
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
        "delete from issue_alias where source_issue_id = any($1::uuid[]) or target_issue_id = any($1::uuid[])",
        [issues],
      );
      await cleaner.query(
        "delete from issue_merge where surviving_issue_id = any($1::uuid[]) or merged_issue_id = any($1::uuid[])",
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
      // Rejecting opens a *new* issue, whose participation row is not in
      // `issues` — so the per-issue delete above misses it, and the failure
      // surfaces here as an FK violation attributed to the wrong test.
      // Deleting by the direct FK makes cleanup independent of that.
      await cleaner.query(
        "delete from issue_participation where participant_id = any($1::uuid[])",
        [participants],
      );
      await cleaner.query("delete from participant where participant_id = any($1::uuid[])", [
        participants,
      ]);
    }
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

const newIssue = async (category: string, metresEast = 0): Promise<string> => {
  const issueId = randomUUID();
  const lon = ORIGIN.lon + metresEast / (111_320 * Math.cos((ORIGIN.lat * Math.PI) / 180));
  await client.query(
    `insert into canonical_issue
       (issue_id, public_reference, category, current_status, opened_at,
        representative_location, last_evidence_at)
     values ($1,$2,$3,'created', now() - interval '2 days',
             ST_SetSRID(ST_MakePoint($4,$5),4326)::geography, now() - interval '1 day')`,
    [issueId, `VIS-${issueId.slice(0, 8).toUpperCase()}`, category, lon, ORIGIN.lat],
  );
  issues.push(issueId);
  return issueId;
};

const newSubmission = async (
  participantId: string,
  options: { readonly withPhoto?: boolean } = {},
): Promise<{ submissionId: string; evidenceId: string }> => {
  const submissionId = randomUUID();
  await client.query(
    `insert into submission
       (submission_id, participant_id, observed_location, observed_accuracy_m,
        observed_location_source, observed_at, interface_locale, locale_pack_version,
        taxonomy_version, idempotency_key)
     values ($1,$2, ST_SetSRID(ST_MakePoint($3,$4),4326)::geography, 12,
             'device_geolocation', now(), 'en-IN','demo-locales.v1','demo-taxonomy.v1',$5)`,
    [submissionId, participantId, ORIGIN.lon, ORIGIN.lat, `v31-${submissionId}`],
  );
  submissions.push(submissionId);
  const evidenceId = randomUUID();
  await client.query(
    `insert into evidence_item (evidence_id, submission_id, media_type, content_text)
     values ($1,$2,'text','The drain outside the school gate is blocked.')`,
    [evidenceId, submissionId],
  );
  if (options.withPhoto === true) {
    await client.query(
      `insert into evidence_item
         (evidence_id, submission_id, media_type, object_reference, fingerprint_hash,
          redaction_status, derivative_reference, processing_status)
       values ($1,$2,'photo',$3,$4,'approved',$5,'usable')`,
      [
        randomUUID(),
        submissionId,
        `originals/t/${randomUUID()}`,
        "e".repeat(64),
        `derivatives/t/${randomUUID()}`,
      ],
    );
  }
  return { submissionId, evidenceId };
};

// ---------------------------------------------------------------------------
// Presenting the question
// ---------------------------------------------------------------------------

test("V031: the candidate is presented with its location, a preview and its history", async () => {
  const category = `c31-${randomUUID().slice(0, 6)}`;
  const issueId = await newIssue(category, 20);
  const participantId = await newParticipant();
  const { submissionId } = await newSubmission(participantId, { withPhoto: true });
  // Someone else already reported this issue, with a photograph.
  const other = await newParticipant();
  const existing = await newSubmission(other, { withPhoto: true });
  await client.query(
    `insert into issue_evidence_link (issue_evidence_link_id, evidence_id, canonical_issue_id, effective_from)
     select $1, evidence_id, $2, now() from evidence_item where submission_id = $3 limit 1`,
    [randomUUID(), issueId, existing.submissionId],
  );

  const view = await presentCandidate(client, { submissionId, candidateIssueId: issueId });

  assert.notEqual(view, undefined);
  assert.equal(view?.candidate.publicReference.startsWith("VIS-"), true);
  assert.notEqual(view?.candidate.coarseLocation, undefined);
  assert.ok(view?.candidate.distanceMetres !== undefined);
  // History a citizen can judge: when it was first reported and how recently.
  assert.ok(view?.candidate.openedAt !== undefined);
  assert.ok(view?.candidate.entryCount !== undefined);
  // No category picker anywhere in what the citizen is asked.
  assert.equal("categoryOptions" in (view ?? {}), false);
});

test("V031: the preview offers only approved derivatives", async () => {
  const category = `c31-${randomUUID().slice(0, 6)}`;
  const issueId = await newIssue(category, 20);
  const participantId = await newParticipant();
  const { submissionId } = await newSubmission(participantId);
  const other = await newParticipant();
  const existing = await newSubmission(other);
  // An unapproved photo on the candidate issue.
  const pendingId = randomUUID();
  await client.query(
    `insert into evidence_item
       (evidence_id, submission_id, media_type, object_reference, fingerprint_hash,
        redaction_status, processing_status)
     values ($1,$2,'photo',$3,$4,'needs_review','needs_review')`,
    [pendingId, existing.submissionId, `originals/t/${randomUUID()}`, "f".repeat(64)],
  );
  await client.query(
    `insert into issue_evidence_link (issue_evidence_link_id, evidence_id, canonical_issue_id, effective_from)
     values ($1,$2,$3, now())`,
    [randomUUID(), pendingId, issueId],
  );

  const view = await presentCandidate(client, { submissionId, candidateIssueId: issueId });

  const serialised = JSON.stringify(view);
  assert.doesNotMatch(serialised, /originals\//, "a private original must never be previewed");
  assert.equal(view?.candidate.previewDerivatives.length, 0);
});

test("V031: a candidate that was merged away is presented as its survivor", async () => {
  const category = `c31-${randomUUID().slice(0, 6)}`;
  const surviving = await newIssue(category, 10);
  const retired = await newIssue(category, 12);
  const merge = await mergeIssues(client, {
    survivingIssueId: surviving,
    mergedIssueId: retired,
    reason: "the same drain reported twice",
    decidedByActorType: "reviewer",
    decidedByActorId: randomUUID(),
  });
  void merge;
  const participantId = await newParticipant();
  const { submissionId } = await newSubmission(participantId);

  const view = await presentCandidate(client, { submissionId, candidateIssueId: retired });

  const { rows } = await client.query(
    "select public_reference from canonical_issue where issue_id = $1",
    [surviving],
  );
  assert.equal(view?.candidate.publicReference, rows[0]?.["public_reference"]);
  assert.equal(view?.resolvedThroughAlias, true);
});

test("V031: an unknown candidate is undefined rather than an empty question", async () => {
  const participantId = await newParticipant();
  const { submissionId } = await newSubmission(participantId);

  const view = await presentCandidate(client, {
    submissionId,
    candidateIssueId: randomUUID(),
  });

  assert.equal(view, undefined);
});

// ---------------------------------------------------------------------------
// Confirming
// ---------------------------------------------------------------------------

test("V031: confirming attaches the evidence once to the current canonical issue", async () => {
  const category = `c31-${randomUUID().slice(0, 6)}`;
  const issueId = await newIssue(category, 20);
  const participantId = await newParticipant();
  const { submissionId } = await newSubmission(participantId, { withPhoto: true });

  const result = await confirmMatch(client, {
    submissionId,
    participantId,
    candidateIssueId: issueId,
  });

  assert.equal(result.status, "attached");
  if (result.status !== "attached") return;
  assert.equal(result.issueId, issueId);

  const links = await client.query(
    `select count(*)::int as n from issue_evidence_link
      where canonical_issue_id = $1
        and evidence_id in (select evidence_id from evidence_item where submission_id = $2)`,
    [issueId, submissionId],
  );
  assert.equal(links.rows[0]?.["n"], 2, "both evidence items are attached");

  // The citizen's decision is on the record as theirs, not the system's.
  const match = await client.query(
    "select state, decided_by_actor_type, decided_by_actor_id from issue_match where submission_id = $1",
    [submissionId],
  );
  assert.equal(match.rows[0]?.["state"], "match_confirmed");
  assert.equal(match.rows[0]?.["decided_by_actor_type"], "citizen");
  assert.equal(match.rows[0]?.["decided_by_actor_id"], participantId);
});

test("V031: confirming twice attaches nothing more", async () => {
  const category = `c31-${randomUUID().slice(0, 6)}`;
  const issueId = await newIssue(category, 20);
  const participantId = await newParticipant();
  const { submissionId } = await newSubmission(participantId);

  const first = await confirmMatch(client, {
    submissionId,
    participantId,
    candidateIssueId: issueId,
  });
  const second = await confirmMatch(client, {
    submissionId,
    participantId,
    candidateIssueId: issueId,
  });

  assert.equal(first.status, "attached");
  assert.equal(second.status, "already_attached");
  const links = await client.query(
    `select count(*)::int as n from issue_evidence_link
      where canonical_issue_id = $1
        and evidence_id in (select evidence_id from evidence_item where submission_id = $2)`,
    [issueId, submissionId],
  );
  assert.equal(links.rows[0]?.["n"], 1, "a second confirmation must not duplicate the evidence");
});

test("V031: confirming counts the citizen once as a contributor", async () => {
  const category = `c31-${randomUUID().slice(0, 6)}`;
  const issueId = await newIssue(category, 20);
  const participantId = await newParticipant();
  const { submissionId } = await newSubmission(participantId);

  await confirmMatch(client, { submissionId, participantId, candidateIssueId: issueId });
  await confirmMatch(client, { submissionId, participantId, candidateIssueId: issueId });

  const { rows } = await client.query(
    "select count(*)::int as n from issue_participation where canonical_issue_id = $1 and counted = true",
    [issueId],
  );
  assert.equal(rows[0]?.["n"], 1);
});

test("V031: confirming a merged-away candidate attaches to the survivor", async () => {
  const category = `c31-${randomUUID().slice(0, 6)}`;
  const surviving = await newIssue(category, 10);
  const retired = await newIssue(category, 12);
  await mergeIssues(client, {
    survivingIssueId: surviving,
    mergedIssueId: retired,
    reason: "the same drain",
    decidedByActorType: "reviewer",
    decidedByActorId: randomUUID(),
  });
  const participantId = await newParticipant();
  const { submissionId } = await newSubmission(participantId);

  const result = await confirmMatch(client, {
    submissionId,
    participantId,
    candidateIssueId: retired,
  });

  assert.equal(result.status, "attached");
  if (result.status !== "attached") return;
  assert.equal(result.issueId, surviving, "evidence must not land on a tombstone");
  assert.equal(result.resolvedThroughAlias, true);
});

test("V031: a candidate that vanished between question and answer is revalidated", async () => {
  const participantId = await newParticipant();
  const { submissionId } = await newSubmission(participantId);

  const result = await confirmMatch(client, {
    submissionId,
    participantId,
    candidateIssueId: randomUUID(),
  });

  assert.equal(result.status, "revalidate");
  if (result.status !== "revalidate") return;
  assert.match(result.reason, /no longer|not found|changed/i);
});

test("V031: a citizen cannot confirm someone else's submission", async () => {
  const category = `c31-${randomUUID().slice(0, 6)}`;
  const issueId = await newIssue(category, 20);
  const owner = await newParticipant();
  const stranger = await newParticipant();
  const { submissionId } = await newSubmission(owner);

  const result = await confirmMatch(client, {
    submissionId,
    participantId: stranger,
    candidateIssueId: issueId,
  });

  assert.equal(result.status, "not_yours");
});

// ---------------------------------------------------------------------------
// Rejecting
// ---------------------------------------------------------------------------

test("V031: rejecting opens a new issue and needs no category from the citizen", async () => {
  const category = `c31-${randomUUID().slice(0, 6)}`;
  const candidate = await newIssue(category, 20);
  const participantId = await newParticipant();
  const { submissionId } = await newSubmission(participantId);

  const result = await rejectMatch(client, {
    submissionId,
    participantId,
    candidateIssueId: candidate,
    citizenNote: "It is the tap by the gate, not the drain.",
  });

  assert.equal(result.status, "new_issue");
  if (result.status !== "new_issue") return;
  issues.push(result.issueId);

  const { rows } = await client.query("select category from canonical_issue where issue_id = $1", [
    result.issueId,
  ]);
  // The category is inherited from the submission's own processing, not asked
  // of the citizen: V031 requires rejection not to depend on understanding
  // government categories.
  assert.ok(String(rows[0]?.["category"]).length > 0);

  const match = await client.query(
    "select state, decided_by_actor_type from issue_match where submission_id = $1",
    [submissionId],
  );
  assert.equal(match.rows[0]?.["state"], "no_match");
  assert.equal(match.rows[0]?.["decided_by_actor_type"], "citizen");
});

test("V031: rejecting records the citizen's own words for a reviewer", async () => {
  const category = `c31-${randomUUID().slice(0, 6)}`;
  const candidate = await newIssue(category, 20);
  const participantId = await newParticipant();
  const { submissionId } = await newSubmission(participantId);

  const result = await rejectMatch(client, {
    submissionId,
    participantId,
    candidateIssueId: candidate,
    citizenNote: "Different corner of the compound.",
  });
  if (result.status === "new_issue") issues.push(result.issueId);

  const { rows } = await client.query(
    "select kind, citizen_note, state from correction_request where submission_id = $1",
    [submissionId],
  );
  assert.equal(rows[0]?.["kind"], "not_the_same_problem");
  assert.equal(rows[0]?.["citizen_note"], "Different corner of the compound.");
  assert.equal(rows[0]?.["state"], "open", "a reviewer decides; the citizen does not");
});

// ---------------------------------------------------------------------------
// Correction requests for an attachment that already happened
// ---------------------------------------------------------------------------

test("V031: a citizen can dispute an attachment that already happened", async () => {
  const category = `c31-${randomUUID().slice(0, 6)}`;
  const issueId = await newIssue(category, 20);
  const participantId = await newParticipant();
  const { submissionId } = await newSubmission(participantId);
  await confirmMatch(client, { submissionId, participantId, candidateIssueId: issueId });

  const request = await openCorrectionRequest(client, {
    submissionId,
    participantId,
    canonicalIssueId: issueId,
    kind: "not_the_same_problem",
    citizenNote: "I looked again and this is a different tap.",
  });

  assert.equal(request.status, "open");
  // The attachment is NOT undone by the citizen: it carries other people's
  // evidence too, so only a reviewer may separate it (V032).
  const links = await client.query(
    `select count(*)::int as n from issue_evidence_link
      where canonical_issue_id = $1 and effective_to is null
        and evidence_id in (select evidence_id from evidence_item where submission_id = $2)`,
    [issueId, submissionId],
  );
  assert.equal(links.rows[0]?.["n"], 1, "the attachment stands until a reviewer decides");
});

test("V031: disputing twice does not create two open requests", async () => {
  const category = `c31-${randomUUID().slice(0, 6)}`;
  const issueId = await newIssue(category, 20);
  const participantId = await newParticipant();
  const { submissionId } = await newSubmission(participantId);

  await openCorrectionRequest(client, {
    submissionId,
    participantId,
    canonicalIssueId: issueId,
    kind: "not_the_same_problem",
    citizenNote: "first",
  });
  const second = await openCorrectionRequest(client, {
    submissionId,
    participantId,
    canonicalIssueId: issueId,
    kind: "not_the_same_problem",
    citizenNote: "second",
  });

  assert.equal(second.status, "already_open");
  const { rows } = await client.query(
    "select count(*)::int as n from correction_request where submission_id = $1 and state = 'open'",
    [submissionId],
  );
  assert.equal(rows[0]?.["n"], 1);
});

test("V031: a correction request cannot be opened against someone else's report", async () => {
  const category = `c31-${randomUUID().slice(0, 6)}`;
  const issueId = await newIssue(category, 20);
  const owner = await newParticipant();
  const stranger = await newParticipant();
  const { submissionId } = await newSubmission(owner);

  const request = await openCorrectionRequest(client, {
    submissionId,
    participantId: stranger,
    canonicalIssueId: issueId,
    kind: "wrong_location",
    citizenNote: "not mine to dispute",
  });

  assert.equal(request.status, "not_yours");
});

// ---------------------------------------------------------------------------
// The state the citizen is actually asked in (V031)
// ---------------------------------------------------------------------------

/**
 * The prior ambiguous match that caused the question to be asked.
 *
 * Every test above calls confirm/reject with *no* existing match row, which is
 * a state that cannot occur: a citizen is asked precisely because the matcher
 * recorded an ambiguous match. `issue_match_one_active_per_submission_uniq`
 * permits one row with `superseded_at IS NULL`, so the real flow has one
 * waiting — and these tests set it up.
 */
const askedAbout = async (submissionId: string, issueId: string): Promise<string> => {
  const matchId = randomUUID();
  await client.query(
    `insert into issue_match
       (match_id, submission_id, attempt_number, state, candidate_issue_ids, decision_basis)
     values ($1,$2,1,'ambiguous',$3::uuid[],'{}'::jsonb)`,
    [matchId, submissionId, [issueId]],
  );
  return matchId;
};

test("V031: confirming works when the ambiguous match that prompted it exists", async () => {
  const participantId = await newParticipant();
  const { submissionId } = await newSubmission(participantId);
  const issueId = await newIssue("sanitation");
  await askedAbout(submissionId, issueId);

  const result = await confirmMatch(client, {
    submissionId,
    participantId,
    candidateIssueId: issueId,
  });

  assert.equal(result.status, "attached");
  // Exactly one active match row afterwards: the constraint permits one, so a
  // second would have failed the write outright.
  const { rows } = await client.query(
    "select count(*)::int as n from issue_match where submission_id = $1 and superseded_at is null",
    [submissionId],
  );
  assert.equal(rows[0]?.["n"], 1);
});

test("V031: rejecting works when the ambiguous match that prompted it exists", async () => {
  // This is the state the browser hit: a 500 from
  // `issue_match_one_active_per_submission_uniq`, because a new active row was
  // inserted while the ambiguous one was still active. Every test above passed
  // because none of them created the row that makes the question exist.
  const participantId = await newParticipant();
  const { submissionId } = await newSubmission(participantId);
  const issueId = await newIssue("sanitation");
  await askedAbout(submissionId, issueId);

  const result = await rejectMatch(client, {
    submissionId,
    participantId,
    candidateIssueId: issueId,
  });

  assert.equal(result.status, "new_issue");
  const { rows } = await client.query(
    "select count(*)::int as n from issue_match where submission_id = $1 and superseded_at is null",
    [submissionId],
  );
  assert.equal(rows[0]?.["n"], 1);
});

test("V031: the answer supersedes the question rather than deleting it", async () => {
  // The ambiguous attempt is part of the record of how the decision was
  // reached. Deleting it would erase the fact that the system was unsure and
  // that a person resolved it.
  const participantId = await newParticipant();
  const { submissionId } = await newSubmission(participantId);
  const issueId = await newIssue("sanitation");
  const askedMatchId = await askedAbout(submissionId, issueId);

  await rejectMatch(client, { submissionId, participantId, candidateIssueId: issueId });

  const { rows } = await client.query(
    "select state, superseded_at from issue_match where match_id = $1",
    [askedMatchId],
  );
  assert.equal(rows.length, 1, "the ambiguous attempt must still be on record");
  assert.equal(rows[0]?.["state"], "ambiguous");
  assert.notEqual(rows[0]?.["superseded_at"], null);
});

test("V031: the answer records which attempt it replaced", async () => {
  // Without the link the two rows are just two attempts; with it a reader can
  // see that this answer resolved that specific question.
  const participantId = await newParticipant();
  const { submissionId } = await newSubmission(participantId);
  const issueId = await newIssue("sanitation");
  const askedMatchId = await askedAbout(submissionId, issueId);

  await confirmMatch(client, { submissionId, participantId, candidateIssueId: issueId });

  const { rows } = await client.query(
    `select supersedes_match_id from issue_match
      where submission_id = $1 and superseded_at is null`,
    [submissionId],
  );
  assert.equal(String(rows[0]?.["supersedes_match_id"]), askedMatchId);
});

test("V031: answering twice does not leave two active attempts", async () => {
  // A double submit — an impatient second tap — must not produce a second
  // active row, because the constraint would reject it and the citizen would
  // see a server error for an answer that had already been recorded.
  const participantId = await newParticipant();
  const { submissionId } = await newSubmission(participantId);
  const issueId = await newIssue("sanitation");
  await askedAbout(submissionId, issueId);

  await confirmMatch(client, { submissionId, participantId, candidateIssueId: issueId });
  const second = await confirmMatch(client, {
    submissionId,
    participantId,
    candidateIssueId: issueId,
  });

  // `already_attached` is the honest second answer: the evidence is already on
  // the issue, so there is nothing further to do and nothing to report as new.
  assert.equal(second.status, "already_attached");
  const { rows } = await client.query(
    "select count(*)::int as n from issue_match where submission_id = $1 and superseded_at is null",
    [submissionId],
  );
  assert.equal(rows[0]?.["n"], 1);
});

test("V031: answering does not restamp attempts that were already retired", async () => {
  // A submission can have several earlier attempts, each already superseded at
  // its own time. Re-stamping them all would rewrite when those attempts were
  // retired, and the sequence of attempts is how a reader reconstructs how the
  // decision was reached.
  const participantId = await newParticipant();
  const { submissionId } = await newSubmission(participantId);
  const issueId = await newIssue("sanitation");

  const oldMatchId = randomUUID();
  await client.query(
    `insert into issue_match
       (match_id, submission_id, attempt_number, state, candidate_issue_ids,
        decision_basis, superseded_at)
     values ($1,$2,1,'candidates_retrieved',$3::uuid[],'{}'::jsonb,
             now() - interval '3 days')`,
    [oldMatchId, submissionId, [issueId]],
  );
  await client.query(
    `insert into issue_match
       (match_id, submission_id, attempt_number, state, candidate_issue_ids, decision_basis)
     values ($1,$2,2,'ambiguous',$3::uuid[],'{}'::jsonb)`,
    [randomUUID(), submissionId, [issueId]],
  );

  await confirmMatch(client, { submissionId, participantId, candidateIssueId: issueId });

  const { rows } = await client.query(
    "select extract(epoch from (now() - superseded_at)) / 86400.0 as age_days from issue_match where match_id = $1",
    [oldMatchId],
  );
  assert.ok(
    Number(rows[0]?.["age_days"]) > 2.5,
    `the earlier attempt kept its own retirement time, got ${String(rows[0]?.["age_days"])} days`,
  );
});
