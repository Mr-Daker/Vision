/**
 * V038 replayable summaries against a real database.
 *
 * Run with: npm run db:up && npm run db:migrate && npm run test:db
 *
 * The acceptance clauses this file holds:
 *
 *   * **a clean rebuild matches incremental summaries on test histories** —
 *     built by replaying a history that includes a merge, a separation, a
 *     jurisdiction correction, a reassignment, a reopening and a backdated
 *     event, then reconciling and rebuilding and comparing cell for cell;
 *   * **retries cannot increase counts** — the same events are re-read and
 *     re-applied and the totals do not move;
 *   * **summary freshness and reconciliation failures are observable** — a
 *     skipped event makes the summary say it is lagging, and a corrupted fact
 *     is reported rather than silently repaired.
 *
 * Each test uses its own `summaryName` and its own category, so the cell
 * assertions are exact counts rather than deltas against the hundreds of rows
 * earlier tasks left in the development database.
 */

import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

import {
  applySummaryEvents,
  readSummaryCells,
  reconcileSummaries,
  rebuildSummaries,
  summaryStatus,
  type SummaryCell,
} from "./summaries.ts";

const DATABASE_URL =
  process.env["DATABASE_URL"] ??
  "postgresql://vision:vision_local_dev_only@127.0.0.1:5432/vision_dev";

let client: pg.Client;
const createdIssues: string[] = [];
const createdParticipants: string[] = [];
const createdJurisdictions: string[] = [];
const createdSummaries: string[] = [];
const eventVersions = new Map<string, number>();

/** A private namespace for one test's projection. */
const newSummary = (): string => {
  const name = `v038-${randomUUID().slice(0, 12)}`;
  createdSummaries.push(name);
  return name;
};

const makeJurisdiction = async (): Promise<string> => {
  const id = randomUUID();
  await client.query(
    `insert into jurisdiction
       (jurisdiction_id, jurisdiction_profile_id, internal_code, directory_version,
        level_scheme, level_code, effective_from, synthetic_provenance)
     values ($1,'v038-profile',$2,'v038-directory.v1','v038-scheme','block',
             now() - interval '2 years', true)`,
    [id, `V38-${id.slice(0, 8)}`],
  );
  createdJurisdictions.push(id);
  return id;
};

const makeIssue = async (options: {
  readonly category: string;
  readonly jurisdictionId?: string | null;
  readonly status?: string;
}): Promise<string> => {
  const id = randomUUID();
  await client.query(
    `insert into canonical_issue
       (issue_id, public_reference, category, current_status, opened_at, jurisdiction_id)
     values ($1,$2,$3,$4, now() - interval '30 days', $5)`,
    [
      id,
      `VIS-V038-${id.slice(0, 8)}`,
      options.category,
      options.status ?? "created",
      options.jurisdictionId ?? null,
    ],
  );
  createdIssues.push(id);
  return id;
};

const setStatus = async (issueId: string, status: string): Promise<void> => {
  await client.query("update canonical_issue set current_status = $2 where issue_id = $1", [
    issueId,
    status,
  ]);
};

const appendEvent = async (
  issueId: string,
  eventType: string,
  payload: Record<string, unknown> = {},
  clocks?: { readonly occurredAt?: string; readonly recordedAt?: string },
): Promise<string> => {
  const eventId = randomUUID();
  const version = (eventVersions.get(issueId) ?? 0) + 1;
  eventVersions.set(issueId, version);
  await client.query(
    `insert into status_event
       (event_id, aggregate_type, aggregate_id, aggregate_version, event_type,
        actor_type, correlation_id, occurred_at, recorded_at, payload_schema_version, payload)
     values ($1,'canonical_issue',$2,$3,$4,'system_worker',$5,
             coalesce($6::timestamptz, now()), coalesce($7::timestamptz, now()),
             '1.0.0',$8::jsonb)`,
    [
      eventId,
      issueId,
      version,
      eventType,
      randomUUID(),
      clocks?.occurredAt ?? null,
      clocks?.recordedAt ?? null,
      JSON.stringify(payload),
    ],
  );
  return eventId;
};

const makeParticipant = async (): Promise<string> => {
  const id = randomUUID();
  await client.query("insert into participant (participant_id) values ($1)", [id]);
  createdParticipants.push(id);
  return id;
};

const participate = async (participantId: string, issueId: string): Promise<void> => {
  await client.query(
    `insert into issue_participation
       (participation_id, participant_id, canonical_issue_id, counted,
        first_evidence_at, last_evidence_at)
     values ($1,$2,$3,true, now() - interval '29 days', now() - interval '29 days')`,
    [randomUUID(), participantId, issueId],
  );
};

/** Merges `merged` into `surviving`, returning the merge id so it can be reversed. */
const mergeInto = async (surviving: string, merged: string): Promise<string> => {
  const eventId = await appendEvent(surviving, "issue_merged", { merged_issue_id: merged });
  const mergeId = randomUUID();
  await client.query(
    `insert into issue_merge
       (merge_id, surviving_issue_id, merged_issue_id, merged_at, reason, decision_event_id)
     values ($1,$2,$3, now(), 'v038 fixture', $4)`,
    [mergeId, surviving, merged, eventId],
  );
  await client.query(
    `insert into issue_alias (alias_id, source_issue_id, target_issue_id, merge_id, valid_from)
     values ($1,$2,$3,$4, now() - interval '1 hour')`,
    [randomUUID(), merged, surviving, mergeId],
  );
  return mergeId;
};

const reverseMerge = async (mergeId: string, surviving: string): Promise<void> => {
  const { rows } = await client.query(
    "select merged_issue_id from issue_merge where merge_id = $1",
    [mergeId],
  );
  await appendEvent(surviving, "issue_merge_reversed", {
    merge_id: mergeId,
    merged_issue_id: String(rows[0]?.["merged_issue_id"] ?? ""),
  });
  await client.query("update issue_alias set valid_to = now() where merge_id = $1", [mergeId]);
  await client.query(
    "update issue_merge set reversed_at = now(), reversal_reason = 'v038 fixture' where merge_id = $1",
    [mergeId],
  );
};

const cellsFor = async (summaryName: string, category: string): Promise<readonly SummaryCell[]> =>
  (await readSummaryCells(client, { summaryName })).filter((cell) => cell.category === category);

const comparable = (cells: readonly SummaryCell[]): string =>
  JSON.stringify(
    cells
      .map(({ refreshedAt: _refreshedAt, ...rest }) => rest)
      .sort((a, b) => a.jurisdictionKey.localeCompare(b.jurisdictionKey)),
  );

before(async () => {
  client = new pg.Client({ connectionString: DATABASE_URL, statement_timeout: 60_000 });
  await client.connect();
});

const cleanup = async (): Promise<void> => {
  if (createdSummaries.length > 0) {
    for (const table of [
      "summary_reconciliation",
      "summary_applied_event",
      "summary_watermark",
      "summary_cell",
      "summary_issue_fact",
    ]) {
      await client.query(`delete from ${table} where summary_name = any($1::text[])`, [
        createdSummaries,
      ]);
    }
    createdSummaries.length = 0;
  }
  if (createdIssues.length > 0) {
    await client.query(
      "delete from summary_issue_fact where issue_id = any($1::uuid[]) or root_issue_id = any($1::uuid[])",
      [createdIssues],
    );
    await client.query("delete from assignment where issue_id = any($1::uuid[])", [createdIssues]);
    await client.query(
      `delete from issue_alias where source_issue_id = any($1::uuid[])
                                 or target_issue_id = any($1::uuid[])`,
      [createdIssues],
    );
    await client.query(
      `delete from issue_merge where surviving_issue_id = any($1::uuid[])
                                 or merged_issue_id = any($1::uuid[])`,
      [createdIssues],
    );
    await client.query(
      "delete from issue_participation where canonical_issue_id = any($1::uuid[])",
      [createdIssues],
    );
    await client.query(
      "delete from summary_applied_event where event_id in (select event_id from status_event where aggregate_type = 'canonical_issue' and aggregate_id = any($1::text[]))",
      [createdIssues],
    );
    await client.query(
      "delete from status_event where aggregate_type = 'canonical_issue' and aggregate_id = any($1::text[])",
      [createdIssues],
    );
    await client.query("delete from canonical_issue where issue_id = any($1::uuid[])", [
      createdIssues,
    ]);
    createdIssues.length = 0;
  }
  if (createdParticipants.length > 0) {
    await client.query("delete from participant where participant_id = any($1::uuid[])", [
      createdParticipants,
    ]);
    createdParticipants.length = 0;
  }
  if (createdJurisdictions.length > 0) {
    await client.query("delete from jurisdiction where jurisdiction_id = any($1::uuid[])", [
      createdJurisdictions,
    ]);
    createdJurisdictions.length = 0;
  }
  eventVersions.clear();
};

beforeEach(cleanup);

after(async () => {
  await cleanup();
  await client.end();
});

// ---------------------------------------------------------------------------
// The headline clause
// ---------------------------------------------------------------------------

test("a clean rebuild matches the incremental summaries on a full test history", async () => {
  const summaryName = newSummary();
  const category = `v038-history-${randomUUID().slice(0, 8)}`;
  const wardOne = await makeJurisdiction();
  const wardTwo = await makeJurisdiction();

  const survivor = await makeIssue({ category, jurisdictionId: wardOne });
  const duplicate = await makeIssue({ category, jurisdictionId: wardOne });
  const elsewhere = await makeIssue({ category, jurisdictionId: wardTwo });
  const unplaced = await makeIssue({ category });

  // A projection is seeded by a rebuild and maintained incrementally after
  // it, which is the operating model the acceptance clause compares against.
  // Every call takes a fresh clock, because alias validity is evaluated at the
  // instant it is asked about and a pinned `asOf` would still see a merge that
  // has since been reversed.
  await rebuildSummaries(client, { summaryName, asOf: new Date() });

  await setStatus(survivor, "resolution_claimed");
  await appendEvent(survivor, "resolution_claimed");
  await setStatus(elsewhere, "resolution_confirmed");
  await appendEvent(elsewhere, "resolution_confirmed");
  await applySummaryEvents(client, { summaryName, asOf: new Date() });

  // Two people, one of whom reported both of the issues that later merge.
  const both = await makeParticipant();
  const other = await makeParticipant();
  await participate(both, survivor);
  await participate(both, duplicate);
  await participate(other, duplicate);

  const mergeId = await mergeInto(survivor, duplicate);
  await applySummaryEvents(client, { summaryName, asOf: new Date() });

  await setStatus(elsewhere, "reopened");
  await appendEvent(elsewhere, "issue_reopened", { reason: "it came back" });

  await client.query("update canonical_issue set jurisdiction_id = $2 where issue_id = $1", [
    unplaced,
    wardTwo,
  ]);
  await appendEvent(unplaced, "jurisdiction_corrected", { jurisdiction_id: wardTwo });

  await client.query(
    `insert into assignment (assignment_id, issue_id, department_id, assigned_staff_id, reason, valid_from)
     values ($1,$2,'v038-dept',$3,'v038 fixture', now())`,
    [randomUUID(), survivor, randomUUID()],
  );
  await appendEvent(survivor, "issue_assigned", { department_id: "v038-dept" });

  // Backdated: it describes a moment before everything above and arrives now.
  await appendEvent(
    duplicate,
    "resolution_claimed",
    {},
    { occurredAt: new Date(Date.now() - 20 * 86_400_000).toISOString() },
  );

  await applySummaryEvents(client, { summaryName, asOf: new Date() });
  await reverseMerge(mergeId, survivor);
  await applySummaryEvents(client, { summaryName, asOf: new Date() });

  const incremental = await cellsFor(summaryName, category);
  const reconciliation = await reconcileSummaries(client, { summaryName, asOf: new Date() });
  assert.equal(
    reconciliation.reconciled,
    true,
    `incremental projection disagrees with a rebuild: ${JSON.stringify(reconciliation.factDifferences.slice(0, 5))} ${JSON.stringify(reconciliation.cellDifferences.slice(0, 5))}`,
  );

  await rebuildSummaries(client, { summaryName, asOf: new Date() });
  const rebuilt = await cellsFor(summaryName, category);
  assert.equal(comparable(rebuilt), comparable(incremental), "rebuild and incremental must agree");

  // And the history actually exercised what it claims to.
  const byWard = new Map(rebuilt.map((cell) => [cell.jurisdictionKey, cell]));
  assert.equal(byWard.get(wardOne)?.issueCount, 2, "the separation freed the duplicate again");
  assert.equal(byWard.get(wardTwo)?.issueCount, 2, "the corrected issue moved into ward two");
  assert.equal(byWard.get("UNKNOWN"), undefined, "and left no row behind in UNKNOWN");
  assert.equal(byWard.get(wardTwo)?.reopened, 1, "a reopened issue is reopened, not confirmed");
  assert.equal(byWard.get(wardOne)?.claimed, 1);
  assert.equal(byWard.get(wardOne)?.countedParticipants, 2, "a merge unions contributors");
});

// ---------------------------------------------------------------------------
// Retries
// ---------------------------------------------------------------------------

test("re-reading and re-applying every event does not move a single count", async () => {
  const summaryName = newSummary();
  const category = `v038-retry-${randomUUID().slice(0, 8)}`;
  const ward = await makeJurisdiction();
  const asOf = new Date();

  const first = await makeIssue({ category, jurisdictionId: ward, status: "resolution_claimed" });
  const second = await makeIssue({ category, jurisdictionId: ward });
  await participate(await makeParticipant(), first);
  await participate(await makeParticipant(), second);
  await appendEvent(first, "resolution_claimed");
  await appendEvent(second, "work_planned");

  await applySummaryEvents(client, { summaryName, asOf });
  const once = await cellsFor(summaryName, category);
  assert.equal(once[0]?.issueCount, 2);
  assert.equal(once[0]?.countedParticipants, 2);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    // Force the pass to see the same events again, which is what a crashed
    // worker that had already written its facts would produce.
    await client.query("delete from summary_applied_event where summary_name = $1", [summaryName]);
    const pass = await applySummaryEvents(client, { summaryName, asOf });
    assert.ok(pass.eventsRead >= 2, "the events were genuinely re-read");
    assert.equal(comparable(await cellsFor(summaryName, category)), comparable(once));
  }
});

test("two projection passes racing on separate connections apply each event once", async () => {
  const summaryName = newSummary();
  const category = `v038-race-${randomUUID().slice(0, 8)}`;
  const ward = await makeJurisdiction();
  const issue = await makeIssue({ category, jurisdictionId: ward });
  await appendEvent(issue, "work_planned");

  const { rows: total } = await client.query(
    "select count(*)::int as n from status_event where aggregate_type = 'canonical_issue'",
  );
  const issueEvents = Number(total[0]?.["n"] ?? 0);

  const second = new pg.Client({ connectionString: DATABASE_URL, statement_timeout: 60_000 });
  await second.connect();
  try {
    const [left, right] = await Promise.all([
      applySummaryEvents(client, { summaryName, asOf: new Date(), limit: 5_000 }),
      applySummaryEvents(second, { summaryName, asOf: new Date(), limit: 5_000 }),
    ]);
    // Both passes read the same backlog; between them each event is claimed
    // exactly once, because the claim is a primary key rather than a check
    // followed by an insert.
    assert.equal(left.eventsApplied + right.eventsApplied, issueEvents);
  } finally {
    await second.end();
  }

  const { rows: applied } = await client.query(
    "select count(*)::int as n from summary_applied_event where summary_name = $1",
    [summaryName],
  );
  assert.equal(Number(applied[0]?.["n"]), issueEvents, "no event was applied twice");

  const cells = await cellsFor(summaryName, category);
  assert.equal(cells.length, 1);
  assert.equal(cells[0]?.issueCount, 1, "and the racing passes did not inflate the cell");
});

// ---------------------------------------------------------------------------
// Merges, separations, corrections, reassignment
// ---------------------------------------------------------------------------

test("a merge folds two reports into one and unions their contributors", async () => {
  const summaryName = newSummary();
  const category = `v038-merge-${randomUUID().slice(0, 8)}`;
  const ward = await makeJurisdiction();

  const survivor = await makeIssue({ category, jurisdictionId: ward });
  const duplicate = await makeIssue({ category, jurisdictionId: ward });
  const both = await makeParticipant();
  const only = await makeParticipant();
  await participate(both, survivor);
  await participate(both, duplicate);
  await participate(only, duplicate);
  await appendEvent(survivor, "work_planned");
  await appendEvent(duplicate, "work_planned");

  await applySummaryEvents(client, { summaryName, asOf: new Date() });
  const before = await cellsFor(summaryName, category);
  assert.equal(before[0]?.issueCount, 2);
  assert.equal(before[0]?.countedParticipants, 2, "two people, three participation rows");

  const mergeId = await mergeInto(survivor, duplicate);
  await applySummaryEvents(client, { summaryName, asOf: new Date() });
  const merged = await cellsFor(summaryName, category);
  assert.equal(merged[0]?.issueCount, 1, "one report, not two");
  assert.equal(merged[0]?.countedParticipants, 2, "still two people; a merge unions, never adds");

  await reverseMerge(mergeId, survivor);
  await applySummaryEvents(client, { summaryName, asOf: new Date() });
  const separated = await cellsFor(summaryName, category);
  assert.equal(separated[0]?.issueCount, 2, "a separation restores the freed issue with no undo");
  assert.equal(comparable(separated), comparable(before));
});

test("a corrected jurisdiction moves the issue rather than counting it twice", async () => {
  const summaryName = newSummary();
  const category = `v038-move-${randomUUID().slice(0, 8)}`;
  const wrong = await makeJurisdiction();
  const right = await makeJurisdiction();
  const asOf = new Date();

  const issue = await makeIssue({ category, jurisdictionId: wrong });
  await appendEvent(issue, "work_planned");
  await applySummaryEvents(client, { summaryName, asOf });
  assert.equal((await cellsFor(summaryName, category)).length, 1);

  await client.query("update canonical_issue set jurisdiction_id = $2 where issue_id = $1", [
    issue,
    right,
  ]);
  await appendEvent(issue, "jurisdiction_corrected", { jurisdiction_id: right });
  await applySummaryEvents(client, { summaryName, asOf });

  const cells = await cellsFor(summaryName, category);
  assert.equal(cells.length, 1, "the old cell is gone, not left holding a stale count");
  assert.equal(cells[0]?.jurisdictionKey, right);
  assert.equal(cells[0]?.issueCount, 1);
});

test("reassignment inside a department changes no summary count", async () => {
  const summaryName = newSummary();
  const category = `v038-assign-${randomUUID().slice(0, 8)}`;
  const ward = await makeJurisdiction();
  const asOf = new Date();
  const issue = await makeIssue({ category, jurisdictionId: ward });
  await appendEvent(issue, "work_planned");
  await applySummaryEvents(client, { summaryName, asOf });
  const before = await cellsFor(summaryName, category);

  for (let round = 0; round < 3; round += 1) {
    // One active assignment per issue: a reassignment closes the standing one
    // and opens the next, which is what the adapter does too.
    await client.query(
      "update assignment set valid_to = now() where issue_id = $1 and valid_to is null",
      [issue],
    );
    await client.query(
      `insert into assignment (assignment_id, issue_id, department_id, assigned_staff_id, reason, valid_from)
       values ($1,$2,'v038-dept',$3,'reassigned', now() + interval '1 millisecond')`,
      [randomUUID(), issue, randomUUID()],
    );
    await appendEvent(issue, "issue_assigned", { department_id: "v038-dept" });
    await applySummaryEvents(client, { summaryName, asOf });
  }

  assert.equal(
    comparable(await cellsFor(summaryName, category)),
    comparable(before),
    "who is holding the work is not what a district summary counts",
  );
});

test("an issue with no jurisdiction lands in a visible UNKNOWN cell", async () => {
  const summaryName = newSummary();
  const category = `v038-unknown-${randomUUID().slice(0, 8)}`;
  const asOf = new Date();
  const issue = await makeIssue({ category });
  await appendEvent(issue, "work_planned");
  await applySummaryEvents(client, { summaryName, asOf });

  const cells = await cellsFor(summaryName, category);
  assert.equal(cells.length, 1);
  assert.equal(cells[0]?.jurisdictionKey, "UNKNOWN");
  assert.equal(cells[0]?.issueCount, 1, "a row that says UNKNOWN, not a row that is missing");
  assert.equal(cells[0]?.boundaryVersion, null);
});

test("an unresolvable merge cycle is projected as unknown rather than dropped", async () => {
  const summaryName = newSummary();
  const category = `v038-cycle-${randomUUID().slice(0, 8)}`;
  const ward = await makeJurisdiction();
  const asOf = new Date();

  const left = await makeIssue({ category, jurisdictionId: ward });
  const right = await makeIssue({ category, jurisdictionId: ward });
  await mergeInto(left, right);
  await mergeInto(right, left);
  await applySummaryEvents(client, { summaryName, asOf });

  const cells = await cellsFor(summaryName, category);
  assert.equal(cells[0]?.issueCount, 2);
  assert.equal(
    cells[0]?.unknownState,
    2,
    "both are visible as unplaceable; a table whose totals are read as complete must not quietly omit them",
  );
  assert.equal(cells[0]?.open, 0);
});

// ---------------------------------------------------------------------------
// Late updates
// ---------------------------------------------------------------------------

test("an issue that never emitted an event is still found and projected", async () => {
  const summaryName = newSummary();
  const category = `v038-silent-${randomUUID().slice(0, 8)}`;
  const ward = await makeJurisdiction();

  await rebuildSummaries(client, { summaryName, asOf: new Date() });

  // No production path appends a `created` event when an issue is opened, so
  // an event-driven projection alone would never learn this report exists —
  // and the first time a district summary heard about it would be the next
  // full rebuild. The worker's own reconciliation pass found exactly this
  // before the discovery sweep existed.
  const silent = await makeIssue({ category, jurisdictionId: ward });

  const pass = await applySummaryEvents(client, { summaryName, asOf: new Date() });
  assert.equal(pass.eventsRead, 0, "there is genuinely no event for it");
  assert.ok(pass.issuesDiscovered >= 1, "found by absence from its own table, not by an event");

  const cells = await cellsFor(summaryName, category);
  assert.equal(cells.length, 1);
  assert.equal(cells[0]?.issueCount, 1);
  assert.ok(silent.length > 0);

  const run = await reconcileSummaries(client, { summaryName, asOf: new Date() });
  assert.equal(run.reconciled, true, "and the projection now agrees with a clean rebuild");
});

test("a backdated event is projected, because the cursor follows ingestion order", async () => {
  const summaryName = newSummary();
  const category = `v038-late-${randomUUID().slice(0, 8)}`;
  const ward = await makeJurisdiction();
  const asOf = new Date();

  const issue = await makeIssue({ category, jurisdictionId: ward });
  await appendEvent(issue, "work_planned");
  await applySummaryEvents(client, { summaryName, asOf });

  // Describes a moment two years before anything already projected, and
  // arrives now. An event-time cursor would have moved past it long ago.
  await setStatus(issue, "resolution_claimed");
  await appendEvent(
    issue,
    "resolution_claimed",
    {},
    { occurredAt: new Date(asOf.getTime() - 730 * 86_400_000).toISOString() },
  );

  const pass = await applySummaryEvents(client, { summaryName, asOf });
  assert.equal(pass.eventsRead, 1, "the late event was read, not left behind the watermark");
  assert.equal(pass.eventsApplied, 1);

  const cells = await cellsFor(summaryName, category);
  assert.equal(cells[0]?.claimed, 1);
  assert.equal(cells[0]?.open, 0);
});

// ---------------------------------------------------------------------------
// Observability
// ---------------------------------------------------------------------------

test("an unapplied event makes the summary report itself as lagging", async () => {
  const summaryName = newSummary();
  const category = `v038-fresh-${randomUUID().slice(0, 8)}`;
  const ward = await makeJurisdiction();
  const asOf = new Date();

  const never = await summaryStatus(client, { summaryName, asOf });
  assert.equal(never.freshness.state, "never_built");
  assert.match(never.freshness.explanation, /never been built/);

  const issue = await makeIssue({ category, jurisdictionId: ward });
  await appendEvent(issue, "work_planned");
  await rebuildSummaries(client, { summaryName, asOf });
  const fresh = await summaryStatus(client, { summaryName, asOf });
  assert.equal(fresh.freshness.state, "fresh");
  assert.equal(fresh.freshness.pendingEvents, 0);
  assert.notEqual(fresh.lastRebuildAt, null);

  await appendEvent(issue, "resolution_claimed");
  const lagging = await summaryStatus(client, { summaryName, asOf });
  assert.equal(lagging.freshness.state, "lagging", "recency alone is not freshness");
  assert.equal(lagging.freshness.pendingEvents, 1);
  assert.match(lagging.freshness.explanation, /behind the record/);
});

test("a corrupted fact is reported in detail and is not silently repaired", async () => {
  const summaryName = newSummary();
  const category = `v038-recon-${randomUUID().slice(0, 8)}`;
  const ward = await makeJurisdiction();
  const asOf = new Date();

  const issue = await makeIssue({ category, jurisdictionId: ward, status: "resolution_claimed" });
  await appendEvent(issue, "resolution_claimed");
  await rebuildSummaries(client, { summaryName, asOf });
  assert.equal((await reconcileSummaries(client, { summaryName, asOf })).reconciled, true);

  // Exactly the shape of a projection bug: the stored row disagrees with the
  // records it was derived from.
  await client.query(
    "update summary_issue_fact set state = 'confirmed' where summary_name = $1 and issue_id = $2",
    [summaryName, issue],
  );

  const run = await reconcileSummaries(client, { summaryName, asOf });
  assert.equal(run.reconciled, false);
  assert.equal(run.mismatchedFacts, 1);
  const difference = run.factDifferences.find((item) => item.issueId === issue);
  assert.deepEqual(difference, {
    issueId: issue,
    field: "state",
    incremental: "confirmed",
    rebuilt: "claimed",
  });

  const { rows } = await client.query(
    "select state from summary_issue_fact where summary_name = $1 and issue_id = $2",
    [summaryName, issue],
  );
  assert.equal(
    String(rows[0]?.["state"]),
    "confirmed",
    "reconciliation must not repair what it found; the next run would then always pass",
  );

  const status = await summaryStatus(client, { summaryName, asOf });
  assert.equal(status.lastReconciliation?.reconciled, false);
  assert.ok((status.lastReconciliation?.mismatches ?? 0) > 0);

  const { rows: recorded } = await client.query(
    "select reconciled, differences from summary_reconciliation where run_id = $1",
    [run.runId],
  );
  assert.equal(recorded[0]?.["reconciled"], false);
  assert.match(JSON.stringify(recorded[0]?.["differences"]), /"field":"state"/);
});

test("the stored states always partition the issue count, enforced by the database", async () => {
  const summaryName = newSummary();
  const category = `v038-partition-${randomUUID().slice(0, 8)}`;
  const ward = await makeJurisdiction();
  const asOf = new Date();
  for (const status of ["created", "resolution_claimed", "resolution_disputed", "reopened"]) {
    const issue = await makeIssue({ category, jurisdictionId: ward, status });
    await appendEvent(issue, "work_planned");
  }
  await applySummaryEvents(client, { summaryName, asOf });

  const cell = (await cellsFor(summaryName, category))[0];
  assert.ok(cell !== undefined);
  assert.equal(
    cell.open + cell.claimed + cell.disputed + cell.confirmed + cell.reopened + cell.unknownState,
    cell.issueCount,
  );

  await assert.rejects(
    () =>
      client.query(
        "update summary_cell set open_count = open_count + 1 where summary_name = $1 and category = $2",
        [summaryName, category],
      ),
    /summary_cell_partition_ck/,
    "a cell whose states do not add up to its total is a projection bug the database refuses to hold",
  );
});

test("a retired issue is held as a fact but counted in no cell", async () => {
  const summaryName = newSummary();
  const category = `v038-retired-${randomUUID().slice(0, 8)}`;
  const ward = await makeJurisdiction();
  const asOf = new Date();
  const survivor = await makeIssue({ category, jurisdictionId: ward });
  const duplicate = await makeIssue({ category, jurisdictionId: ward });
  await mergeInto(survivor, duplicate);
  await rebuildSummaries(client, { summaryName, asOf });

  const { rows } = await client.query(
    "select issue_id, retired_by_merge, root_issue_id from summary_issue_fact where summary_name = $1 and issue_id = any($2::uuid[]) order by retired_by_merge",
    [summaryName, [survivor, duplicate]],
  );
  assert.equal(rows.length, 2, "both issues keep a row; nothing disappears from the record");
  const retired = rows.find((row) => row["retired_by_merge"] === true);
  assert.equal(String(retired?.["issue_id"]), duplicate);
  assert.equal(String(retired?.["root_issue_id"]), survivor);

  assert.equal((await cellsFor(summaryName, category))[0]?.issueCount, 1);
});
