#!/usr/bin/env node
/**
 * The resolution-durability read (roadmap V050a).
 *
 * Usage:
 *   npm run durability:report
 *   npm run durability:report -- --days 180 --signal did_not_hold
 *
 * Reports whether resolutions lasted. It does not report on people, it does not
 * rank units against one another, and it prints the explanations it cannot rule
 * out beside every figure rather than beneath the table.
 */

import pg from "pg";

import {
  DURABILITY_LIMITS,
  DURABILITY_SIGNALS,
  RANKING_REFUSAL,
  SIGNAL_MEANING,
  concernsFrom,
  durabilityFigure,
  figureStatement,
} from "@vision/domain";
import { readDurability } from "@vision/adapters";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://vision:vision_local_dev_only@127.0.0.1:5432/vision_dev";

const argOf = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
};
const days = Number(argOf("days", "120"));
const only = argOf("signal", null);

const client = new pg.Client({ connectionString: DATABASE_URL, statement_timeout: 120_000 });
await client.connect();

try {
  const reading = await readDurability(client, { asOf: new Date(), days });
  const signals = only === null ? DURABILITY_SIGNALS : [only];

  console.log(
    `resolution durability over ${String(days)} days — ${String(reading.totalClaims)} completion claim(s) across ${String(reading.observations.length)} unit(s)\n`,
  );

  if (reading.totalClaims === 0) {
    console.log("no completion claim in this window, so there is nothing to measure.");
    console.log("`npm run db:seed:durability` writes a synthetic history at a volume that can be.");
  }

  for (const signal of signals) {
    const meaning = SIGNAL_MEANING[signal];
    if (meaning === undefined) {
      console.error(`unknown signal '${signal}'; one of: ${DURABILITY_SIGNALS.join(", ")}`);
      process.exit(64);
    }
    console.log(`── ${signal} ──`);
    console.log(`   ${meaning.observed}\n`);
    for (const observation of reading.observations) {
      const figure = durabilityFigure(observation, signal);
      console.log(`   ${observation.unit.label.padEnd(30)} ${figureStatement(figure)}`);
    }
    console.log();
  }

  // The only ordering this produces: units whose interval does not overlap the
  // rest of the organisation pooled. Everything else is left unsorted on
  // purpose.
  const concerns = signals.flatMap((signal) =>
    concernsFrom({ observations: reading.observations, signal }),
  );

  console.log("── worth a person looking at ──\n");
  if (concerns.length === 0) {
    console.log(
      "   No unit's figure can be distinguished from the rest of the organisation on this",
    );
    console.log("   evidence. That is not the same as every unit being fine — see the limits.\n");
  } else {
    for (const concern of concerns) {
      console.log(`   ${concern.unit.label} — ${concern.signal}`);
      console.log(`     this unit: ${figureStatement(concern.figure)}`);
      console.log(`     everyone else: ${figureStatement(concern.baseline)}`);
      console.log(`     observed: ${concern.observed}`);
      console.log(`     this cannot rule out:`);
      for (const alternative of concern.alternatives) console.log(`       - ${alternative}`);
      console.log(`     next step: ${concern.nextStep}\n`);
    }
  }

  console.log(`on ordering: ${RANKING_REFUSAL}\n`);
  console.log("what this does not establish:");
  for (const limit of DURABILITY_LIMITS) console.log(`  - ${limit}`);
} finally {
  await client.end();
}
