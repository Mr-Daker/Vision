#!/usr/bin/env node
/**
 * Prints the V037 metric report against the local database.
 *
 * Usage:
 *   npm run metrics:report
 *   npm run metrics:report -- --as-of 2026-06-01T00:00:00Z --knowledge-cutoff 2026-03-01T00:00:00Z
 *
 * Every line states its own uncertainty. A value is printed as UNKNOWN with
 * its reason rather than as a number, unclassifiable records are printed next
 * to the value rather than folded into it, and no speed figure is printed
 * without the count of issues that have no resolution time at all.
 */

import pg from "pg";

import { speedCoverage, speedStatement } from "@vision/domain";
import { computeMetricReport, defaultParams } from "@vision/adapters";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://vision:vision_local_dev_only@127.0.0.1:5432/vision_dev";

const flag = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
};

const show = (measure) =>
  measure.value === null ? `UNKNOWN (${measure.unknownReason})` : String(measure.value);

const now = Date.now();
const base = defaultParams(now, Number(flag("cohort-days", "365")));
const params = {
  ...base,
  asOf: flag("as-of", base.asOf),
  knowledgeCutoff: flag("knowledge-cutoff", flag("as-of", base.knowledgeCutoff)),
  windowStart: flag("window-start", base.windowStart),
  windowEnd: flag("window-end", base.windowEnd),
  fixedWindowDays: Number(flag("fixed-window-days", String(base.fixedWindowDays))),
};

const client = new pg.Client({ connectionString: DATABASE_URL, statement_timeout: 60_000 });
await client.connect();

try {
  const report = await computeMetricReport(client, params, now);

  console.log(`V037 metric report — ${report.mode} horizon`);
  console.log(`  event time up to     ${report.params.asOf}`);
  console.log(`  known to this system ${report.params.knowledgeCutoff}`);
  console.log(
    `  cohort window        [${report.params.windowStart}, ${report.params.windowEnd}) · fixed window ${report.params.fixedWindowDays} days`,
  );
  console.log("");

  for (const reading of report.readings) {
    const unknowns = reading.unknownRows > 0 ? `  (+${reading.unknownRows} record(s) UNKNOWN)` : "";
    console.log(
      `  ${reading.id}  ${reading.title.padEnd(42)} ${show(reading.measure)} ${reading.unit}${unknowns}`,
    );
  }

  console.log("");
  console.log("  Speed");
  console.log(`    ${speedStatement(report.speed)}`);
  console.log(`    measured over ${show(speedCoverage(report.speed))}% of the cohort`);
  console.log(
    `    standing resolution ${report.speed.standingResolutionHoursMedian ?? "UNKNOWN"} h · reopening cycle ${report.speed.reopeningCycleHoursMedian ?? "UNKNOWN"} h`,
  );

  console.log("");
  console.log("  Counted demo participants");
  console.log(`    distinct across the whole scope   ${report.contributors.distinctInScope}`);
  console.log(
    `    what adding the per-issue counts would say  ${report.contributors.sumOfPerRoot} — never publish this`,
  );
  console.log(`    recorded but not counted          ${report.contributors.notCountedRows}`);

  console.log("");
  console.log("  Coverage");
  console.log(`    roots in scope        ${report.coverage.rows}`);
  console.log(`    missing a dimension   ${report.coverage.anyDimensionUnknown}`);
  console.log(`    status unknown        ${report.coverage.statusUnknown}`);
  console.log(`    category unknown      ${report.coverage.categoryUnknown}`);
  console.log(`    jurisdiction unknown  ${report.coverage.jurisdictionUnknown}`);
  console.log(
    `    boundaries with no population source  ${report.population.filter((row) => row.population.value === null).length} of ${report.population.length}`,
  );

  const disclosures = [...new Set(report.readings.flatMap((reading) => reading.disclosures))];
  if (disclosures.length > 0) {
    console.log("");
    console.log("  What these numbers do not mean");
    for (const disclosure of disclosures) console.log(`    · ${disclosure}`);
  }
} finally {
  await client.end();
}
