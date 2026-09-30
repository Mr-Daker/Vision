/**
 * A resident's roadmap against the real database (report roadmap design,
 * 2026-09-30).
 *
 * Run with: npm run db:up && npm run db:migrate && npm run test:db
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";

import type { AgeingPolicyPack } from "@vision/domain";

import { FilesystemObjectStoreAdapter } from "./object-store.ts";
import { readIssueRoadmap, readReportRoadmap } from "./report-roadmap.ts";
import { SubmissionService } from "./submissions.ts";

const DATABASE_URL =
  process.env["DATABASE_URL"] ??
  "postgresql://vision:vision_local_dev_only@127.0.0.1:5432/vision_dev";

const POLICY: AgeingPolicyPack = {
  version: "test-ageing.v1",
  note: "An alert means a configured promise about time has passed, and nothing more.",
  rules: { sanitation: { alertAfterDays: 7, escalateAfterDays: 14 } },
  fallback: { alertAfterDays: 21, escalateAfterDays: 42 },
};

const DAY = 86_400_000;

let client: pg.Client;
let storeRoot: string;
let service: SubmissionService;
const submissions: string[] = [];
const participants: string[] = [];
const issues: string[] = [];
/** Reference data this file creates for itself, and removes. */
const jurisdictions: string[] = [];
const responsibilities: string[] = [];

before(async () => {
  client = new pg.Client({ connectionString: DATABASE_URL, statement_timeout: 15_000 });
  await client.connect();
  storeRoot = await mkdtemp(join(tmpdir(), "vision-roadmap-"));
  const store = new FilesystemObjectStoreAdapter({
    root: storeRoot,
    grantHmacKey: "test-only-key",
  });
  service = new SubmissionService(client, store, {
    localePackVersion: "demo-locales.v1",
    taxonomyVersion: "demo-taxonomy.v1",
    supportedLocales: ["en-IN", "mr-IN"],
  });
});

after(async () => {
  for (const issueId of issues) {
    await client.query(
      "delete from status_event where aggregate_type = 'canonical_issue' and aggregate_id = $1",
      [issueId],
    );
    await client.query("delete from routing_decision where issue_id = $1", [issueId]);
    await client.query("delete from issue_evidence_link where canonical_issue_id = $1", [issueId]);
    await client.query("delete from canonical_issue where issue_id = $1", [issueId]);
  }
  for (const submissionId of submissions) {
    await client.query(
      "delete from outbox where event_id in (select event_id from status_event where aggregate_id = $1)",
      [submissionId],
    );
    await client.query("delete from status_event where aggregate_id = $1", [submissionId]);
    await client.query("delete from evidence_item where submission_id = $1", [submissionId]);
    await client.query("delete from submission where submission_id = $1", [submissionId]);
  }
  await client.query(
    "delete from responsibility_directory where responsibility_id = any($1::uuid[])",
    [responsibilities],
  );
  await client.query("delete from jurisdiction where jurisdiction_id = any($1::uuid[])", [
    jurisdictions,
  ]);
  if (participants.length > 0) {
    await client.query("delete from participant where participant_id = any($1::uuid[])", [
      participants,
    ]);
  }
  await client.end();
  await rm(storeRoot, { recursive: true, force: true });
});

const newParticipant = async (): Promise<string> => {
  const id = randomUUID();
  await client.query("insert into participant (participant_id) values ($1)", [id]);
  participants.push(id);
  return id;
};

const newReport = async (participantId: string): Promise<string> => {
  const result = await service.create(
    {
      participantId,
      observed: {
        lon: 74.56,
        lat: 16.85,
        accuracyMetres: 12,
        source: "device_geolocation",
        observedAt: new Date().toISOString(),
      },
      interfaceLocale: "en-IN",
      languageHint: "en-IN",
      text: "A deep pothole in the middle of the road.",
      evidence: [],
    },
    { idempotencyKey: `roadmap-${randomUUID()}`, correlationId: randomUUID() },
  );
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("submission failed");
  submissions.push(result.receipt.submission_id);
  return result.receipt.submission_id;
};

test("a report nobody has processed yet is at 'being checked', with no escalation", async () => {
  const participant = await newParticipant();
  const submissionId = await newReport(participant);

  const roadmap = await readReportRoadmap(client, {
    participantId: participant,
    submissionId,
    policy: POLICY,
    asOf: new Date(),
  });
  assert.ok(roadmap);
  assert.equal(roadmap.note, "being_checked");
  assert.equal(roadmap.steps[0]?.state, "done");
  assert.equal(roadmap.issue, undefined);
  assert.equal(roadmap.escalation, undefined);
});

test("a routed report shows its dated steps and the department's clock", async () => {
  const participant = await newParticipant();
  const submissionId = await newReport(participant);
  const now = Date.now();
  // Whole seconds: the event table records time to the second.
  const routedAt = new Date(Math.floor((now - 2 * DAY) / 1000) * 1000);

  const issueId = randomUUID();
  issues.push(issueId);
  const reference = `VIS-RM-${issueId.slice(0, 6).toUpperCase()}`;
  await client.query(
    `insert into canonical_issue (issue_id, public_reference, category, current_status, opened_at)
     values ($1, $2, 'sanitation', 'routed_internal', $3)`,
    [issueId, reference, routedAt],
  );
  const { rows: evidence } = await client.query(
    "select evidence_id from evidence_item where submission_id = $1 limit 1",
    [submissionId],
  );
  await client.query(
    `insert into issue_evidence_link (issue_evidence_link_id, evidence_id, canonical_issue_id, effective_from)
     values ($1, $2, $3, $4)`,
    [randomUUID(), evidence[0]?.["evidence_id"], issueId, routedAt],
  );
  // Its own department, not whatever the database happens to hold: a test
  // that needs a row from a developer's seed data passes on one machine only.
  const jurisdictionId = randomUUID();
  jurisdictions.push(jurisdictionId);
  await client.query(
    `insert into jurisdiction
       (jurisdiction_id, jurisdiction_profile_id, internal_code, directory_version,
        level_scheme, level_code, effective_from, synthetic_provenance)
     values ($1,'demo-district-a',$2,'roadmap-test.v1','test-scheme','district',
             now() - interval '1 year', true)`,
    [jurisdictionId, `rm-${jurisdictionId.slice(0, 8)}`],
  );
  const responsibilityId = randomUUID();
  responsibilities.push(responsibilityId);
  await client.query(
    `insert into responsibility_directory
       (responsibility_id, directory_version, jurisdiction_id, category,
        department_id, department_label, provider_mode, effective_from)
     values ($1,'roadmap-test.v1',$2,'sanitation','demo-sanitation','Sanitation (simulated)','simulated', now())`,
    [responsibilityId, jurisdictionId],
  );
  const directory = { responsibility_id: responsibilityId, department_id: "demo-sanitation" };
  await client.query(
    `insert into routing_decision
       (routing_id, issue_id, directory_version, category, recipient_mode, outcome, reason,
        decided_at, department_id, responsibility_id)
     values ($1, $2, 'test', 'sanitation', 'simulated', 'routed', 'test routing', $3, $4, $5)`,
    [randomUUID(), issueId, routedAt, directory.department_id, directory.responsibility_id],
  );
  await client.query(
    `insert into status_event
       (event_id, aggregate_type, aggregate_id, aggregate_version, event_type, actor_type,
        correlation_id, occurred_at, payload_schema_version)
     values ($1, 'canonical_issue', $2, 1, 'routed_internal', 'system_worker', $3, $4, '1.0.0')`,
    [randomUUID(), issueId, randomUUID(), routedAt],
  );

  const roadmap = await readReportRoadmap(client, {
    participantId: participant,
    submissionId,
    policy: POLICY,
    asOf: new Date(now),
  });
  assert.ok(roadmap);
  assert.equal(roadmap.issue?.publicReference, reference);
  assert.equal(roadmap.note, "with_department");
  const routed = roadmap.steps.find((step) => step.id === "routed");
  assert.equal(routed?.state, "done");
  assert.equal(routed?.at, routedAt.toISOString());

  assert.ok(roadmap.escalation, "a department is responsible, so its clock is shown");
  assert.equal(roadmap.escalation.departmentDays, 2);
  assert.equal(roadmap.escalation.alertAfterDays, 7);
  assert.equal(roadmap.escalation.flagDueAt, new Date(routedAt.getTime() + 7 * DAY).toISOString());
  assert.equal(roadmap.escalation.flaggedAt, undefined);

  // The public issue page reads the same clock, so the two can never disagree.
  const publicRoadmap = await readIssueRoadmap(client, {
    issueId,
    policy: POLICY,
    asOf: new Date(now),
  });
  assert.ok(publicRoadmap);
  assert.equal(publicRoadmap.note, "with_department");
  assert.deepEqual(publicRoadmap.escalation, roadmap.escalation);
});

test("somebody else's report is indistinguishable from one that does not exist", async () => {
  const owner = await newParticipant();
  const stranger = await newParticipant();
  const submissionId = await newReport(owner);
  assert.equal(
    await readReportRoadmap(client, {
      participantId: stranger,
      submissionId,
      policy: POLICY,
      asOf: new Date(),
    }),
    undefined,
  );
});
