#!/usr/bin/env node
/**
 * Prints the V042 ordering and its sensitivity.
 *
 * Usage:
 *   npm run priority:report
 *
 * The sensitivity column is printed beside every position, not in a footnote.
 * A list of positions with the caveat somewhere below it is a list of
 * positions, and a reader takes the number.
 */

import pg from "pg";

import { loadPrioritizationPolicy } from "@vision/config-packs";
import { orderCandidates } from "@vision/adapters";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://vision:vision_local_dev_only@127.0.0.1:5432/vision_dev";
const PROFILE = process.env.JURISDICTION_PROFILE_ID ?? "demo-district-a";
const SHOW = Number(process.argv[2] ?? 12);

const client = new pg.Client({ connectionString: DATABASE_URL, statement_timeout: 60_000 });
await client.connect();

try {
  const pack = loadPrioritizationPolicy(PROFILE);
  const policy = {
    version: pack.version,
    weightings: pack.weightings,
    references: pack.references,
    existingProjectDirection: pack.existingProjectDirection,
    existingProjectRationale: pack.existingProjectRationale,
    minimumFactorsForRanking: pack.minimumFactorsForRanking,
    budgetAssumption: pack.budgetAssumption,
    note: pack.note,
  };

  const { rows } = await client.query(
    "select jurisdiction_id from jurisdiction where jurisdiction_profile_id = $1",
    [PROFILE],
  );
  const result = await orderCandidates(client, {
    jurisdictionIds: rows.map((row) => String(row.jurisdiction_id)),
    asOf: new Date(),
    policy,
  });

  console.log(`V042 ordering — policy ${result.ordering.policyVersion}`);
  console.log(
    `  ${result.candidateCount} open report(s) considered at ${result.asOf}${result.exhaustive ? "" : " — the candidate limit was reached, so this is not every open report"}`,
  );
  console.log(`  weightings: ${result.ordering.weightingIds.join(", ")}`);
  console.log("");

  console.log(
    `  ${"report".padEnd(24)} ${"position".padEnd(14)} ${"sensitivity".padEnd(12)} factors with data`,
  );
  for (const placement of result.ordering.placements.slice(0, SHOW)) {
    const position =
      placement.bestRank === null ? "not ranked" : `${placement.bestRank}–${placement.worstRank}`;
    const withData = placement.factors.filter((factor) => factor.contribution !== null).length;
    console.log(
      `  ${placement.label.padEnd(24)} ${position.padEnd(14)} ${placement.stability.padEnd(12)} ${withData} of ${placement.factors.length}`,
    );
  }
  if (result.ordering.placements.length > SHOW) {
    console.log(`  … ${result.ordering.placements.length - SHOW} more`);
  }

  // The sensitivity summary is printed before any explanation of a position,
  // because how much the ordering depends on its weights is the thing a reader
  // needs before they read any position at all.
  const tally = { robust: 0, sensitive: 0, unstable: 0, not_ranked: 0 };
  for (const placement of result.ordering.placements) tally[placement.stability] += 1;
  const moved = [...result.ordering.placements]
    .filter((placement) => placement.bestRank !== null)
    .sort((a, b) => b.worstRank - b.bestRank - (a.worstRank - a.bestRank))[0];

  console.log("");
  console.log("  How much of this ordering is the weighting rather than the evidence");
  console.log(
    `    ${tally.robust} robust, ${tally.sensitive} sensitive, ${tally.unstable} unstable, ${tally.not_ranked} not ranked`,
  );
  if (moved !== undefined) {
    console.log(
      `    furthest moved: ${moved.label} between ${moved.bestRank} and ${moved.worstRank} (${moved.stability})`,
    );
  }
  const ranked = result.ordering.placements.length - tally.not_ranked;
  if (ranked > 0 && tally.robust / ranked > 0.9) {
    // Worth saying plainly. A reader seeing a column of "robust" will take the
    // ordering as well supported, when what it usually means here is that the
    // candidates are barely distinguishable — a stable ordering among
    // near-identical reports is stability, not evidence.
    console.log(
      "    most positions barely move, which here means the reports are barely distinguishable rather than that the ordering is well supported",
    );
  }

  const leader = result.ordering.placements[0];
  if (leader !== undefined) {
    console.log("");
    console.log(`  Why ${leader.label} sits where it does`);
    console.log(`    ${leader.explanation}`);
    for (const factor of leader.factors) {
      const value =
        factor.contribution === null
          ? `not counted (${factor.status})`
          : `${factor.contribution} at weight ${factor.appliedWeight}`;
      console.log(`    ${factor.factor.padEnd(20)} ${value}`);
      console.log(`        ${factor.explanation}`);
    }
    console.log("");
    console.log("  Position under each weighting");
    for (const entry of leader.underWeighting) {
      console.log(`    ${entry.weightingId.padEnd(16)} ${entry.rank ?? "not ranked"}`);
    }
  }

  if (result.ordering.unranked.length > 0) {
    console.log("");
    console.log(`  ${result.ordering.unranked.length} report(s) could not be ranked`);
    console.log(`    ${result.ordering.unranked[0].reason}`);
  }

  console.log("");
  console.log("  What this ordering is not");
  for (const disclosure of result.ordering.disclosures) console.log(`    · ${disclosure}`);
} finally {
  await client.end();
}
