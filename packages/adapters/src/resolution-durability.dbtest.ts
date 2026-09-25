/**
 * Durability read against the real tables (roadmap V050a).
 *
 * Run with: npm run db:up && npm run db:migrate && npm run test:db
 *
 * What only becomes true against a database: that the five signals are decided
 * from one pass over the same claims, that a claim missing from one denominator
 * is missing from all of them, and — the one that matters most — that the
 * reading never carries the staff member who filed the claim.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";

import { durabilityFigure } from "@vision/domain";

import { readDurability } from "./resolution-durability.ts";

const DATABASE_URL =
  process.env["DATABASE_URL"] ??
  "postgresql://vision:vision_local_dev_only@127.0.0.1:5432/vision_dev";

const DEPARTMENT = `dur-dept-${randomUUID().slice(0, 8)}`;

let client: pg.Client;
let jurisdictionId: string;
let staffId: string;
const issues: string[] = [];
const participants: string[] = [];

before(async () => {
  client = new pg.Client({ connectionString: DATABASE_URL, statement_timeout: 60_000 });
  await client.connect();

  const { rows } = await client.query(
    "select jurisdiction_id from jurisdiction order by internal_code limit 1",
  );
  assert.notEqual(rows[0], undefined, "run `npm run db:seed` before this suite");
  jurisdictionId = String(rows[0]?.["jurisdiction_id"]);

  const staffParticipant = randomUUID();
  participants.push(staffParticipant);
  await client.query("insert into participant (participant_id) values ($1)", [staffParticipant]);
  staffId = randomUUID();
  await client.query(
    `insert into staff_account (staff_id, participant_id, role, account_state, provider_mode, created_at)
     values ($1,$2,'department_staff','active','simulated', now())`,
    [staffId, staffParticipant],
  );
});

after(async () => {
  const cleaner = new pg.Client({ connectionString: DATABASE_URL, statement_timeout: 60_000 });
  await cleaner.connect();
  try {
    if (issues.length > 0) {
      await cleaner.query(
        `delete from resolution_confirmation where claim_id in
           (select claim_id from resolution_claim where issue_id = any($1::uuid[]))`,
        [issues],
      );
      await cleaner.query(
        `delete from resolution_evidence_item where claim_id in
           (select claim_id from resolution_claim where issue_id = any($1::uuid[]))`,
        [issues],
      );
      await cleaner.query("delete from resolution_claim where issue_id = any($1::uuid[])", [
        issues,
      ]);
      await cleaner.query("delete from issue_alert where issue_id = any($1::uuid[])", [issues]);
      await cleaner.query("delete from assignment where issue_id = any($1::uuid[])", [issues]);
      await cleaner
        .query(
          `delete from summary_applied_event where event_id in
             (select event_id from status_event where aggregate_id = any($1::text[]))`,
          [issues],
        )
        .catch(() => undefined);
      await cleaner.query("delete from status_event where aggregate_id = any($1::text[])", [
        issues,
      ]);
      await cleaner
        .query("delete from summary_issue_fact where issue_id = any($1::uuid[])", [issues])
        .catch(() => undefined);
      await cleaner.query("delete from canonical_issue where issue_id = any($1::uuid[])", [issues]);
    }
    await cleaner.query("delete from staff_account where staff_id = $1", [staffId]);
    if (participants.length > 0) {
      await cleaner.query("delete from participant where participant_id = any($1::uuid[])", [
        participants,
      ]);
    }
  } finally {
    await cleaner.end();
    await client.end().catch(() => undefined);
  }
});

/** One completed issue, shaped by what the test needs to observe. */
const completedIssue = async (options: {
  readonly decision: "confirmed" | "disputed";
  readonly reopened?: boolean;
  readonly evidencePieces?: number;
  readonly claimMinutesAfterPlanning?: number;
}): Promise<string> => {
  const issueId = randomUUID();
  issues.push(issueId);
  await client.query(
    `insert into canonical_issue
       (issue_id, public_reference, category, current_status, opened_at,
        representative_location, last_evidence_at, jurisdiction_id)
     values ($1,$2,'sanitation','resolution_confirmed', now() - interval '20 days',
             ST_SetSRID(ST_MakePoint(74.56,16.85),4326)::geography, now(), $3)`,
    [issueId, `VIS-DUR-${issueId.slice(0, 8).toUpperCase()}`, jurisdictionId],
  );
  await client.query(
    `insert into assignment
       (assignment_id, issue_id, department_id, assigned_staff_id, reason, valid_from, current_version)
     values ($1,$2,$3,$4,'durability dbtest', now() - interval '19 days', 1)`,
    [randomUUID(), issueId, DEPARTMENT, staffId],
  );
  await client.query(
    `insert into issue_alert
       (alert_id, issue_id, rule_id, window_start, raised_at, department_age_days,
        citizen_age_days, threshold_days, rule_source, policy_version, reasons)
     values ($1,$2,'overdue', now() - interval '20 days', now() - interval '13 days',
             7,7,7,'category','demo-ageing.v1','{}'::jsonb)`,
    [randomUUID(), issueId],
  );

  const minutes = options.claimMinutesAfterPlanning ?? 2880;
  const event = async (type: string, at: string, version: number): Promise<void> => {
    await client.query(
      `insert into status_event
         (event_id, aggregate_type, aggregate_id, aggregate_version, event_type,
          actor_type, correlation_id, occurred_at, recorded_at, payload_schema_version, payload)
       values ($1,'canonical_issue',$2,$3,$4,'staff',$5, ${at}, ${at},'1.0.0','{}'::jsonb)`,
      [randomUUID(), issueId, version, type, randomUUID()],
    );
  };
  await event("work_planned", `now() - interval '10 days' - interval '${minutes} minutes'`, 2);
  await event("resolution_claimed", "now() - interval '10 days'", 3);

  const claimId = randomUUID();
  await client.query(
    `insert into resolution_claim (claim_id, issue_id, staff_id, idempotency_key, claimed_at, description)
     values ($1,$2,$3,$4, now() - interval '10 days', 'done')`,
    [claimId, issueId, staffId, `dur-${claimId}`],
  );
  for (let piece = 0; piece < (options.evidencePieces ?? 2); piece += 1) {
    await client.query(
      // Active evidence must name a stored object — the schema refuses a live
      // row that points at nothing.
      `insert into resolution_evidence_item
         (resolution_evidence_id, claim_id, media_type, object_reference, fingerprint_hash,
          derivative_reference, redaction_status, privacy_state, current_version)
       values ($1,$2,'photo',$3,$4,$5,'approved','active',1)`,
      [
        randomUUID(),
        claimId,
        `originals/dur/${claimId}-${String(piece)}`,
        createHash("sha256")
          .update(`${claimId}-${String(piece)}`)
          .digest("hex"),
        `derivatives/dur/${claimId}-${String(piece)}`,
      ],
    );
  }

  const reporter = randomUUID();
  participants.push(reporter);
  await client.query("insert into participant (participant_id) values ($1)", [reporter]);
  await client.query(
    `insert into resolution_confirmation
       (confirmation_id, claim_id, responding_participant_id, decision, decided_at)
     values ($1,$2,$3,$4, now() - interval '9 days')`,
    [randomUUID(), claimId, reporter, options.decision],
  );
  await event(
    options.decision === "confirmed" ? "resolution_confirmed" : "resolution_disputed",
    "now() - interval '9 days'",
    4,
  );

  if (options.reopened === true) {
    await event("reopened", "now() - interval '4 days'", 5);
  }
  return issueId;
};

const unitReading = async () => {
  const reading = await readDurability(client, { asOf: new Date(), days: 120 });
  const observation = reading.observations.find((entry) => entry.unit.departmentId === DEPARTMENT);
  assert.notEqual(observation, undefined, "the seeded department produced no observation");
  return { reading, observation: observation! };
};

// ---------------------------------------------------------------------------

test("V050a: a confirmed closure that was reopened is counted as not having held", async () => {
  await completedIssue({ decision: "confirmed", reopened: true });
  await completedIssue({ decision: "confirmed" });

  const { observation } = await unitReading();
  assert.equal(observation.confirmedClosures, 2);
  assert.equal(observation.counts.did_not_hold, 1);

  const figure = durabilityFigure(observation, "did_not_hold");
  assert.ok(figure.kind === "counted" && figure.numerator === 1 && figure.denominator === 2);
  // One of two is not fifty per cent.
  assert.ok(figure.kind === "counted" && !figure.rateReportable);
});

test("V050a: a dispute is counted against answered claims, not against closures", async () => {
  await completedIssue({ decision: "disputed" });

  const { observation } = await unitReading();
  assert.equal(observation.counts.disputed_by_reporter, 1);
  // A disputed claim is answered but never confirmed, so it belongs to one
  // denominator and not the other.
  assert.equal(observation.answeredClaims, 3);
  assert.equal(observation.confirmedClosures, 2);
});

test("V050a: a claim filed minutes after the work was planned is counted as fast", async () => {
  await completedIssue({ decision: "confirmed", claimMinutesAfterPlanning: 4 });

  const { observation } = await unitReading();
  assert.equal(observation.counts.claimed_implausibly_fast, 1);
});

test("V050a: a claim carrying one photograph is counted as minimum evidence", async () => {
  await completedIssue({ decision: "confirmed", evidencePieces: 1 });

  const { observation } = await unitReading();
  assert.ok(observation.counts.minimum_evidence >= 1);
});

test("V050a: the reading never carries the staff member who filed the claim", async () => {
  const { reading } = await unitReading();
  const serialised = JSON.stringify(reading);
  assert.ok(
    !serialised.includes(staffId),
    "a durability reading must not carry a staff identifier: the unit of this measurement is the department and the ward, and attaching a pattern to a named worker is a supervisor's deliberate act rather than a report's default",
  );
});

test("V050a: every signal is decided over the same claims", async () => {
  const { observation } = await unitReading();
  // Each signal's numerator has to fit inside the denominator that belongs to
  // it; a claim counted in one and absent from another would mean the five
  // signals were reading different populations.
  assert.ok(observation.counts.did_not_hold <= observation.confirmedClosures);
  assert.ok(observation.counts.disputed_by_reporter <= observation.answeredClaims);
  assert.ok(observation.counts.minimum_evidence <= observation.claims);
  assert.ok(observation.counts.claimed_implausibly_fast <= observation.claims);
  assert.ok(observation.counts.claimed_near_deadline <= observation.claims);
  assert.ok(observation.answeredClaims <= observation.claims);
});
