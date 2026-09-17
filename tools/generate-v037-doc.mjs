#!/usr/bin/env node
/**
 * Writes the generated metric reference into the V037 document.
 *
 * The reference is rendered from `METRIC_CATALOGUE` and `METRIC_SQL`, so the
 * published formula is the executed formula. The result is run through
 * Prettier with the repository's own configuration, because `format:check`
 * gates every file and a generator that fights the formatter would leave the
 * document permanently one command away from green.
 *
 * `analytics-doc-sync.test.ts` fails the build when the file on disk is not
 * what this script would write.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { spliceMetricReference } from "@vision/adapters";
import { format, resolveConfig } from "prettier";

const DOC = join(process.cwd(), "docs/foundation/V037-analytics-metric-semantics.md");

const current = readFileSync(DOC, "utf8");
const options = await resolveConfig(DOC);
const updated = await format(spliceMetricReference(current), {
  ...options,
  filepath: DOC,
  parser: "markdown",
});

if (updated === current) {
  console.log("V037 metric reference already up to date.");
} else {
  writeFileSync(DOC, updated, "utf8");
  console.log("V037 metric reference written.");
}
