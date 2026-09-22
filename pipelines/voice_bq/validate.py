"""Step 4 — prove the warehouse matches the pipeline, and that nothing leaked.

Two kinds of check, and the second is the one that matters.

**Parity.** Row counts in BigQuery against the local Parquet the load came
from. Cheap, and catches a partial load, a silently failed job, or a stale
warehouse being queried as if it were current.

**Leakage.** Every column in the analytics dataset is tested against the
forbidden-name patterns. `SELECT * EXCEPT (...)` in `schema.py` states the
intent, but it silently *keeps* any label column added upstream later — so the
intent is not self-enforcing and this check is what enforces it. If someone
adds `ground_truth_something` to the master table next month, the build fails
here rather than quietly improving every evaluation score.

Non-zero exit on failure, so it can gate a deploy.
"""

from __future__ import annotations

from dataclasses import dataclass

import pandas as pd

from . import config as cfg
from . import schema
from .client import bigquery_client, column_names, dataset_exists, run_query, table_row_count
from .load import STAGING_SOURCES, _frame_for


@dataclass
class Check:
    name: str
    passed: bool
    detail: str


def run() -> list[Check]:
    config = cfg.load()
    client = bigquery_client(config)
    checks: list[Check] = []

    def add(name: str, passed: bool, detail: str) -> None:
        checks.append(Check(name, bool(passed), detail))

    # ── Datasets ──────────────────────────────────────────────────────────
    for dataset_id, label in ((config.analytics, "analytics"), (config.evaluation, "eval")):
        add(f"dataset_exists_{label}", dataset_exists(client, dataset_id), dataset_id)

    # ── Leakage: no label-shaped column anywhere in analytics ─────────────
    leaked: list[str] = []
    for spec in schema.ANALYTICS_TABLES:
        table_id = f"{config.analytics}.{spec.name}"
        try:
            columns = column_names(client, table_id)
        except Exception:  # noqa: BLE001 — a missing table is reported by parity below
            continue
        for column in columns:
            lowered = column.lower()
            if column in schema.FORBIDDEN_EXEMPTIONS:
                continue
            if any(pattern in lowered for pattern in schema.FORBIDDEN_SUBSTRINGS):
                leaked.append(f"{spec.name}.{column}")
    add(
        "no_evaluation_labels_in_analytics",
        not leaked,
        "clean" if not leaked else f"LEAKED: {', '.join(leaked)}",
    )

    for spec in schema.ANALYTICS_TABLES:
        table_id = f"{config.analytics}.{spec.name}"
        try:
            columns = set(column_names(client, table_id))
        except Exception:  # noqa: BLE001
            continue
        expected_absent = {
            "citizen_reports": schema.REPORT_LABELS,
            "canonical_issues": schema.ISSUE_LABELS,
            "district_sector_month": schema.MASTER_LABELS,
        }.get(spec.name, ())
        present = sorted(columns & set(expected_absent))
        if expected_absent:
            add(
                f"labels_excluded_{spec.name}",
                not present,
                "excluded" if not present else f"still present: {present}",
            )

    # ── Evaluation labels actually landed somewhere ───────────────────────
    # A leakage control that worked by losing the labels would pass the check
    # above and make evaluation impossible, so both sides are asserted.
    for spec in schema.EVAL_TABLES:
        rows = table_row_count(client, f"{config.evaluation}.{spec.name}")
        add(
            f"eval_table_populated_{spec.name}",
            bool(rows),
            f"{rows:,} rows" if rows else "missing or empty",
        )

    # ── Parity against the local pipeline output ──────────────────────────
    for staging, source in STAGING_SOURCES.items():
        table = {
            "_staging_citizen_reports": "citizen_reports",
            "_staging_canonical_issues": "canonical_issues",
            "_staging_district_sector_month": "district_sector_month",
            "_staging_district_master": "district_master",
            "_staging_district_demographics": "district_demographics",
            "_staging_public_projects": "public_projects",
            "_staging_district_infrastructure": "district_infrastructure",
        }.get(staging)
        if table is None:
            continue
        try:
            local_rows = len(_frame_for(source))
        except FileNotFoundError as error:
            add(f"parity_{table}", False, str(error))
            continue
        remote_rows = table_row_count(client, f"{config.analytics}.{table}")
        add(
            f"parity_{table}",
            remote_rows == local_rows,
            f"bigquery {remote_rows:,} vs local {local_rows:,}"
            if remote_rows is not None
            else "table missing in BigQuery",
        )

    # ── Physical design actually applied ──────────────────────────────────
    for spec in schema.ANALYTICS_TABLES:
        if not spec.partition_by and not spec.cluster_by:
            continue
        try:
            table = client.get_table(f"{config.analytics}.{spec.name}")
        except Exception:  # noqa: BLE001
            continue
        if spec.partition_by:
            partitioned = table.time_partitioning is not None or table.range_partitioning is not None
            add(f"partitioned_{spec.name}", partitioned, spec.partition_by)
        if spec.cluster_by:
            clustered = tuple(table.clustering_fields or ())
            add(
                f"clustered_{spec.name}",
                clustered == spec.cluster_by,
                f"{clustered or 'none'} (expected {spec.cluster_by})",
            )

    # ── GEOGRAPHY is real and inside India ────────────────────────────────
    try:
        row = next(
            iter(
                run_query(
                    client,
                    f"""
                    SELECT
                      COUNT(*) AS total,
                      COUNTIF(location IS NULL) AS null_location,
                      COUNTIF(NOT ST_WITHIN(
                        location,
                        ST_GEOGFROMTEXT('POLYGON((67 6, 98 6, 98 38, 67 38, 67 6))')
                      )) AS outside_india
                    FROM `{config.analytics}.citizen_reports`
                    """,
                    label="geography",
                )
            )
        )
        add("geography_populated", row["null_location"] == 0, f"{row['null_location']:,} null")
        add(
            "geography_within_india_bbox",
            row["outside_india"] == 0,
            f"{row['outside_india']:,} outside",
        )
    except Exception as error:  # noqa: BLE001
        add("geography_populated", False, str(error)[:140])

    return checks


def report(checks: list[Check]) -> bool:
    if not checks:
        print("  no checks ran")
        return False
    width = max(len(c.name) for c in checks)
    failures = sum(1 for c in checks if not c.passed)
    for check in checks:
        print(f"  [{'PASS' if check.passed else 'FAIL'}] {check.name.ljust(width)}  {check.detail}")
    print(f"\n  {len(checks) - failures}/{len(checks)} checks passed")
    return failures == 0
