#!/usr/bin/env node
/**
 * The V050 signal read (roadmap V050).
 *
 * Usage:
 *   npm run monitor:check     exits non-zero when a signal is past its budget
 *   npm run monitor:report    the same read, printed for a person
 *
 * It reads seven signals from the operational tables and compares each against
 * the budget V049 recorded for it. It delivers nothing anywhere: this is the
 * signal and its threshold, not a pager, and the runbook says so rather than
 * letting somebody assume an alert will find them.
 *
 * Every alert carries identifiers, counts and codes, and never a report's
 * content — an alert is forwarded, screenshotted and pasted into a group chat,
 * so V005 §7 is at its strictest here rather than its loosest.
 */

import pg from "pg";

import { MONITORING_LIMITS, alertStatement, monitoringVerdict } from "@vision/domain";
import { alertsFrom, readSignals } from "@vision/adapters";
import { loadOperatingBudgets } from "@vision/config-packs";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://vision:vision_local_dev_only@127.0.0.1:5432/vision_dev";
const PROFILE = process.env.JURISDICTION_PROFILE_ID ?? "demo-district-a";

const command = process.argv[2] ?? "report";
if (command !== "check" && command !== "report") {
  console.error(`unknown command: ${command}\nusage: node tools/monitor.mjs [check|report]`);
  process.exit(64);
}

const client = new pg.Client({ connectionString: DATABASE_URL, statement_timeout: 60_000 });
await client.connect();

try {
  const budgets = loadOperatingBudgets(PROFILE);
  const readings = await readSignals(client, { asOf: new Date() });
  const alerts = alertsFrom(readings, budgets.budgets);
  const verdict = monitoringVerdict({ readings, alerts });

  console.log(`signals read at ${new Date().toISOString()} (budgets ${budgets.version}):\n`);
  for (const reading of readings) {
    const firing = alerts.some((entry) => entry.signal === reading.signal);
    const value =
      reading.value === undefined
        ? `UNREADABLE — ${reading.unavailable ?? "no reason recorded"}`
        : `${reading.value} ${reading.unit}`;
    console.log(`  ${firing ? "!!" : "ok"} ${reading.signal}: ${value}`);
    if (reading.examples.length > 0) console.log(`       ${reading.examples.join(" ")}`);
  }

  if (alerts.length > 0) {
    console.log("\nalerts:\n");
    for (const entry of alerts) console.log(`${alertStatement(entry)}\n`);
  }

  console.log("what this does not establish:");
  for (const limit of MONITORING_LIMITS) console.log(`  - ${limit}`);

  if (verdict.noWatchedSignalIsFiring) {
    console.log("\nno watched signal is past its budget.");
  } else {
    console.log("\nnot clean:");
    for (const reason of verdict.reasons) console.log(`  - ${reason}`);
    if (command === "check") process.exitCode = 1;
  }
} finally {
  await client.end();
}
