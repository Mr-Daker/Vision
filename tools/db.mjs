#!/usr/bin/env node
/**
 * Local persistence stack operations (roadmap V013).
 *
 * Commands:
 *   status    applied vs pending migrations
 *   migrate   apply pending migrations, forward-only, with checksums
 *   verify    prove spatial + vector capability and key invariants with real queries
 *   seed      load the V011 fixture corpus (development split only)
 *   reset     drop and recreate the schema  [GUARDED: loopback + explicit opt-in]
 *
 * Safety: `reset` refuses unless DATABASE_URL points at loopback AND
 * VISION_ALLOW_DESTRUCTIVE=yes is set. A development reset must never be able
 * to target a shared or production database (V013 "done when").
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

const MIGRATIONS_DIR = join(process.cwd(), "migrations");
const DEFAULT_URL = "postgresql://vision:vision_local_dev_only@127.0.0.1:5432/vision_dev";
const DATABASE_URL = process.env["DATABASE_URL"] ?? DEFAULT_URL;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", ""]);

const connect = async () => {
  const client = new pg.Client({
    connectionString: DATABASE_URL,
    // Bounded per V006 §5: a hung statement must not hold a connection open.
    statement_timeout: 30_000,
  });
  await client.connect();
  return client;
};

const assertLoopbackTarget = (command) => {
  let host;
  try {
    host = new URL(DATABASE_URL).hostname;
  } catch {
    console.error(`DATABASE_URL is not a valid URL; refusing to ${command}`);
    process.exit(2);
  }
  if (!LOOPBACK_HOSTS.has(host)) {
    console.error(
      [
        `refusing to ${command}: DATABASE_URL host is '${host}', which is not loopback.`,
        "",
        "A development reset must never be able to target a shared or production",
        "database. If this really is a disposable local database, point",
        "DATABASE_URL at 127.0.0.1.",
      ].join("\n"),
    );
    process.exit(2);
  }
  if (process.env["VISION_ALLOW_DESTRUCTIVE"] !== "yes") {
    console.error(
      [
        `refusing to ${command}: destructive commands require an explicit opt-in.`,
        "",
        "Re-run with VISION_ALLOW_DESTRUCTIVE=yes if you intend to discard all",
        "local data in this database.",
      ].join("\n"),
    );
    process.exit(2);
  }
};

const listMigrations = () =>
  readdirSync(MIGRATIONS_DIR)
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .sort()
    .map((filename) => {
      const sql = readFileSync(join(MIGRATIONS_DIR, filename), "utf8");
      return {
        filename,
        sequence: filename.slice(0, 4),
        sql,
        checksum: createHash("sha256").update(sql).digest("hex"),
      };
    });

const ensureLedger = async (client) => {
  // 0001 creates the ledger, so bootstrap it before querying.
  await client.query(readFileSync(join(MIGRATIONS_DIR, "0001_migration_bookkeeping.sql"), "utf8"));
};

const appliedMap = async (client) => {
  const { rows } = await client.query(
    "select sequence, filename, checksum, applied_at from schema_migrations order by sequence",
  );
  return new Map(rows.map((row) => [row.sequence, row]));
};

const commandStatus = async () => {
  const client = await connect();
  try {
    await ensureLedger(client);
    const applied = await appliedMap(client);
    const migrations = listMigrations();

    console.log(`database: ${DATABASE_URL.replace(/:[^:@/]*@/, ":***@")}`);
    console.log(
      `server:   ${(await client.query("select version()")).rows[0].version.slice(0, 40)}`,
    );
    console.log("");
    for (const migration of migrations) {
      const record = applied.get(migration.sequence);
      if (record === undefined) {
        console.log(`  PENDING  ${migration.filename}`);
      } else if (record.checksum !== migration.checksum) {
        console.log(`  CHANGED  ${migration.filename}  <-- applied file was edited`);
      } else {
        console.log(`  applied  ${migration.filename}  ${record.applied_at.toISOString()}`);
      }
    }
  } finally {
    await client.end();
  }
};

const commandMigrate = async () => {
  const client = await connect();
  try {
    await ensureLedger(client);
    const applied = await appliedMap(client);
    const migrations = listMigrations();

    // Forward-only integrity: an already-applied migration must not have changed.
    const drifted = migrations.filter((migration) => {
      const record = applied.get(migration.sequence);
      return record !== undefined && record.checksum !== migration.checksum;
    });
    if (drifted.length > 0) {
      console.error("refusing to migrate: these applied migrations were edited:");
      for (const migration of drifted) console.error(`  - ${migration.filename}`);
      console.error("\nMigrations are forward-only. Add a new migration instead.");
      process.exit(1);
    }

    let count = 0;
    for (const migration of migrations) {
      if (applied.has(migration.sequence)) continue;

      // Each migration is one transaction: a failure leaves no partial schema.
      await client.query("begin");
      try {
        await client.query(migration.sql);
        await client.query(
          "insert into schema_migrations (sequence, filename, checksum) values ($1,$2,$3)",
          [migration.sequence, migration.filename, migration.checksum],
        );
        await client.query("commit");
        console.log(`  applied  ${migration.filename}`);
        count += 1;
      } catch (error) {
        await client.query("rollback");
        console.error(`\nfailed on ${migration.filename}:\n${String(error)}`);
        process.exit(1);
      }
    }
    console.log(count === 0 ? "\nup to date" : `\nmigrate OK — applied ${String(count)}`);
  } finally {
    await client.end();
  }
};

/**
 * Capability verification. V013 requires that spatial and vector capability be
 * verified rather than assumed from upstream documentation, so these are real
 * queries whose answers are checked, not extension version strings.
 */
const commandVerify = async () => {
  const client = await connect();
  const failures = [];
  const check = (label, ok, detail) => {
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail === undefined ? "" : ` — ${detail}`}`);
    if (!ok) failures.push(label);
  };

  try {
    const server = (await client.query("select current_setting('server_version') as v")).rows[0].v;
    console.log(`server: PostgreSQL ${server}\n`);

    const ext = await client.query(
      "select extname, extversion from pg_extension where extname in ('postgis','vector') order by extname",
    );
    const versions = new Map(ext.rows.map((row) => [row.extname, row.extversion]));
    check("postgis installed", versions.has("postgis"), versions.get("postgis"));
    check("pgvector installed", versions.has("vector"), versions.get("vector"));

    // Spatial: ST_DWithin on geography must measure METRES, not degrees.
    const spatial = await client.query(`
      select ST_DWithin('SRID=4326;POINT(74.56 16.85)'::geography,
                        'SRID=4326;POINT(74.5605 16.85)'::geography, 60) as within_60m,
             ST_DWithin('SRID=4326;POINT(74.56 16.85)'::geography,
                        'SRID=4326;POINT(74.5605 16.85)'::geography, 10) as within_10m,
             round(ST_Distance('SRID=4326;POINT(74.56 16.85)'::geography,
                               'SRID=4326;POINT(74.5605 16.85)'::geography)::numeric, 1) as metres
    `);
    const s = spatial.rows[0];
    check(
      "ST_DWithin on geography measures metres",
      s.within_60m === true && s.within_10m === false,
      `${String(s.metres)} m apart`,
    );

    // Spatial index is actually usable on the asset table.
    const gist = await client.query(`
      select count(*)::int as n from pg_indexes
      where indexname in ('infrastructure_asset_location_gix','jurisdiction_boundary_gix')
    `);
    check("GiST spatial indexes exist", gist.rows[0].n === 2, `${String(gist.rows[0].n)}/2`);

    // Vector: exact distance operators must compute correctly.
    const vector = await client.query(`
      select round(('[1,0,0]'::vector <-> '[0,1,0]'::vector)::numeric, 4) as l2,
             round(('[1,0,0]'::vector <=> '[1,0,0]'::vector)::numeric, 4) as cosine_same,
             vector_dims('[1,2,3]'::vector) as dims
    `);
    const v = vector.rows[0];
    check("pgvector L2 distance", Number(v.l2) === 1.4142, `sqrt(2) = ${String(v.l2)}`);
    check(
      "pgvector cosine distance",
      Number(v.cosine_same) === 0,
      `identical = ${String(v.cosine_same)}`,
    );
    check("pgvector dimensions", v.dims === 3);

    // Bounded resources per V006 §5.
    const settings = await client.query(`
      select name, setting from pg_settings
      where name in ('max_connections','statement_timeout','idle_in_transaction_session_timeout')
      order by name
    `);
    for (const row of settings.rows) {
      check(`setting ${row.name}`, row.setting !== "0" || row.name === "x", row.setting);
    }

    // The invariants V012 exists to enforce must actually be present.
    const expectedIndexes = [
      "submission_participant_idempotency_uniq",
      "processing_stage_identity_uniq",
      "issue_participation_participant_issue_uniq",
      "status_event_aggregate_version_uniq",
      "issue_match_one_active_per_submission_uniq",
      "issue_evidence_link_one_active_per_evidence_uniq",
      "assignment_one_active_per_issue_uniq",
      "issue_alias_one_active_outgoing_uniq",
      "identity_mapping_provider_subject_uniq",
      "outbox_event_task_uniq",
    ];
    const present = new Set(
      (
        await client.query(
          "select conname as name from pg_constraint union select indexname as name from pg_indexes",
        )
      ).rows.map((row) => row.name),
    );
    for (const name of expectedIndexes) {
      check(`invariant ${name}`, present.has(name));
    }

    console.log("");
    if (failures.length > 0) {
      console.error(`db:verify FAILED — ${String(failures.length)} check(s) failed`);
      process.exit(1);
    }
    console.log("db:verify OK — spatial and vector capability verified by query, not assumed");
  } finally {
    await client.end();
  }
};

const commandReset = async () => {
  assertLoopbackTarget("reset");
  const client = await connect();
  try {
    await client.query("drop schema public cascade; create schema public;");
    // Extensions live in public, so they are dropped with it and re-created by 0002.
    console.log("reset OK — schema dropped and recreated; run `npm run db:migrate` next");
  } finally {
    await client.end();
  }
};

const commandSeed = async () => {
  const { seedDevelopmentCorpus } = await import("./seed-fixtures.mjs");
  const client = await connect();
  try {
    const summary = await seedDevelopmentCorpus(client);
    console.log(`seed OK — ${JSON.stringify(summary)}`);
  } finally {
    await client.end();
  }
};

/**
 * The V035 demonstration issues.
 *
 * Separate from `seed` because it is additive and safe to re-run against a
 * database that already has work recorded against these issues, whereas the
 * corpus seed is the initial load.
 */
const commandSeedV035 = async () => {
  const { seedV035Demo } = await import("./seed-v035-demo.mjs");
  const client = await connect();
  try {
    const summary = await seedV035Demo(client);
    console.log(`seed:v035 OK — ${JSON.stringify(summary)}`);
  } finally {
    await client.end();
  }
};

const command = process.argv[2] ?? "status";
const commands = {
  status: commandStatus,
  migrate: commandMigrate,
  verify: commandVerify,
  reset: commandReset,
  seed: commandSeed,
  "seed:v035": commandSeedV035,
};

const handler = commands[command];
if (handler === undefined) {
  console.error(`unknown command: ${command}`);
  console.error("usage: node tools/db.mjs [status|migrate|verify|seed|seed:v035|reset]");
  process.exit(64);
}

try {
  await handler();
} catch (error) {
  console.error(String(error instanceof Error ? error.message : error));
  process.exit(1);
}
