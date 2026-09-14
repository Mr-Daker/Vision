/**
 * Canonical issue assignment under concurrency (roadmap V028).
 *
 * Run with: npm run db:up && npm run db:migrate && npm run test:db
 *
 * The failure this task exists to prevent: two citizens report the same
 * pothole at the same moment, both searches legitimately find nothing, and two
 * canonical issues are created for one problem. Neither transaction did
 * anything wrong on its own — this is write skew, and no amount of care in a
 * single transaction's own logic prevents it.
 *
 * Strategy chosen: **SERIALIZABLE with a bounded retry**, and a candidate
 * recheck inside the transaction. The alternative — an explicit advisory lock
 * on a coarse spatial bucket — was rejected because correctness would then
 * depend on bucket geometry: two reports thirty metres apart can straddle a
 * boundary and take different locks, and the bug comes straight back.
 *
 * Expensive inference stays strictly outside the transaction: the proposal is
 * computed first and passed in, so no database transaction is ever held open
 * across a network call.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

import {
  assignSubmissionToIssue,
  assignSubmissionToIssueInTransaction,
  mergeIssues,
  reverseMerge,
  MAX_ASSIGNMENT_ATTEMPTS,
} from "./issue-assignment.ts";
import { DEFAULT_THRESHOLDS, MATCHER_VERSION, type MatchProposal } from "@vision/domain";

const DATABASE_URL =
  process.env["DATABASE_URL"] ??
  "postgresql://vision:vision_local_dev_only@127.0.0.1:5432/vision_dev";

let client: pg.Client;
const issues: string[] = [];
const submissions: string[] = [];
const participants: string[] = [];
const events: string[] = [];

const ORIGIN = { lon: 74.62, lat: 16.91 };

before(async () => {
  client = new pg.Client({ connectionString: DATABASE_URL, statement_timeout: 15_000 });
  await client.connect();
});

after(async () => {
  // Cleanup runs on a *fresh* connection, and the tests' client is closed
  // first. The tests drive many explicit SERIALIZABLE transactions on that
  // client, and a cleanup that depends on its health cannot report a problem
  // if the client is wedged — it simply never resolves, which hangs the whole
  // file with every test passing. A new connection cannot inherit that state,
  // and the statement timeout turns any lock contention into a visible error.
  await client.end().catch(() => undefined);

  const cleaner = new pg.Client({ connectionString: DATABASE_URL, statement_timeout: 10_000 });
  await cleaner.connect();
  try {
    if (submissions.length > 0) {
      await cleaner.query("delete from candidate_query_log where submission_id = any($1::uuid[])", [
        submissions,
      ]);
      // Links reference their match row, so they go first. Deleting matches
      // first raises `issue_evidence_link_match_id_fkey` — which is the
      // constraint doing its job: a link whose decision record vanished could
      // not explain why the evidence is attached where it is.
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
      await cleaner.query("delete from canonical_issue where issue_id = any($1::uuid[])", [issues]);
    }
    if (events.length > 0) {
      await cleaner.query("delete from outbox where event_id = any($1::uuid[])", [events]);
      await cleaner.query("delete from status_event where event_id = any($1::uuid[])", [events]);
    }
    if (participants.length > 0) {
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

/** A category unique to one test, so tests cannot become each other's candidates. */
const newCategory = (): string => `cat-${randomUUID().slice(0, 8)}`;

const newSubmission = async (
  metresEast = 0,
): Promise<{ submissionId: string; participantId: string }> => {
  const participantId = await newParticipant();
  const submissionId = randomUUID();
  const lon = ORIGIN.lon + metresEast / (111_320 * Math.cos((ORIGIN.lat * Math.PI) / 180));
  await client.query(
    `insert into submission
       (submission_id, participant_id, observed_location, observed_accuracy_m,
        observed_location_source, observed_at, interface_locale, language_hint,
        locale_pack_version, taxonomy_version, idempotency_key)
     values ($1,$2, ST_SetSRID(ST_MakePoint($3,$4),4326)::geography, 12,
             'device_geolocation', now(), 'en-IN', 'en-IN',
             'demo-locales.v1','demo-taxonomy.v1',$5)`,
    [submissionId, participantId, lon, ORIGIN.lat, `assign-${submissionId}`],
  );
  // A text report always carries one evidence item; assignment links evidence,
  // not submissions, so without this there is nothing to link.
  await client.query(
    `insert into evidence_item (evidence_id, submission_id, media_type, content_text)
     values ($1,$2,'text','The classroom roof leaks whenever it rains.')`,
    [randomUUID(), submissionId],
  );
  submissions.push(submissionId);
  return { submissionId, participantId };
};

const newIssueRow = async (metresEast: number, category: string): Promise<string> => {
  const issueId = randomUUID();
  const lon = ORIGIN.lon + metresEast / (111_320 * Math.cos((ORIGIN.lat * Math.PI) / 180));
  await client.query(
    `insert into canonical_issue
       (issue_id, public_reference, category, opened_at, representative_location, last_evidence_at)
     values ($1,$2,$3, now(), ST_SetSRID(ST_MakePoint($4,$5),4326)::geography, now())`,
    [issueId, `VIS-${issueId.slice(0, 8)}`, category, lon, ORIGIN.lat],
  );
  issues.push(issueId);
  return issueId;
};

const base = {
  matcherVersion: MATCHER_VERSION,
  taxonomyVersion: "demo-taxonomy.v1",
  evidenceIds: [] as readonly string[],
  thresholds: DEFAULT_THRESHOLDS,
};

const newIssueProposal = (): MatchProposal => ({
  ...base,
  decision: "new_issue",
  reasons: ["no candidate issue was retrieved within the searched bounds"],
});

const existingProposal = (issueId: string, publicReference = "VIS-X"): MatchProposal => ({
  ...base,
  decision: "existing_issue",
  issueId,
  publicReference,
  reasons: ["the same asset identifier"],
});

const ambiguousProposal = (ids: readonly string[]): MatchProposal => ({
  ...base,
  decision: "ambiguous",
  candidates: ids.map((issueId) => ({ issueId, publicReference: `VIS-${issueId.slice(0, 4)}` })),
  requiresReview: true,
  mayMerge: false,
  permittedTreatments: [],
  reasons: ["two candidates score too closely to choose between them"],
});

const assignInput = (
  submissionId: string,
  participantId: string,
  proposal: MatchProposal,
  category: string,
  overrides: Record<string, unknown> = {},
) => ({
  submissionId,
  participantId,
  lon: ORIGIN.lon,
  lat: ORIGIN.lat,
  accuracyMetres: 12,
  category,
  observedAt: new Date().toISOString(),
  proposal,
  candidateIdsSeen: [] as readonly string[],
  ...overrides,
});

// ---------------------------------------------------------------------------
// The three ordinary outcomes
// ---------------------------------------------------------------------------

test("V028: a new-issue proposal creates one issue and records the decision", async () => {
  const category = newCategory();
  const { submissionId, participantId } = await newSubmission();

  const result = await assignSubmissionToIssue(
    client,
    assignInput(submissionId, participantId, newIssueProposal(), category),
  );

  assert.equal(result.status, "created");
  if (result.status !== "created") return;
  issues.push(result.issueId);

  const { rows } = await client.query(
    "select state, resulting_issue_id, decision_basis, attempt_number from issue_match where submission_id = $1",
    [submissionId],
  );
  assert.equal(rows[0]?.["state"], "no_match");
  assert.equal(rows[0]?.["resulting_issue_id"], result.issueId);
  assert.equal(rows[0]?.["attempt_number"], 1);
  // The basis must carry the versioned metadata that produced the decision.
  const basis = rows[0]?.["decision_basis"] as Record<string, unknown>;
  assert.equal(basis["matcher_version"], MATCHER_VERSION);
});

test("V028: an existing-issue proposal attaches without creating anything", async () => {
  const category = newCategory();
  const target = await newIssueRow(5, category);
  const { submissionId, participantId } = await newSubmission();

  const result = await assignSubmissionToIssue(
    client,
    assignInput(submissionId, participantId, existingProposal(target), category, {
      candidateIdsSeen: [target],
    }),
  );

  assert.equal(result.status, "attached");
  if (result.status !== "attached") return;
  assert.equal(result.issueId, target);

  const { rows } = await client.query("select state from issue_match where submission_id = $1", [
    submissionId,
  ]);
  assert.equal(rows[0]?.["state"], "match_confirmed");
  const linked = await client.query(
    `select count(*)::int as n from issue_evidence_link
      where canonical_issue_id = $2
        and evidence_id in (select evidence_id from evidence_item where submission_id = $1)`,
    [submissionId, target],
  );
  assert.equal(linked.rows[0]?.["n"], 1);
});

test("V028: an ambiguous proposal creates no issue, no link and no merge", async () => {
  const category = newCategory();
  const a = await newIssueRow(5, category);
  const b = await newIssueRow(8, category);
  const { submissionId, participantId } = await newSubmission();
  const before = await client.query("select count(*)::int as n from canonical_issue");

  const result = await assignSubmissionToIssue(
    client,
    assignInput(submissionId, participantId, ambiguousProposal([a, b]), category, {
      candidateIdsSeen: [a, b],
    }),
  );

  assert.equal(result.status, "needs_review");
  const after = await client.query("select count(*)::int as n from canonical_issue");
  assert.equal(after.rows[0]?.["n"], before.rows[0]?.["n"], "no issue may be created");

  const { rows } = await client.query(
    "select state, resulting_issue_id from issue_match where submission_id = $1",
    [submissionId],
  );
  assert.equal(rows[0]?.["state"], "ambiguous");
  assert.equal(rows[0]?.["resulting_issue_id"], null, "an ambiguous attempt must claim no result");

  const merges = await client.query(
    "select count(*)::int as n from issue_merge where surviving_issue_id = any($1::uuid[])",
    [[a, b]],
  );
  assert.equal(merges.rows[0]?.["n"], 0, "an ambiguous proposal must never cause a merge");
});

// ---------------------------------------------------------------------------
// The concurrency case this task exists for
// ---------------------------------------------------------------------------

test("V028: two concurrent first reports cannot both create an issue", async () => {
  const first = await newSubmission(0);
  const second = await newSubmission(4);
  const marker = `concurrent-${randomUUID().slice(0, 8)}`;

  const clientA = new pg.Client({ connectionString: DATABASE_URL });
  const clientB = new pg.Client({ connectionString: DATABASE_URL });
  await clientA.connect();
  await clientB.connect();

  try {
    // Both proposals legitimately saw nothing: this is write skew, and each
    // transaction is individually correct.
    const [resultA, resultB] = await Promise.all([
      assignSubmissionToIssue(
        clientA,
        assignInput(first.submissionId, first.participantId, newIssueProposal(), marker),
      ),
      assignSubmissionToIssue(
        clientB,
        assignInput(second.submissionId, second.participantId, newIssueProposal(), marker),
      ),
    ]);

    for (const result of [resultA, resultB]) {
      if (result.status === "created") issues.push(result.issueId);
    }

    const created = await client.query(
      "select count(*)::int as n from canonical_issue where category = $1",
      [marker],
    );
    // Exactly one issue for one problem. The loser is either told the decision
    // is stale (so it re-proposes and attaches) or attaches directly.
    assert.equal(
      created.rows[0]?.["n"],
      1,
      `expected one issue, got ${String(created.rows[0]?.["n"])}`,
    );
    const statuses = [resultA.status, resultB.status].sort();
    assert.ok(
      statuses.includes("created"),
      `one must have created; got ${JSON.stringify(statuses)}`,
    );
    assert.ok(
      statuses.includes("stale") || statuses.includes("attached"),
      `the other must be stale or attached; got ${JSON.stringify(statuses)}`,
    );
  } finally {
    await clientA.end();
    await clientB.end();
  }
});

test("V028: a decision made on stale candidates is rerun rather than committed", async () => {
  const category = newCategory();
  const { submissionId, participantId } = await newSubmission();
  // The proposal saw nothing, but by commit time an issue exists here.
  const appeared = await newIssueRow(3, category);

  const result = await assignSubmissionToIssue(
    client,
    assignInput(submissionId, participantId, newIssueProposal(), category, {
      candidateIdsSeen: [],
    }),
  );

  assert.equal(result.status, "stale");
  if (result.status !== "stale") return;
  assert.ok(result.candidateIdsNow.includes(appeared));
  assert.match(result.reason, /changed|stale|recheck/i);

  const created = await client.query(
    "select count(*)::int as n from issue_match where submission_id = $1",
    [submissionId],
  );
  assert.equal(created.rows[0]?.["n"], 1, "the stale attempt is recorded, not silently dropped");
  const { rows } = await client.query("select state from issue_match where submission_id = $1", [
    submissionId,
  ]);
  assert.equal(rows[0]?.["state"], "failed_retryable");
});

// ---------------------------------------------------------------------------
// Aliases and versions at commit
// ---------------------------------------------------------------------------

test("V028: attaching to a merged-away issue resolves to the surviving issue", async () => {
  const category = newCategory();
  const surviving = await newIssueRow(5, category);
  const retired = await newIssueRow(6, category);
  const merge = await mergeIssues(client, {
    survivingIssueId: surviving,
    mergedIssueId: retired,
    reason: "the same blocked drain reported twice",
    decidedByActorType: "reviewer",
    decidedByActorId: randomUUID(),
  });
  events.push(merge.decisionEventId);

  const { submissionId, participantId } = await newSubmission();
  const result = await assignSubmissionToIssue(
    client,
    assignInput(submissionId, participantId, existingProposal(retired), category, {
      candidateIdsSeen: [retired, surviving],
    }),
  );

  assert.equal(result.status, "attached");
  if (result.status !== "attached") return;
  // Alias resolution at commit: a proposal naming a retired issue must attach
  // to the issue that survived, not to a tombstone.
  assert.equal(result.issueId, surviving);
  assert.equal(result.resolvedThroughAlias, true);
});

test("V028: a merge is reversible and its record is retained", async () => {
  const category = newCategory();
  const surviving = await newIssueRow(5, category);
  const retired = await newIssueRow(7, category);

  const merge = await mergeIssues(client, {
    survivingIssueId: surviving,
    mergedIssueId: retired,
    reason: "duplicate of the same drain",
    decidedByActorType: "reviewer",
    decidedByActorId: randomUUID(),
  });
  events.push(merge.decisionEventId);

  const reversal = await reverseMerge(client, {
    mergeId: merge.mergeId,
    reason: "reviewed again and they are different drains",
  });
  events.push(reversal.reversalEventId);

  const { rows } = await client.query(
    "select reversed_at, reversal_reason from issue_merge where merge_id = $1",
    [merge.mergeId],
  );
  // The record stays: a reversed merge is history, not a mistake to erase.
  assert.notEqual(rows[0]?.["reversed_at"], null);
  assert.match(String(rows[0]?.["reversal_reason"]), /different drains/);

  const alias = await client.query("select valid_to from issue_alias where merge_id = $1", [
    merge.mergeId,
  ]);
  assert.notEqual(alias.rows[0]?.["valid_to"], null, "the alias must be closed, not deleted");

  // And the previously retired issue is reachable again on its own.
  const { submissionId, participantId } = await newSubmission();
  const result = await assignSubmissionToIssue(
    client,
    assignInput(submissionId, participantId, existingProposal(retired), category, {
      candidateIdsSeen: [retired, surviving],
    }),
  );
  assert.equal(result.status, "attached");
  if (result.status !== "attached") return;
  assert.equal(result.issueId, retired);
});

test("V028: a merge requires a reason", async () => {
  const category = newCategory();
  const surviving = await newIssueRow(5, category);
  const retired = await newIssueRow(9, category);

  await assert.rejects(
    () =>
      mergeIssues(client, {
        survivingIssueId: surviving,
        mergedIssueId: retired,
        reason: "  ",
        decidedByActorType: "reviewer",
        decidedByActorId: randomUUID(),
      }),
    /reason/i,
  );
});

test("V028: an issue cannot be merged into itself, and no event is written", async () => {
  const issueId = await newIssueRow(5, newCategory());
  const before = await client.query(
    "select count(*)::int as n from status_event where aggregate_id = $1",
    [issueId],
  );

  await assert.rejects(
    () =>
      mergeIssues(client, {
        survivingIssueId: issueId,
        mergedIssueId: issueId,
        reason: "a genuine reason",
        decidedByActorType: "reviewer",
        decidedByActorId: randomUUID(),
      }),
    /cannot be merged into itself/,
  );

  // The database constraint would also refuse this, but only after the event
  // row was written. Nothing may claim a merge that never happened.
  const after = await client.query(
    "select count(*)::int as n from status_event where aggregate_id = $1",
    [issueId],
  );
  assert.equal(after.rows[0]?.["n"], before.rows[0]?.["n"], "no event may be recorded");
});

// ---------------------------------------------------------------------------
// Inference stays outside the transaction
// ---------------------------------------------------------------------------

test("V028: assignment performs no inference of its own", async () => {
  // Structural: the proposal is an input. If assignment could classify, it
  // would hold a transaction open across a network call, which is how a
  // connection pool is exhausted by a slow provider.
  const { submissionId, participantId } = await newSubmission();
  const forbidden = () => {
    throw new Error("assignment must not call a provider");
  };

  const result = await assignSubmissionToIssue(client, {
    ...assignInput(submissionId, participantId, newIssueProposal(), newCategory()),
    // Deliberately supplied and deliberately unused.
    classify: forbidden,
  } as never);

  assert.equal(result.status, "created");
  if (result.status === "created") issues.push(result.issueId);
});

test("V028: the retry ceiling is bounded and stated", () => {
  assert.ok(MAX_ASSIGNMENT_ATTEMPTS >= 2 && MAX_ASSIGNMENT_ATTEMPTS <= 10);
});

test("V028: a merge that fails part-way leaves no event claiming it happened", async () => {
  // The event row has no foreign key, so it inserts happily; the merge row
  // references both issues and fails. Without one transaction around the
  // three writes, the log would permanently assert a merge that never
  // occurred — and the log is what a reviewer trusts.
  const surviving = await newIssueRow(5, newCategory());
  const nonExistent = randomUUID();
  const before = await client.query(
    "select count(*)::int as n from status_event where aggregate_id = $1",
    [surviving],
  );

  await assert.rejects(() =>
    mergeIssues(client, {
      survivingIssueId: surviving,
      mergedIssueId: nonExistent,
      reason: "a genuine reason that will not survive the foreign key",
      decidedByActorType: "reviewer",
      decidedByActorId: randomUUID(),
    }),
  );

  const after = await client.query(
    "select count(*)::int as n from status_event where aggregate_id = $1",
    [surviving],
  );
  assert.equal(after.rows[0]?.["n"], before.rows[0]?.["n"], "the event must have been rolled back");

  const merges = await client.query(
    "select count(*)::int as n from issue_merge where surviving_issue_id = $1",
    [surviving],
  );
  assert.equal(merges.rows[0]?.["n"], 0);
});

// ---------------------------------------------------------------------------
// Composing the assignment inside a caller's transaction (V028)
// ---------------------------------------------------------------------------

test("V028: the savepoint variant composes inside a caller's transaction", async () => {
  // V028 recorded that `assignSubmissionToIssue` "manages its own transaction,
  // so it cannot be composed inside a caller's transaction; a caller needing
  // that would need a savepoint variant". This is that variant: a caller with
  // other writes to make atomically alongside the assignment can now do so.
  const category = newCategory();
  const { submissionId, participantId } = await newSubmission();

  await client.query("begin isolation level serializable");
  const result = await assignSubmissionToIssueInTransaction(
    client,
    assignInput(submissionId, participantId, newIssueProposal(), category),
  );
  // A write the caller makes alongside it, which must land or not land
  // together with the assignment.
  await client.query("update submission set interface_locale = 'mr-IN' where submission_id = $1", [
    submissionId,
  ]);
  await client.query("commit");
  if (result.status === "created") issues.push(result.issueId);

  assert.equal(result.status, "created");
  const { rows } = await client.query(
    "select interface_locale from submission where submission_id = $1",
    [submissionId],
  );
  assert.equal(rows[0]?.["interface_locale"], "mr-IN");
});

test("V028: the caller rolling back undoes the assignment too", async () => {
  // This is the property that makes it composable at all. With the
  // self-managing variant the assignment is already committed by the time the
  // caller decides to roll back, leaving an issue their own records never
  // mention.
  const category = newCategory();
  const { submissionId, participantId } = await newSubmission();

  await client.query("begin isolation level serializable");
  const result = await assignSubmissionToIssueInTransaction(
    client,
    assignInput(submissionId, participantId, newIssueProposal(), category),
  );
  const issueId = result.status === "created" ? result.issueId : undefined;
  await client.query("rollback");

  assert.ok(issueId !== undefined);
  const { rows } = await client.query("select 1 from canonical_issue where issue_id = $1", [
    issueId,
  ]);
  assert.equal(rows.length, 0, "the assignment must not survive the caller's rollback");
});

test("V028: outside a transaction the savepoint variant refuses rather than half-working", async () => {
  // In autocommit each statement commits on its own, so the caller would
  // believe they had atomicity and not have it. Refused, and the message
  // names the function to use instead.
  const category = newCategory();
  const { submissionId, participantId } = await newSubmission();

  await assert.rejects(
    () =>
      assignSubmissionToIssueInTransaction(
        client,
        assignInput(submissionId, participantId, newIssueProposal(), category),
      ),
    /already be in a transaction|assignSubmissionToIssue/,
  );
});

test("V028: a caller's read-committed transaction is refused", async () => {
  // The recheck is only sound under SERIALIZABLE. At READ COMMITTED two
  // callers can both recheck, both see no conflict, and both open an issue for
  // the same problem — so accepting the weaker isolation would make the
  // duplicate protection look present when it is not.
  const category = newCategory();
  const { submissionId, participantId } = await newSubmission();

  await client.query("begin");
  try {
    await assert.rejects(
      () =>
        assignSubmissionToIssueInTransaction(
          client,
          assignInput(submissionId, participantId, newIssueProposal(), category),
        ),
      /serializable/i,
    );
  } finally {
    await client.query("rollback");
  }
});

test("V028: a serialization failure is reported to the caller, not retried inside", async () => {
  // Checked against the database rather than assumed: once a transaction has
  // hit 40001, `rollback to savepoint` lets statements run again but the
  // transaction can still never commit. Retrying inside would burn attempts
  // and fail anyway, so the caller has to retry its own transaction — and the
  // result says exactly that instead of reporting a success it cannot commit.
  const category = newCategory();
  const { submissionId, participantId } = await newSubmission();
  // Created before the transaction opens: rows written on `client` inside an
  // uncommitted transaction are invisible to `other`, so the conflicting
  // assignment would otherwise fail on a foreign key rather than on
  // serialization — and the test would pass for the wrong reason.
  const conflicting = await newSubmission();
  const other = new pg.Client({ connectionString: DATABASE_URL, statement_timeout: 15_000 });
  await other.connect();
  try {
    await client.query("begin isolation level serializable");
    // Read the predicate the other transaction is about to write into.
    await client.query(
      "select 1 from canonical_issue where jurisdiction_id is null and category = $1",
      [category],
    );

    // A committed conflicting write from elsewhere.
    const committed = await assignSubmissionToIssue(
      other,
      assignInput(
        conflicting.submissionId,
        conflicting.participantId,
        newIssueProposal(),
        category,
      ),
    );
    if (committed.status === "created") issues.push(committed.issueId);

    const result = await assignSubmissionToIssueInTransaction(
      client,
      assignInput(submissionId, participantId, newIssueProposal(), category),
    );

    // Either no conflict arose, or the conflict was reported for the caller to
    // retry. What it must never do is claim a success it cannot commit.
    // Asserted unconditionally. An `if (status === ...)` here would quietly
    // stop testing anything the day the conflict no longer arises, and the
    // whole point is that this path is reached.
    assert.equal(result.status, "caller_must_retry");
    if (result.status === "caller_must_retry") {
      assert.match(result.reason, /retry its own transaction/i);
      assert.equal(result.sqlState, "40001");
    }
    // And retrying the same work inside this transaction is futile, which is
    // the actual reason this function does not retry: rolling back to the
    // savepoint makes the transaction usable again, but the conflict is
    // recorded against the transaction, so the same work conflicts again.
    const second = await assignSubmissionToIssueInTransaction(
      client,
      assignInput(submissionId, participantId, newIssueProposal(), category),
    );
    assert.equal(second.status, "caller_must_retry");
  } finally {
    await client.query("rollback").catch(() => undefined);
    await other.query("rollback").catch(() => undefined);
    await other.end();
  }
});

test("V028: a permanent error throws rather than telling the caller to retry", async () => {
  // "Retry" is advice a caller acts on in a loop. Reporting a permanent
  // failure — an unknown submission here — as retryable would have them retry
  // forever against something that can never succeed, which is the same
  // failure mode as the blank Gemini model name reported as a retryable
  // outage (V023).
  const category = newCategory();
  const unknownSubmission = randomUUID();

  await client.query("begin isolation level serializable");
  try {
    await assert.rejects(() =>
      assignSubmissionToIssueInTransaction(
        client,
        assignInput(unknownSubmission, randomUUID(), newIssueProposal(), category),
      ),
    );
  } finally {
    await client.query("rollback").catch(() => undefined);
  }
});
