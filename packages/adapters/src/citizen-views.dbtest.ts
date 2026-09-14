/**
 * Citizen tracking and discovery read models (roadmap V030).
 *
 * Run with: npm run db:up && npm run db:migrate && npm run test:db
 *
 * Two obligations pull in opposite directions and both have to hold. A citizen
 * must be able to come back to their own report without keeping a secret link
 * — so "My Reports" is bound to their session, not to a URL anyone could
 * guess. And a stranger must be able to discover nearby public issues without
 * learning anything private — so the public view is derived through the V015
 * projection, never assembled by hand.
 *
 * The read side is also where uncertainty becomes visible or disappears. Every
 * view here carries what is uncertain, what is simulated, and what is a
 * fixture, because a summary that looks confident is worse than no summary.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

import { PUBLIC_FORBIDDEN_FIELDS } from "@vision/domain";

import { mergeIssues } from "./issue-assignment.ts";

import {
  listMyReports,
  lookupReceipt,
  discoverNearbyIssues,
  getIssueDetail,
  DISCOVERY_PAGE_LIMIT,
} from "./citizen-views.ts";

const DATABASE_URL =
  process.env["DATABASE_URL"] ??
  "postgresql://vision:vision_local_dev_only@127.0.0.1:5432/vision_dev";

let client: pg.Client;
const issues: string[] = [];
const submissions: string[] = [];
const participants: string[] = [];

const ORIGIN = { lon: 74.81, lat: 17.05 };
const offset = (metresEast: number) => ({
  lon: ORIGIN.lon + metresEast / (111_320 * Math.cos((ORIGIN.lat * Math.PI) / 180)),
  lat: ORIGIN.lat,
});

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
      // Aliases and merges first: both reference the issues below, and the
      // merge test creates them.
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

const newIssue = async (metresEast: number, category = "sanitation"): Promise<string> => {
  const issueId = randomUUID();
  const at = offset(metresEast);
  await client.query(
    `insert into canonical_issue
       (issue_id, public_reference, category, current_status, opened_at,
        representative_location, last_evidence_at)
     values ($1,$2,$3,'created', now(), ST_SetSRID(ST_MakePoint($4,$5),4326)::geography, now())`,
    [issueId, `VIS-${issueId.slice(0, 8).toUpperCase()}`, category, at.lon, at.lat],
  );
  issues.push(issueId);
  return issueId;
};

const newReport = async (
  participantId: string,
  issueId: string | undefined,
  options: { readonly text?: string; readonly withPhoto?: boolean } = {},
): Promise<{ submissionId: string; evidenceId: string }> => {
  const submissionId = randomUUID();
  await client.query(
    `insert into submission
       (submission_id, participant_id, observed_location, observed_accuracy_m,
        observed_location_source, observed_at, interface_locale, language_hint,
        locale_pack_version, taxonomy_version, idempotency_key)
     values ($1,$2, ST_SetSRID(ST_MakePoint($3,$4),4326)::geography, 12,
             'device_geolocation', now(), 'en-IN','en-IN',
             'demo-locales.v1','demo-taxonomy.v1',$5)`,
    [submissionId, participantId, ORIGIN.lon, ORIGIN.lat, `v30-${submissionId}`],
  );
  submissions.push(submissionId);

  const evidenceId = randomUUID();
  const created: string[] = [evidenceId];
  await client.query(
    `insert into evidence_item (evidence_id, submission_id, media_type, content_text)
     values ($1,$2,'text',$3)`,
    [evidenceId, submissionId, options.text ?? "The drain outside the school is blocked."],
  );
  if (options.withPhoto === true) {
    const photoId = randomUUID();
    created.push(photoId);
    await client.query(
      `insert into evidence_item
         (evidence_id, submission_id, media_type, object_reference, fingerprint_hash,
          redaction_status, derivative_reference, processing_status)
       values ($1,$2,'photo',$3,$4,'approved',$5,'usable')`,
      [
        photoId,
        submissionId,
        `originals/t/${randomUUID()}`,
        "b".repeat(64),
        `derivatives/t/${randomUUID()}`,
      ],
    );
  }
  if (issueId !== undefined) {
    // Every evidence item is linked, not only the text one: a detail view
    // that never sees the photograph cannot be tested for what it does with
    // one.
    for (const id of created) {
      await client.query(
        `insert into issue_evidence_link
           (issue_evidence_link_id, evidence_id, canonical_issue_id, effective_from)
         values ($1,$2,$3, now())`,
        [randomUUID(), id, issueId],
      );
    }
    await client.query(
      `insert into issue_participation
         (participation_id, participant_id, canonical_issue_id, counted,
          first_evidence_at, last_evidence_at)
       values ($1,$2,$3,true, now(), now())
       on conflict do nothing`,
      [randomUUID(), participantId, issueId],
    );
  }
  return { submissionId, evidenceId };
};

// ---------------------------------------------------------------------------
// My Reports: reachable from a session, not from a secret link
// ---------------------------------------------------------------------------

test("V030: a citizen sees their own reports without needing a saved link", async () => {
  const participantId = await newParticipant();
  const issueId = await newIssue(10);
  const { submissionId } = await newReport(participantId, issueId);

  const page = await listMyReports(client, { participantId });

  assert.equal(page.reports.length, 1);
  assert.equal(page.reports[0]?.submissionId, submissionId);
  assert.equal(page.reports[0]?.issuePublicReference?.startsWith("VIS-"), true);
});

test("V030: one citizen never sees another's reports", async () => {
  const mine = await newParticipant();
  const theirs = await newParticipant();
  const issueId = await newIssue(10);
  await newReport(theirs, issueId);

  const page = await listMyReports(client, { participantId: mine });

  assert.deepEqual(page.reports, []);
});

test("V030: a report not yet matched to an issue is still listed", async () => {
  // The citizen must be able to see that their report exists and is being
  // worked on, not just once it has an issue.
  const participantId = await newParticipant();
  await newReport(participantId, undefined);

  const page = await listMyReports(client, { participantId });

  assert.equal(page.reports.length, 1);
  assert.equal(page.reports[0]?.issuePublicReference, undefined);
  assert.match(page.reports[0]?.statusLabel ?? "", /received|being|not yet/i);
});

test("V030: my-reports pages with a cursor rather than an offset", async () => {
  const participantId = await newParticipant();
  const issueId = await newIssue(10);
  for (let index = 0; index < 3; index += 1) await newReport(participantId, issueId);

  const first = await listMyReports(client, { participantId, limit: 2 });
  assert.equal(first.reports.length, 2);
  assert.notEqual(first.nextCursor, undefined);

  const second = await listMyReports(client, {
    participantId,
    limit: 2,
    cursor: first.nextCursor,
  });
  assert.equal(second.reports.length, 1);
  assert.equal(second.nextCursor, undefined);
  // No overlap: an offset would repeat a row if one were inserted between
  // pages, which is exactly what a citizen would notice.
  const ids = new Set([...first.reports, ...second.reports].map((r) => r.submissionId));
  assert.equal(ids.size, 3);
});

// ---------------------------------------------------------------------------
// Receipt lookup
// ---------------------------------------------------------------------------

test("V030: a receipt reference resolves for the citizen who owns it", async () => {
  const participantId = await newParticipant();
  const issueId = await newIssue(10);
  const { submissionId } = await newReport(participantId, issueId);

  const found = await lookupReceipt(client, { participantId, submissionId });

  assert.notEqual(found, undefined);
  assert.equal(found?.submissionId, submissionId);
});

test("V030: a receipt reference does not resolve for anyone else", async () => {
  const owner = await newParticipant();
  const stranger = await newParticipant();
  const issueId = await newIssue(10);
  const { submissionId } = await newReport(owner, issueId);

  const found = await lookupReceipt(client, { participantId: stranger, submissionId });

  assert.equal(found, undefined, "a receipt is not a bearer token for anyone holding the id");
});

// ---------------------------------------------------------------------------
// Public discovery
// ---------------------------------------------------------------------------

test("V030: nearby public issues are discoverable without any private field", async () => {
  const participantId = await newParticipant();
  const near = await newIssue(30);
  await newReport(participantId, near);

  const page = await discoverNearbyIssues(client, {
    lon: ORIGIN.lon,
    lat: ORIGIN.lat,
    radiusMetres: 500,
  });

  const found = page.issues.find((issue) => issue.publicReference !== undefined);
  assert.notEqual(found, undefined);
  // The public projection is the V015 one, so this asserts the guard rather
  // than re-listing the allowed fields by hand.
  const serialised = JSON.stringify(page.issues);
  for (const forbidden of PUBLIC_FORBIDDEN_FIELDS) {
    assert.doesNotMatch(
      serialised,
      new RegExp(forbidden),
      `${forbidden} leaked into a public view`,
    );
  }
});

test("V030: discovery reports a coarse location, never the precise one", async () => {
  const near = await newIssue(30);
  void near;

  const page = await discoverNearbyIssues(client, {
    lon: ORIGIN.lon,
    lat: ORIGIN.lat,
    radiusMetres: 500,
  });

  const issue = page.issues[0];
  assert.notEqual(issue?.coarseLocation, undefined);
  // Rounded, so a public map cannot be used to find a reporter's doorstep.
  assert.equal(issue?.coarseLocation?.lon, Number(issue?.coarseLocation?.lon.toFixed(3)));
});

test("V030: discovery is bounded and pages with a cursor", async () => {
  const category = `disc-${randomUUID().slice(0, 6)}`;
  for (let index = 0; index < 3; index += 1) await newIssue(10 + index, category);

  const first = await discoverNearbyIssues(client, {
    lon: ORIGIN.lon,
    lat: ORIGIN.lat,
    radiusMetres: 500,
    category,
    limit: 2,
  });

  assert.equal(first.issues.length, 2);
  assert.notEqual(first.nextCursor, undefined);
  const second = await discoverNearbyIssues(client, {
    lon: ORIGIN.lon,
    lat: ORIGIN.lat,
    radiusMetres: 500,
    category,
    limit: 2,
    cursor: first.nextCursor,
  });
  assert.equal(second.issues.length, 1);
});

test("V030: an absurd page size is clamped rather than accepted", async () => {
  const page = await discoverNearbyIssues(client, {
    lon: ORIGIN.lon,
    lat: ORIGIN.lat,
    radiusMetres: 500,
    limit: 10_000,
  });

  assert.ok(page.issues.length <= DISCOVERY_PAGE_LIMIT);
  assert.equal(page.appliedLimit, DISCOVERY_PAGE_LIMIT);
});

test("V030: an empty discovery result is not proof that nothing is wrong nearby", async () => {
  const page = await discoverNearbyIssues(client, { lon: 10, lat: 10, radiusMetres: 100 });

  assert.deepEqual(page.issues, []);
  assert.match(page.note, /bounded|not .*proof|nothing was found/i);
});

test("V030: a filter restricts the category without hiding that it was applied", async () => {
  const marker = `f-${randomUUID().slice(0, 6)}`;
  await newIssue(10, marker);
  await newIssue(12, `${marker}-other`);

  const page = await discoverNearbyIssues(client, {
    lon: ORIGIN.lon,
    lat: ORIGIN.lat,
    radiusMetres: 500,
    category: marker,
  });

  assert.equal(page.issues.length, 1);
  assert.equal(page.appliedFilters.category, marker);
});

// ---------------------------------------------------------------------------
// Issue detail: traceable, and honest about what is not real yet
// ---------------------------------------------------------------------------

test("V030: an issue detail traces back to its evidence and dates", async () => {
  const participantId = await newParticipant();
  const issueId = await newIssue(10);
  await newReport(participantId, issueId, { withPhoto: true });

  const detail = await getIssueDetail(client, { issueId });

  assert.notEqual(detail, undefined);
  assert.equal(detail?.countedParticipants, 1);
  assert.ok(detail?.evidence.length ?? 0 >= 1);
  assert.ok(detail?.openedAt !== undefined);
  assert.ok(detail?.lastEvidenceAt !== undefined);
});

test("V030: only approved derivatives appear, never an original reference", async () => {
  const participantId = await newParticipant();
  const issueId = await newIssue(10);
  await newReport(participantId, issueId, { withPhoto: true });

  const detail = await getIssueDetail(client, { issueId });

  const serialised = JSON.stringify(detail);
  assert.doesNotMatch(serialised, /originals\//, "a private original must never reach a reader");
  assert.match(serialised, /derivatives\//);
});

test("V030: an unapproved photo contributes no viewable image at all", async () => {
  const participantId = await newParticipant();
  const issueId = await newIssue(10);
  const { submissionId } = await newReport(participantId, issueId);
  // A photo still awaiting a redaction decision — V021's normal state.
  const pendingPhotoId = randomUUID();
  await client.query(
    `insert into evidence_item
       (evidence_id, submission_id, media_type, object_reference, fingerprint_hash,
        redaction_status, processing_status)
     values ($1,$2,'photo',$3,$4,'needs_review','needs_review')`,
    [pendingPhotoId, submissionId, `originals/t/${randomUUID()}`, "c".repeat(64)],
  );
  await client.query(
    `insert into issue_evidence_link
       (issue_evidence_link_id, evidence_id, canonical_issue_id, effective_from)
     values ($1,$2,$3, now())`,
    [randomUUID(), pendingPhotoId, issueId],
  );

  const detail = await getIssueDetail(client, { issueId });

  const viewable = detail?.evidence.filter((item) => item.derivativeReference !== undefined) ?? [];
  assert.equal(viewable.length, 0);
  const pending = detail?.evidence.find((item) => item.mediaType === "photo");
  assert.equal(pending?.viewable, false);
  assert.match(pending?.whyNotViewable ?? "", /redaction|review/i);
});

test("V030: assignment and resolution report what is actually recorded", async () => {
  // This used to assert the fields were hard-coded "not yet live", which was
  // true while V034 and V035 existed only as services. Both now write real
  // events, so the assertion is the stronger one: the fields describe *this*
  // issue rather than a constant, and an issue with nothing recorded says so
  // in words instead of rendering an empty workflow as though it were real.
  const issueId = await newIssue(10);

  const detail = await getIssueDetail(client, { issueId });

  assert.equal(detail?.assignment.isLive, false);
  assert.equal(detail?.resolution.isLive, false);
  assert.match(detail?.assignment.note ?? "", /no staff member is assigned/i);
  assert.match(detail?.resolution.note ?? "", /no repair has been claimed/i);

  // The disclosure that stops a claim being read as a finished repair travels
  // with every issue, whether or not one has been claimed.
  assert.ok(
    detail?.disclosures.some((line) => /not an inspection|certification/i.test(line)),
    "every issue must carry the disclosure that agreement is not an inspection",
  );
  // And the stale sentence is gone: saying the workflows are not connected
  // would now be false.
  assert.ok(
    !(detail?.disclosures ?? []).some((line) => /not yet connected/i.test(line)),
    "the V034/V035 'not yet connected' disclosure is stale and must not return",
  );
});

test("V030: infrastructure history is distinguished from repeated complaints", async () => {
  const participantId = await newParticipant();
  const issueId = await newIssue(10);
  await newReport(participantId, issueId);
  await newReport(participantId, issueId);

  const detail = await getIssueDetail(client, { issueId });

  // Two complaint entries by one person is not two things happening to the
  // asset. Conflating them is how a history page invents a pattern.
  assert.equal(detail?.complaintEntries, 2);
  assert.equal(detail?.countedParticipants, 1);
  assert.equal(detail?.infrastructureHistory.length, 0);
  assert.match(detail?.infrastructureHistoryNote ?? "", /asset|not .*complaint|separate/i);
});

test("V030: a detail view states what is simulated or uncertain", async () => {
  const issueId = await newIssue(10);

  const detail = await getIssueDetail(client, { issueId });

  assert.ok((detail?.disclosures.length ?? 0) > 0, "a reader must be told what is not real yet");
  assert.match(detail?.disclosures.join(" ") ?? "", /simulated|fixture|not yet/i);
});

test("V030: an unknown issue is undefined rather than an empty-looking detail", async () => {
  const detail = await getIssueDetail(client, { issueId: randomUUID() });

  assert.equal(detail, undefined);
});

// ---------------------------------------------------------------------------
// Gaps found by mutation testing
// ---------------------------------------------------------------------------

test("V030: an erased report drops out of My Reports", async () => {
  // V005 erasure keeps a tombstone row. A tombstone is not a report, and
  // listing it would show the citizen an entry with nothing behind it.
  const participantId = await newParticipant();
  const issueId = await newIssue(10);
  await newReport(participantId, issueId);
  assert.equal((await listMyReports(client, { participantId })).reports.length, 1);

  await client.query(
    `update submission set privacy_state = 'erased', erased_at = now(),
            observed_location = null where participant_id = $1`,
    [participantId],
  );

  assert.deepEqual((await listMyReports(client, { participantId })).reports, []);
});

test("V030: a discovered issue exposes exactly the agreed fields and no more", async () => {
  // Checking the *shape* rather than only scanning for known-bad names: a
  // field added here later would otherwise reach the public payload without
  // any test objecting, and the forbidden-name list only catches names
  // somebody already thought of.
  await newIssue(30);

  const page = await discoverNearbyIssues(client, {
    lon: ORIGIN.lon,
    lat: ORIGIN.lat,
    radiusMetres: 500,
  });

  assert.ok(page.issues.length >= 1);
  assert.deepEqual(Object.keys(page.issues[0] ?? {}).sort(), [
    "approvedDerivativeReferences",
    "category",
    "coarseLocation",
    "countedParticipants",
    "currentStatus",
    "lastEvidenceAt",
    "publicReference",
  ]);
});

test("V030: the database forbids a derivative without an approved redaction", async () => {
  // The discovery query filters on redaction status, and that filter is only
  // redundant because this constraint holds. The guarantee is what needs
  // pinning, not the filter.
  const participantId = await newParticipant();
  const issueId = await newIssue(10);
  const { submissionId } = await newReport(participantId, issueId);

  await assert.rejects(
    () =>
      client.query(
        `insert into evidence_item
           (evidence_id, submission_id, media_type, object_reference, fingerprint_hash,
            redaction_status, derivative_reference)
         values ($1,$2,'photo',$3,$4,'needs_review',$5)`,
        [
          randomUUID(),
          submissionId,
          `originals/t/${randomUUID()}`,
          "d".repeat(64),
          `derivatives/t/${randomUUID()}`,
        ],
      ),
    /evidence_item_derivative_needs_approval_ck/,
  );
});

test("V030: an issue retired by a merge does not appear twice in discovery", async () => {
  // Otherwise a merged duplicate shows up beside its survivor on a public
  // map, which reads as two problems where there is one.
  const category = `merge-${randomUUID().slice(0, 6)}`;
  const surviving = await newIssue(10, category);
  const retired = await newIssue(12, category);

  const before = await discoverNearbyIssues(client, {
    lon: ORIGIN.lon,
    lat: ORIGIN.lat,
    radiusMetres: 500,
    category,
  });
  assert.equal(before.issues.length, 2);

  const merge = await mergeIssues(client, {
    survivingIssueId: surviving,
    mergedIssueId: retired,
    reason: "the same problem reported twice",
    decidedByActorType: "reviewer",
    decidedByActorId: randomUUID(),
  });
  void merge;

  const after = await discoverNearbyIssues(client, {
    lon: ORIGIN.lon,
    lat: ORIGIN.lat,
    radiusMetres: 500,
    category,
  });
  assert.equal(
    after.issues.length,
    1,
    "the retired issue must not be listed alongside its survivor",
  );
  const { rows } = await client.query(
    "select public_reference from canonical_issue where issue_id = $1",
    [surviving],
  );
  assert.equal(after.issues[0]?.publicReference, rows[0]?.["public_reference"]);
});

// ---------------------------------------------------------------------------
// A report awaiting the citizen's answer says so (V031)
// ---------------------------------------------------------------------------

test("V031: a report with an ambiguous match reports the question awaiting an answer", async () => {
  // V031 recorded that a citizen "cannot reach it without calling the API
  // directly" — partly because nothing told the interface a question existed.
  // The report row now carries it.
  const participantId = await newParticipant();
  const { submissionId } = await newReport(participantId, undefined);
  const issueId = await newIssue(0);
  await client.query(
    `insert into issue_match
       (match_id, submission_id, attempt_number, state, candidate_issue_ids, decision_basis)
     values ($1,$2,1,'ambiguous',$3::uuid[],'{}'::jsonb)`,
    [randomUUID(), submissionId, [issueId]],
  );

  const page = await listMyReports(client, { participantId });
  const mine = page.reports.find((report) => report.submissionId === submissionId);

  assert.ok(mine !== undefined);
  assert.equal(mine.awaitingAnswerForIssueId, issueId);
});

test("V031: a report with no ambiguous match reports no question", async () => {
  const participantId = await newParticipant();
  const { submissionId } = await newReport(participantId, undefined);

  const page = await listMyReports(client, { participantId });
  const mine = page.reports.find((report) => report.submissionId === submissionId);

  assert.ok(mine !== undefined);
  assert.equal(mine.awaitingAnswerForIssueId, undefined);
});

test("V031: an already-decided match reports no question", async () => {
  // Asking again after the citizen has answered would make their answer look
  // as though it had not registered.
  const participantId = await newParticipant();
  const { submissionId } = await newReport(participantId, undefined);
  const issueId = await newIssue(0);
  await client.query(
    `insert into issue_match
       (match_id, submission_id, attempt_number, state, candidate_issue_ids,
        resulting_issue_id, decision_basis, decided_by_actor_type, decided_at)
     values ($1,$2,1,'match_confirmed',$3::uuid[],$4,'{}'::jsonb,'citizen', now())`,
    [randomUUID(), submissionId, [issueId], issueId],
  );

  const page = await listMyReports(client, { participantId });
  const mine = page.reports.find((report) => report.submissionId === submissionId);

  assert.equal(mine?.awaitingAnswerForIssueId, undefined);
});

test("V031: a superseded ambiguous match reports no question", async () => {
  // A rerun supersedes the earlier proposal. Offering the superseded one would
  // ask the citizen about a candidate the matcher has already discarded.
  const participantId = await newParticipant();
  const { submissionId } = await newReport(participantId, undefined);
  const issueId = await newIssue(0);
  await client.query(
    `insert into issue_match
       (match_id, submission_id, attempt_number, state, candidate_issue_ids,
        decision_basis, superseded_at)
     values ($1,$2,1,'ambiguous',$3::uuid[],'{}'::jsonb, now())`,
    [randomUUID(), submissionId, [issueId]],
  );

  const page = await listMyReports(client, { participantId });
  const mine = page.reports.find((report) => report.submissionId === submissionId);

  assert.equal(mine?.awaitingAnswerForIssueId, undefined);
});

test("V031: a match still being worked out asks the citizen nothing", async () => {
  // `candidates_retrieved` means the matcher found candidates and has not
  // decided whether they are ambiguous. Asking now would put a question to the
  // citizen that the system has not actually arrived at — and most of these
  // resolve without anyone being asked.
  const participantId = await newParticipant();
  const { submissionId } = await newReport(participantId, undefined);
  const issueId = await newIssue(0);
  await client.query(
    `insert into issue_match
       (match_id, submission_id, attempt_number, state, candidate_issue_ids, decision_basis)
     values ($1,$2,1,'candidates_retrieved',$3::uuid[],'{}'::jsonb)`,
    [randomUUID(), submissionId, [issueId]],
  );

  const page = await listMyReports(client, { participantId });
  const mine = page.reports.find((report) => report.submissionId === submissionId);

  assert.equal(mine?.awaitingAnswerForIssueId, undefined);
});

test("V031: an ambiguous match that already carries a decision asks nothing", async () => {
  // The schema permits `state = 'ambiguous'` with `decided_at` set, so the
  // state filter alone is not enough. Without the decision filter a citizen
  // who has answered would be asked the same question again, which reads as
  // their answer not having registered.
  const participantId = await newParticipant();
  const { submissionId } = await newReport(participantId, undefined);
  const issueId = await newIssue(0);
  await client.query(
    `insert into issue_match
       (match_id, submission_id, attempt_number, state, candidate_issue_ids,
        decision_basis, decided_by_actor_type, decided_at)
     values ($1,$2,1,'ambiguous',$3::uuid[],'{}'::jsonb,'citizen', now())`,
    [randomUUID(), submissionId, [issueId]],
  );

  const page = await listMyReports(client, { participantId });
  const mine = page.reports.find((report) => report.submissionId === submissionId);

  assert.equal(mine?.awaitingAnswerForIssueId, undefined);
});
