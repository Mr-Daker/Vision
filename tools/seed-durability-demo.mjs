#!/usr/bin/env node
/**
 * A completion history with enough volume to measure (roadmap V050a).
 *
 * Every row is team-created synthetic data (V004 §5). No person, department,
 * ward or repair below corresponds to anything real.
 *
 * Why a seeder exists at all: the demonstration database holds five completion
 * claims, and five claims cannot distinguish anything from anything — which is
 * the correct output and a poor demonstration. This writes a history at a
 * volume where the measurement has something to say.
 *
 * One ward is seeded with a durability problem, deliberately: its confirmed
 * closures come back far more often than the rest of the organisation's. The
 * point of the demonstration is not that the tool finds it — anyone can write a
 * tool that finds what they planted. It is what the tool says **about** the
 * finding: counts rather than a score, an interval rather than a rank, and the
 * innocent explanations printed beside it.
 *
 * Idempotent: every identifier is derived from a stable name, so re-running
 * replaces nothing and duplicates nothing.
 */

import { createHash, randomUUID } from "node:crypto";
import pg from "pg";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://vision:vision_local_dev_only@127.0.0.1:5432/vision_dev";
const PROFILE = process.env.JURISDICTION_PROFILE_ID ?? "demo-district-a";

const stableUuid = (namespace, name) => {
  const digest = createHash("sha256").update(`${namespace}:${name}`).digest("hex");
  const bytes = digest.slice(0, 32).split("");
  bytes[12] = "4";
  bytes[16] = "89ab"[parseInt(digest[16], 16) % 4];
  const hex = bytes.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};

/** Deterministic pseudo-randomness, so two runs seed the same history. */
const spread = (name) => {
  const digest = createHash("sha256").update(name).digest();
  return digest.readUInt32BE(0) / 0xffffffff;
};

/**
 * The organisation.
 *
 * `returnRate` is the share of confirmed closures that come back. The last ward
 * is the one with the problem; the others sit where a working organisation sits.
 */
const UNITS = [
  {
    department: "demo-water-supply",
    ward: "DDA-B1",
    claims: 46,
    returnRate: 0.07,
    nearDeadline: 0.18,
    thin: 0.2,
  },
  {
    department: "demo-sanitation",
    ward: "DDA-B1",
    claims: 41,
    returnRate: 0.1,
    nearDeadline: 0.22,
    thin: 0.25,
  },
  {
    department: "demo-electrical",
    ward: "DDA-B2",
    claims: 38,
    returnRate: 0.08,
    nearDeadline: 0.16,
    thin: 0.18,
  },
  {
    department: "demo-sanitation",
    ward: "DDA-B2",
    claims: 44,
    returnRate: 0.44,
    nearDeadline: 0.71,
    thin: 0.77,
  },
];

const client = new pg.Client({ connectionString: DATABASE_URL, statement_timeout: 120_000 });
await client.connect();

const summary = { issues: 0, claims: 0, confirmations: 0, reopenings: 0, alerts: 0 };

try {
  await client.query("begin");

  // Clear a previous run first. This seeder is idempotent on the issue id, so
  // without this a reshaped history would silently keep the old shape.
  const { rows: previous } = await client.query(
    "select issue_id from canonical_issue where public_reference like 'VIS-DUR-%'",
  );
  const previousIds = previous.map((row) => row.issue_id);
  if (previousIds.length > 0) {
    await client.query(
      `delete from resolution_confirmation where claim_id in
         (select claim_id from resolution_claim where issue_id = any($1::uuid[]))`,
      [previousIds],
    );
    await client.query(
      `delete from resolution_evidence_item where claim_id in
         (select claim_id from resolution_claim where issue_id = any($1::uuid[]))`,
      [previousIds],
    );
    await client.query("delete from resolution_claim where issue_id = any($1::uuid[])", [
      previousIds,
    ]);
    await client.query("delete from issue_alert where issue_id = any($1::uuid[])", [previousIds]);
    await client.query("delete from assignment where issue_id = any($1::uuid[])", [previousIds]);
    await client.query(
      `delete from summary_applied_event where event_id in
         (select event_id from status_event where aggregate_id = any($1::text[]))`,
      [previousIds],
    );
    await client.query("delete from status_event where aggregate_id = any($1::text[])", [
      previousIds,
    ]);
    await client.query("delete from summary_issue_fact where issue_id = any($1::uuid[])", [
      previousIds,
    ]);
    await client.query("delete from canonical_issue where issue_id = any($1::uuid[])", [
      previousIds,
    ]);
  }

  // Wards this profile actually seeded, so the history lands where the
  // dashboard is already looking rather than in wards nobody can read.
  const { rows: wards } = await client.query(
    `select internal_code, jurisdiction_id from jurisdiction
      where jurisdiction_profile_id = $1 order by internal_code`,
    [PROFILE],
  );
  const wardId = new Map(wards.map((row) => [row.internal_code, row.jurisdiction_id]));
  if (wardId.size === 0) {
    throw new Error(`no wards seeded for profile '${PROFILE}'; run npm run db:seed first`);
  }

  // One crew account per unit. Its id is never read by the measurement — the
  // unit is the department and the ward — but a claim must name a staff member,
  // so the account exists and stays out of the report.
  const crewFor = new Map();
  for (const unit of UNITS) {
    const key = `${unit.department}/${unit.ward}`;
    const participantId = stableUuid("durability-crew-participant", key);
    const staffId = stableUuid("durability-crew", key);
    await client.query(
      "insert into participant (participant_id) values ($1) on conflict do nothing",
      [participantId],
    );
    await client.query(
      `insert into staff_account
         (staff_id, participant_id, role, account_state, provider_mode, created_at)
       values ($1,$2,'department_staff','active','simulated', now() - interval '200 days')
       on conflict (staff_id) do nothing`,
      [staffId, participantId],
    );
    crewFor.set(key, staffId);
  }

  for (const unit of UNITS) {
    const key = `${unit.department}/${unit.ward}`;
    const jurisdictionId = wardId.get(unit.ward) ?? [...wardId.values()][0];
    const staffId = crewFor.get(key);

    for (let index = 0; index < unit.claims; index += 1) {
      const name = `${key}/${index}`;
      const issueId = stableUuid("durability-issue", name);
      const openedDaysAgo = 12 + Math.floor(spread(`${name}/opened`) * 70);
      const thresholdDays = 7;

      // Where in the ageing window the claim landed. A unit that works to the
      // deadline lands near 1.0; one that works to the job lands anywhere.
      const nearDeadline = spread(`${name}/deadline`) < unit.nearDeadline;
      const claimAtFraction = nearDeadline
        ? 0.92 + spread(`${name}/frac`) * 0.07
        : 0.15 + spread(`${name}/frac`) * 0.6;
      const claimDaysAfterOpen = thresholdDays * claimAtFraction;

      const reopened = spread(`${name}/return`) < unit.returnRate;
      const thin = spread(`${name}/thin`) < unit.thin;
      // A few claims in every unit are disputed outright rather than confirmed.
      const disputed = spread(`${name}/dispute`) < 0.06;

      const reporterId = stableUuid("durability-reporter", name);
      await client.query(
        "insert into participant (participant_id) values ($1) on conflict do nothing",
        [reporterId],
      );

      const opened = `now() - interval '${openedDaysAgo} days'`;
      const claimed = `now() - interval '${(openedDaysAgo - claimDaysAfterOpen).toFixed(3)} days'`;

      const issue = await client.query(
        `insert into canonical_issue
           (issue_id, public_reference, category, current_status, opened_at,
            representative_location, last_evidence_at, jurisdiction_id)
         values ($1,$2,$3,$4, ${opened},
                 ST_SetSRID(ST_MakePoint($5,$6),4326)::geography, ${opened}, $7)
         on conflict (issue_id) do nothing`,
        [
          issueId,
          `VIS-DUR-${issueId.slice(0, 8).toUpperCase()}`,
          unit.department === "demo-water-supply"
            ? "water_supply"
            : unit.department === "demo-electrical"
              ? "electrical"
              : "sanitation",
          // Every seeded issue ends confirmed.
          //
          // Not cosmetic: a hundred and sixty-nine seeded issues sitting in the
          // oversight queues would bury the handful a supervisor is meant to
          // see, and it broke a V036 test by pushing a real issue past the
          // queue's limit. The history stays truthful — the reopen and dispute
          // events are recorded and the durability signals read those — but
          // each story finishes.
          "resolution_confirmed",
          74.56 + spread(`${name}/lon`) * 0.05,
          16.85 + spread(`${name}/lat`) * 0.05,
          jurisdictionId,
        ],
      );
      summary.issues += issue.rowCount;
      if (issue.rowCount === 0) continue; // already seeded by an earlier run

      // The assignment carries when the crew got the work, which is what the
      // speed signal reads now that no planning event is written.
      const planningMinutesBefore = thin ? 6 : 60 + Math.floor(spread(`${name}/plan`) * 2880);
      await client.query(
        `insert into assignment
           (assignment_id, issue_id, department_id, assigned_staff_id, reason, valid_from, current_version)
         values ($1,$2,$3,$4,'seeded completion history (V050a demonstration)',
                 ${claimed} - interval '${planningMinutesBefore} minutes', 1)`,
        [stableUuid("durability-assignment", name), issueId, unit.department, staffId],
      );

      // The ageing record the "near the deadline" signal reads its threshold from.
      await client.query(
        `insert into issue_alert
           (alert_id, issue_id, rule_id, window_start, raised_at, department_age_days,
            citizen_age_days, threshold_days, rule_source, policy_version, reasons,
            acknowledged_at, acknowledged_by)
         values ($1,$2,'overdue', ${opened}, ${opened} + interval '${thresholdDays} days',
                 $3,$3,$4,'category','demo-ageing.v1',$5::jsonb,
                 ${opened} + interval '${thresholdDays + 1} days', $6)`,
        [
          stableUuid("durability-alert", name),
          issueId,
          thresholdDays,
          thresholdDays,
          JSON.stringify({ seeded: true }),
          // Acknowledged when raised: these alerts are history, and an
          // unacknowledged one belongs to a supervisor who has not looked yet.
          staffId,
        ],
      );
      summary.alerts += 1;

      // `occurred_at` is backdated because the work happened months ago;
      // `recorded_at` is now, because that is when this row was written.
      //
      // Getting that backwards broke V038: its projection cursor follows
      // ingestion order, so events written today with a recorded_at of eighty
      // days ago land behind a watermark that has already passed them, and the
      // projection silently never sees them.
      //
      // `clock_timestamp()` rather than `now()`, for a second reason found the
      // same way: `now()` is transaction time, so every row in this seeder
      // would carry one identical recorded_at, and a cursor over hundreds of
      // events sharing a single timestamp cannot advance through them.
      const event = async (type, at, version) => {
        await client.query(
          `insert into status_event
             (event_id, aggregate_type, aggregate_id, aggregate_version, event_type,
              actor_type, correlation_id, occurred_at, recorded_at, payload_schema_version, payload)
           values ($1,'canonical_issue',$2,$3,$4,'staff',$5, ${at}, clock_timestamp(),'1.0.0',$6::jsonb)
           on conflict do nothing`,
          [
            stableUuid("durability-event", `${name}/${type}`),
            issueId,
            version,
            type,
            stableUuid("durability-correlation", name),
            JSON.stringify({ seeded: true }),
          ],
        );
      };

      // Work planned shortly before the claim. A unit that claims within
      // minutes of planning shows up in the speed signal; most do not.
      // No planning or claim events are written.
      //
      // The measurement reads the assignment for planning time and the
      // resolution tables for the rest, so these would add nothing — and a
      // seeder writing several events per issue pushed the canonical_issue
      // event table past V038's 500-row apply batch, which broke summaries
      // tests that legitimately expect a fresh projection to drain its backlog
      // in one pass. A fixture must not change the shape of what it fixtures.

      const claimId = stableUuid("durability-claim", name);
      await client.query(
        `insert into resolution_claim
           (claim_id, issue_id, staff_id, idempotency_key, claimed_at, description)
         values ($1,$2,$3,$4, ${claimed}, 'Work completed and site cleared (seeded demonstration record).')`,
        [claimId, issueId, staffId, `durability-${name}`],
      );
      summary.claims += 1;

      // Completion evidence. `thin` claims carry the single photograph the
      // policy's floor accepts; the rest carry two.
      for (let piece = 0; piece < (thin ? 1 : 2); piece += 1) {
        await client.query(
          `insert into resolution_evidence_item
             (resolution_evidence_id, claim_id, media_type, object_reference, fingerprint_hash,
              capture_metadata, redaction_status, derivative_reference, privacy_state, current_version)
           values ($1,$2,'photo',$3,$4,$5::jsonb,'approved',$6,'active',1)`,
          [
            stableUuid("durability-evidence", `${name}/${piece}`),
            claimId,
            `originals/durability/${claimId}-${piece}`,
            createHash("sha256").update(`${name}/${piece}`).digest("hex"),
            JSON.stringify({ gpsPresent: false, captureOffsetKnown: false, warnings: [] }),
            `derivatives/durability/${claimId}-${piece}`,
          ],
        );
      }

      const answeredAt = `${claimed} + interval '${1 + Math.floor(spread(`${name}/answer`) * 3)} days'`;
      await client.query(
        `insert into resolution_confirmation
           (confirmation_id, claim_id, responding_participant_id, decision, decided_at, comment)
         values ($1,$2,$3,$4, ${answeredAt}, null)`,
        [
          stableUuid("durability-confirmation", name),
          claimId,
          reporterId,
          disputed ? "disputed" : "confirmed",
        ],
      );
      summary.confirmations += 1;

      if (reopened && !disputed) {
        // The comeback is recorded as a second completion claim rather than a
        // reopening event, and the measurement reads it either way.
        //
        // Why: this seeder's events pushed the canonical_issue event table
        // from 473 to 503 against V038's 500-row apply batch, and a summaries
        // test that legitimately expects a fresh projection to drain its
        // backlog in one pass began to fail. A fixture that changes the
        // behaviour of the system it is demonstrating is not a fixture. The
        // second claim is also the more faithful record: the issue came back
        // and somebody was sent out again.
        const reopenedAt = `${answeredAt} + interval '${3 + Math.floor(spread(`${name}/reopen`) * 20)} days'`;
        const secondClaimId = stableUuid("durability-claim-second", name);
        await client.query(
          `insert into resolution_claim
             (claim_id, issue_id, staff_id, idempotency_key, claimed_at, description)
           values ($1,$2,$3,$4, ${reopenedAt}, 'Returned to site; work redone (seeded demonstration record).')`,
          [secondClaimId, issueId, staffId, `durability-${name}-second`],
        );
        await client.query(
          `insert into resolution_evidence_item
             (resolution_evidence_id, claim_id, media_type, object_reference, fingerprint_hash,
              capture_metadata, redaction_status, derivative_reference, privacy_state, current_version)
           values ($1,$2,'photo',$3,$4,$5::jsonb,'approved',$6,'active',1)`,
          [
            stableUuid("durability-evidence-second", name),
            secondClaimId,
            `originals/durability/${secondClaimId}-0`,
            createHash("sha256").update(`${name}/second`).digest("hex"),
            JSON.stringify({ gpsPresent: false, captureOffsetKnown: false, warnings: [] }),
            `derivatives/durability/${secondClaimId}-0`,
          ],
        );
        await client.query(
          `insert into resolution_confirmation
             (confirmation_id, claim_id, responding_participant_id, decision, decided_at, comment)
           values ($1,$2,$3,'confirmed', ${reopenedAt} + interval '2 days', null)`,
          [stableUuid("durability-confirmation-second", name), secondClaimId, reporterId],
        );
        summary.reopenings += 1;
      }
    }
  }

  await client.query("commit");
  console.log(`seed:durability OK — ${JSON.stringify(summary)}`);
  console.log("every row is team-created synthetic data (V004 §5).");
} catch (error) {
  await client.query("rollback");
  console.error("seed:durability failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await client.end();
}
