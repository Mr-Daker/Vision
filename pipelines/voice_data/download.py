"""Step 1 — fetch the real sources and record exactly what came back.

This step writes nothing but caches and a register. It does not clean, join or
interpret anything; `prepare.py` does that from the cache. Keeping them apart
means a cleaning bug can be fixed and re-run without touching a government
service again, and it means the register records the retrieval as it happened
rather than as the cleaning step wished it had.

Failures are recorded, not raised. A source that did not answer today is a fact
about the dataset, and the next reader needs to see it in `sources.csv` rather
than discover it by noticing a table is thin.
"""

from __future__ import annotations

import json
from dataclasses import asdict

from . import config, datagov, sources
from .provenance import DERIVED, REAL, SourceLog, SourceRecord, now_iso

DISCOVERY_CACHE = "_pca_discovery.json"


def _discover_pca_resources(refresh: bool = False) -> list[dict[str, str]]:
    """Finds the per-state Census 2011 PCA resources.

    Discovered rather than hard-coded: the catalogue is the authority on what
    exists, and a frozen list would rot silently the first time a resource is
    republished under a new id.
    """
    cache = config.RAW_CENSUS / DISCOVERY_CACHE
    if cache.exists() and not refresh:
        return json.loads(cache.read_text(encoding="utf-8"))["resources"]

    found: dict[str, str] = {}
    queries = (sources.PCA_DISCOVERY_QUERY, *sources.PCA_EXTRA_QUERIES)
    for query in queries:
        for offset in range(0, 240, 40):
            try:
                payload = datagov._get(
                    "lists", {"limit": 40, "offset": offset, "filters[title]": query}
                )
            except datagov.DataGovError:
                break
            records = payload.get("records") or []
            if not records:
                break
            for record in records:
                title = str(record.get("title", "")).strip()
                index = str(record.get("index_name", "")).strip()
                lowered = title.lower()
                if not lowered.startswith(sources.PCA_TITLE_PREFIX):
                    continue
                if lowered in sources.PCA_EXCLUDE_TITLES:
                    continue
                if len(index) != 36:  # non-UUID index names are not fetchable
                    continue
                found.setdefault(index, title)

    resources = [{"resource_id": k, "title": v} for k, v in sorted(found.items(), key=lambda kv: kv[1])]
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(
        json.dumps({"discovered_at": now_iso(), "queries": list(queries), "resources": resources}),
        encoding="utf-8",
    )
    return resources


def run(refresh: bool = False, log: SourceLog | None = None) -> SourceLog:
    config.ensure_dirs()
    log = log or SourceLog()

    if datagov.using_sample_key():
        print(
            "  note: using the public data.gov.in sample key (10 records per request).\n"
            "        Set DATA_GOV_IN_API_KEY to a registered key for faster retrieval."
        )

    # ── Census 2011 PCA, per state ────────────────────────────────────────
    discovered = _discover_pca_resources(refresh=refresh)
    print(f"  census: {len(discovered)} Primary Census Abstract 2011 resources discovered")

    total_rows = 0
    for entry in discovered:
        resource_id = entry["resource_id"]
        title = entry["title"]
        state = title.split("-", 1)[-1].strip() if "-" in title else title
        cache_path = config.RAW_CENSUS / f"pca2011_{resource_id}.json"
        record = SourceRecord(
            dataset_name=title,
            publisher=sources.PCA_PUBLISHER,
            url_or_location=f"https://api.data.gov.in/resource/{resource_id}",
            access_method="data.gov.in REST API (paged JSON)",
            geographic_coverage=state,
            geographic_level="district (with state and rural/urban splits)",
            time_period="Census 2011",
            access_date=now_iso(),
            licence_or_permission_status=sources.GODL,
            data_origin=REAL,
            columns_used=(
                "state_code, district_code, level, name, tru, total_population_person, "
                "no_of_households, literates_population_person, and the age/sex/SC/ST columns"
            ),
            cleaning_performed=(
                "Filtered to level=DISTRICT and tru=Total; codes zero-padded; "
                "numeric columns coerced, non-numeric set to null"
            ),
            known_limitations=(
                "Census 2011 is the most recent full Indian census; district boundaries "
                "and populations have changed materially since."
            ),
        )
        try:
            rows = datagov.fetch_resource(resource_id, cache_path, refresh=refresh)
            record.rows_retrieved = len(rows)
            record.retrieval_status = "ok" if rows else "empty"
            total_rows += len(rows)
        except Exception as error:  # noqa: BLE001 — recorded, never fatal
            record.retrieval_status = "failed"
            record.notes = str(error)[:300]
        log.add(record)

    print(f"  census: {total_rows} rows cached")

    # ── Sector fragments ──────────────────────────────────────────────────
    for resource in sources.SECTOR_RESOURCES:
        cache_path = config.RAW / _sector_dir(resource.sector) / f"{resource.key}.json"
        record = SourceRecord(
            dataset_name=resource.dataset_name,
            publisher=resource.publisher,
            url_or_location=resource.url,
            access_method="data.gov.in REST API (paged JSON)",
            geographic_coverage=resource.state_hint or "selected districts",
            geographic_level=resource.geographic_level,
            time_period=resource.time_period,
            access_date=now_iso(),
            licence_or_permission_status=sources.GODL,
            data_origin=REAL,
            columns_used="see data/processed/*_infrastructure.csv for the mapped columns",
            cleaning_performed=(
                "District names normalised and matched to Census 2011 district codes; "
                "lakh-denominated household counts rescaled to units where noted"
            ),
            known_limitations=(
                "Single-state parliamentary answer: covers a small share of Indian "
                "districts and does not generalise nationally. " + resource.notes
            ),
            notes=resource.notes,
        )
        try:
            rows = datagov.fetch_resource(resource.resource_id, cache_path, refresh=refresh)
            record.rows_retrieved = len(rows)
            record.retrieval_status = "ok" if rows else "empty"
            print(f"  {resource.key}: {len(rows)} rows")
        except Exception as error:  # noqa: BLE001
            record.retrieval_status = "failed"
            record.notes = f"{resource.notes} | {error}"[:300]
            print(f"  {resource.key}: FAILED ({error})")
        log.add(record)

    # ── Sources deliberately not ingested ─────────────────────────────────
    for entry in sources.UNAVAILABLE:
        log.add(
            SourceRecord(
                dataset_name=entry["dataset_name"],
                publisher="see url",
                url_or_location=entry["url"],
                access_method="investigated; no licence-clean bulk access",
                geographic_coverage="National",
                geographic_level="n/a",
                time_period="n/a",
                access_date=now_iso(),
                licence_or_permission_status=(
                    "reference-only — public visibility is not permission for bulk reuse "
                    "(see docs/foundation/V004-source-and-reuse-register.md)"
                ),
                data_origin=DERIVED,
                known_limitations=entry["reason"],
                retrieval_status="not_attempted",
                notes=f"Substitute used: {entry['substitute']}",
            )
        )

    log.write(config.METADATA / "sources.csv")
    ok = len(log.succeeded)
    bad = len(log.failed)
    print(f"  register: {ok} retrieved, {bad} failed, written to data/metadata/sources.csv")
    return log


def _sector_dir(sector: str | None) -> str:
    return {"water": "jjm", "roads": "pmgsy", "education": "udise", "health": "hmis"}.get(
        sector or "", "other"
    )
