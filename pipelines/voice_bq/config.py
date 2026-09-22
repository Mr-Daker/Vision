"""Where the warehouse lives, and how this package is told about it.

Nothing here is hard-coded to a project, a dataset or a region. Every value
comes from the environment, because a Digital Public Good that only runs in
one team's Google Cloud project is not portable and a project id compiled into
source is the usual way that happens.

Credentials are never read from this repository. Locally the client picks up
**Application Default Credentials** (`gcloud auth application-default login`);
on Cloud Run it picks up the service account attached to the revision. There is
no code path that loads a key file, and none should be added.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
DATA = REPO_ROOT / "data"
SQL_DIR = Path(__file__).resolve().parent / "sql"

#: The analytical dataset. Holds every fact and no evaluation label.
ANALYTICS_DATASET_DEFAULT = "voice_analytics"

#: The evaluation dataset. Holds the planted labels and nothing else. Kept
#: physically separate so leakage is an IAM boundary, not a review promise
#: (V050b §3).
EVAL_DATASET_DEFAULT = "voice_eval"

LOCATION_DEFAULT = "asia-south1"
"""Default region. India-resident by default for an India-scale system; a
deployment elsewhere sets BIGQUERY_LOCATION."""


class ConfigurationError(RuntimeError):
    """Raised when a required setting is absent, rather than guessing one."""


@dataclass(frozen=True)
class BigQueryConfig:
    project: str
    analytics_dataset: str
    eval_dataset: str
    location: str
    staging_bucket: str | None

    @property
    def analytics(self) -> str:
        return f"{self.project}.{self.analytics_dataset}"

    @property
    def evaluation(self) -> str:
        return f"{self.project}.{self.eval_dataset}"

    def table(self, name: str) -> str:
        return f"{self.analytics}.{name}"

    def eval_table(self, name: str) -> str:
        return f"{self.evaluation}.{name}"


def load(require_project: bool = True) -> BigQueryConfig:
    project = (
        os.environ.get("VOICE_BIGQUERY_PROJECT")
        or os.environ.get("GOOGLE_CLOUD_PROJECT")
        or ""
    ).strip()
    if require_project and not project:
        raise ConfigurationError(
            "No Google Cloud project configured.\n"
            "  Set VOICE_BIGQUERY_PROJECT (or GOOGLE_CLOUD_PROJECT), then authenticate with:\n"
            "    gcloud auth application-default login\n"
            "  This package never reads a service-account key file."
        )
    return BigQueryConfig(
        project=project,
        analytics_dataset=os.environ.get("VOICE_BIGQUERY_DATASET", ANALYTICS_DATASET_DEFAULT),
        eval_dataset=os.environ.get("VOICE_BIGQUERY_EVAL_DATASET", EVAL_DATASET_DEFAULT),
        location=os.environ.get("BIGQUERY_LOCATION", LOCATION_DEFAULT),
        staging_bucket=(os.environ.get("VOICE_BIGQUERY_STAGING_BUCKET") or "").strip() or None,
    )


# ── Source files produced by pipelines/voice_data ──────────────────────────

#: (table name, source path, whether the source is Parquet).
#: Parquet wherever the pipeline emits it: typed, compressed, and loadable
#: without BigQuery having to guess a schema from text.
SOURCES: dict[str, Path] = {
    "citizen_reports": DATA / "synthetic" / "citizen_reports.parquet",
    "canonical_issues": DATA / "synthetic" / "canonical_issues.parquet",
    "district_sector_month": DATA / "master" / "district_sector_master.parquet",
    "district_master": DATA / "master" / "district_master.csv",
    "district_demographics": DATA / "processed" / "demographics.csv",
    "public_projects": DATA / "processed" / "public_investments.csv",
    "planted_scenarios": DATA / "synthetic" / "planted_scenarios.csv",
}

#: The four sector infrastructure tables are stacked into one on load, because
#: every analytical query wants `sector` as a column rather than four tables to
#: union by hand.
INFRASTRUCTURE_SOURCES: dict[str, Path] = {
    "water": DATA / "processed" / "water_infrastructure.csv",
    "roads": DATA / "processed" / "road_infrastructure.csv",
    "education": DATA / "processed" / "education_infrastructure.csv",
    "health": DATA / "processed" / "health_infrastructure.csv",
}

SECTORS = ("water", "roads", "education", "health")
