/**
 * Deterministic end-to-end fixture for V035 (resolution claims and
 * confirmation).
 *
 * The rest of the corpus stops at submissions: canonical issues are produced
 * by the matching pipeline, so a fresh database has nothing for a department
 * to work on and nothing for a citizen to confirm. This creates the two issues
 * a demonstration of V035 needs, and nothing else.
 *
 * Everything is derived from a fixed seed string, so running it twice produces
 * the same rows and a demo can be replayed. It is additive and idempotent:
 * every insert is `on conflict do nothing`, so it never disturbs work already
 * done against these issues.
 *
 * Two issues rather than one, because the interesting part of V035 is that the
 * bar differs by category:
 *
 *   * a **routine** category (one confirmation, reviewer may resolve a
 *     dispute in favour of the claim) — the path a demonstration walks;
 *   * a **safety** category (two confirmations from two different people, no
 *     reviewer override, and a second disclosure saying no qualified
 *     inspection has happened) — the path that shows the policy has teeth.
 *
 * Participation is attached to the demo citizen accounts by pre-creating their
 * identity mappings with the same keyed hash `IdentityService` computes. When
 * those citizens sign in, `resolveParticipant` finds the mapping that is
 * already there and returns the same participant — so "only a counted
 * participant may confirm" can be demonstrated rather than asserted.
 */

import { createHash, createHmac } from "node:crypto";

const SEED = "vision-v035-demo";
const PROVIDER = "simulated-identity";

/** A UUID that is the same on every run, so a demo is replayable. */
const stableUuid = (namespace, name) => {
  const digest = createHash("sha256").update(`${SEED}:${namespace}:${name}`).digest("hex");
  const hex = digest.slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = "89ab"[parseInt(digest[16], 16) % 4];
  const joined = hex.join("");
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
};

/**
 * The demo citizens who will be able to answer a claim.
 *
 * Subject references match `DEMO_PRINCIPALS` in `packages/adapters/src/identity.ts`.
 * They are repeated rather than imported because this is a plain Node script
 * and the adapters are TypeScript; `seed-v035-demo.test.mjs` asserts the two
 * lists still agree, so a drift is a failing test rather than a silent
 * mismatch that only shows up as "you are not a counted participant".
 */
export const DEMO_CITIZEN_SUBJECTS = ["demo-subject-0001", "demo-subject-0002"];

/**
 * The two issues. Categories must exist in the routing pack, or the issue
 * lands in no department inbox and the demonstration has nothing to show.
 */
const ISSUES = [
  {
    key: "routine",
    category: "water_supply",
    departmentId: "demo-water-supply",
    reference: "VIS-V035-WATER",
    summary: "A standpipe on the approach road has been leaking for several days.",
    lon: 75.9064,
    lat: 17.6599,
  },
  {
    key: "safety",
    category: "electrical",
    departmentId: "demo-electrical",
    reference: "VIS-V035-LIGHT",
    summary: "A street light pole is live to the touch after rain.",
    lon: 75.9071,
    lat: 17.6605,
  },
];

export const seedV035Demo = async (client, environment = process.env) => {
  const hmacKey = environment["IDENTITY_MAPPING_HMAC_KEY"];
  if (hmacKey === undefined || hmacKey.length === 0) {
    // Refused rather than defaulted. A guessed key produces mappings the
    // running service will not recognise, so the demo citizens would sign in
    // as *different* participants and be told they may not confirm — which
    // looks like a permissions bug rather than a seeding mistake.
    throw new Error(
      "IDENTITY_MAPPING_HMAC_KEY must be set so the seeded identity mappings match the ones the API will look up",
    );
  }

  const summary = { participants: 0, issues: 0, participation: 0, events: 0 };
  await client.query("begin");
  try {
    const { rows: jurisdictions } = await client.query(
      "select jurisdiction_id, internal_code from jurisdiction where internal_code = $1",
      ["DDA-B1"],
    );
    const jurisdictionId = jurisdictions[0]?.jurisdiction_id;
    if (jurisdictionId === undefined) {
      throw new Error("jurisdiction DDA-B1 is not seeded; run `npm run db:seed` first");
    }

    // ── The demo citizens ────────────────────────────────────────────────
    const participantIds = [];
    for (const subject of DEMO_CITIZEN_SUBJECTS) {
      // The separator is a NUL, exactly as `IdentityService.hashProviderSubject`
      // writes it. A space here produces a hash nothing will ever look up, so
      // the seeded mapping is orphaned and the demo citizen signs in as a
      // different participant — which surfaces as "you are not a counted
      // participant" on their own report and looks like a permissions bug.
      const subjectHash = createHmac("sha256", hmacKey)
        .update(`${PROVIDER}\u0000${subject}`)
        .digest("hex");

      // An existing mapping wins. If this credential has ever signed in, the
      // identity service already chose a participant for it, and that is the
      // one the session will resolve to — seeding a second would attach the
      // participation to somebody who never signs in, and the demo citizen
      // would be told they are not a counted participant on their own report.
      const { rows: existing } = await client.query(
        `select participant_id from identity_mapping
          where provider = $1 and provider_subject_hash = $2 and erased_at is null`,
        [PROVIDER, subjectHash],
      );
      const participantId = existing[0]?.participant_id ?? stableUuid("participant", subject);
      participantIds.push(participantId);

      if (existing[0] === undefined) {
        const created = await client.query(
          "insert into participant (participant_id) values ($1) on conflict do nothing",
          [participantId],
        );
        summary.participants += created.rowCount;
        await client.query(
          `insert into identity_mapping
             (identity_mapping_id, participant_id, provider, provider_subject_hash, provider_mode)
           values ($1,$2,$3,$4,'simulated')
           on conflict do nothing`,
          [stableUuid("mapping", subject), participantId, PROVIDER, subjectHash],
        );
      }
    }

    for (const issue of ISSUES) {
      const issueId = stableUuid("issue", issue.key);
      const created = await client.query(
        `insert into canonical_issue
           (issue_id, public_reference, category, current_status, opened_at,
            representative_location, last_evidence_at, jurisdiction_id)
         values ($1,$2,$3,'routed_internal', now() - interval '9 days',
                 ST_SetSRID(ST_MakePoint($4,$5),4326)::geography,
                 now() - interval '9 days', $6)
         on conflict (issue_id) do nothing`,
        [issueId, issue.reference, issue.category, issue.lon, issue.lat, jurisdictionId],
      );
      summary.issues += created.rowCount;

      // Routed, so the issue appears in exactly one department inbox and the
      // V034 acknowledgment and assignment actions apply to it. The
      // responsibility row is looked up rather than invented: a routed
      // decision must name the directory entry it came from, which is what
      // makes the route re-derivable.
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
          `department '${issue.departmentId}' is not in the seeded responsibility directory; run \`npm run db:seed\` first`,
        );
      }
      await client.query(
        `insert into routing_decision
           (routing_id, issue_id, directory_version, category, jurisdiction_id,
            responsibility_id, department_id, department_label, recipient_mode,
            outcome, reason, decided_at)
         values ($1,$2,'demo-routing.v1',$3,$4,$5,$6,$7,'simulated','routed',$8,
                 now() - interval '8 days')
         on conflict do nothing`,
        [
          stableUuid("routing", issue.key),
          issueId,
          issue.category,
          jurisdictionId,
          responsibility.responsibility_id,
          issue.departmentId,
          responsibility.department_label,
          "Seeded by tools/seed-v035-demo.mjs so the V035 workflow has an issue to act on; the recipient is simulated.",
        ],
      );

      // One submission per citizen, so both have counted participation and the
      // "two different people" rule can actually be exercised.
      for (const [index, participantId] of participantIds.entries()) {
        const submissionId = stableUuid("submission", `${issue.key}/${String(index)}`);
        await client.query(
          `insert into submission
             (submission_id, participant_id, observed_location, observed_accuracy_m,
              observed_location_source, observed_at, interface_locale, locale_pack_version,
              taxonomy_version, idempotency_key)
           values ($1,$2, ST_SetSRID(ST_MakePoint($3,$4),4326)::geography, 14,
                   'device_geolocation', now() - interval '9 days', 'en-IN',
                   'demo-locales.v1','demo-taxonomy.v1',$5)
           on conflict (submission_id) do update set participant_id = excluded.participant_id`,
          [submissionId, participantId, issue.lon, issue.lat, `v035-demo-${submissionId}`],
        );

        const evidenceId = stableUuid("evidence", `${issue.key}/${String(index)}`);
        await client.query(
          `insert into evidence_item
             (evidence_id, submission_id, media_type, content_text, processing_status,
              redaction_status, captured_at)
           values ($1,$2,'text',$3,'usable','not_required', now() - interval '9 days')
           on conflict do nothing`,
          [evidenceId, submissionId, issue.summary],
        );
        await client.query(
          `insert into issue_evidence_link
             (issue_evidence_link_id, canonical_issue_id, evidence_id, effective_from)
           values ($1,$2,$3, now() - interval '9 days')
           on conflict do nothing`,
          [stableUuid("link", `${issue.key}/${String(index)}`), issueId, evidenceId],
        );

        const participation = await client.query(
          `insert into issue_participation
             (participation_id, participant_id, canonical_issue_id, counted,
              first_evidence_at, last_evidence_at)
           values ($1,$2,$3,true, now() - interval '9 days', now() - interval '9 days')
           -- Re-pointed rather than skipped. An earlier run may have attached
           -- this slot to a placeholder participant before the demo credential
           -- had ever signed in; leaving that in place is what produces
           -- "you are not a counted participant" on your own report.
           on conflict (participation_id) do update
             set participant_id = excluded.participant_id, counted = true`,
          [stableUuid("participation", `${issue.key}/${String(index)}`), participantId, issueId],
        );
        summary.participation += participation.rowCount;
      }

      // Version 1 of the issue's event stream. The lifecycle advances append
      // 2, 3, … so the contiguity V035 asserts holds from the first event.
      const event = await client.query(
        `insert into status_event
           (event_id, aggregate_type, aggregate_id, aggregate_version, event_type,
            actor_type, correlation_id, occurred_at, payload_schema_version, payload)
         values ($1,'canonical_issue',$2,1,'routed_internal','system_worker',$3,
                 now() - interval '8 days','1.0.0',$4::jsonb)
         on conflict do nothing`,
        [
          stableUuid("event", issue.key),
          issueId,
          stableUuid("correlation", issue.key),
          JSON.stringify({
            department_id: issue.departmentId,
            directory_version: "demo-routing.v1",
            seeded: true,
          }),
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
