#!/usr/bin/env node
/**
 * Builds, checks and prints the V038 summary projection.
 *
 * Usage:
 *   npm run summaries:rebuild     rebuild from authoritative state
 *   npm run summaries:apply       apply newly recorded events
 *   npm run summaries:report      print cells, freshness and the last check
 *
 * The report always prints freshness and the reconciliation verdict above the
 * numbers. A summary that is behind the record or has failed its last check is
 * not a summary anybody should be reading figures out of, and putting that
 * line underneath the table would be the same as hiding it.
 */

import pg from "pg";

import { rollUpCells } from "@vision/domain";
import {
  applySummaryEvents,
  readSummaryCells,
  rebuildSummaries,
  reconcileSummaries,
  summaryStatus,
} from "@vision/adapters";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://vision:vision_local_dev_only@127.0.0.1:5432/vision_dev";

const command = process.argv[2] ?? "report";
const client = new pg.Client({ connectionString: DATABASE_URL, statement_timeout: 120_000 });
await client.connect();

try {
  const asOf = new Date();

  if (command === "rebuild") {
    const result = await rebuildSummaries(client, { asOf });
    console.log(
      `rebuilt ${result.issuesProjected} issue(s) into ${result.cellsWritten} cell(s); ${result.eventsMarked} event(s) newly marked as applied`,
    );
  }

  if (command === "apply") {
    const result = await applySummaryEvents(client, { asOf, limit: 5000 });
    console.log(
      `read ${result.eventsRead} event(s), applied ${result.eventsApplied}, found ${result.issuesDiscovered} unprojected issue(s), reprojected ${result.issuesProjected} into ${result.cellsRefreshed} cell(s)`,
    );
  }

  if (command === "reconcile" || command === "report") {
    const run = await reconcileSummaries(client, { asOf });
    console.log(
      run.reconciled
        ? `reconciled: ${run.checkedFacts} issue(s) and ${run.checkedCells} cell(s) match a clean rebuild`
        : `RECONCILIATION FAILED: ${run.mismatchedFacts} issue(s), ${run.mismatchedCells} cell(s) disagree`,
    );
    for (const difference of run.factDifferences.slice(0, 10)) {
      console.log(
        `  ${difference.issueId} ${difference.field}: projected ${difference.incremental}, rebuilt ${difference.rebuilt}`,
      );
    }
    for (const difference of run.cellDifferences.slice(0, 10)) {
      console.log(
        `  cell ${difference.cell} ${difference.field}: stored ${difference.stored}, rebuilt ${difference.rebuilt}`,
      );
    }
  }

  if (command !== "report") {
    await client.end();
    process.exit(0);
  }

  const status = await summaryStatus(client, { asOf });
  console.log("");
  console.log(`V038 summary — ${status.summaryName}`);
  console.log(
    `  freshness:  ${status.freshness.state.toUpperCase()} — ${status.freshness.explanation}`,
  );
  console.log(`  last full rebuild: ${status.lastRebuildAt ?? "never"}`);
  console.log(`  events applied:    ${status.eventsApplied}`);
  console.log(
    `  last check:        ${
      status.lastReconciliation === null
        ? "never"
        : `${status.lastReconciliation.reconciled ? "matched a clean rebuild" : `FAILED with ${status.lastReconciliation.mismatches} mismatch(es)`} at ${status.lastReconciliation.ranAt}`
    }`,
  );

  const cells = await readSummaryCells(client);
  const withWork = cells.filter((cell) => cell.issueCount > 0);
  console.log("");
  console.log(`  ${withWork.length} cell(s) with issues, of ${cells.length} projected`);
  console.log("");
  console.log(
    `    ${"jurisdiction".padEnd(14)} ${"category".padEnd(18)} ${"issues".padStart(6)} ${"open".padStart(5)} ${"claim".padStart(5)} ${"disp".padStart(5)} ${"conf".padStart(5)} ${"reop".padStart(5)} ${"?".padStart(3)} ${"people".padStart(6)}`,
  );
  for (const cell of [...withWork].sort((a, b) => b.issueCount - a.issueCount).slice(0, 15)) {
    const where =
      cell.jurisdictionKey === "UNKNOWN" ? "UNKNOWN" : cell.jurisdictionKey.slice(0, 13);
    console.log(
      `    ${where.padEnd(14)} ${cell.category.slice(0, 18).padEnd(18)} ${String(cell.issueCount).padStart(6)} ${String(cell.open).padStart(5)} ${String(cell.claimed).padStart(5)} ${String(cell.disputed).padStart(5)} ${String(cell.confirmed).padStart(5)} ${String(cell.reopened).padStart(5)} ${String(cell.unknownState).padStart(3)} ${String(cell.countedParticipants).padStart(6)}`,
    );
  }
  if (withWork.length > 15) console.log(`    … ${withWork.length - 15} more`);

  const parts = withWork.map((cell) => ({
    boundaryId: `${cell.jurisdictionKey}|${cell.category}`,
    boundaryVersion: cell.boundaryVersion ?? "UNKNOWN",
    value: cell.issueCount,
  }));
  const versions = new Set(parts.map((part) => part.boundaryVersion));
  console.log("");
  console.log("  Rolling up");
  const issues = rollUpCells("issues", parts, { mutuallyExclusive: true });
  console.log(
    `    issues across ${parts.length} cell(s): ${
      issues.ok
        ? (issues.value.value ?? `UNKNOWN (${issues.value.unknownReason})`)
        : `REFUSED — ${issues.reason}`
    }`,
  );
  const people = rollUpCells(
    "countedParticipants",
    withWork.map((cell) => ({
      boundaryId: `${cell.jurisdictionKey}|${cell.category}`,
      boundaryVersion: cell.boundaryVersion ?? "UNKNOWN",
      value: cell.countedParticipants,
    })),
    { mutuallyExclusive: true },
  );
  console.log(
    `    counted demo participants: ${people.ok ? people.value.value : `REFUSED — ${people.reason}`}`,
  );
  if (versions.size > 1) {
    console.log(
      `    (${versions.size} boundary versions present, which is why the issue roll-up above may refuse)`,
    );
  }
} finally {
  await client.end();
}
