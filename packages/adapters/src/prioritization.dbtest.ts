/**
 * V042 prioritization inputs against a real database.
 *
 * Run with: npm run db:up && npm run db:migrate && npm run test:db
 *
 * The policy itself is pure and is covered by `prioritization.test.ts`. What
 * only becomes true against real rows is held here: that a ward with no
 * population figure arrives as `null` rather than zero, that a report count
 * without a denominator is withheld rather than treated as a rate, that the
 * V041 distinction between "searched and found nothing" and "nobody has
 * looked" survives into the factor, and that a lower-reporting ward can reach
 * the top of the ordering for reasons somebody can read.
 */

import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

import { priorityOverclaims, orderingText, type RecommendationPolicy } from "@vision/domain";

import { PrioritizationInputError, gatherCandidates, orderCandidates } from "./prioritization.ts";

const DATABASE_URL =
  process.env["DATABASE_URL"] ??
  "postgresql://vision:vision_local_dev_only@127.0.0.1:5432/vision_dev";

const PROFILE = `v042-profile-${randomUUID().slice(0, 8)}`;

const POLICY: RecommendationPolicy = {
  version: "v042-test.v1",
  weightings: [
    {
      id: "equity-led",
      label: "Equity-led",
      rationale: "wards that report less are treated as under-served",
      weights: {
        reporting_equity: 0.4,
        persistence: 0.25,
        service_population: 0.15,
        alternatives: 0.1,
        existing_project: 0.1,
      },
    },
    {
      id: "waiting-led",
      label: "Waiting-led",
      rationale: "how long people have waited is the strongest claim",
      weights: {
        persistence: 0.5,
        reporting_equity: 0.15,
        service_population: 0.15,
        alternatives: 0.1,
        existing_project: 0.1,
      },
    },
  ],
  references: {
    persistenceReferenceDays: 120,
    persistencePerReopening: 0.25,
    populationReferenceCount: 20000,
    equityReferenceRatePer1000: 8,
    alternativesReferenceCount: 3,
  },
  existingProjectDirection: "deprioritise",
  existingProjectRationale: "a confirmed project suggests the work is already planned",
  minimumFactorsForRanking: 2,
  budgetAssumption: "No budget or cost information is used anywhere in this ordering.",
  note: "An ordering of reports by configured factors, not a finding about need.",
};

let client: pg.Client;
let quietWard: string;
let loudWard: string;
let unmeasuredWard: string;
const createdJurisdictions: string[] = [];
const createdIssues: string[] = [];
const createdDatasets: string[] = [];
const createdSources: string[] = [];

const makeJurisdiction = async (code: string): Promise<string> => {
  const id = randomUUID();
  await client.query(
    `insert into jurisdiction
       (jurisdiction_id, jurisdiction_profile_id, internal_code, directory_version,
        level_scheme, level_code, effective_from, synthetic_provenance)
     values ($1,$2,$3,'v042-directory.v1','v042-scheme','block',
             now() - interval '2 years', true)`,
    [id, PROFILE, code],
  );
  createdJurisdictions.push(id);
  return id;
};

const setPopulation = async (jurisdictionId: string, residents: number): Promise<void> => {
  const sourceId = randomUUID();
  const datasetId = `v042-pop-${randomUUID().slice(0, 8)}`;
  createdSources.push(sourceId);
  createdDatasets.push(datasetId);
  await client.query(
    `insert into source_record
       (source_record_id, source_name, source_url_or_location, retrieved_at,
        licence_or_permission_status, demo_status)
     values ($1,'v042 synthetic context','fixture', now(),'synthetic','team_created_synthetic')`,
    [sourceId],
  );
  await client.query(
    `insert into context_dataset
       (dataset_id, kind, unit, label, source_record_id, synthetic_provenance,
        max_age_days, jurisdiction_profile_id)
     values ($1,'population','persons','Population (synthetic)',$2,true,400,$3)`,
    [datasetId, sourceId, PROFILE],
  );
  await client.query(
    `insert into context_observation
       (observation_id, dataset_id, subject_kind, jurisdiction_id, value, unit, vintage)
     values ($1,$2,'jurisdiction',$3,$4,'persons', now() - interval '30 days')`,
    [randomUUID(), datasetId, jurisdictionId, residents],
  );
};

const makeIssue = async (options: {
  readonly jurisdictionId: string;
  readonly openDays: number;
  readonly status?: string;
  readonly reference?: string;
}): Promise<string> => {
  const id = randomUUID();
  await client.query(
    `insert into canonical_issue
       (issue_id, public_reference, category, current_status, opened_at, jurisdiction_id,
        representative_location)
     values ($1,$2,'water_supply',$3, now() - make_interval(days => $4), $5,
             st_setsrid(st_makepoint(78.5, 20.5),4326)::geography)`,
    [
      id,
      options.reference ?? `VIS-V042-${id.slice(0, 8)}`,
      options.status ?? "work_planned",
      options.openDays,
      options.jurisdictionId,
    ],
  );
  createdIssues.push(id);
  return id;
};

const gather = () =>
  gatherCandidates(client, {
    jurisdictionIds: [quietWard, loudWard, unmeasuredWard],
    asOf: new Date(),
  });

const order = () =>
  orderCandidates(client, {
    jurisdictionIds: [quietWard, loudWard, unmeasuredWard],
    asOf: new Date(),
    policy: POLICY,
  });

before(async () => {
  client = new pg.Client({ connectionString: DATABASE_URL, statement_timeout: 60_000 });
  await client.connect();
  quietWard = await makeJurisdiction("V042-QUIET");
  loudWard = await makeJurisdiction("V042-LOUD");
  unmeasuredWard = await makeJurisdiction("V042-UNMEASURED");
});

const cleanup = async (): Promise<void> => {
  if (createdIssues.length > 0) {
    await client.query("delete from project_link where issue_id = any($1::uuid[])", [
      createdIssues,
    ]);
    await client.query("delete from reopening where issue_id = any($1::uuid[])", [createdIssues]);
    await client.query("delete from issue_alias where source_issue_id = any($1::uuid[])", [
      createdIssues,
    ]);
    await client.query("delete from summary_issue_fact where issue_id = any($1::uuid[])", [
      createdIssues,
    ]);
    await client.query("delete from canonical_issue where issue_id = any($1::uuid[])", [
      createdIssues,
    ]);
    createdIssues.length = 0;
  }
  if (createdDatasets.length > 0) {
    await client.query("delete from context_observation where dataset_id = any($1::text[])", [
      createdDatasets,
    ]);
    await client.query("delete from context_dataset where dataset_id = any($1::text[])", [
      createdDatasets,
    ]);
    createdDatasets.length = 0;
  }
  if (createdSources.length > 0) {
    await client.query("delete from source_record where source_record_id = any($1::uuid[])", [
      createdSources,
    ]);
    createdSources.length = 0;
  }
};

beforeEach(cleanup);

after(async () => {
  await cleanup();
  if (createdJurisdictions.length > 0) {
    await client.query("delete from jurisdiction where jurisdiction_id = any($1::uuid[])", [
      createdJurisdictions,
    ]);
  }
  await client.end();
});

// ---------------------------------------------------------------------------
// Missing data arrives as missing
// ---------------------------------------------------------------------------

test("a ward with no population figure arrives as null, never as zero residents", async () => {
  await setPopulation(quietWard, 18000);
  await makeIssue({ jurisdictionId: quietWard, openDays: 40 });
  await makeIssue({ jurisdictionId: unmeasuredWard, openDays: 40 });

  const candidates = await gather();
  const measured = candidates.find((candidate) => candidate.jurisdictionKey === quietWard);
  const unmeasured = candidates.find((candidate) => candidate.jurisdictionKey === unmeasuredWard);

  assert.equal(measured?.servicePopulation, 18000);
  assert.equal(unmeasured?.servicePopulation, null, "zero would read as nobody living there");
});

test("a report count with no denominator is withheld rather than treated as a rate", async () => {
  await makeIssue({ jurisdictionId: unmeasuredWard, openDays: 10 });
  await makeIssue({ jurisdictionId: unmeasuredWard, openDays: 20 });

  const candidates = await gather();
  const unmeasured = candidates.find((candidate) => candidate.jurisdictionKey === unmeasuredWard);
  assert.equal(
    unmeasured?.wardReportCount,
    null,
    "a volume presented as a rate is how a large ward looks like a troubled one",
  );
});

test("a missing population redistributes weight instead of sinking the ward", async () => {
  await setPopulation(loudWard, 4000);
  await makeIssue({ jurisdictionId: loudWard, openDays: 10 });
  const long = await makeIssue({ jurisdictionId: unmeasuredWard, openDays: 200 });

  const result = await order();
  const unmeasured = result.ordering.placements.find((placement) => placement.candidateId === long);
  const population = unmeasured?.factors.find((factor) => factor.factor === "service_population");
  assert.equal(population?.contribution, null);
  assert.equal(population?.appliedWeight, 0);
  assert.equal(
    unmeasured?.bestRank,
    1,
    "the long-open report still leads on the factors it does have",
  );

  // The surviving factors carry the whole weight between them, so the ward is
  // not penalised for the figures nobody collected there.
  const applied = (unmeasured?.factors ?? [])
    .filter((factor) => factor.contribution !== null)
    .reduce((total, factor) => total + factor.appliedWeight, 0);
  assert.equal(Math.round(applied * 100) / 100, 1);
});

// ---------------------------------------------------------------------------
// A lower-reporting ward can rank, for readable reasons
// ---------------------------------------------------------------------------

test("a quiet populous ward outranks a loud small one, and the reason is readable", async () => {
  await setPopulation(quietWard, 18000);
  await setPopulation(loudWard, 3000);
  const quiet = await makeIssue({
    jurisdictionId: quietWard,
    openDays: 60,
    reference: "VIS-V042-QUIET",
  });
  // Thirty reports in a ward of three thousand: ten per thousand, above the
  // reference. One report in a ward of eighteen thousand is far below it.
  for (let index = 0; index < 30; index += 1) {
    await makeIssue({ jurisdictionId: loudWard, openDays: 60 });
  }

  const result = await order();
  const quietPlacement = result.ordering.placements.find(
    (placement) => placement.candidateId === quiet,
  );
  assert.equal(quietPlacement?.bestRank, 1);

  const equity = quietPlacement?.factors.find((factor) => factor.factor === "reporting_equity");
  assert.equal(equity?.status, "available");
  assert.match(equity?.explanation ?? "", /per 1000 residents/);
  assert.match(equity?.explanation ?? "", /low reporting is not evidence of low need/);
});

// ---------------------------------------------------------------------------
// Sensitivity, on real rows
// ---------------------------------------------------------------------------

test("two plausible weightings disagree, and the disagreement is published", async () => {
  await setPopulation(quietWard, 18000);
  await setPopulation(loudWard, 3000);
  // Quiet ward, brand new report. Loud ward, very old report. Equity and
  // waiting point in opposite directions.
  const quietNew = await makeIssue({ jurisdictionId: quietWard, openDays: 1 });
  const loudOld = await makeIssue({ jurisdictionId: loudWard, openDays: 300 });
  for (let index = 0; index < 30; index += 1) {
    await makeIssue({ jurisdictionId: loudWard, openDays: 5 });
  }

  const result = await order();
  const quiet = result.ordering.placements.find((placement) => placement.candidateId === quietNew);
  const loud = result.ordering.placements.find((placement) => placement.candidateId === loudOld);

  assert.notEqual(quiet?.bestRank, quiet?.worstRank, "the weightings must actually disagree");
  assert.notEqual(loud?.bestRank, loud?.worstRank);
  assert.equal(
    quiet?.underWeighting.length,
    2,
    "a position under each weighting, so a reader can see which one produced what",
  );
  assert.ok(["sensitive", "unstable"].includes(quiet?.stability ?? ""));
});

// ---------------------------------------------------------------------------
// What is and is not a candidate
// ---------------------------------------------------------------------------

test("a standing confirmed report and a merged-away one are not candidates", async () => {
  await setPopulation(quietWard, 18000);
  const open = await makeIssue({ jurisdictionId: quietWard, openDays: 30 });
  await makeIssue({ jurisdictionId: quietWard, openDays: 30, status: "resolution_confirmed" });
  const merged = await makeIssue({ jurisdictionId: quietWard, openDays: 30 });

  const eventId = randomUUID();
  await client.query(
    `insert into status_event
       (event_id, aggregate_type, aggregate_id, aggregate_version, event_type,
        actor_type, correlation_id, occurred_at, payload_schema_version)
     values ($1,'canonical_issue',$2,9042,'issue_merged','reviewer',$3, now(),'1.0.0')`,
    [eventId, open, randomUUID()],
  );
  const mergeId = randomUUID();
  await client.query(
    `insert into issue_merge
       (merge_id, surviving_issue_id, merged_issue_id, merged_at, reason, decision_event_id)
     values ($1,$2,$3, now(),'v042 fixture',$4)`,
    [mergeId, open, merged, eventId],
  );
  await client.query(
    `insert into issue_alias (alias_id, source_issue_id, target_issue_id, merge_id, valid_from)
     values ($1,$2,$3,$4, now() - interval '1 hour')`,
    [randomUUID(), merged, open, mergeId],
  );

  const candidates = await gather();
  assert.deepEqual(
    candidates.map((candidate) => candidate.candidateId),
    [open],
    "a fixed report is not waiting, and a merged one is the same report twice",
  );

  await client.query("delete from issue_alias where merge_id = $1", [mergeId]);
  await client.query("delete from issue_merge where merge_id = $1", [mergeId]);
  await client.query("delete from status_event where event_id = $1", [eventId]);
});

test("an unsearched project register is not an absence of projects", async () => {
  await setPopulation(quietWard, 18000);
  const issue = await makeIssue({ jurisdictionId: quietWard, openDays: 30 });

  const before = await gather();
  assert.equal(before[0]?.projectRegisterSearched, false);
  assert.equal(before[0]?.hasConfirmedProject, false);

  // Now record a V041 search that found nothing. The two states differ.
  const sourceId = randomUUID();
  createdSources.push(sourceId);
  await client.query(
    `insert into source_record
       (source_record_id, source_name, source_url_or_location, retrieved_at,
        licence_or_permission_status, demo_status)
     values ($1,'v042 register','fixture', now(),'synthetic','team_created_synthetic')`,
    [sourceId],
  );
  await client.query(
    `insert into project_link
       (project_link_id, issue_id, source_project_id, match_basis, match_status, proposed_at)
     values ($1,$2,$3,'{}'::jsonb,'unmatched', now())`,
    [randomUUID(), issue, sourceId],
  );

  const afterSearch = await gather();
  assert.equal(afterSearch[0]?.projectRegisterSearched, true);
  assert.equal(afterSearch[0]?.hasConfirmedProject, false);
});

test("an ordering of nothing is refused rather than returned as an empty list", async () => {
  await assert.rejects(
    () => order(),
    (error: unknown) =>
      error instanceof PrioritizationInputError && /mistake for a finding/.test(error.message),
  );
});

test("nothing an ordering built from real rows produces reads as a spending decision", async () => {
  await setPopulation(quietWard, 18000);
  await makeIssue({ jurisdictionId: quietWard, openDays: 90 });
  await makeIssue({ jurisdictionId: unmeasuredWard, openDays: 30 });
  const result = await order();
  assert.deepEqual(priorityOverclaims(orderingText(result.ordering)), []);
  assert.match(result.ordering.disclosures.join(" "), /No budget or cost information/);
});
