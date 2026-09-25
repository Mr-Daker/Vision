# BigQuery deployment — exact commands

Everything needed to stand up the VOICE analytical layer in a Google Cloud
project. The local evaluation does **not** depend on any of this: the analysis
SQL and the held-out evaluation run against local Parquet through DuckDB, so
nothing here blocks the work described in
[`deliverables/V050c-analytics-evaluation.md`](../../deliverables/V050c-analytics-evaluation.md).

No step asks for a service-account key. Locally the pipeline uses Application
Default Credentials; on Cloud Run it uses the service account attached to the
revision. There is no code path in this repository that reads a key file.

## 0. Prerequisites

The SDK is installed (`gcloud 585.0.0`, `bq 2.1.38`). If a teammate needs it:

```bash
brew install --cask google-cloud-sdk
```

## 1. Project and APIs

```bash
export VOICE_PROJECT=your-project-id
export VOICE_REGION=asia-south1

gcloud auth login
gcloud config set project "$VOICE_PROJECT"

gcloud services enable \
  bigquery.googleapis.com \
  bigquerystorage.googleapis.com \
  storage.googleapis.com
```

`asia-south1` (Mumbai) is the default for an India-scale system so the data is
region-resident. Any BigQuery location works; set `BIGQUERY_LOCATION` to match.

## 2. Credentials for local work

```bash
gcloud auth application-default login
gcloud auth application-default set-quota-project "$VOICE_PROJECT"
```

That writes an ADC file under `~/.config/gcloud/`. It is outside the repository
and must stay there.

## 3. Environment

Add to `.env` (already templated in `.env.example`):

```bash
VOICE_BIGQUERY_PROJECT=your-project-id
VOICE_BIGQUERY_DATASET=voice_analytics
VOICE_BIGQUERY_EVAL_DATASET=voice_eval
BIGQUERY_LOCATION=asia-south1
```

## 4. Build the warehouse

```bash
npm run data:all -- --reports 500000 --seed 42   # if not already generated
npm run bigquery:setup      # creates both datasets
npm run bigquery:load       # Parquet -> staging -> partitioned tables
npm run bigquery:views      # analytics_safe_* views + the five analysis views
npm run bigquery:validate   # parity, leakage, partitioning, GEOGRAPHY
```

`bigquery:load` is idempotent — staging uses `WRITE_TRUNCATE` and final tables
use `CREATE OR REPLACE`, so a re-run replaces rather than appends. Raw staging
tables live only in the restricted `voice_eval` dataset, because some source
files carry planted labels. The loader removes them in `finally` after success
or failure; validation checks both datasets for leftover staging tables.

## 5. The IAM boundary that matters

This is the step that makes ground-truth leakage impossible rather than merely
discouraged. The analytics service account gets read on the analytics dataset
**and no grant at all** on the evaluation dataset, so a query reaching for a
planted label fails with a permission error instead of returning a
suspiciously good number.

```bash
# The identity that runs analytics, BigQuery ML and Gemini explanation jobs.
gcloud iam service-accounts create voice-analytics \
  --display-name="VOICE analytics (no evaluation label access)"

ANALYTICS_SA="voice-analytics@${VOICE_PROJECT}.iam.gserviceaccount.com"

# Read on the analytics dataset only.
bq add-iam-policy-binding \
  --member="serviceAccount:${ANALYTICS_SA}" \
  --role="roles/bigquery.dataViewer" \
  "${VOICE_PROJECT}:voice_analytics"

# If this bq subcommand says it requires allowlisting, set the same dataset
# access entry through the BigQuery dataset Access pane or datasets.patch API.
# Do not replace it with a project-wide dataViewer grant.

# Needed to run queries at all; does not grant data access.
gcloud projects add-iam-policy-binding "$VOICE_PROJECT" \
  --member="serviceAccount:${ANALYTICS_SA}" \
  --role="roles/bigquery.jobUser"

# Deliberately NOT run, and this omission is the control:
#   bq add-iam-policy-binding ... "${VOICE_PROJECT}:voice_eval"
```

Verify the boundary holds rather than assuming it:

```bash
gcloud auth print-access-token --impersonate-service-account="$ANALYTICS_SA" >/dev/null
bq --project_id="$VOICE_PROJECT" query --use_legacy_sql=false \
  'SELECT COUNT(*) FROM `'"$VOICE_PROJECT"'.voice_eval.planted_scenarios`'
# Expected: Access Denied. A row count here means the boundary is not in place.
```

The evaluation runner is a separate identity (or a human with
`bigquery.dataViewer` on both datasets). It is the only thing permitted to join
predictions to labels.

For `vision-new-india`, the dataset access entries were set with the
BigQuery API because this `bq` installation rejected the binding subcommand.
The analytics identity was verified to read `voice_analytics` and receive 403
from `voice_eval`. The old `vision-508301` datasets were left untouched.

## 6. Optional — Cloud Storage staging

Only needed if a dataset grows large enough that a direct upload times out.

```bash
gcloud storage buckets create "gs://${VOICE_PROJECT}-voice-staging" \
  --location="$VOICE_REGION" --uniform-bucket-level-access
```

Then set `VOICE_BIGQUERY_STAGING_BUCKET=${VOICE_PROJECT}-voice-staging`.

## 7. Cost awareness

At the current dataset size this is small, but the shape of the cost matters
more than today's number.

| Item | Size / rate | Note |
| --- | --- | --- |
| Storage | ~40 MB for 500k reports | Effectively free; well inside the 10 GB free tier. |
| Query | 1 TiB/month free, then ~$6.25/TiB | A full scan of `citizen_reports` is ~35 MB, so ~30,000 full scans fit in the free tier. |
| Partition pruning | — | Trend queries touch 3–12 of 24 monthly partitions. This is why partitioning exists here at this size: not for storage, for the bill at scale. |
| Gemini | per call | **Not yet wired.** When it is, explanations must be precomputed per surfaced signal and cached — never per report row. Hundreds of thousands of rows through a model is the one genuinely expensive mistake available in this architecture. |

Controls worth setting before anyone else uses the project:

```bash
# Cap accidental full-table scans during development.
bq query --use_legacy_sql=false --maximum_bytes_billed=1000000000 'SELECT ...'

# A budget alert is the backstop that catches what review misses.
gcloud billing budgets create \
  --billing-account="$(gcloud billing projects describe "$VOICE_PROJECT" \
      --format='value(billingAccountName)' | cut -d/ -f2)" \
  --display-name="VOICE development" \
  --budget-amount=25USD \
  --threshold-rule=percent=50 --threshold-rule=percent=90
```

## 8. Teardown

```bash
bq rm -r -f -d "${VOICE_PROJECT}:voice_analytics"
bq rm -r -f -d "${VOICE_PROJECT}:voice_eval"
```

Both are rebuilt from the local pipeline in minutes, so deleting them to stop
costs between demos loses nothing.
