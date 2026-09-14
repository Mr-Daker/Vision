/**
 * The handlers that make a submitted report actually get processed
 * (roadmap V021, V022, V026–V033).
 *
 * Run with: npm run db:up && npm run db:migrate && npm run test:db
 *
 * This is the end-to-end claim: a report arrives, the relay picks up the work
 * the submission enqueued, and by the time the backlog is empty the report has
 * an issue, a routing decision, a counted contributor and a stored trust
 * report. Before this, all of that machinery existed and none of it ran.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";

import { FilesystemObjectStoreAdapter, recordConsent } from "@vision/adapters";

import { buildStageHandlers } from "./handlers.ts";
import { runRelayOnce } from "./relay.ts";

const DATABASE_URL =
  process.env["DATABASE_URL"] ??
  "postgresql://vision:vision_local_dev_only@127.0.0.1:5432/vision_dev";

/**
 * A fresh origin per report group, ~5 km apart.
 *
 * Reports at a shared point are candidates for each other *and* for whatever
 * earlier runs left in this database, so a test at a fixed origin measures the
 * leftovers rather than its own behaviour. Two reports that are meant to match
 * share an origin explicitly.
 */
let originSeed = 0;
const nextOrigin = (): { lon: number; lat: number } => {
  originSeed += 1;
  return { lon: 76.31 + originSeed * 0.05, lat: 18.31 + originSeed * 0.05 };
};
const CATEGORY = "sanitation";
const DIRECTORY = "demo-routing.v1";

let client: pg.Client;
let store: FilesystemObjectStoreAdapter;
let root: string;
let jurisdictionId: string;
const participants: string[] = [];
const submissions: string[] = [];
const issues: string[] = [];
const events: string[] = [];
const responsibilities: string[] = [];

const BOUNDS = {
  version: "worker-test-matching.v1",
  baseRadiusMetres: 150,
  timeWindowHours: 24 * 90,
  note: "test bounds, not calibrated",
};

before(async () => {
  client = new pg.Client({ connectionString: DATABASE_URL, statement_timeout: 20_000 });
  await client.connect();
  root = await mkdtemp(join(tmpdir(), "vision-worker-"));
  store = new FilesystemObjectStoreAdapter({
    root,
    grantHmacKey: "worker-test-only-grant-key",
  });

  jurisdictionId = randomUUID();
  await client.query(
    `insert into jurisdiction
       (jurisdiction_id, jurisdiction_profile_id, internal_code, directory_version,
        level_scheme, level_code, effective_from, synthetic_provenance)
     values ($1,'demo-district-a',$2,$3,'test-scheme','district',
             now() - interval '1 year', true)`,
    [jurisdictionId, `wk-${jurisdictionId.slice(0, 8)}`, DIRECTORY],
  );
  const responsibilityId = randomUUID();
  await client.query(
    `insert into responsibility_directory
       (responsibility_id, directory_version, jurisdiction_id, category,
        department_id, department_label, provider_mode, effective_from)
     values ($1,$2,$3,$4,'demo-sanitation','Sanitation (simulated)','simulated', now())`,
    [responsibilityId, DIRECTORY, jurisdictionId, CATEGORY],
  );
  responsibilities.push(responsibilityId);

  // Tasks from an earlier aborted run whose submission has since been cleaned
  // up. They are genuinely dead — nothing can ever process them — and left in
  // place they are claimed by this file's relay passes and fail there, which
  // reads as a defect in whichever test ran last.
  await client.query(
    `delete from outbox o
      where o.delivered_at is null
        and o.task_type in ('process_submission_media','match_submission')
        and o.payload ? 'submission_id'
        and not exists (
          select 1 from submission s
           where s.submission_id = (o.payload->>'submission_id')::uuid
        )`,
  );
});

after(async () => {
  await client.end().catch(() => undefined);
  const cleaner = new pg.Client({ connectionString: DATABASE_URL, statement_timeout: 15_000 });
  await cleaner.connect();
  try {
    // Cleaned by aggregate, not by the ids this file recorded: the relay
    // creates its own chained events (`submission_media_processed`), and their
    // outbox rows would otherwise keep the events alive and fail the delete.
    if (submissions.length > 0) {
      await cleaner.query(
        `delete from outbox where event_id in (
           select event_id from status_event where aggregate_id = any($1::text[]))`,
        [submissions],
      );
    }
    if (events.length > 0) {
      await cleaner.query("delete from outbox where event_id = any($1::uuid[])", [events]);
    }
    if (submissions.length > 0) {
      // Retrieval logs its query per submission (V026), and embeddings are
      // stored per submission (V025/V026) — both reference it.
      await cleaner.query("delete from candidate_query_log where submission_id = any($1::uuid[])", [
        submissions,
      ]);
      await cleaner
        .query("delete from submission_embedding where submission_id = any($1::uuid[])", [
          submissions,
        ])
        .catch(() => undefined);
      await cleaner.query("delete from trust_signal_report where submission_id = any($1::uuid[])", [
        submissions,
      ]);
      await cleaner.query(
        "delete from classification_proposal where submission_id = any($1::uuid[])",
        [submissions],
      );
      // Evidence links reference the match that produced them, so the links
      // go first — otherwise this fails with an FK violation attributed to
      // whichever test happened to run last.
      await cleaner.query(
        "delete from issue_evidence_link where evidence_id in (select evidence_id from evidence_item where submission_id = any($1::uuid[]))",
        [submissions],
      );
      await cleaner.query("delete from issue_match where submission_id = any($1::uuid[])", [
        submissions,
      ]);
      await cleaner.query("delete from processing_stage where submission_id = any($1::uuid[])", [
        submissions,
      ]);
      await cleaner.query(
        "delete from issue_evidence_link where evidence_id in (select evidence_id from evidence_item where submission_id = any($1::uuid[]))",
        [submissions],
      );
      await cleaner.query("delete from evidence_item where submission_id = any($1::uuid[])", [
        submissions,
      ]);
    }
    if (issues.length > 0) {
      await cleaner.query("delete from routing_decision where issue_id = any($1::uuid[])", [
        issues,
      ]);
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
    // Keyed on the jurisdiction this file created rather than on the issues it
    // happened to look up: every issue in it belongs to this file, and a test
    // that never called `issueOf` still opened one.
    const { rows: mine } = await cleaner.query(
      "select issue_id from canonical_issue where jurisdiction_id = $1",
      [jurisdictionId],
    );
    const allIssues = [...new Set([...issues, ...mine.map((row) => String(row["issue_id"]))])];
    if (allIssues.length > 0) {
      await cleaner.query("delete from routing_decision where issue_id = any($1::uuid[])", [
        allIssues,
      ]);
      await cleaner.query(
        "delete from issue_participation where canonical_issue_id = any($1::uuid[])",
        [allIssues],
      );
      await cleaner.query(
        "delete from issue_evidence_link where canonical_issue_id = any($1::uuid[])",
        [allIssues],
      );
      await cleaner.query(
        `delete from outbox where event_id in (
           select event_id from status_event where aggregate_id = any($1::text[]))`,
        [allIssues],
      );
      await cleaner.query("delete from status_event where aggregate_id = any($1::text[])", [
        allIssues,
      ]);
      await cleaner.query("delete from canonical_issue where issue_id = any($1::uuid[])", [
        allIssues,
      ]);
    }
    if (events.length > 0) {
      await cleaner.query("delete from status_event where event_id = any($1::uuid[])", [events]);
    }
    if (submissions.length > 0) {
      await cleaner.query("delete from status_event where aggregate_id = any($1::text[])", [
        submissions,
      ]);
    }
    if (participants.length > 0) {
      await cleaner.query("delete from consent_record where participant_id = any($1::uuid[])", [
        participants,
      ]);
      await cleaner.query(
        "delete from issue_participation where participant_id = any($1::uuid[])",
        [participants],
      );
      await cleaner.query("delete from participant where participant_id = any($1::uuid[])", [
        participants,
      ]);
    }
    if (responsibilities.length > 0) {
      // Routing decisions reference the directory entry they used. Keyed on the
      // entry rather than on the issues this file happened to collect, because
      // a test that did not look up its issue still produced a route.
      await cleaner.query(
        "delete from routing_decision where responsibility_id = any($1::uuid[])",
        [responsibilities],
      );
      await cleaner.query(
        "delete from responsibility_directory where responsibility_id = any($1::uuid[])",
        [responsibilities],
      );
    }
    await cleaner.query("delete from jurisdiction where jurisdiction_id = $1", [jurisdictionId]);
  } finally {
    await cleaner.end();
  }
  await rm(root, { recursive: true, force: true });
});

/** A text report, with the first event and the media task the API writes. */
const arrivingReport = async (
  text?: string,
  origin: { lon: number; lat: number } = nextOrigin(),
): Promise<string> => {
  const participantId = randomUUID();
  await client.query("insert into participant (participant_id) values ($1)", [participantId]);
  participants.push(participantId);
  await recordConsent(client, {
    participantId,
    noticeVersion: "demo-notice.v1",
    noticeLocale: "en-IN",
    grantedPurposes: ["demo_processing"],
  });

  const submissionId = randomUUID();
  await client.query(
    `insert into submission
       (submission_id, participant_id, observed_location, observed_accuracy_m,
        observed_location_source, observed_at, interface_locale, language_hint,
        locale_pack_version, taxonomy_version, idempotency_key)
     values ($1,$2, ST_SetSRID(ST_MakePoint($3,$4),4326)::geography, 12,
             'device_geolocation', now(), 'en-IN','en-IN',
             'demo-locales.v1','demo-taxonomy.v1',$5)`,
    [submissionId, participantId, origin.lon, origin.lat, `wk-${submissionId}`],
  );
  submissions.push(submissionId);
  await client.query(
    `insert into evidence_item (evidence_id, submission_id, media_type, content_text)
     values ($1,$2,'text',$3)`,
    [randomUUID(), submissionId, text ?? `The drain by the gate is blocked ${randomUUID()}`],
  );

  const eventId = randomUUID();
  await client.query(
    `insert into status_event
       (event_id, aggregate_type, aggregate_id, aggregate_version, event_type,
        actor_type, actor_pseudonym, correlation_id, occurred_at, payload_schema_version, payload)
     values ($1,'Submission',$2,1,'submission_received','citizen',$3,$4, now(),'v1','{}'::jsonb)`,
    [eventId, submissionId, participantId, randomUUID()],
  );
  events.push(eventId);
  await client.query(
    "insert into outbox (event_id, task_type, payload) values ($1,'process_submission_media',$2::jsonb)",
    [eventId, JSON.stringify({ submission_id: submissionId })],
  );
  return submissionId;
};

/**
 * A deterministic stand-in for the embedding provider.
 *
 * Identical text gives an identical vector, so two reports in the same words
 * are semantically identical and different words are far apart. That is the
 * property matching depends on, and it makes the duplicate path testable
 * without an API key.
 */
const deterministicEmbed = async (text: string) => {
  const digest = createHash("sha256").update(text.trim().toLowerCase()).digest();
  // 3072 dimensions, because that is what the schema stores — the column is
  // `vector(3072)`, sized for gemini-embedding-001, and a shorter vector is
  // rejected outright rather than padded.
  const vector = Array.from({ length: 3072 }, (_, index) => (digest[index % 32] ?? 0) / 255 - 0.5);
  const norm = Math.sqrt(vector.reduce((total, value) => total + value * value, 0)) || 1;
  return {
    vector: vector.map((value) => value / norm),
    model: "deterministic-test-embedder",
    dimensions: 3072,
    normalized: true,
  };
};

/** Drains the backlog the way a running worker would, with a bounded number of passes. */
const drain = async (options: { readonly withEmbedder?: boolean } = {}): Promise<void> => {
  const handlers = buildStageHandlers({
    client,
    objectStore: store,
    ...(options.withEmbedder === false ? {} : { embed: deterministicEmbed }),
    jurisdictionId,
    fallbackCategory: CATEGORY,
    directoryVersion: DIRECTORY,
    bounds: BOUNDS,
    taxonomy: { version: "demo-taxonomy.v1", categoryIds: [CATEGORY], defectIds: ["blockage"] },
  });
  // Failures are retried rather than treated as fatal, because that is what a
  // running relay does. V028 legitimately refuses a decision whose candidate
  // set moved between the proposal and the transactional recheck — "the
  // decision must be rerun" — and the rerun is exactly what the outbox
  // backoff provides. Asserting no failure ever occurs would be asserting that
  // concurrency never happens.
  const failures: string[] = [];
  for (let pass = 0; pass < 12; pass += 1) {
    const result = await runRelayOnce(client, {
      handlers,
      claimedBy: `worker-test:${randomUUID().slice(0, 8)}`,
      limit: 20,
      taskTypes: ["process_submission_media", "match_submission"],
    });
    assert.equal(result.unhandled, 0, `unhandled task types: ${result.notes.join("; ")}`);
    failures.push(...(result.failed > 0 ? result.notes : []));
    if (result.claimed === 0) return;
    if (result.failed > 0) {
      // Bring the backoff forward so the retry happens inside the test rather
      // than seconds later.
      await client.query(
        "update outbox set not_before = now() where event_id = any($1::uuid[]) and delivered_at is null",
        [events],
      );
    }
  }
  assert.fail(`the backlog did not drain in 12 passes: ${failures.join("; ")}`);
};

const issueOf = async (submissionId: string): Promise<string | undefined> => {
  const { rows } = await client.query(
    `select link.canonical_issue_id
       from issue_evidence_link link
       join evidence_item e on e.evidence_id = link.evidence_id
      where e.submission_id = $1 and link.effective_to is null
      limit 1`,
    [submissionId],
  );
  const id = rows[0]?.["canonical_issue_id"];
  if (id !== undefined && id !== null) issues.push(String(id));
  return id === undefined || id === null ? undefined : String(id);
};

// ---------------------------------------------------------------------------

test("V017: a report that arrives is processed into an issue without anyone calling a stage", async () => {
  // The whole point. Before this the submission was stored, a receipt was
  // returned, and the enqueued work sat in `outbox` forever.
  const submissionId = await arrivingReport();

  await drain();

  const issueId = await issueOf(submissionId);
  assert.ok(issueId !== undefined, "the report should have been grouped into an issue");
  const { rows } = await client.query(
    "select current_status, category from canonical_issue where issue_id = $1",
    [issueId],
  );
  assert.equal(rows[0]?.["category"], CATEGORY);
});

test("V017: the processed report is routed to a simulated owner", async () => {
  const submissionId = await arrivingReport();

  await drain();

  const issueId = await issueOf(submissionId);
  const { rows } = await client.query(
    "select outcome, department_id, recipient_mode from routing_decision where issue_id = $1",
    [issueId],
  );
  assert.equal(rows[0]?.["outcome"], "routed");
  assert.equal(rows[0]?.["department_id"], "demo-sanitation");
  // Never `real`: no relationship with any authority exists (V004 §5, V010).
  assert.equal(rows[0]?.["recipient_mode"], "simulated");
});

test("V017: the reporter is counted once, and the trust checks are stored", async () => {
  const submissionId = await arrivingReport();

  await drain();

  const issueId = await issueOf(submissionId);
  const { rows: counted } = await client.query(
    "select count(*)::int as n from issue_participation where canonical_issue_id = $1 and counted",
    [issueId],
  );
  assert.equal(counted[0]?.["n"], 1);
  const { rows: trust } = await client.query(
    "select requires_review from trust_signal_report where submission_id = $1",
    [submissionId],
  );
  assert.equal(trust.length, 1);
  assert.equal(trust[0]?.["requires_review"], false);
});

test("V017: the backlog empties, so nothing is left stuck", async () => {
  const submissionId = await arrivingReport();

  await drain();

  const { rows } = await client.query(
    `select count(*)::int as n from outbox
      where delivered_at is null and terminal_failure_reason is null
        and event_id = any($1::uuid[])`,
    [events],
  );
  assert.equal(rows[0]?.["n"], 0, "every task this report enqueued was delivered");
  void submissionId;
});

test("V017: a second report of the same problem joins the first issue", async () => {
  // The end-to-end duplicate path: two reports, one issue, two counted
  // contributors — which is the whole reason matching exists.
  const words = `the drain by the gate is blocked and smells ${randomUUID()}`;
  const spot = nextOrigin();
  const first = await arrivingReport(words, spot);
  await drain();
  const firstIssue = await issueOf(first);

  const second = await arrivingReport(words, spot);
  await drain();
  const secondIssue = await issueOf(second);

  assert.equal(secondIssue, firstIssue);
  const { rows } = await client.query(
    "select count(*)::int as n from issue_participation where canonical_issue_id = $1 and counted",
    [firstIssue],
  );
  assert.equal(rows[0]?.["n"], 2);
});

test("V017: with no embedder configured, duplicates are never grouped", async () => {
  // Not a defect — the domain says it outright: "no semantic comparison was
  // available, and proximity on its own is not enough to call two reports the
  // same problem" (V027). Two people standing in the same place may be
  // reporting two different things.
  //
  // But the operational consequence is large and worth a test of its own: a
  // deployment with no embedding provider gets one issue per report, and
  // duplicate detection does not merely degrade, it does not happen. The
  // embedder is effectively required for the feature to exist.
  const words = `the same words with no embedder ${randomUUID()}`;
  const spot = nextOrigin();
  const first = await arrivingReport(words, spot);
  await drain({ withEmbedder: false });
  const firstIssue = await issueOf(first);

  const second = await arrivingReport(words, spot);
  await drain({ withEmbedder: false });
  const secondIssue = await issueOf(second);

  assert.notEqual(secondIssue, firstIssue);
  const { rows } = await client.query(
    `select m.state, m.decision_basis from issue_match m where m.submission_id = $1`,
    [second],
  );
  assert.equal(rows[0]?.["state"], "no_match");
  const reasons = ((rows[0]?.["decision_basis"] as { reasons?: string[] }).reasons ?? []).join(" ");
  assert.match(reasons, /no semantic comparison was available/);
});

test("V017: running the relay twice over the same report changes nothing", async () => {
  // Duplicate delivery is normal, not exceptional (V017). The stage lease
  // makes the second pass a no-op rather than a second issue.
  const submissionId = await arrivingReport();
  await drain();
  const issueId = await issueOf(submissionId);

  // Re-deliver every task for this report, as a crash before acknowledgment
  // would.
  await client.query(
    `update outbox set delivered_at = null, claimed_at = null, claimed_by = null, not_before = now()
      where event_id = any($1::uuid[])`,
    [events],
  );
  await drain();

  const { rows } = await client.query(
    `select count(distinct link.canonical_issue_id)::int as n
       from issue_evidence_link link
       join evidence_item e on e.evidence_id = link.evidence_id
      where e.submission_id = $1 and link.effective_to is null`,
    [submissionId],
  );
  assert.equal(rows[0]?.["n"], 1, "still exactly one issue");
  const { rows: counted } = await client.query(
    "select count(*)::int as n from issue_participation where canonical_issue_id = $1",
    [issueId],
  );
  assert.equal(counted[0]?.["n"], 1, "the contributor is still counted once");
});

test("V017: a re-delivered match task is acknowledged, not refused", async () => {
  // The stage lease makes the second delivery a no-op and reports
  // `already_processed`. Treating that as a refusal would have the relay back
  // off and eventually mark the task terminal — recording a permanent failure
  // for work that actually succeeded.
  const submissionId = await arrivingReport();
  await drain();

  const handlers = buildStageHandlers({
    client,
    objectStore: store,
    embed: deterministicEmbed,
    jurisdictionId,
    fallbackCategory: CATEGORY,
    directoryVersion: DIRECTORY,
    bounds: BOUNDS,
    taxonomy: { version: "demo-taxonomy.v1", categoryIds: [CATEGORY], defectIds: ["blockage"] },
  });
  const handler = handlers["match_submission"];
  assert.ok(handler !== undefined);

  const outcome = await handler(
    {
      outboxId: "1",
      eventId: randomUUID(),
      taskType: "match_submission",
      payload: { submission_id: submissionId },
      attempts: 1,
    },
    { enqueueNext: async () => ({ eventId: randomUUID() }) },
  );

  assert.equal(outcome.outcome, "already_processed");
});

test("V017: a task with the payload the API actually writes is still processed", async () => {
  // Found by running the real thing. `submissions.ts` enqueues
  // `[{ task_type: "process_submission_media" }]` — with **no payload** — and
  // this file's fixture supplied a `submission_id` because that is what I
  // assumed it wrote. So the handler required a field that never arrives, and
  // every real report was refused with "the task carries no submission_id"
  // while the suite stayed green.
  //
  // The event is the authority: `status_event.aggregate_id` for a Submission
  // event *is* the submission. Resolving from there also works for rows
  // already sitting in the queue, which changing the producer alone would not.
  const submissionId = await arrivingReport();
  await client.query(
    `update outbox set payload = '{}'::jsonb
      where task_type = 'process_submission_media'
        and event_id in (select event_id from status_event where aggregate_id = $1)`,
    [submissionId],
  );

  await drain();

  const issueId = await issueOf(submissionId);
  assert.ok(issueId !== undefined, "a report whose task carries no payload must still be grouped");
});
