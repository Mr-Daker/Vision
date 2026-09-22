"""Where every value in this dataset came from, and what may be claimed of it.

The repository already has this discipline: `docs/foundation/V004-source-and-reuse-register.md`
sorts every candidate source into four `demo_status` labels and states plainly
that *public visibility of a dataset is not permission to reuse it in bulk*.
This module carries the same rule into the data pipeline rather than inventing
a second, looser vocabulary beside it.

The three origins below are what any downstream reader must be able to tell
apart at a glance, on every row:

- ``real``     — copied from an official source under a licence that permits
                 reuse. Today that means data.gov.in, whose datasets carry the
                 Government Open Data License – India.
- ``derived``  — computed from a ``real`` value by a documented rule (a rate
                 from a count, a proxy built from census characteristics).
                 Plausible, reproducible, and **not** an official statistic.
- ``synthetic``— authored by the generator. Represents no real record, no real
                 person and no real government action.

Nothing in this pipeline may write a ``real`` origin onto a number that was not
actually fetched from a source. That is the single rule this file exists for.
"""

from __future__ import annotations

import csv
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path

REAL = "real"
DERIVED = "derived"
SYNTHETIC = "synthetic"

ORIGINS = (REAL, DERIVED, SYNTHETIC)


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


@dataclass
class SourceRecord:
    """One row of `data/metadata/sources.csv`.

    The column set mirrors `docs/foundation/registers/source-register.csv` so
    the two registers can be read side by side, with the extra fields §4 of the
    data brief asks for (columns used, cleaning performed, rows retrieved).
    """

    dataset_name: str
    publisher: str
    url_or_location: str
    access_method: str
    geographic_coverage: str
    geographic_level: str
    time_period: str
    access_date: str
    licence_or_permission_status: str
    data_origin: str
    columns_used: str = ""
    cleaning_performed: str = ""
    known_limitations: str = ""
    rows_retrieved: int = 0
    retrieval_status: str = "not_attempted"
    notes: str = ""


@dataclass
class SourceLog:
    """Accumulates what a run actually retrieved, successes and failures alike.

    A source that failed is written out too, with its status and the reason.
    A register that silently drops what did not work would make the next reader
    think it was never tried.
    """

    records: list[SourceRecord] = field(default_factory=list)

    def add(self, record: SourceRecord) -> None:
        self.records.append(record)

    def write(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        columns = list(SourceRecord.__dataclass_fields__.keys())
        with path.open("w", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(handle, fieldnames=columns)
            writer.writeheader()
            for record in sorted(self.records, key=lambda r: (r.data_origin, r.dataset_name)):
                writer.writerow(asdict(record))

    @property
    def succeeded(self) -> list[SourceRecord]:
        return [r for r in self.records if r.retrieval_status == "ok"]

    @property
    def failed(self) -> list[SourceRecord]:
        return [r for r in self.records if r.retrieval_status not in ("ok", "not_attempted")]
