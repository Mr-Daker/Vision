/**
 * The V037 document and the code that computes V037 are the same thing.
 *
 * A metric definition living in a document and a metric definition living in a
 * query drift in a predictable direction: the query changes because somebody
 * had to make a number come out, and the document stays behind saying what
 * everyone still believes. This test removes that possibility — the reference
 * section is generated, and the build fails if the file on disk is not exactly
 * what the generator would write.
 *
 * Fix a failure with `npm run docs:v037`, never by editing the document.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";

import { METRIC_IDS, METRIC_CATALOGUE } from "@vision/domain";

import { METRIC_PRELUDE_SQL, METRIC_SQL, metricStatement } from "./analytics-metrics.ts";
import { GENERATED_BEGIN, GENERATED_END, spliceMetricReference } from "./analytics-doc.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const DOC_PATH = join(REPO_ROOT, "docs/foundation/V037-analytics-metric-semantics.md");

const document = readFileSync(DOC_PATH, "utf8");

test("the published metric reference is the generated one", async () => {
  const options = await resolveConfig(DOC_PATH);
  const expected = await format(spliceMetricReference(document), {
    ...options,
    filepath: DOC_PATH,
    parser: "markdown",
  });
  assert.equal(
    document,
    expected,
    "docs/foundation/V037-analytics-metric-semantics.md is stale — run `npm run docs:v037`",
  );
});

test("the document carries the generated markers exactly once each", () => {
  assert.equal(document.split(GENERATED_BEGIN).length - 1, 1);
  assert.equal(document.split(GENERATED_END).length - 1, 1);
  assert.ok(document.indexOf(GENERATED_BEGIN) < document.indexOf(GENERATED_END));
});

test("every metric in the catalogue has SQL, and every query has a contract", () => {
  const catalogued = Object.keys(METRIC_CATALOGUE).sort();
  const implemented = Object.keys(METRIC_SQL).sort();
  assert.deepEqual(
    implemented,
    catalogued,
    "a contract with no query, or a query with no contract",
  );
  assert.deepEqual(catalogued, [...METRIC_IDS].sort());
});

test("the published SQL is the executed SQL, character for character", () => {
  for (const id of METRIC_IDS) {
    assert.ok(
      document.includes(METRIC_SQL[id]),
      `${id}: the statement in the document is not the statement that runs`,
    );
    assert.ok(metricStatement(id).endsWith(METRIC_SQL[id]));
    assert.ok(metricStatement(id).startsWith(METRIC_PRELUDE_SQL));
  }
  assert.ok(document.includes(METRIC_PRELUDE_SQL), "the shared prelude must be published too");
});

test("every statement binds both clocks, so neither can be forgotten in one metric", () => {
  // The prelude carries both bounds for every metric that reads events, which
  // is what makes "knowledge at the time" a property of the whole report
  // rather than of whichever query somebody remembered to write it into.
  assert.match(METRIC_PRELUDE_SQL, /occurred_at <= \$1::timestamptz/);
  assert.match(METRIC_PRELUDE_SQL, /recorded_at <= \$2::timestamptz/);
  for (const id of METRIC_IDS) {
    const statement = metricStatement(id);
    assert.match(statement, /occurred_at <= \$1::timestamptz/, `${id} must bound event time`);
    assert.match(statement, /recorded_at <= \$2::timestamptz/, `${id} must bound knowledge time`);
  }
});

test("no metric interpolates a value into its SQL", () => {
  for (const id of METRIC_IDS) {
    const statement = metricStatement(id);
    assert.doesNotMatch(
      statement,
      /\$\{/,
      `${id} must be a static statement with bound parameters`,
    );
  }
});

test("the document states the limits rather than only the contracts", () => {
  for (const claim of [
    /no population source table/i,
    /no effective-dated history/i,
    /MAX_ALIAS_HOPS/,
    /issue_alias` has no `recorded_at/i,
  ]) {
    assert.match(document, claim, `the document must keep stating this limitation`);
  }
});
