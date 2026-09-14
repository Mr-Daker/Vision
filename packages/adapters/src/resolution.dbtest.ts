/**
 * Resolution claims, confirmation, dispute and reopening (roadmap V035).
 *
 * Run with: npm run db:up && npm run db:migrate && npm run test:db
 *
 * The one thing this must never do is let a repair *claim* count as a verified
 * resolution. Staff saying they fixed something is a claim; the issue becomes
 * resolved only when the category's confirmation policy is satisfied by people
 * who are entitled to speak for it.
 *
 * And reopening has to actually reverse the closure: a metric that counts an
 * issue as closed after it was reopened is worse than having no metric.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

import type { ConfirmationPolicyPack, Principal } from "@vision/domain";

import {
  claimResolution,
  readCitizenResolutionView,
  respondToClaim,
  resolveDispute,
  reopenIssue,
  readResolutionState,
  ResolutionError,
} from "./resolution.ts";

const DATABASE_URL =
  process.env["DATABASE_URL"] ??
  "postgresql://vision:vision_local_dev_only@127.0.0.1:5432/vision_dev";

let client: pg.Client;
let jurisdictionId: string;
const issues: string[] = [];
const participants: string[] = [];
const submissions: string[] = [];
const claims: string[] = [];

const ORIGIN = { lon: 75.51, lat: 17.71 };
const ROUTINE = "routine-cat";
const SAFETY = "safety-cat";

const POLICY: ConfirmationPolicyPack = {
  version: "demo-confirmation.v1",
  rules: {
    [ROUTINE]: { requiredConfirmations: 1, citizenMayConfirm: true, reviewerMayOverride: true },
    [SAFETY]: {
      requiredConfirmations: 2,
      citizenMayConfirm: true,
      reviewerMayOverride: false,
      requiresQualifiedInspection: true,
    },
  },
};

const staff = (): Principal => ({
  role: "department_staff",
  staffId: randomUUID() as never,
  jurisdictionScope: [jurisdictionId],
  sessionId: randomUUID() as never,
});

const reviewer = (): Principal => ({
  role: "reviewer",
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
     values ($1,'test-profile',$2,'demo-routing.v1','test-scheme','district',
             now() - interval '1 year', true)`,
    [jurisdictionId, `code-${jurisdictionId.slice(0, 8)}`],
  );
});

after(async () => {
  await client.end().catch(() => undefined);
  const cleaner = new pg.Client({ connectionString: DATABASE_URL, statement_timeout: 10_000 });
  await cleaner.connect();
  try {
    if (issues.length > 0) {
      await cleaner.query("delete from reopening where issue_id = any($1::uuid[])", [issues]);
    }
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
    if (submissions.length > 0) {
      await cleaner.query(
        "delete from issue_evidence_link where evidence_id in (select evidence_id from evidence_item where submission_id = any($1::uuid[]))",
        [submissions],
      );
      await cleaner.query("delete from evidence_item where submission_id = any($1::uuid[])", [
        submissions,
      ]);
      await cleaner.query("delete from submission where submission_id = any($1::uuid[])", [
        submissions,
      ]);
    }
    if (issues.length > 0) {
      await cleaner.query(
        "delete from issue_participation where canonical_issue_id = any($1::uuid[])",
        [issues],
      );
      // Review decisions reference the event they were recorded against, so
      // they go before the events (a returned dispute now writes one).
      await cleaner.query(
        "delete from review_decision where canonical_issue_id = any($1::uuid[])",
        [issues],
      );
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

const newParticipant = async (): Promise<string> => {
  const id = randomUUID();
  await client.query("insert into participant (participant_id) values ($1)", [id]);
  participants.push(id);
  return id;
};

/** An issue with work planned, which is where a claim becomes possible. */
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

/** A participant whose participation counts on the issue. */
const countedReporter = async (issueId: string): Promise<string> => {
  const participantId = await newParticipant();
  const submissionId = randomUUID();
  await client.query(
    `insert into submission
       (submission_id, participant_id, observed_location, observed_accuracy_m,
        observed_location_source, observed_at, interface_locale, locale_pack_version,
        taxonomy_version, idempotency_key)
     values ($1,$2, ST_SetSRID(ST_MakePoint($3,$4),4326)::geography, 12,
             'device_geolocation', now(), 'en-IN','demo-locales.v1','demo-taxonomy.v1',$5)`,
    [submissionId, participantId, ORIGIN.lon, ORIGIN.lat, `v35-${submissionId}`],
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

const claimWithEvidence = async (issueId: string, principal = staff()) => {
  const result = await claimResolution(client, {
    principal,
    issueId,
    idempotencyKey: `claim-${randomUUID()}`,
    description: "Replaced the broken section and cleared the blockage.",
    completionEvidence: [storedPhoto()],
  });
  if (result.status === "claimed") claims.push(result.claimId);
  return result;
};

// ---------------------------------------------------------------------------
// A claim is a claim
// ---------------------------------------------------------------------------

test("V035: a claim does not resolve the issue", async () => {
  const issueId = await workPlannedIssue(ROUTINE);

  const result = await claimWithEvidence(issueId);

  assert.equal(result.status, "claimed");
  const { rows } = await client.query(
    "select current_status from canonical_issue where issue_id = $1",
    [issueId],
  );
  // The whole point: claimed, not confirmed.
  assert.equal(rows[0]?.["current_status"], "resolution_claimed");

  const state = await readResolutionState(client, { issueId, policy: POLICY });
  assert.equal(state?.isVerifiedResolution, false);
  assert.match(state?.reason ?? "", /claim|awaiting/i);
});

test("V035: a claim with no completion evidence is refused", async () => {
  const issueId = await workPlannedIssue(ROUTINE);

  await assert.rejects(
    () =>
      claimResolution(client, {
        principal: staff(),
        issueId,
        idempotencyKey: `claim-${randomUUID()}`,
        description: "Fixed it.",
        completionEvidence: [],
      }),
    /evidence/i,
  );

  const { rows } = await client.query(
    "select current_status from canonical_issue where issue_id = $1",
    [issueId],
  );
  assert.equal(rows[0]?.["current_status"], "work_planned", "nothing may have changed");
});

test("V035: the same claim key from the same staff member is idempotent", async () => {
  const issueId = await workPlannedIssue(ROUTINE);
  const principal = staff();
  const key = `claim-${randomUUID()}`;
  const body = {
    principal,
    issueId,
    idempotencyKey: key,
    description: "Replaced the broken section.",
    completionEvidence: [storedPhoto()],
  };

  const first = await claimResolution(client, body);
  const second = await claimResolution(client, body);
  if (first.status === "claimed") claims.push(first.claimId);

  assert.equal(first.status, "claimed");
  assert.equal(second.status, "already_claimed");
  const { rows } = await client.query(
    "select count(*)::int as n from resolution_claim where issue_id = $1",
    [issueId],
  );
  assert.equal(rows[0]?.["n"], 1);
});

test("V035: a claim idempotency key cannot be rebound to another issue", async () => {
  const firstIssueId = await workPlannedIssue(ROUTINE);
  const secondIssueId = await workPlannedIssue(ROUTINE);
  const principal = staff();
  const idempotencyKey = `claim-${randomUUID()}`;
  const completionEvidence = [storedPhoto()];
  const first = await claimResolution(client, {
    principal,
    issueId: firstIssueId,
    idempotencyKey,
    description: "Replaced the broken section and cleared the blockage.",
    completionEvidence,
  });
  if (first.status === "claimed") claims.push(first.claimId);

  await assert.rejects(
    () =>
      claimResolution(client, {
        principal,
        issueId: secondIssueId,
        idempotencyKey,
        description: "Replaced the broken section and cleared the blockage.",
        completionEvidence,
      }),
    (error: Error) =>
      error instanceof ResolutionError && /different resolution claim request/.test(error.message),
  );

  const { rows } = await client.query(
    "select current_status from canonical_issue where issue_id = $1",
    [secondIssueId],
  );
  assert.equal(rows[0]?.["current_status"], "work_planned");
});

test("V035: a citizen cannot claim a resolution", async () => {
  const issueId = await workPlannedIssue(ROUTINE);
  const participantId = await newParticipant();

  await assert.rejects(
    () =>
      claimResolution(client, {
        principal: {
          role: "citizen",
          participantId: participantId as never,
          jurisdictionScope: [],
          sessionId: randomUUID() as never,
        },
        issueId,
        idempotencyKey: `claim-${randomUUID()}`,
        description: "I fixed it myself.",
        completionEvidence: [storedPhoto()],
      }),
    ResolutionError,
  );
});

// ---------------------------------------------------------------------------
// Confirmation and dispute
// ---------------------------------------------------------------------------

test("V035: a counted reporter's confirmation resolves a routine issue", async () => {
  const issueId = await workPlannedIssue(ROUTINE);
  const reporter = await countedReporter(issueId);
  const claim = await claimWithEvidence(issueId);
  if (claim.status !== "claimed") return;

  await respondToClaim(client, {
    claimId: claim.claimId,
    participantId: reporter,
    decision: "confirmed",
    policy: POLICY,
    comment: "The tap is working again.",
  });

  const { rows } = await client.query(
    "select current_status from canonical_issue where issue_id = $1",
    [issueId],
  );
  assert.equal(rows[0]?.["current_status"], "resolution_confirmed");
  const state = await readResolutionState(client, { issueId, policy: POLICY });
  assert.equal(state?.isVerifiedResolution, true);

  const persisted = await client.query(
    `select c.confirmation_id, e.payload->>'confirmation_id' as event_confirmation_id
       from resolution_confirmation c
       join status_event e on e.aggregate_id = $2 and e.event_type = 'resolution_confirmed'
      where c.claim_id = $1
      order by e.aggregate_version desc limit 1`,
    [claim.claimId, issueId],
  );
  assert.equal(
    String(persisted.rows[0]?.["event_confirmation_id"]),
    String(persisted.rows[0]?.["confirmation_id"]),
    "the lifecycle event must name the persisted confirmation, not its parent claim",
  );
});

test("V035: a dispute leaves the issue disputed, not resolved", async () => {
  const issueId = await workPlannedIssue(ROUTINE);
  const reporter = await countedReporter(issueId);
  const claim = await claimWithEvidence(issueId);
  if (claim.status !== "claimed") return;

  await respondToClaim(client, {
    claimId: claim.claimId,
    participantId: reporter,
    decision: "disputed",
    policy: POLICY,
    comment: "Still dry.",
  });

  const { rows } = await client.query(
    "select current_status from canonical_issue where issue_id = $1",
    [issueId],
  );
  assert.equal(rows[0]?.["current_status"], "resolution_disputed");
  const state = await readResolutionState(client, { issueId, policy: POLICY });
  assert.equal(state?.isVerifiedResolution, false);
});

test("V035: someone with no counted participation cannot confirm", async () => {
  const issueId = await workPlannedIssue(ROUTINE);
  const stranger = await newParticipant();
  const claim = await claimWithEvidence(issueId);
  if (claim.status !== "claimed") return;

  await assert.rejects(
    () =>
      respondToClaim(client, {
        claimId: claim.claimId,
        participantId: stranger,
        decision: "confirmed",
        policy: POLICY,
      }),
    /counted|participation/i,
  );
});

test("V035: one claim takes one response", async () => {
  const issueId = await workPlannedIssue(ROUTINE);
  const reporter = await countedReporter(issueId);
  const claim = await claimWithEvidence(issueId);
  if (claim.status !== "claimed") return;

  await respondToClaim(client, {
    claimId: claim.claimId,
    participantId: reporter,
    decision: "confirmed",
    policy: POLICY,
  });

  await assert.rejects(
    () =>
      respondToClaim(client, {
        claimId: claim.claimId,
        participantId: reporter,
        decision: "disputed",
        policy: POLICY,
      }),
    /already|one confirmation/i,
  );
});

test("V035: a safety category cannot be closed by one confirmation, and has no other route", async () => {
  const issueId = await workPlannedIssue(SAFETY);
  const reporter = await countedReporter(issueId);
  const claim = await claimWithEvidence(issueId);
  if (claim.status !== "claimed") return;

  await respondToClaim(client, {
    claimId: claim.claimId,
    participantId: reporter,
    decision: "confirmed",
    policy: POLICY,
  });

  const { rows } = await client.query(
    "select current_status from canonical_issue where issue_id = $1",
    [issueId],
  );
  // One confirmation is not enough for this category, so the issue stays a
  // claim. And because resolution_confirmation allows exactly one row per
  // claim, there is no way to gather a second — so a safety-category issue
  // cannot currently reach a confirmed resolution at all. That is an honest
  // dead end rather than a lowered bar, and it is recorded as an owner
  // decision in the V035 task record.
  assert.equal(rows[0]?.["current_status"], "resolution_claimed");
  const state = await readResolutionState(client, { issueId, policy: POLICY });
  assert.equal(state?.isVerifiedResolution, false);
  assert.equal(state?.requiresQualifiedInspection, true);
});

test("V035: a reviewer resolves a dispute by returning the work, not by overruling", async () => {
  // The V003 lifecycle has no edge from resolution_disputed to
  // resolution_confirmed: a reviewer cannot convert a citizen's dispute into a
  // confirmation. What they can do is send the work back. That is a stronger
  // guarantee than any policy flag, and it is the contract, not a choice made
  // here.
  const issueId = await workPlannedIssue(ROUTINE);
  const reporter = await countedReporter(issueId);
  const claim = await claimWithEvidence(issueId);
  if (claim.status !== "claimed") return;
  await respondToClaim(client, {
    claimId: claim.claimId,
    participantId: reporter,
    decision: "disputed",
    policy: POLICY,
  });

  const result = await resolveDispute(client, {
    principal: reviewer(),
    issueId,
    reason:
      "Visited the site; the reported fault is still present, so the work returns to the crew.",
  });

  assert.equal(result.returnedToWork, true);
  const { rows } = await client.query(
    "select current_status from canonical_issue where issue_id = $1",
    [issueId],
  );
  assert.equal(rows[0]?.["current_status"], "work_planned");

  // And the citizen's dispute is still on the record.
  const confirmation = await client.query(
    "select decision from resolution_confirmation where claim_id = $1",
    [claim.claimId],
  );
  assert.equal(confirmation.rows[0]?.["decision"], "disputed");
});

test("V035: a reviewer resolves a dispute where the policy permits it", async () => {
  // An earlier version of this test asserted that a reviewer *cannot* do this,
  // on the grounds that "the one confirmation per claim is already spent on the
  // dispute". That was not the design — it was the defect, written down as
  // though it were intended. `reviewerMayOverride` has always existed in the
  // policy and is true for a routine category; the lifecycle simply had no
  // edge, so a dispute was terminal whatever the pack said.
  const issueId = await workPlannedIssue(ROUTINE);
  const reporter = await countedReporter(issueId);
  const claim = await claimWithEvidence(issueId);
  assert.equal(claim.status, "claimed");
  const disputed = await respondToClaim(client, {
    claimId: claim.claimId,
    participantId: reporter,
    decision: "disputed",
    policy: POLICY,
  });
  assert.equal(disputed.resultingStatus, "resolution_disputed");

  const overridden = await respondToClaim(client, {
    claimId: claim.claimId,
    reviewerPrincipal: reviewer(),
    decision: "confirmed",
    policy: POLICY,
  });

  assert.equal(overridden.resultingStatus, "resolution_confirmed");
  const state = await readResolutionState(client, { issueId, policy: POLICY });
  assert.equal(state?.resolvedByReviewer, true);
});

test("V035: a reviewer may not resolve a dispute on a safety category", async () => {
  // The pack withholds the override exactly where overruling the people who
  // live there would be least defensible. The dispute stands, and the issue
  // does not become a verified resolution.
  const issueId = await workPlannedIssue(SAFETY);
  const reporter = await countedReporter(issueId);
  const claim = await claimWithEvidence(issueId);
  assert.equal(claim.status, "claimed");
  await respondToClaim(client, {
    claimId: claim.claimId,
    participantId: reporter,
    decision: "disputed",
    policy: POLICY,
  });

  await assert.rejects(
    () =>
      respondToClaim(client, {
        claimId: claim.claimId,
        reviewerPrincipal: reviewer(),
        decision: "confirmed",
        policy: POLICY,
      }),
    /does not let a reviewer override|may not override/i,
  );

  const { rows } = await client.query(
    "select current_status from canonical_issue where issue_id = $1",
    [issueId],
  );
  assert.equal(rows[0]?.["current_status"], "resolution_disputed");
  const state = await readResolutionState(client, { issueId, policy: POLICY });
  assert.equal(state?.isVerifiedResolution, false);
});

test("V035: a reviewer with no reason cannot return the work", async () => {
  const issueId = await workPlannedIssue(ROUTINE);
  const reporter = await countedReporter(issueId);
  const claim = await claimWithEvidence(issueId);
  if (claim.status !== "claimed") return;
  await respondToClaim(client, {
    claimId: claim.claimId,
    participantId: reporter,
    decision: "disputed",
    policy: POLICY,
  });

  await assert.rejects(
    () => resolveDispute(client, { principal: reviewer(), issueId, reason: "  " }),
    /reason/i,
  );
});

// ---------------------------------------------------------------------------
// Reopening
// ---------------------------------------------------------------------------

test("V035: reopening reverses the closure and says why", async () => {
  const issueId = await workPlannedIssue(ROUTINE);
  const reporter = await countedReporter(issueId);
  const claim = await claimWithEvidence(issueId);
  if (claim.status !== "claimed") return;
  await respondToClaim(client, {
    claimId: claim.claimId,
    participantId: reporter,
    decision: "confirmed",
    policy: POLICY,
  });

  const result = await reopenIssue(client, {
    issueId,
    actorType: "citizen",
    actorId: reporter,
    reason: "The tap failed again two days later.",
  });

  assert.equal(result.reopened, true);
  const { rows } = await client.query(
    "select current_status from canonical_issue where issue_id = $1",
    [issueId],
  );
  assert.equal(rows[0]?.["current_status"], "reopened");

  const state = await readResolutionState(client, { issueId, policy: POLICY });
  // The metric consequence: this issue is no longer closed.
  assert.equal(state?.isVerifiedResolution, false);
  assert.equal(state?.countsAsClosed, false);
  assert.match(state?.reason ?? "", /reopened/i);
});

test("V035: an issue that was never confirmed cannot be reopened", async () => {
  const issueId = await workPlannedIssue(ROUTINE);
  const claim = await claimWithEvidence(issueId);
  if (claim.status !== "claimed") return;
  const actorId = await newParticipant();

  await assert.rejects(
    () =>
      reopenIssue(client, {
        issueId,
        actorType: "citizen",
        actorId,
        reason: "It is still broken.",
      }),
    /confirmed|not closed/i,
  );
});

test("V035: reopening requires a reason", async () => {
  const issueId = await workPlannedIssue(ROUTINE);
  const reporter = await countedReporter(issueId);
  const claim = await claimWithEvidence(issueId);
  if (claim.status !== "claimed") return;
  await respondToClaim(client, {
    claimId: claim.claimId,
    participantId: reporter,
    decision: "confirmed",
    policy: POLICY,
  });

  await assert.rejects(
    () => reopenIssue(client, { issueId, actorType: "citizen", actorId: reporter, reason: " " }),
    /reason/i,
  );
});

// ---------------------------------------------------------------------------
// History and honesty
// ---------------------------------------------------------------------------

test("V035: the whole transition history is retained", async () => {
  const issueId = await workPlannedIssue(ROUTINE);
  const reporter = await countedReporter(issueId);
  const claim = await claimWithEvidence(issueId);
  if (claim.status !== "claimed") return;
  await respondToClaim(client, {
    claimId: claim.claimId,
    participantId: reporter,
    decision: "confirmed",
    policy: POLICY,
  });
  await reopenIssue(client, {
    issueId,
    actorType: "citizen",
    actorId: reporter,
    reason: "Failed again.",
  });

  const { rows } = await client.query(
    "select event_type, aggregate_version from status_event where aggregate_id = $1 order by aggregate_version",
    [issueId],
  );
  const types = rows.map((row) => String(row["event_type"]));
  assert.ok(types.includes("resolution_claimed"));
  assert.ok(types.includes("resolution_confirmed"));
  assert.ok(types.includes("issue_reopened"));
  // Versions are contiguous, so nothing was quietly dropped.
  assert.deepEqual(
    rows.map((row) => Number(row["aggregate_version"])),
    rows.map((_row, index) => index + 1),
  );
});

test("V035: a resolution state always carries what it does not establish", async () => {
  const issueId = await workPlannedIssue(SAFETY);
  const reporter = await countedReporter(issueId);
  const claim = await claimWithEvidence(issueId);
  if (claim.status !== "claimed") return;
  await respondToClaim(client, {
    claimId: claim.claimId,
    participantId: reporter,
    decision: "confirmed",
    policy: POLICY,
  });

  const state = await readResolutionState(client, { issueId, policy: POLICY });

  assert.match(state?.disclosures.join(" ") ?? "", /not an engineer's certification/i);
  assert.match(state?.disclosures.join(" ") ?? "", /qualified person should inspect/i);
});

test("V035: completion photographs are recorded as evidence, never as certification", async () => {
  const issueId = await workPlannedIssue(SAFETY);
  const claim = await claimWithEvidence(issueId);
  if (claim.status !== "claimed") return;

  const state = await readResolutionState(client, { issueId, policy: POLICY });

  assert.equal(state?.claimEvidenceCount, 1);
  assert.doesNotMatch(JSON.stringify(state), /certified|certification of|inspected by/i);
});

// ---------------------------------------------------------------------------
// The lifecycle is the authority
// ---------------------------------------------------------------------------

test("V035: a claim on an issue that has no work planned is refused", async () => {
  // The V003 edge list allows work_planned -> resolution_claimed and nothing
  // else into a claim. Skipping that check would let staff close an issue
  // nobody had been assigned to do anything about.
  const issueId = randomUUID();
  await client.query(
    `insert into canonical_issue
       (issue_id, public_reference, category, current_status, opened_at,
        representative_location, last_evidence_at, jurisdiction_id)
     values ($1,$2,$3,'created', now(),
             ST_SetSRID(ST_MakePoint($4,$5),4326)::geography, now(), $6)`,
    [
      issueId,
      `VIS-${issueId.slice(0, 8).toUpperCase()}`,
      ROUTINE,
      ORIGIN.lon,
      ORIGIN.lat,
      jurisdictionId,
    ],
  );
  issues.push(issueId);

  await assert.rejects(
    () =>
      claimResolution(client, {
        principal: staff(),
        issueId,
        idempotencyKey: `claim-${randomUUID()}`,
        description: "Replaced the section.",
        completionEvidence: [storedPhoto()],
      }),
    /cannot move created -> resolution_claimed/,
  );

  const { rows } = await client.query(
    "select current_status from canonical_issue where issue_id = $1",
    [issueId],
  );
  assert.equal(rows[0]?.["current_status"], "created");
});

test("V035: a citizen cannot return disputed work to the crew", async () => {
  const issueId = await workPlannedIssue(ROUTINE);
  const reporter = await countedReporter(issueId);
  const claim = await claimWithEvidence(issueId);
  if (claim.status !== "claimed") return;
  await respondToClaim(client, {
    claimId: claim.claimId,
    participantId: reporter,
    decision: "disputed",
    policy: POLICY,
  });

  await assert.rejects(
    () =>
      resolveDispute(client, {
        principal: {
          role: "citizen",
          participantId: reporter as never,
          jurisdictionScope: [],
          sessionId: randomUUID() as never,
        },
        issueId,
        reason: "I want this looked at again.",
      }),
    /may not transition/,
  );

  const { rows } = await client.query(
    "select current_status from canonical_issue where issue_id = $1",
    [issueId],
  );
  assert.equal(rows[0]?.["current_status"], "resolution_disputed");
});

test("V035: staff outside the jurisdiction cannot claim a resolution", async () => {
  const issueId = await workPlannedIssue(ROUTINE);

  await assert.rejects(
    () =>
      claimResolution(client, {
        principal: {
          role: "department_staff",
          staffId: randomUUID() as never,
          jurisdictionScope: [randomUUID()],
          sessionId: randomUUID() as never,
        },
        issueId,
        idempotencyKey: `claim-${randomUUID()}`,
        description: "Replaced the section.",
        completionEvidence: [storedPhoto()],
      }),
    /may not claim a resolution/,
  );
});

test("V035: returning disputed work is recorded in the reviewer audit table", async () => {
  // V032's `review_decision` is the one place built for "which reviewer
  // decided what, and why". A returned dispute used to write only an event,
  // so it was invisible to anyone reviewing reviewer decisions.
  const issueId = await workPlannedIssue(ROUTINE);
  const reporter = await countedReporter(issueId);
  const claim = await claimWithEvidence(issueId);
  if (claim.status !== "claimed") return;
  await respondToClaim(client, {
    claimId: claim.claimId,
    participantId: reporter,
    decision: "disputed",
    policy: POLICY,
  });
  const principal = reviewer();

  await resolveDispute(client, {
    principal,
    issueId,
    reason: "Visited the site; the reported fault is still present.",
  });

  const { rows } = await client.query(
    `select action, reason, reviewer_id, prior_state, resulting_state, decision_event_id
       from review_decision where canonical_issue_id = $1`,
    [issueId],
  );
  assert.equal(rows[0]?.["action"], "return_disputed_work");
  assert.match(String(rows[0]?.["reason"]), /still present/);
  assert.equal(rows[0]?.["reviewer_id"], principal.staffId);
  assert.equal(
    (rows[0]?.["prior_state"] as Record<string, unknown>)["issue_status"],
    "resolution_disputed",
  );
  assert.equal(
    (rows[0]?.["resulting_state"] as Record<string, unknown>)["issue_status"],
    "work_planned",
  );
  // Linked to the event, so the audit row and the timeline agree.
  assert.notEqual(rows[0]?.["decision_event_id"], null);
});

// ---------------------------------------------------------------------------
// A category needing two confirmations must be closable (V035)
// ---------------------------------------------------------------------------

test("V035: a two-confirmation category can actually be closed by two people", async () => {
  // The defect this exercises: `resolution_confirmation.claim_id` was UNIQUE,
  // so a claim could take exactly one confirmation — while the policy pack
  // requires two for a safety category. Those issues could never be closed at
  // all, which is not a stricter bar but a broken one: the second confirmation
  // was refused by the database, so the people who did confirm were told
  // nothing had happened.
  const issueId = await workPlannedIssue(SAFETY);
  const first = await countedReporter(issueId);
  const second = await countedReporter(issueId);
  const claim = await claimWithEvidence(issueId);
  assert.equal(claim.status, "claimed");

  const one = await respondToClaim(client, {
    claimId: claim.claimId,
    decision: "confirmed",
    policy: POLICY,
    participantId: first,
  });
  assert.notEqual(one.resultingStatus, "resolution_confirmed");

  const two = await respondToClaim(client, {
    claimId: claim.claimId,
    decision: "confirmed",
    policy: POLICY,
    participantId: second,
  });

  assert.equal(two.resultingStatus, "resolution_confirmed");
});

test("V035: the same person cannot confirm twice to reach the bar alone", async () => {
  // Otherwise "two confirmations" means "one person tapping twice", and the
  // whole point of a higher bar for a safety category disappears.
  const issueId = await workPlannedIssue(SAFETY);
  const reporter = await countedReporter(issueId);
  const claim = await claimWithEvidence(issueId);
  assert.equal(claim.status, "claimed");

  await respondToClaim(client, {
    claimId: claim.claimId,
    decision: "confirmed",
    policy: POLICY,
    participantId: reporter,
  });

  await assert.rejects(
    () =>
      respondToClaim(client, {
        claimId: claim.claimId,
        decision: "confirmed",
        policy: POLICY,
        participantId: reporter,
      }),
    /already|once/i,
  );

  const { rows } = await client.query(
    "select current_status from canonical_issue where issue_id = $1",
    [issueId],
  );
  assert.notEqual(rows[0]?.["current_status"], "resolution_confirmed");
});

test("V035: one reviewer decision per claim, not several", async () => {
  // A reviewer changing their mind by adding a second row would leave two
  // reviewer decisions on one claim with nothing saying which stands.
  const issueId = await workPlannedIssue(ROUTINE);
  const reporter = await countedReporter(issueId);
  const claim = await claimWithEvidence(issueId);
  assert.equal(claim.status, "claimed");
  await respondToClaim(client, {
    claimId: claim.claimId,
    decision: "disputed",
    policy: POLICY,
    participantId: reporter,
  });

  await respondToClaim(client, {
    claimId: claim.claimId,
    decision: "confirmed",
    policy: POLICY,
    reviewerPrincipal: reviewer(),
  });

  await assert.rejects(
    () =>
      respondToClaim(client, {
        claimId: claim.claimId,
        decision: "disputed",
        policy: POLICY,
        reviewerPrincipal: reviewer(),
      }),
    /already|once/i,
  );
});

test("V035: a confirmation stops counting if the participation behind it stops counting", async () => {
  // Reachable without anyone acting in bad faith: a merge moves participation,
  // or a participant is tombstoned, after they confirmed. The read model
  // recomputes from participation as it stands rather than trusting that the
  // answer counted when it was given — it previously hard-coded that it did.
  const issueId = await workPlannedIssue(ROUTINE);
  const reporter = await countedReporter(issueId);
  const claim = await claimWithEvidence(issueId);
  assert.equal(claim.status, "claimed");
  const responded = await respondToClaim(client, {
    claimId: claim.claimId,
    decision: "confirmed",
    policy: POLICY,
    participantId: reporter,
  });
  assert.equal(responded.resultingStatus, "resolution_confirmed");

  const before = await readResolutionState(client, { issueId, policy: POLICY });
  assert.equal(before?.isVerifiedResolution, true);

  // The schema requires a reason whenever participation stops counting
  // (`issue_participation_reason_required_ck`), so uncounting is never silent.
  await client.query(
    `update issue_participation
        set counted = false, non_counted_reason = 'participation moved by a merge'
      where canonical_issue_id = $1 and participant_id = $2`,
    [issueId, reporter],
  );

  const after = await readResolutionState(client, { issueId, policy: POLICY });
  assert.equal(after?.isVerifiedResolution, false);
  assert.match(after?.reason ?? "", /counted|eligible/i);
});

// ---------------------------------------------------------------------------
// Completion evidence names real objects (V035 §A)
// ---------------------------------------------------------------------------

test("V035: a claim cannot name completion evidence with no stored object", async () => {
  const issueId = await workPlannedIssue(ROUTINE);
  await assert.rejects(
    claimResolution(client, {
      principal: staff(),
      issueId,
      idempotencyKey: `claim-${randomUUID()}`,
      description: "Replaced the broken section and cleared the blockage.",
      completionEvidence: [storedPhoto()],
      // The store says it has never seen these bytes.
      hasStoredObject: async () => false,
    }),
    (error: Error) => error instanceof ResolutionError && /not in the store/.test(error.message),
  );
  const { rows } = await client.query(
    "select count(*)::int as n from resolution_claim where issue_id = $1",
    [issueId],
  );
  assert.equal(Number(rows[0]?.["n"]), 0, "nothing is written for a claim that was refused");
});

test("V035: completion evidence must carry an object reference and a fingerprint", async () => {
  const issueId = await workPlannedIssue(ROUTINE);
  await assert.rejects(
    claimResolution(client, {
      principal: staff(),
      issueId,
      idempotencyKey: `claim-${randomUUID()}`,
      description: "Replaced the broken section and cleared the blockage.",
      completionEvidence: [{ ...storedPhoto(), objectReference: "", fingerprintHash: "" }],
    }),
    (error: Error) =>
      error instanceof ResolutionError && /stored object and the fingerprint/.test(error.message),
  );
});

test("V035: the stored row names the object the caller supplied, not an invented one", async () => {
  const issueId = await workPlannedIssue(ROUTINE);
  const photo = storedPhoto();
  const result = await claimResolution(client, {
    principal: staff(),
    issueId,
    idempotencyKey: `claim-${randomUUID()}`,
    description: "Replaced the broken section and cleared the blockage.",
    completionEvidence: [photo],
    hasStoredObject: async (reference) => reference === photo.objectReference,
  });
  if (result.status === "claimed") claims.push(result.claimId);

  const { rows } = await client.query(
    "select object_reference, fingerprint_hash from resolution_evidence_item where claim_id = $1",
    [result.claimId],
  );
  // An earlier version generated `originals/resolution/<uuid>` here, so the
  // table recorded photographs nobody had uploaded.
  assert.equal(String(rows[0]?.["object_reference"]), photo.objectReference);
  assert.equal(String(rows[0]?.["fingerprint_hash"]), photo.fingerprintHash);
  assert.doesNotMatch(String(rows[0]?.["object_reference"]), /^originals\/resolution\//);
});

test("V035: a claim needs a description a citizen can check against", async () => {
  const issueId = await workPlannedIssue(ROUTINE);
  await assert.rejects(
    claimResolution(client, {
      principal: staff(),
      issueId,
      idempotencyKey: `claim-${randomUUID()}`,
      description: "Fixed.",
      completionEvidence: [storedPhoto()],
    }),
    (error: Error) =>
      error instanceof ResolutionError && /specific description/.test(error.message),
  );
});

// ---------------------------------------------------------------------------
// The citizen-facing view (V035 §B)
// ---------------------------------------------------------------------------

test("V035: the citizen view never carries a private original", async () => {
  const issueId = await workPlannedIssue(ROUTINE);
  const participantId = await countedReporter(issueId);
  const photo = storedPhoto();
  const result = await claimResolution(client, {
    principal: staff(),
    issueId,
    idempotencyKey: `claim-${randomUUID()}`,
    description: "Replaced the broken section and cleared the blockage.",
    completionEvidence: [photo],
  });
  if (result.status === "claimed") claims.push(result.claimId);

  const view = await readCitizenResolutionView(client, {
    issueId,
    policy: POLICY,
    participantId,
  });
  const serialised = JSON.stringify(view);
  assert.ok(
    !serialised.includes(photo.objectReference),
    "the object reference of a private original reached the citizen view",
  );
  assert.equal(view?.claim?.evidence[0]?.derivativeReference, photo.derivativeReference);
});

test("V035: the citizen view names why a person may not answer", async () => {
  const issueId = await workPlannedIssue(ROUTINE);
  const counted = await countedReporter(issueId);
  const stranger = await newParticipant();
  const result = await claimResolution(client, {
    principal: staff(),
    issueId,
    idempotencyKey: `claim-${randomUUID()}`,
    description: "Replaced the broken section and cleared the blockage.",
    completionEvidence: [storedPhoto()],
  });
  if (result.status === "claimed") claims.push(result.claimId);

  const outsider = await readCitizenResolutionView(client, {
    issueId,
    policy: POLICY,
    participantId: stranger,
  });
  assert.equal(outsider?.mayRespond, false);
  assert.equal(outsider?.mayRespondBlockedBy, "not_a_counted_participant");

  const reporter = await readCitizenResolutionView(client, {
    issueId,
    policy: POLICY,
    participantId: counted,
  });
  assert.equal(reporter?.mayRespond, true);

  await respondToClaim(client, {
    claimId: result.claimId,
    decision: "confirmed",
    policy: POLICY,
    participantId: counted,
  });
  const afterwards = await readCitizenResolutionView(client, {
    issueId,
    policy: POLICY,
    participantId: counted,
  });
  // Now confirmed, so there is no claim awaiting an answer — a different
  // refusal from "you are not allowed", and the view says which.
  assert.equal(afterwards?.mayRespond, false);
  assert.equal(afterwards?.mayRespondBlockedBy, "no_claim_awaiting_an_answer");
  assert.equal(afterwards?.mayReopen, true);
});

test("V035: every citizen view carries the non-certification sentence", async () => {
  const issueId = await workPlannedIssue(SAFETY);
  const participantId = await countedReporter(issueId);
  const result = await claimResolution(client, {
    principal: staff(),
    issueId,
    idempotencyKey: `claim-${randomUUID()}`,
    description: "Isolated the feed and replaced the perished gland.",
    completionEvidence: [storedPhoto()],
  });
  if (result.status === "claimed") claims.push(result.claimId);

  const view = await readCitizenResolutionView(client, {
    issueId,
    policy: POLICY,
    participantId,
  });
  assert.ok(
    view?.disclosures.some((line) => /not an inspection/i.test(line)),
    "the disclosure that agreement is not an inspection is always present",
  );
  // A safety category carries the second one as well.
  assert.equal(view?.requiresQualifiedInspection, true);
  assert.ok(view?.disclosures.some((line) => /qualified person should inspect/i.test(line)));
  assert.equal(view?.requiredConfirmations, 2);
});

// ---------------------------------------------------------------------------
// Reopening is for the people who reported it (V035 §D)
// ---------------------------------------------------------------------------

test("V035: a citizen with no counted participation cannot reopen", async () => {
  const issueId = await workPlannedIssue(ROUTINE);
  const counted = await countedReporter(issueId);
  const stranger = await newParticipant();
  const result = await claimResolution(client, {
    principal: staff(),
    issueId,
    idempotencyKey: `claim-${randomUUID()}`,
    description: "Replaced the broken section and cleared the blockage.",
    completionEvidence: [storedPhoto()],
  });
  if (result.status === "claimed") claims.push(result.claimId);
  await respondToClaim(client, {
    claimId: result.claimId,
    decision: "confirmed",
    policy: POLICY,
    participantId: counted,
  });

  await assert.rejects(
    reopenIssue(client, {
      issueId,
      actorType: "citizen",
      actorId: stranger,
      reason: "I would like this reopened although I never reported it.",
    }),
    (error: Error) =>
      error instanceof ResolutionError && /counted on this issue/.test(error.message),
  );
  // Unchanged: a refused reopening leaves the closure exactly as it was.
  const state = await readResolutionState(client, { issueId, policy: POLICY });
  assert.equal(state?.issueStatus, "resolution_confirmed");
  assert.equal(state?.countsAsClosed, true);
});
