/**
 * A deliberate processing failure, and the alert it produces (roadmap V050).
 *
 * Run with: npm run db:up && npm run db:migrate && npm run test:db
 *
 * This is V050's "done when" written as a test: break processing on purpose,
 * and require the alert to be diagnosable from identifiers and state — and to
 * contain nothing a citizen wrote, because an alert is the surface that gets
 * forwarded, screenshotted and pasted into a group chat.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

import { SIGNAL_NAMES, monitoringVerdict } from "@vision/domain";

import { alertsFrom, readSignals } from "./observability.ts";

const DATABASE_URL =
  process.env["DATABASE_URL"] ??
  "postgresql://vision:vision_local_dev_only@127.0.0.1:5432/vision_dev";

/** Words no identifier, code or version would ever contain. */
const CITIZEN_WORDS =
  "The drain outside Shivaji Vidyalaya has been overflowing since Tuesday morning";

const BUDGETS = [
  { name: "untraceable_events", limit: 0, unit: "events", direction: "at_most" as const },
  { name: "outbox_lag_seconds", limit: 300, unit: "seconds", direction: "at_most" as const },
  { name: "queue_age_seconds", limit: 120, unit: "seconds", direction: "at_most" as const },
  { name: "stage_failures", limit: 0, unit: "terminal failures", direction: "at_most" as const },
  { name: "model_calls_per_hour", limit: 200, unit: "calls", direction: "at_most" as const },
  {
    name: "database_saturation_percent",
    limit: 80,
    unit: "percent",
    direction: "at_most" as const,
  },
  { name: "summary_lag_events", limit: 50, unit: "events", direction: "at_most" as const },
];

let client: pg.Client;
const planted: { submissionId?: string; issueId?: string; eventId?: string } = {};

before(async () => {
  client = new pg.Client({ connectionString: DATABASE_URL, statement_timeout: 60_000 });
  await client.connect();
});

after(async () => {
  if (planted.eventId !== undefined) {
    await client
      .query("delete from outbox where event_id = $1", [planted.eventId])
      .catch(() => undefined);
    await client
      .query("delete from summary_applied_event where event_id = $1", [planted.eventId])
      .catch(() => undefined);
    await client
      .query("delete from status_event where event_id = $1", [planted.eventId])
      .catch(() => undefined);
  }
  if (planted.submissionId !== undefined) {
    await client
      .query("delete from evidence_item where submission_id = $1", [planted.submissionId])
      .catch(() => undefined);
    await client
      .query("delete from submission where submission_id = $1", [planted.submissionId])
      .catch(() => undefined);
  }
  if (planted.issueId !== undefined) {
    await client
      .query("delete from canonical_issue where issue_id = $1", [planted.issueId])
      .catch(() => undefined);
  }
  await client.end().catch(() => undefined);
});

/** Breaks processing the way it actually breaks: a task that gave up. */
const breakProcessingDeliberately = async (): Promise<string> => {
  const issueId = randomUUID();
  planted.issueId = issueId;
  await client.query(
    `insert into canonical_issue
       (issue_id, public_reference, category, current_status, opened_at,
        representative_location, last_evidence_at)
     values ($1,$2,'sanitation','created', now(),
             ST_SetSRID(ST_MakePoint(75.61,17.81),4326)::geography, now())`,
    [issueId, `VIS-MON-${issueId.slice(0, 8).toUpperCase()}`],
  );

  // A submission whose evidence carries words nobody may forward.
  const participantId = randomUUID();
  await client.query("insert into participant (participant_id) values ($1)", [participantId]);
  const submissionId = randomUUID();
  planted.submissionId = submissionId;
  await client.query(
    `insert into submission
       (submission_id, participant_id, observed_location, observed_accuracy_m,
        observed_location_source, observed_at, interface_locale, language_hint,
        locale_pack_version, taxonomy_version, idempotency_key)
     values ($1,$2, ST_SetSRID(ST_MakePoint(75.61,17.81),4326)::geography, 12,
             'device_geolocation', now(), 'en-IN','en-IN','demo-locales.v1',
             'demo-taxonomy.v1',$3)`,
    [submissionId, participantId, `mon-${submissionId}`],
  );
  await client.query(
    `insert into evidence_item (evidence_id, submission_id, media_type, content_text)
     values ($1,$2,'text',$3)`,
    [randomUUID(), submissionId, CITIZEN_WORDS],
  );

  const eventId = randomUUID();
  planted.eventId = eventId;
  await client.query(
    `insert into status_event
       (event_id, aggregate_type, aggregate_id, aggregate_version, event_type,
        actor_type, correlation_id, occurred_at, payload_schema_version, payload)
     values ($1,'canonical_issue',$2,1,'probe','system_worker',$3, now(),'1.0.0',$4::jsonb)`,
    [eventId, issueId, randomUUID(), JSON.stringify({ note: CITIZEN_WORDS })],
  );

  const { rows } = await client.query(
    `insert into outbox
       (event_id, task_type, payload, created_at, not_before, attempts, terminal_failure_reason)
     values ($1,'match_submission',$2::jsonb, now(), now(), 5, 'stage_failed_permanently')
     returning outbox_id`,
    [eventId, JSON.stringify({ submission_id: submissionId })],
  );
  return String(rows[0]?.["outbox_id"]);
};

// ---------------------------------------------------------------------------

test("V050: every signal V050 names is read", async () => {
  const readings = await readSignals(client, { asOf: new Date() });
  assert.deepEqual(readings.map((reading) => reading.signal).sort(), [...SIGNAL_NAMES].sort());
});

test("V050: a deliberate processing failure produces an alert with the id and the state", async () => {
  const outboxId = await breakProcessingDeliberately();

  const readings = await readSignals(client, { asOf: new Date() });
  const alerts = alertsFrom(readings, BUDGETS);
  const failure = alerts.find((entry) => entry.signal === "stage_failures");

  assert.notEqual(failure, undefined, "a task that gave up must produce an alert");
  assert.ok(
    failure?.identifiers.includes(outboxId),
    `the alert must name the task: it carries ${JSON.stringify(failure?.identifiers)}`,
  );
  assert.equal(failure?.state["signal"], "stage_failures");
  assert.ok(Number(failure?.observed ?? 0) >= 1);
  assert.match(failure?.runbook ?? "", /runbook/);
  assert.equal(failure?.severity, "page");

  // Diagnosable: the identifier leads to the record, and the record holds the
  // reason. That is the division of labour — the alert says where, the record
  // says what.
  const { rows } = await client.query(
    "select terminal_failure_reason, task_type, attempts from outbox where outbox_id = $1",
    [outboxId],
  );
  assert.equal(rows[0]?.["terminal_failure_reason"], "stage_failed_permanently");
  assert.equal(rows[0]?.["task_type"], "match_submission");
});

test("V050: nothing in a reading or an alert carries what the citizen wrote", async () => {
  const readings = await readSignals(client, { asOf: new Date() });
  const alerts = alertsFrom(readings, BUDGETS);
  const everything = JSON.stringify({ readings, alerts });

  for (const fragment of ["Shivaji", "overflowing", "Vidyalaya", CITIZEN_WORDS]) {
    assert.ok(
      !everything.includes(fragment),
      `'${fragment}' reached an operational signal; an alert is forwarded and screenshotted, so a report's words must never be in one`,
    );
  }
});

test("V050: a signal that cannot be read says so, and is never reported as zero", async () => {
  const broken = new pg.Client({ connectionString: DATABASE_URL, statement_timeout: 60_000 });
  await broken.connect();
  try {
    // A schema the queries cannot see, so every table lookup fails the way a
    // missing table or a revoked grant would.
    await broken.query("set search_path to pg_catalog");
    const readings = await readSignals(broken, { asOf: new Date() });
    const unreadable = readings.filter((reading) => reading.value === undefined);
    assert.ok(unreadable.length > 0, "a broken read must not come back as a healthy zero");
    for (const reading of unreadable) {
      assert.ok(
        (reading.unavailable ?? "").length > 0,
        `'${reading.signal}' is unreadable and records no reason`,
      );
    }
    const verdict = monitoringVerdict({ readings, alerts: [] });
    assert.equal(verdict.noWatchedSignalIsFiring, false);
    assert.ok(verdict.reasons.some((reason) => /could not be read/.test(reason)));
  } finally {
    await broken.end();
  }
});
