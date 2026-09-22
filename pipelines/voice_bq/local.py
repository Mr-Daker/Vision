"""Local validation only — DuckDB standing in for BigQuery over the same files.

This is **not** a second warehouse and nothing in production depends on it. It
exists so that the analytics SQL and the evaluation numbers can be checked
without a cloud project, and so a change to a query can be verified in seconds
rather than by running a billed job.

The trick that makes it honest is that there is exactly one copy of each query.
`sql/*.sql` is written in the subset BigQuery and DuckDB share, with named
placeholders like `{district_sector_month}` for every table reference. This
module binds those names to DuckDB views over the local Parquet; `bq.py` binds
the same names to fully-qualified BigQuery tables. If the two ever diverge it is
a bug in the binding, not two queries drifting apart.

Where the dialects genuinely differ — `ST_GEOGPOINT` versus DuckDB's spatial
`ST_Point`, `SAFE.PARSE_DATE` versus `TRY_CAST` — the difference is confined to
`GEO_SHIMS` below and does not touch the analyses, which use no geography.
"""

from __future__ import annotations

import re
from pathlib import Path

import duckdb

from . import config as cfg

SQL_DIR = Path(__file__).resolve().parent / "sql"

#: Placeholder -> the DuckDB relation that satisfies it.
TABLE_BINDINGS = {
    "district_sector_month": "district_sector_month",
    "citizen_reports": "citizen_reports",
    "canonical_issues": "canonical_issues",
    "public_projects": "public_projects",
    "district_demographics": "district_demographics",
    "district_infrastructure": "district_infrastructure",
    "district_master": "district_master",
    "analytics_features": "analytics_features",
    "analytics_safe_district_sector_month": "analytics_safe_district_sector_month",
    # Evaluation labels. Bound only for the evaluation harness; the analysis
    # files never reference these names, and `assert_no_label_access` proves it.
    "planted_scenarios": "planted_scenarios",
    "district_sector_month_labels": "district_sector_month_labels",
}

#: Names an analysis query is forbidden to mention. Checked before execution,
#: so a leak fails loudly here as well as by IAM in BigQuery.
LABEL_BINDINGS = frozenset(
    {"planted_scenarios", "district_sector_month_labels", "canonical_issue_labels"}
)

GEO_SHIMS = {
    "ST_GEOGPOINT": "ST_Point",
}


def connect() -> duckdb.DuckDBPyConnection:
    """A connection with views over whatever `pipelines/voice_data` last wrote."""
    connection = duckdb.connect(":memory:")
    connection.execute("INSTALL spatial; LOAD spatial;")

    def view(name: str, path: Path, reader: str) -> None:
        if not path.exists():
            raise FileNotFoundError(
                f"{path} is missing. Run `npm run data:all` before local validation."
            )
        connection.execute(
            f"CREATE OR REPLACE VIEW {name} AS SELECT * FROM {reader}('{path.as_posix()}')"
        )

    view("citizen_reports", cfg.SOURCES["citizen_reports"], "read_parquet")
    view("canonical_issues_raw", cfg.SOURCES["canonical_issues"], "read_parquet")
    view("district_sector_month_raw", cfg.SOURCES["district_sector_month"], "read_parquet")
    view("district_master", cfg.SOURCES["district_master"], "read_csv_auto")
    view("district_demographics", cfg.SOURCES["district_demographics"], "read_csv_auto")
    view("public_projects", cfg.SOURCES["public_projects"], "read_csv_auto")
    view("planted_scenarios", cfg.SOURCES["planted_scenarios"], "read_csv_auto")

    # The analytics-visible copies drop the evaluation labels, exactly as the
    # BigQuery build does. Same exclusion, same place in the flow.
    from . import schema

    connection.execute(
        f"""
        CREATE OR REPLACE VIEW district_sector_month AS
        SELECT * EXCLUDE ({", ".join(schema.MASTER_LABELS)})
        FROM district_sector_month_raw
        """
    )
    connection.execute(
        f"""
        CREATE OR REPLACE VIEW canonical_issues AS
        SELECT * EXCLUDE ({", ".join(schema.ISSUE_LABELS)})
        FROM canonical_issues_raw
        """
    )
    # Label views, for the evaluation harness only.
    connection.execute(
        f"""
        CREATE OR REPLACE VIEW district_sector_month_labels AS
        SELECT district_key, state_code, district_code, sector, year, month,
               {", ".join(schema.MASTER_LABELS)}
        FROM district_sector_month_raw
        """
    )

    # Stacked sector infrastructure, matching the BigQuery load.
    parts = []
    for sector, path in cfg.INFRASTRUCTURE_SOURCES.items():
        if path.exists():
            parts.append(
                f"SELECT district_key, state_code, infrastructure_score, "
                f"infrastructure_deficit_score, data_origin, '{sector}' AS sector "
                f"FROM read_csv_auto('{path.as_posix()}')"
            )
    if parts:
        connection.execute(
            "CREATE OR REPLACE VIEW district_infrastructure AS " + " UNION ALL ".join(parts)
        )

    return connection


def bind(sql: str, bindings: dict[str, str] | None = None) -> str:
    """Replaces `{table}` placeholders with DuckDB relation names."""
    bound = sql
    for name, relation in (bindings or TABLE_BINDINGS).items():
        bound = bound.replace(f"{{{name}}}", relation)
    for bigquery_fn, duckdb_fn in GEO_SHIMS.items():
        bound = bound.replace(bigquery_fn, duckdb_fn)
    leftover = re.findall(r"\{([a-z_]+)\}", bound)
    if leftover:
        raise KeyError(f"unbound table placeholder(s): {sorted(set(leftover))}")
    return bound


def assert_no_label_access(sql: str, source: str) -> None:
    """Refuses an analysis query that names an evaluation table.

    In BigQuery this is enforced by dataset permissions. Locally there are no
    permissions, so the same guarantee is enforced by reading the query — which
    also means a leak is caught at development time rather than at deploy.
    """
    mentioned = sorted(name for name in LABEL_BINDINGS if f"{{{name}}}" in sql)
    if mentioned:
        raise PermissionError(
            f"{source} references evaluation label table(s) {mentioned}. "
            "Analysis SQL must read only analytics tables (V050b §3)."
        )


def load_sql(filename: str) -> str:
    return (SQL_DIR / filename).read_text(encoding="utf-8")


def run_file(
    connection: duckdb.DuckDBPyConnection,
    filename: str,
    *,
    allow_labels: bool = False,
):
    """Executes one .sql file. Returns the final statement's result, if any."""
    sql = load_sql(filename)
    if not allow_labels:
        assert_no_label_access(sql, filename)
    result = None
    for statement in split_statements(sql):
        result = connection.execute(bind(statement))
    return result


def split_statements(sql: str) -> list[str]:
    """Splits on statement boundaries, ignoring semicolons inside literals.

    A naive `sql.split(";")` truncates any string containing a semicolon,
    which is exactly what the reason-code expressions are built from. The
    failure is a parser error rather than a wrong answer, but only because
    the truncation happened to be syntactically invalid — worth not relying on.
    """
    statements: list[str] = []
    current: list[str] = []
    in_string = False
    in_line_comment = False
    previous = ""
    for char in sql:
        if in_line_comment:
            current.append(char)
            if char == "\n":
                in_line_comment = False
            continue
        if not in_string and char == "-" and previous == "-":
            in_line_comment = True
            current.append(char)
            previous = char
            continue
        if char == "'":
            in_string = not in_string
        if char == ";" and not in_string:
            statement = "".join(current).strip()
            if statement:
                statements.append(statement)
            current = []
            previous = char
            continue
        current.append(char)
        previous = char
    tail = "".join(current).strip()
    if tail:
        statements.append(tail)
    return statements
