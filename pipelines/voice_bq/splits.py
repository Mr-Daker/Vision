"""The development / hidden split of the planted scenario cells.

Why a split at all: every threshold in the analysis SQL was chosen by looking
at how it scored against the planted scenarios. A figure produced on the same
cells that set the threshold measures the fitting, not the method. The split
separates the cells that were allowed to inform the rules from the cells that
decide whether the rules work.

Three properties this needs, and how each is obtained.

**Deterministic.** The assignment is a SHA-256 of the cell identity and a fixed
salt, so it does not depend on row order, pandas version, or when it was run.
Re-deriving the split next month gives the same answer, which is what makes a
freeze meaningful.

**Stratified.** Scenario D has 18 cells and Scenario A has 26. A uniform random
70/30 over all 162 could leave a scenario with two hidden examples by chance,
and a metric computed on two examples is not a metric. Splitting *within* each
scenario keeps the proportions intact.

**Auditable.** The result is written to `data/metadata/scenario_split.csv`,
which is tracked in git, so a reviewer can check that the hidden set used in a
report is the hidden set that was frozen and not one selected afterwards.

The split belongs to the evaluation side. It is derived from label data and
must never be joined into an analytics query — the runner enforces that the
same way it enforces the rest of the boundary.
"""

from __future__ import annotations

import hashlib
from pathlib import Path

import pandas as pd

from . import config as cfg

#: Bumped only if the split must genuinely change. Changing it invalidates
#: every frozen evaluation that came before, which is the point of recording it.
SPLIT_SALT = "voice-eval-split-v1"

DEV_FRACTION = 0.70

SPLIT_PATH = cfg.DATA / "metadata" / "scenario_split.csv"

DEV = "development"
HIDDEN = "hidden"


def _rank_key(district_key: str, sector: str) -> str:
    digest = hashlib.sha256(f"{SPLIT_SALT}|{district_key}|{sector}".encode()).hexdigest()
    return digest


#: Stratum label for cells carrying no planted scenario.
UNPLANTED = "none"


def assign(planted: pd.DataFrame, all_cells: pd.DataFrame | None = None) -> pd.DataFrame:
    """Splits cells into development and hidden, stratified by scenario.

    Cells are ordered inside each stratum by their hash and the first 70%
    become development, so the boundary is a property of the cell identity
    rather than of anything observed about the cell — a split that depended on
    report volume or deficit would quietly put the easy cases on one side.

    **Unplanted cells are split too**, as their own stratum, and this matters
    more than it looks. An earlier version split only the 162 planted cells and
    left all 2,346 unplanted cells in both universes. Because unplanted cells
    are where false positives come from, both splits then carried the *same*
    false-positive pool while the hidden split had far fewer true positives —
    so hidden precision was depressed by construction and the apparent
    generalisation gap was partly an artefact of the split, not a property of
    the rules. Splitting everything makes the two universes comparable samples
    of the same country.
    """
    frame = planted[["district_key", "sector", "scenario_code"]].drop_duplicates().copy()
    if all_cells is not None:
        known = set(zip(frame["district_key"], frame["sector"]))
        unplanted = all_cells[
            ~all_cells.apply(lambda r: (r["district_key"], r["sector"]) in known, axis=1)
        ][["district_key", "sector"]].copy()
        unplanted["scenario_code"] = UNPLANTED
        frame = pd.concat([frame, unplanted], ignore_index=True)
    frame["hash_key"] = [
        _rank_key(district_key, sector)
        for district_key, sector in zip(frame["district_key"], frame["sector"])
    ]
    frame = frame.sort_values(["scenario_code", "hash_key"]).reset_index(drop=True)

    assignments: list[str] = []
    for _, group in frame.groupby("scenario_code", sort=True):
        count = len(group)
        # At least one hidden cell per scenario, even in a small stratum: a
        # scenario with no hidden example cannot be evaluated at all, which is
        # worse than one evaluated on a single example and said to be.
        dev_count = min(count - 1, int(round(count * DEV_FRACTION))) if count > 1 else count
        assignments.extend([DEV] * dev_count + [HIDDEN] * (count - dev_count))
    frame["split"] = assignments
    frame["split_salt"] = SPLIT_SALT
    return frame[["district_key", "sector", "scenario_code", "split", "split_salt", "hash_key"]]


def build(write: bool = True) -> pd.DataFrame:
    """Derives the split over every district-sector cell and records it."""
    planted = pd.read_csv(
        cfg.SOURCES["planted_scenarios"],
        dtype={"district_key": str, "state_code": str, "district_code": str},
    )
    master = pd.read_parquet(
        cfg.SOURCES["district_sector_month"], columns=["district_key", "sector"]
    )
    master["district_key"] = master["district_key"].astype(str)
    all_cells = master.drop_duplicates().reset_index(drop=True)
    split = assign(planted, all_cells)
    if write:
        SPLIT_PATH.parent.mkdir(parents=True, exist_ok=True)
        split.to_csv(SPLIT_PATH, index=False)
    return split


def load() -> pd.DataFrame:
    """Reads the recorded split, deriving it if it has never been written.

    Reading the recorded file rather than always re-deriving is deliberate: if
    the generator is ever re-run with a different seed and the planted cells
    move, the recorded split is the one the frozen evaluation referred to, and
    a silent re-derivation would change the hidden set without anyone noticing.
    """
    if SPLIT_PATH.exists():
        return pd.read_csv(SPLIT_PATH, dtype={"district_key": str})
    return build()


def summarise(split: pd.DataFrame) -> pd.DataFrame:
    return (
        split.groupby(["scenario_code", "split"])
        .size()
        .unstack(fill_value=0)
        .rename(columns={DEV: "development", HIDDEN: "hidden"})
        .assign(total=lambda f: f.sum(axis=1))
    )
