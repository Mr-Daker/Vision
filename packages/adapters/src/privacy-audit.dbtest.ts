/**
 * V044 sample-data privacy audit against a real database.
 *
 * Run with: npm run db:up && npm run db:migrate && npm run test:db
 *
 * The clause this file holds: **a documented sample-data audit finds no
 * undisclosed identity records or unnecessary personal information in public
 * views, model traces, logs, or repository fixtures.**
 *
 * Half of these tests plant violations before checking the real data is clean.
 * An audit that always passes is indistinguishable from one that does not run,
 * so every class it claims to detect is planted and caught here first — and
 * every planted value is invented and matches no real person.
 */

import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

import { PLANTED_PROBES, scanText, toPublicIssueView } from "@vision/domain";

import { auditSampleData } from "./privacy-audit.ts";

const DATABASE_URL =
  process.env["DATABASE_URL"] ??
  "postgresql://vision:vision_local_dev_only@127.0.0.1:5432/vision_dev";

let client: pg.Client;
const createdEvents: string[] = [];
const createdCaches: string[] = [];
const createdIssues: string[] = [];
const createdEvidence: string[] = [];
const createdSubmissions: string[] = [];
const createdParticipants: string[] = [];

const plantEvent = async (payload: Record<string, unknown>): Promise<string> => {
  const eventId = randomUUID();
  await client.query(
    `insert into status_event
       (event_id, aggregate_type, aggregate_id, aggregate_version, event_type,
        actor_type, correlation_id, occurred_at, payload_schema_version, payload)
     values ($1,'v044_probe',$2,1,'v044_probe','system_worker',$3, now(),'1.0.0',$4::jsonb)`,
    [eventId, randomUUID(), randomUUID(), JSON.stringify(payload)],
  );
  createdEvents.push(eventId);
  return eventId;
};

const plantCache = async (result: Record<string, unknown>): Promise<string> => {
  const cacheId = randomUUID();
  await client.query(
    `insert into ai_result_cache
       (cache_id, operation, input_hash, model_name, prompt_version, result)
     values ($1,'classification',$2,'v044-probe-model','v044-probe.v1',$3::jsonb)`,
    [
      cacheId,
      randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "").slice(0, 32),
      JSON.stringify(result),
    ],
  );
  createdCaches.push(cacheId);
  return cacheId;
};

const audit = () => auditSampleData(client, { asOf: new Date() });

before(async () => {
  client = new pg.Client({ connectionString: DATABASE_URL, statement_timeout: 120_000 });
  await client.connect();
});

const cleanup = async (): Promise<void> => {
  if (createdEvents.length > 0) {
    await client.query("delete from status_event where event_id = any($1::uuid[])", [
      createdEvents,
    ]);
    createdEvents.length = 0;
  }
  if (createdCaches.length > 0) {
    await client.query("delete from ai_result_cache where cache_id = any($1::uuid[])", [
      createdCaches,
    ]);
    createdCaches.length = 0;
  }
  if (createdIssues.length > 0) {
    await client.query(
      "delete from issue_evidence_link where canonical_issue_id = any($1::uuid[])",
      [createdIssues],
    );
    await client.query("delete from summary_issue_fact where issue_id = any($1::uuid[])", [
      createdIssues,
    ]);
    await client.query("delete from project_link where issue_id = any($1::uuid[])", [
      createdIssues,
    ]);
    await client.query("delete from canonical_issue where issue_id = any($1::uuid[])", [
      createdIssues,
    ]);
    createdIssues.length = 0;
  }
  if (createdEvidence.length > 0) {
    await client.query("delete from evidence_item where evidence_id = any($1::uuid[])", [
      createdEvidence,
    ]);
    createdEvidence.length = 0;
  }
  if (createdSubmissions.length > 0) {
    await client.query("delete from submission where submission_id = any($1::uuid[])", [
      createdSubmissions,
    ]);
    createdSubmissions.length = 0;
  }
  if (createdParticipants.length > 0) {
    await client.query("delete from participant where participant_id = any($1::uuid[])", [
      createdParticipants,
    ]);
    createdParticipants.length = 0;
  }
};

beforeEach(cleanup);

after(async () => {
  await cleanup();
  await client.end();
});

// ---------------------------------------------------------------------------
// The audit works
// ---------------------------------------------------------------------------

test("an email address planted in an event payload is found and named", async () => {
  const eventId = await plantEvent({ note: `contact ${PLANTED_PROBES["email_address"]}` });
  const report = await audit();

  const finding = report.findings.find((item) => item.location.includes(eventId));
  assert.notEqual(finding, undefined, "the audit did not find a planted email address");
  assert.equal(finding?.scope, "log");
  assert.equal(finding?.patternId, "email_address");
  assert.equal(report.clean, false);
});

test("a mobile number planted in outbox-adjacent payloads is found", async () => {
  const eventId = await plantEvent({ caller: PLANTED_PROBES["indian_mobile_number"] });
  const report = await audit();
  assert.ok(
    report.findings.some(
      (item) => item.location.includes(eventId) && item.patternId === "indian_mobile_number",
    ),
  );
});

test("a raw model request kept in the cache is found", async () => {
  // V005 §6 forbids storing one; the input hash identifies it already, and the
  // body is a citizen's own words.
  const cacheId = await plantCache({ request_body: { text: "invented report text" } });
  const report = await audit();
  assert.ok(
    report.findings.some(
      (item) => item.location.includes(cacheId) && item.patternId === "raw_request_body",
    ),
  );
});

test("a cleartext provider subject in a model trace is found", async () => {
  const cacheId = await plantCache({ provider_subject: "not-a-real-subject-value" });
  const report = await audit();
  assert.ok(
    report.findings.some(
      (item) => item.location.includes(cacheId) && item.patternId === "cleartext_provider_subject",
    ),
  );
});

test("a private original reference in a model trace is found", async () => {
  const cacheId = await plantCache({ source: PLANTED_PROBES["private_original_reference"] });
  const report = await audit();
  assert.ok(
    report.findings.some(
      (item) => item.location.includes(cacheId) && item.patternId === "private_original_reference",
    ),
  );
});

test("no finding reproduces the value it found", async () => {
  await plantEvent({ note: PLANTED_PROBES["email_address"] });
  await plantCache({ provider_subject: "not-a-real-subject-value" });
  const report = await audit();
  const serialised = JSON.stringify(report.findings);
  assert.doesNotMatch(serialised, /not-a-real-person/);
  assert.doesNotMatch(serialised, /not-a-real-subject-value/);
  assert.ok(report.findings.length >= 2, "and it did find them");
});

// ---------------------------------------------------------------------------
// The identity store
// ---------------------------------------------------------------------------

test("the database itself refuses a provider subject that is not a digest", async () => {
  // The audit's check is defence in depth: the constraint is what actually
  // prevents cleartext reaching the identity store.
  const participantId = randomUUID();
  await client.query("insert into participant (participant_id) values ($1)", [participantId]);
  createdParticipants.push(participantId);

  await assert.rejects(
    () =>
      client.query(
        `insert into identity_mapping
           (identity_mapping_id, participant_id, provider, provider_subject_hash, provider_mode)
         values ($1,$2,'v044-probe','not-a-real-subject','simulated')`,
        [randomUUID(), participantId],
      ),
    /identity_mapping_hash_shape_ck/,
  );
});

test("every stored identity mapping is a keyed hash or an erased tombstone", async () => {
  const report = await audit();
  const identityFindings = report.findings.filter((finding) => finding.scope === "identity_store");
  assert.deepEqual(
    identityFindings,
    [],
    "a mapping that is neither a digest nor an erasure would resolve a login to a person",
  );
  assert.ok(report.counts.identityMappings > 0, "and there were mappings to check");
});

// ---------------------------------------------------------------------------
// Public views
// ---------------------------------------------------------------------------

test("a precise location and a private original never reach the public view", async () => {
  const participantId = randomUUID();
  await client.query("insert into participant (participant_id) values ($1)", [participantId]);
  createdParticipants.push(participantId);
  const submissionId = randomUUID();
  await client.query(
    `insert into submission
       (submission_id, participant_id, observed_at, interface_locale, locale_pack_version,
        idempotency_key, taxonomy_version, processing_status)
     values ($1,$2, now(),'en-IN','v044.v1',$3,'v044.v1','accepted')`,
    [submissionId, participantId, `v044-${submissionId.slice(0, 8)}`],
  );
  createdSubmissions.push(submissionId);

  const issueId = randomUUID();
  const reference = `VIS-V044-${issueId.slice(0, 8)}`;
  await client.query(
    `insert into canonical_issue
       (issue_id, public_reference, category, current_status, opened_at, representative_location)
     values ($1,$2,'water_supply','created', now(),
             st_setsrid(st_makepoint(74.512345, 16.812345),4326)::geography)`,
    [issueId, reference],
  );
  createdIssues.push(issueId);

  const evidenceId = randomUUID();
  await client.query(
    `insert into evidence_item
       (evidence_id, submission_id, media_type, object_reference, fingerprint_hash,
        redaction_status, processing_status)
     values ($1,$2,'photo',$3,$4,'pending','usable')`,
    [
      evidenceId,
      submissionId,
      PLANTED_PROBES["private_original_reference"],
      `sha256:${evidenceId}`,
    ],
  );
  createdEvidence.push(evidenceId);
  await client.query(
    `insert into issue_evidence_link
       (issue_evidence_link_id, evidence_id, canonical_issue_id, effective_from)
     values ($1,$2,$3, now())`,
    [randomUUID(), evidenceId, issueId],
  );

  const report = await audit();
  assert.deepEqual(
    report.findings.filter((finding) => finding.location === `public_view/${reference}`),
    [],
    "the public view of an issue holding both is clean",
  );

  // And the audit would have caught them: the same record, unfiltered, is full
  // of findings. Without this the clean result above proves only that nothing
  // was there to find.
  const unfiltered = JSON.stringify({
    precise_location: { lon: 74.512345, lat: 16.812345 },
    original_object_references: [PLANTED_PROBES["private_original_reference"]],
  });
  const wouldHaveFound = scanText(unfiltered, "public_view", "unfiltered");
  assert.ok(
    wouldHaveFound.some((finding) => finding.patternId === "precise_coordinate"),
    "the scanner must be able to see a precise coordinate",
  );
  assert.ok(wouldHaveFound.some((finding) => finding.patternId === "private_original_reference"));
});

test("the public view is built by construction, so a new restricted field is excluded", async () => {
  const view = toPublicIssueView({
    issue_id: randomUUID(),
    public_reference: "VIS-V044-SHAPE",
    category: "water_supply",
    current_status: "created",
    jurisdiction_id: randomUUID(),
    precise_location: { lon: 74.512345, lat: 16.812345 },
    counted_participants: 3,
    reporter_participant_id: randomUUID(),
    original_object_references: ["originals/2026/09/x.bin"],
    raw_model_output: { anything: "at all" },
  });
  const serialised = JSON.stringify(view);
  assert.doesNotMatch(serialised, /precise_location/);
  assert.doesNotMatch(serialised, /reporter_participant_id/);
  assert.doesNotMatch(serialised, /originals\//);
  assert.doesNotMatch(serialised, /raw_model_output/);
  assert.deepEqual(scanText(serialised, "public_view", "constructed"), []);
});

// ---------------------------------------------------------------------------
// The real data
// ---------------------------------------------------------------------------

test("the sample data carries no undisclosed identity record or personal information", async () => {
  const report = await audit();
  assert.deepEqual(
    report.findings,
    [],
    `findings: ${JSON.stringify(report.findings.slice(0, 5), null, 1)}`,
  );
  assert.equal(report.clean, true);

  // And the audit actually looked at something.
  assert.ok(report.counts.publicViews > 0);
  assert.ok(report.counts.eventPayloads > 0);
  assert.ok(report.counts.modelTraces > 0);
});
