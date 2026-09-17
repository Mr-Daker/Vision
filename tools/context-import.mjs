#!/usr/bin/env node
/**
 * Imports the district's contextual datasets and prints what was refused.
 *
 * Usage:
 *   npm run context:import
 *   npm run context:report
 *
 * The rejection list is printed in full and last, because it is the part
 * somebody has to act on. A loader that prints "4 datasets imported" and
 * nothing else is how a file with half its rows refused gets treated as
 * loaded.
 */

import pg from "pg";

import { loadContextPack } from "@vision/config-packs";
import {
  importContextDataset,
  readContextForJurisdictions,
  readImportRuns,
} from "@vision/adapters";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://vision:vision_local_dev_only@127.0.0.1:5432/vision_dev";
const PROFILE = process.env.JURISDICTION_PROFILE_ID ?? "demo-district-a";

const command = process.argv[2] ?? "import";
const client = new pg.Client({ connectionString: DATABASE_URL, statement_timeout: 60_000 });
await client.connect();

try {
  const asOf = new Date();

  if (command === "import") {
    const pack = loadContextPack(PROFILE);
    console.log(`context pack ${pack.version} — ${pack.datasets.length} dataset(s)`);
    console.log(`  ${pack.notice}`);
    console.log("");

    const source = {
      source_record_id: pack.source.sourceRecordId,
      source_name: pack.source.sourceName,
      source_url_or_location: pack.source.sourceUrlOrLocation,
      retrieved_at: pack.source.retrievedAt,
      ...(pack.source.sourceEffectiveAt === undefined
        ? {}
        : { source_effective_at: pack.source.sourceEffectiveAt }),
      licence_or_permission_status: pack.source.licenceOrPermissionStatus,
      demo_status: pack.source.demoStatus,
    };

    for (const dataset of pack.datasets) {
      const result = await importContextDataset(client, {
        dataset: {
          datasetId: dataset.datasetId,
          kind: dataset.kind,
          unit: dataset.unit,
          label: dataset.label,
          maxAgeDays: dataset.maxAgeDays,
          rows: dataset.rows,
        },
        source,
        jurisdictionProfileId: PROFILE,
        asOf,
      });
      console.log(
        `  ${result.datasetId}: read ${result.rowsRead}, loaded ${result.rowsLoaded}, refused ${result.rowsRejected}`,
      );
      for (const rejection of result.rejections) {
        console.log(`      row ${rejection.rowIndex} ${rejection.code}: ${rejection.detail}`);
      }
    }
    console.log("");
  }

  const runs = await readImportRuns(client, { jurisdictionProfileId: PROFILE });
  console.log("Last import run per dataset");
  for (const run of runs) {
    console.log(
      `  ${run.datasetId.padEnd(38)} ${String(run.rowsLoaded).padStart(3)} loaded, ${String(run.rowsRejected).padStart(3)} refused   ${run.ranAt}`,
    );
    for (const rejection of run.rejections) {
      console.log(`      row ${rejection.rowIndex} ${rejection.code}: ${rejection.detail}`);
    }
  }

  const { rows } = await client.query(
    "select jurisdiction_id from jurisdiction where jurisdiction_profile_id = $1",
    [PROFILE],
  );
  const values = await readContextForJurisdictions(client, {
    jurisdictionIds: rows.map((row) => String(row.jurisdiction_id)),
    asOf,
  });

  console.log("");
  console.log(`Loaded context values (${values.length})`);
  for (const value of values) {
    const figure =
      value.value === null ? `UNKNOWN (${value.missingIndicator})` : String(value.value);
    console.log(
      `  ${value.kind.padEnd(11)} ${figure.padStart(22)} ${value.unit.padEnd(22)} ${value.staleness.stale ? "STALE" : "current"}`,
    );
    console.log(`      ${value.lineage}`);
  }
} finally {
  await client.end();
}
