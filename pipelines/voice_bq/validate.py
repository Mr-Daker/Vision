"""Step 4 — prove the warehouse matches the pipeline, and that nothing leaked.

Two kinds of check, and the second is the one that matters.

**Parity.** Row counts, schemas, null patterns, dimensions, aggregates,
provenance and the five analysis outputs in BigQuery against DuckDB/local
pipeline results.  Floating analytical values use an explicit tolerance;
identifiers, strings, booleans and null placement must match exactly.

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
from datetime import date, datetime

import numpy as np
import pandas as pd
from pandas.api import types as ptypes

from . import analytics
from . import config as cfg
from . import schema
from .client import bigquery_client, column_names, dataset_exists, run_query, table_row_count
from .load import STAGING_SOURCES, _frame_for


FLOAT_RTOL = 1e-9
FLOAT_ATOL = 1e-10

TABLE_BY_STAGING = {
    "_staging_citizen_reports": "citizen_reports",
    "_staging_canonical_issues": "canonical_issues",
    "_staging_district_sector_month": "district_sector_month",
    "_staging_district_master": "district_master",
    "_staging_district_demographics": "district_demographics",
    "_staging_public_projects": "public_projects",
    "_staging_district_infrastructure": "district_infrastructure",
}

EXCLUDED_BY_TABLE = {
    "citizen_reports": schema.REPORT_LABELS,
    "canonical_issues": schema.ISSUE_LABELS,
    "district_sector_month": schema.MASTER_LABELS,
}

PROVENANCE_COLUMNS = {
    "citizen_reports": "data_origin",
    "canonical_issues": "data_origin",
    "district_sector_month": "infrastructure_data_origin",
    "district_demographics": "data_origin",
    "public_projects": "data_origin",
    "district_infrastructure": "data_origin",
}

DECISION_COLUMNS = {
    "unmet_need": ("sufficient_evidence", "potential_unmet_need"),
    "investment": (
        "sufficient_evidence",
        "potential_unmet_need",
        "investment_classification",
    ),
    "execution": ("sufficient_evidence", "execution_finding"),
    "hotspot": ("sufficient_evidence", "emerging_hotspot"),
    "silent": ("possible_under_reporting",),
}


@dataclass
class Check:
    name: str
    passed: bool
    detail: str


def _pandas_bigquery_type(series: pd.Series) -> str:
    if ptypes.is_bool_dtype(series.dtype):
        return "BOOLEAN"
    if ptypes.is_integer_dtype(series.dtype):
        return "INTEGER"
    if ptypes.is_float_dtype(series.dtype):
        return "FLOAT"
    if ptypes.is_datetime64_any_dtype(series.dtype):
        # This mirrors google-cloud-bigquery's DataFrame load contract for
        # these sources: the millisecond Parquet event columns land as
        # TIMESTAMP, while pandas nanosecond, timezone-naive columns land as
        # civil DATETIME values.
        return "DATETIME" if str(series.dtype) == "datetime64[ns]" else "TIMESTAMP"
    return "STRING"


def _expected_schema(table: str, frame: pd.DataFrame) -> dict[str, str]:
    excluded = set(EXCLUDED_BY_TABLE.get(table, ()))
    expected = {
        column: _pandas_bigquery_type(frame[column])
        for column in frame.columns
        if column not in excluded
    }
    if table in {"citizen_reports", "canonical_issues", "district_master"}:
        expected["location"] = "GEOGRAPHY"
    if table == "district_sector_month":
        expected["month_start"] = "DATE"
    if table == "public_projects":
        for column in (
            "sanction_date",
            "start_date",
            "expected_completion_date",
            "actual_completion_date",
        ):
            expected[column] = "DATE"
    return expected


def _local_null_counts(table: str, frame: pd.DataFrame, columns: list[str]) -> dict[str, int]:
    result: dict[str, int] = {}
    for column in columns:
        if column == "location":
            coordinate_columns = (
                ("lon", "lat") if table == "canonical_issues" else ("longitude", "latitude")
            )
            result[column] = int(frame[list(coordinate_columns)].isna().any(axis=1).sum())
        elif column == "month_start":
            result[column] = int(frame[["year", "month"]].isna().any(axis=1).sum())
        elif table == "public_projects" and column.endswith("_date"):
            result[column] = int(pd.to_datetime(frame[column], errors="coerce").isna().sum())
        else:
            result[column] = int(frame[column].isna().sum())
    return result


def _remote_null_counts(client, table_id: str, columns: list[str]) -> dict[str, int]:
    expressions = ",\n".join(
        f"COUNTIF(`{column}` IS NULL) AS n_{index}"
        for index, column in enumerate(columns)
    )
    row = next(iter(run_query(client, f"SELECT {expressions} FROM `{table_id}`", label="nulls")))
    return {column: int(row[f"n_{index}"]) for index, column in enumerate(columns)}


def _rows_to_frame(rows) -> pd.DataFrame:
    return pd.DataFrame([dict(row.items()) for row in rows])


def _analysis_frames_match(local_frame: pd.DataFrame, remote_frame: pd.DataFrame) -> tuple[bool, str]:
    keys = ["district_key", "sector"]
    if set(local_frame.columns) != set(remote_frame.columns):
        missing = sorted(set(local_frame.columns) - set(remote_frame.columns))
        extra = sorted(set(remote_frame.columns) - set(local_frame.columns))
        return False, f"column mismatch; missing={missing}, extra={extra}"
    if len(local_frame) != len(remote_frame):
        return False, f"row mismatch; duckdb={len(local_frame):,}, bigquery={len(remote_frame):,}"

    left = local_frame.sort_values(keys).reset_index(drop=True)
    right = remote_frame.sort_values(keys).reset_index(drop=True)
    if list(map(tuple, left[keys].astype(str).to_numpy())) != list(
        map(tuple, right[keys].astype(str).to_numpy())
    ):
        return False, "district-sector keys differ"

    max_absolute_error = 0.0
    differences: list[str] = []
    for column in left.columns:
        left_null = left[column].isna().to_numpy()
        right_null = right[column].isna().to_numpy()
        if not np.array_equal(left_null, right_null):
            differences.append(
                f"{column}:null={int(np.count_nonzero(left_null != right_null))}"
            )
            continue
        present = ~left_null
        if not present.any():
            continue

        if ptypes.is_bool_dtype(left[column].dtype):
            unequal = (
                left.loc[present, column].astype(bool).to_numpy()
                != right.loc[present, column].astype(bool).to_numpy()
            )
            if unequal.any():
                differences.append(f"{column}:bool={int(unequal.sum())}")
        elif ptypes.is_numeric_dtype(left[column].dtype):
            left_values = pd.to_numeric(left.loc[present, column]).to_numpy(dtype=float)
            right_values = pd.to_numeric(right.loc[present, column]).to_numpy(dtype=float)
            absolute_error = float(np.max(np.abs(left_values - right_values)))
            max_absolute_error = max(max_absolute_error, absolute_error)
            close = np.isclose(
                left_values,
                right_values,
                rtol=FLOAT_RTOL,
                atol=FLOAT_ATOL,
            )
            if not close.all():
                differences.append(
                    f"{column}:numeric={int((~close).sum())},max_abs={absolute_error:.3g}"
                )
        elif ptypes.is_datetime64_any_dtype(left[column].dtype) or any(
            isinstance(value, (date, datetime)) for value in left.loc[present, column].head(3)
        ):
            left_values = pd.to_datetime(left.loc[present, column]).to_numpy()
            right_values = pd.to_datetime(right.loc[present, column]).to_numpy()
            unequal = left_values != right_values
            if unequal.any():
                differences.append(f"{column}:datetime={int(unequal.sum())}")
        else:
            unequal = (
                left.loc[present, column].astype(str).to_numpy()
                != right.loc[present, column].astype(str).to_numpy()
            )
            if unequal.any():
                differences.append(f"{column}:text={int(unequal.sum())}")

    if differences:
        return False, "; ".join(differences)

    return (
        True,
        f"{len(left):,} rows, {len(left.columns)} columns; "
        f"float rtol={FLOAT_RTOL:g}, atol={FLOAT_ATOL:g}, max abs={max_absolute_error:.3g}",
    )


def _decision_columns_match(
    local_frame: pd.DataFrame,
    remote_frame: pd.DataFrame,
    decision_columns: tuple[str, ...],
) -> tuple[bool, str]:
    columns = ["district_key", "sector", *decision_columns]
    left = local_frame[columns].sort_values(["district_key", "sector"]).reset_index(drop=True)
    right = remote_frame[columns].sort_values(["district_key", "sector"]).reset_index(drop=True)
    differences = {
        column: int(
            np.count_nonzero(
                left[column]
                .astype("object")
                .where(left[column].notna(), "__NULL__")
                .astype(str)
                .to_numpy()
                != right[column]
                .astype("object")
                .where(right[column].notna(), "__NULL__")
                .astype(str)
                .to_numpy()
            )
        )
        for column in decision_columns
    }
    differences = {column: count for column, count in differences.items() if count}
    return (
        not differences,
        f"{len(left):,} keyed rows; {', '.join(decision_columns)} exact"
        if not differences
        else f"different values={differences}",
    )


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

    for dataset, name in (
        (config.analytics, "analytics"),
        (config.evaluation, "eval"),
    ):
        live_staging = sorted(
            table.table_id
            for table in client.list_tables(dataset)
            if table.table_id.startswith("_staging_")
        )
        add(
            f"no_staging_tables_in_{name}",
            not live_staging,
            "clean" if not live_staging else f"present: {live_staging}",
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
    local_provenance: dict[tuple[str, str], dict[str, int]] = {}
    district_sector_month_summary: dict[str, float | int] = {}
    for staging, source in STAGING_SOURCES.items():
        table = TABLE_BY_STAGING.get(staging)
        if table is None:
            continue
        try:
            frame = _frame_for(source)
            local_rows = len(frame)
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

        table_id = f"{config.analytics}.{table}"
        remote_table = client.get_table(table_id)
        expected_schema = _expected_schema(table, frame)
        actual_schema = {field.name: field.field_type for field in remote_table.schema}
        schema_matches = expected_schema == actual_schema
        if schema_matches:
            schema_detail = f"{len(actual_schema)} columns and types match"
        else:
            missing = sorted(set(expected_schema) - set(actual_schema))
            extra = sorted(set(actual_schema) - set(expected_schema))
            wrong = sorted(
                f"{column}:{actual_schema[column]}!={expected_schema[column]}"
                for column in set(expected_schema) & set(actual_schema)
                if expected_schema[column] != actual_schema[column]
            )
            schema_detail = f"missing={missing}, extra={extra}, wrong_types={wrong}"
        add(f"schema_{table}", schema_matches, schema_detail)

        columns = list(expected_schema)
        local_nulls = _local_null_counts(table, frame, columns)
        remote_nulls = _remote_null_counts(client, table_id, columns)
        null_differences = {
            column: (local_nulls[column], remote_nulls[column])
            for column in columns
            if local_nulls[column] != remote_nulls[column]
        }
        add(
            f"null_pattern_{table}",
            not null_differences,
            f"{len(columns)} columns match"
            if not null_differences
            else f"local,bigquery differences={null_differences}",
        )

        provenance_column = PROVENANCE_COLUMNS.get(table)
        if provenance_column:
            values = frame[provenance_column].fillna("__NULL__").astype(str).value_counts()
            local_provenance[(table, provenance_column)] = {
                key: int(value) for key, value in values.items()
            }

        if table == "district_sector_month":
            district_sector_month_summary = {
                "districts": int(frame["district_key"].nunique()),
                "sectors": int(frame["sector"].nunique()),
                "months": int(frame[["year", "month"]].drop_duplicates().shape[0]),
                "reports": int(frame["citizen_report_count"].sum()),
                "unique_citizens": int(frame["unique_citizen_count"].sum()),
                "canonical_issues": int(frame["canonical_issue_count"].sum()),
                "sanctioned": float(frame["sanctioned_investment"].sum()),
                "released": float(frame["released_investment"].sum()),
                "spent": float(frame["spent_investment"].sum()),
            }

    # ── Dimensional, aggregate and provenance parity ─────────────────────
    if district_sector_month_summary:
        row = next(
            iter(
                run_query(
                    client,
                    f"""
                    SELECT
                      COUNT(DISTINCT district_key) AS districts,
                      COUNT(DISTINCT sector) AS sectors,
                      COUNT(DISTINCT FORMAT('%04d-%02d', year, month)) AS months,
                      SUM(citizen_report_count) AS reports,
                      SUM(unique_citizen_count) AS unique_citizens,
                      SUM(canonical_issue_count) AS canonical_issues,
                      SUM(sanctioned_investment) AS sanctioned,
                      SUM(released_investment) AS released,
                      SUM(spent_investment) AS spent
                    FROM `{config.analytics}.district_sector_month`
                    """,
                    label="district-sector-month aggregates",
                )
            )
        )
        remote_summary = {key: row[key] for key in district_sector_month_summary}
        dimensions_match = all(
            int(remote_summary[key]) == int(district_sector_month_summary[key])
            for key in ("districts", "sectors", "months")
        )
        add(
            "dimension_counts",
            dimensions_match,
            "districts={districts}, sectors={sectors}, months={months}".format(
                **district_sector_month_summary
            ),
        )
        aggregate_match = all(
            np.isclose(
                float(remote_summary[key]),
                float(district_sector_month_summary[key]),
                rtol=FLOAT_RTOL,
                atol=FLOAT_ATOL,
            )
            for key in (
                "reports",
                "unique_citizens",
                "canonical_issues",
                "sanctioned",
                "released",
                "spent",
            )
        )
        add(
            "district_sector_month_aggregates",
            aggregate_match,
            ", ".join(
                f"{key}={district_sector_month_summary[key]:,.6g}"
                for key in (
                    "reports",
                    "unique_citizens",
                    "canonical_issues",
                    "sanctioned",
                    "released",
                    "spent",
                )
            ),
        )

    for (table, column), local_counts in local_provenance.items():
        rows = run_query(
            client,
            f"""
            SELECT COALESCE(CAST(`{column}` AS STRING), '__NULL__') AS origin,
                   COUNT(*) AS row_count
            FROM `{config.analytics}.{table}`
            GROUP BY origin
            """,
            label=f"provenance {table}",
        )
        remote_counts = {str(row["origin"]): int(row["row_count"]) for row in rows}
        add(
            f"provenance_{table}",
            remote_counts == local_counts,
            str(remote_counts if remote_counts == local_counts else {
                "local": local_counts,
                "bigquery": remote_counts,
            }),
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
    for table in ("citizen_reports", "canonical_issues", "district_master"):
        try:
            row = next(
                iter(
                    run_query(
                        client,
                        f"""
                        SELECT
                          COUNT(*) AS total,
                          COUNTIF(location IS NULL) AS null_location,
                          COUNTIF(location IS NOT NULL AND NOT ST_WITHIN(
                            location,
                            ST_GEOGFROMTEXT('POLYGON((67 6, 98 6, 98 38, 67 38, 67 6))')
                          )) AS outside_india
                        FROM `{config.analytics}.{table}`
                        """,
                        label=f"geography {table}",
                    )
                )
            )
            add(
                f"geography_{table}",
                row["null_location"] == 0 and row["outside_india"] == 0,
                f"{row['total']:,} rows, {row['null_location']:,} null, "
                f"{row['outside_india']:,} outside India bbox",
            )
        except Exception as error:  # noqa: BLE001
            add(f"geography_{table}", False, str(error)[:140])

    # ── The actual analytical outputs match DuckDB ────────────────────────
    # This executes the same frozen SQL locally, then reads each already-built
    # BigQuery view. Ground-truth tables are not involved in either side.
    local_run = analytics.run_local()
    for analysis_name, view_name in analytics.VIEW_NAMES.items():
        remote_frame = _rows_to_frame(
            run_query(
                client,
                f"SELECT * FROM `{config.analytics}.{view_name}`",
                label=f"analysis parity {analysis_name}",
            )
        )
        matched, detail = _analysis_frames_match(
            local_run.tables[analysis_name], remote_frame
        )
        add(f"analysis_parity_{analysis_name}", matched, detail)
        decisions_match, decisions_detail = _decision_columns_match(
            local_run.tables[analysis_name],
            remote_frame,
            DECISION_COLUMNS[analysis_name],
        )
        add(
            f"analysis_decision_parity_{analysis_name}",
            decisions_match,
            decisions_detail,
        )

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
