/**
 * The matching pipeline, wired end to end (closes the "not wired" gaps
 * recorded in V026, V027, V028, V029, V031 and V033).
 *
 * Run with: npm run db:up && npm run db:migrate && npm run test:db
 *
 * Each stage was verified on its own; none of them was ever called by
 * anything. This is the stage that calls them in order — retrieve candidates,
 * propose, commit, count the contributor, route — inside one V017 lease so a
 * duplicate delivery is harmless and a crash is recoverable.
 *
 * Expensive work stays outside the transaction: embedding and classification
 * happen before the short transactional commit, which is what V028's strategy
 * depends on.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

import {
  runMatchingStage,
  type ClassifyText,
  MATCHING_STAGE,
  MATCHING_PIPELINE_VERSION,
} from "./matching-pipeline.ts";

const DATABASE_URL =
  process.env["DATABASE_URL"] ??
  "postgresql://vision:vision_local_dev_only@127.0.0.1:5432/vision_dev";

let client: pg.Client;
let jurisdictionId: string;
const issues: string[] = [];
const submissions: string[] = [];
const participants: string[] = [];
const responsibilities: string[] = [];

/**
 * Each test works at its own location, several kilometres from the others.
 *
 * Without this, an issue opened by one test is a candidate for the next: the
 * pipeline would attach where the test expected it to create, which says
 * nothing about the pipeline and everything about the fixtures.
 */
let originIndex = 0;
const nextOrigin = (): { lon: number; lat: number } => {
  originIndex += 1;
  return { lon: 75.61 + originIndex * 0.05, lat: 17.81 };
};
const DIRECTORY = "demo-routing.v1";
const CATEGORY = "sanitation";
const DEPARTMENT = "water-works";

const TAXONOMY = {
  version: "demo-taxonomy.v1",
  categoryIds: [CATEGORY, "structural"],
  defectIds: ["blockage", "leak", "crack"],
};

/** A deterministic 3072-wide unit vector, so no provider is needed. */
const vectorFor = (seed: number): readonly number[] => {
  const raw = Array.from({ length: 3072 }, (_v, index) => Math.sin((index + 1) * seed));
  const norm = Math.sqrt(raw.reduce((sum, value) => sum + value * value, 0));
  return raw.map((value) => value / norm);
};

const TEST_BOUNDS = {
  version: "test-matching.v1",
  baseRadiusMetres: 150,
  timeWindowHours: 24 * 90,
  note: "test bounds, not calibrated",
};

const stageOptions = (overrides: Record<string, unknown> = {}) => ({
  taxonomy: TAXONOMY,
  bounds: TEST_BOUNDS,
  directoryVersion: DIRECTORY,
  fallbackCategory: CATEGORY,
  embed: async (text: string) => ({
    vector: vectorFor(text.length % 7 === 0 ? 0.5 : 0.5),
    model: "test-embedding-model",
    dimensions: 3072,
    normalized: true,
  }),
  ...overrides,
});

before(async () => {
  client = new pg.Client({ connectionString: DATABASE_URL, statement_timeout: 15_000 });
  await client.connect();
  jurisdictionId = randomUUID();
  await client.query(
    `insert into jurisdiction
       (jurisdiction_id, jurisdiction_profile_id, internal_code, directory_version,
        level_scheme, level_code, effective_from, synthetic_provenance)
     values ($1,'test-profile',$2,$3,'test-scheme','district',
             now() - interval '1 year', true)`,
    [jurisdictionId, `code-${jurisdictionId.slice(0, 8)}`, DIRECTORY],
  );
  const responsibilityId = randomUUID();
  await client.query(
    `insert into responsibility_directory
       (responsibility_id, directory_version, jurisdiction_id, category,
        department_id, department_label, provider_mode, effective_from)
     values ($1,$2,$3,$4,$5,'Water Works (simulated)','simulated', now() - interval '1 day')`,
    [responsibilityId, DIRECTORY, jurisdictionId, CATEGORY, DEPARTMENT],
  );
  responsibilities.push(responsibilityId);
});

after(async () => {
  await client.end().catch(() => undefined);
  const cleaner = new pg.Client({ connectionString: DATABASE_URL, statement_timeout: 10_000 });
  await cleaner.connect();
  try {
    if (submissions.length > 0) {
      await cleaner.query("delete from trust_signal_report where submission_id = any($1::uuid[])", [
        submissions,
      ]);
      await cleaner.query(
        "delete from classification_proposal where submission_id = any($1::uuid[])",
        [submissions],
      );
      await cleaner.query("delete from candidate_query_log where submission_id = any($1::uuid[])", [
        submissions,
      ]);
      await cleaner.query(
        "delete from submission_embedding where submission_id = any($1::uuid[])",
        [submissions],
      );
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
      await cleaner.query("delete from evidence_item where submission_id = any($1::uuid[])", [
        submissions,
      ]);
    }
    if (issues.length > 0) {
      await cleaner.query("delete from routing_decision where issue_id = any($1::uuid[])", [
        issues,
      ]);
      await cleaner.query("delete from jurisdiction_resolution where issue_id = any($1::uuid[])", [
        issues,
      ]);
      await cleaner.query(
        "delete from issue_participation where canonical_issue_id = any($1::uuid[])",
        [issues],
      );
    }
    if (submissions.length > 0) {
      await cleaner.query(
        "delete from jurisdiction_resolution where submission_id = any($1::uuid[])",
        [submissions],
      );
      await cleaner.query("delete from submission where submission_id = any($1::uuid[])", [
        submissions,
      ]);
    }
    const { rows: scopedIssues } = await cleaner.query(
      "select issue_id from canonical_issue where jurisdiction_id = $1",
      [jurisdictionId],
    );
    const allIssues = [
      ...new Set([...issues, ...scopedIssues.map((row) => String(row["issue_id"]))]),
    ];
    if (allIssues.length > 0) {
      await cleaner.query("delete from routing_decision where issue_id = any($1::uuid[])", [
        allIssues,
      ]);
      await cleaner.query("delete from jurisdiction_resolution where issue_id = any($1::uuid[])", [
        allIssues,
      ]);
      await cleaner.query(
        "delete from issue_participation where canonical_issue_id = any($1::uuid[])",
        [allIssues],
      );
      await cleaner.query("delete from status_event where aggregate_id = any($1::text[])", [
        allIssues,
      ]);
      await cleaner.query("delete from canonical_issue where issue_id = any($1::uuid[])", [
        allIssues,
      ]);
    }
    if (responsibilities.length > 0) {
      // A test that completed routing but returned before collecting its issue
      // can still leave a decision pointing at this file's synthetic owner.
      // Delete by the direct responsibility FK as well as by the tracked issue
      // list so cleanup is independent of assertion control flow.
      await cleaner.query(
        "delete from routing_decision where responsibility_id = any($1::uuid[])",
        [responsibilities],
      );
      await cleaner.query(
        "delete from responsibility_directory where responsibility_id = any($1::uuid[])",
        [responsibilities],
      );
    }
    if (participants.length > 0) {
      // Participation rows are also deleted per-issue above, but a test whose
      // issue was created by the pipeline and not recorded in `issues` would
      // leave one behind — and the failure then surfaces as an FK violation in
      // this hook, which is reported *after* the test that caused it and looks
      // like an unrelated flake. Deleting by the direct FK too makes cleanup
      // independent of how carefully each test tracked its issues.
      await cleaner.query(
        "delete from issue_participation where participant_id = any($1::uuid[])",
        [participants],
      );
      // Consent rows reference the participant, so they go first.
      await cleaner.query("delete from consent_record where participant_id = any($1::uuid[])", [
        participants,
      ]);
      await cleaner.query("delete from participant where participant_id = any($1::uuid[])", [
        participants,
      ]);
    }
    await cleaner.query("delete from jurisdiction where jurisdiction_id = $1", [jurisdictionId]);
  } finally {
    await cleaner.end();
  }
});

/**
 * A participant who has granted processing consent.
 *
 * Required, not incidental: V014's eligibility rules need `demo_processing`,
 * so a participant without a consent record is recorded but *not counted*.
 * Wiring those rules is what revealed that nothing in the system wrote a
 * consent record at all.
 */
const newParticipant = async (options: { readonly consented?: boolean } = {}): Promise<string> => {
  const id = randomUUID();
  await client.query("insert into participant (participant_id) values ($1)", [id]);
  participants.push(id);
  if (options.consented !== false) {
    await client.query(
      `insert into consent_record
         (consent_id, participant_id, notice_version, notice_locale,
          granted_purposes, granted_at)
       values ($1,$2,'notice.v1','en-IN', ARRAY['demo_processing']::text[], now())`,
      [randomUUID(), id],
    );
  }
  return id;
};

const newSubmission = async (options: {
  readonly origin: { lon: number; lat: number };
  readonly metresEast?: number;
  readonly text?: string;
  readonly participantId?: string;
  /** How long before now the problem was observed. Defaults to now. */
  readonly observedHoursAgo?: number;
  /** A typed position rather than a device measurement. */
  readonly manualPin?: boolean;
}): Promise<{ submissionId: string; participantId: string }> => {
  const participantId = options.participantId ?? (await newParticipant());
  const submissionId = randomUUID();
  const lon =
    options.origin.lon +
    (options.metresEast ?? 0) / (111_320 * Math.cos((options.origin.lat * Math.PI) / 180));
  await client.query(
    `insert into submission
       (submission_id, participant_id, observed_location, observed_accuracy_m,
        observed_location_source, observed_at, interface_locale, language_hint,
        locale_pack_version, taxonomy_version, idempotency_key)
     values ($1,$2, ST_SetSRID(ST_MakePoint($3,$4),4326)::geography,
             case when $6 then null else 12 end,
             case when $6 then 'manual_pin' else 'device_geolocation' end,
             now() - ($7::numeric * interval '1 hour'), 'en-IN','en-IN',
             'demo-locales.v1','demo-taxonomy.v1',$5)`,
    [
      submissionId,
      participantId,
      lon,
      options.origin.lat,
      `mp-${submissionId}`,
      options.manualPin === true,
      options.observedHoursAgo ?? 0,
    ],
  );
  submissions.push(submissionId);
  await client.query(
    `insert into evidence_item (evidence_id, submission_id, media_type, content_text)
     values ($1,$2,'text',$3)`,
    [randomUUID(), submissionId, options.text ?? "The drain outside the school gate is blocked."],
  );
  return { submissionId, participantId };
};

/** A usable photograph on a submission, optionally sharing bytes with another. */
const photoOn = async (
  submissionId: string,
  fingerprintHash: string,
  options: { readonly capturedHoursAgo?: number } = {},
): Promise<string> => {
  const evidenceId = randomUUID();
  await client.query(
    `insert into evidence_item
       (evidence_id, submission_id, media_type, object_reference, fingerprint_hash,
        redaction_status, derivative_reference, processing_status, captured_at)
     values ($1,$2,'photo',$3,$4,'approved',$5,'usable',
             case when $6::numeric is null then null
                  else now() - ($6::numeric * interval '1 hour') end)`,
    [
      evidenceId,
      submissionId,
      `originals/t/${randomUUID()}`,
      fingerprintHash,
      `derivatives/t/${randomUUID()}`,
      options.capturedHoursAgo ?? null,
    ],
  );
  return evidenceId;
};

const collect = (issueId: string | undefined): void => {
  if (issueId !== undefined && !issues.includes(issueId)) issues.push(issueId);
};

// ---------------------------------------------------------------------------
// The chain runs
// ---------------------------------------------------------------------------

test("PIPE: a first report opens an issue, counts its reporter and routes it", async () => {
  const { submissionId } = await newSubmission({ origin: nextOrigin() });

  const result = await runMatchingStage(client, {
    submissionId,
    jurisdictionId,
    ...stageOptions(),
  });

  assert.equal(result.status, "completed");
  if (result.status !== "completed") return;
  collect(result.issueId);

  // V028 committed a new issue...
  assert.equal(result.assignment, "created");
  // ...V029 counted the reporter once...
  const counted = await client.query(
    "select count(*)::int as n from issue_participation where canonical_issue_id = $1 and counted = true",
    [result.issueId],
  );
  assert.equal(counted.rows[0]?.["n"], 1);
  // ...and V033 routed it, recording the directory version it used.
  assert.equal(result.routing?.outcome, "routed");
  const routed = await client.query(
    "select directory_version, department_id, recipient_mode from routing_decision where issue_id = $1",
    [result.issueId],
  );
  assert.equal(routed.rows[0]?.["directory_version"], DIRECTORY);
  assert.equal(routed.rows[0]?.["department_id"], DEPARTMENT);
  assert.equal(routed.rows[0]?.["recipient_mode"], "simulated");
});

test("V033 PIPE: location resolution scopes the issue and is linked to its route", async () => {
  const { submissionId } = await newSubmission({ origin: nextOrigin() });
  const result = await runMatchingStage(client, {
    submissionId,
    jurisdictionId: undefined,
    ...stageOptions({
      resolveJurisdiction: async () => ({
        outcome: "resolved" as const,
        profileId: "test-profile",
        boundaryVersion: DIRECTORY,
        method: "point_in_versioned_boundary" as const,
        selected: {
          jurisdictionId,
          internalCode: `code-${jurisdictionId.slice(0, 8)}`,
          levelCode: "district",
          depth: 0,
        },
        candidates: [
          {
            jurisdictionId,
            internalCode: `code-${jurisdictionId.slice(0, 8)}`,
            levelCode: "district",
            depth: 0,
          },
        ],
        accuracyMetres: 12,
        reason: "the point falls inside the test boundary",
        syntheticProvenance: true,
      }),
    }),
  });

  assert.equal(result.status, "completed");
  if (result.status !== "completed") return;
  collect(result.issueId);
  assert.equal(result.jurisdictionResolution?.outcome, "resolved");
  const { rows } = await client.query(
    `select jr.boundary_version, jr.applied_to_issue,
            rd.jurisdiction_resolution_id, i.jurisdiction_id,
            cql.jurisdiction_filter_mode
       from jurisdiction_resolution jr
       join canonical_issue i on i.issue_id = jr.issue_id
       join routing_decision rd on rd.jurisdiction_resolution_id = jr.resolution_id
       join candidate_query_log cql on cql.submission_id = jr.submission_id
      where jr.submission_id = $1`,
    [submissionId],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.["boundary_version"], DIRECTORY);
  assert.equal(rows[0]?.["applied_to_issue"], true);
  assert.equal(rows[0]?.["jurisdiction_id"], jurisdictionId);
  assert.equal(rows[0]?.["jurisdiction_filter_mode"], "resolved_or_unscoped");
});

test("V033 PIPE: an uncertain boundary remains unscoped and cannot route", async () => {
  const { submissionId } = await newSubmission({ origin: nextOrigin() });
  const result = await runMatchingStage(client, {
    submissionId,
    jurisdictionId: undefined,
    ...stageOptions({
      resolveJurisdiction: async () => ({
        outcome: "boundary_uncertain" as const,
        profileId: "test-profile",
        boundaryVersion: DIRECTORY,
        method: "point_in_versioned_boundary" as const,
        selected: undefined,
        candidates: [],
        accuracyMetres: 400,
        reason: "the accuracy range reaches a boundary edge",
        syntheticProvenance: true,
      }),
    }),
  });

  assert.equal(result.status, "completed");
  if (result.status !== "completed") return;
  collect(result.issueId);
  assert.equal(result.jurisdictionResolution?.outcome, "boundary_uncertain");
  assert.equal(result.routing?.outcome, "unknown_owner_review");
  const { rows } = await client.query(
    `select i.jurisdiction_id, jr.applied_to_issue, cql.jurisdiction_filter_mode
       from jurisdiction_resolution jr
       join canonical_issue i on i.issue_id = jr.issue_id
       join candidate_query_log cql on cql.submission_id = jr.submission_id
      where jr.submission_id = $1`,
    [submissionId],
  );
  assert.equal(rows[0]?.["jurisdiction_id"], null);
  assert.equal(rows[0]?.["applied_to_issue"], false);
  assert.equal(rows[0]?.["jurisdiction_filter_mode"], "unscoped_only");
});

test("PIPE: the embedding is written, not just used in memory", async () => {
  const { submissionId } = await newSubmission({ origin: nextOrigin() });

  const result = await runMatchingStage(client, {
    submissionId,
    jurisdictionId,
    ...stageOptions(),
  });
  if (result.status === "completed") collect(result.issueId);

  const { rows } = await client.query(
    "select model_name, dimensions, normalized, input_hash from submission_embedding where submission_id = $1",
    [submissionId],
  );
  assert.equal(rows[0]?.["model_name"], "test-embedding-model");
  assert.equal(rows[0]?.["dimensions"], 3072);
  assert.equal(rows[0]?.["normalized"], true);
  assert.equal(String(rows[0]?.["input_hash"]).length, 64);

  // And the issue carries a representative copy, so V026 can rerank later.
  if (result.status !== "completed") return;
  const issue = await client.query(
    "select representative_embedding is not null as has_vector, representative_embedding_model from canonical_issue where issue_id = $1",
    [result.issueId],
  );
  assert.equal(issue.rows[0]?.["has_vector"], true);
  assert.equal(issue.rows[0]?.["representative_embedding_model"], "test-embedding-model");
});

test("PIPE: a second report about the same thing attaches instead of opening another issue", async () => {
  const origin = nextOrigin();
  const first = await newSubmission({ origin, metresEast: 0 });
  const firstResult = await runMatchingStage(client, {
    submissionId: first.submissionId,
    jurisdictionId,
    ...stageOptions(),
  });
  if (firstResult.status === "completed") collect(firstResult.issueId);

  const second = await newSubmission({ origin, metresEast: 15 });
  const secondResult = await runMatchingStage(client, {
    submissionId: second.submissionId,
    jurisdictionId,
    ...stageOptions(),
  });

  assert.equal(secondResult.status, "completed");
  if (secondResult.status !== "completed" || firstResult.status !== "completed") return;
  assert.equal(secondResult.assignment, "attached");
  assert.equal(secondResult.issueId, firstResult.issueId);

  // Two distinct people, one issue.
  const counted = await client.query(
    "select count(*)::int as n from issue_participation where canonical_issue_id = $1 and counted = true",
    [firstResult.issueId],
  );
  assert.equal(counted.rows[0]?.["n"], 2);
});

test("PIPE: one person reporting twice is still one counted contributor", async () => {
  const participantId = await newParticipant();
  const origin = nextOrigin();
  const first = await newSubmission({ origin, participantId });
  const firstResult = await runMatchingStage(client, {
    submissionId: first.submissionId,
    jurisdictionId,
    ...stageOptions(),
  });
  if (firstResult.status === "completed") collect(firstResult.issueId);

  const second = await newSubmission({ origin, participantId, metresEast: 10 });
  await runMatchingStage(client, {
    submissionId: second.submissionId,
    jurisdictionId,
    ...stageOptions(),
  });

  if (firstResult.status !== "completed") return;
  const counted = await client.query(
    "select count(*)::int as n from issue_participation where canonical_issue_id = $1 and counted = true",
    [firstResult.issueId],
  );
  assert.equal(counted.rows[0]?.["n"], 1, "V029's rule must hold through the pipeline");
});

// ---------------------------------------------------------------------------
// Ambiguity reaches a person rather than being guessed
// ---------------------------------------------------------------------------

test("PIPE: an ambiguous proposal leaves a review item and opens no issue", async () => {
  // Two existing issues, both in range, both with the same vector: V027 finds
  // them too close to separate and refuses to choose. Nothing may be opened,
  // and a reviewer decides (V032).
  const origin = nextOrigin();
  const a = await newSubmission({ origin, metresEast: 0 });
  const first = await runMatchingStage(client, {
    submissionId: a.submissionId,
    jurisdictionId,
    ...stageOptions(),
  });
  if (first.status === "completed") collect(first.issueId);

  const b = await newSubmission({ origin, metresEast: 400 });
  const second = await runMatchingStage(client, {
    submissionId: b.submissionId,
    jurisdictionId,
    ...stageOptions(),
  });
  if (second.status === "completed") collect(second.issueId);
  assert.equal(second.status === "completed" ? second.assignment : "", "created");

  const c = await newSubmission({ origin, metresEast: 200 });
  const result = await runMatchingStage(client, {
    submissionId: c.submissionId,
    jurisdictionId,
    ...stageOptions({ bounds: { ...TEST_BOUNDS, baseRadiusMetres: 600 } }),
  });

  assert.equal(result.status, "completed");
  if (result.status !== "completed") return;
  assert.equal(result.assignment, "needs_review");
  assert.equal(result.issueId, undefined, "no issue may be opened for an ambiguous proposal");
  assert.match(result.notes.join(" "), /ambiguous|reviewer/i);

  const { rows } = await client.query(
    "select state, resulting_issue_id from issue_match where submission_id = $1",
    [c.submissionId],
  );
  assert.equal(rows[0]?.["state"], "ambiguous");
  assert.equal(rows[0]?.["resulting_issue_id"], null);
});

test("PIPE: the recheck searches the same bounds retrieval did", async () => {
  // A candidate beyond the retrieval radius but inside the recheck's own
  // default would be found only by the recheck, making the decision stale —
  // and the rerun would do the same thing forever. Found by mutation testing.
  const origin = nextOrigin();
  const existing = await newSubmission({ origin, metresEast: 0 });
  const first = await runMatchingStage(client, {
    submissionId: existing.submissionId,
    jurisdictionId,
    ...stageOptions(),
  });
  if (first.status === "completed") collect(first.issueId);

  // 250 m away: outside the 150 m base plus 12 m accuracy that retrieval uses,
  // inside the 400 m the recheck would otherwise default to.
  const nearby = await newSubmission({ origin, metresEast: 250 });
  const result = await runMatchingStage(client, {
    submissionId: nearby.submissionId,
    jurisdictionId,
    ...stageOptions(),
  });

  assert.equal(result.status, "completed", "a decision must commit, not be stale forever");
  if (result.status !== "completed") return;
  collect(result.issueId);
  assert.equal(result.assignment, "created");
});

// ---------------------------------------------------------------------------
// The stage is a V017 stage
// ---------------------------------------------------------------------------

test("PIPE: the stage takes a lease so duplicate delivery is harmless", async () => {
  const { submissionId } = await newSubmission({ origin: nextOrigin() });

  const first = await runMatchingStage(client, { submissionId, jurisdictionId, ...stageOptions() });
  const second = await runMatchingStage(client, {
    submissionId,
    jurisdictionId,
    ...stageOptions(),
  });
  if (first.status === "completed") collect(first.issueId);

  assert.equal(first.status, "completed");
  assert.equal(second.status, "already_processed");

  const { rows } = await client.query(
    "select count(*)::int as n from processing_stage where submission_id = $1 and stage = $2",
    [submissionId, MATCHING_STAGE],
  );
  assert.equal(rows[0]?.["n"], 1);
  const matches = await client.query(
    "select count(*)::int as n from issue_match where submission_id = $1",
    [submissionId],
  );
  assert.equal(matches.rows[0]?.["n"], 1, "one unit of work, whatever the delivery count");
});

test("PIPE: the stage records its pipeline version", async () => {
  const { submissionId } = await newSubmission({ origin: nextOrigin() });

  const result = await runMatchingStage(client, {
    submissionId,
    jurisdictionId,
    ...stageOptions(),
  });
  if (result.status === "completed") collect(result.issueId);

  const { rows } = await client.query(
    "select pipeline_version, state from processing_stage where submission_id = $1 and stage = $2",
    [submissionId, MATCHING_STAGE],
  );
  assert.equal(rows[0]?.["pipeline_version"], MATCHING_PIPELINE_VERSION);
  assert.equal(rows[0]?.["state"], "succeeded");
});

test("PIPE: no provider is called inside a database transaction", async () => {
  // The embedding function records whether a transaction was open when it ran.
  // A transaction held across a network call is how a connection pool is
  // exhausted by a slow provider (V006 §5).
  const { submissionId } = await newSubmission({ origin: nextOrigin() });
  let inTransactionDuringEmbed: boolean | undefined;

  await runMatchingStage(client, {
    submissionId,
    jurisdictionId,
    ...stageOptions({
      embed: async (text: string) => {
        const { rows } = await client.query("select now() <> statement_timestamp() as in_tx");
        inTransactionDuringEmbed = rows[0]?.["in_tx"] === true;
        void text;
        return {
          vector: vectorFor(0.5),
          model: "test-embedding-model",
          dimensions: 3072,
          normalized: true,
        };
      },
    }),
  });
  const created = await client.query(
    "select resulting_issue_id from issue_match where submission_id = $1",
    [submissionId],
  );
  collect(
    created.rows[0]?.["resulting_issue_id"] === null
      ? undefined
      : String(created.rows[0]?.["resulting_issue_id"]),
  );

  assert.equal(inTransactionDuringEmbed, false);
});

// ---------------------------------------------------------------------------
// Failures stay visible
// ---------------------------------------------------------------------------

test("PIPE: an embedding failure does not stop the chain, it is recorded", async () => {
  // A provider outage must not prevent a report being grouped at all: without
  // a vector the matcher simply has one fewer signal, which V027 already
  // handles by refusing to match on proximity alone.
  const { submissionId } = await newSubmission({ origin: nextOrigin() });

  const result = await runMatchingStage(client, {
    submissionId,
    jurisdictionId,
    ...stageOptions({
      embed: async () => {
        throw new Error("provider unavailable");
      },
    }),
  });

  assert.equal(result.status, "completed");
  if (result.status !== "completed") return;
  collect(result.issueId);
  assert.equal(result.embeddingAvailable, false);
  assert.match(result.notes.join(" "), /embedding|vector/i);

  const { rows } = await client.query(
    "select count(*)::int as n from submission_embedding where submission_id = $1",
    [submissionId],
  );
  assert.equal(rows[0]?.["n"], 0, "no vector may be stored when none was produced");
});

test("PIPE: a submission with no location is a visible recoverable failure", async () => {
  const participantId = await newParticipant();
  const submissionId = randomUUID();
  await client.query(
    `insert into submission
       (submission_id, participant_id, observed_at, interface_locale,
        locale_pack_version, taxonomy_version, idempotency_key)
     values ($1,$2, now(),'en-IN','demo-locales.v1','demo-taxonomy.v1',$3)`,
    [submissionId, participantId, `mp-noloc-${submissionId}`],
  );
  submissions.push(submissionId);

  const result = await runMatchingStage(client, {
    submissionId,
    jurisdictionId,
    ...stageOptions(),
  });

  assert.equal(result.status, "failed");
  if (result.status !== "failed") return;
  assert.match(result.reason, /location/i);
  const { rows } = await client.query(
    "select state, failure_reason from processing_stage where submission_id = $1 and stage = $2",
    [submissionId, MATCHING_STAGE],
  );
  assert.equal(rows[0]?.["state"], "failed_retryable");
  assert.match(String(rows[0]?.["failure_reason"]), /location/i);
});

test("PIPE: an unknown submission is refused rather than partially processed", async () => {
  await assert.rejects(
    () =>
      runMatchingStage(client, { submissionId: randomUUID(), jurisdictionId, ...stageOptions() }),
    /not exist|not found/i,
  );
});

test("PIPE: a contribution with no processing consent is recorded but not counted", async () => {
  // V014's rule, now actually connected. The report is still grouped — losing
  // it would be worse — but it does not inflate the contributor count, and the
  // reason is recorded rather than implied.
  const participantId = await newParticipant({ consented: false });
  const { submissionId } = await newSubmission({ origin: nextOrigin(), participantId });

  const result = await runMatchingStage(client, {
    submissionId,
    jurisdictionId,
    ...stageOptions(),
  });

  assert.equal(result.status, "completed");
  if (result.status !== "completed") return;
  collect(result.issueId);
  assert.match(result.notes.join(" "), /not counted|consent/i);

  const { rows } = await client.query(
    `select counted, non_counted_reason from issue_participation
      where canonical_issue_id = $1 and participant_id = $2`,
    [result.issueId, participantId],
  );
  assert.equal(rows[0]?.["counted"], false);
  assert.match(String(rows[0]?.["non_counted_reason"]), /consent/i);

  const counted = await client.query(
    "select count(*)::int as n from issue_participation where canonical_issue_id = $1 and counted = true",
    [result.issueId],
  );
  assert.equal(counted.rows[0]?.["n"], 0);
});

test("PIPE: reused media is reported in the decision basis", async () => {
  // Closes V027's note that media similarity was passed in rather than
  // computed. The same photograph bytes on two reports are recognised, and the
  // observation travels into the decision record — without deciding the match,
  // which V027 forbids.
  const origin = nextOrigin();
  const shared = "c".repeat(64);

  const firstReporter = await newParticipant();
  const first = await newSubmission({ origin, participantId: firstReporter });
  await client.query(
    `insert into evidence_item
       (evidence_id, submission_id, media_type, object_reference, fingerprint_hash,
        redaction_status, derivative_reference, processing_status)
     values ($1,$2,'photo',$3,$4,'approved',$5,'usable')`,
    [
      randomUUID(),
      first.submissionId,
      `originals/t/${randomUUID()}`,
      shared,
      `derivatives/t/${randomUUID()}`,
    ],
  );
  const firstResult = await runMatchingStage(client, {
    submissionId: first.submissionId,
    jurisdictionId,
    ...stageOptions(),
  });
  if (firstResult.status === "completed") collect(firstResult.issueId);

  // A second report, 15 m away, carrying the same bytes.
  const second = await newSubmission({ origin, metresEast: 15 });
  await client.query(
    `insert into evidence_item
       (evidence_id, submission_id, media_type, object_reference, fingerprint_hash,
        redaction_status, derivative_reference, processing_status)
     values ($1,$2,'photo',$3,$4,'approved',$5,'usable')`,
    [
      randomUUID(),
      second.submissionId,
      `originals/t/${randomUUID()}`,
      shared,
      `derivatives/t/${randomUUID()}`,
    ],
  );

  await runMatchingStage(client, {
    submissionId: second.submissionId,
    jurisdictionId,
    ...stageOptions(),
  });

  const { rows } = await client.query(
    "select decision_basis from issue_match where submission_id = $1",
    [second.submissionId],
  );
  const basis = rows[0]?.["decision_basis"] as { reasons?: string[] };
  assert.match(
    (basis.reasons ?? []).join(" "),
    /near-identical bytes|reuse of one photograph/i,
    "the reuse observation must reach the record",
  );
});

test("PIPE: the bounds actually searched are recorded on the result, with their caveat", async () => {
  // V026's gap was an uncalibrated window with nothing saying so. A run that
  // used bounds without recording which ones leaves a reader unable to tell
  // whether two unmatched reports were far apart or the window was narrow.
  const { submissionId } = await newSubmission({ origin: nextOrigin() });

  const result = await runMatchingStage(client, {
    submissionId,
    jurisdictionId,
    ...stageOptions({
      bounds: {
        version: "narrow-bounds.v9",
        baseRadiusMetres: 150,
        timeWindowHours: 6,
        note: "deliberately narrow, not calibrated",
      },
    }),
  });

  assert.equal(result.status, "completed");
  const notes = result.status === "completed" ? result.notes.join(" | ") : "";
  assert.match(notes, /narrow-bounds\.v9/);
  assert.match(notes, /6 h/);
  assert.match(notes, /not calibrated/i);
});

test("PIPE: a narrow window really narrows retrieval, it is not just reported", async () => {
  // The note alone is not enough: a note that quotes the caller's number while
  // retrieval searched a code default would read correctly and be false. This
  // pins the behaviour instead — the same second report attaches under a wide
  // window and opens a separate issue under a narrow one.
  const origin = nextOrigin();
  const first = await newSubmission({ origin });
  const opened = await runMatchingStage(client, {
    submissionId: first.submissionId,
    jurisdictionId,
    ...stageOptions(),
  });
  const openedIssueId = opened.status === "completed" ? opened.issueId : undefined;
  collect(openedIssueId);
  assert.ok(openedIssueId !== undefined);

  // The issue is now two days old. A 6-hour window must not reach it.
  await client.query(
    "update canonical_issue set opened_at = now() - interval '48 hours' where issue_id = $1",
    [openedIssueId],
  );

  const second = await newSubmission({ origin, metresEast: 10 });
  const narrow = await runMatchingStage(client, {
    submissionId: second.submissionId,
    jurisdictionId,
    ...stageOptions({
      bounds: {
        version: "narrow-bounds.v9",
        baseRadiusMetres: 150,
        timeWindowHours: 6,
        note: "deliberately narrow, not calibrated",
      },
    }),
  });
  collect(narrow.status === "completed" ? narrow.issueId : undefined);

  assert.equal(narrow.status, "completed");
  assert.equal(narrow.status === "completed" ? narrow.candidateCount : -1, 0);
  assert.notEqual(narrow.status === "completed" ? narrow.issueId : undefined, openedIssueId);

  // And the same report under the wide window would have found it: a third
  // report at the same spot attaches to the issue the narrow run could not see.
  const third = await newSubmission({ origin, metresEast: 10 });
  const wide = await runMatchingStage(client, {
    submissionId: third.submissionId,
    jurisdictionId,
    ...stageOptions(),
  });
  collect(wide.status === "completed" ? wide.issueId : undefined);
  assert.ok((wide.status === "completed" ? wide.candidateCount : 0) >= 1);
});

// ---------------------------------------------------------------------------
// Trust signals are evaluated and stored by the stage (V025)
// ---------------------------------------------------------------------------

test("PIPE: the stage evaluates and stores the trust checks", async () => {
  // V025 recorded that "nothing consumes these checks yet" — they were
  // computed in the domain and discarded. A check nobody stores is not a
  // safeguard.
  const { submissionId } = await newSubmission({ origin: nextOrigin() });

  const result = await runMatchingStage(client, {
    submissionId,
    jurisdictionId,
    ...stageOptions(),
  });
  collect(result.status === "completed" ? result.issueId : undefined);

  const { rows } = await client.query(
    "select checks, requires_review, any_input_is_fixture from trust_signal_report where submission_id = $1",
    [submissionId],
  );
  assert.equal(rows.length, 1);
  const checks = rows[0]?.["checks"] as { signal: string }[];
  assert.ok(checks.length >= 3, `expected several checks, got ${String(checks.length)}`);
  // A text-only report has nothing inconsistent about it.
  assert.equal(rows[0]?.["requires_review"], false);
});

test("PIPE: a text-only report is not flagged for having no photograph metadata", async () => {
  // The V025 rule, now on the real path: absence is not evidence. A report
  // with no photograph has no capture timestamp to check, and that must come
  // back `unknown` rather than flagging the reporter.
  const { submissionId } = await newSubmission({ origin: nextOrigin() });

  const result = await runMatchingStage(client, {
    submissionId,
    jurisdictionId,
    ...stageOptions(),
  });
  collect(result.status === "completed" ? result.issueId : undefined);

  const { rows } = await client.query(
    "select checks, requires_review from trust_signal_report where submission_id = $1",
    [submissionId],
  );
  const checks = rows[0]?.["checks"] as { signal: string; verdict: string }[];
  const timestamp = checks.find((check) => check.signal === "timestamp_availability");

  assert.equal(rows[0]?.["requires_review"], false);
  // `not_applicable`, not `unknown`: with no photograph there is no capture
  // timestamp to be missing. The distinction matters — `unknown` says a check
  // was attempted and could not conclude, and claiming that here would be
  // reporting an attempt that never happened.
  assert.equal(timestamp?.verdict, "not_applicable");
});

test("PIPE: a photograph with no capture timestamp is unknown, not a flag", async () => {
  // The V025 rule at its sharpest, on the real path. Stripping metadata is
  // what most phones and messaging apps do; treating its absence as a signal
  // would flag the majority of honest reports.
  const { submissionId } = await newSubmission({ origin: nextOrigin() });
  await photoOn(submissionId, randomUUID().replace(/-/g, "").padEnd(64, "e").slice(0, 64));

  const result = await runMatchingStage(client, {
    submissionId,
    jurisdictionId,
    ...stageOptions(),
  });
  collect(result.status === "completed" ? result.issueId : undefined);

  const { rows } = await client.query(
    "select checks, requires_review from trust_signal_report where submission_id = $1",
    [submissionId],
  );
  const checks = rows[0]?.["checks"] as { signal: string; verdict: string }[];
  const timestamp = checks.find((check) => check.signal === "timestamp_availability");

  assert.equal(timestamp?.verdict, "unknown");
  assert.equal(rows[0]?.["requires_review"], false);
});

test("PIPE: the corroboration check is no longer marked as fixture input", async () => {
  // V025 declared the corroboration input "a fixture until V029 supplies live
  // eligible participation". V029 is wired now, so the count is real — and a
  // report that still said `fixture` would be understating what the system
  // actually knows.
  const { submissionId } = await newSubmission({ origin: nextOrigin() });

  const result = await runMatchingStage(client, {
    submissionId,
    jurisdictionId,
    ...stageOptions(),
  });
  collect(result.status === "completed" ? result.issueId : undefined);

  const { rows } = await client.query(
    "select checks, any_input_is_fixture from trust_signal_report where submission_id = $1",
    [submissionId],
  );
  const checks = rows[0]?.["checks"] as { signal: string; inputIsFixture: boolean }[];
  const corroboration = checks.find((check) => check.signal === "independent_corroboration");

  assert.equal(corroboration?.inputIsFixture, false);
  assert.equal(rows[0]?.["any_input_is_fixture"], false);
});

test("PIPE: reused media is recorded as a reuse check, not as a fraud finding", async () => {
  // Reuse is a real signal — the same photograph attached to two reports — and
  // the check must say what it is without characterising the reporter.
  const origin = nextOrigin();
  const sharedBytes = randomUUID().replace(/-/g, "").padEnd(64, "d").slice(0, 64);
  const first = await newSubmission({ origin });
  await photoOn(first.submissionId, sharedBytes);
  const firstResult = await runMatchingStage(client, {
    submissionId: first.submissionId,
    jurisdictionId,
    ...stageOptions(),
  });
  collect(firstResult.status === "completed" ? firstResult.issueId : undefined);

  const second = await newSubmission({ origin, metresEast: 10 });
  await photoOn(second.submissionId, sharedBytes);
  const secondResult = await runMatchingStage(client, {
    submissionId: second.submissionId,
    jurisdictionId,
    ...stageOptions(),
  });
  collect(secondResult.status === "completed" ? secondResult.issueId : undefined);

  const { rows } = await client.query(
    "select checks from trust_signal_report where submission_id = $1",
    [second.submissionId],
  );
  const checks = rows[0]?.["checks"] as { signal: string; verdict: string; reason: string }[];
  const reuse = checks.find((check) => check.signal === "known_media_reuse");

  assert.ok(reuse !== undefined);
  assert.doesNotMatch(reuse.reason, /fraud|fake|dishonest|stolen/i);
});

test("PIPE: reuse is found even when the other report was never a candidate", async () => {
  // The narrower `reused` set answers "which candidates share bytes with this
  // report". Using it for the trust check would miss a photograph reused from
  // somewhere retrieval never looked — 6 km away here — which is precisely the
  // case the reuse check exists for.
  const sharedBytes = randomUUID().replace(/-/g, "").padEnd(64, "f").slice(0, 64);
  const far = await newSubmission({ origin: nextOrigin() });
  await photoOn(far.submissionId, sharedBytes);
  const farResult = await runMatchingStage(client, {
    submissionId: far.submissionId,
    jurisdictionId,
    ...stageOptions(),
  });
  collect(farResult.status === "completed" ? farResult.issueId : undefined);

  const here = await newSubmission({ origin: nextOrigin() });
  await photoOn(here.submissionId, sharedBytes);
  const result = await runMatchingStage(client, {
    submissionId: here.submissionId,
    jurisdictionId,
    ...stageOptions(),
  });
  collect(result.status === "completed" ? result.issueId : undefined);
  assert.equal(result.status === "completed" ? result.candidateCount : -1, 0);

  const { rows } = await client.query(
    "select checks from trust_signal_report where submission_id = $1",
    [here.submissionId],
  );
  const checks = rows[0]?.["checks"] as { signal: string; verdict: string }[];
  const reuse = checks.find((check) => check.signal === "known_media_reuse");
  assert.notEqual(reuse?.verdict, "not_applicable");
  assert.notEqual(reuse?.verdict, "consistent");
});

test("PIPE: a capture time is compared against the receipt, not the observation", async () => {
  // A report typed up two days after it was observed is ordinary. The
  // photograph's age is measured against when the server received the report,
  // so a photograph taken *during* that gap is consistent. Measuring against
  // `observed_at` instead would flag the reporter for writing it up late.
  const { submissionId } = await newSubmission({
    origin: nextOrigin(),
    observedHoursAgo: 100,
  });
  // Taken 90 hours ago: 90 h before observation would breach the 72-hour
  // limit, but it is only a few hours before the report was received.
  await photoOn(submissionId, randomUUID().replace(/-/g, "").padEnd(64, "a").slice(0, 64), {
    capturedHoursAgo: 4,
  });

  const result = await runMatchingStage(client, {
    submissionId,
    jurisdictionId,
    ...stageOptions(),
  });
  collect(result.status === "completed" ? result.issueId : undefined);

  const { rows } = await client.query(
    "select checks, requires_review from trust_signal_report where submission_id = $1",
    [submissionId],
  );
  const checks = rows[0]?.["checks"] as { signal: string; verdict: string }[];
  const capture = checks.find((check) => check.signal === "capture_consistency");

  assert.equal(capture?.verdict, "consistent");
  assert.equal(rows[0]?.["requires_review"], false);
});

test("PIPE: a hand-entered position is reported as one, not as a device measurement", async () => {
  // A dropped pin is a claim about a place, not a failed measurement. Passing
  // it to the check as `device_geolocation` would have the check compare a
  // measurement that was never taken.
  const { submissionId } = await newSubmission({ origin: nextOrigin(), manualPin: true });
  await photoOn(submissionId, randomUUID().replace(/-/g, "").padEnd(64, "b").slice(0, 64));

  const result = await runMatchingStage(client, {
    submissionId,
    jurisdictionId,
    ...stageOptions(),
  });
  collect(result.status === "completed" ? result.issueId : undefined);

  const { rows } = await client.query(
    "select checks from trust_signal_report where submission_id = $1",
    [submissionId],
  );
  const checks = rows[0]?.["checks"] as { signal: string; verdict: string; reason: string }[];
  const capture = checks.find((check) => check.signal === "capture_consistency");

  assert.equal(capture?.verdict, "unknown");
  assert.match(capture?.reason ?? "", /entered by hand/i);
});

test("PIPE: no image-and-text comparison is claimed, because none is performed", async () => {
  // Nothing in this pipeline compares a photograph against its description —
  // that needs a vision call. Supplying a verdict anyway would be reporting a
  // comparison that never happened, which is worse than reporting none.
  const { submissionId } = await newSubmission({ origin: nextOrigin() });
  await photoOn(submissionId, randomUUID().replace(/-/g, "").padEnd(64, "c").slice(0, 64));

  const result = await runMatchingStage(client, {
    submissionId,
    jurisdictionId,
    ...stageOptions(),
  });
  collect(result.status === "completed" ? result.issueId : undefined);

  const { rows } = await client.query(
    "select checks from trust_signal_report where submission_id = $1",
    [submissionId],
  );
  const checks = rows[0]?.["checks"] as { signal: string; verdict: string; reason: string }[];
  const description = checks.find((check) => check.signal === "image_description_consistency");

  assert.equal(description?.verdict, "unknown");
  assert.match(description?.reason ?? "", /no image-and-text comparison/i);
});

// ---------------------------------------------------------------------------
// Classification runs inside the stage (V023)
// ---------------------------------------------------------------------------

/** A classifier that answers with a fixed band, and counts how often it is asked. */
const stubClassifier = (
  band: "low" | "medium" | "high",
  category = "sanitation",
): { classify: ClassifyText; calls: () => number } => {
  let calls = 0;
  return {
    calls: () => calls,
    classify: async (text: string) => {
      calls += 1;
      void text;
      return {
        outcome: "classified" as const,
        proposal: {
          taxonomy_version: TAXONOMY.version,
          proposed_category_id: category,
          certainty_band: band,
          requires_review: band !== "high",
          model_name: "stub-classifier",
          prompt_version: "classify.v1",
          input_hash: "0".repeat(64),
        },
      };
    },
  };
};

test("V023: the stage classifies, and stores the proposal against the evidence", async () => {
  // V023's gap: the classifier existed, was unit-tested against a stubbed
  // transport, and was called by nothing. A proposal that never reaches a
  // reviewer is a proposal nobody can act on.
  // Distinct text per test: the cache key is the text plus the model and the
  // prompt version, so two tests sharing text would correctly reuse one
  // answer — and the second would then be testing the cache, not the stage.
  const { submissionId } = await newSubmission({
    origin: nextOrigin(),
    text: `a blocked drain ${randomUUID()}`,
  });
  const classifier = stubClassifier("medium", "water_supply");

  const result = await runMatchingStage(client, {
    submissionId,
    jurisdictionId,
    ...stageOptions({ classify: classifier.classify }),
  });
  collect(result.status === "completed" ? result.issueId : undefined);

  assert.equal(classifier.calls(), 1);
  const { rows } = await client.query(
    "select proposed_category_id, certainty_band, requires_review from classification_proposal where submission_id = $1",
    [submissionId],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.["proposed_category_id"], "water_supply");
  assert.equal(rows[0]?.["requires_review"], true);
});

test("V023: an uncertain proposal does not become the issue's category", async () => {
  // A `medium` proposal is advice pending review. Using it as the working
  // category would route the report on a guess nobody confirmed — and routing
  // is what decides who is asked to fix the problem.
  const { submissionId } = await newSubmission({
    origin: nextOrigin(),
    text: `a report ${randomUUID()}`,
  });

  const result = await runMatchingStage(client, {
    submissionId,
    jurisdictionId,
    ...stageOptions({ classify: stubClassifier("low", "electrical").classify }),
  });
  collect(result.status === "completed" ? result.issueId : undefined);

  const issueId = result.status === "completed" ? result.issueId : undefined;
  const { rows } = await client.query("select category from canonical_issue where issue_id = $1", [
    issueId,
  ]);
  assert.equal(rows[0]?.["category"], CATEGORY);
  const notes = result.status === "completed" ? result.notes.join(" | ") : "";
  assert.match(notes, /pending review|not applied|reviewer/i);
});

test("V023: a high-certainty proposal is used, and the note says a model chose it", async () => {
  // `requires_review` is false for a high band, so nobody is asked — which
  // makes it all the more important that the record says a model decided,
  // rather than presenting the category as an established fact.
  const { submissionId } = await newSubmission({
    origin: nextOrigin(),
    text: `a report ${randomUUID()}`,
  });

  const result = await runMatchingStage(client, {
    submissionId,
    jurisdictionId,
    ...stageOptions({ classify: stubClassifier("high", "water_supply").classify }),
  });
  collect(result.status === "completed" ? result.issueId : undefined);

  const issueId = result.status === "completed" ? result.issueId : undefined;
  const { rows } = await client.query("select category from canonical_issue where issue_id = $1", [
    issueId,
  ]);
  assert.equal(rows[0]?.["category"], "water_supply");
  const notes = result.status === "completed" ? result.notes.join(" | ") : "";
  // The note has to attribute the choice and disclaim confirmation. An earlier
  // version asserted the note simply never contained "confirmed", which the
  // correct disclosure ("nothing has confirmed it") itself violated — a
  // pattern loose enough to forbid the very words that make it honest.
  assert.match(notes, /a model chose this/i);
  assert.match(notes, /nothing has confirmed it/i);
  assert.doesNotMatch(notes, /confirmed by|verified category|established category/i);
});

test("V023: a classifier outage does not lose the report", async () => {
  // The classifier is an external dependency on a free tier. A report that
  // failed to process because a vendor was rate-limiting would be a report the
  // citizen filed and nobody ever saw.
  const { submissionId } = await newSubmission({
    origin: nextOrigin(),
    text: `a report ${randomUUID()}`,
  });

  const result = await runMatchingStage(client, {
    submissionId,
    jurisdictionId,
    ...stageOptions({
      classify: async () => ({ outcome: "unavailable" as const, reasonCode: "provider_http_429" }),
    }),
  });
  collect(result.status === "completed" ? result.issueId : undefined);

  assert.equal(result.status, "completed");
  const notes = result.status === "completed" ? result.notes.join(" | ") : "";
  assert.match(notes, /classification/i);
  assert.match(notes, /429|unavailable/i);
  // And nothing was stored, so a retry asks again rather than inheriting a
  // proposal that was never made.
  const { rows } = await client.query(
    "select count(*)::int as n from classification_proposal where submission_id = $1",
    [submissionId],
  );
  assert.equal(rows[0]?.["n"], 0);
});

test("V023: the same text is classified once, not once per report", async () => {
  // The repeat V023 named, now on the real path: two people describing the
  // same problem in the same words must not cost two calls on a tier that
  // allows five a minute.
  const classifier = stubClassifier("medium");
  const origin = nextOrigin();
  const text = `the same words ${randomUUID()}`;

  const first = await newSubmission({ origin, text });
  const a = await runMatchingStage(client, {
    submissionId: first.submissionId,
    jurisdictionId,
    ...stageOptions({ classify: classifier.classify }),
  });
  collect(a.status === "completed" ? a.issueId : undefined);

  const second = await newSubmission({ origin, metresEast: 4_000, text });
  const b = await runMatchingStage(client, {
    submissionId: second.submissionId,
    jurisdictionId,
    ...stageOptions({ classify: classifier.classify }),
  });
  collect(b.status === "completed" ? b.issueId : undefined);

  assert.equal(classifier.calls(), 1, "the second report reused the cached answer");
  // Both still get their own stored proposal, because a proposal belongs to a
  // submission even when the answer behind it was reused.
  const { rows } = await client.query(
    "select count(*)::int as n from classification_proposal where submission_id = any($1::uuid[])",
    [[first.submissionId, second.submissionId]],
  );
  assert.equal(rows[0]?.["n"], 2);
});

test("V023: without a classifier the stage still works, on the fallback category", async () => {
  // A deployment with no API key must keep working. The fallback is recorded
  // as the fallback it is, not as a classification.
  const { submissionId } = await newSubmission({
    origin: nextOrigin(),
    text: `a report ${randomUUID()}`,
  });

  const result = await runMatchingStage(client, {
    submissionId,
    jurisdictionId,
    ...stageOptions(),
  });
  collect(result.status === "completed" ? result.issueId : undefined);

  assert.equal(result.status, "completed");
  const { rows } = await client.query(
    "select count(*)::int as n from classification_proposal where submission_id = $1",
    [submissionId],
  );
  assert.equal(rows[0]?.["n"], 0);
});
