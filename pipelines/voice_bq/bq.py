"""Binds the analysis SQL to BigQuery — the other half of the `local.py` pair.

`local.py` points the `{table}` placeholders at DuckDB views over Parquet; this
points them at fully-qualified BigQuery tables. There is one copy of each query
and two bindings, so a change to an analysis cannot land in one environment and
not the other.

The views the analyses create are materialised in the analytics dataset. The
evaluation label tables are deliberately NOT bound here: a query that tries to
name one raises before it reaches BigQuery, which is the same refusal IAM would
give it, only faster and with a clearer message.
"""

from __future__ import annotations

from . import config as cfg
from . import local, views
from .client import bigquery_client, run_query


def bindings(config: cfg.BigQueryConfig) -> dict[str, str]:
    """Placeholder -> fully-qualified BigQuery reference."""
    analytics = {
        name: f"`{config.analytics}.{name}`"
        for name in (
            "district_sector_month",
            "citizen_reports",
            "canonical_issues",
            "public_projects",
            "district_demographics",
            "district_infrastructure",
            "district_master",
            "analytics_features",
            "analytics_safe_district_sector_month",
        )
    }
    # Evaluation tables are intentionally absent. `local.assert_no_label_access`
    # rejects any analysis naming them before we get here.
    return analytics


def create_views(config: cfg.BigQueryConfig | None = None) -> list[str]:
    """Creates the analytics_safe_* views and the five analysis views."""
    config = config or cfg.load()
    client = bigquery_client(config)
    created: list[str] = []

    for spec in views.VIEWS:
        run_query(client, spec.create_sql(config.analytics), label=spec.name)
        created.append(spec.name)

    table_bindings = bindings(config)
    from .analytics import ANALYSIS_FILES

    for filename in ANALYSIS_FILES:
        sql = local.load_sql(filename)
        local.assert_no_label_access(sql, filename)
        for statement in local.split_statements(sql):
            run_query(client, local.bind(statement, table_bindings), label=filename)
        created.append(filename)

    return created
