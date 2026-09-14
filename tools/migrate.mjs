#!/usr/bin/env node
/**
 * Migration runner scaffolding (roadmap V007).
 *
 * V007 establishes the *mechanism*: forward-only, versioned, numerically
 * ordered SQL files with a bookkeeping table. It does not author the domain
 * schema — that is V012, and it must not be pulled forward, because the V003
 * invariants (partial unique indexes, effective-dating) are the hard part and
 * deserve their own task.
 *
 * `apply` deliberately refuses to run: no database driver is chosen and no
 * instance exists until V013. Refusing loudly is better than appearing to
 * migrate nothing successfully.
 *
 * Usage:
 *   node tools/migrate.mjs status
 *   node tools/migrate.mjs validate
 *   node tools/migrate.mjs apply     (refuses until V013)
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(process.cwd(), "migrations");
const NAME_PATTERN = /^(\d{4})_[a-z0-9_]+\.sql$/;

const listMigrations = () => {
  let entries;
  try {
    entries = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql"));
  } catch {
    return [];
  }
  return entries.sort();
};

const validate = () => {
  const files = listMigrations();
  const problems = [];
  const seen = new Set();

  files.forEach((name, index) => {
    const match = NAME_PATTERN.exec(name);
    if (match === null) {
      problems.push(`${name}: must match NNNN_snake_case_name.sql`);
      return;
    }
    const sequence = match[1];
    if (seen.has(sequence)) {
      problems.push(`${name}: duplicate sequence number ${sequence}`);
    }
    seen.add(sequence);

    const expected = String(index + 1).padStart(4, "0");
    if (sequence !== expected) {
      problems.push(`${name}: out-of-order sequence (expected ${expected})`);
    }

    const sql = readFileSync(join(MIGRATIONS_DIR, name), "utf8");
    if (/\bDROP\s+TABLE\b/i.test(sql) && !/-- allow-destructive:/i.test(sql)) {
      problems.push(
        `${name}: contains DROP TABLE without an explicit '-- allow-destructive:' justification`,
      );
    }
  });

  return { files, problems };
};

const command = process.argv[2] ?? "status";

if (command === "status" || command === "validate") {
  const { files, problems } = validate();

  if (command === "status") {
    console.log(`migrations directory: ${MIGRATIONS_DIR}`);
    console.log(`discovered ${files.length} migration file(s):`);
    for (const file of files) console.log(`  - ${file}`);
    console.log(
      "\napplied state: unknown — no database is configured (V013 provisions the local stack)",
    );
  }

  if (problems.length > 0) {
    console.error("\nmigration validation failed:");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }

  console.log(`\nmigrate:${command} OK — naming and ordering are valid`);
  process.exit(0);
}

if (command === "apply") {
  console.error(
    [
      "refusing to apply migrations.",
      "",
      "No database driver or migration tool is chosen yet (V006 D14), and no",
      "PostgreSQL instance exists. V012 authors the domain schema and V013 runs",
      "the local persistence stack and tests these migrations.",
      "",
      "Applying nothing and reporting success would be worse than this refusal.",
    ].join("\n"),
  );
  process.exit(2);
}

console.error(`unknown command: ${command}\nusage: node tools/migrate.mjs [status|validate|apply]`);
process.exit(64);
