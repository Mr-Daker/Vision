/**
 * Renders the V037 metric reference from the code that computes it.
 *
 * A metric definition living in a document and a metric definition living in a
 * query will drift, and the direction of that drift is predictable: the query
 * changes because somebody had to make a number come out, and the document
 * stays behind saying what everyone still believes. The reference section of
 * `docs/foundation/V037-analytics-metric-semantics.md` is therefore generated
 * from `METRIC_CATALOGUE` and `METRIC_SQL`, written by `npm run docs:v037`,
 * and asserted byte-for-byte by `analytics-doc-sync.test.ts`.
 *
 * Only the reference section is generated. The reasoning above it is written
 * by hand, because the argument for why a metric is shaped the way it is does
 * not follow from the shape.
 */

import { METRIC_IDS, METRIC_CATALOGUE, type MetricContract } from "@vision/domain";

import { METRIC_PRELUDE_SQL, METRIC_SQL } from "./analytics-metrics.ts";

export const GENERATED_BEGIN = "<!-- BEGIN generated: metric reference. npm run docs:v037 -->";
export const GENERATED_END = "<!-- END generated: metric reference -->";

const AGGREGATION_TEXT: Readonly<Record<MetricContract["aggregation"], string>> = {
  additive: "Additive across disjoint areas of one boundary version.",
  not_additive: "**Not additive.** Two areas cannot be added; recompute over the combined area.",
  requires_exclusive_boundaries:
    "**Only across boundaries proven not to overlap.** Unproven disjointness yields UNKNOWN.",
};

const denominatorText = (contract: MetricContract): string =>
  contract.denominator.kind === "population"
    ? contract.denominator.of
    : `None — ${contract.denominator.why}`;

const horizonText = (contract: MetricContract): string =>
  contract.horizon === "as_of" ? "`:as_of`" : "`[:window_start, :window_end)`, read at `:as_of`";

const list = (items: readonly string[]): string =>
  items.length === 0 ? "None." : items.join("; ");

const section = (contract: MetricContract): string =>
  [
    `### ${contract.id} — ${contract.title}`,
    "",
    contract.meaning,
    "",
    "| Field | Contract |",
    "| --- | --- |",
    `| Unit | ${contract.unit} |`,
    `| Numerator | ${contract.numerator} |`,
    `| Denominator | ${denominatorText(contract)} |`,
    `| Cohort | ${contract.cohort} |`,
    `| Horizon | ${horizonText(contract)} |`,
    `| Inclusions | ${list(contract.inclusions)} |`,
    `| Exclusions | ${list(contract.exclusions)} |`,
    `| Alias semantics | ${contract.aliasSemantics} |`,
    `| Corrections | ${contract.corrections} |`,
    `| Missing data | ${contract.missingData} |`,
    `| Aggregation | ${AGGREGATION_TEXT[contract.aggregation]} |`,
    `| Disclosures | ${list(contract.disclosures)} |`,
    "",
    "```sql",
    METRIC_SQL[contract.id],
    "```",
  ].join("\n");

/** The generated reference, exactly as it must appear between the markers. */
export const renderMetricReference = (): string =>
  [
    GENERATED_BEGIN,
    "",
    "## Metric reference",
    "",
    "Generated from `packages/domain/src/metric-semantics.ts` and",
    "`packages/adapters/src/analytics-metrics.ts` by `npm run docs:v037`. Edit those files,",
    "not this section: `analytics-doc-sync.test.ts` fails the build if the two disagree.",
    "",
    "Every statement below is executed by appending it to the shared prelude and binding",
    "`$1` as-of, `$2` knowledge cutoff, `$3` live-horizon flag, `$4` window start,",
    "`$5` window end, `$6` fixed-window days. Nothing else is interpolated, so any of them",
    "can be replayed against the database by hand.",
    "",
    "### Shared prelude",
    "",
    "```sql",
    METRIC_PRELUDE_SQL,
    "```",
    "",
    ...METRIC_IDS.map((id) => `${section(METRIC_CATALOGUE[id])}\n`),
    GENERATED_END,
  ].join("\n");

/** Splices the generated reference into a document, replacing any earlier one. */
export const spliceMetricReference = (document: string): string => {
  const rendered = renderMetricReference();
  const begin = document.indexOf(GENERATED_BEGIN);
  const end = document.indexOf(GENERATED_END);
  if (begin === -1 || end === -1 || end < begin) {
    return `${document.trimEnd()}\n\n${rendered}\n`;
  }
  return `${document.slice(0, begin)}${rendered}${document.slice(end + GENERATED_END.length)}`;
};
