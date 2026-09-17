#!/usr/bin/env node
/**
 * The documented V044 sample-data audit.
 *
 * Usage:
 *   npm run audit:privacy
 *
 * Scans the database (identity store, model traces, logs and event payloads,
 * and the public view of every issue) and the fixtures committed to this
 * repository, then prints what it found and — always — what it does not cover.
 *
 * A clean result is evidence that the detectable classes are absent from what
 * was scanned. It is not a guarantee, and the limits are printed with the
 * result rather than filed somewhere a reader of the result will not go.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import pg from "pg";

import { AUDIT_LIMITS, scanText } from "@vision/domain";
import { auditSampleData } from "@vision/adapters";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://vision:vision_local_dev_only@127.0.0.1:5432/vision_dev";
const ROOT = process.cwd();

/**
 * Directories whose contents are committed and therefore published.
 *
 * `tools` is included because the seed scripts are where invented "realistic"
 * data is most likely to be typed in, and `docs` because an example in prose
 * is as committed as one in a fixture.
 */
const SCANNED_TREES = [
  "packages/fixtures",
  "packages/config-packs/src/packs",
  "tools",
  "docs",
  "deliverables",
];

const SKIPPED = new Set(["node_modules", ".git", "dist", "local-object-store"]);
const TEXT_FILE = /\.(?:ts|tsx|mjs|cjs|js|json|md|csv|txt|sql|html|css)$/i;

const walk = (directory) => {
  let entries = [];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    if (SKIPPED.has(entry.name)) return [];
    const full = join(directory, entry.name);
    if (entry.isDirectory()) return walk(full);
    return TEXT_FILE.test(entry.name) ? [full] : [];
  });
};

const client = new pg.Client({ connectionString: DATABASE_URL, statement_timeout: 120_000 });
await client.connect();

try {
  const asOf = new Date();
  const report = await auditSampleData(client, { asOf });

  // The repository fixtures, scanned with the same rules. This file is itself
  // excluded: it contains the pattern definitions, and a scanner that reports
  // its own source is noise that hides real findings.
  const fixtureFindings = [];
  let filesScanned = 0;
  for (const tree of SCANNED_TREES) {
    for (const file of walk(join(ROOT, tree))) {
      const relativePath = relative(ROOT, file);
      if (relativePath.includes("privacy-audit")) continue;
      let contents = "";
      try {
        if (statSync(file).size > 2_000_000) continue;
        contents = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      filesScanned += 1;
      fixtureFindings.push(...scanText(contents, "fixture", relativePath));
    }
  }

  const all = [...report.findings, ...fixtureFindings];

  console.log(`V044 sample-data privacy audit — ${report.ranAt}`);
  console.log("");
  console.log("  What was scanned");
  console.log(`    identity mappings      ${report.counts.identityMappings}`);
  console.log(`    model traces           ${report.counts.modelTraces}`);
  console.log(`    log rows               ${report.counts.logRows}`);
  console.log(`    event payloads         ${report.counts.eventPayloads}`);
  console.log(`    public issue views     ${report.counts.publicViews}`);
  console.log(`    committed files        ${filesScanned}`);
  console.log("");

  if (all.length === 0) {
    console.log("  No undisclosed identity record or detectable personal information was found.");
  } else {
    console.log(`  ${all.length} finding(s)`);
    const byScope = new Map();
    for (const finding of all) {
      byScope.set(finding.scope, [...(byScope.get(finding.scope) ?? []), finding]);
    }
    for (const [scope, findings] of byScope) {
      console.log("");
      console.log(`  ${scope} — ${findings.length}`);
      for (const finding of findings.slice(0, 25)) {
        console.log(`    ${finding.location}`);
        console.log(`        ${finding.patternId}: ${finding.maskedExcerpt}`);
        console.log(`        ${finding.why}`);
      }
      if (findings.length > 25) console.log(`    … ${findings.length - 25} more`);
    }
  }

  console.log("");
  console.log("  What this audit does not cover");
  for (const limit of AUDIT_LIMITS) console.log(`    · ${limit}`);

  process.exitCode = all.length === 0 ? 0 : 1;
} finally {
  await client.end();
}
