#!/usr/bin/env node
/**
 * Runs the real-database tests against their OWN database.
 *
 * Usage:
 *   npm run test:db                              every *.dbtest.ts, serially
 *   npm run test:db -- path/to/file.dbtest.ts    just those files
 *
 * Why this exists. The dbtest files used to run against `vision_dev`, the
 * database a person is also using: they created reports and follow-up tasks
 * in it, their cleanup missed some (an outbox task whose report was deleted
 * fails at every worker pass, for ever), and the worker test processed
 * *every* waiting report, including a real one, moving it into a test area.
 * Tests that share a database with a person's work leave it worse each run.
 *
 * So they run in `vision_test`, created and migrated here on first use and
 * kept between runs. Nothing a test does can reach `vision_dev`.
 *
 * Safety: the database is only created on loopback, and its name is fixed
 * apart from an explicit VISION_TEST_DATABASE_URL, which must not name the
 * development database.
 */

import { spawn } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

const DEV_URL = "postgresql://vision:vision_local_dev_only@127.0.0.1:5432/vision_dev";
const TEST_URL =
  process.env["VISION_TEST_DATABASE_URL"] ??
  "postgresql://vision:vision_local_dev_only@127.0.0.1:5432/vision_test";
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", ""]);

const target = new URL(TEST_URL);
const databaseName = target.pathname.replace(/^\//, "");
const devName = new URL(process.env["DATABASE_URL"] ?? DEV_URL).pathname.replace(/^\//, "");

if (!LOOPBACK_HOSTS.has(target.hostname)) {
  console.error(`refusing to run tests: '${target.hostname}' is not a loopback host`);
  process.exit(2);
}
if (databaseName.length === 0 || databaseName === devName || databaseName === "vision_dev") {
  console.error(
    `refusing to run tests against '${databaseName}': the test database must not be the development database`,
  );
  process.exit(2);
}
if (!/^[a-z][a-z0-9_]*$/.test(databaseName)) {
  console.error(`refusing to create a database named '${databaseName}'`);
  process.exit(2);
}

const ensureDatabase = async () => {
  // Connect to the maintenance database of the same server to create ours.
  const admin = new URL(TEST_URL);
  admin.pathname = "/postgres";
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const { rows } = await client.query("select 1 from pg_database where datname = $1", [
      databaseName,
    ]);
    if (rows.length === 0) {
      // Identifier validated above; CREATE DATABASE cannot take a parameter.
      await client.query(`create database ${databaseName}`);
      console.log(`created database ${databaseName}`);
    }
  } finally {
    await client.end();
  }
};

const run = (command, args, env) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "inherit", env: { ...process.env, ...env } });
    child.on("exit", (code) => resolve(code ?? 1));
  });

const dbtestFiles = (directory) =>
  readdirSync(directory).flatMap((name) => {
    if (name === "node_modules" || name.startsWith(".")) return [];
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return dbtestFiles(path);
    return name.endsWith(".dbtest.ts") ? [path] : [];
  });

await ensureDatabase();

const migrated = await run("node", ["tools/db.mjs", "migrate"], { DATABASE_URL: TEST_URL });
if (migrated !== 0) process.exit(migrated);

// The standard fixture corpus (wards, assets, routing rules, a few reports):
// several suites read it rather than creating their own, and say "run
// db:seed first" when it is missing. Repeatable, so it is loaded every time.
const seeded = await run("node", ["tools/db.mjs", "seed"], { DATABASE_URL: TEST_URL });
if (seeded !== 0) process.exit(seeded);

// The imported context figures (population, enrolment, access). The dashboard
// suites assert every figure carries its source and lineage, which needs some.
const imported = await run("node", ["tools/context-import.mjs", "import"], {
  DATABASE_URL: TEST_URL,
});
if (imported !== 0) process.exit(imported);

const requested = process.argv.slice(2);
const files =
  requested.length > 0 ? requested : [...dbtestFiles("packages"), ...dbtestFiles("apps")].sort();

console.log(`\nrunning ${String(files.length)} database test file(s) against ${databaseName}\n`);
const code = await run("node", ["--test", "--test-concurrency=1", ...files], {
  DATABASE_URL: TEST_URL,
});
process.exit(code);
