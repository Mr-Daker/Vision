/**
 * V044 deletion requests against a real database.
 *
 * What erasure removes and what it keeps are two separate decisions, and the
 * second is the one this file exists to pin. Deleting participation rows would
 * mean every deletion request quietly reduced a public count, and "fourteen
 * people reported this" would stop meaning what it says — so the rows stay as
 * tombstones holding nothing about the person.
 */

import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import pg from "pg";

import { scanText } from "@vision/domain";

import { ErasureError, eraseParticipant } from "./erasure.ts";

const DATABASE_URL =
  process.env["DATABASE_URL"] ??
  "postgresql://vision:vision_local_dev_only@127.0.0.1:5432/vision_dev";

let client: pg.Client;
let issueId: string;
const createdParticipants: string[] = [];
const createdSubmissions: string[] = [];
const createdEvidence: string[] = [];
const createdIssues: string[] = [];

const digest = (): string => createHash("sha256").update(randomUUID()).digest("hex");

const makeParticipant = async (): Promise<string> => {
  const participantId = randomUUID();
  await client.query("insert into participant (participant_id) values ($1)", [participantId]);
  createdParticipants.push(participantId);
  await client.query(
    `insert into identity_mapping
       (identity_mapping_id, participant_id, provider, provider_subject_hash, provider_mode)
     values ($1,$2,'v044-provider',$3,'simulated')`,
    [randomUUID(), participantId, digest()],
  );
  await client.query(
    `insert into app_session
       (session_id, participant_id, token_hash, issued_at, expires_at)
     values ($1,$2,$3, now(), now() + interval '1 hour')`,
    [randomUUID(), participantId, digest()],
  );
  return participantId;
};

const makeSubmissionWithEvidence = async (participantId: string): Promise<string> => {
  const submissionId = randomUUID();
  await client.query(
    `insert into submission
       (submission_id, participant_id, observed_at, observed_location, observed_accuracy_m,
        observed_location_source, interface_locale, locale_pack_version, idempotency_key,
        taxonomy_version, processing_status)
     values ($1,$2, now(), st_setsrid(st_makepoint(74.512345,16.812345),4326)::geography, 8,
             'device','en-IN','v044.v1',$3,'v044.v1','accepted')`,
    [submissionId, participantId, `v044-${submissionId.slice(0, 8)}`],
  );
  createdSubmissions.push(submissionId);

  const evidenceId = randomUUID();
  await client.query(
    `insert into evidence_item
       (evidence_id, submission_id, media_type, object_reference, content_text,
        fingerprint_hash, perceptual_hash, capture_metadata, derivative_reference,
        redaction_status, processing_status)
     values ($1,$2,'photo',$3,null,$4,$5,$6::jsonb,$7,'approved','usable')`,
    [
      evidenceId,
      submissionId,
      `originals/v044/${evidenceId}.bin`,
      `sha256:${digest()}`,
      "ff00ff00ff00ff00",
      JSON.stringify({ captured_at: "2026-09-01T00:00:00Z", lon: 74.512345, lat: 16.812345 }),
      `derivatives/v044/${evidenceId}.png`,
    ],
  );
  createdEvidence.push(evidenceId);
  return submissionId;
};

before(async () => {
  client = new pg.Client({ connectionString: DATABASE_URL, statement_timeout: 60_000 });
  await client.connect();
  issueId = randomUUID();
  await client.query(
    `insert into canonical_issue
       (issue_id, public_reference, category, current_status, opened_at)
     values ($1,$2,'water_supply','created', now())`,
    [issueId, `VIS-V044E-${issueId.slice(0, 8)}`],
  );
  createdIssues.push(issueId);
});

const cleanup = async (): Promise<void> => {
  if (createdParticipants.length > 0) {
    await client.query(
      "delete from status_event where aggregate_type = 'participant' and aggregate_id = any($1::text[])",
      [createdParticipants],
    );
    await client.query("delete from issue_participation where participant_id = any($1::uuid[])", [
      createdParticipants,
    ]);
    await client.query("delete from app_session where participant_id = any($1::uuid[])", [
      createdParticipants,
    ]);
    await client.query("delete from identity_mapping where participant_id = any($1::uuid[])", [
      createdParticipants,
    ]);
  }
  if (createdEvidence.length > 0) {
    await client.query("delete from evidence_item where evidence_id = any($1::uuid[])", [
      createdEvidence,
    ]);
    createdEvidence.length = 0;
  }
  if (createdSubmissions.length > 0) {
    await client.query("delete from submission where submission_id = any($1::uuid[])", [
      createdSubmissions,
    ]);
    createdSubmissions.length = 0;
  }
  if (createdParticipants.length > 0) {
    await client.query("delete from participant where participant_id = any($1::uuid[])", [
      createdParticipants,
    ]);
    createdParticipants.length = 0;
  }
};

beforeEach(cleanup);

after(async () => {
  await cleanup();
  await client.query("delete from canonical_issue where issue_id = any($1::uuid[])", [
    createdIssues,
  ]);
  await client.end();
});

// ---------------------------------------------------------------------------
// What is removed
// ---------------------------------------------------------------------------

test("erasure clears the identity digest, the location and every piece of content", async () => {
  const participantId = await makeParticipant();
  await makeSubmissionWithEvidence(participantId);

  const result = await eraseParticipant(client, {
    participantId,
    reasonCode: "participant_request",
    asOf: new Date(),
  });
  assert.equal(result.identityMappingsErased, 1);
  assert.equal(result.submissionsErased, 1);
  assert.equal(result.evidenceErased, 1);
  assert.equal(result.sessionsRevoked, 1);
  assert.equal(result.alreadyErased, false);

  const { rows: identity } = await client.query(
    "select provider_subject_hash, erased_at from identity_mapping where participant_id = $1",
    [participantId],
  );
  assert.equal(identity[0]?.["provider_subject_hash"], null);
  assert.notEqual(identity[0]?.["erased_at"], null, "the tombstone records when");

  const { rows: submission } = await client.query(
    `select privacy_state, observed_location, observed_accuracy_m, observed_location_source
       from submission where participant_id = $1`,
    [participantId],
  );
  assert.equal(submission[0]?.["privacy_state"], "erased");
  assert.equal(submission[0]?.["observed_location"], null, "a precise location is the address");
  assert.equal(submission[0]?.["observed_accuracy_m"], null);

  const { rows: evidence } = await client.query(
    `select e.privacy_state, e.object_reference, e.fingerprint_hash, e.perceptual_hash,
            e.capture_metadata, e.derivative_reference, e.content_text, e.transcript_text
       from evidence_item e
       join submission s on s.submission_id = e.submission_id
      where s.participant_id = $1`,
    [participantId],
  );
  assert.equal(evidence[0]?.["privacy_state"], "erased");
  for (const field of [
    "object_reference",
    "fingerprint_hash",
    "perceptual_hash",
    "capture_metadata",
    "derivative_reference",
    "content_text",
    "transcript_text",
  ]) {
    assert.equal(evidence[0]?.[field], null, `${field} survived erasure`);
  }
});

test("the account cannot be used again: every live session is revoked as an erasure", async () => {
  const participantId = await makeParticipant();
  await eraseParticipant(client, {
    participantId,
    reasonCode: "consent_withdrawn",
    asOf: new Date(),
  });
  const { rows } = await client.query(
    "select revoked_at, revocation_reason from app_session where participant_id = $1",
    [participantId],
  );
  assert.notEqual(rows[0]?.["revoked_at"], null);
  assert.equal(
    rows[0]?.["revocation_reason"],
    "erasure",
    "recording this as an administrator's decision would misattribute the citizen's own request",
  );
});

// ---------------------------------------------------------------------------
// What is kept, and why
// ---------------------------------------------------------------------------

test("participation rows survive, so unique-contribution counts stay true", async () => {
  const participantId = await makeParticipant();
  await client.query(
    `insert into issue_participation
       (participation_id, participant_id, canonical_issue_id, counted,
        first_evidence_at, last_evidence_at)
     values ($1,$2,$3,true, now(), now())`,
    [randomUUID(), participantId, issueId],
  );

  const before = await client.query(
    "select count(*)::int as n from issue_participation where canonical_issue_id = $1 and counted",
    [issueId],
  );
  const result = await eraseParticipant(client, {
    participantId,
    reasonCode: "participant_request",
    asOf: new Date(),
  });
  const after = await client.query(
    "select count(*)::int as n from issue_participation where canonical_issue_id = $1 and counted",
    [issueId],
  );

  assert.equal(result.participationKept, 1);
  assert.equal(
    after.rows[0]?.["n"],
    before.rows[0]?.["n"],
    "deleting these would make every erasure quietly reduce a public count",
  );
});

test("the participant row stays as a tombstone rather than being deleted", async () => {
  const participantId = await makeParticipant();
  await eraseParticipant(client, {
    participantId,
    reasonCode: "participant_request",
    asOf: new Date(),
  });
  const { rows } = await client.query(
    "select tombstoned_at from participant where participant_id = $1",
    [participantId],
  );
  assert.equal(rows.length, 1, "the row is kept so a second login cannot create a twin beside it");
  assert.notEqual(rows[0]?.["tombstoned_at"], null);
});

// ---------------------------------------------------------------------------
// The record of the request
// ---------------------------------------------------------------------------

test("the record of an erasure holds counts and a reason code, never free text", async () => {
  const participantId = await makeParticipant();
  await makeSubmissionWithEvidence(participantId);
  await eraseParticipant(client, {
    participantId,
    reasonCode: "participant_request",
    asOf: new Date(),
  });

  const { rows } = await client.query(
    `select event_type, payload from status_event
      where aggregate_type = 'participant' and aggregate_id = $1`,
    [participantId],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.["event_type"], "participant_erased");
  const payload = rows[0]?.["payload"] as Record<string, unknown>;
  assert.equal(payload["reason_code"], "participant_request");
  assert.equal(payload["participation_kept"], 0);

  // A free-text field here is where somebody types the number they want
  // removed, which would then be in the record of their asking to be removed.
  assert.deepEqual(
    scanText(JSON.stringify(payload), "log", "erasure-event"),
    [],
    "the erasure record must itself be clean",
  );
});

test("an unknown reason code is refused before anything is written", async () => {
  const participantId = await makeParticipant();
  await assert.rejects(
    () =>
      eraseParticipant(client, {
        participantId,
        reasonCode: "because-i-said-so" as never,
        asOf: new Date(),
      }),
    (error: unknown) => error instanceof ErasureError,
  );
  const { rows } = await client.query(
    "select tombstoned_at from participant where participant_id = $1",
    [participantId],
  );
  assert.equal(rows[0]?.["tombstoned_at"], null);
});

test("asking twice is asking the same thing, and is not an error", async () => {
  const participantId = await makeParticipant();
  await makeSubmissionWithEvidence(participantId);
  const first = await eraseParticipant(client, {
    participantId,
    reasonCode: "participant_request",
    asOf: new Date(),
  });
  const second = await eraseParticipant(client, {
    participantId,
    reasonCode: "participant_request",
    asOf: new Date(),
  });
  assert.equal(first.alreadyErased, false);
  assert.equal(second.alreadyErased, true);
  assert.equal(second.evidenceErased, 0, "there was nothing left to clear");
});

test("erasing somebody who does not exist is refused rather than silently accepted", async () => {
  await assert.rejects(
    () =>
      eraseParticipant(client, {
        participantId: randomUUID(),
        reasonCode: "participant_request",
        asOf: new Date(),
      }),
    (error: unknown) => error instanceof ErasureError && /no such participant/.test(error.message),
  );
});

// ---------------------------------------------------------------------------
// The audit sees the result
// ---------------------------------------------------------------------------

test("after erasure nothing of that participant's content is scannable anywhere", async () => {
  const participantId = await makeParticipant();
  await makeSubmissionWithEvidence(participantId);
  await eraseParticipant(client, {
    participantId,
    reasonCode: "participant_request",
    asOf: new Date(),
  });

  const { rows } = await client.query(
    `select e.object_reference, e.capture_metadata, s.observed_location::text as loc
       from evidence_item e
       join submission s on s.submission_id = e.submission_id
      where s.participant_id = $1`,
    [participantId],
  );
  const remaining = JSON.stringify(rows);
  assert.deepEqual(scanText(remaining, "public_view", "post-erasure"), []);
  assert.doesNotMatch(remaining, /originals\//);
  assert.doesNotMatch(remaining, /74\.512345/);
});
