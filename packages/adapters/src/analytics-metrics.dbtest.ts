/**
 * V037 metric semantics against a real database.
 *
 * Run with: npm run db:up && npm run db:migrate && npm run test:db
 *
 * Every scenario lives in its own year in the deep past, and every horizon is
 * bounded to that year. The development database holds hundreds of rows from
 * earlier tasks, all of them dated 2025 or later; anchoring each fixture in
 * 2001-2011 means `opened_at <= :as_of` excludes all of them, so these
 * assertions are exact counts rather than deltas against whatever else
 * happens to be present.
 *
 * The acceptance clauses this file holds:
 *
 *   * every metric has a reproducible formula and denominator — the statement
 *     is replayable and an empty denominator yields UNKNOWN, never 0;
 *   * resolved-only speed does not hide unresolved cases;
 *   * local distinct counts cannot be summed, shown by computing both the
 *     distinct count and the sum that a naive dashboard would print;
 *   * a late-recorded event does not leak backwards into a snapshot taken
 *     before this system had been told about it.
 */

import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

import { speedCoverage, speedStatement } from "@vision/domain";

import {
  AnalyticsError,
  acceptedCohort,
  backlogByDimension,
  computeMetricReport,
  currentBacklog,
  dataCoverage,
  disputedResolutions,
  estimatedPopulation,
  evidenceVolumes,
  fixedWindowResolutionRate,
  horizonMode,
  metricStatement,
  reopeningRate,
  standingConfirmed,
  standingResolutionRate,
  timeToResolution,
  unresolvedAge,
  uniqueContributors,
  type MetricParams,
} from "./analytics-metrics.ts";

const DATABASE_URL =
  process.env["DATABASE_URL"] ??
  "postgresql://vision:vision_local_dev_only@127.0.0.1:5432/vision_dev";

let client: pg.Client;
const createdIssues: string[] = [];
const createdParticipants: string[] = [];
const createdJurisdictions: string[] = [];
const eventVersions = new Map<string, number>();

/** A whole year, bounded so no other fixture in this database is in scope. */
const year = (
  y: number,
): { readonly params: MetricParams; readonly at: (month: number, day: number) => string } => ({
  params: {
    asOf: `${y}-12-31T00:00:00.000Z`,
    knowledgeCutoff: `${y}-12-31T00:00:00.000Z`,
    windowStart: `${y}-01-01T00:00:00.000Z`,
    windowEnd: `${y + 1}-01-01T00:00:00.000Z`,
    fixedWindowDays: 30,
  },
  at: (month, day) =>
    `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T00:00:00.000Z`,
});

const HISTORICAL = "historical" as const;

const makeJurisdiction = async (directoryVersion: string, from: string): Promise<string> => {
  const id = randomUUID();
  await client.query(
    `insert into jurisdiction
       (jurisdiction_id, jurisdiction_profile_id, internal_code, directory_version,
        level_scheme, level_code, effective_from, synthetic_provenance)
     values ($1,'v037-profile',$2,$3,'v037-scheme','block',$4,true)`,
    [id, `V37-${id.slice(0, 8)}`, directoryVersion, from],
  );
  createdJurisdictions.push(id);
  return id;
};

const makeIssue = async (options: {
  readonly openedAt: string;
  readonly status?: string;
  readonly jurisdictionId?: string | null;
  readonly category?: string;
}): Promise<string> => {
  const id = randomUUID();
  await client.query(
    `insert into canonical_issue
       (issue_id, public_reference, category, current_status, opened_at, jurisdiction_id)
     values ($1,$2,$3,$4,$5,$6)`,
    [
      id,
      `VIS-V037-${id.slice(0, 8)}`,
      options.category ?? "v037-category",
      options.status ?? "created",
      options.openedAt,
      options.jurisdictionId ?? null,
    ],
  );
  createdIssues.push(id);
  return id;
};

/**
 * Appends one issue event with both clocks set explicitly.
 *
 * `recordedAt` defaults to `occurredAt`, which is the ordinary case. Passing a
 * later value is how a backdated correction is simulated: it describes an
 * earlier moment but only became known later.
 */
const appendEvent = async (
  issueId: string,
  eventType: string,
  occurredAt: string,
  recordedAt?: string,
): Promise<string> => {
  const eventId = randomUUID();
  const version = (eventVersions.get(issueId) ?? 0) + 1;
  eventVersions.set(issueId, version);
  await client.query(
    `insert into status_event
       (event_id, aggregate_type, aggregate_id, aggregate_version, event_type,
        actor_type, correlation_id, occurred_at, recorded_at, payload_schema_version)
     values ($1,'canonical_issue',$2,$3,$4,'system_worker',$5,$6,$7,'1.0.0')`,
    [eventId, issueId, version, eventType, randomUUID(), occurredAt, recordedAt ?? occurredAt],
  );
  return eventId;
};

const makeParticipant = async (): Promise<string> => {
  const id = randomUUID();
  await client.query("insert into participant (participant_id) values ($1)", [id]);
  createdParticipants.push(id);
  return id;
};

const participate = async (
  participantId: string,
  issueId: string,
  at: string,
  counted = true,
): Promise<void> => {
  await client.query(
    `insert into issue_participation
       (participation_id, participant_id, canonical_issue_id, counted, non_counted_reason,
        first_evidence_at, last_evidence_at)
     values ($1,$2,$3,$4,$5,$6,$6)`,
    [randomUUID(), participantId, issueId, counted, counted ? null : "v037 fixture", at],
  );
};

/** Merges `merged` into `surviving`, creating the merge row the alias requires. */
const mergeInto = async (surviving: string, merged: string, at: string): Promise<void> => {
  const eventId = await appendEvent(surviving, "issue_merged", at);
  const mergeId = randomUUID();
  await client.query(
    `insert into issue_merge
       (merge_id, surviving_issue_id, merged_issue_id, merged_at, reason, decision_event_id)
     values ($1,$2,$3,$4,'v037 fixture',$5)`,
    [mergeId, surviving, merged, at, eventId],
  );
  await client.query(
    `insert into issue_alias (alias_id, source_issue_id, target_issue_id, merge_id, valid_from)
     values ($1,$2,$3,$4,$5)`,
    [randomUUID(), merged, surviving, mergeId, at],
  );
};

before(async () => {
  client = new pg.Client({ connectionString: DATABASE_URL, statement_timeout: 30_000 });
  await client.connect();
});

/**
 * Removes every row these tests created.
 *
 * Run before each test rather than once at the end, because the fixtures are
 * only isolated from the rest of the database by their dates — not from each
 * other. A scenario anchored in 2006 would otherwise see everything the 2001
 * to 2005 scenarios left behind, since all of it was opened before its
 * horizon, and the exact counts below would silently become approximate.
 */
const cleanup = async (): Promise<void> => {
  if (createdIssues.length > 0) {
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
// Alias folding, and the count that must not be summed
// ---------------------------------------------------------------------------

test("a merge unions contributors into one root and never adds the two totals", async () => {
  const { params, at } = year(2001);
  const surviving = await makeIssue({ openedAt: at(1, 5) });
  const merged = await makeIssue({ openedAt: at(1, 6) });
  const separate = await makeIssue({ openedAt: at(1, 7) });
  await mergeInto(surviving, merged, at(2, 1));

  const both = await makeParticipant();
  const onlyMerged = await makeParticipant();
  const onlySeparate = await makeParticipant();
  await participate(both, surviving, at(1, 5));
  await participate(both, merged, at(1, 6));
  await participate(both, separate, at(1, 7));
  await participate(onlyMerged, merged, at(1, 6));
  await participate(onlySeparate, separate, at(1, 7));
  // Recorded but not counted, and therefore never in the headline number.
  await participate(await makeParticipant(), separate, at(1, 8), false);

  const backlog = await currentBacklog(client, params, HISTORICAL);
  assert.equal(backlog.measure.value, 0, "no ledger events yet, so every status is UNKNOWN");
  assert.equal(backlog.unknownRows, 2, "two active roots, both unclassifiable from the ledger");

  const contributors = await uniqueContributors(client, params, HISTORICAL);
  assert.equal(contributors.distinctInScope, 3, "three distinct people across the whole scope");
  assert.equal(
    contributors.sumOfPerRoot,
    4,
    "adding the per-issue counts would say four, because one person reported both",
  );
  assert.ok(
    contributors.sumOfPerRoot > contributors.distinctInScope,
    "the gap between these two numbers is exactly the double-count this metric refuses",
  );
  assert.equal(contributors.notCountedRows, 1);
});

test("a merge cycle resolves to nothing and is excluded rather than guessed at", async () => {
  const { params, at } = year(2004);
  const a = await makeIssue({ openedAt: at(1, 1) });
  const b = await makeIssue({ openedAt: at(1, 2) });
  const control = await makeIssue({ openedAt: at(1, 3) });
  await appendEvent(control, "resolution_claimed", at(3, 1));
  await mergeInto(a, b, at(2, 1));
  await mergeInto(b, a, at(2, 2));

  // The query terminates rather than looping, which is the first thing a cycle
  // must not be allowed to break.
  const backlog = await currentBacklog(client, params, HISTORICAL);
  assert.equal(backlog.measure.value, 1, "only the control issue remains countable");
  assert.equal(backlog.unknownRows, 0);

  const cohort = await acceptedCohort(client, params, HISTORICAL);
  assert.equal(cohort.measure.value, 1, "the two issues in the cycle are in no cohort either");
});

test("data beyond the hop limit fails safely out of the fold rather than being guessed", async () => {
  const { params, at } = year(2005);
  // 19 issues, each merged into the next, so longChain[18] is the root and
  // longChain[0] sits 18 hops away — past MAX_ALIAS_HOPS.
  const longChain: string[] = [];
  for (let index = 0; index <= 18; index += 1) {
    longChain.push(await makeIssue({ openedAt: at(1, 1) }));
  }
  for (let index = 0; index < 18; index += 1) {
    const source = longChain[index];
    const target = longChain[index + 1];
    if (source !== undefined && target !== undefined) await mergeInto(target, source, at(2, 1));
  }
  const root = longChain[18] as string;
  await appendEvent(root, "resolution_claimed", at(3, 1));

  const tooDeep = await makeParticipant();
  const withinReach = await makeParticipant();
  await participate(tooDeep, longChain[0] as string, at(1, 1));
  await participate(withinReach, longChain[5] as string, at(1, 1));

  const backlog = await currentBacklog(client, params, HISTORICAL);
  assert.equal(backlog.measure.value, 1, "one root, not nineteen separate pieces of work");

  const contributors = await uniqueContributors(client, params, HISTORICAL);
  assert.equal(
    contributors.distinctInScope,
    1,
    "the participant 18 hops away is left out; an undercount that can be found is recoverable, a confidently wrong root is not",
  );
});

// ---------------------------------------------------------------------------
// Two clocks
// ---------------------------------------------------------------------------

test("a late-recorded event does not leak into a snapshot taken before it arrived", async () => {
  const { params, at } = year(2002);
  const issue = await makeIssue({ openedAt: at(1, 1) });
  await appendEvent(issue, "resolution_claimed", at(1, 5));
  // Describes 10 January; this system was only told about it on 1 June.
  await appendEvent(issue, "resolution_confirmed", at(1, 10), at(6, 1));

  const beforeItArrived: MetricParams = { ...params, knowledgeCutoff: at(3, 1) };
  const afterItArrived: MetricParams = { ...params, knowledgeCutoff: at(12, 31) };

  const early = await standingConfirmed(client, beforeItArrived, HISTORICAL);
  const late = await standingConfirmed(client, afterItArrived, HISTORICAL);

  assert.equal(early.measure.value, 0, "the confirmation had not been recorded by 1 March");
  assert.equal(late.measure.value, 1, "the same event at the same event-time, once known");

  const earlyBacklog = await currentBacklog(client, beforeItArrived, HISTORICAL);
  assert.equal(earlyBacklog.measure.value, 1, "at knowledge-time the issue was still open");
});

test("a past horizon never shows a state the issue only reached later", async () => {
  const { params, at } = year(2003);
  const issue = await makeIssue({ openedAt: at(1, 1), status: "resolution_confirmed" });
  await appendEvent(issue, "resolution_claimed", at(2, 1));
  await appendEvent(issue, "resolution_confirmed", at(6, 1));

  const march: MetricParams = { ...params, asOf: at(3, 1), knowledgeCutoff: at(3, 1) };
  const september: MetricParams = { ...params, asOf: at(9, 1), knowledgeCutoff: at(9, 1) };

  assert.equal((await standingConfirmed(client, march, HISTORICAL)).measure.value, 0);
  assert.equal((await currentBacklog(client, march, HISTORICAL)).measure.value, 1);
  assert.equal((await standingConfirmed(client, september, HISTORICAL)).measure.value, 1);
  assert.equal((await currentBacklog(client, september, HISTORICAL)).measure.value, 0);
});

test("a creation event is enough to establish the opened state at a past horizon", async () => {
  // Nothing appended an event when an issue was opened, so every issue that
  // had not yet been routed was UNKNOWN at every past horizon — which is to
  // say the whole backlog was. The creation event is what makes `created`
  // readable from the ledger rather than only from today's column.
  const { params, at } = year(2010);
  const issue = await makeIssue({ openedAt: at(1, 1) });
  await appendEvent(issue, "issue_created", at(1, 1));

  const backlog = await currentBacklog(client, params, HISTORICAL);
  assert.equal(backlog.measure.value, 1, "an opened, unrouted issue is backlog");
  assert.equal(backlog.unknownRows, 0, "the ledger establishes this one");

  const coverage = await dataCoverage(client, params, HISTORICAL);
  assert.equal(coverage.counts.statusUnknown, 0);

  // ...and it stops being the answer as soon as a later event supersedes it.
  await appendEvent(issue, "routed_internal", at(2, 1));
  const later = await currentBacklog(client, { ...params, asOf: at(3, 1) }, HISTORICAL);
  assert.equal(later.measure.value, 1);
  assert.equal(later.unknownRows, 0);

  // Before the issue was opened it is in no cohort and no count at all.
  const beforeItExisted: MetricParams = {
    ...params,
    asOf: `2009-12-31T00:00:00.000Z`,
    knowledgeCutoff: `2009-12-31T00:00:00.000Z`,
  };
  assert.equal((await currentBacklog(client, beforeItExisted, HISTORICAL)).measure.value, 0);
});

test("a status with no ledger behind it reads UNKNOWN historically, not today's value", async () => {
  const { params, at } = year(2011);
  await makeIssue({ openedAt: at(1, 1), status: "resolution_confirmed" });

  const confirmed = await standingConfirmed(client, params, HISTORICAL);
  assert.equal(
    confirmed.measure.value,
    0,
    "the stored column is today's answer and says nothing about this horizon",
  );
  assert.equal(confirmed.unknownRows, 1, "reported as unclassifiable, not silently dropped");

  const coverage = await dataCoverage(client, params, HISTORICAL);
  assert.equal(coverage.counts.rows, 1);
  assert.equal(coverage.counts.statusUnknown, 1);
  assert.equal(coverage.statusCoverage.value, 100);
  assert.equal(coverage.counts.anyDimensionUnknown, 1);
  assert.equal(coverage.incomplete.value, 100);
  assert.equal(
    coverage.counts.categoryUnknown,
    1,
    "category is corrected in place with no history, so it is UNKNOWN at any past horizon",
  );
});

test("the live horizon is a separate mode, and the report records which one produced it", async () => {
  const now = Date.now();
  const live: MetricParams = {
    asOf: new Date(now).toISOString(),
    knowledgeCutoff: new Date(now).toISOString(),
    windowStart: new Date(now - 86_400_000).toISOString(),
    windowEnd: new Date(now + 86_400_000).toISOString(),
    fixedWindowDays: 30,
  };
  assert.equal(horizonMode(live, now), "live");
  assert.equal(horizonMode(year(2003).params, now), "historical");

  const report = await computeMetricReport(client, live, now);
  assert.equal(report.mode, "live");
  assert.equal(report.readings.length, 15, "all fifteen metrics, every time");
});

// ---------------------------------------------------------------------------
// Fixed windows and denominators
// ---------------------------------------------------------------------------

test("a reopening inside the fixed window invalidates it; one outside does not", async () => {
  const { params, at } = year(2006);
  const held = await makeIssue({ openedAt: at(1, 1) });
  await appendEvent(held, "resolution_confirmed", at(1, 6));

  const failedInside = await makeIssue({ openedAt: at(1, 1) });
  await appendEvent(failedInside, "resolution_confirmed", at(1, 6));
  await appendEvent(failedInside, "issue_reopened", at(1, 11));

  const failedLater = await makeIssue({ openedAt: at(1, 1) });
  await appendEvent(failedLater, "resolution_confirmed", at(1, 6));
  await appendEvent(failedLater, "issue_reopened", at(8, 1));

  const neverConfirmed = await makeIssue({ openedAt: at(1, 1) });
  // Opened eleven days before the horizon: its 30-day window has not closed.
  const tooYoung = await makeIssue({ openedAt: at(12, 20) });

  const fixed = await fixedWindowResolutionRate(client, params, HISTORICAL);
  assert.equal(
    fixed.measure.value,
    50,
    "two of the four fully observed issues held for thirty days",
  );

  const cohort = await acceptedCohort(client, params, HISTORICAL);
  assert.equal(cohort.measure.value, 5, "the young issue is in the cohort");
  assert.ok(tooYoung.length > 0 && neverConfirmed.length > 0);

  // ... and in neither side of the fixed-window rate, which is what stops the
  // figure falling every time reporting picks up.
  const { rows } = await client.query(metricStatement("M05"), [
    params.asOf,
    params.knowledgeCutoff,
    false,
    params.windowStart,
    params.windowEnd,
    params.fixedWindowDays,
  ]);
  assert.equal(Number(rows[0]?.["denominator"]), 4);
});

test("an empty population yields UNKNOWN for every rate, never zero percent", async () => {
  const { params } = year(2007);

  const cohort = await acceptedCohort(client, params, HISTORICAL);
  assert.equal(cohort.measure.value, 0, "the cohort is genuinely empty");

  for (const reading of [
    await standingResolutionRate(client, params, HISTORICAL),
    await fixedWindowResolutionRate(client, params, HISTORICAL),
    await reopeningRate(client, params, HISTORICAL),
  ]) {
    assert.equal(reading.measure.value, null, `${reading.id} must not report 0%`);
    assert.equal(reading.measure.unknownReason, "empty_denominator");
  }

  const age = await unresolvedAge(client, params, HISTORICAL);
  assert.equal(age.reading.measure.value, null, "an empty backlog has no age, not an age of zero");
  assert.equal(age.maxHours.value, null);
  assert.equal(age.backlogSize, 0);
});

test("the reopening rate is measured against issues that were confirmed, not all issues", async () => {
  const { params, at } = year(2010);
  for (let index = 0; index < 4; index += 1) {
    const issue = await makeIssue({ openedAt: at(1, 1) });
    await appendEvent(issue, "resolution_confirmed", at(2, 1));
    if (index === 0) await appendEvent(issue, "issue_reopened", at(3, 1));
  }
  // Never confirmed, so it could never have been reopened and is not evidence
  // either way about how often repairs hold.
  await makeIssue({ openedAt: at(1, 1) });

  const rate = await reopeningRate(client, params, HISTORICAL);
  assert.equal(rate.measure.value, 25, "one in four confirmed issues was reopened");

  const cohort = await acceptedCohort(client, params, HISTORICAL);
  assert.equal(cohort.measure.value, 5, "the denominator is not the cohort size");
});

// ---------------------------------------------------------------------------
// Speed never travels alone
// ---------------------------------------------------------------------------

test("a fast figure measured over one issue in ten arrives with the nine still waiting", async () => {
  const { params, at } = year(2008);
  const fast = await makeIssue({ openedAt: `${2008}-01-01T00:00:00.000Z` });
  await appendEvent(fast, "resolution_confirmed", `${2008}-01-01T02:00:00.000Z`);
  for (let index = 0; index < 9; index += 1) {
    await makeIssue({ openedAt: at(1, 1) });
  }

  const speed = await timeToResolution(client, params, HISTORICAL);
  assert.equal(speed.resolvedCount, 1);
  assert.equal(speed.stillWaitingCount, 9);
  assert.equal(speed.firstConfirmationHoursMedian, 2);

  const statement = speedStatement(speed);
  assert.match(statement, /2 hours/);
  assert.match(
    statement,
    /9 issues in this group are still waiting/,
    "the flattering number cannot be rendered without the nine it excludes",
  );
  assert.equal(speedCoverage(speed).value, 10);
});

test("standing-resolution time subtracts the interval an issue spent reopened", async () => {
  const { params, at } = year(2009);
  const issue = await makeIssue({ openedAt: `2009-01-01T00:00:00.000Z` });
  await appendEvent(issue, "resolution_confirmed", `2009-01-01T10:00:00.000Z`);
  await appendEvent(issue, "issue_reopened", `2009-01-01T12:00:00.000Z`);
  await appendEvent(issue, "resolution_confirmed", `2009-01-02T12:00:00.000Z`);
  assert.ok(at(1, 1).startsWith("2009"));

  const speed = await timeToResolution(client, params, HISTORICAL);
  assert.equal(speed.firstConfirmationHoursMedian, 10, "first confirmation is still ten hours");
  assert.equal(
    speed.standingResolutionHoursMedian,
    12,
    "36 hours to the confirmation that stands, less the 24 it spent reopened",
  );
  assert.equal(speed.reopeningCycleHoursMedian, 2, "two hours from confirmation to reopening");
});

// ---------------------------------------------------------------------------
// Population, coverage, and what the report refuses
// ---------------------------------------------------------------------------

test("population is UNKNOWN for every boundary and never falls back to zero", async () => {
  const jurisdictionId = await makeJurisdiction("v037-directory.v1", "2000-01-01T00:00:00.000Z");
  const { params } = year(2012);

  const rows = await estimatedPopulation(client, params, HISTORICAL);
  const mine = rows.find((row) => row.jurisdictionId === jurisdictionId);
  assert.ok(mine !== undefined, "boundaries are listed so uncovered areas are visible");
  assert.equal(mine.population.value, null);
  assert.equal(mine.population.unknownReason, "no_population_source");
  assert.equal(mine.source, null);
  assert.equal(mine.boundaryVersion, "v037-directory.v1");
  for (const row of rows) {
    assert.notEqual(row.population.value, 0, "zero people is a claim; UNKNOWN is the truth here");
  }
});

test("a missing jurisdiction is reported as unknown coverage, not folded into another area", async () => {
  const jurisdictionId = await makeJurisdiction("v037-directory.v2", "2000-01-01T00:00:00.000Z");
  const { params, at } = year(2013);
  const placed = await makeIssue({ openedAt: at(1, 1), jurisdictionId, category: "v037-placed" });
  await appendEvent(placed, "resolution_claimed", at(2, 1));
  const unplacedOne = await makeIssue({ openedAt: at(1, 2), category: "v037-unplaced" });
  await appendEvent(unplacedOne, "resolution_claimed", at(2, 1));
  const unplacedTwo = await makeIssue({ openedAt: at(1, 3), category: "v037-unplaced" });
  await appendEvent(unplacedTwo, "resolution_claimed", at(2, 1));

  const coverage = await dataCoverage(client, params, HISTORICAL);
  assert.equal(coverage.counts.rows, 3);
  assert.equal(
    coverage.counts.jurisdictionUnknown,
    3,
    "jurisdiction has no effective-dated history either, so a past horizon cannot place any of them",
  );

  const groups = await backlogByDimension(client, params, HISTORICAL);
  assert.equal(groups.length, 1, "every group is UNKNOWN at a past horizon");
  assert.equal(groups[0]?.category, null);
  assert.equal(groups[0]?.jurisdictionId, null);
  assert.equal(groups[0]?.value, 3);
});

test("evidence volumes are separated and never stand in for how many people reported", async () => {
  const { params, at } = year(2014);
  const issue = await makeIssue({ openedAt: at(1, 1) });
  await appendEvent(issue, "resolution_claimed", at(2, 1));
  const volumes = await evidenceVolumes(client, params, HISTORICAL);
  assert.equal(volumes.submissions, 0);
  assert.equal(volumes.activeLinks, 0);
  assert.equal(volumes.historicalLinks, 0);
  assert.equal(volumes.completionEvidence, 0);

  const contributors = await uniqueContributors(client, params, HISTORICAL);
  assert.equal(
    contributors.distinctInScope,
    0,
    "no evidence, no contributors, and no substitution",
  );
});

test("disputes are counted as disputes and are not resolutions", async () => {
  const { params, at } = year(2015);
  const disputed = await makeIssue({ openedAt: at(1, 1) });
  await appendEvent(disputed, "resolution_claimed", at(2, 1));
  await appendEvent(disputed, "resolution_disputed", at(3, 1));

  assert.equal((await disputedResolutions(client, params, HISTORICAL)).measure.value, 1);
  assert.equal((await standingConfirmed(client, params, HISTORICAL)).measure.value, 0);
  assert.equal(
    (await currentBacklog(client, params, HISTORICAL)).measure.value,
    1,
    "a disputed claim is open work, not closed work",
  );
});

test("the report refuses a window that is not half-open and forward-running", async () => {
  const now = Date.now();
  const params = year(2016).params;
  await assert.rejects(
    () => computeMetricReport(client, { ...params, windowEnd: params.windowStart }, now),
    (error: unknown) => error instanceof AnalyticsError,
  );
  await assert.rejects(
    () => computeMetricReport(client, { ...params, fixedWindowDays: 0 }, now),
    (error: unknown) => error instanceof AnalyticsError,
  );
});

test("every metric statement is replayable on its own with the same six bindings", async () => {
  const { params } = year(2001);
  for (const id of [
    "M01",
    "M02",
    "M03",
    "M04",
    "M05",
    "M06",
    "M07",
    "M08",
    "M09",
    "M10",
    "M11",
    "M12",
    "M13",
    "M14",
    "M15",
  ] as const) {
    const first = await client.query(metricStatement(id), [
      params.asOf,
      params.knowledgeCutoff,
      false,
      params.windowStart,
      params.windowEnd,
      params.fixedWindowDays,
    ]);
    const second = await client.query(metricStatement(id), [
      params.asOf,
      params.knowledgeCutoff,
      false,
      params.windowStart,
      params.windowEnd,
      params.fixedWindowDays,
    ]);
    assert.deepEqual(second.rows, first.rows, `${id} must be reproducible`);
  }
});
