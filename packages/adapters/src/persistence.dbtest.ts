/**
 * Real-database invariant tests (roadmap V012/V014).
 *
 * These run against the local PostgreSQL stack (V013), not a mock, because the
 * point is to prove the constraints exist and fire. Run with:
 *
 *   npm run db:up && npm run db:migrate && npm run test:db
 *
 * They are a separate file suffix (`.dbtest.ts`) so `npm test` stays runnable
 * on a clean checkout with no database, which V007 requires.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const DATABASE_URL =
  process.env["DATABASE_URL"] ??
  "postgresql://vision:vision_local_dev_only@127.0.0.1:5432/vision_dev";

let client: pg.Client;

before(async () => {
  client = new pg.Client({ connectionString: DATABASE_URL, statement_timeout: 15_000 });
  await client.connect();
});

after(async () => {
  await client.end();
});

/**
 * Asserts that a statement is refused by a named constraint or index.
 *
 * Wrapped in a savepoint because PostgreSQL aborts the entire transaction after
 * any failed statement — without this, the first expected violation would make
 * every later check in the same test fail with 25P02 instead of running.
 */
const expectViolation = async (
  run: () => Promise<unknown>,
  expected: string,
  message: string,
): Promise<void> => {
  await client.query("savepoint expected_violation");

  let accepted = false;
  let detail = "";
  try {
    await run();
    accepted = true;
  } catch (error) {
    detail = String(error instanceof Error ? error.message : error);
  }

  await client.query("rollback to savepoint expected_violation");

  assert.equal(accepted, false, `${message}: the database accepted a write it must reject`);
  assert.ok(
    detail.includes(expected),
    `${message}: expected '${expected}' to reject this write, got: ${detail}`,
  );
};

/** Each test works inside a rolled-back transaction, so nothing leaks. */
const inRollback = async (body: () => Promise<void>): Promise<void> => {
  await client.query("begin");
  try {
    await body();
  } finally {
    await client.query("rollback");
  }
};

const newParticipant = async (): Promise<string> => {
  const id = randomUUID();
  await client.query("insert into participant (participant_id) values ($1)", [id]);
  return id;
};

const newIssue = async (status = "created"): Promise<string> => {
  const id = randomUUID();
  await client.query(
    `insert into canonical_issue (issue_id, public_reference, category, current_status, opened_at)
     values ($1,$2,'structure.roof',$3, now())`,
    [id, `VIS-${id.slice(0, 8)}`, status],
  );
  return id;
};

const newSubmission = async (
  participantId: string,
  key: string = randomUUID(),
): Promise<string> => {
  const id = randomUUID();
  await client.query(
    `insert into submission (
       submission_id, participant_id, observed_location, observed_accuracy_m,
       observed_at, interface_locale, locale_pack_version, idempotency_key, taxonomy_version
     ) values ($1,$2, ST_SetSRID(ST_MakePoint(74.56,16.85),4326)::geography, 12,
               now(),'en-IN','demo-locales.v1',$3,'demo-taxonomy.v1')`,
    [id, participantId, key],
  );
  return id;
};

const newEvidence = async (submissionId: string): Promise<string> => {
  const id = randomUUID();
  await client.query(
    `insert into evidence_item (evidence_id, submission_id, media_type, object_reference, fingerprint_hash)
     values ($1,$2,'photo',$3,$4)`,
    [id, submissionId, `obj/${id}`, "a".repeat(64)],
  );
  return id;
};

const newEvent = async (aggregateId: string, version: number): Promise<string> => {
  const id = randomUUID();
  await client.query(
    `insert into status_event (
       event_id, aggregate_type, aggregate_id, aggregate_version, event_type,
       actor_type, correlation_id, occurred_at, payload_schema_version
     ) values ($1,'CanonicalIssue',$2,$3,'status_transitioned','system_worker',$4, now(),'v1')`,
    [id, aggregateId, version, randomUUID()],
  );
  return id;
};

// ---------------------------------------------------------------------------
// Repeated request acceptance
// ---------------------------------------------------------------------------

test("V012: a replayed submission cannot be accepted twice", async () => {
  await inRollback(async () => {
    const participant = await newParticipant();
    const key = "replayed-request-key-0001";
    await newSubmission(participant, key);

    await expectViolation(
      () => newSubmission(participant, key),
      "submission_participant_idempotency_uniq",
      "a retried submit under one idempotency key",
    );
  });
});

test("V012: the same idempotency key is free for a different participant", async () => {
  await inRollback(async () => {
    const a = await newParticipant();
    const b = await newParticipant();
    const key = "client-generated-key-0002";
    await newSubmission(a, key);
    // Keys are client-generated, so they are only unique per participant.
    await newSubmission(b, key);
  });
});

// ---------------------------------------------------------------------------
// Duplicate stage identities
// ---------------------------------------------------------------------------

test("V012: at-least-once delivery cannot create two rows for one stage", async () => {
  await inRollback(async () => {
    const submission = await newSubmission(await newParticipant());
    const insertStage = () =>
      client.query(
        `insert into processing_stage (stage_id, submission_id, stage, pipeline_version)
         values ($1,$2,'media_processing','v1')`,
        [randomUUID(), submission],
      );

    await insertStage();
    await expectViolation(
      insertStage,
      "processing_stage_identity_uniq",
      "a duplicate queue delivery for one stage",
    );
  });
});

test("V012: a lease must name its owner and expiry", async () => {
  await inRollback(async () => {
    const submission = await newSubmission(await newParticipant());
    await expectViolation(
      () =>
        client.query(
          `insert into processing_stage (stage_id, submission_id, stage, pipeline_version, state)
           values ($1,$2,'media_processing','v1','leased')`,
          [randomUUID(), submission],
        ),
      "processing_stage_lease_ck",
      "a leased stage with no lease owner",
    );
  });
});

// ---------------------------------------------------------------------------
// Repeated participation
// ---------------------------------------------------------------------------

test("V012: one participant counts once per canonical issue", async () => {
  await inRollback(async () => {
    const participant = await newParticipant();
    const issue = await newIssue();
    const insertParticipation = () =>
      client.query(
        `insert into issue_participation (
           participation_id, participant_id, canonical_issue_id, first_evidence_at, last_evidence_at
         ) values ($1,$2,$3, now(), now())`,
        [randomUUID(), participant, issue],
      );

    await insertParticipation();
    await expectViolation(
      insertParticipation,
      "issue_participation_participant_issue_uniq",
      "a second participation row for one participant on one issue",
    );
  });
});

test("V012: a non-counting participation must record why", async () => {
  await inRollback(async () => {
    const participant = await newParticipant();
    const issue = await newIssue();
    await expectViolation(
      () =>
        client.query(
          `insert into issue_participation (
             participation_id, participant_id, canonical_issue_id, counted,
             first_evidence_at, last_evidence_at
           ) values ($1,$2,$3,false, now(), now())`,
          [randomUUID(), participant, issue],
        ),
      "issue_participation_reason_required_ck",
      "counted=false with no reason",
    );
  });
});

test("V012: evidence timestamps cannot run backwards", async () => {
  await inRollback(async () => {
    const participant = await newParticipant();
    const issue = await newIssue();
    await expectViolation(
      () =>
        client.query(
          `insert into issue_participation (
             participation_id, participant_id, canonical_issue_id,
             first_evidence_at, last_evidence_at
           ) values ($1,$2,$3, now(), now() - interval '1 day')`,
          [randomUUID(), participant, issue],
        ),
      "issue_participation_evidence_order_ck",
      "last_evidence_at before first_evidence_at",
    );
  });
});

// ---------------------------------------------------------------------------
// Event ordering and time separation
// ---------------------------------------------------------------------------

test("V012: two events cannot occupy the same aggregate version", async () => {
  await inRollback(async () => {
    const issue = await newIssue();
    await newEvent(issue, 1);
    await newEvent(issue, 2);

    await expectViolation(
      () => newEvent(issue, 2),
      "status_event_aggregate_version_uniq",
      "a second event at one aggregate version",
    );
  });
});

test("V012: event time and ingestion time are stored separately", async () => {
  await inRollback(async () => {
    const issue = await newIssue();
    const eventId = randomUUID();
    // A reconciliation event records something that happened earlier.
    await client.query(
      `insert into status_event (
         event_id, aggregate_type, aggregate_id, aggregate_version, event_type,
         actor_type, correlation_id, occurred_at, payload_schema_version
       ) values ($1,'CanonicalIssue',$2,1,'reconciled','system_worker',$3,
                 now() - interval '2 hours','v1')`,
      [eventId, issue, randomUUID()],
    );

    const { rows } = await client.query(
      `select occurred_at, recorded_at,
              extract(epoch from (recorded_at - occurred_at)) as gap_seconds
       from status_event where event_id = $1`,
      [eventId],
    );
    const row = rows[0];
    assert.ok(row.gap_seconds > 3000, "the two timestamps must be independent columns");
    assert.notDeepEqual(row.occurred_at, row.recorded_at);
  });
});

// ---------------------------------------------------------------------------
// "Exactly one active row" partial unique indexes
// ---------------------------------------------------------------------------

test("V012: an evidence item has exactly one active issue link", async () => {
  await inRollback(async () => {
    const submission = await newSubmission(await newParticipant());
    const evidence = await newEvidence(submission);
    const issueA = await newIssue();
    const issueB = await newIssue();

    const link = (issueId: string) =>
      client.query(
        `insert into issue_evidence_link (
           issue_evidence_link_id, evidence_id, canonical_issue_id, effective_from
         ) values ($1,$2,$3, now() - interval '1 hour')`,
        [randomUUID(), evidence, issueId],
      );

    await link(issueA);
    await expectViolation(
      () => link(issueB),
      "issue_evidence_link_one_active_per_evidence_uniq",
      "a second active link for one evidence item",
    );

    // Closing the first link is what makes a correction possible.
    await client.query(
      "update issue_evidence_link set effective_to = now() where evidence_id = $1",
      [evidence],
    );
    await link(issueB);
  });
});

test("V012: a submission has exactly one active matching attempt", async () => {
  await inRollback(async () => {
    const submission = await newSubmission(await newParticipant());
    const attempt = (n: number) =>
      client.query(
        `insert into issue_match (match_id, submission_id, attempt_number)
         values ($1,$2,$3)`,
        [randomUUID(), submission, n],
      );

    await attempt(1);
    await expectViolation(
      () => attempt(2),
      "issue_match_one_active_per_submission_uniq",
      "a second active matching attempt",
    );

    // Superseding the first attempt allows a recheck.
    await client.query("update issue_match set superseded_at = now() where submission_id = $1", [
      submission,
    ]);
    await attempt(2);
  });
});

test("V012: a terminal match must record its result", async () => {
  await inRollback(async () => {
    const submission = await newSubmission(await newParticipant());
    await expectViolation(
      () =>
        client.query(
          `insert into issue_match (match_id, submission_id, attempt_number, state)
           values ($1,$2,1,'no_match')`,
          [randomUUID(), submission],
        ),
      "issue_match_terminal_requires_result_ck",
      "a terminal match with no resulting issue",
    );
  });
});

test("V012: a non-terminal match cannot pretend to have a result", async () => {
  await inRollback(async () => {
    const submission = await newSubmission(await newParticipant());
    const issue = await newIssue();
    await expectViolation(
      () =>
        client.query(
          `insert into issue_match (match_id, submission_id, attempt_number, state, resulting_issue_id)
           values ($1,$2,1,'candidates_retrieved',$3)`,
          [randomUUID(), submission, issue],
        ),
      "issue_match_nonterminal_has_no_result_ck",
      "a pending match carrying a result",
    );
  });
});

test("V012: an issue has exactly one active assignment", async () => {
  await inRollback(async () => {
    const issue = await newIssue();
    const assign = (department: string) =>
      client.query(
        `insert into assignment (assignment_id, issue_id, department_id, reason, valid_from)
         values ($1,$2,$3,'routing decision', now() - interval '1 hour')`,
        [randomUUID(), issue, department],
      );

    await assign("dept-a");
    await expectViolation(
      () => assign("dept-b"),
      "assignment_one_active_per_issue_uniq",
      "a second active assignment",
    );

    await client.query("update assignment set valid_to = now() where issue_id = $1", [issue]);
    await assign("dept-b");
  });
});

test("V012: an issue has one active outgoing alias and never aliases to itself", async () => {
  await inRollback(async () => {
    const a = await newIssue();
    const b = await newIssue();
    const c = await newIssue();
    const eventId = await newEvent(a, 1);

    const mergeId = randomUUID();
    await client.query(
      `insert into issue_merge (merge_id, surviving_issue_id, merged_issue_id, merged_at, reason, decision_event_id)
       values ($1,$2,$3, now(),'same defect',$4)`,
      [mergeId, a, b, eventId],
    );

    const alias = (source: string, target: string) =>
      client.query(
        `insert into issue_alias (alias_id, source_issue_id, target_issue_id, merge_id, valid_from)
         values ($1,$2,$3,$4, now() - interval '1 hour')`,
        [randomUUID(), source, target, mergeId],
      );

    await alias(b, a);
    await expectViolation(
      () => alias(b, c),
      "issue_alias_one_active_outgoing_uniq",
      "a second active outgoing alias",
    );
    await expectViolation(() => alias(c, c), "issue_alias_distinct_ck", "a self-alias");

    // Reversal closes the edge, restoring b as its own root without a new issue.
    await client.query("update issue_alias set valid_to = now() where source_issue_id = $1", [b]);
    await alias(b, c);
  });
});

test("V012: an issue cannot be merged into itself", async () => {
  await inRollback(async () => {
    const issue = await newIssue();
    const eventId = await newEvent(issue, 1);
    await expectViolation(
      () =>
        client.query(
          `insert into issue_merge (merge_id, surviving_issue_id, merged_issue_id, merged_at, reason, decision_event_id)
           values ($1,$2,$2, now(),'oops',$3)`,
          [randomUUID(), issue, eventId],
        ),
      "issue_merge_distinct_ck",
      "a self-merge",
    );
  });
});

// ---------------------------------------------------------------------------
// Optimistic concurrency
// ---------------------------------------------------------------------------

test("V014: a stale optimistic write affects no rows", async () => {
  await inRollback(async () => {
    const issue = await newIssue("routed_internal");

    // Writer A reads version 1 and commits.
    const first = await client.query(
      `update canonical_issue set current_status = 'agency_ack_received',
              current_version = current_version + 1
       where issue_id = $1 and current_version = 1`,
      [issue],
    );
    assert.equal(first.rowCount, 1);

    // Writer B still holds version 1 and must lose.
    const stale = await client.query(
      `update canonical_issue set current_status = 'work_planned',
              current_version = current_version + 1
       where issue_id = $1 and current_version = 1`,
      [issue],
    );
    assert.equal(stale.rowCount, 0, "a stale expected-version write must not apply");

    const { rows } = await client.query(
      "select current_status, current_version from canonical_issue where issue_id = $1",
      [issue],
    );
    assert.equal(rows[0].current_status, "agency_ack_received");
    assert.equal(rows[0].current_version, 2);
  });
});

// ---------------------------------------------------------------------------
// Claim / confirmation separation
// ---------------------------------------------------------------------------

test("V014: a confirmation is written by exactly one of a participant or a reviewer", async () => {
  await inRollback(async () => {
    const participant = await newParticipant();
    const issue = await newIssue("work_planned");
    const claimId = randomUUID();
    await client.query(
      `insert into resolution_claim (claim_id, issue_id, staff_id, idempotency_key, claimed_at, description)
       values ($1,$2,$3,$4, now(),'repaired')`,
      [claimId, issue, randomUUID(), `claim-${claimId.slice(0, 8)}`],
    );

    const confirm = (participantId: string | null, reviewerId: string | null) =>
      client.query(
        `insert into resolution_confirmation (
           confirmation_id, claim_id, responding_participant_id, reviewer_id, decision, decided_at
         ) values ($1,$2,$3,$4,'confirmed', now())`,
        [randomUUID(), claimId, participantId, reviewerId],
      );

    await expectViolation(
      () => confirm(null, null),
      "resolution_confirmation_exactly_one_actor_ck",
      "a confirmation with no actor",
    );
    await expectViolation(
      () => confirm(participant, randomUUID()),
      "resolution_confirmation_exactly_one_actor_ck",
      "a confirmation with two actors",
    );

    await confirm(participant, null);

    // One answer per *actor*, not one per claim (migration 0016). The old rule
    // said one per claim, which made a category requiring two confirmations
    // impossible to close — so the schema forbade what the policy required.
    await expectViolation(
      () => confirm(participant, null),
      "resolution_confirmation_one_per_participant_uniq",
      "the same participant answering twice",
    );

    // A different person may answer, which is what makes a two-confirmation
    // category reachable at all.
    const second = await newParticipant();
    await confirm(second, null);

    // A reviewer may add their decision alongside the participants'.
    await confirm(null, randomUUID());

    // But only one reviewer decision, or two contradictory ones could stand
    // with nothing saying which applies.
    await expectViolation(
      () => confirm(null, randomUUID()),
      "resolution_confirmation_one_reviewer_per_claim_uniq",
      "a second reviewer decision on one claim",
    );
  });
});

test("V014: a resolution claim requires an issue and cannot be duplicated per staff key", async () => {
  await inRollback(async () => {
    const issue = await newIssue("work_planned");
    const staff = randomUUID();
    const insertClaim = () =>
      client.query(
        `insert into resolution_claim (claim_id, issue_id, staff_id, idempotency_key, claimed_at, description)
         values ($1,$2,$3,'staff-claim-key-1', now(),'repaired')`,
        [randomUUID(), issue, staff],
      );

    await insertClaim();
    await expectViolation(
      insertClaim,
      "resolution_claim_staff_idempotency_uniq",
      "a replayed resolution claim",
    );
  });
});

// ---------------------------------------------------------------------------
// Privacy and provenance constraints
// ---------------------------------------------------------------------------

test("V012: reference-only source material cannot carry a snapshot", async () => {
  await inRollback(async () => {
    await expectViolation(
      () =>
        client.query(
          `insert into source_record (
             source_record_id, source_name, source_url_or_location, retrieved_at,
             licence_or_permission_status, demo_status, raw_snapshot
           ) values ($1,'Local Government Directory','https://example.invalid/', now(),
                     'reference_only','unavailable_not_approved','{"code":"X"}'::jsonb)`,
          [randomUUID()],
        ),
      "source_record_no_snapshot_when_unusable_ck",
      "a reference-only source holding copied data",
    );
  });
});

test("V012: reference-only material cannot be labelled permitted demo data", async () => {
  await inRollback(async () => {
    await expectViolation(
      () =>
        client.query(
          `insert into source_record (
             source_record_id, source_name, source_url_or_location, retrieved_at,
             licence_or_permission_status, demo_status
           ) values ($1,'x','https://example.invalid/', now(),
                     'reference_only','permitted_source_data')`,
          [randomUUID()],
        ),
      "source_record_demo_status_consistency_ck",
      "reference-only material presented as permitted",
    );
  });
});

test("V012: a jurisdiction needs real or explicitly synthetic provenance", async () => {
  await inRollback(async () => {
    await expectViolation(
      () =>
        client.query(
          `insert into jurisdiction (
             jurisdiction_id, jurisdiction_profile_id, internal_code, directory_version,
             level_scheme, level_code, effective_from, synthetic_provenance
           ) values ($1,'p','X','v1','s','district', now(), false)`,
          [randomUUID()],
        ),
      "jurisdiction_provenance_required_ck",
      "a jurisdiction with neither a source nor a synthetic label",
    );
  });
});

test("V012: an external jurisdiction code requires an approved source record", async () => {
  await inRollback(async () => {
    await expectViolation(
      () =>
        client.query(
          `insert into jurisdiction (
             jurisdiction_id, jurisdiction_profile_id, internal_code, external_source_code,
             directory_version, level_scheme, level_code, effective_from, synthetic_provenance
           ) values ($1,'p','X','LGD-12345','v1','s','district', now(), true)`,
          [randomUUID()],
        ),
      "jurisdiction_external_code_needs_source_ck",
      "an external identifier with no source record",
    );
  });
});

test("V012: text evidence carries content and no object; media carries the reverse", async () => {
  await inRollback(async () => {
    const submission = await newSubmission(await newParticipant());

    await expectViolation(
      () =>
        client.query(
          `insert into evidence_item (evidence_id, submission_id, media_type, object_reference)
           values ($1,$2,'text','obj/should-not-exist')`,
          [randomUUID(), submission],
        ),
      "evidence_item_text_requires_content_ck",
      "text evidence pointing at an object",
    );

    await expectViolation(
      () =>
        client.query(
          `insert into evidence_item (evidence_id, submission_id, media_type, content_text)
           values ($1,$2,'photo','no object reference')`,
          [randomUUID(), submission],
        ),
      "evidence_item_media_requires_object_ck",
      "photo evidence with no object or fingerprint",
    );
  });
});

test("V012: only voice evidence may carry a transcript", async () => {
  await inRollback(async () => {
    const submission = await newSubmission(await newParticipant());
    await expectViolation(
      () =>
        client.query(
          `insert into evidence_item (
             evidence_id, submission_id, media_type, object_reference, fingerprint_hash, transcript_text
           ) values ($1,$2,'photo',$3,$4,'a transcript on a photo')`,
          [randomUUID(), submission, "obj/x", "b".repeat(64)],
        ),
      "evidence_item_transcript_only_for_voice_ck",
      "a transcript attached to a photo",
    );
  });
});

test("V012: a public derivative requires an approved redaction decision", async () => {
  await inRollback(async () => {
    const submission = await newSubmission(await newParticipant());
    await expectViolation(
      () =>
        client.query(
          `insert into evidence_item (
             evidence_id, submission_id, media_type, object_reference, fingerprint_hash,
             redaction_status, derivative_reference
           ) values ($1,$2,'photo',$3,$4,'pending','public/derivative.jpg')`,
          [randomUUID(), submission, "obj/y", "c".repeat(64)],
        ),
      "evidence_item_derivative_needs_approval_ck",
      "a public derivative without redaction approval",
    );
  });
});

test("V012: an identity mapping stores a keyed hash, never a raw reference", async () => {
  await inRollback(async () => {
    const participant = await newParticipant();
    await expectViolation(
      () =>
        client.query(
          `insert into identity_mapping (
             identity_mapping_id, participant_id, provider, provider_subject_hash, provider_mode
           ) values ($1,$2,'simulated-identity','demo-subject-0001','simulated')`,
          [randomUUID(), participant],
        ),
      "identity_mapping_hash_shape_ck",
      "a raw provider subject stored in place of a hash",
    );

    // The hashed form is accepted, and is unique per provider subject.
    const hash = "d".repeat(64);
    const insertMapping = () =>
      client.query(
        `insert into identity_mapping (
           identity_mapping_id, participant_id, provider, provider_subject_hash, provider_mode
         ) values ($1,$2,'simulated-identity',$3,'simulated')`,
        [randomUUID(), participant, hash],
      );
    await insertMapping();
    await expectViolation(
      insertMapping,
      "identity_mapping_provider_subject_uniq",
      "two mappings for one provider subject",
    );
  });
});

test("V012: consent purposes must be known and non-empty", async () => {
  await inRollback(async () => {
    const participant = await newParticipant();
    const insertConsent = (purposes: string[]) =>
      client.query(
        `insert into consent_record (
           consent_id, participant_id, notice_version, notice_locale, granted_purposes, granted_at
         ) values ($1,$2,'notice.v1','en-IN',$3::text[], now())`,
        [randomUUID(), participant, purposes],
      );

    await expectViolation(
      () => insertConsent([]),
      "consent_record_purposes_nonempty_ck",
      "consent with no purposes",
    );
    await expectViolation(
      () => insertConsent(["demo_processing", "sell_the_data"]),
      "consent_record_purposes_known_ck",
      "an unknown consent purpose",
    );
    await insertConsent(["demo_processing", "gemini_voice_transcription"]);
  });
});

test("V012: outbox work is unique per event and task type", async () => {
  await inRollback(async () => {
    const issue = await newIssue();
    const eventId = await newEvent(issue, 1);
    const insertOutbox = () =>
      client.query(`insert into outbox (event_id, task_type) values ($1,'notify_recipient')`, [
        eventId,
      ]);

    await insertOutbox();
    await expectViolation(
      insertOutbox,
      "outbox_event_task_uniq",
      "a duplicate outbox row for one event and task",
    );
  });
});

test("V012: a project link targets exactly one of an issue or an asset", async () => {
  await inRollback(async () => {
    const issue = await newIssue();
    const sourceId = randomUUID();
    await client.query(
      `insert into source_record (
         source_record_id, source_name, source_url_or_location, retrieved_at,
         licence_or_permission_status, demo_status, raw_snapshot
       ) values ($1,'synthetic projects','fixture', now(),'synthetic','team_created_synthetic','{}'::jsonb)`,
      [sourceId],
    );

    // V041 added `project_id` and made it mandatory for every status except
    // `unmatched`: a proposal has to name the project it proposes. The shape
    // this test is about — exactly one of an issue or an asset — is unchanged,
    // so the row gains a project and the assertion below stays as it was.
    const projectId = `persistence-prj-${randomUUID().slice(0, 8)}`;
    await client.query(
      `insert into sanctioned_project (
         project_id, project_name, scope_description, scope_terms, sanctioned_at,
         source_record_id, synthetic_provenance
       ) values ($1,'synthetic project','fixture scope',array['water_supply'], now(), $2, true)`,
      [projectId, sourceId],
    );

    const link = (issueId: string | null, assetId: string | null) =>
      client.query(
        `insert into project_link (
           project_link_id, issue_id, asset_id, project_id, source_project_id,
           match_basis, proposed_at
         ) values ($1,$2,$3,$4,$5,'{"basis":"asset_id"}'::jsonb, now())`,
        [randomUUID(), issueId, assetId, projectId, sourceId],
      );

    await expectViolation(
      () => link(null, null),
      "project_link_exactly_one_target_ck",
      "a project link with no target",
    );
    await link(issue, null);
  });
});
