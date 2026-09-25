# V050b — BigQuery deployment and parity report

- **Run date:** 2026-09-22
- **Google Cloud project:** `vision-508301`
- **Region:** `asia-south1`
- **Source commit at start of deployment:** `9f40ace798f568c6258dd03fcb9ed2d20e756d0d`
- **Status:** deployed; source-table parity and published decision parity pass; full-cell analytical parity is not yet complete.

## 1. What was deployed

Only BigQuery was used. No Cloud Storage bucket, BigQuery ML model, Vertex AI
resource, Cloud Run service, or service account was created.

| Dataset                         | Contents                                                        | Rows in stored tables | Stored bytes |
| ------------------------------- | --------------------------------------------------------------- | --------------------: | -----------: |
| `vision-508301.voice_analytics` | 7 source tables, 4 safe views, 1 feature view, 5 analysis views |               633,509 |  301,943,300 |
| `vision-508301.voice_eval`      | 3 label-only tables                                             |               127,007 |    7,621,106 |

The analytical source tables contain 500,000 citizen reports, 66,653 canonical
issues, 60,192 district-sector-month rows, 627 districts, 2,902 synthetic
projects, 627 demographic rows and 2,508 infrastructure rows. The grain is 627
districts × 4 sectors × 24 months. All loads use replacement semantics and all
eight temporary staging tables were removed.

The first live deployment exposed four implementation defects, fixed outside
the frozen analysis SQL:

1. `public_projects` attempted to partition on `DATE(sanction_date)` even
   though the CTAS output was already a `DATE`; it now partitions directly on
   `sanction_date`.
2. A failed load could leave label-bearing staging tables in
   `voice_analytics`; staging cleanup now runs in `finally`, and an executable
   failure-path test proves all staging tables are removed.
3. BigQuery cannot group on `GEOGRAPHY`; the district profile now rebuilds its
   deterministic point from grouped longitude/latitude values.
4. Suffixed frozen-SQL placeholders were quoted as
   `` `dataset.analytics_features`_unmet_need ``. The binder now keeps the
   suffix inside the quoted identifier. The six frozen SQL files were not
   changed.

All-null block/locality identifiers were also being inferred as integers. The
loader now uses pandas' nullable string dtype so identifier schemas remain
stable when those fields acquire values.

## 2. Source-table parity

The deployed tables match the local pipeline for all required source-level
properties:

- row counts: exact for all seven analytical tables;
- column names and BigQuery types: exact for all seven tables;
- null counts: exact for every column in every table;
- dimensions: 627 districts, 4 sectors and 24 months;
- aggregates: 500,000 reports, 482,044 monthly unique-citizen observations,
  207,397 monthly canonical-issue observations, and matching sanctioned,
  released and spent totals;
- provenance: exact, including 151 real and 2,357 derived infrastructure
  cells, and 3,624 real versus 56,568 derived monthly infrastructure rows;
- coordinates: all 500,000 report points, 66,653 issue points and 627 district
  points are non-null `GEOGRAPHY` values inside the declared India bounding
  box;
- partitioning and clustering: applied exactly as declared.

The numeric comparator uses `rtol=1e-9` and `atol=1e-10`. Identifiers,
strings, booleans, dates, schemas, keys and null placement require exact
equality.

## 3. Analytical parity result

Every policy-facing decision matches exactly between DuckDB and BigQuery:

| Analysis         | Keyed rows | Exact decision columns                        |
| ---------------- | ---------: | --------------------------------------------- |
| unmet need       |      2,508 | `sufficient_evidence`, `potential_unmet_need` |
| investment       |      2,508 | the above plus `investment_classification`    |
| execution gap    |        205 | `sufficient_evidence`, `execution_finding`    |
| emerging hotspot |      2,508 | `sufficient_evidence`, `emerging_hotspot`     |
| silent need      |      2,508 | `possible_under_reporting`                    |

Execution-gap tables match fully. Four other tables are not cell-for-cell
identical:

| Analysis         | Observed difference                                                                                                                        | Decision impact |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------- |
| unmet need       | `citizen_demand_signal` differs in 61 rows; maximum absolute difference 0.00319489                                                         | none            |
| investment       | inherits the same 61 percentile differences                                                                                                | none            |
| emerging hotspot | 2 `reason_codes` differ at the exact `growth_ratio = 2` boundary                                                                           | none            |
| silent need      | in the final run, 174 `deficit_band` rows moved by one band; 504 expected-rate/shortfall values, 418 ratios and 18 `reason_codes` differed | none            |

Cause: the frozen SQL orders `PERCENT_RANK` and `NTILE` only by floating or
tied values. BigQuery and DuckDB are both entitled to choose a different order
inside ties, and floating aggregation can land on opposite sides of an exact
reason-code threshold. Silent-need difference counts changed between two
validation executions without any data or SQL change, further confirming the
unspecified tie order. This is not ordinary floating-point noise: accepting an
integer band difference under a floating tolerance would conceal the defect.

The validator therefore exits non-zero: 59 of 63 checks pass. Full-table
parity cannot be claimed while the frozen SQL remains unchanged. Correcting it
would require a separately approved rule revision that adds stable tie-breakers
and rounds values before boundary comparisons, followed by a new SQL freeze
and re-evaluation. That was explicitly out of scope for this deployment.

## 4. Leakage verification

The following controls passed:

- no forbidden ground-truth/scenario column exists anywhere in
  `voice_analytics`;
- all named labels are absent from the three analytics copies that originate
  from labelled sources;
- the three label tables are populated only in `voice_eval`;
- no `_staging_*` table remains in `voice_analytics` after success or failure;
- each shipped analysis passes the static label-table and label-column guards;
- local analyses run before labels are loaded for evaluation;
- the frozen manifest verifies all six SQL files by SHA-256.

IAM isolation was **not** demonstrated. The deployment used personal
Application Default Credentials for `cs25m030@smail.iitm.ac.in`, which has
`roles/owner` on the project. Both datasets currently inherit project-owner,
project-writer and project-reader access, and the user is an explicit dataset
owner. That identity can read both datasets, so a successful query is not proof
of a production boundary. Demonstrating IAM denial requires a dedicated
analytics service account with dataset-level read access only to
`voice_analytics`, and a separate evaluator identity for `voice_eval`; neither
was created to keep this deployment within the requested minimal-service scope.

## 5. Verification commands

```text
npm run bigquery:test                       12/12 pass
npm run bigquery:views                      10/10 created
npm run bigquery:validate                   59/63 pass; four full-table parity failures above
npm run analytics:report                    completed; SQL freeze valid
```

Python 3.9 and LibreSSL warnings are environmental, not observed data errors,
but the runtime should be upgraded to Python 3.11+ with OpenSSL before a
production deployment. `pandas-gbq>=0.26.1` should also be added before the
BigQuery client makes it a hard requirement.
