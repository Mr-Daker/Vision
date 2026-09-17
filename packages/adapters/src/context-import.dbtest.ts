/**
 * V040 contextual data import against a real database.
 *
 * Run with: npm run db:up && npm run db:migrate && npm run test:db
 *
 * The acceptance clauses this file holds:
 *
 *   * **every stored context value links to a source record or is visibly
 *     synthetic** — the column is NOT NULL, and the lineage sentence arrives
 *     attached to the number rather than being left to a screen to remember;
 *   * **invalid units, stale records and unmatched assets are reported, never
 *     converted into plausible values** — the rejections are persisted, so
 *     "what did not load, and why" is answerable a week later;
 *   * a missing figure is stored as a missing figure, and the database refuses
 *     to hold an unexplained null.
 */

import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

import type { IsoTimestamp, SourceRecordSnapshot, Uuid } from "@vision/contracts";

import {
  ContextImportError,
  importContextDataset,
  readContextForJurisdictions,
  readImportRuns,
  type DatasetToImport,
} from "./context-import.ts";

const DATABASE_URL =
  process.env["DATABASE_URL"] ??
  "postgresql://vision:vision_local_dev_only@127.0.0.1:5432/vision_dev";

const PROFILE = `v040-profile-${randomUUID().slice(0, 8)}`;
const DAY = 86_400_000;

let client: pg.Client;
let districtId: string;
let blockOneId: string;
let blockTwoId: string;
const createdJurisdictions: string[] = [];
const createdDatasets: string[] = [];
const createdSources: string[] = [];

const syntheticSource = (over: Partial<SourceRecordSnapshot> = {}): SourceRecordSnapshot => {
  const id = (over.source_record_id ?? randomUUID()) as Uuid;
  createdSources.push(String(id));
  return {
    source_name: "v040 synthetic context register",
    source_url_or_location: "packages/adapters/src/context-import.dbtest.ts",
    retrieved_at: new Date().toISOString() as IsoTimestamp,
    source_effective_at: "2026-01-01T00:00:00Z" as IsoTimestamp,
    licence_or_permission_status: "synthetic",
    demo_status: "team_created_synthetic",
    ...over,
    // Last, so a caller overriding the licence still gets the tracked id.
    source_record_id: id,
  };
};

const makeJurisdiction = async (internalCode: string): Promise<string> => {
  const id = randomUUID();
  await client.query(
    `insert into jurisdiction
       (jurisdiction_id, jurisdiction_profile_id, internal_code, directory_version,
        level_scheme, level_code, effective_from, synthetic_provenance)
     values ($1,$2,$3,'v040-directory.v1','v040-scheme','block',
             now() - interval '2 years', true)`,
    [id, PROFILE, internalCode],
  );
  createdJurisdictions.push(id);
  return id;
};

const dataset = (over: Partial<DatasetToImport> = {}): DatasetToImport => {
  const datasetId = over.datasetId ?? `v040-population-${randomUUID().slice(0, 8)}`;
  if (!createdDatasets.includes(datasetId)) createdDatasets.push(datasetId);
  return {
    kind: "population",
    unit: "persons",
    label: "Population (synthetic)",
    maxAgeDays: 365,
    rows: [
      {
        subjectKind: "jurisdiction",
        subjectId: "V040-A",
        value: 18600,
        unit: "persons",
        vintage: new Date(Date.now() - 30 * DAY).toISOString(),
      },
    ],
    ...over,
    // Last, so a caller passing rows still gets the tracked dataset id.
    datasetId,
  };
};

const runImport = (over: Partial<DatasetToImport> = {}, source = syntheticSource()) =>
  importContextDataset(client, {
    dataset: dataset(over),
    source,
    jurisdictionProfileId: PROFILE,
    asOf: new Date(),
  });

before(async () => {
  client = new pg.Client({ connectionString: DATABASE_URL, statement_timeout: 60_000 });
  await client.connect();
  districtId = await makeJurisdiction("V040-D");
  blockOneId = await makeJurisdiction("V040-A");
  blockTwoId = await makeJurisdiction("V040-B");
});

const cleanupData = async (): Promise<void> => {
  if (createdDatasets.length > 0) {
    await client.query(
      `delete from context_import_rejection where run_id in
         (select run_id from context_import_run where dataset_id = any($1::text[]))`,
      [createdDatasets],
    );
    await client.query("delete from context_import_run where dataset_id = any($1::text[])", [
      createdDatasets,
    ]);
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

beforeEach(cleanupData);

after(async () => {
  await cleanupData();
  if (createdJurisdictions.length > 0) {
    await client.query("delete from jurisdiction where jurisdiction_id = any($1::uuid[])", [
      createdJurisdictions,
    ]);
  }
  await client.end();
});

// ---------------------------------------------------------------------------
// Lineage
// ---------------------------------------------------------------------------

test("a loaded value carries its source, its unit, its vintage and its lineage", async () => {
  const result = await runImport();
  assert.equal(result.rowsLoaded, 1);
  assert.equal(result.rowsRejected, 0);

  const values = await readContextForJurisdictions(client, {
    jurisdictionIds: [blockOneId],
    asOf: new Date(),
  });
  assert.equal(values.length, 1);
  const value = values[0];
  assert.equal(value?.value, 18600);
  assert.equal(value?.unit, "persons");
  assert.equal(value?.synthetic, true);
  assert.equal(value?.sourceName, "v040 synthetic context register");
  assert.match(value?.lineage ?? "", /Invented for this demonstration/);
  assert.match(value?.lineage ?? "", /18600 persons/);
  assert.match(value?.lineage ?? "", /days ago/);
});

test("a dataset cannot exist without a source record, enforced by the database", async () => {
  await runImport();
  await assert.rejects(
    () =>
      client.query(
        `insert into context_dataset
           (dataset_id, kind, unit, label, source_record_id, synthetic_provenance,
            max_age_days, jurisdiction_profile_id)
         values ($1,'population','persons','No source', null, true, 365, $2)`,
        [`v040-orphan-${randomUUID().slice(0, 8)}`, PROFILE],
      ),
    /null value in column "source_record_id"/,
    "a context figure with no source is a rumour with a number attached",
  );
});

test("a source that may not be ingested is refused before anything is written", async () => {
  const forbidden = syntheticSource({
    licence_or_permission_status: "reference_only",
    demo_status: "unavailable_not_approved",
  });
  await assert.rejects(
    () => runImport({}, forbidden),
    (error: unknown) => error instanceof ContextImportError && /V004/.test(error.message),
  );
  const { rows } = await client.query(
    "select count(*)::int as n from source_record where source_record_id = $1",
    [forbidden.source_record_id],
  );
  assert.equal(rows[0]?.["n"], 0, "nothing was written on the way to the refusal");
});

// ---------------------------------------------------------------------------
// Reported, never converted
// ---------------------------------------------------------------------------

test("a row in the wrong unit is refused and the refusal is stored", async () => {
  const datasetId = `v040-units-${randomUUID().slice(0, 8)}`;
  const result = await runImport({
    datasetId,
    rows: [
      {
        subjectKind: "jurisdiction",
        subjectId: "V040-A",
        value: 4800,
        unit: "households",
        vintage: new Date(Date.now() - 10 * DAY).toISOString(),
      },
    ],
  });
  assert.equal(result.rowsLoaded, 0);
  assert.equal(result.rowsRejected, 1);
  assert.equal(result.rejections[0]?.code, "unit_mismatch");

  const runs = await readImportRuns(client, { jurisdictionProfileId: PROFILE });
  const run = runs.find((candidate) => candidate.datasetId === datasetId);
  assert.equal(run?.rowsRejected, 1);
  assert.equal(run?.rejections[0]?.code, "unit_mismatch");
  assert.match(
    run?.rejections[0]?.detail ?? "",
    /does not convert units/,
    "the stored reason has to be readable without the original file",
  );

  const values = await readContextForJurisdictions(client, {
    jurisdictionIds: [blockOneId],
    asOf: new Date(),
  });
  assert.equal(values.length, 0, "and nothing rescaled was stored");
});

test("a row naming a subject that does not exist is refused, not attached to a neighbour", async () => {
  const result = await runImport({
    rows: [
      {
        subjectKind: "jurisdiction",
        subjectId: "V040-NOWHERE",
        value: 900,
        unit: "persons",
        vintage: new Date(Date.now() - 10 * DAY).toISOString(),
      },
    ],
  });
  assert.equal(result.rowsRejected, 1);
  assert.equal(result.rejections[0]?.code, "unmatched_subject");

  const values = await readContextForJurisdictions(client, {
    jurisdictionIds: [districtId, blockOneId, blockTwoId],
    asOf: new Date(),
  });
  assert.equal(values.length, 0);
});

test("a run that refuses everything still records what it attempted", async () => {
  const datasetId = `v040-allbad-${randomUUID().slice(0, 8)}`;
  const at = new Date(Date.now() - 5 * DAY).toISOString();
  const result = await runImport({
    datasetId,
    rows: [
      {
        subjectKind: "jurisdiction",
        subjectId: "V040-A",
        value: "12,400",
        unit: "persons",
        vintage: at,
      },
      { subjectKind: "jurisdiction", subjectId: "V040-X", value: 10, unit: "persons", vintage: at },
      { subjectKind: "jurisdiction", subjectId: "V040-B", value: -4, unit: "persons", vintage: at },
    ],
  });
  assert.equal(result.rowsRead, 3);
  assert.equal(result.rowsLoaded, 0);
  assert.equal(result.rowsRejected, 3);

  const runs = await readImportRuns(client, { jurisdictionProfileId: PROFILE });
  const run = runs.find((candidate) => candidate.datasetId === datasetId);
  assert.notEqual(
    run,
    undefined,
    "the run itself is committed; rolling it back would leave nothing to look at",
  );
  assert.deepEqual([...(run?.rejections ?? [])].map((rejection) => rejection.code).sort(), [
    "negative_value",
    "unmatched_subject",
    "unparseable_value",
  ]);
});

test("the same subject twice is refused rather than one figure silently winning", async () => {
  const at = new Date(Date.now() - 5 * DAY).toISOString();
  const result = await runImport({
    rows: [
      {
        subjectKind: "jurisdiction",
        subjectId: "V040-A",
        value: 100,
        unit: "persons",
        vintage: at,
      },
      {
        subjectKind: "jurisdiction",
        subjectId: "V040-A",
        value: 200,
        unit: "persons",
        vintage: at,
      },
    ],
  });
  assert.equal(result.rowsLoaded, 1, "the first stands");
  assert.equal(result.rejections[0]?.code, "duplicate_subject");

  const values = await readContextForJurisdictions(client, {
    jurisdictionIds: [blockOneId],
    asOf: new Date(),
  });
  assert.equal(values[0]?.value, 100);
});

// ---------------------------------------------------------------------------
// Missing stays missing
// ---------------------------------------------------------------------------

test("a source that said it did not know is stored as unknown, never as zero", async () => {
  const at = new Date(Date.now() - 10 * DAY).toISOString();
  const result = await runImport({
    rows: [
      {
        subjectKind: "jurisdiction",
        subjectId: "V040-A",
        value: "not surveyed",
        unit: "persons",
        vintage: at,
      },
    ],
  });
  assert.equal(result.rowsLoaded, 1);

  const values = await readContextForJurisdictions(client, {
    jurisdictionIds: [blockOneId],
    asOf: new Date(),
  });
  assert.equal(values[0]?.value, null);
  assert.equal(values[0]?.missingIndicator, "not surveyed");
  assert.match(values[0]?.lineage ?? "", /No figure is recorded/);
  assert.match(values[0]?.lineage ?? "", /"not surveyed"/);
  assert.doesNotMatch(values[0]?.lineage ?? "", /\b0 persons\b/);
});

test("the database refuses a null value with no reason, and a value with a reason", async () => {
  await runImport();
  const { rows } = await client.query(
    "select dataset_id from context_dataset where jurisdiction_profile_id = $1 limit 1",
    [PROFILE],
  );
  const datasetId = String(rows[0]?.["dataset_id"]);

  await assert.rejects(
    () =>
      client.query(
        `insert into context_observation
           (observation_id, dataset_id, subject_kind, jurisdiction_id, value,
            missing_indicator, unit, vintage)
         values ($1,$2,'jurisdiction',$3, null, null, 'persons', now())`,
        [randomUUID(), datasetId, blockTwoId],
      ),
    /context_observation_value_or_reason_ck/,
    "an unexplained null is exactly the state that later becomes a zero",
  );

  await assert.rejects(
    () =>
      client.query(
        `insert into context_observation
           (observation_id, dataset_id, subject_kind, jurisdiction_id, value,
            missing_indicator, unit, vintage)
         values ($1,$2,'jurisdiction',$3, 10, 'NA', 'persons', now())`,
        [randomUUID(), datasetId, blockTwoId],
      ),
    /context_observation_value_or_reason_ck/,
  );
});

// ---------------------------------------------------------------------------
// Staleness is reported, not refused
// ---------------------------------------------------------------------------

test("a stale figure is loaded and shown with its age, because it is still the best available", async () => {
  const result = await runImport({
    maxAgeDays: 365,
    rows: [
      {
        subjectKind: "jurisdiction",
        subjectId: "V040-A",
        value: 71.4,
        unit: "persons",
        vintage: new Date(Date.now() - 900 * DAY).toISOString(),
      },
    ],
  });
  assert.equal(result.rowsLoaded, 1, "old is not invalid");

  const values = await readContextForJurisdictions(client, {
    jurisdictionIds: [blockOneId],
    asOf: new Date(),
  });
  assert.equal(values[0]?.staleness.stale, true);
  assert.ok((values[0]?.staleness.ageDays ?? 0) >= 899);
  assert.match(values[0]?.lineage ?? "", /past the 365 days/);
  assert.match(values[0]?.lineage ?? "", /still the most recent figure available/);
});

test("a vintage in the future is refused, unlike one in the past", async () => {
  const result = await runImport({
    rows: [
      {
        subjectKind: "jurisdiction",
        subjectId: "V040-A",
        value: 100,
        unit: "persons",
        vintage: new Date(Date.now() + 90 * DAY).toISOString(),
      },
    ],
  });
  assert.equal(result.rejections[0]?.code, "future_vintage");
});

// ---------------------------------------------------------------------------
// Re-running
// ---------------------------------------------------------------------------

test("a corrected file replaces its dataset rather than leaving the old rows beside it", async () => {
  const datasetId = `v040-rerun-${randomUUID().slice(0, 8)}`;
  const source = syntheticSource();
  const at = new Date(Date.now() - 10 * DAY).toISOString();

  await importContextDataset(client, {
    dataset: dataset({
      datasetId,
      rows: [
        {
          subjectKind: "jurisdiction",
          subjectId: "V040-A",
          value: 100,
          unit: "persons",
          vintage: at,
        },
        {
          subjectKind: "jurisdiction",
          subjectId: "V040-B",
          value: 200,
          unit: "persons",
          vintage: at,
        },
      ],
    }),
    source,
    jurisdictionProfileId: PROFILE,
    asOf: new Date(),
  });

  await importContextDataset(client, {
    dataset: dataset({
      datasetId,
      rows: [
        {
          subjectKind: "jurisdiction",
          subjectId: "V040-A",
          value: 150,
          unit: "persons",
          vintage: at,
        },
      ],
    }),
    source,
    jurisdictionProfileId: PROFILE,
    asOf: new Date(),
  });

  const values = await readContextForJurisdictions(client, {
    jurisdictionIds: [blockOneId, blockTwoId],
    asOf: new Date(),
  });
  assert.equal(values.length, 1, "the superseded row is gone, not sitting beside its replacement");
  assert.equal(values[0]?.value, 150);

  const runs = await readImportRuns(client, { jurisdictionProfileId: PROFILE });
  const run = runs.find((candidate) => candidate.datasetId === datasetId);
  assert.equal(run?.rowsRead, 1, "the reported run is the most recent one");
});
