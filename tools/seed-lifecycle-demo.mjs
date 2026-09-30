#!/usr/bin/env node
/**
 * One report at every point of the lifecycle (report roadmap design, 2026-09-30).
 *
 * Usage: npm run db:seed:lifecycle
 *
 * Every row is team-created synthetic data (V004 §5): no person, department,
 * repair or place below is real. It exists so each roadmap state — being
 * checked, choosing a department, with the department on time, flagged,
 * escalated, acknowledged, planned, a claimed repair waiting for the resident,
 * confirmed, disputed, reopened — can be seen without waiting weeks for a
 * clock to run.
 *
 * The reports belong to the resident account the Residents door signs in
 * ("Demo citizen 1"), found the way sign-in finds it — the keyed hash of its
 * identity — so they appear in that resident's own reports. They are placed
 * around that resident's latest report, so "search near my location" finds
 * them; with no report yet, around the demo district.
 *
 * Idempotent: every identifier is derived from a stable name, and a previous
 * run's rows (public references VIS-LC-…) are removed first.
 */

import { createHash, createHmac } from "node:crypto";
import pg from "pg";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://vision:vision_local_dev_only@127.0.0.1:5432/vision_dev";
const DAY = 86_400_000;

const stableUuid = (name) => {
  const hex = createHash("sha256")
    .update(`lifecycle-demo:${name}`)
    .digest("hex")
    .slice(0, 32)
    .split("");
  hex[12] = "4";
  hex[16] = "89ab"[parseInt(hex[16], 16) % 4];
  const h = hex.join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};

/**
 * The cases. `routedDaysAgo` anchors the department clock; the ageing pack
 * gives sanitation and water supply 7/14 days and electrical 3/7.
 */
const CASES = [
  {
    key: "checking",
    text: "Streetlight flickering all night outside the bus stop.",
    category: "electrical",
    stage: "checking",
  },
  {
    key: "routing",
    text: "Open drain overflowing onto the footpath.",
    category: "sanitation",
    stage: "routing_review",
  },
  {
    key: "on-time",
    text: "Pothole near the school gate, about a metre wide.",
    category: "sanitation",
    stage: "routed",
    routedDaysAgo: 2,
  },
  {
    key: "flagged",
    text: "Broken water pipe leaking into the road.",
    category: "water_supply",
    stage: "routed",
    routedDaysAgo: 9,
    alerts: ["overdue"],
  },
  {
    key: "escalated",
    text: "Garbage not collected for two weeks at the market corner.",
    category: "sanitation",
    stage: "routed",
    routedDaysAgo: 16,
    alerts: ["overdue", "escalated"],
  },
  {
    key: "acknowledged",
    text: "Exposed electrical wires on the pole by the temple.",
    category: "electrical",
    stage: "acknowledged",
    routedDaysAgo: 2,
  },
  {
    key: "planned",
    text: "Manhole cover missing on the main road.",
    category: "sanitation",
    stage: "work_planned",
    routedDaysAgo: 5,
  },
  {
    key: "claimed",
    text: "No water supply in the lane since Monday.",
    category: "water_supply",
    stage: "claimed",
    routedDaysAgo: 6,
  },
  {
    key: "confirmed",
    text: "Streetlight out at the junction.",
    category: "electrical",
    stage: "confirmed",
    routedDaysAgo: 8,
  },
  {
    key: "disputed",
    text: "Drain blocked outside the clinic.",
    category: "sanitation",
    stage: "disputed",
    routedDaysAgo: 10,
  },
  {
    key: "reopened",
    text: "Water pipe burst again near the park.",
    category: "water_supply",
    stage: "reopened",
    routedDaysAgo: 12,
  },
];

const client = new pg.Client({ connectionString: DATABASE_URL, statement_timeout: 60_000 });
await client.connect();

try {
  // ── Who and where ────────────────────────────────────────────────────────
  let participantId = process.env.SEED_PARTICIPANT_ID;
  if (participantId === undefined) {
    const key = process.env.IDENTITY_MAPPING_HMAC_KEY;
    if (key === undefined || key.length === 0) {
      throw new Error(
        "IDENTITY_MAPPING_HMAC_KEY is needed to find the resident account (or set SEED_PARTICIPANT_ID)",
      );
    }
    const hash = createHmac("sha256", key)
      // The same string sign-in hashes: provider, a NUL, the subject.
      .update("simulated-identity\u0000demo-subject-0001")
      .digest("hex");
    const { rows } = await client.query(
      "select participant_id from identity_mapping where provider_subject_hash = $1 and erased_at is null",
      [hash],
    );
    participantId = rows[0]?.participant_id;
    if (participantId === undefined) {
      throw new Error(
        "the resident account has never signed in on this database; open app.html once, then rerun",
      );
    }
  }

  const { rows: here } = await client.query(
    `select ST_X(observed_location::geometry) as lon, ST_Y(observed_location::geometry) as lat
       from submission where participant_id = $1 and observed_location is not null
        and idempotency_key not like 'lifecycle-demo-%'
      order by server_received_at desc limit 1`,
    [participantId],
  );
  const centre = here[0] ?? { lon: 74.56, lat: 16.85 };

  const { rows: staff } = await client.query(
    "select staff_id from staff_account where role = 'department_staff' order by created_at limit 1",
  );
  const staffId = staff[0]?.staff_id;
  if (staffId === undefined)
    throw new Error(
      "no department staff account exists; sign in as department staff once, then rerun",
    );

  const directoryFor = async (category) => {
    const prefix = {
      sanitation: "sanitation.",
      water_supply: "water.",
      electrical: "electrical.",
      structural: "structure.",
    }[category];
    const { rows } = await client.query(
      `select responsibility_id, department_id from responsibility_directory
        where category like $1 order by category limit 1`,
      [`${prefix}%`],
    );
    if (rows[0] === undefined) throw new Error(`no routing directory entry for '${category}'`);
    return rows[0];
  };

  await client.query("begin");

  // ── Remove a previous run ────────────────────────────────────────────────
  const { rows: previous } = await client.query(
    "select issue_id from canonical_issue where public_reference like 'VIS-LC-%'",
  );
  const previousIssues = previous.map((row) => row.issue_id);
  const previousSubmissions = CASES.map((c) => stableUuid(`submission:${c.key}`));
  if (previousIssues.length > 0) {
    const ids = [previousIssues];
    await client.query("delete from reopening where issue_id = any($1::uuid[])", ids);
    await client.query(
      "delete from resolution_confirmation where claim_id in (select claim_id from resolution_claim where issue_id = any($1::uuid[]))",
      ids,
    );
    await client.query(
      "delete from resolution_evidence_item where claim_id in (select claim_id from resolution_claim where issue_id = any($1::uuid[]))",
      ids,
    );
    await client.query("delete from resolution_claim where issue_id = any($1::uuid[])", ids);
    await client.query("delete from issue_alert where issue_id = any($1::uuid[])", ids);
    await client.query("delete from routing_decision where issue_id = any($1::uuid[])", ids);
    await client.query(
      "delete from issue_participation where canonical_issue_id = any($1::uuid[])",
      ids,
    );
    await client.query(
      "delete from issue_evidence_link where canonical_issue_id = any($1::uuid[])",
      ids,
    );
    await client.query(
      "delete from summary_applied_event where event_id in (select event_id from status_event where aggregate_id = any($1::text[]))",
      ids,
    );
    // The summary projection keeps a pointer to each issue's last event, so once
    // the worker has run, the facts have to go before the events they cite.
    await client.query("delete from summary_issue_fact where issue_id = any($1::uuid[])", ids);
    await client.query("delete from status_event where aggregate_id = any($1::text[])", ids);
    await client.query("delete from canonical_issue where issue_id = any($1::uuid[])", ids);
  }
  await client.query(
    "delete from summary_applied_event where event_id in (select event_id from status_event where aggregate_id = any($1::text[]))",
    [previousSubmissions],
  );
  await client.query(
    "delete from outbox where event_id in (select event_id from status_event where aggregate_id = any($1::text[]))",
    [previousSubmissions],
  );
  await client.query("delete from status_event where aggregate_id = any($1::text[])", [
    previousSubmissions,
  ]);
  await client.query("delete from evidence_item where submission_id = any($1::uuid[])", [
    previousSubmissions,
  ]);
  await client.query("delete from submission where submission_id = any($1::uuid[])", [
    previousSubmissions,
  ]);

  // ── The cases ────────────────────────────────────────────────────────────
  const now = Date.now();
  const at = (ms) => new Date(Math.floor(ms / 1000) * 1000).toISOString();
  const event = async (aggregateType, aggregateId, version, type, when, name) => {
    await client.query(
      `insert into status_event
         (event_id, aggregate_type, aggregate_id, aggregate_version, event_type, actor_type,
          correlation_id, occurred_at, recorded_at, payload_schema_version, payload)
       values ($1,$2,$3,$4,$5,'system_worker',$6,$7, clock_timestamp(),'1.0.0',$8::jsonb)`,
      [
        stableUuid(`event:${name}`),
        aggregateType,
        aggregateId,
        version,
        type,
        stableUuid(`corr:${name}`),
        when,
        JSON.stringify({ seeded: "lifecycle-demo" }),
      ],
    );
  };

  for (const [index, c] of CASES.entries()) {
    const submissionId = stableUuid(`submission:${c.key}`);
    const evidenceId = stableUuid(`evidence:${c.key}`);
    const issueId = stableUuid(`issue:${c.key}`);
    const reference = `VIS-LC-${c.key.toUpperCase().replace(/-/g, "")}`.slice(0, 20);
    // A ring around the resident, a few hundred metres out, so each is its
    // own issue and all fall inside the nearby search.
    const angle = (index / CASES.length) * 2 * Math.PI;
    const lon = centre.lon + 0.004 * Math.cos(angle);
    const lat = centre.lat + 0.004 * Math.sin(angle);

    const routedMs =
      c.routedDaysAgo === undefined ? now - 3 * 3_600_000 : now - c.routedDaysAgo * DAY;
    const receivedMs = routedMs - 3_600_000;
    const checkedMs = receivedMs + 60_000;
    const groupedMs = receivedMs + 120_000;

    await client.query(
      `insert into submission
         (submission_id, participant_id, observed_at, server_received_at, observed_location,
          observed_accuracy_m, interface_locale, locale_pack_version, idempotency_key, taxonomy_version)
       values ($1,$2,$3,$3, ST_SetSRID(ST_MakePoint($4,$5),4326)::geography, 15,
               'en-IN','demo-locales.v1',$6,'demo-taxonomy.v1')`,
      [submissionId, participantId, at(receivedMs), lon, lat, `lifecycle-demo-${c.key}`],
    );
    await client.query(
      `insert into evidence_item (evidence_id, submission_id, media_type, content_text, processing_status, redaction_status, ingested_at)
       values ($1,$2,'text',$3,'usable','not_required',$4)`,
      [evidenceId, submissionId, c.text, at(receivedMs)],
    );
    await event(
      "Submission",
      submissionId,
      1,
      "submission_received",
      at(receivedMs),
      `${c.key}:received`,
    );

    if (c.stage === "checking") continue; // the worker has not run for this one

    await event(
      "Submission",
      submissionId,
      2,
      "submission_media_processed",
      at(checkedMs),
      `${c.key}:checked`,
    );

    const status = {
      routing_review: "routing_review",
      routed: "routed_internal",
      acknowledged: "agency_ack_received",
      work_planned: "work_planned",
      claimed: "resolution_claimed",
      confirmed: "resolution_confirmed",
      disputed: "resolution_disputed",
      reopened: "reopened",
    }[c.stage];
    await client.query(
      `insert into canonical_issue
         (issue_id, public_reference, category, current_status, opened_at, representative_location, last_evidence_at)
       values ($1,$2,$3,$4,$5, ST_SetSRID(ST_MakePoint($6,$7),4326)::geography, $5)`,
      [issueId, reference, c.category, status, at(groupedMs), lon, lat],
    );
    await client.query(
      `insert into issue_evidence_link (issue_evidence_link_id, evidence_id, canonical_issue_id, effective_from)
       values ($1,$2,$3,$4)`,
      [stableUuid(`link:${c.key}`), evidenceId, issueId, at(groupedMs)],
    );
    await client.query(
      `insert into issue_participation
         (participation_id, participant_id, canonical_issue_id, counted, first_evidence_at, last_evidence_at)
       values ($1,$2,$3,true,$4,$4)`,
      [stableUuid(`participation:${c.key}`), participantId, issueId, at(receivedMs)],
    );

    let version = 1;
    await event(
      "canonical_issue",
      issueId,
      version++,
      "issue_created",
      at(groupedMs),
      `${c.key}:created`,
    );

    if (c.stage === "routing_review") {
      await client.query(
        `insert into routing_decision (routing_id, issue_id, directory_version, category, recipient_mode, outcome, reason, decided_at)
         values ($1,$2,'demo-directory.v1',$3,'none','unknown_owner_review','no responsible department for this location in the directory',$4)`,
        [stableUuid(`routing:${c.key}`), issueId, c.category, at(groupedMs + 60_000)],
      );
      await event(
        "canonical_issue",
        issueId,
        version++,
        "routing_review",
        at(groupedMs + 60_000),
        `${c.key}:review`,
      );
      continue;
    }

    const directory = await directoryFor(c.category);
    await client.query(
      `insert into routing_decision
         (routing_id, issue_id, directory_version, category, recipient_mode, outcome, reason,
          decided_at, department_id, responsibility_id)
       values ($1,$2,'demo-directory.v1',$3,'simulated','routed','routed by the synthetic lifecycle seed',$4,$5,$6)`,
      [
        stableUuid(`routing:${c.key}`),
        issueId,
        c.category,
        at(routedMs),
        directory.department_id,
        directory.responsibility_id,
      ],
    );
    await event(
      "canonical_issue",
      issueId,
      version++,
      "routed_internal",
      at(routedMs),
      `${c.key}:routed`,
    );

    // Alerts the ageing sweep would have recorded, at the moment it would have.
    const policy = { sanitation: [7, 14], water_supply: [7, 14], electrical: [3, 7] }[c.category];
    for (const rule of c.alerts ?? []) {
      const threshold = rule === "overdue" ? policy[0] : policy[1];
      await client.query(
        `insert into issue_alert
           (alert_id, issue_id, rule_id, window_start, raised_at, department_age_days,
            citizen_age_days, threshold_days, rule_source, policy_version, reasons)
         values ($1,$2,$3,$4,$5,$6,$6,$6,'category','demo-ageing.v1',$7::jsonb)`,
        [
          stableUuid(`alert:${c.key}:${rule}`),
          issueId,
          rule,
          at(routedMs),
          at(routedMs + threshold * DAY),
          threshold,
          JSON.stringify(["seeded by the lifecycle demo"]),
        ],
      );
    }

    const later = ["acknowledged", "work_planned", "claimed", "confirmed", "disputed", "reopened"];
    if (!later.includes(c.stage)) continue;
    await event(
      "canonical_issue",
      issueId,
      version++,
      "agency_ack_received",
      at(routedMs + 0.5 * DAY),
      `${c.key}:ack`,
    );
    if (c.stage === "acknowledged") continue;
    await event(
      "canonical_issue",
      issueId,
      version++,
      "work_planned",
      at(routedMs + 1 * DAY),
      `${c.key}:planned`,
    );
    if (c.stage === "work_planned") continue;

    const claimId = stableUuid(`claim:${c.key}`);
    const claimedMs = routedMs + 2 * DAY;
    await client.query(
      `insert into resolution_claim (claim_id, issue_id, staff_id, idempotency_key, claimed_at, description)
       values ($1,$2,$3,$4,$5,'Repair completed by the crew (synthetic).')`,
      [claimId, issueId, staffId, `lifecycle-demo-claim-${c.key}`, at(claimedMs)],
    );
    // A claim with no completion photo cannot be confirmed by anyone (the
    // confirmation rule says so), so a demonstration claim carries one. The
    // object is a stand-in name, not a file: the page shows that no approved
    // picture is available rather than a broken image.
    await client.query(
      `insert into resolution_evidence_item
         (resolution_evidence_id, claim_id, media_type, object_reference, fingerprint_hash, redaction_status)
       values ($1,$2,'photo',$3,$4,'not_required')`,
      [
        stableUuid(`claim-evidence:${c.key}`),
        claimId,
        `synthetic/lifecycle-demo/${c.key}.jpg`,
        createHash("sha256").update(`lifecycle-demo-completion-photo:${c.key}`).digest("hex"),
      ],
    );
    await event(
      "canonical_issue",
      issueId,
      version++,
      "resolution_claimed",
      at(claimedMs),
      `${c.key}:claimed`,
    );
    if (c.stage === "claimed") continue;

    const decision = c.stage === "disputed" ? "disputed" : "confirmed";
    const confirmationId = stableUuid(`confirmation:${c.key}`);
    const decidedMs = claimedMs + 0.5 * DAY;
    await client.query(
      `insert into resolution_confirmation (confirmation_id, claim_id, decision, decided_at, responding_participant_id, comment)
       values ($1,$2,$3,$4,$5,$6)`,
      [
        confirmationId,
        claimId,
        decision,
        at(decidedMs),
        participantId,
        decision === "disputed" ? "The drain is still blocked." : null,
      ],
    );
    await event(
      "canonical_issue",
      issueId,
      version++,
      decision === "disputed" ? "resolution_disputed" : "resolution_confirmed",
      at(decidedMs),
      `${c.key}:${decision}`,
    );
    if (c.stage !== "reopened") continue;

    const reopenedMs = decidedMs + 2 * DAY;
    await client.query(
      `insert into reopening (reopening_id, issue_id, prior_confirmation_id, reopened_at, reason, actor_type, actor_id)
       values ($1,$2,$3,$4,'It burst again two days after the repair.','citizen',$5)`,
      [stableUuid(`reopening:${c.key}`), issueId, confirmationId, at(reopenedMs), participantId],
    );
    await event(
      "canonical_issue",
      issueId,
      version++,
      "issue_reopened",
      at(reopenedMs),
      `${c.key}:reopened`,
    );
  }

  await client.query("commit");
  console.log(
    `lifecycle demo: ${CASES.length} synthetic reports for resident ${participantId.slice(0, 8)}… around ${centre.lat.toFixed(4)}, ${centre.lon.toFixed(4)}`,
  );
  for (const c of CASES)
    console.log(`  ${c.stage.padEnd(15)} ${stableUuid(`submission:${c.key}`)}  ${c.text}`);
} catch (error) {
  await client.query("rollback").catch(() => undefined);
  console.error(
    `lifecycle demo seed failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
} finally {
  await client.end();
}
