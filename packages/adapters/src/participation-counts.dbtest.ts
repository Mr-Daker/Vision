/**
 * Unique contribution counts across merges (roadmap V029).
 *
 * Run with: npm run db:up && npm run db:migrate && npm run test:db
 *
 * "Fourteen people reported this" is the single most quotable number this
 * system produces, so every way of inflating it has to be closed: one person
 * submitting repeatedly, a retry, a duplicate delivery, or two issues merging
 * when the same person had reported both.
 *
 * Four quantities are kept strictly separate, because collapsing them is how
 * a dashboard ends up overstating public concern: submitted media items,
 * unique contributors, on-site evidence, and population — the last of which
 * this system never estimates at all.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

import {
  recordParticipation,
  countsForIssue,
  unionParticipationOnMerge,
  LiveCorroborationAdapter,
} from "./participation-counts.ts";
import { mergeIssues, reverseMerge } from "./issue-assignment.ts";
import { newCorrelationId, type AdapterCallContext } from "@vision/contracts";

const DATABASE_URL =
  process.env["DATABASE_URL"] ??
  "postgresql://vision:vision_local_dev_only@127.0.0.1:5432/vision_dev";

let client: pg.Client;
const issues: string[] = [];
const submissions: string[] = [];
const participants: string[] = [];

const ORIGIN = { lon: 74.71, lat: 16.99 };

before(async () => {
  client = new pg.Client({ connectionString: DATABASE_URL, statement_timeout: 15_000 });
  await client.connect();
});

after(async () => {
  await client.end().catch(() => undefined);
  const cleaner = new pg.Client({ connectionString: DATABASE_URL, statement_timeout: 10_000 });
  await cleaner.connect();
  try {
    if (submissions.length > 0) {
      await cleaner.query(
        "delete from issue_evidence_link where evidence_id in (select evidence_id from evidence_item where submission_id = any($1::uuid[]))",
        [submissions],
      );
      await cleaner.query("delete from issue_match where submission_id = any($1::uuid[])", [
        submissions,
      ]);
      await cleaner.query("delete from evidence_item where submission_id = any($1::uuid[])", [
        submissions,
      ]);
    }
    if (issues.length > 0) {
      await cleaner.query(
        "delete from issue_alias where source_issue_id = any($1::uuid[]) or target_issue_id = any($1::uuid[])",
        [issues],
      );
      await cleaner.query(
        "delete from issue_merge where surviving_issue_id = any($1::uuid[]) or merged_issue_id = any($1::uuid[])",
        [issues],
      );
      await cleaner.query(
        "delete from issue_participation where canonical_issue_id = any($1::uuid[])",
        [issues],
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
      await cleaner.query("delete from identity_mapping where participant_id = any($1::uuid[])", [
        participants,
      ]);
      await cleaner.query("delete from participant where participant_id = any($1::uuid[])", [
        participants,
      ]);
    }
  } finally {
    await cleaner.end();
  }
});

const newParticipant = async (): Promise<string> => {
  const id = randomUUID();
  await client.query("insert into participant (participant_id) values ($1)", [id]);
  participants.push(id);
  return id;
};

const newIssue = async (): Promise<string> => {
  const issueId = randomUUID();
  await client.query(
    `insert into canonical_issue
       (issue_id, public_reference, category, opened_at, representative_location, last_evidence_at)
     values ($1,$2,'sanitation', now(), ST_SetSRID(ST_MakePoint($3,$4),4326)::geography, now())`,
    [issueId, `VIS-${issueId.slice(0, 8)}`, ORIGIN.lon, ORIGIN.lat],
  );
  issues.push(issueId);
  return issueId;
};

/** A submission plus one evidence item, linked to an issue. */
const contribute = async (
  participantId: string,
  issueId: string,
  options: { readonly source?: string; readonly mediaType?: string } = {},
): Promise<string> => {
  const submissionId = randomUUID();
  await client.query(
    `insert into submission
       (submission_id, participant_id, observed_location, observed_accuracy_m,
        observed_location_source, observed_at, interface_locale, locale_pack_version,
        taxonomy_version, idempotency_key)
     values ($1,$2, ST_SetSRID(ST_MakePoint($3,$4),4326)::geography, 12, $5, now(),
             'en-IN','demo-locales.v1','demo-taxonomy.v1',$6)`,
    [
      submissionId,
      participantId,
      ORIGIN.lon,
      ORIGIN.lat,
      options.source ?? "device_geolocation",
      `p29-${submissionId}`,
    ],
  );
  submissions.push(submissionId);

  const evidenceId = randomUUID();
  const mediaType = options.mediaType ?? "text";
  if (mediaType === "text") {
    await client.query(
      `insert into evidence_item (evidence_id, submission_id, media_type, content_text)
       values ($1,$2,'text','The drain outside the school is blocked.')`,
      [evidenceId, submissionId],
    );
  } else {
    await client.query(
      `insert into evidence_item
         (evidence_id, submission_id, media_type, object_reference, fingerprint_hash)
       values ($1,$2,$3,$4,$5)`,
      [evidenceId, submissionId, mediaType, `originals/test/${evidenceId}`, "a".repeat(64)],
    );
  }
  await client.query(
    `insert into issue_evidence_link
       (issue_evidence_link_id, evidence_id, canonical_issue_id, effective_from)
     values ($1,$2,$3, now())`,
    [randomUUID(), evidenceId, issueId],
  );
  return submissionId;
};

const eligible = {
  verdict: "eligible" as const,
  reasons: ["a distinct demonstration participant"],
};

// ---------------------------------------------------------------------------
// One counted participant per issue
// ---------------------------------------------------------------------------

test("V029: a first contribution creates one counted participation", async () => {
  const issueId = await newIssue();
  const participantId = await newParticipant();
  await contribute(participantId, issueId);

  const result = await recordParticipation(client, {
    participantId,
    issueId,
    evidenceAt: new Date().toISOString(),
    eligibility: eligible,
  });

  assert.equal(result.counted, true);
  assert.equal(result.created, true);
  const counts = await countsForIssue(client, issueId);
  assert.equal(counts.uniqueContributors, 1);
});

test("V029: the same person contributing again does not increase the count", async () => {
  const issueId = await newIssue();
  const participantId = await newParticipant();

  for (let index = 0; index < 3; index += 1) {
    await contribute(participantId, issueId);
    await recordParticipation(client, {
      participantId,
      issueId,
      evidenceAt: new Date().toISOString(),
      eligibility: eligible,
    });
  }

  const counts = await countsForIssue(client, issueId);
  assert.equal(counts.uniqueContributors, 1, "one person is one contributor");
  // But the extra evidence is real and must be visible as media.
  assert.equal(counts.submittedMediaItems, 3);
});

test("V029: a repeated call for the same pair is idempotent, not an error", async () => {
  const issueId = await newIssue();
  const participantId = await newParticipant();
  await contribute(participantId, issueId);

  const first = await recordParticipation(client, {
    participantId,
    issueId,
    evidenceAt: new Date().toISOString(),
    eligibility: eligible,
  });
  const second = await recordParticipation(client, {
    participantId,
    issueId,
    evidenceAt: new Date().toISOString(),
    eligibility: eligible,
  });

  assert.equal(first.created, true);
  assert.equal(second.created, false, "a duplicate delivery must not be a second contributor");
  assert.equal((await countsForIssue(client, issueId)).uniqueContributors, 1);
});

test("V029: later evidence advances the participation window without recounting", async () => {
  const issueId = await newIssue();
  const participantId = await newParticipant();
  await contribute(participantId, issueId);
  const early = "2026-09-01T10:00:00.000Z";
  const later = "2026-09-05T10:00:00.000Z";

  await recordParticipation(client, {
    participantId,
    issueId,
    evidenceAt: early,
    eligibility: eligible,
  });
  await recordParticipation(client, {
    participantId,
    issueId,
    evidenceAt: later,
    eligibility: eligible,
  });

  const { rows } = await client.query(
    "select first_evidence_at, last_evidence_at from issue_participation where participant_id = $1 and canonical_issue_id = $2",
    [participantId, issueId],
  );
  assert.equal(new Date(String(rows[0]?.["first_evidence_at"])).toISOString(), early);
  assert.equal(new Date(String(rows[0]?.["last_evidence_at"])).toISOString(), later);
});

test("V029: an ineligible contribution is recorded but not counted, with a reason", async () => {
  const issueId = await newIssue();
  const participantId = await newParticipant();
  await contribute(participantId, issueId);

  const result = await recordParticipation(client, {
    participantId,
    issueId,
    evidenceAt: new Date().toISOString(),
    eligibility: {
      verdict: "not_counted",
      reasons: ["the same device reported twice in one minute"],
    },
  });

  assert.equal(result.counted, false);
  const counts = await countsForIssue(client, issueId);
  assert.equal(counts.uniqueContributors, 0);
  const { rows } = await client.query(
    "select counted, non_counted_reason from issue_participation where participant_id = $1",
    [participantId],
  );
  assert.equal(rows[0]?.["counted"], false);
  assert.ok(
    String(rows[0]?.["non_counted_reason"]).length > 0,
    "a non-count needs a stated reason",
  );
});

// ---------------------------------------------------------------------------
// One person cannot become two accounts
// ---------------------------------------------------------------------------

test("V029: one provider subject cannot map to two participants", async () => {
  // This is what actually prevents repeated accounts inflating a count: the
  // V009 identity mapping is unique on the hashed provider subject, so a
  // second login by the same credential reaches the same participant.
  const first = await newParticipant();
  const second = await newParticipant();
  // 64 lowercase hex characters, as `identity_mapping_hash_shape_ck` requires.
  const subjectHash = (randomUUID() + randomUUID()).replace(/-/g, "");

  await client.query(
    "insert into identity_mapping (identity_mapping_id, participant_id, provider, provider_subject_hash, provider_mode) values ($1,$2,'simulated',$3,'simulated')",
    [randomUUID(), first, subjectHash],
  );

  await assert.rejects(
    () =>
      client.query(
        "insert into identity_mapping (identity_mapping_id, participant_id, provider, provider_subject_hash, provider_mode) values ($1,$2,'simulated',$3,'simulated')",
        [randomUUID(), second, subjectHash],
      ),
    /uniq|duplicate key/i,
  );
});

// ---------------------------------------------------------------------------
// Merges union contributors rather than adding them up
// ---------------------------------------------------------------------------

test("V029: merging unions contributors instead of summing them", async () => {
  const surviving = await newIssue();
  const merged = await newIssue();
  const shared = await newParticipant();
  const onlyOnSurviving = await newParticipant();
  const onlyOnMerged = await newParticipant();

  for (const [participantId, issueId] of [
    [shared, surviving],
    [shared, merged],
    [onlyOnSurviving, surviving],
    [onlyOnMerged, merged],
  ] as const) {
    await contribute(participantId, issueId);
    await recordParticipation(client, {
      participantId,
      issueId,
      evidenceAt: new Date().toISOString(),
      eligibility: eligible,
    });
  }

  assert.equal((await countsForIssue(client, surviving)).uniqueContributors, 2);
  assert.equal((await countsForIssue(client, merged)).uniqueContributors, 2);

  const merge = await mergeIssues(client, {
    survivingIssueId: surviving,
    mergedIssueId: merged,
    reason: "the same blocked drain",
    decidedByActorType: "reviewer",
    decidedByActorId: randomUUID(),
  });

  // Three distinct people, not four: the shared contributor is one person.
  // The merge itself unioned them; no follow-up call is needed.
  const counts = await countsForIssue(client, surviving);
  assert.equal(counts.uniqueContributors, 3, "2 + 2 must not become 4");
  assert.equal(merge.participation.movedParticipations, 1);
  assert.equal(merge.participation.alreadyPresent, 1);
});

test("V029: a merge preserves the moved participation's own evidence window", async () => {
  const surviving = await newIssue();
  const merged = await newIssue();
  const mover = await newParticipant();
  await contribute(mover, merged);
  await recordParticipation(client, {
    participantId: mover,
    issueId: merged,
    evidenceAt: "2026-08-01T00:00:00Z",
    eligibility: eligible,
  });

  await unionParticipationOnMerge(client, { survivingIssueId: surviving, mergedIssueId: merged });

  const { rows } = await client.query(
    "select first_evidence_at from issue_participation where participant_id = $1 and canonical_issue_id = $2",
    [mover, surviving],
  );
  assert.equal(
    new Date(String(rows[0]?.["first_evidence_at"])).toISOString(),
    "2026-08-01T00:00:00.000Z",
    "when someone first reported is history and must survive the merge",
  );
});

test("V029: reversing a merge restores the separate counts and keeps the history", async () => {
  const surviving = await newIssue();
  const merged = await newIssue();
  const a = await newParticipant();
  const b = await newParticipant();
  await contribute(a, surviving);
  await recordParticipation(client, {
    participantId: a,
    issueId: surviving,
    evidenceAt: new Date().toISOString(),
    eligibility: eligible,
  });
  await contribute(b, merged);
  await recordParticipation(client, {
    participantId: b,
    issueId: merged,
    evidenceAt: new Date().toISOString(),
    eligibility: eligible,
  });

  const merge = await mergeIssues(client, {
    survivingIssueId: surviving,
    mergedIssueId: merged,
    reason: "looked like one problem",
    decidedByActorType: "reviewer",
    decidedByActorId: randomUUID(),
  });
  await unionParticipationOnMerge(client, { survivingIssueId: surviving, mergedIssueId: merged });
  assert.equal((await countsForIssue(client, surviving)).uniqueContributors, 2);

  await reverseMerge(client, { mergeId: merge.mergeId, reason: "they are two different drains" });
  const restored = await unionParticipationOnMerge(client, {
    survivingIssueId: merged,
    mergedIssueId: surviving,
    onlyMovedByMerge: merge.mergeId,
  });

  // The contribution history is auditable: the move is recorded rather than
  // the rows being silently rewritten.
  assert.ok(restored.movedParticipations >= 1);
  // Only what the merge moved comes back. `a` reported the surviving issue
  // and must stay there; sweeping everything would corrupt both counts.
  assert.equal((await countsForIssue(client, merged)).uniqueContributors, 1);
  assert.equal((await countsForIssue(client, surviving)).uniqueContributors, 1);
});

// ---------------------------------------------------------------------------
// Four quantities, kept apart
// ---------------------------------------------------------------------------

test("V029: media items, contributors and on-site evidence are separate numbers", async () => {
  const issueId = await newIssue();
  const walker = await newParticipant();
  const pinner = await newParticipant();

  // One person, two photographs, captured by the device.
  await contribute(walker, issueId, { mediaType: "photo" });
  await contribute(walker, issueId, { mediaType: "photo" });
  await recordParticipation(client, {
    participantId: walker,
    issueId,
    evidenceAt: new Date().toISOString(),
    eligibility: eligible,
  });
  // Another person, one text report, location typed by hand.
  await contribute(pinner, issueId, { source: "manual_pin" });
  await recordParticipation(client, {
    participantId: pinner,
    issueId,
    evidenceAt: new Date().toISOString(),
    eligibility: eligible,
  });

  const counts = await countsForIssue(client, issueId);

  assert.equal(counts.uniqueContributors, 2);
  assert.equal(counts.submittedMediaItems, 3);
  // On-site means a device measurement, not a typed claim about a place.
  assert.equal(counts.onsiteEvidenceItems, 2);
  // Never estimated. A count of reporters says nothing about how many people
  // are affected, and presenting one as the other would be an invention.
  assert.equal(counts.populationEstimate, undefined);
});

// ---------------------------------------------------------------------------
// The live corroboration signal replaces the V025 fixture
// ---------------------------------------------------------------------------

test("V029: the live corroboration adapter reports real counts, not a fixture", async () => {
  const issueId = await newIssue();
  for (let index = 0; index < 3; index += 1) {
    const participantId = await newParticipant();
    await contribute(participantId, issueId);
    await recordParticipation(client, {
      participantId,
      issueId,
      evidenceAt: new Date().toISOString(),
      eligibility: eligible,
    });
  }
  const adapter = new LiveCorroborationAdapter(client);
  const context: AdapterCallContext = { correlation_id: newCorrelationId() };

  const outcome = await adapter.countEligibleParticipants(issueId, context);

  assert.equal(outcome.kind, "success");
  if (outcome.kind !== "success") return;
  assert.equal(outcome.value.eligibleParticipants, 3);
  assert.equal(outcome.value.inputIsFixture, false, "this is live participation now");
  assert.equal(adapter.descriptor.provider_mode, "real");
});

test("V029: an issue nobody else reported is zero, not unknown, and says so", async () => {
  const issueId = await newIssue();
  const adapter = new LiveCorroborationAdapter(client);

  const outcome = await adapter.countEligibleParticipants(issueId, {
    correlation_id: newCorrelationId(),
  });

  assert.equal(outcome.kind, "success");
  if (outcome.kind !== "success") return;
  assert.equal(outcome.value.eligibleParticipants, 0);
  // Now that the count is live, zero genuinely means "no other counted
  // participant" — which still is not evidence that nobody else is affected.
  // The earlier pattern here included `/nobody else/`, which happily matched
  // the sentence "nobody else reported this" — the exact claim it was meant to
  // forbid. The disclaimer has to be asserted literally.
  assert.match(outcome.value.note, /does not mean nobody else is affected/i);
  assert.doesNotMatch(outcome.value.note, /^nobody else reported/i);
});

// ---------------------------------------------------------------------------
// Corrections and erasure must not leave evidence in the counts
// ---------------------------------------------------------------------------

test("V029: a superseded evidence link is no longer counted as media", async () => {
  // A correction supersedes a link rather than deleting it (V003), so the old
  // row stays for history. Counting it would double-count the evidence after
  // every correction.
  const issueId = await newIssue();
  const participantId = await newParticipant();
  await contribute(participantId, issueId, { mediaType: "photo" });
  assert.equal((await countsForIssue(client, issueId)).submittedMediaItems, 1);

  await client.query(
    "update issue_evidence_link set effective_to = now() where canonical_issue_id = $1",
    [issueId],
  );

  const counts = await countsForIssue(client, issueId);
  assert.equal(counts.submittedMediaItems, 0, "a superseded link is history, not current evidence");
  assert.equal(counts.onsiteEvidenceItems, 0);
});

test("V029: erased evidence drops out of the counts", async () => {
  // V005 erasure keeps a tombstone row with every restricted value cleared.
  // A tombstone is not evidence and must not be counted as media.
  const issueId = await newIssue();
  const participantId = await newParticipant();
  await contribute(participantId, issueId, { mediaType: "photo" });
  assert.equal((await countsForIssue(client, issueId)).submittedMediaItems, 1);

  await client.query(
    `update evidence_item
        set privacy_state = 'erased', erased_at = now(), object_reference = null,
            content_text = null, fingerprint_hash = null, perceptual_hash = null,
            capture_metadata = null, transcript_text = null, transcript_provenance = null,
            derivative_reference = null
      where submission_id = any($1::uuid[])`,
    [submissions.slice(-1)],
  );

  assert.equal((await countsForIssue(client, issueId)).submittedMediaItems, 0);
});

test("V029: merging unions participation as part of the merge itself", async () => {
  // Previously `unionParticipationOnMerge` was a separate call, so a merge
  // without the follow-up stranded contributions on an issue nobody can reach
  // and left the survivor undercounting the people who reported it.
  const surviving = await newIssue();
  const merged = await newIssue();
  const shared = await newParticipant();
  const onlyOnMerged = await newParticipant();

  for (const [participantId, issueId] of [
    [shared, surviving],
    [shared, merged],
    [onlyOnMerged, merged],
  ] as const) {
    await contribute(participantId, issueId);
    await recordParticipation(client, {
      participantId,
      issueId,
      evidenceAt: new Date().toISOString(),
      eligibility: eligible,
    });
  }

  const merge = await mergeIssues(client, {
    survivingIssueId: surviving,
    mergedIssueId: merged,
    reason: "the same blocked drain",
    decidedByActorType: "reviewer",
    decidedByActorId: randomUUID(),
  });

  // No second call: the merge did it.
  assert.equal(merge.participation.movedParticipations, 1);
  assert.equal(merge.participation.alreadyPresent, 1);
  const counts = await countsForIssue(client, surviving);
  assert.equal(counts.uniqueContributors, 2, "two distinct people, not three");
  const stranded = await client.query(
    "select count(*)::int as n from issue_participation where canonical_issue_id = $1",
    [merged],
  );
  assert.equal(stranded.rows[0]?.["n"], 0, "nothing may be left on the retired issue");
});
