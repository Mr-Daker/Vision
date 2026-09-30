#!/usr/bin/env node
/**
 * Removes issues that only ever existed because a test made them.
 *
 * Usage:
 *   node --env-file-if-exists=.env tools/prune-test-residue.mjs           dry run: counts only
 *   node --env-file-if-exists=.env tools/prune-test-residue.mjs --apply   delete, in one transaction
 *
 * Why. The database tests used to run against the development database and
 * their cleanup missed rows, so it filled with issues no person reported: a
 * dashboard read "702 reports, 493 not placed in a ward", and the supervisor
 * queues listed problems with nothing behind them. The tests now use their own
 * database (`npm run test:db`), so this is a one-off tidy of what they left.
 *
 * What counts as residue — all three must hold:
 *   - the reference has the shape a generated issue gets (VIS- and eight hex
 *     digits), which excludes every demonstration seed (VIS-DUR-…, VIS-LC-…,
 *     VIS-V035-…, VIS-V036-…);
 *   - not one evidence link has ever pointed at it, live or ended. A reported
 *     issue is created together with its link, so this is never true of one;
 *   - it is not the target of a merge or alias that a real issue relies on
 *     (those tables are cleaned for the issues removed, never the survivors').
 *
 * Nothing else is touched. Take a dump first if the data matters:
 *   docker exec vision-postgres pg_dump -U vision -d vision_dev > backup.sql
 */

import pg from "pg";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://vision:vision_local_dev_only@127.0.0.1:5432/vision_dev";
const apply = process.argv.includes("--apply");

const host = new URL(DATABASE_URL).hostname;
if (!["localhost", "127.0.0.1", "::1", ""].includes(host)) {
  console.error(`refusing to prune '${host}': this tool only runs against a local database`);
  process.exit(2);
}

const client = new pg.Client({ connectionString: DATABASE_URL });
await client.connect();

const residue = `
  select issue_id from canonical_issue i
   where i.public_reference ~ '^VIS-[0-9A-F]{8}$'
     and not exists (select 1 from issue_evidence_link l where l.canonical_issue_id = i.issue_id)`;

try {
  const { rows: found } = await client.query(residue);
  const ids = found.map((row) => row.issue_id);
  const { rows: total } = await client.query("select count(*)::int as n from canonical_issue");
  console.log(`${ids.length} of ${total[0].n} issues are test residue`);
  if (ids.length === 0 || !apply) {
    if (!apply) console.log("dry run: nothing deleted (add --apply to delete)");
    process.exit(0);
  }

  const idsText = ids.map(String);
  const steps = [
    ["summary_issue_fact", "issue_id = any($1::uuid[]) or root_issue_id = any($1::uuid[])"],
    ["issue_alert", "issue_id = any($1::uuid[])"],
    ["issue_ageing_override", "issue_id = any($1::uuid[])"],
    ["acknowledgment", "issue_id = any($1::uuid[])"],
    ["review_decision", "canonical_issue_id = any($1::uuid[])"],
    [
      "issue_alias",
      "source_issue_id = any($1::uuid[]) or target_issue_id = any($1::uuid[]) or merge_id in (select merge_id from issue_merge where merged_issue_id = any($1::uuid[]) or surviving_issue_id = any($1::uuid[]))",
    ],
    ["issue_merge", "merged_issue_id = any($1::uuid[]) or surviving_issue_id = any($1::uuid[])"],
    ["correction_request", "canonical_issue_id = any($1::uuid[])"],
    ["trust_signal_report", "canonical_issue_id = any($1::uuid[])"],
    ["assignment", "issue_id = any($1::uuid[])"],
    ["routing_decision", "issue_id = any($1::uuid[])"],
    ["jurisdiction_resolution", "issue_id = any($1::uuid[])"],
    ["project_link", "issue_id = any($1::uuid[])"],
    ["reopening", "issue_id = any($1::uuid[])"],
    [
      "resolution_confirmation",
      "claim_id in (select claim_id from resolution_claim where issue_id = any($1::uuid[]))",
    ],
    [
      "resolution_evidence_item",
      "claim_id in (select claim_id from resolution_claim where issue_id = any($1::uuid[]))",
    ],
    ["resolution_claim", "issue_id = any($1::uuid[])"],
    ["issue_participation", "canonical_issue_id = any($1::uuid[])"],
  ];

  await client.query("begin");
  for (const [table, where] of steps) {
    const { rowCount } = await client.query(`delete from ${table} where ${where}`, [ids]);
    console.log(`  ${table}: ${rowCount}`);
  }
  await client.query(
    `update issue_match set supersedes_match_id = null
      where supersedes_match_id in (select match_id from issue_match where resulting_issue_id = any($1::uuid[]))`,
    [ids],
  );
  console.log(
    `  issue_match: ${(await client.query("delete from issue_match where resulting_issue_id = any($1::uuid[])", [ids])).rowCount}`,
  );
  await client.query(
    `delete from summary_applied_event where event_id in
       (select event_id from status_event where aggregate_id = any($1::text[]))`,
    [idsText],
  );
  await client.query(
    `delete from outbox where event_id in
       (select event_id from status_event where aggregate_id = any($1::text[]))`,
    [idsText],
  );
  console.log(
    `  status_event: ${(await client.query("delete from status_event where aggregate_id = any($1::text[])", [idsText])).rowCount}`,
  );
  console.log(
    `  canonical_issue: ${(await client.query("delete from canonical_issue where issue_id = any($1::uuid[])", [ids])).rowCount}`,
  );
  await client.query("commit");
  console.log("done; run `npm run summaries:rebuild` so the summaries match");
} catch (error) {
  await client.query("rollback").catch(() => undefined);
  console.error(
    `prune failed, nothing was deleted: ${error instanceof Error ? error.message : error}`,
  );
  process.exitCode = 1;
} finally {
  await client.end();
}
