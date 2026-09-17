/**
 * V039 district dashboard read model against a real database.
 *
 * Run with: npm run db:up && npm run db:migrate && npm run test:db
 *
 * The acceptance clauses this file holds:
 *
 *   * **dashboard totals reconcile to the defined source population** — and
 *     when they do not, the payload says so with both figures rather than
 *     showing the prettier one;
 *   * **zero can be told from missing coverage** — a ward with a projected
 *     cell holding no reports and a ward with nothing projected produce
 *     different rows, not the same row;
 *   * **an indicator leads to its supporting records** — and stops exactly at
 *     the V015 boundary, so a private original is not in the payload at all.
 *
 * Each test builds its own jurisdiction, its own category and its own
 * projection namespace, so the counts below are exact rather than deltas
 * against the hundreds of rows earlier tasks left in the development database.
 */

import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

import {
  DashboardError,
  UNPLACED_KEY,
  readCellIssues,
  readDistrictDashboard,
  readIssueDetail,
} from "./dashboard.ts";
import { rebuildSummaries, reconcileSummaries } from "./summaries.ts";

const DATABASE_URL =
  process.env["DATABASE_URL"] ??
  "postgresql://vision:vision_local_dev_only@127.0.0.1:5432/vision_dev";

let client: pg.Client;
const createdIssues: string[] = [];
const createdJurisdictions: string[] = [];
const createdParticipants: string[] = [];
const createdSubmissions: string[] = [];
const createdEvidence: string[] = [];
const createdSummaries: string[] = [];

const newSummary = (): string => {
  const name = `v039-${randomUUID().slice(0, 12)}`;
  createdSummaries.push(name);
  return name;
};

const makeJurisdiction = async (): Promise<string> => {
  const id = randomUUID();
  await client.query(
    `insert into jurisdiction
       (jurisdiction_id, jurisdiction_profile_id, internal_code, directory_version,
        level_scheme, level_code, effective_from, synthetic_provenance)
     values ($1,'v039-profile',$2,'v039-directory.v1','v039-scheme','block',
             now() - interval '2 years', true)`,
    [id, `V39-${id.slice(0, 8)}`],
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
     values ($1,$2,$3,$4, now() - interval '20 days', $5)`,
    [
      id,
      `VIS-V039-${id.slice(0, 8)}`,
      options.category,
      options.status ?? "created",
      options.jurisdictionId ?? null,
    ],
  );
  createdIssues.push(id);
  return id;
};

const referenceOf = async (issueId: string): Promise<string> => {
  const { rows } = await client.query(
    "select public_reference from canonical_issue where issue_id = $1",
    [issueId],
  );
  return String(rows[0]?.["public_reference"]);
};

/** One evidence item linked to an issue, with whatever redaction state is wanted. */
const attachEvidence = async (
  issueId: string,
  options: {
    readonly mediaType: string;
    readonly derivative: string | null;
    readonly redactionStatus: string;
    readonly privacyState?: string;
  },
): Promise<void> => {
  const submissionId = randomUUID();
  const evidenceId = randomUUID();
  const participantId = randomUUID();
  await client.query("insert into participant (participant_id) values ($1)", [participantId]);
  createdParticipants.push(participantId);
  await client.query(
    `insert into submission
       (submission_id, participant_id, observed_at, interface_locale, locale_pack_version,
        idempotency_key, taxonomy_version, processing_status)
     values ($1,$2, now() - interval '19 days','en-IN','v039-locale.v1',$3,'v039-taxonomy.v1','accepted')`,
    [submissionId, participantId, `v039-${submissionId.slice(0, 8)}`],
  );
  createdSubmissions.push(submissionId);
  await client.query(
    `insert into evidence_item
       (evidence_id, submission_id, media_type, object_reference, content_text,
        fingerprint_hash, redaction_status, derivative_reference, privacy_state,
        processing_status)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'usable')`,
    [
      evidenceId,
      submissionId,
      options.mediaType,
      options.mediaType === "text" ? null : `originals/v039/${evidenceId}.bin`,
      options.mediaType === "text" ? "a description of the problem" : null,
      options.mediaType === "text" ? null : `sha256:${evidenceId.replace(/-/g, "")}`,
      options.redactionStatus,
      options.derivative,
      options.privacyState ?? "active",
    ],
  );
  createdEvidence.push(evidenceId);
  await client.query(
    `insert into issue_evidence_link
       (issue_evidence_link_id, evidence_id, canonical_issue_id, effective_from)
     values ($1,$2,$3, now() - interval '19 days')`,
    [randomUUID(), evidenceId, issueId],
  );
};

const TRACKED = ["water_supply", "sanitation"] as const;

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
    await client.query(
      "delete from issue_evidence_link where canonical_issue_id = any($1::uuid[])",
      [createdIssues],
    );
    await client.query(
      "delete from issue_participation where canonical_issue_id = any($1::uuid[])",
      [createdIssues],
    );
    await client.query("delete from canonical_issue where issue_id = any($1::uuid[])", [
      createdIssues,
    ]);
    createdIssues.length = 0;
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
  if (createdJurisdictions.length > 0) {
    await client.query("delete from jurisdiction where jurisdiction_id = any($1::uuid[])", [
      createdJurisdictions,
    ]);
    createdJurisdictions.length = 0;
  }
};

beforeEach(cleanup);

after(async () => {
  await cleanup();
  await client.end();
});

// ---------------------------------------------------------------------------
// Totals reconcile to a named population
// ---------------------------------------------------------------------------

test("totals reconcile to the source population, and the population is named", async () => {
  const summaryName = newSummary();
  const ward = await makeJurisdiction();
  const category = TRACKED[0];
  for (let index = 0; index < 5; index += 1) {
    await makeIssue({ category, jurisdictionId: ward });
  }
  await rebuildSummaries(client, { summaryName, asOf: new Date() });

  const dashboard = await readDistrictDashboard(client, {
    jurisdictionScope: [ward],
    trackedCategories: [...TRACKED],
    summaryName,
    asOf: new Date(),
  });

  // Reconciliation is a relation between two independently computed numbers,
  // not a constant: the projection is summed from the stored cells and the
  // population is counted live from the records. Asserting a literal here
  // would be testing the fixture rather than the property — the scope also
  // carries the district-wide bucket of reports nobody has placed in a ward,
  // which the definition string says out loud.
  assert.equal(dashboard.reconciliation.reconciles, true);
  assert.equal(dashboard.reconciliation.projectedTotal, dashboard.reconciliation.sourcePopulation);
  assert.match(
    dashboard.reconciliation.definition,
    /Active canonical roots/,
    "a total must say what it is a total of",
  );
  assert.match(dashboard.reconciliation.definition, /not yet placed in a ward/);

  const table = dashboard.cells.reduce((sum, cell) => sum + cell.issueCount, 0);
  assert.equal(table, dashboard.reconciliation.projectedTotal, "the table adds up to the headline");

  const mine = dashboard.cells.find(
    (cell) => cell.jurisdictionKey === ward && cell.category === category,
  );
  assert.equal(mine?.issueCount, 5, "and this ward holds exactly what was put in it");
});

test("a stale projection is reported as not reconciling, with both figures", async () => {
  const summaryName = newSummary();
  const ward = await makeJurisdiction();
  const category = TRACKED[0];
  await makeIssue({ category, jurisdictionId: ward });
  await rebuildSummaries(client, { summaryName, asOf: new Date() });

  // A report arrives and nothing reprojects it. This is the ordinary failure:
  // the dashboard is not wrong about what it holds, it is behind.
  await makeIssue({ category, jurisdictionId: ward });

  const dashboard = await readDistrictDashboard(client, {
    jurisdictionScope: [ward],
    trackedCategories: [...TRACKED],
    summaryName,
    asOf: new Date(),
  });

  assert.equal(dashboard.reconciliation.reconciles, false);
  assert.equal(
    dashboard.reconciliation.sourcePopulation - dashboard.reconciliation.projectedTotal,
    1,
    "exactly the one report that arrived after the projection ran",
  );
  assert.equal(dashboard.reconciliation.difference, -1);
  assert.match(dashboard.reconciliation.explanation, /should be quoted/);
});

test("a merged report is one report on both sides of the reconciliation", async () => {
  const summaryName = newSummary();
  const ward = await makeJurisdiction();
  const category = TRACKED[1];
  const survivor = await makeIssue({ category, jurisdictionId: ward });
  const duplicate = await makeIssue({ category, jurisdictionId: ward });

  const eventId = randomUUID();
  await client.query(
    `insert into status_event
       (event_id, aggregate_type, aggregate_id, aggregate_version, event_type,
        actor_type, correlation_id, occurred_at, payload_schema_version)
     values ($1,'canonical_issue',$2,9001,'issue_merged','reviewer',$3, now(),'1.0.0')`,
    [eventId, survivor, randomUUID()],
  );
  const mergeId = randomUUID();
  await client.query(
    `insert into issue_merge
       (merge_id, surviving_issue_id, merged_issue_id, merged_at, reason, decision_event_id)
     values ($1,$2,$3, now(), 'v039 fixture', $4)`,
    [mergeId, survivor, duplicate, eventId],
  );
  await client.query(
    `insert into issue_alias (alias_id, source_issue_id, target_issue_id, merge_id, valid_from)
     values ($1,$2,$3,$4, now() - interval '1 hour')`,
    [randomUUID(), duplicate, survivor, mergeId],
  );

  await rebuildSummaries(client, { summaryName, asOf: new Date() });
  const dashboard = await readDistrictDashboard(client, {
    jurisdictionScope: [ward],
    trackedCategories: [...TRACKED],
    summaryName,
    asOf: new Date(),
  });

  const mine = dashboard.cells.find(
    (cell) => cell.jurisdictionKey === ward && cell.category === category,
  );
  assert.equal(mine?.issueCount, 1, "two reports of one problem are one report");
  assert.equal(dashboard.reconciliation.reconciles, true);
  assert.equal(
    dashboard.reconciliation.projectedTotal,
    dashboard.reconciliation.sourcePopulation,
    "and both sides of the reconciliation resolved the merge the same way",
  );

  await client.query("delete from issue_alias where merge_id = $1", [mergeId]);
  await client.query("delete from issue_merge where merge_id = $1", [mergeId]);
  await client.query("delete from status_event where event_id = $1", [eventId]);
});

// ---------------------------------------------------------------------------
// Zero is not missing
// ---------------------------------------------------------------------------

test("a ward with nothing projected is no_data; a ward with no open reports is zero", async () => {
  const summaryName = newSummary();
  const withReports = await makeJurisdiction();
  const withoutReports = await makeJurisdiction();
  await makeIssue({ category: TRACKED[0], jurisdictionId: withReports });
  await rebuildSummaries(client, { summaryName, asOf: new Date() });

  const dashboard = await readDistrictDashboard(client, {
    jurisdictionScope: [withReports, withoutReports],
    trackedCategories: [...TRACKED],
    summaryName,
    asOf: new Date(),
  });

  const projected = dashboard.cells.find(
    (cell) => cell.jurisdictionKey === withReports && cell.category === TRACKED[0],
  );
  assert.equal(projected?.coverage, "projected");
  assert.equal(projected?.issueCount, 1);

  // The same ward, a tracked category nobody reported in.
  const emptyCategory = dashboard.cells.find(
    (cell) => cell.jurisdictionKey === withReports && cell.category === TRACKED[1],
  );
  assert.ok(
    emptyCategory?.coverage === "zero" || emptyCategory?.coverage === "no_data",
    "an empty slot is one of the two empty verdicts, never a report count",
  );
  assert.equal(emptyCategory?.issueCount, 0);

  // A whole ward with nothing projected still gets its rows.
  const emptyWard = dashboard.cells.filter((cell) => cell.jurisdictionKey === withoutReports);
  assert.equal(
    emptyWard.length,
    TRACKED.length,
    "an absent ward would read as a ward with no problems",
  );
  for (const cell of emptyWard) {
    assert.notEqual(cell.coverage, "projected");
    assert.equal(cell.issueCount, 0);
    assert.equal(cell.drillDownAvailable, false, "there is nothing behind it to open");
  }
  assert.equal(
    dashboard.cells.filter(
      (cell) =>
        (cell.jurisdictionKey === withReports || cell.jurisdictionKey === withoutReports) &&
        cell.coverage !== "projected",
    ).length,
    3,
    "one empty category in the reporting ward, and both in the silent one",
  );
});

test("the same empty slot is a zero when the projection is healthy and unknown when it is not", async () => {
  const summaryName = newSummary();
  const ward = await makeJurisdiction();
  await makeIssue({ category: TRACKED[0], jurisdictionId: ward });
  await rebuildSummaries(client, { summaryName, asOf: new Date() });
  await reconcileSummaries(client, { summaryName, asOf: new Date() });

  const healthy = await readDistrictDashboard(client, {
    jurisdictionScope: [ward],
    trackedCategories: [...TRACKED],
    summaryName,
    asOf: new Date(),
  });
  const healthyEmpty = healthy.cells.find(
    (cell) => cell.jurisdictionKey === ward && cell.category === TRACKED[1],
  );
  assert.equal(
    healthyEmpty?.coverage,
    "zero",
    "a projection that is fresh, reconciled and adds up has established that this slot is empty",
  );

  // A report arrives and nothing reprojects it. Nothing about the empty slot
  // changed — but what can be concluded from it did.
  await makeIssue({ category: TRACKED[0], jurisdictionId: ward });
  const stale = await readDistrictDashboard(client, {
    jurisdictionScope: [ward],
    trackedCategories: [...TRACKED],
    summaryName,
    asOf: new Date(),
  });
  const staleEmpty = stale.cells.find(
    (cell) => cell.jurisdictionKey === ward && cell.category === TRACKED[1],
  );
  assert.equal(
    staleEmpty?.coverage,
    "no_data",
    "a projection that disagrees with the records has established nothing about the slots it found empty",
  );
  assert.equal(stale.reconciliation.reconciles, false);
});

test("reports with no ward are counted in a visible bucket and cannot be opened", async () => {
  const summaryName = newSummary();
  const ward = await makeJurisdiction();
  await makeIssue({ category: TRACKED[0], jurisdictionId: ward });
  await makeIssue({ category: TRACKED[0] });
  await makeIssue({ category: TRACKED[0] });
  await rebuildSummaries(client, { summaryName, asOf: new Date() });

  const dashboard = await readDistrictDashboard(client, {
    jurisdictionScope: [ward],
    trackedCategories: [...TRACKED],
    summaryName,
    asOf: new Date(),
  });

  const unplaced = dashboard.cells.filter((cell) => cell.jurisdictionKey === UNPLACED_KEY);
  assert.ok(
    unplaced.length > 0,
    "the bucket is always present, so its absence is never mistaken for zero",
  );
  const counted = unplaced.reduce((sum, cell) => sum + cell.issueCount, 0);
  assert.ok(counted >= 2, "the count is shown");
  assert.ok(
    dashboard.coverage.unplacedIssues >= 2,
    "and is reported separately so a reader sees how much of the total is unplaceable",
  );
  for (const cell of unplaced) {
    assert.equal(cell.drillDownAvailable, false, "no jurisdiction grant covers these records");
  }

  await assert.rejects(
    () =>
      readCellIssues(client, {
        jurisdictionKey: UNPLACED_KEY,
        category: TRACKED[0],
        jurisdictionScope: [ward],
        asOf: new Date(),
        summaryName,
      }),
    (error: unknown) =>
      error instanceof DashboardError && /not been placed in a ward/.test(error.message),
  );
});

test("an untracked category is counted but never generates a no_data row", async () => {
  const summaryName = newSummary();
  const ward = await makeJurisdiction();
  const stray = `v039-untracked-${randomUUID().slice(0, 8)}`;
  await makeIssue({ category: stray, jurisdictionId: ward });
  await rebuildSummaries(client, { summaryName, asOf: new Date() });

  const dashboard = await readDistrictDashboard(client, {
    jurisdictionScope: [ward],
    trackedCategories: [...TRACKED],
    summaryName,
    asOf: new Date(),
  });

  const untracked = dashboard.cells.filter((cell) => cell.category === stray);
  assert.equal(untracked.length, 1, "one row where it exists, and none where it does not");
  assert.equal(untracked[0]?.tracked, false);
  assert.equal(untracked[0]?.issueCount, 1);
  assert.equal(
    dashboard.reconciliation.reconciles,
    true,
    "hiding it would have made the table stop adding up to the total above it",
  );
  assert.ok(dashboard.coverage.untrackedCategoryCells >= 1);
});

// ---------------------------------------------------------------------------
// From an indicator to its records, and no further
// ---------------------------------------------------------------------------

test("a figure leads to the records it counts", async () => {
  const summaryName = newSummary();
  const ward = await makeJurisdiction();
  const category = TRACKED[0];
  const claimed = await makeIssue({ category, jurisdictionId: ward, status: "resolution_claimed" });
  await makeIssue({ category, jurisdictionId: ward });
  await rebuildSummaries(client, { summaryName, asOf: new Date() });

  const issues = await readCellIssues(client, {
    jurisdictionKey: ward,
    category,
    jurisdictionScope: [ward],
    asOf: new Date(),
    summaryName,
  });
  assert.equal(issues.length, 2, "as many records as the cell counted");
  const claimedReference = await referenceOf(claimed);
  const claimedRow = issues.find((row) => row.publicReference === claimedReference);
  assert.notEqual(claimedRow, undefined);
  assert.equal(claimedRow?.state, "claimed");
  assert.ok((claimedRow?.ageHours ?? 0) > 400, "roughly twenty days");
});

test("a cell key edited in the browser cannot reach a ward with no grant", async () => {
  const mine = await makeJurisdiction();
  const somebodyElses = await makeJurisdiction();
  await makeIssue({ category: TRACKED[0], jurisdictionId: somebodyElses });

  await assert.rejects(
    () =>
      readCellIssues(client, {
        jurisdictionKey: somebodyElses,
        category: TRACKED[0],
        jurisdictionScope: [mine],
        asOf: new Date(),
      }),
    (error: unknown) => error instanceof DashboardError && /no grant/.test(error.message),
  );
});

test("evidence arrives as redacted copies, and the private original is not in the payload", async () => {
  const summaryName = newSummary();
  const ward = await makeJurisdiction();
  const issue = await makeIssue({ category: TRACKED[0], jurisdictionId: ward });
  await attachEvidence(issue, {
    mediaType: "photo",
    derivative: "derivatives/v039/approved.png",
    redactionStatus: "approved",
  });
  await attachEvidence(issue, {
    mediaType: "photo",
    derivative: null,
    redactionStatus: "needs_review",
  });
  await attachEvidence(issue, {
    mediaType: "text",
    derivative: null,
    redactionStatus: "not_required",
  });
  await rebuildSummaries(client, { summaryName, asOf: new Date() });

  const detail = await readIssueDetail(client, {
    publicReference: await referenceOf(issue),
    jurisdictionScope: [ward],
    asOf: new Date(),
    summaryName,
  });

  assert.equal(detail.evidence.length, 3);
  const availability = detail.evidence.map((item) => item.availability).sort();
  assert.deepEqual(availability, [
    "approved_derivative",
    "text_held_not_displayed",
    "withheld_pending_redaction",
  ]);

  const approved = detail.evidence.find((item) => item.availability === "approved_derivative");
  assert.equal(approved?.derivativeReference, "derivatives/v039/approved.png");

  // The structural guarantee: not "the original was filtered out", but that no
  // field in this payload could have carried it.
  const serialised = JSON.stringify(detail);
  assert.doesNotMatch(serialised, /originals\//, "a private original reached the payload");
  assert.doesNotMatch(serialised, /object_reference/i);
  assert.match(detail.evidenceNote, /Redacted copies only/);
});

test("a report in a ward this session has no grant for cannot be opened by reference", async () => {
  const mine = await makeJurisdiction();
  const somebodyElses = await makeJurisdiction();
  const issue = await makeIssue({ category: TRACKED[0], jurisdictionId: somebodyElses });
  const reference = await referenceOf(issue);

  await assert.rejects(
    () =>
      readIssueDetail(client, {
        publicReference: reference,
        jurisdictionScope: [mine],
        asOf: new Date(),
      }),
    (error: unknown) => error instanceof DashboardError && /no grant/.test(error.message),
  );
});

test("a dashboard with no authorized jurisdiction is refused rather than shown empty", async () => {
  await assert.rejects(
    () =>
      readDistrictDashboard(client, {
        jurisdictionScope: [],
        trackedCategories: [...TRACKED],
        asOf: new Date(),
      }),
    (error: unknown) => error instanceof DashboardError,
  );
  await assert.rejects(
    () =>
      readDistrictDashboard(client, {
        jurisdictionScope: [randomUUID()],
        trackedCategories: [],
        asOf: new Date(),
      }),
    (error: unknown) => error instanceof DashboardError && /taxonomy pack/.test(error.message),
  );
});
