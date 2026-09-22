# V050b — BigQuery analytical layer

**Roadmap task:** V050b (added from the VOICE national-analytics requirement, not from the original roadmap) · **Prerequisites:** V037, V038, V039, V046, V050a, VOICE data foundation · **Owner:** Data + Platform
**Code:** `pipelines/voice_bq/` · **Commands:** `npm run bigquery:setup`, `bigquery:load`, `bigquery:validate`, `analytics:run`, `analytics:evaluate`
**Consumes:** `pipelines/voice_data/` output under `data/` · **Does not replace it.**

## 1. Why this exists

The system can already say what has been reported and where. It cannot say
whether anything is **getting worse**.

Every analytical surface built so far — `summary_cell`, the M01–M15 metric
contracts, the district dashboard — is graded at `jurisdiction × category`.
There is no month bucketing anywhere in `packages/adapters/src`; no
`date_trunc` appears in any adapter. `summary_issue_fact` carries `opened_at`
but nothing ever buckets it. That is not an oversight, it is the grain the
projection was designed at, and it is the right grain for an operational
backlog view.

It is the wrong grain for the question VOICE exists to answer. "Where should
national investment go next?" requires comparing a district against its own
past and against every other district, across 24 months and four sectors —
60,192 cells before any join to investment or demographics. Four of the five
analyses this layer must support (emerging hotspot, execution gap, persistence,
expected-versus-observed reporting) are **temporal by definition** and cannot be
expressed at the existing grain at all.

So the justification for a warehouse here is not row count. PostgreSQL would
hold a million reports without complaint. It is that the operational store is
correctly shaped for operations, and reshaping it for national time-series
analytics would damage it. The separation is the point:

```
PostgreSQL (Cloud SQL)          BigQuery
operational state               analytical state
issue lifecycle, grants,        district × sector × month,
outbox, evidence metadata,      trends, cohorts, forecasts,
PostGIS matching, pgvector      GIS aggregation, ML
```

## 2. What this layer must not do

**It must not become a second source of truth.** `pipelines/voice_data/`
remains the only place that downloads, cleans, validates and generates. This
layer loads that output and queries it. Provenance columns (`data_origin`,
`source_name`, `source_year`) travel into every BigQuery table unchanged; a
warehouse that lost the real/derived/synthetic distinction would undo the
foundation it was built on.

**It must not re-derive semantics that already exist.** The metric contracts in
`packages/domain/src/metric-semantics.ts` (M01–M15), the Wilson-interval
`Figure` type in `evaluation.ts`, and the `AggregationSafety` rules are the
project's settled answers to "what may this number be summed with?". SQL that
quietly re-invents them will drift from the application. Where this layer
computes something those files already define, it mirrors their definition and
says so in a comment.

**It must not publish a composite score.** `prioritization.ts` deliberately has
no `rank` field, `resolution-durability.ts` carries a `RANKING_REFUSAL`, and
`trust-signals.ts` states it has no composite score. The analyses below emit
named component signals and `reason_codes`, never one opaque number a
policymaker cannot argue with.

## 3. Ground-truth separation

The generated dataset contains planted evaluation labels. These must never
reach scoring logic, ML features, or Gemini.

Column-level discipline is not enough, because it relies on every future query
author remembering. The control is **two physically separate datasets**:

```
voice_analytics    every fact, no labels.        Read by analytics, BQML, Gemini.
voice_eval         labels only.                  Read by evaluation. Nothing else.
```

This makes leakage an IAM boundary rather than a code-review promise: the
service account that runs analytics is granted `roles/bigquery.dataViewer` on
`voice_analytics` alone, and a query that reaches for a label fails with a
permission error rather than returning a suspiciously good number.

Withheld from `voice_analytics` entirely:

| Table                   | Columns held back                                                                                                                                                                                                      |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `district_sector_month` | `scenario_id`, `ground_truth_scenario`, `expected_interpretation`, `ground_truth_unmet_need`, `ground_truth_investment_gap`, `ground_truth_execution_gap`, `ground_truth_emerging_hotspot`, `ground_truth_silent_need` |
| `citizen_reports`       | `scenario_id`                                                                                                                                                                                                          |
| `canonical_issues`      | `severity_ground_truth`, `true_status`, `true_project_overlap`, `true_infrastructure_deficit`, `scenario_id`                                                                                                           |
| all                     | `planted_scenarios` is loaded to `voice_eval` only                                                                                                                                                                     |

`canonical_issue_id` stays on `citizen_reports` in `voice_analytics`: it is the
operational grouping key the product genuinely has, not a planted label. It is
withheld only when deduplication itself is the thing being evaluated.

## 4. Physical design

Partitioning and clustering are chosen from the actual query shapes, not by
reflex. `district_demographics` and `district_infrastructure` are 627 rows and
are deliberately **not** partitioned — partition metadata would cost more than
it saves.

| Table                     | Partition              | Cluster                                | Reason                                                                                                 |
| ------------------------- | ---------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `citizen_reports`         | `DATE(created_at)`     | `state_code, district_key, sector`     | The large table. Every analysis is time-windowed, and the filter path is always geography then sector. |
| `district_sector_month`   | `month_start`, monthly | `state_code, district_key, sector`     | 60k rows: partitioning is for trend-window pruning, not size.                                          |
| `canonical_issues`        | `DATE(first_seen_at)`  | `district_key, sector`                 | Persistence and emergence queries scan by first appearance.                                            |
| `public_projects`         | `DATE(sanction_date)`  | `district_key, sector, project_status` | Execution-gap joins filter on status and completion date.                                              |
| `district_demographics`   | none                   | `state_code`                           | 627 rows.                                                                                              |
| `district_infrastructure` | none                   | `state_code, sector`                   | 2,508 rows.                                                                                            |

**GEOGRAPHY.** `citizen_reports.location` and `canonical_issues.location` are
`GEOGRAPHY`, built with `ST_GEOGPOINT(longitude, latitude)`. Used for spatial
concentration of reports around an issue and for report-to-asset distance —
work BigQuery GIS does natively and we would otherwise hand-roll.

One honest constraint travels with them, repeated in the view definitions:
**these coordinates are `derived`**. `pipelines/voice_data` places each district
at a deterministic point inside its state, not at a centroid, because no
licence-clean boundary source was available. District-level aggregation over
them is sound. Sub-district distance analysis is not, and must not be presented
as if it were.

## 5. Ingestion

`pipelines/voice_bq/` is a Python package beside `voice_data`, reading its
Parquet output. Parquet rather than CSV throughout: typed, compressed, and
loadable by BigQuery without a schema guess.

Loads are **idempotent**. Each table is written with `WRITE_TRUNCATE`, so a
re-run replaces rather than appends — a loader that doubled the row count on a
second run would be worse than one that failed.

Credentials come from **Application Default Credentials** locally and the
service account's own identity on Cloud Run. No key file is committed, pasted,
or read from the repository. Project, dataset and location come from
environment variables; nothing is hard-coded.

## 6. Local validation without a cloud project

The analyses are written in the SQL subset BigQuery and DuckDB share — CTEs,
window functions, standard aggregates, `x / NULLIF(y, 0)` instead of
`SAFE_DIVIDE`, and the master table's existing `year`/`month` columns instead of
`DATE_TRUNC`, whose argument order differs between the two. Only the table
prefix is templated.

The same file therefore runs against BigQuery and against DuckDB reading the
local Parquet. DuckDB is **validation only** — it is not a second warehouse and
nothing depends on it in production. It exists so the evaluation numbers are
real before a cloud project exists, and so a SQL change can be checked in
seconds without a billed query.

## 7. What this enables next

V050c consumes these views for five analyses (unmet need, investment gap,
execution gap, emerging hotspot, silent need), each emitting component signals
and reason codes, evaluated against `voice_eval` with precision, recall, F1,
Recall@K and NDCG@K — each reported with a Wilson interval, per the discipline
`packages/domain/src/evaluation.ts` already applies.

BigQuery ML is deliberately **not** part of this task. A forecast or an
expected-reporting model is only worth adding once an interpretable baseline
exists to compare it against, and if it does not beat that baseline, the
honest outcome is to keep the baseline and record that it did not.
