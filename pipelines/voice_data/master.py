"""Step 4 — the district × sector × month table analytics will actually use.

One row per district, sector and month, carrying the citizen signal, the
infrastructure position, the investment position, a participation score, and
the planted ground truth. Everything a later analysis needs to ask "is this
place under-served, already funded, badly executed, newly deteriorating, or
simply quiet?" is on one row — except the answer, which is what the
`ground_truth_*` columns are for and what a method is supposed to derive
without them.

Deliberately **not** computed here: any VOICE priority or recommendation score.
That is the next phase's job. This table is the input to it, not a preview of
its output.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pyarrow.parquet as pq

from . import config


def _month_frame() -> pd.DataFrame:
    end = pd.Timestamp(year=config.WINDOW_END_YEAR, month=config.WINDOW_END_MONTH, day=1)
    months = pd.date_range(end=end, periods=config.MONTHS, freq="MS")
    return pd.DataFrame({"month_start": months, "year": months.year, "month": months.month})


def run(processed: dict, generated: dict) -> pd.DataFrame:
    config.ensure_dirs()

    demographics = processed["demographics"]
    planted = processed["planted"]
    investments = processed["investments"]
    issues = generated["issues"]
    demand = generated["demand"]

    months = _month_frame()

    # ── Skeleton: every district × sector × month exists, reported or not ──
    # A month with no reports is a fact and must appear as a zero row rather
    # than a missing one; Scenario G depends on being able to see silence.
    skeleton = (
        demographics[["district_key", "state_code", "district_code", "state_name", "district_name"]]
        .merge(pd.DataFrame({"sector": list(config.SECTORS)}), how="cross")
        .merge(months, how="cross")
    )

    # ── Citizen signal, aggregated from the report table ───────────────────
    reports = pq.read_table(
        config.SYNTHETIC / "citizen_reports.parquet",
        columns=["district_key", "sector", "created_at", "severity", "citizen_id_hash", "canonical_issue_id"],
    ).to_pandas()
    reports["year"] = reports["created_at"].dt.year
    reports["month"] = reports["created_at"].dt.month

    grouped = reports.groupby(["district_key", "sector", "year", "month"], observed=True)
    signal = grouped.agg(
        citizen_report_count=("severity", "size"),
        avg_severity=("severity", "mean"),
        high_severity_report_count=("severity", lambda s: int((s >= 4).sum())),
        unique_citizen_count=("citizen_id_hash", "nunique"),
        canonical_issue_count=("canonical_issue_id", "nunique"),
    ).reset_index()

    master = skeleton.merge(signal, on=["district_key", "sector", "year", "month"], how="left")
    for column, default in (
        ("citizen_report_count", 0),
        ("high_severity_report_count", 0),
        ("unique_citizen_count", 0),
        ("canonical_issue_count", 0),
    ):
        master[column] = master[column].fillna(default).astype("int64")
    master["avg_severity"] = master["avg_severity"].round(3)

    # ── Issue persistence, by the month an issue was open ──────────────────
    open_rows = []
    for row in issues.itertuples():
        first = pd.Timestamp(row.first_seen_at)
        last = pd.Timestamp(row.last_seen_at)
        if pd.isna(first) or pd.isna(last):
            continue
        span = pd.date_range(first.replace(day=1), last.replace(day=1), freq="MS")
        for month_start in span:
            open_rows.append(
                (
                    row.district_key,
                    row.sector,
                    month_start.year,
                    month_start.month,
                    int(row.persistence_days),
                    bool(row.persistence_days >= 180),
                )
            )
    if open_rows:
        open_frame = pd.DataFrame(
            open_rows,
            columns=["district_key", "sector", "year", "month", "persistence_days", "is_persistent"],
        )
        persistence = (
            open_frame.groupby(["district_key", "sector", "year", "month"], observed=True)
            .agg(
                avg_persistence_days=("persistence_days", "mean"),
                persistent_issue_count=("is_persistent", "sum"),
            )
            .reset_index()
        )
        master = master.merge(persistence, on=["district_key", "sector", "year", "month"], how="left")
    else:
        master["avg_persistence_days"] = np.nan
        master["persistent_issue_count"] = 0
    master["persistent_issue_count"] = master["persistent_issue_count"].fillna(0).astype("int64")
    master["avg_persistence_days"] = master["avg_persistence_days"].round(1)

    # ── Demographics and participation ────────────────────────────────────
    master = master.merge(
        demographics[["district_key", "population", "population_density"]],
        on="district_key",
        how="left",
    )
    participation = (
        demand.groupby(["district_key", "sector"], observed=True)
        .agg(
            digital_participation_score=("participation", "first"),
            platform_adoption_score=("platform_adoption_score", "first"),
            reporting_propensity=("propensity", "first"),
        )
        .reset_index()
    )
    master = master.merge(participation, on=["district_key", "sector"], how="left")
    master["urbanization_proxy"] = master["district_key"].map(
        demographics.set_index("district_key")["urban_population_pct"]
    )

    # Reports per 10,000 people. The column Scenario F exists to argue about:
    # a metro can top the raw count and sit mid-table here.
    master["reports_per_10k"] = np.round(
        10_000 * master["citizen_report_count"] / master["population"].replace(0, np.nan), 4
    )

    # ── Infrastructure ────────────────────────────────────────────────────
    infra_parts = []
    for sector in config.SECTORS:
        table = processed[sector][
            ["district_key", "infrastructure_score", "infrastructure_deficit_score", "data_origin"]
        ].copy()
        table["sector"] = sector
        table = table.rename(columns={"data_origin": "infrastructure_data_origin"})
        infra_parts.append(table)
    master = master.merge(pd.concat(infra_parts, ignore_index=True), on=["district_key", "sector"], how="left")

    # ── Investment, as at each month ──────────────────────────────────────
    projects = investments.copy()
    projects["sanction_date"] = pd.to_datetime(projects["sanction_date"], errors="coerce")
    projects["actual_completion_date"] = pd.to_datetime(
        projects["actual_completion_date"], errors="coerce"
    )

    totals = (
        projects.groupby(["district_key", "sector"], observed=True)
        .agg(
            sanctioned_investment=("sanctioned_amount", "sum"),
            released_investment=("released_amount", "sum"),
            spent_investment=("spent_amount", "sum"),
        )
        .reset_index()
    )
    master = master.merge(totals, on=["district_key", "sector"], how="left")
    for column in ("sanctioned_investment", "released_investment", "spent_investment"):
        master[column] = master[column].fillna(0.0).round(2)

    status_counts = (
        projects.assign(
            active=projects["project_status"].isin(["sanctioned", "in_progress"]),
            completed=projects["project_status"].eq("completed"),
            delayed=projects["project_status"].eq("delayed"),
        )
        .groupby(["district_key", "sector"], observed=True)[["active", "completed", "delayed"]]
        .sum()
        .reset_index()
        .rename(
            columns={
                "active": "active_project_count",
                "completed": "completed_project_count",
                "delayed": "delayed_project_count",
            }
        )
    )
    master = master.merge(status_counts, on=["district_key", "sector"], how="left")
    for column in ("active_project_count", "completed_project_count", "delayed_project_count"):
        master[column] = master[column].fillna(0).astype("int64")

    # Months since the most recent completion in this cell — the column that
    # makes Scenario C answerable: complaints continuing well after a project
    # was reported finished.
    last_completion = (
        projects.dropna(subset=["actual_completion_date"])
        .groupby(["district_key", "sector"], observed=True)["actual_completion_date"]
        .max()
        .reset_index()
        .rename(columns={"actual_completion_date": "last_project_completion_date"})
    )
    master = master.merge(last_completion, on=["district_key", "sector"], how="left")
    master["months_since_last_completion"] = (
        (master["month_start"] - master["last_project_completion_date"]).dt.days / 30.44
    ).round(1)

    # ── Ground truth ──────────────────────────────────────────────────────
    if not planted.empty:
        labels = planted[
            [
                "district_key",
                "sector",
                "scenario_id",
                "scenario_code",
                "expected_interpretation",
                "ground_truth_unmet_need",
                "ground_truth_investment_gap",
                "ground_truth_execution_gap",
                "ground_truth_emerging_hotspot",
                "ground_truth_silent_need",
            ]
        ].rename(columns={"scenario_code": "ground_truth_scenario"})
        master = master.merge(labels, on=["district_key", "sector"], how="left")
    else:
        for column in (
            "scenario_id",
            "ground_truth_scenario",
            "expected_interpretation",
            "ground_truth_unmet_need",
            "ground_truth_investment_gap",
            "ground_truth_execution_gap",
            "ground_truth_emerging_hotspot",
            "ground_truth_silent_need",
        ):
            master[column] = np.nan

    # Unplanted cells are labelled "none" rather than left null: "no scenario
    # was planted here" is a real class in the evaluation, not missing data.
    master["ground_truth_scenario"] = master["ground_truth_scenario"].fillna("none")
    master["scenario_id"] = master["scenario_id"].fillna("")
    master["expected_interpretation"] = master["expected_interpretation"].fillna("")
    for column in (
        "ground_truth_unmet_need",
        "ground_truth_investment_gap",
        "ground_truth_execution_gap",
        "ground_truth_emerging_hotspot",
        "ground_truth_silent_need",
    ):
        master[column] = master[column].fillna(False).astype(bool)

    master["country_code"] = config.COUNTRY_CODE
    master = master.sort_values(["state_code", "district_code", "sector", "year", "month"])

    ordered = [
        "country_code", "state_code", "state_name", "district_code", "district_key", "district_name",
        "year", "month", "sector",
        "population", "population_density",
        "citizen_report_count", "unique_citizen_count", "canonical_issue_count",
        "reports_per_10k", "avg_severity", "high_severity_report_count",
        "persistent_issue_count", "avg_persistence_days",
        "infrastructure_score", "infrastructure_deficit_score", "infrastructure_data_origin",
        "sanctioned_investment", "released_investment", "spent_investment",
        "active_project_count", "completed_project_count", "delayed_project_count",
        "last_project_completion_date", "months_since_last_completion",
        "digital_participation_score", "platform_adoption_score", "reporting_propensity",
        "urbanization_proxy",
        "scenario_id", "ground_truth_scenario", "expected_interpretation",
        "ground_truth_unmet_need", "ground_truth_investment_gap", "ground_truth_execution_gap",
        "ground_truth_emerging_hotspot", "ground_truth_silent_need",
    ]
    master = master[[c for c in ordered if c in master.columns]]

    master.to_csv(config.MASTER / "district_sector_master.csv", index=False)
    master.to_parquet(config.MASTER / "district_sector_master.parquet", index=False)
    print(f"  master: {len(master):,} district-sector-month rows")
    return master
