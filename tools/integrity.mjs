#!/usr/bin/env node
/**
 * The integrity check and the operator's copy of it (roadmap V048).
 *
 * Usage:
 *   npm run integrity:check     exits non-zero on any finding, so it can gate
 *   npm run integrity:report    the same run, printed for a person to read
 *
 * The difference between the two is the exit code and nothing else. A check
 * that only a human reads is a check nobody runs on a Sunday, and a gate that
 * prints nothing useful is a gate somebody disables.
 *
 * It repairs nothing. Every finding carries the procedure an operator follows,
 * because a detection they cannot act on is an alarm with no exit — and because
 * a tool that quietly fixed what it found would destroy the evidence of how it
 * broke.
 */

import pg from "pg";

import { INTEGRITY_LIMITS, findingStatement, integrityVerdict } from "@vision/domain";
import { runIntegrityChecks } from "@vision/adapters";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://vision:vision_local_dev_only@127.0.0.1:5432/vision_dev";

const command = process.argv[2] ?? "report";
if (command !== "check" && command !== "report") {
  console.error(`unknown command: ${command}\nusage: node tools/integrity.mjs [check|report]`);
  process.exit(64);
}

const client = new pg.Client({ connectionString: DATABASE_URL, statement_timeout: 120_000 });
await client.connect();

try {
  const startedAt = Date.now();
  const outcomes = await runIntegrityChecks(client, {
    asOf: new Date(),
    maxAttempts: Number(process.env.OUTBOX_MAX_ATTEMPTS ?? "5"),
  });
  const verdict = integrityVerdict(outcomes);
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

  const ran = outcomes.filter((outcome) => outcome.ran);
  console.log(
    `integrity: ${ran.length} of ${outcomes.length} check(s) ran in ${elapsed}s against ${DATABASE_URL.replace(/:[^:@]*@/, ":***@")}`,
  );

  for (const outcome of outcomes) {
    if (!outcome.ran) {
      console.log(`  ?  ${outcome.check} — DID NOT RUN: ${outcome.reasonNotRun ?? "no reason"}`);
    } else if (outcome.findings.length === 0) {
      console.log(
        outcome.enforcedBy === undefined
          ? `  ok ${outcome.check}`
          : `  ok ${outcome.check} (the condition cannot occur: ${outcome.enforcedBy} refuses it on write)`,
      );
    } else {
      console.log(`  !! ${outcome.check}`);
    }
  }

  if (verdict.findings.length > 0) {
    console.log("\nfindings, worst first:\n");
    const order = { unrecoverable: 0, repairable_by_operator: 1, repairable_by_rebuild: 2 };
    const sorted = [...verdict.findings].sort(
      (a, b) => order[a.recoverability] - order[b.recoverability],
    );
    for (const finding of sorted) {
      console.log(`[${finding.recoverability}] ${findingStatement(finding)}\n`);
    }
    console.log(
      `${verdict.unrecoverable} unrecoverable, ${verdict.operatorRepairs} needing an operator, ${verdict.rebuildRepairs} a rebuild would fix.`,
    );
  }

  if (verdict.enforcedByTheDatabase > 0) {
    console.log(
      `\n${verdict.enforcedByTheDatabase} of these conditions cannot occur at all: a database constraint refuses them on every write. Those checks are a second opinion, kept because a migration can drop a constraint, and they have never been able to fire.`,
    );
  }

  console.log("\nwhat a clean result does not establish:");
  for (const limit of INTEGRITY_LIMITS) console.log(`  - ${limit}`);

  if (verdict.everyCheckRanAndFoundNothing) {
    console.log("\nevery check ran and found nothing.");
  } else {
    console.log("\nthis run is not clean:");
    for (const reason of verdict.reasons) console.log(`  - ${reason}`);
  }

  if (command === "check" && !verdict.everyCheckRanAndFoundNothing) {
    process.exitCode = 1;
  }
} finally {
  await client.end();
}
