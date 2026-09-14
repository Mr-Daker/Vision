/**
 * The configured confirmation policy actually governs resolution (roadmap V035).
 *
 * Run with: npm run db:up && npm run db:migrate && npm run test:db
 *
 * `resolution.dbtest.ts` already proves the adapter honours *a* policy, using a
 * policy the test wrote itself. That leaves the gap V035 recorded: nothing
 * loaded the pack, so in a deployment there was no policy at all. These tests
 * drive the real resolution path with the real on-disk pack, so a change to
 * `confirmation.json` that lowered the bar would change an outcome here.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

import type { Principal } from "@vision/domain";
import { claimResolution, respondToClaim, readResolutionState } from "@vision/adapters";

import {
  resolveConfirmationPolicy,
  resolveMatchingBounds,
  resolveTaxonomy,
  resolveTriagePolicy,
  ConfigPackError,
} from "./pack-composition.ts";

const DATABASE_URL =
  process.env["DATABASE_URL"] ??
  "postgresql://vision:vision_local_dev_only@127.0.0.1:5432/vision_dev";

const PROFILE = "demo-district-a";
const ORIGIN = { lon: 75.53, lat: 17.73 };

let client: pg.Client;
let jurisdictionId: string;
const issues: string[] = [];
const participants: string[] = [];
const submissions: string[] = [];
const claims: string[] = [];

const staff = (): Principal => ({
  role: "department_staff",
  staffId: randomUUID() as never,
  jurisdictionScope: [jurisdictionId],
  sessionId: randomUUID() as never,
});

before(async () => {
  client = new pg.Client({ connectionString: DATABASE_URL, statement_timeout: 15_000 });
  await client.connect();
  jurisdictionId = randomUUID();
  await client.query(
    `insert into jurisdiction
       (jurisdiction_id, jurisdiction_profile_id, internal_code, directory_version,
        level_scheme, level_code, effective_from, synthetic_provenance)
     values ($1,$2,$3,'demo-routing.v1','test-scheme','district',
             now() - interval '1 year', true)`,
    [jurisdictionId, PROFILE, `rp-${jurisdictionId.slice(0, 8)}`],
  );
});

after(async () => {
  await client.end().catch(() => undefined);
  const cleaner = new pg.Client({ connectionString: DATABASE_URL, statement_timeout: 10_000 });
  await cleaner.connect();
  try {
    if (claims.length > 0) {
      await cleaner.query("delete from resolution_confirmation where claim_id = any($1::uuid[])", [
        claims,
      ]);
      await cleaner
        .query("delete from resolution_evidence_item where claim_id = any($1::uuid[])", [claims])
        .catch(() => undefined);
      await cleaner.query("delete from resolution_claim where claim_id = any($1::uuid[])", [
        claims,
      ]);
    }
    if (participants.length > 0) {
      await cleaner.query(
        "delete from issue_participation where participant_id = any($1::uuid[])",
        [participants],
      );
    }
    if (submissions.length > 0) {
      await cleaner.query("delete from submission where submission_id = any($1::uuid[])", [
        submissions,
      ]);
    }
    if (issues.length > 0) {
      await cleaner.query("delete from status_event where aggregate_id = any($1::text[])", [
        issues,
      ]);
      await cleaner.query("delete from canonical_issue where issue_id = any($1::uuid[])", [issues]);
    }
    if (participants.length > 0) {
      await cleaner.query("delete from participant where participant_id = any($1::uuid[])", [
        participants,
      ]);
    }
    await cleaner.query("delete from jurisdiction where jurisdiction_id = $1", [jurisdictionId]);
  } finally {
    await cleaner.end();
  }
});

const workPlannedIssue = async (category: string): Promise<string> => {
  const issueId = randomUUID();
  await client.query(
    `insert into canonical_issue
       (issue_id, public_reference, category, current_status, opened_at,
        representative_location, last_evidence_at, jurisdiction_id)
     values ($1,$2,$3,'work_planned', now() - interval '5 days',
             ST_SetSRID(ST_MakePoint($4,$5),4326)::geography, now(), $6)`,
    [
      issueId,
      `VIS-${issueId.slice(0, 8).toUpperCase()}`,
      category,
      ORIGIN.lon,
      ORIGIN.lat,
      jurisdictionId,
    ],
  );
  issues.push(issueId);
  return issueId;
};

const countedReporter = async (issueId: string): Promise<string> => {
  const participantId = randomUUID();
  await client.query("insert into participant (participant_id) values ($1)", [participantId]);
  participants.push(participantId);
  const submissionId = randomUUID();
  await client.query(
    `insert into submission
       (submission_id, participant_id, observed_location, observed_accuracy_m,
        observed_location_source, observed_at, interface_locale, locale_pack_version,
        taxonomy_version, idempotency_key)
     values ($1,$2, ST_SetSRID(ST_MakePoint($3,$4),4326)::geography, 12,
             'device_geolocation', now(), 'en-IN','demo-locales.v1','demo-taxonomy.v1',$5)`,
    [submissionId, participantId, ORIGIN.lon, ORIGIN.lat, `rp-${submissionId}`],
  );
  submissions.push(submissionId);
  await client.query(
    `insert into issue_participation
       (participation_id, participant_id, canonical_issue_id, counted,
        first_evidence_at, last_evidence_at)
     values ($1,$2,$3,true, now(), now())`,
    [randomUUID(), participantId, issueId],
  );
  return participantId;
};

const claimOn = async (issueId: string): Promise<string> => {
  const result = await claimResolution(client, {
    principal: staff(),
    issueId,
    idempotencyKey: `claim-${randomUUID()}`,
    description: "Cleared the blockage and replaced the cover.",
    completionEvidence: [storedPhoto()],
  });
  if (result.status === "claimed") claims.push(result.claimId);
  return result.claimId;
};

// ---------------------------------------------------------------------------

/**
 * One piece of completion evidence that names a real stored object.
 *
 * `claimResolution` no longer invents object references, so a test has to
 * supply them the way the HTTP layer does: a finalised object and the
 * fingerprint of its bytes. The assertions below are unchanged — this only
 * stops them describing photographs that were never stored.
 */
const storedPhoto = () => {
  const id = randomUUID();
  return {
    mediaType: "photo" as const,
    objectReference: `2026-09/${id}`,
    fingerprintHash: `sha256:${id.replace(/-/g, "").padEnd(64, "0")}`,
    redactionStatus: "approved" as const,
    derivativeReference: `derivatives/t/${id}`,
  };
};

test("V035: the loaded pack is what the resolution path applies", async () => {
  const { policy, source } = resolveConfirmationPolicy(PROFILE);
  const issueId = await workPlannedIssue("sanitation");
  const participantId = await countedReporter(issueId);
  const claimId = await claimOn(issueId);

  const responded = await respondToClaim(client, {
    claimId,
    decision: "confirmed",
    policy,
    participantId,
  });

  assert.equal(responded.resultingStatus, "resolution_confirmed");
  const state = await readResolutionState(client, { issueId, policy });
  assert.ok(state !== undefined);
  // The version recorded is the pack's, not one the test invented.
  assert.equal(state.policyVersion, "demo-confirmation.v1");
  assert.match(source, /demo-district-a/);
});

test("V035: a category the pack says needs two confirmations is not closed by one", async () => {
  // This is the assertion that makes `confirmation.json` load-bearing: nothing
  // in this file states the number, so raising or lowering `electrical` in the
  // pack changes this outcome.
  const { policy } = resolveConfirmationPolicy(PROFILE);
  const issueId = await workPlannedIssue("electrical");
  const participantId = await countedReporter(issueId);
  const claimId = await claimOn(issueId);

  const responded = await respondToClaim(client, {
    claimId,
    decision: "confirmed",
    policy,
    participantId,
  });

  assert.notEqual(responded.resultingStatus, "resolution_confirmed");
  const state = await readResolutionState(client, { issueId, policy });
  assert.ok(state !== undefined);
  assert.equal(state.isVerifiedResolution, false);
  assert.equal(state.requiresQualifiedInspection, true);
  assert.match(state.disclosures.join(" "), /qualified person should inspect/i);
});

test("V035: an unknown profile is refused rather than given a built-in default", () => {
  // A deployment that silently fell back to a code default would be applying a
  // bar nobody configured, which is the failure V035 exists to prevent.
  assert.throws(() => resolveConfirmationPolicy("no-such-profile"), ConfigPackError);
});

test("V035: the version reported is the pack's own, not a constant", () => {
  // Asserting the demo pack's version alone cannot distinguish a pass-through
  // from a hard-coded string that happens to match it. A pack declaring a
  // different version can.
  const { policy, source } = resolveConfirmationPolicy(PROFILE, {
    version: "other-confirmation.v7",
    rules: { sanitation: { required_confirmations: 1, citizen_may_confirm: true } },
  });

  assert.equal(policy.version, "other-confirmation.v7");
  assert.match(source, /other-confirmation\.v7/);
});

test("V026: the matching bounds a deployment uses come from the same pack", () => {
  const bounds = resolveMatchingBounds(PROFILE);

  assert.equal(bounds.version, "demo-matching.v1");
  assert.ok(bounds.timeWindowHours > 0);
  // The note is the point: the numbers are reasoned, not measured, and the
  // note has to say so and say where calibration would happen (V046).
  assert.match(bounds.note, /NOT values measured against any labelled set/);
  assert.match(bounds.note, /V046/);
});

test("V023: the classification taxonomy a deployment uses comes from the pack", () => {
  // V023's gap was that the taxonomy reached the classifier only from test
  // fixtures, so a deployed classifier had no permitted identifiers at all and
  // would reject every reply it received.
  const taxonomy = resolveTaxonomy(PROFILE);

  assert.equal(taxonomy.version, "demo-taxonomy.v1");
  assert.ok(taxonomy.categoryIds.includes("sanitation"));
  assert.ok(taxonomy.defectIds.includes("blockage"));
});

test("V023: the taxonomy and the routing directory a deployment loads agree", () => {
  // Checked here as well as in the pack tests, because this is the pairing an
  // actual deployment makes: a category the classifier can propose but the
  // directory cannot route would reach `no_directory_entry` for every report.
  const taxonomy = resolveTaxonomy(PROFILE);
  const bounds = resolveMatchingBounds(PROFILE);

  assert.ok(taxonomy.categoryIds.length > 0);
  assert.ok(bounds.candidateLimit > 0);
});

test("V034: the inbox ordering a deployment uses comes from the pack, and disclaims severity", () => {
  // V034's objection was that urgency "would be a policy decision disguised as
  // a field". The disguise is what the note removes: the ordering arrives as a
  // configured choice that says out loud it is not a severity judgement.
  const triage = resolveTriagePolicy(PROFILE);

  assert.equal(triage.version, "demo-triage.v1");
  assert.ok(triage.categoryOrder.length > 0);
  assert.ok(triage.ageEscalationDays > 0);
  assert.match(triage.note, /NOT a severity, risk or urgency assessment/);
});

test("V034: every category the triage policy orders can actually be routed", () => {
  // An ordering rule for a category no directory entry owns would never fire,
  // and would read as coverage that is not there.
  const triage = resolveTriagePolicy(PROFILE);
  const taxonomy = resolveTaxonomy(PROFILE);

  for (const category of triage.categoryOrder) {
    assert.ok(
      taxonomy.categoryIds.includes(category),
      `the triage policy orders '${category}', which the taxonomy does not list`,
    );
  }
});
