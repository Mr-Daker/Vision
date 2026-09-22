"""BigQuery access, authenticated the way Google intends and no other way.

Locally this resolves Application Default Credentials, which a developer
establishes once with `gcloud auth application-default login`. On Cloud Run it
resolves the service account attached to the revision. Both are handled by the
client library's default credential chain, so there is nothing to configure and
nothing to leak.

There is deliberately no code path that reads a service-account key file. Key
files are the thing that ends up committed, pasted into a chat, or copied onto
a laptop, and none of that is necessary when workload identity exists.
"""

from __future__ import annotations

from google.api_core import exceptions as gexc
from google.cloud import bigquery

from .config import BigQueryConfig, ConfigurationError


class AuthenticationError(RuntimeError):
    pass


def bigquery_client(config: BigQueryConfig) -> bigquery.Client:
    try:
        return bigquery.Client(project=config.project, location=config.location)
    except Exception as error:  # noqa: BLE001 — turned into actionable advice
        raise AuthenticationError(
            "Could not authenticate to BigQuery.\n"
            "  Locally:    gcloud auth application-default login\n"
            "  On Cloud Run: attach a service account to the revision.\n"
            f"  Underlying error: {error}"
        ) from error


def run_query(client: bigquery.Client, sql: str, *, label: str = "") -> bigquery.table.RowIterator:
    """Runs a statement and turns BigQuery's common refusals into advice."""
    try:
        job = client.query(sql)
        return job.result()
    except gexc.Forbidden as error:
        raise PermissionError(
            f"BigQuery refused the query{f' ({label})' if label else ''}.\n"
            "  If this query touched the evaluation dataset from an analytics context, that "
            "refusal is the leakage control working as designed (V050b §3).\n"
            f"  Underlying error: {error}"
        ) from error
    except gexc.NotFound as error:
        raise ConfigurationError(
            f"BigQuery could not find a dataset or table{f' ({label})' if label else ''}. "
            "Run `npm run bigquery:setup` and `npm run bigquery:load` first.\n"
            f"  Underlying error: {error}"
        ) from error


def dataset_exists(client: bigquery.Client, dataset_id: str) -> bool:
    try:
        client.get_dataset(dataset_id)
        return True
    except gexc.NotFound:
        return False


def table_row_count(client: bigquery.Client, table_id: str) -> int | None:
    try:
        return int(client.get_table(table_id).num_rows)
    except gexc.NotFound:
        return None


def column_names(client: bigquery.Client, table_id: str) -> list[str]:
    return [field.name for field in client.get_table(table_id).schema]
