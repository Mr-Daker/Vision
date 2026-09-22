"""Step 5 — checks that must pass before anyone trusts this dataset.

Each check returns a row for the report rather than raising, so one failure
does not hide the next nine. The exit status is non-zero if any check fails,
which is what makes this usable in CI.

The provenance checks are the ones that matter most. A dataset that mixes
synthetic and real values is only safe if the marking is right, so
`no_synthetic_marked_real` and `origins_are_known` are treated as hard failures
rather than warnings.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd
import pyarrow.parquet as pq

from . import config
from .provenance import ORIGINS


@dataclass
class Check:
    name: str
    passed: bool
    detail: str
    severity: str = "error"


#: Read as strings, always. These are identifiers with meaningful leading
#: zeros ("01" is Jammu & Kashmir), and pandas will happily infer them to int64
#: and silently drop the zero — which makes every join against the report table
#: fail while looking like a referential-integrity problem.
_CODE_COLUMNS = {"state_code": str, "district_code": str, "district_key": str, "block_code": str}


def _read(path, columns=None) -> pd.DataFrame:
    if path.suffix == ".parquet":
        return pq.read_table(path, columns=columns).to_pandas()
    return pd.read_csv(path, low_memory=False, dtype=_CODE_COLUMNS)


def run() -> list[Check]:
    checks: list[Check] = []
    synthetic = config.SYNTHETIC
    processed = config.PROCESSED
    master_dir = config.MASTER

    reports_path = synthetic / "citizen_reports.parquet"
    if not reports_path.exists():
        return [Check("reports_exist", False, "citizen_reports.parquet is missing; run data:generate")]

    reports = _read(reports_path)
    issues = _read(synthetic / "canonical_issues.csv")
    master = _read(master_dir / "district_master.csv")
    demographics = _read(processed / "demographics.csv")
    investments = _read(processed / "public_investments.csv")
    dsm = _read(master_dir / "district_sector_master.parquet")

    def add(name, passed, detail, severity="error"):
        checks.append(Check(name, bool(passed), detail, severity))

    # ── Identity and referential integrity ────────────────────────────────
    duplicate_ids = int(reports["report_id"].duplicated().sum())
    add("no_duplicate_report_ids", duplicate_ids == 0, f"{duplicate_ids} duplicate report_id values")

    dup_issue_ids = int(issues["canonical_issue_id"].duplicated().sum())
    add("no_duplicate_issue_ids", dup_issue_ids == 0, f"{dup_issue_ids} duplicate canonical_issue_id values")

    known_issues = set(issues["canonical_issue_id"])
    orphan = int((~reports["canonical_issue_id"].isin(known_issues)).sum())
    add("canonical_issue_refs_valid", orphan == 0, f"{orphan} reports reference an unknown canonical issue")

    known_districts = set(master["district_key"])
    bad_district = int((~reports["district_key"].isin(known_districts)).sum())
    add("report_district_refs_valid", bad_district == 0, f"{bad_district} reports reference an unknown district")

    bad_project_district = int((~investments["district_key"].isin(known_districts)).sum())
    add("project_district_refs_valid", bad_project_district == 0, f"{bad_project_district} projects reference an unknown district")

    # ── Coordinates ───────────────────────────────────────────────────────
    lat_ok = reports["latitude"].between(6.0, 37.5)
    lon_ok = reports["longitude"].between(67.0, 97.5)
    bad_coords = int((~(lat_ok & lon_ok)).sum())
    add("report_coordinates_in_india_bbox", bad_coords == 0, f"{bad_coords} reports outside the India bounding box")

    master_coords_bad = int(
        (~(master["latitude"].between(6.0, 37.5) & master["longitude"].between(67.0, 97.5))).sum()
    )
    add("district_coordinates_valid", master_coords_bad == 0, f"{master_coords_bad} districts outside the bounding box")

    # ── Values ────────────────────────────────────────────────────────────
    nonpositive_population = int((pd.to_numeric(demographics["population"], errors="coerce") <= 0).sum())
    add("population_positive", nonpositive_population == 0, f"{nonpositive_population} districts with population <= 0")

    pct_columns = [
        "rural_population_pct", "urban_population_pct", "literacy_rate", "female_population_pct",
        "sc_population_pct", "st_population_pct", "working_population_pct", "child_population_pct",
    ]
    out_of_range = 0
    for column in pct_columns:
        values = pd.to_numeric(demographics[column], errors="coerce").dropna()
        out_of_range += int(((values < 0) | (values > 100)).sum())
    add("percentages_within_0_100", out_of_range == 0, f"{out_of_range} demographic percentage values outside 0-100")

    negative_money = 0
    for column in ("sanctioned_amount", "released_amount", "spent_amount"):
        negative_money += int((pd.to_numeric(investments[column], errors="coerce") < 0).sum())
    add("monetary_values_nonnegative", negative_money == 0, f"{negative_money} negative monetary values")

    overspent = int(
        (
            pd.to_numeric(investments["spent_amount"], errors="coerce")
            > pd.to_numeric(investments["released_amount"], errors="coerce") + 0.01
        ).sum()
    )
    add("spend_not_above_release", overspent == 0, f"{overspent} projects spent more than was released")

    released_over_sanctioned = int(
        (
            pd.to_numeric(investments["released_amount"], errors="coerce")
            > pd.to_numeric(investments["sanctioned_amount"], errors="coerce") + 0.01
        ).sum()
    )
    add("release_not_above_sanction", released_over_sanctioned == 0, f"{released_over_sanctioned} projects released more than was sanctioned")

    severity_bad = int((~reports["severity"].between(1, 5)).sum())
    add("severity_within_1_5", severity_bad == 0, f"{severity_bad} reports with severity outside 1-5")

    # ── Time ──────────────────────────────────────────────────────────────
    window_end = pd.Timestamp(year=config.WINDOW_END_YEAR, month=config.WINDOW_END_MONTH, day=1) + pd.offsets.MonthEnd(1)
    window_start = window_end - pd.DateOffset(months=config.MONTHS)
    created = pd.to_datetime(reports["created_at"])
    outside = int(((created < window_start) | (created > window_end)).sum())
    add("timestamps_within_window", outside == 0, f"{outside} reports outside the {config.MONTHS}-month window")

    resolved = pd.to_datetime(reports["resolved_at"], errors="coerce")
    impossible = int((resolved.notna() & (resolved < created)).sum())
    add("no_resolved_before_created", impossible == 0, f"{impossible} reports resolved before they were created")

    # ── Categorical consistency ───────────────────────────────────────────
    bad_sector = int((~reports["sector"].isin(config.SECTORS)).sum())
    add("report_sectors_known", bad_sector == 0, f"{bad_sector} reports with an unknown sector")

    issue_sector = issues.set_index("canonical_issue_id")["sector"]
    joined = reports[["canonical_issue_id", "sector"]].join(issue_sector, on="canonical_issue_id", rsuffix="_issue")
    mismatch = int((joined["sector"] != joined["sector_issue"]).sum())
    add("report_sector_matches_issue", mismatch == 0, f"{mismatch} reports whose sector differs from their canonical issue")

    bad_channel = int((~reports["input_channel"].isin(config.INPUT_CHANNELS)).sum())
    add("input_channels_known", bad_channel == 0, f"{bad_channel} reports with an unknown input channel")

    bad_language = int((~reports["language"].isin(config.LANGUAGES)).sum())
    add("languages_known", bad_language == 0, f"{bad_language} reports with an unknown language")

    bad_status = int((~investments["project_status"].isin(config.PROJECT_STATUSES)).sum())
    add("project_statuses_known", bad_status == 0, f"{bad_status} projects with an unknown status")

    # ── Provenance ────────────────────────────────────────────────────────
    unknown_origin = int((~reports["data_origin"].isin(ORIGINS)).sum())
    add("origins_are_known", unknown_origin == 0, f"{unknown_origin} reports with an unrecognised data_origin")

    wrongly_real = int((reports["data_origin"] != "synthetic").sum())
    add(
        "no_synthetic_marked_real",
        wrongly_real == 0,
        f"{wrongly_real} generated citizen reports not marked synthetic",
    )

    projects_not_synthetic = int((investments["data_origin"] != "synthetic").sum())
    add(
        "projects_marked_synthetic",
        projects_not_synthetic == 0,
        f"{projects_not_synthetic} project records not marked synthetic",
    )

    demographics_real = int((demographics["data_origin"] != "real").sum())
    add(
        "demographics_marked_real",
        demographics_real == 0,
        f"{demographics_real} demographic rows not marked real (they are Census 2011 figures)",
    )

    # ── Master table ──────────────────────────────────────────────────────
    expected_rows = len(demographics) * len(config.SECTORS) * config.MONTHS
    add(
        "master_is_complete",
        len(dsm) == expected_rows,
        f"master has {len(dsm):,} rows, expected {expected_rows:,} (districts x sectors x months)",
    )

    master_reports = int(dsm["citizen_report_count"].sum())
    add(
        "master_report_total_matches",
        master_reports == len(reports),
        f"master totals {master_reports:,} reports, report table has {len(reports):,}",
    )

    negative_counts = int((dsm["citizen_report_count"] < 0).sum())
    add("master_counts_nonnegative", negative_counts == 0, f"{negative_counts} negative report counts in master")

    unique_gt_total = int((dsm["unique_citizen_count"] > dsm["citizen_report_count"]).sum())
    add(
        "unique_citizens_not_above_reports",
        unique_gt_total == 0,
        f"{unique_gt_total} master rows with more unique citizens than reports",
    )

    return checks


def report(checks: list[Check]) -> bool:
    width = max(len(c.name) for c in checks) if checks else 10
    failures = 0
    for check in checks:
        mark = "PASS" if check.passed else "FAIL"
        if not check.passed:
            failures += 1
        print(f"  [{mark}] {check.name.ljust(width)}  {check.detail}")
    print(f"\n  {len(checks) - failures}/{len(checks)} checks passed")
    return failures == 0
