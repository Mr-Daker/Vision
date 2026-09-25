/**
 * Every integrity check, planted and caught (roadmap V048).
 *
 * Run with: npm run db:up && npm run db:migrate && npm run test:db
 *
 * A check that has never been seen to fire is not evidence — V044 established
 * that for the privacy audit and it is at least as true here, because an
 * integrity check runs against a database that is usually fine and therefore
 * spends its whole life returning nothing. So each condition is planted, the
 * check is required to find it, and the finding is required to carry a
 * procedure an operator could actually follow.
 *
 * Everything is planted inside a transaction that is rolled back, so the
 * development database this runs against is not left holding the corruption
 * this file invents.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

import { INTEGRITY_CHECK_NAMES, runIntegrityChecks } from "./integrity.ts";

const DATABASE_URL =
  process.env["DATABASE_URL"] ??
  "postgresql://vision:vision_local_dev_only@127.0.0.1:5432/vision_dev";

let client: pg.Client;

before(async () => {
  client = new pg.Client({ connectionString: DATABASE_URL, statement_timeout: 60_000 });
  await client.connect();
});

after(async () => {
  await client.end().catch(() => undefined);
});

/** Plants a condition, runs the checks, and always rolls the planting back. */
const planted = async <T>(
  plant: () => Promise<T>,
): Promise<{
  readonly outcomes: Awaited<ReturnType<typeof runIntegrityChecks>>;
  readonly value: T;
}> => {
  await client.query("begin");
  try {
    const value = await plant();
    const outcomes = await runIntegrityChecks(client, { asOf: new Date(), maxAttempts: 5 });
    return { outcomes, value };
  } finally {
    await client.query("rollback").catch(() => undefined);
  }
};

const findingsOf = (
  outcomes: Awaited<ReturnType<typeof runIntegrityChecks>>,
  check: string,
): readonly import("@vision/domain").IntegrityFinding[] => {
  const outcome = outcomes.find((entry) => entry.check === check);
  assert.notEqual(outcome, undefined, `no check named '${check}' ran`);
  assert.equal(outcome?.ran, true, `'${check}' did not run: ${outcome?.reasonNotRun ?? ""}`);
  return outcome?.findings ?? [];
};

/** A bare issue, inserted the way a test fixture does, for a probe to corrupt. */
const anIssue = async (status = "created"): Promise<string> => {
  const issueId = randomUUID();
  await client.query(
    `insert into canonical_issue
       (issue_id, public_reference, category, current_status, opened_at,
        representative_location, last_evidence_at)
     values ($1,$2,'sanitation',$3, now(),
             ST_SetSRID(ST_MakePoint(75.61,17.81),4326)::geography, now())`,
    [issueId, `VIS-PROBE-${issueId.slice(0, 8).toUpperCase()}`, status],
  );
  return issueId;
};

const aParticipant = async (): Promise<string> => {
  const participantId = randomUUID();
  await client.query("insert into participant (participant_id) values ($1)", [participantId]);
  return participantId;
};

const anEvidenceItem = async (): Promise<string> => {
  const participantId = await aParticipant();
  const submissionId = randomUUID();
  await client.query(
    `insert into submission
       (submission_id, participant_id, observed_location, observed_accuracy_m,
        observed_location_source, observed_at, interface_locale, language_hint,
        locale_pack_version, taxonomy_version, idempotency_key)
     values ($1,$2, ST_SetSRID(ST_MakePoint(75.61,17.81),4326)::geography, 12,
             'device_geolocation', now(), 'en-IN','en-IN','demo-locales.v1',
             'demo-taxonomy.v1',$3)`,
    [submissionId, participantId, `probe-${submissionId}`],
  );
  const evidenceId = randomUUID();
  await client.query(
    `insert into evidence_item (evidence_id, submission_id, media_type, content_text)
     values ($1,$2,'text','planted by the V048 integrity probe')`,
    [evidenceId, submissionId],
  );
  return evidenceId;
};

const PROBE_BASIS = JSON.stringify({ planted_by: "the V048 integrity probe" });

const link = async (evidenceId: string, issueId: string): Promise<void> => {
  await client.query(
    `insert into issue_evidence_link
       (issue_evidence_link_id, evidence_id, canonical_issue_id, decision_basis, effective_from)
     values ($1,$2,$3,$4::jsonb, now())`,
    [randomUUID(), evidenceId, issueId, PROBE_BASIS],
  );
};

/** A recorded event, so a merge has the decision row the schema requires. */
const anEvent = async (issueId: string, eventType = "probe"): Promise<string> => {
  const eventId = randomUUID();
  await client.query(
    `insert into status_event
       (event_id, aggregate_type, aggregate_id, aggregate_version, event_type,
        actor_type, correlation_id, occurred_at, payload_schema_version, payload)
     values ($1,'canonical_issue',$2,1,$3,'system_worker',$4, now(),'1.0.0','{}'::jsonb)`,
    [eventId, issueId, eventType, randomUUID()],
  );
  return eventId;
};

const merge = async (survivor: string, retired: string): Promise<void> => {
  await client.query(
    `insert into issue_merge
       (merge_id, surviving_issue_id, merged_issue_id, merged_at, reason, decision_event_id)
     values ($1,$2,$3, now(), 'planted by the V048 integrity probe', $4)`,
    [randomUUID(), survivor, retired, await anEvent(survivor, "merged")],
  );
};

const anOutboxRow = async (overrides: {
  readonly attempts?: number;
  readonly delivered?: boolean;
  readonly reason?: string | null;
}): Promise<string> => {
  const eventId = await anEvent(await anIssue());
  const { rows } = await client.query(
    `insert into outbox
       (event_id, task_type, payload, created_at, not_before, attempts,
        delivered_at, terminal_failure_reason)
     values ($1,'probe_task','{}'::jsonb, now(), now(), $2,
             case when $3::boolean then now() else null end, $4)
     returning outbox_id`,
    [eventId, overrides.attempts ?? 0, overrides.delivered ?? false, overrides.reason ?? null],
  );
  return String(rows[0]?.["outbox_id"]);
};

// ---------------------------------------------------------------------------
// The control
// ---------------------------------------------------------------------------

test("V048: every check this module claims to run is named, and every name runs", async () => {
  const outcomes = await runIntegrityChecks(client, { asOf: new Date(), maxAttempts: 5 });
  const ran = outcomes.map((outcome) => outcome.check).sort();
  assert.deepEqual(
    ran,
    [...INTEGRITY_CHECK_NAMES].sort(),
    "the declared list and the checks that actually run have drifted apart",
  );
  for (const outcome of outcomes) {
    assert.equal(
      outcome.ran,
      true,
      `'${outcome.check}' did not run: ${outcome.reasonNotRun ?? ""}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Canonical issue membership
// ---------------------------------------------------------------------------

/**
 * Four conditions cannot be planted at all.
 *
 * Found by trying: the database refuses each one on write. Those checks stay,
 * because a second opinion costs nothing and a constraint can be dropped by a
 * migration — but what is proved here is the **constraint**, not the query,
 * since a query that has never been able to return a row proves nothing about
 * its own correctness.
 */
const refusedByTheDatabase = async (
  constraint: string,
  plant: () => Promise<unknown>,
): Promise<void> => {
  await client.query("begin");
  try {
    await plant();
    assert.fail(`the database accepted a state '${constraint}' is supposed to refuse`);
  } catch (error) {
    if (error instanceof assert.AssertionError) throw error;
    assert.equal(
      (error as { constraint?: string }).constraint,
      constraint,
      `refused, but by something other than ${constraint}: ${String(error)}`,
    );
  } finally {
    await client.query("rollback").catch(() => undefined);
  }
};

test("V048: evidence cannot be live on two issues, because the schema refuses it", async () => {
  await refusedByTheDatabase("issue_evidence_link_one_active_per_evidence_uniq", async () => {
    const evidenceId = await anEvidenceItem();
    await link(evidenceId, await anIssue());
    await link(evidenceId, await anIssue());
  });
});

test("V048: two issues cannot share a public reference, because the schema refuses it", async () => {
  await refusedByTheDatabase("canonical_issue_public_reference_key", async () => {
    const reference = `VIS-PROBE-${randomUUID().slice(0, 8).toUpperCase()}`;
    for (let index = 0; index < 2; index += 1) {
      await client.query(
        `insert into canonical_issue
           (issue_id, public_reference, category, current_status, opened_at,
            representative_location, last_evidence_at)
         values ($1,$2,'sanitation','created', now(),
                 ST_SetSRID(ST_MakePoint(75.61,17.81),4326)::geography, now())`,
        [randomUUID(), reference],
      );
    }
  });
});

test("V048: one person cannot be counted twice on one issue, because the schema refuses it", async () => {
  await refusedByTheDatabase("issue_participation_participant_issue_uniq", async () => {
    const issueId = await anIssue();
    const participantId = await aParticipant();
    for (let index = 0; index < 2; index += 1) {
      await client.query(
        `insert into issue_participation
           (participation_id, participant_id, canonical_issue_id, counted,
            eligibility_provenance, first_evidence_at, last_evidence_at)
         values ($1,$2,$3,true,$4::jsonb, now(), now())`,
        [randomUUID(), participantId, issueId, PROBE_BASIS],
      );
    }
  });
});

test("V048: a task cannot be delivered and failed at once, because the schema refuses it", async () => {
  await refusedByTheDatabase("outbox_terminal_requires_no_delivery_ck", async () => {
    await anOutboxRow({ attempts: 1, delivered: true, reason: "planted by the V048 probe" });
  });
});

test("V048 PROBE: a ring of merges with no survivor is found, and says what is lost", async () => {
  const { outcomes } = await planted(async () => {
    const a = await anIssue();
    const b = await anIssue();
    await merge(a, b);
    await merge(b, a);
    return [a, b];
  });
  const findings = findingsOf(outcomes, "merge_alias_cycle");
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.recoverability, "unrecoverable");
  assert.match(findings[0]?.lost ?? "", /intended to survive/);
  assert.match(findings[0]?.procedure ?? "", /reverse the merge/);
});

// ---------------------------------------------------------------------------
// Uniqueness
// ---------------------------------------------------------------------------

test("V048 PROBE: a status no event ever moved the issue to is found and is unrecoverable", async () => {
  const { outcomes } = await planted(async () => anIssue("resolution_confirmed"));
  const findings = findingsOf(outcomes, "status_with_no_transition_event");
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.recoverability, "unrecoverable");
  assert.match(findings[0]?.lost ?? "", /who moved the issue and why/);
  // The procedure has to refuse the obvious wrong move.
  assert.match(findings[0]?.procedure ?? "", /do not edit the status/i);
});

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

test("V048 PROBE: a task that stopped being retried without saying why is found", async () => {
  const { outcomes } = await planted(async () => anOutboxRow({ attempts: 5 }));
  const findings = findingsOf(outcomes, "task_abandoned_without_a_reason");
  assert.equal(findings.length, 1);
  assert.match(findings[0]?.ifNobodyActs ?? "", /keeps promising it is being processed/);
});

test("V048 PROBE: cells that no longer total their facts are found", async () => {
  const { outcomes } = await planted(async () => {
    const { rows } = await client.query(
      `select summary_name, jurisdiction_key, category from summary_cell
        where summary_name = 'district_category' order by jurisdiction_key limit 1`,
    );
    assert.notEqual(rows[0], undefined, "run `npm run summaries:rebuild` before this probe");
    await client.query(
      // Both columns, because `summary_cell_partition_ck` requires the states
      // to sum to the issue count. Breaking that is a different fault, and the
      // database refuses it; what this plants is the cross-cell total drifting
      // from the facts, which nothing refuses.
      `update summary_cell set issue_count = issue_count + 7, open_count = open_count + 7
        where summary_name = $1 and jurisdiction_key = $2 and category = $3`,
      [rows[0]?.["summary_name"], rows[0]?.["jurisdiction_key"], rows[0]?.["category"]],
    );
    return rows[0];
  });
  const findings = findingsOf(outcomes, "summary_cells_do_not_total_the_facts");
  assert.equal(findings.length, 1);
  assert.match(findings[0]?.procedure ?? "", /summaries:rebuild/);
});

test("V048 PROBE: a projection that disagrees with a rebuild is found", async () => {
  const { outcomes } = await planted(async () => {
    const { rows } = await client.query(
      `select issue_id from summary_issue_fact where summary_name = 'district_category'
        order by issue_id limit 1`,
    );
    assert.notEqual(rows[0], undefined, "run `npm run summaries:rebuild` before this probe");
    await client.query(
      `update summary_issue_fact set counted_participants = counted_participants + 3
        where summary_name = 'district_category' and issue_id = $1`,
      [rows[0]?.["issue_id"]],
    );
    return rows[0];
  });
  const findings = findingsOf(outcomes, "projection_disagrees_with_a_rebuild");
  assert.equal(findings.length, 1);
  assert.match(findings[0]?.procedure ?? "", /Keep this run's report/);
});

// ---------------------------------------------------------------------------
// The planting leaves nothing behind
// ---------------------------------------------------------------------------

test("V048: nothing this file planted survives it", async () => {
  const { rows } = await client.query(
    `select (select count(*)::int from canonical_issue where public_reference like 'VIS-PROBE-%') issues,
            (select count(*)::int from outbox where task_type = 'probe_task') tasks,
            (select count(*)::int from evidence_item
              where content_text = 'planted by the V048 integrity probe') evidence`,
  );
  assert.deepEqual(rows[0], { issues: 0, tasks: 0, evidence: 0 });
});
