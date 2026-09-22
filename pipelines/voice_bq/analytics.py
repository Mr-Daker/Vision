"""Runs the five analyses, then scores them against the labels they never saw.

Execution order matters and is enforced rather than assumed: the analysis files
run first, through a path that refuses to bind an evaluation table, and only
then are labels loaded and joined. There is no point in the flow where a
scoring query could reach a label even by accident.

The same files run on BigQuery. `local.py` binds the table placeholders to
DuckDB views over the Parquet; `bq.py` binds them to fully-qualified BigQuery
tables. One copy of each query, two bindings.
"""

from __future__ import annotations

from dataclasses import dataclass

import pandas as pd

from . import local
from .evaluation import ClassificationResult, RankingResult, score_classification, score_ranking

#: Run in order; later files depend on the views earlier ones create.
ANALYSIS_FILES = (
    "01_features.sql",
    "02_unmet_need.sql",
    "03_investment_gap.sql",
    "04_execution_gap.sql",
    "05_emerging_hotspot.sql",
    "06_silent_need.sql",
)

VIEW_NAMES = {
    "unmet_need": "analytics_features_unmet_need",
    "investment": "analytics_features_investment_classification",
    "execution": "analytics_features_execution_gap",
    "hotspot": "analytics_features_emerging_hotspot",
    "silent": "analytics_features_silent_need",
}


@dataclass
class AnalyticsRun:
    tables: dict[str, pd.DataFrame]
    labels: pd.DataFrame


def run_local() -> AnalyticsRun:
    """Executes every analysis against the local Parquet and returns the results."""
    connection = local.connect()
    for filename in ANALYSIS_FILES:
        # Refuses any file that names an evaluation table.
        local.run_file(connection, filename)

    tables = {
        key: connection.execute(f"SELECT * FROM {view}").fetchdf()
        for key, view in VIEW_NAMES.items()
    }

    # Labels are loaded only now, after every analysis has already produced its
    # output. Nothing above this line can see them.
    labels = connection.execute(
        """
        SELECT
          district_key, sector,
          ANY_VALUE(ground_truth_scenario)          AS ground_truth_scenario,
          MAX(CAST(ground_truth_unmet_need AS INT))       = 1 AS ground_truth_unmet_need,
          MAX(CAST(ground_truth_investment_gap AS INT))   = 1 AS ground_truth_investment_gap,
          MAX(CAST(ground_truth_execution_gap AS INT))    = 1 AS ground_truth_execution_gap,
          MAX(CAST(ground_truth_emerging_hotspot AS INT)) = 1 AS ground_truth_emerging_hotspot,
          MAX(CAST(ground_truth_silent_need AS INT))      = 1 AS ground_truth_silent_need
        FROM district_sector_month_labels
        GROUP BY district_key, sector
        """
    ).fetchdf()

    return AnalyticsRun(tables=tables, labels=labels)


#: Which planted scenarios each analysis is actually designed to detect.
#:
#: Scoring every signal against the union label `ground_truth_unmet_need`
#: (true for A, B, C, D, E and G) would be a misattribution dressed up as
#: rigour. Scenario G is *defined* as need that produces almost no reports —
#: a demand-driven analysis cannot see it, and that is precisely why Analysis 5
#: exists. Marking Analysis 1 wrong for missing G would punish the design for
#: working, and would reward a version that flagged everything.
#:
#: So each analysis is scored against its own target, and the union is scored
#: separately as an ensemble, which is the claim that actually matters:
#: between them, do the analyses find the unmet need that was planted?
TARGET_SCENARIOS = {
    "unmet_need": ("A", "B", "C", "D", "E"),
    "new_investment_gap": ("A", "D", "E"),
    "monitor_existing": ("B",),
    "execution_gap": ("C",),
    "emerging_hotspot": ("D",),
    "silent_need": ("G",),
}


def _label_for(labels: pd.DataFrame, scenarios: tuple[str, ...]) -> pd.DataFrame:
    frame = labels.copy()
    frame["target"] = frame["ground_truth_scenario"].isin(scenarios)
    return frame


def evaluate(run: AnalyticsRun) -> tuple[list[ClassificationResult], list[RankingResult]]:
    tables, labels = run.tables, run.labels

    unmet = tables["unmet_need"]
    investment = tables["investment"].copy()
    investment["is_new_gap"] = investment["investment_classification"].eq(
        "POTENTIAL_NEW_INVESTMENT_GAP"
    )
    investment["is_monitor"] = investment["investment_classification"].eq(
        "MONITOR_EXISTING_PROJECT"
    )
    execution = tables["execution"].copy()
    execution["is_outcome_gap"] = execution["execution_finding"].eq("POSSIBLE_OUTCOME_GAP")

    classifications = [
        score_classification(
            unmet, _label_for(labels, TARGET_SCENARIOS["unmet_need"]),
            signal="Unmet need (demand-visible)",
            prediction_column="potential_unmet_need",
            label_column="target",
        ),
        score_classification(
            investment, _label_for(labels, TARGET_SCENARIOS["new_investment_gap"]),
            signal="New investment gap",
            prediction_column="is_new_gap",
            label_column="target",
        ),
        score_classification(
            investment, _label_for(labels, TARGET_SCENARIOS["monitor_existing"]),
            signal="Monitor existing project",
            prediction_column="is_monitor",
            label_column="target",
        ),
        score_classification(
            execution, _label_for(labels, TARGET_SCENARIOS["execution_gap"]),
            signal="Execution / outcome gap",
            prediction_column="is_outcome_gap",
            label_column="target",
        ),
        score_classification(
            tables["hotspot"], _label_for(labels, TARGET_SCENARIOS["emerging_hotspot"]),
            signal="Emerging hotspot",
            prediction_column="emerging_hotspot",
            label_column="target",
        ),
        score_classification(
            tables["silent"], _label_for(labels, TARGET_SCENARIOS["silent_need"]),
            signal="Silent need / under-reporting",
            prediction_column="possible_under_reporting",
            label_column="target",
        ),
    ]

    # The ensemble claim: between the demand-driven and the silence-driven
    # analyses, how much of the planted unmet need is surfaced at all? This is
    # the number that answers "would a policymaker have seen it".
    ensemble = (
        unmet[["district_key", "sector", "potential_unmet_need"]]
        .merge(
            tables["silent"][["district_key", "sector", "possible_under_reporting"]],
            on=["district_key", "sector"],
            how="outer",
        )
    )
    ensemble["surfaced"] = ensemble["potential_unmet_need"].fillna(False).astype(bool) | ensemble[
        "possible_under_reporting"
    ].fillna(False).astype(bool)
    classifications.append(
        score_classification(
            ensemble, labels,
            signal="ENSEMBLE: any unmet need surfaced",
            prediction_column="surfaced",
            label_column="ground_truth_unmet_need",
        )
    )

    # ── Ranking ───────────────────────────────────────────────────────────
    # `evidence_strength` exists ONLY here, to give the ranking metrics an
    # order to measure. It is deliberately not a published priority score and
    # is not written to any table a policymaker or Gemini can see: the product
    # surfaces named component signals and reason codes, per V050b §2.
    ranked = unmet.copy()
    ranked["evidence_strength"] = (
        ranked["citizen_demand_signal"].fillna(0)
        + ranked["infrastructure_deficit_signal"].fillna(0)
        + (1 - ranked["investment_coverage_signal"].fillna(1))
    )
    rank_labels = _label_for(labels, TARGET_SCENARIOS["unmet_need"])
    rankings = [
        score_ranking(
            ranked, rank_labels,
            signal="Unmet need shortlist",
            score_column="evidence_strength",
            label_column="target",
            k=k,
        )
        for k in (10, 25, 50, 100)
    ]

    return classifications, rankings


def report(
    classifications: list[ClassificationResult],
    rankings: list[RankingResult],
) -> None:
    print("\n  Classification — signal vs the scenario it was never shown")
    print("  " + "-" * 92)
    print(f"  {'Signal':<32} {'TP':>4} {'FP':>4} {'FN':>4}  {'Precision':<28} {'Recall':<28} F1")
    for result in classifications:
        f1 = f"{result.f1:.2f}" if result.f1 is not None else "n/a"
        print(
            f"  {result.signal:<32} {result.true_positives:>4} {result.false_positives:>4} "
            f"{result.false_negatives:>4}  {result.precision.render():<28} "
            f"{result.recall.render():<28} {f1}"
        )
    notes = {note for r in classifications for note in r.notes}
    for note in sorted(notes):
        print(f"    note: {note}")

    print("\n  Ranking — unmet-need shortlist against planted unmet need")
    print("  " + "-" * 92)
    print(
        f"  {'K':>4}  {'Hits':>5}  {'Recall@K':<12} {'(ceiling)':<10} "
        f"{'Precision@K':<14} NDCG@K"
    )
    for result in rankings:
        recall = result.recall_at_k.value
        precision = result.precision_at_k.value
        print(
            f"  {result.k:>4}  {result.hits_at_k:>5}  "
            f"{(f'{recall:.1%}' if recall is not None else 'n/a'):<12} "
            f"{f'max {result.max_possible_recall:.1%}':<10} "
            f"{(f'{precision:.1%}' if precision is not None else 'n/a'):<14} "
            f"{result.ndcg_at_k:.3f}"
        )
    print(
        "    Recall@K is bounded by K/relevant; the ceiling column is what a "
        "perfect ranking could reach."
    )


def leakage_statement() -> str:
    """The claim this harness is entitled to make, and its basis."""
    return (
        "No ground-truth column reached the analytics. The five analysis files are executed "
        "through local.run_file, which raises PermissionError if a query names an evaluation "
        "table; labels are read only after every analysis has produced its output, and joined "
        "in Python. In BigQuery the same separation is enforced by dataset permissions: the "
        "analytics service account has no read grant on voice_eval."
    )
