/**
 * Deterministic ageing fixture for V036.
 *
 * The V035 fixture produces issues that move through the workflow quickly. To
 * demonstrate ageing you need the opposite: a report that was routed to a
 * department and then simply sat there. This creates one, dated far enough
 * back that it is past both the configured wait and the escalation wait for
 * its category, so a sweep raises both alerts on the first pass.
 *
 * Derived from a fixed seed, additive, and idempotent — the same rules the
 * V035 fixture follows, so a demonstration can be replayed.
 *
 * It deliberately does **not** pre-write any `issue_alert` rows. The alerts
 * must come from the sweep evaluating a clock, because that is the thing V036
 * is claiming works; seeding them would demonstrate nothing.
 */

import { createHash } from "node:crypto";

const SEED = "vision-v036-demo";

const stableUuid = (namespace, name) => {
  const digest = createHash("sha256").update(`${SEED}:${namespace}:${name}`).digest("hex");
  const hex = digest.slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = "89ab"[parseInt(digest[16], 16) % 4];
  const joined = hex.join("");
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
};

/**
 * Two issues, chosen to separate the two things a supervisor screen must not
 * conflate: a department that has been slow, and a department nobody has asked
 * yet because the recipient never replied.
 */
const ISSUES = [
  {
    key: "aged-sanitation",
    category: "sanitation",
    departmentId: "demo-sanitation",
    reference: "VIS-V036-WAIT",
    summary: "The drain outside the school gate has been blocked since the last rain.",
    lon: 75.9058,
    lat: 17.6592,
    openedDaysAgo: 40,
    routedDaysAgo: 38,
  },
  {
    key: "aged-electrical",
    category: "electrical",
    departmentId: "demo-electrical",
    reference: "VIS-V036-DARK",
    summary: "Three street lights on the approach road have been out for weeks.",
    lon: 75.9067,
    lat: 17.6588,
    openedDaysAgo: 21,
    routedDaysAgo: 19,
  },
];

export const seedV036Demo = async (client) => {
  const summary = { issues: 0, participation: 0, events: 0 };
  await client.query("begin");
  try {
    const { rows: jurisdictions } = await client.query(
      "select jurisdiction_id from jurisdiction where internal_code = $1",
      ["DDA-B1"],
    );
    const jurisdictionId = jurisdictions[0]?.jurisdiction_id;
    if (jurisdictionId === undefined) {
      throw new Error("jurisdiction DDA-B1 is not seeded; run `npm run db:seed` first");
    }

    // Reuse whichever participants the V035 fixture already bound to the demo
    // citizen credentials, so the counted-participation story stays consistent.
    const { rows: participants } = await client.query(
      `select participant_id from identity_mapping
        where provider = 'simulated-identity' and erased_at is null
        order by created_at asc limit 2`,
    );

    for (const issue of ISSUES) {
      const issueId = stableUuid("issue", issue.key);
      const created = await client.query(
        `insert into canonical_issue
           (issue_id, public_reference, category, current_status, opened_at,
            representative_location, last_evidence_at, jurisdiction_id)
         values ($1,$2,$3,'routed_internal', now() - ($4 || ' days')::interval,
                 ST_SetSRID(ST_MakePoint($5,$6),4326)::geography,
                 now() - ($4 || ' days')::interval, $7)
         on conflict (issue_id) do nothing`,
        [
          issueId,
          issue.reference,
          issue.category,
          String(issue.openedDaysAgo),
          issue.lon,
          issue.lat,
          jurisdictionId,
        ],
      );
      summary.issues += created.rowCount;

      const { rows: responsibilities } = await client.query(
        `select responsibility_id, department_label from responsibility_directory
          where jurisdiction_id = $1 and department_id = $2
            and effective_from <= now() and (effective_to is null or effective_to > now())
          order by effective_from desc limit 1`,
        [jurisdictionId, issue.departmentId],
      );
      const responsibility = responsibilities[0];
      if (responsibility === undefined) {
        throw new Error(
          `department '${issue.departmentId}' is not in the seeded responsibility directory`,
        );
      }

      // Routed this long ago and never acknowledged: this is the department
      // clock the sweep will measure.
      await client.query(
        `insert into routing_decision
           (routing_id, issue_id, directory_version, category, jurisdiction_id,
            responsibility_id, department_id, department_label, recipient_mode,
            outcome, reason, decided_at)
         values ($1,$2,'demo-routing.v1',$3,$4,$5,$6,$7,'simulated','routed',$8,
                 now() - ($9 || ' days')::interval)
         on conflict do nothing`,
        [
          stableUuid("routing", issue.key),
          issueId,
          issue.category,
          jurisdictionId,
          responsibility.responsibility_id,
          issue.departmentId,
          responsibility.department_label,
          "Seeded by tools/seed-v036-demo.mjs so the ageing sweep has a real clock to measure.",
          String(issue.routedDaysAgo),
        ],
      );

      for (const [index, row] of participants.entries()) {
        const submissionId = stableUuid("submission", `${issue.key}/${String(index)}`);
        await client.query(
          `insert into submission
             (submission_id, participant_id, observed_location, observed_accuracy_m,
              observed_location_source, observed_at, interface_locale, locale_pack_version,
              taxonomy_version, idempotency_key)
           values ($1,$2, ST_SetSRID(ST_MakePoint($3,$4),4326)::geography, 15,
                   'device_geolocation', now() - ($5 || ' days')::interval, 'en-IN',
                   'demo-locales.v1','demo-taxonomy.v1',$6)
           on conflict (submission_id) do update set participant_id = excluded.participant_id`,
          [
            submissionId,
            row.participant_id,
            issue.lon,
            issue.lat,
            String(issue.openedDaysAgo),
            `v036-demo-${submissionId}`,
          ],
        );
        const evidenceId = stableUuid("evidence", `${issue.key}/${String(index)}`);
        await client.query(
          `insert into evidence_item
             (evidence_id, submission_id, media_type, content_text, processing_status,
              redaction_status, captured_at)
           values ($1,$2,'text',$3,'usable','not_required', now() - ($4 || ' days')::interval)
           on conflict (evidence_id) do nothing`,
          [evidenceId, submissionId, issue.summary, String(issue.openedDaysAgo)],
        );
        await client.query(
          `insert into issue_evidence_link
             (issue_evidence_link_id, canonical_issue_id, evidence_id, effective_from)
           values ($1,$2,$3, now() - ($4 || ' days')::interval)
           on conflict do nothing`,
          [
            stableUuid("link", `${issue.key}/${String(index)}`),
            issueId,
            evidenceId,
            String(issue.openedDaysAgo),
          ],
        );
        const participation = await client.query(
          `insert into issue_participation
             (participation_id, participant_id, canonical_issue_id, counted,
              first_evidence_at, last_evidence_at)
           values ($1,$2,$3,true, now() - ($4 || ' days')::interval,
                   now() - ($4 || ' days')::interval)
           on conflict (participation_id) do update
             set participant_id = excluded.participant_id, counted = true`,
          [
            stableUuid("participation", `${issue.key}/${String(index)}`),
            row.participant_id,
            issueId,
            String(issue.openedDaysAgo),
          ],
        );
        summary.participation += participation.rowCount;
      }

      const event = await client.query(
        `insert into status_event
           (event_id, aggregate_type, aggregate_id, aggregate_version, event_type,
            actor_type, correlation_id, occurred_at, payload_schema_version, payload)
         values ($1,'canonical_issue',$2,1,'routed_internal','system_worker',$3,
                 now() - ($4 || ' days')::interval,'1.0.0',$5::jsonb)
         on conflict do nothing`,
        [
          stableUuid("event", issue.key),
          issueId,
          stableUuid("correlation", issue.key),
          String(issue.routedDaysAgo),
          JSON.stringify({ department_id: issue.departmentId, seeded: true }),
        ],
      );
      summary.events += event.rowCount;
    }

    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
  return summary;
};
