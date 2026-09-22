"""A small, cached client for the data.gov.in open-data API.

Why this exists rather than `requests.get` at each call site: the public API
has two behaviours that shape every fetch in this pipeline, and both are easy
to get silently wrong.

1. **The sample key is capped at 10 records per request**, whatever `limit`
   says. Asking for 1000 returns 10 and reports success. Every full read is
   therefore a paging loop in steps of 10, and a caller that trusts `limit`
   would quietly ingest 10 rows and believe it had the table. Setting
   `DATA_GOV_IN_API_KEY` to a registered key raises the cap; `PAGE_SIZE` is
   read from the first response so a better key is used properly.

2. **Responses are cached to `data/raw/`.** A national census read is thousands
   of requests; re-running `data:prepare` must not re-hammer a government
   service. The cache is the retrieved artefact — `data:download` fills it and
   everything downstream reads from disk, which is also what makes the pipeline
   reproducible offline.

Licence: datasets served here carry the Government Open Data License – India,
which permits reuse with attribution. That is the licence this project relies
on for every row marked `real`.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any, Iterator

import requests

API_ROOT = "https://api.data.gov.in"

#: The sample key data.gov.in publishes for testing. Rate- and page-limited.
#: Override with a registered key via the environment for a full-speed run.
SAMPLE_KEY = "579b464db66ec23bdd000001cdd3946e44ce4aad7209ff7b23ac571b"

USER_AGENT = "VOICE-data-pipeline/0.1 (civic research; contact via repository)"

REQUEST_TIMEOUT = 30
RETRIES = 6
BACKOFF_SECONDS = 4.0
"""Backoff is generous on purpose. A national census read is ~1,900 requests on
the sample key, and the first full run lost ten consecutive states to what was
almost certainly a rate-limit window — each of those resources answered fine
when requested on its own. Retrying harder is the fix; hammering faster is not."""

COURTESY_DELAY = 0.35
"""Pause between requests. This is a free public service, not ours."""


class DataGovError(RuntimeError):
    pass


def api_key() -> str:
    return os.environ.get("DATA_GOV_IN_API_KEY", SAMPLE_KEY).strip() or SAMPLE_KEY


def using_sample_key() -> bool:
    return api_key() == SAMPLE_KEY


def _get(path: str, params: dict[str, Any]) -> dict[str, Any]:
    url = f"{API_ROOT}/{path.lstrip('/')}"
    merged = {"format": "json", "api-key": api_key(), **params}
    last: Exception | None = None
    for attempt in range(RETRIES):
        try:
            response = requests.get(
                url,
                params=merged,
                timeout=REQUEST_TIMEOUT,
                headers={"User-Agent": USER_AGENT},
            )
            if response.status_code != 200:
                raise DataGovError(f"HTTP {response.status_code} for {url}")
            time.sleep(COURTESY_DELAY)
            return response.json()
        except Exception as error:  # noqa: BLE001 — retried, then surfaced
            last = error
            if attempt < RETRIES - 1:
                time.sleep(BACKOFF_SECONDS * (attempt + 1))
    raise DataGovError(f"failed after {RETRIES} attempts: {url}: {last}")


def search_resources(title_contains: str, limit: int = 40) -> list[dict[str, Any]]:
    """Catalogue search.

    `/catalog` and a bare `/resource` are 404; `/lists` with a `filters[title]`
    is the endpoint that answers. The match is fuzzy and relevance-ranked, and
    the `total` it reports counts the whole catalogue rather than the matches,
    so callers must filter the returned titles themselves rather than trusting
    the count.
    """
    payload = _get("lists", {"limit": limit, "filters[title]": title_contains})
    records = payload.get("records", [])
    return [r for r in records if isinstance(r, dict)]


def fetch_resource(
    resource_id: str,
    cache_path: Path,
    *,
    max_records: int | None = None,
    refresh: bool = False,
) -> list[dict[str, Any]]:
    """Reads one resource in full, paging until exhausted, and caches it.

    Returns the record list. The cache holds the records plus the retrieval
    metadata, because a file of numbers with no note of when and from where it
    came is the thing this pipeline is trying not to produce.
    """
    if cache_path.exists() and not refresh:
        cached = json.loads(cache_path.read_text(encoding="utf-8"))
        return cached.get("records", [])

    records: list[dict[str, Any]] = []
    offset = 0
    page_size = 10  # corrected from the first response
    total: int | None = None

    while True:
        payload = _get(
            f"resource/{resource_id}",
            {"limit": 100, "offset": offset},
        )
        page = payload.get("records") or []
        if total is None:
            try:
                total = int(payload.get("total") or 0)
            except (TypeError, ValueError):
                total = None
            if page:
                page_size = max(len(page), 1)
        if not page:
            break
        records.extend(page)
        offset += len(page)
        if max_records is not None and len(records) >= max_records:
            records = records[:max_records]
            break
        if total is not None and offset >= total:
            break
        if len(page) < page_size:
            break

    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(
        json.dumps(
            {
                "resource_id": resource_id,
                "retrieved_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "source_url": f"{API_ROOT}/resource/{resource_id}",
                "licence": "Government Open Data License - India (GODL-India)",
                "record_count": len(records),
                "records": records,
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    return records


def iter_cached(directory: Path) -> Iterator[tuple[Path, dict[str, Any]]]:
    """Every cached payload in a directory, for the prepare step to read."""
    for path in sorted(directory.glob("*.json")):
        try:
            yield path, json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue
