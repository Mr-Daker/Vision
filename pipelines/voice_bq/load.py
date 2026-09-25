"""Steps 1–2 — create the datasets, then load and build the tables.

Idempotent throughout. Staging loads use `WRITE_TRUNCATE` and final tables use
`CREATE OR REPLACE`, so running this twice leaves the same warehouse rather
than double the rows. A loader that appends on re-run is worse than one that
refuses, because the damage is silent and the row counts still look plausible.

Load path: local Parquet is uploaded directly by the client library, which is
the simplest thing that works at this size (33 MB for a million reports).
`VOICE_BIGQUERY_STAGING_BUCKET` switches to a Cloud Storage hop instead, which
is what a dataset large enough to time out a direct upload would need.
"""

from __future__ import annotations

import io

import pandas as pd
from google.cloud import bigquery, storage

from . import config as cfg
from . import schema
from .client import bigquery_client, dataset_exists, run_query


def ensure_datasets(client: bigquery.Client, config: cfg.BigQueryConfig) -> list[str]:
    """Creates the two datasets if absent. Never deletes.

    They are separate datasets rather than separate table prefixes because the
    separation is meant to be enforceable by IAM: the analytics service account
    is granted read on `voice_analytics` only, so a query that reaches for a
    label fails with a permission error instead of returning a good number.
    """
    created = []
    for dataset_id, description in (
        (
            config.analytics,
            "VOICE analytical layer. Facts only — contains no evaluation labels. "
            "Safe to grant to analytics, BigQuery ML and Gemini explanation jobs.",
        ),
        (
            config.evaluation,
            "VOICE evaluation labels. Planted scenario ground truth. "
            "Must NOT be granted to anything that scores, ranks, trains or explains.",
        ),
    ):
        if dataset_exists(client, dataset_id):
            continue
        dataset = bigquery.Dataset(dataset_id)
        dataset.location = config.location
        dataset.description = description
        client.create_dataset(dataset)
        created.append(dataset_id)
    return created


def _frame_for(name: str) -> pd.DataFrame:
    """Reads one pipeline output, preserving identifier leading zeros.

    `state_code` "01" becoming the integer 1 is the defect that broke every
    join the first time this dataset met pandas, so the code columns are read
    as strings on the way in rather than repaired later.
    """
    codes = {
        "state_code": str,
        "district_code": str,
        "district_key": str,
        "block_code": str,
        "locality_code": str,
    }
    if name == "district_infrastructure":
        frames = []
        for sector, path in cfg.INFRASTRUCTURE_SOURCES.items():
            if not path.exists():
                continue
            part = pd.read_csv(path, dtype=codes, low_memory=False)
            part["sector"] = sector
            frames.append(part)
        if not frames:
            raise FileNotFoundError(
                "No infrastructure CSVs found. Run `npm run data:all` first."
            )
        # The four sector tables have different columns by design; a union
        # keeps every column and leaves the others null, which is the honest
        # representation of "this sector has no pupil-teacher ratio".
        return pd.concat(frames, ignore_index=True, sort=False)

    path = cfg.SOURCES[name]
    if not path.exists():
        raise FileNotFoundError(
            f"{path} is missing. Run `npm run data:all` before loading BigQuery."
        )
    if path.suffix == ".parquet":
        frame = pd.read_parquet(path)
    else:
        frame = pd.read_csv(path, dtype=codes, low_memory=False)

    # Pandas leaves an all-null CSV identifier column as object dtype even
    # when `dtype=str` was requested. PyArrow/BigQuery can then infer INTEGER
    # solely because there were no values from which to infer STRING. Use the
    # nullable string extension dtype after every read so identifier schemas
    # remain stable when a future dataset starts populating block/locality
    # codes, while preserving missing values as NULL rather than the text
    # "nan".
    for column in codes:
        if column in frame.columns:
            frame[column] = frame[column].astype("string")
    return frame


def _upload(
    client: bigquery.Client,
    config: cfg.BigQueryConfig,
    frame: pd.DataFrame,
    table_id: str,
) -> int:
    job_config = bigquery.LoadJobConfig(
        write_disposition=bigquery.WriteDisposition.WRITE_TRUNCATE,
        source_format=bigquery.SourceFormat.PARQUET,
    )
    if config.staging_bucket:
        # Cloud Storage hop, for datasets too large to push directly.
        buffer = io.BytesIO()
        frame.to_parquet(buffer, index=False)
        buffer.seek(0)
        blob_name = f"voice-bq-staging/{table_id.rsplit('.', 1)[-1]}.parquet"
        bucket = storage.Client(project=config.project).bucket(config.staging_bucket)
        bucket.blob(blob_name).upload_from_file(buffer, content_type="application/octet-stream")
        uri = f"gs://{config.staging_bucket}/{blob_name}"
        client.load_table_from_uri(uri, table_id, job_config=job_config).result()
    else:
        client.load_table_from_dataframe(frame, table_id, job_config=job_config).result()
    return len(frame)


#: staging table -> the pipeline output that fills it.
STAGING_SOURCES = {
    "_staging_citizen_reports": "citizen_reports",
    "_staging_canonical_issues": "canonical_issues",
    "_staging_district_sector_month": "district_sector_month",
    "_staging_district_master": "district_master",
    "_staging_district_demographics": "district_demographics",
    "_staging_public_projects": "public_projects",
    "_staging_district_infrastructure": "district_infrastructure",
    "_staging_planted_scenarios": "planted_scenarios",
}


def run(drop_staging: bool = True) -> dict[str, int]:
    config = cfg.load()
    client = bigquery_client(config)

    created = ensure_datasets(client, config)
    for dataset_id in created:
        print(f"  created dataset {dataset_id}")

    counts: dict[str, int] = {}
    try:
        # ── Stage ─────────────────────────────────────────────────────────
        # Stage every raw source in the restricted evaluation dataset. Several
        # sources contain planted labels, so staging them in voice_analytics
        # would expose labels to its reader even briefly during a load.
        for staging, source in STAGING_SOURCES.items():
            frame = _frame_for(source)
            rows = _upload(client, config, frame, f"{config.evaluation}.{staging}")
            counts[staging] = rows
            print(f"  staged {staging:38s} {rows:>9,} rows")

        # ── Build ─────────────────────────────────────────────────────────
        for spec in schema.ANALYTICS_TABLES:
            sql = spec.create_sql(config.analytics).replace(
                f"`{config.analytics}.{spec.staging}`",
                f"`{config.evaluation}.{spec.staging}`",
            )
            run_query(client, sql, label=spec.name)
            print(f"  built  {config.analytics_dataset}.{spec.name}")

        for spec in schema.EVAL_TABLES:
            run_query(client, spec.create_sql(config.evaluation), label=spec.name)
            print(f"  built  {config.eval_dataset}.{spec.name}")
    finally:
        # ── Clean up ──────────────────────────────────────────────────────
        # This deliberately runs after success *and* after any exception.
        # Final analytics tables may be incomplete after a failed build (and
        # validation will say so), but raw staging stays inaccessible to the
        # analytics identity even while the load is running.
        if drop_staging:
            for staging in schema.staging_tables():
                client.delete_table(f"{config.evaluation}.{staging}", not_found_ok=True)
            print(f"  dropped {len(schema.staging_tables())} staging tables")

    return counts
