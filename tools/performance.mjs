#!/usr/bin/env node
/**
 * The V049 measurement run.
 *
 * Usage:
 *   npm run perf:measure            measure and write deliverables/V049-performance-results.md
 *   npm run perf:measure -- --iterations 100
 *
 * It measures the real functions the deployment calls, records the machine and
 * the database settings it ran against, and refuses to turn any of it into a
 * capacity figure. V002 row 22 names that prohibited claim in advance:
 * national-scale capacity extrapolated from a small demonstration. The
 * arithmetic is easy and that is exactly why the refusal is in code.
 *
 * Everything it creates is deleted afterwards, and the projection is rebuilt,
 * because a measurement run that leaves the demonstration drifted has made the
 * next person's dashboard wrong to find out how fast a query is.
 */

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import pg from "pg";

import {
  PERFORMANCE_LIMITS,
  budgetStatement,
  capacityClaimVerdict,
  checkBudget,
  percentileStatement,
  summaryOf,
} from "@vision/domain";
import {
  FilesystemObjectStoreAdapter,
  measureCandidateQuery,
  measureConditions,
  measureConnectionCapacity,
  measureDashboard,
  measureStorageGrowth,
  lastCandidateCounts,
  rebuildSummaries,
  timed,
} from "@vision/adapters";
import { loadOperatingBudgets, loadTaxonomy } from "@vision/config-packs";

import { buildAppWithDatabase } from "../apps/api/src/server.ts";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://vision:vision_local_dev_only@127.0.0.1:5432/vision_dev";
const PROFILE = process.env.JURISDICTION_PROFILE_ID ?? "demo-district-a";

const argOf = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
};
const ITERATIONS = Number(argOf("iterations", "40"));

const client = new pg.Client({ connectionString: DATABASE_URL, statement_timeout: 120_000 });
await client.connect();

const storeRoot = mkdtempSync(join(tmpdir(), "vision-perf-"));
const createdSubmissions = [];
const createdParticipants = [];

const TEST_ENV = {
  IDENTITY_PROVIDER_MODE: "simulated",
  RECIPIENT_PROVIDER_MODE: "simulated",
  IDENTITY_MAPPING_HMAC_KEY: `perf-identity-${randomUUID()}`,
  SESSION_TOKEN_HMAC_KEY: `perf-session-${randomUUID()}`,
  SESSION_TTL_SECONDS: "3600",
  SESSION_COOKIE_SECURE: "false",
  SUPPORTED_LOCALES: "en-IN,mr-IN",
  JURISDICTION_PROFILE_ID: PROFILE,
};

const objectStore = new FilesystemObjectStoreAdapter({
  root: storeRoot,
  grantHmacKey: "perf-object-key-not-a-secret",
});
const { handler } = buildAppWithDatabase(client, objectStore, TEST_ENV);
const server = createServer((request, response) => void handler(request, response));
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

try {
  const conditions = await measureConditions(client, { concurrency: 1 });

  // --- a session, so the HTTP measurements measure the authenticated path ---
  const loginResponse = await fetch(`${baseUrl}/v1/auth/demo-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential: "demo-citizen-one" }),
  });
  const cookies = loginResponse.headers
    .getSetCookie()
    .map((header) => header.split(";")[0])
    .join("; ");
  const csrf = decodeURIComponent(
    (
      loginResponse.headers
        .getSetCookie()
        .map((header) => header.split(";")[0])
        .find((pair) => pair.startsWith("vision_csrf=")) ?? ""
    ).slice("vision_csrf=".length),
  );
  const authed = { cookie: cookies, "x-csrf-token": csrf, "content-type": "application/json" };

  const submissionBody = (index) => ({
    observed: {
      lon: 76.9 + (index % 50) * 0.001,
      lat: 15.2,
      accuracy_m: 12,
      source: "device_geolocation",
      observed_at: new Date().toISOString(),
    },
    interface_locale: "en-IN",
    language_hint: "en-IN",
    text: "Measurement run: the drain by the school gate is blocked.",
    evidence: [],
  });

  // --- 1. receipt latency ---
  const receipt = await timed(
    "receipt_latency",
    "POST /v1/submissions over HTTP with a session and a CSRF token: what a citizen waits for before they are told their report was accepted",
    async (iteration) => {
      const response = await fetch(`${baseUrl}/v1/submissions`, {
        method: "POST",
        headers: { ...authed, "idempotency-key": `perf-${randomUUID()}` },
        body: JSON.stringify(submissionBody(iteration)),
      });
      if (response.status >= 400) throw new Error(`receipt failed: ${response.status}`);
      const body = await response.json();
      if (body.submission_id) createdSubmissions.push(body.submission_id);
    },
    { iterations: ITERATIONS },
  );

  // --- 2. upload behaviour ---
  const JPEG = Buffer.from(
    "ffd8ffe000104a46494600010100000100010000ffdb0043000302020202020302020203030303040604040404040806060506090809090809090a0c0f0c0a0b0e0b09090d110d0e0f101011100a0c12131210130f101010ffc9000b080001000101011100ffcc000600101005ffda0008010100003f00d2cf20ffd9",
    "hex",
  );
  const upload = await timed(
    "upload_grant_and_put",
    "POST /v1/uploads then PUT the bytes: the grant, the signed token and the write, which is what a photograph costs before anything looks at it",
    async () => {
      const grant = await fetch(`${baseUrl}/v1/uploads`, {
        method: "POST",
        headers: authed,
        body: JSON.stringify({ content_type: "image/jpeg", max_bytes: 4096 }),
      });
      if (grant.status >= 400) throw new Error(`grant failed: ${grant.status}`);
      const { upload_url: uploadUrl } = await grant.json();
      const put = await fetch(`${baseUrl}${uploadUrl}`, {
        method: "PUT",
        headers: { cookie: cookies, "content-type": "image/jpeg" },
        body: JPEG,
      });
      if (put.status >= 400) throw new Error(`put failed: ${put.status}`);
    },
    { iterations: Math.min(ITERATIONS, 25) },
  );

  // --- 3. processing delay: accepted to visible ---
  const processing = await timed(
    "processing_delay",
    "the delay between a submission being accepted and its receipt being readable again, which is the part of the wait a citizen sees as 'still processing'",
    async () => {
      const id = createdSubmissions[Math.floor(Math.random() * createdSubmissions.length)];
      if (id === undefined) throw new Error("no submission to read");
      const response = await fetch(`${baseUrl}/v1/submissions/${id}`, { headers: authed });
      if (response.status >= 400) throw new Error(`receipt read failed: ${response.status}`);
      await response.text();
    },
    { iterations: ITERATIONS },
  );

  // --- 4. candidate query ---
  const candidates = await measureCandidateQuery(client, { iterations: ITERATIONS });

  // --- 5. dashboard ---
  const { rows: jurisdictionRows } = await client.query(
    "select jurisdiction_id from jurisdiction where jurisdiction_profile_id = $1 limit 5",
    [PROFILE],
  );
  const taxonomy = loadTaxonomy(PROFILE);
  const dashboard = await measureDashboard(client, {
    iterations: Math.min(ITERATIONS, 20),
    jurisdictionIds: jurisdictionRows.map((row) => String(row.jurisdiction_id)),
    trackedCategories: taxonomy.categoryIds,
    jurisdictionProfileId: PROFILE,
  });

  // --- 6. database connections ---
  const capacity = await measureConnectionCapacity(
    async () => {
      const extra = new pg.Client({ connectionString: DATABASE_URL, statement_timeout: 5_000 });
      await extra.connect();
      return { close: () => extra.end() };
    },
    { ceiling: 80 },
  );

  // --- 7. storage growth ---
  const storage = await measureStorageGrowth(
    client,
    async () => {
      const participantId = randomUUID();
      createdParticipants.push(participantId);
      await client.query("insert into participant (participant_id) values ($1)", [participantId]);
      await client.query(
        `insert into consent_record
           (consent_id, participant_id, notice_version, notice_locale, granted_purposes, granted_at)
         values ($1,$2,'notice.v1','en-IN', ARRAY['demo_processing']::text[], now())`,
        [randomUUID(), participantId],
      );
      const submissionId = randomUUID();
      createdSubmissions.push(submissionId);
      await client.query(
        `insert into submission
           (submission_id, participant_id, observed_location, observed_accuracy_m,
            observed_location_source, observed_at, interface_locale, language_hint,
            locale_pack_version, taxonomy_version, idempotency_key)
         values ($1,$2, ST_SetSRID(ST_MakePoint(76.95,15.25),4326)::geography, 12,
                 'device_geolocation', now(), 'en-IN','en-IN','demo-locales.v1',
                 'demo-taxonomy.v1',$3)`,
        [submissionId, participantId, `perf-storage-${submissionId}`],
      );
      await client.query(
        `insert into evidence_item (evidence_id, submission_id, media_type, content_text)
         values ($1,$2,'text','Measurement run: storage growth sample.')`,
        [randomUUID(), submissionId],
      );
    },
    { iterations: 50 },
  );

  // --- the report ---
  const measurements = [receipt, upload, processing, candidates, dashboard];
  const budgets = loadOperatingBudgets(PROFILE);
  const p95 = (measurement) => {
    const value = summaryOf(measurement).p95;
    return value.kind === "reported" ? value.value : undefined;
  };

  const checks = budgets.budgets.map((entry) => {
    const observed = {
      receipt_latency_p95_ms: p95(receipt),
      candidate_query_p95_ms: p95(candidates),
      dashboard_read_p95_ms: p95(dashboard),
      processing_delay_p95_ms: p95(processing),
      workload_connections_min: capacity.opened,
      storage_bytes_per_issue_max: storage.bytesPerIssue,
      ai_calls_per_report_max: undefined,
    }[entry.name];
    return checkBudget(entry, observed);
  });

  const verdict = capacityClaimVerdict({
    conditions,
    measurements,
    ranOnTheDeployedEnvironment: false,
    dataVolumeMatchesTheClaim: false,
  });

  const lines = [];
  const write = (line = "") => lines.push(line);

  write("# V049 — Performance measurements and operating budgets");
  write();
  write(
    `Measured ${conditions.startedAt} on \`${conditions.host}\` — ${conditions.cpuCount} CPU(s), ${(conditions.totalMemoryBytes / 1024 ** 3).toFixed(1)} GiB, PostgreSQL ${conditions.databaseSettings.server_version}.`,
  );
  write();
  write("## What this run may not be used to say");
  write();
  if (verdict.permitted) {
    write("Every condition this measurement checks is met.");
  } else {
    write(
      "This run **may not back a capacity claim**, and the reasons are listed in full rather than summarised, because the arithmetic that turns a latency into a capacity is easy enough to do by accident.",
    );
    write();
    for (const reason of verdict.reasons) write(`1. ${reason}`);
  }
  write();

  write("## Conditions");
  write();
  write("| Setting | Value |");
  write("| --- | --- |");
  for (const [name, value] of Object.entries(conditions.databaseSettings)) {
    write(`| \`${name}\` | ${value} |`);
  }
  write(`| concurrency during the run | ${conditions.concurrency} (sequential) |`);
  write();
  write("Rows present when the run started — query cost does not stay flat as these grow:");
  write();
  write("| Table | Rows |");
  write("| --- | --- |");
  for (const [table, count] of Object.entries(conditions.rowsPresent)) {
    write(`| \`${table}\` | ${count.toLocaleString("en-IN")} |`);
  }
  write();

  write("## Measurements");
  write();
  write("| Measurement | Observations | Failures | Min | Median | p95 | Max |");
  write("| --- | --- | --- | --- | --- | --- | --- |");
  for (const measurement of measurements) {
    const summary = summaryOf(measurement);
    write(
      `| ${measurement.name} | ${summary.count} | ${summary.failures} | ${
        summary.min === undefined ? "—" : summary.min.toFixed(1)
      } ms | ${percentileStatement(summary.median, "ms")} | ${percentileStatement(summary.p95, "ms")} | ${
        summary.max === undefined ? "—" : summary.max.toFixed(1)
      } ms |`,
    );
  }
  write();
  for (const measurement of measurements) {
    write(`- **${measurement.name}** — ${measurement.operation}`);
  }
  write();
  if (lastCandidateCounts.length > 0) {
    const total = lastCandidateCounts.reduce((sum, value) => sum + value, 0);
    const empty = lastCandidateCounts.filter((value) => value === 0).length;
    write(
      `Candidate retrieval returned ${total} candidate(s) across ${lastCandidateCounts.length} timed queries, of which ${empty} returned none. This is printed beside the latency because **a query that matches nothing is fast**, and a retrieval figure from queries that retrieved nothing measures the index and not the work.`,
    );
    write();
  }

  write("## Database connections");
  write();
  write(
    capacity.reachedCeiling
      ? `Opened ${capacity.opened} concurrent connections without refusal (the run's own ceiling). \`max_connections\` is ${conditions.databaseSettings.max_connections}.`
      : `Opened ${capacity.opened} concurrent connections; the ${capacity.refusedAt}th was refused. \`max_connections\` is ${conditions.databaseSettings.max_connections}, with ${conditions.databaseSettings.superuser_reserved_connections} reserved for superusers.`,
  );
  write();

  write("## Storage growth");
  write();
  write(
    storage.bytesPerIssue === undefined
      ? "Not measured."
      : `${Math.round(storage.bytesPerIssue).toLocaleString("en-IN")} bytes per report, measured as the delta across ${storage.iterations} inserted reports (${storage.beforeBytes.toLocaleString("en-IN")} → ${storage.afterBytes.toLocaleString("en-IN")} bytes of public tables). Measured as a delta rather than divided out of the total, because the total holds fixtures, seeds and several tasks' leftovers and dividing it would attribute all of that to reports.`,
  );
  write();

  write("## AI cost");
  write();
  write(
    "Not exercised by this run: no provider call is made here, so no token is spent. The measured figures are in [the V046 results](V046-evaluation-results.md) — 16 calls, 1 841 input and 230 output tokens for eight reports — and no monetary figure accompanies them, because no price for this model is recorded in the source register.",
  );
  write();

  write("## Budgets");
  write();
  write(`Loaded from \`${budgets.version}\`. ${budgets.note}`);
  write();
  for (const check of checks) write(`- ${budgetStatement(check)}`);
  write();

  write("## What these figures do not establish");
  write();
  for (const limit of PERFORMANCE_LIMITS) write(`- ${limit}`);
  write();

  const { format, resolveConfig } = await import("prettier");
  mkdirSync("deliverables", { recursive: true });
  const target = join("deliverables", "V049-performance-results.md");
  const prettierConfig = await resolveConfig(target);
  writeFileSync(
    target,
    await format(lines.join("\n") + "\n", {
      ...prettierConfig,
      filepath: target,
      parser: "markdown",
    }),
    "utf8",
  );
  console.log(`wrote ${target}`);

  const exceeded = checks.filter((check) => check.within === false);
  if (exceeded.length > 0) {
    console.log("\nbudgets exceeded:");
    for (const check of exceeded) console.log(`  - ${budgetStatement(check)}`);
    process.exitCode = 1;
  } else {
    console.log("every measured budget was within its limit");
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
  // Everything this run created, removed — and the projection put back.
  const cleaner = new pg.Client({ connectionString: DATABASE_URL, statement_timeout: 120_000 });
  await cleaner.connect();
  try {
    if (createdSubmissions.length > 0) {
      await cleaner.query(
        "delete from issue_evidence_link where evidence_id in (select evidence_id from evidence_item where submission_id = any($1::uuid[]))",
        [createdSubmissions],
      );
      await cleaner.query("delete from issue_match where submission_id = any($1::uuid[])", [
        createdSubmissions,
      ]);
      await cleaner.query("delete from evidence_item where submission_id = any($1::uuid[])", [
        createdSubmissions,
      ]);
      await cleaner
        .query(
          "delete from submission_participant_idempotency where submission_id = any($1::uuid[])",
          [createdSubmissions],
        )
        .catch(() => undefined);
      // Order matters and is not swallowed. The outbox and the applied-event
      // claim both reference an event, so they go before it; the event itself
      // outlives the submission it describes, because `aggregate_id` carries no
      // foreign key. An earlier version deleted the events first, the delete
      // failed on the outbox's reference, the failure was caught and ignored,
      // and the orphan events it left made `summaries.dbtest.ts` count events it
      // had not been given. A cleanup that fails quietly is how one tool breaks
      // another's suite.
      await cleaner.query(
        "delete from outbox where event_id in (select event_id from status_event where aggregate_id = any($1::text[]))",
        [createdSubmissions],
      );
      await cleaner.query(
        "delete from summary_applied_event where event_id in (select event_id from status_event where aggregate_id = any($1::text[]))",
        [createdSubmissions],
      );
      await cleaner.query("delete from status_event where aggregate_id = any($1::text[])", [
        createdSubmissions,
      ]);
      await cleaner.query("delete from submission where submission_id = any($1::uuid[])", [
        createdSubmissions,
      ]);
    }
    if (createdParticipants.length > 0) {
      await cleaner
        .query("delete from consent_record where participant_id = any($1::uuid[])", [
          createdParticipants,
        ])
        .catch(() => undefined);
      await cleaner
        .query("delete from participant where participant_id = any($1::uuid[])", [
          createdParticipants,
        ])
        .catch(() => undefined);
    }
    await rebuildSummaries(cleaner, { asOf: new Date() });
  } finally {
    await cleaner.end();
  }
  await client.end();
  await rm(storeRoot, { recursive: true, force: true });
}
