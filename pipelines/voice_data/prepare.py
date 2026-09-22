"""Step 2 — turn the cached retrievals into clean, joinable analytical tables.

Reads only from `data/raw/`, writes only to `data/processed/` and
`data/master/`. Nothing here calls the network, so cleaning can be fixed and
re-run freely.

The honest shape of what comes out:

- **Demographics are real.** Every column is a Census 2011 Primary Census
  Abstract figure or a ratio computed directly from two of them.
- **Infrastructure is mixed, and says which it is per row.** Where a real
  district-level table exists for a sector it is used and marked `real`.
  It does not exist for most of India in any of the four sectors, so the
  remainder is a `derived` proxy built from census characteristics by the
  documented rules in `_derive_*` below. A derived proxy is a plausible
  stand-in for modelling, never a statistic about that district.
- **Coordinates are derived.** Placed inside the district's own state extent,
  deterministically. They are not official centroids.
"""

from __future__ import annotations

import json
import math
import re
import unicodedata

import numpy as np
import pandas as pd

from . import config, sources
from .provenance import DERIVED, REAL, now_iso

DISTRICT_LEVEL = "DISTRICT"

# Columns copied straight from the census record.
_PCA_NUMERIC = {
    "no_of_households": "households",
    "total_population_person": "population",
    "total_population_female": "population_female",
    "population_in_the_age_group_0_6_person": "population_child_0_6",
    "scheduled_castes_population_person": "population_sc",
    "scheduled_tribes_population_person": "population_st",
    "literates_population_person": "population_literate",
    "total_worker_population_person": "population_working",
}


def _num(value) -> float:
    """Census cells arrive as ints, floats, '', '-' and stray strings."""
    if value is None:
        return math.nan
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    text = str(value).strip().replace(",", "")
    if text in ("", "-", "NA", "N/A", "na"):
        return math.nan
    try:
        return float(text)
    except ValueError:
        return math.nan


def normalise_name(name: str) -> str:
    """A district name reduced to something two sources can be joined on.

    Government tables spell the same district a dozen ways: case, accents,
    'and'/'&', bracketed notes, and the very common '*' footnote marker. This
    strips all of it. It is a matching key only and never replaces the
    published name, which is kept verbatim in `district_name`.
    """
    text = unicodedata.normalize("NFKD", str(name or ""))
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    text = text.lower().replace("&", " and ")
    text = re.sub(r"\([^)]*\)", " ", text)
    text = re.sub(r"[^a-z0-9]+", " ", text)
    text = re.sub(r"\b(district|dist|distt|zilla|zila)\b", " ", text)
    return re.sub(r"\s+", " ", text).strip()


# ── Census ─────────────────────────────────────────────────────────────────


def load_pca_records() -> pd.DataFrame:
    """Every cached PCA row, across all state resources."""
    frames: list[pd.DataFrame] = []
    for path in sorted(config.RAW_CENSUS.glob("pca2011_*.json")):
        payload = json.loads(path.read_text(encoding="utf-8"))
        records = payload.get("records") or []
        if records:
            frames.append(pd.DataFrame(records))
    if not frames:
        raise SystemExit(
            "No census cache found. Run `npm run data:download` before `data:prepare`."
        )
    frame = pd.concat(frames, ignore_index=True, sort=False)
    for column in ("state_code", "district_code", "level", "name", "tru"):
        if column not in frame.columns:
            frame[column] = ""
        frame[column] = frame[column].astype(str).str.strip()
    frame["state_code"] = frame["state_code"].str.zfill(2)
    frame["district_code"] = frame["district_code"].str.zfill(3)
    return frame


def build_district_frame(pca: pd.DataFrame) -> pd.DataFrame:
    """District rows with the Total/Rural/Urban split folded into columns."""
    districts = pca[(pca["level"].str.upper() == DISTRICT_LEVEL)].copy()
    if districts.empty:
        raise SystemExit("Census cache holds no DISTRICT rows; re-run the download.")

    for source_column, target in _PCA_NUMERIC.items():
        districts[target] = (
            districts[source_column].map(_num) if source_column in districts.columns else math.nan
        )

    totals = districts[districts["tru"].str.lower() == "total"].copy()
    rural = districts[districts["tru"].str.lower() == "rural"][
        ["state_code", "district_code", "population"]
    ].rename(columns={"population": "population_rural"})
    urban = districts[districts["tru"].str.lower() == "urban"][
        ["state_code", "district_code", "population"]
    ].rename(columns={"population": "population_urban"})

    merged = totals.merge(rural, on=["state_code", "district_code"], how="left").merge(
        urban, on=["state_code", "district_code"], how="left"
    )
    merged = merged.drop_duplicates(subset=["state_code", "district_code"], keep="first")
    merged["district_name"] = merged["name"].str.strip().str.title()
    merged["district_key"] = merged["state_code"] + merged["district_code"]
    merged["name_key"] = merged["district_name"].map(normalise_name)
    return merged.reset_index(drop=True)


def attach_state_names(districts: pd.DataFrame, pca: pd.DataFrame) -> pd.DataFrame:
    """State names come from the STATE-level rows of the same census tables."""
    states = pca[(pca["level"].str.upper() == "STATE") & (pca["tru"].str.lower() == "total")]
    lookup = (
        states.drop_duplicates(subset=["state_code"])
        .set_index("state_code")["name"]
        .str.strip()
        .str.title()
        .to_dict()
    )
    districts = districts.copy()
    districts["state_name"] = districts["state_code"].map(lookup).fillna("Unknown")
    return districts


def derive_coordinates(districts: pd.DataFrame, seed: int) -> pd.DataFrame:
    """A plausible point inside the district's own state, deterministically.

    Not a centroid. The census abstract carries no geometry and the boundary
    files that do are outside the licence position agreed for this pipeline
    (see `sources.UNAVAILABLE`), so rather than ingest an unlicensed shapefile
    or invent an official-looking coordinate, every district gets a stable
    pseudo-location within its state's extent. Marked `derived` throughout,
    and unfit for real geospatial work.
    """
    districts = districts.copy()
    rng = np.random.default_rng(seed ^ 0xC0FFEE)
    lat = np.empty(len(districts))
    lon = np.empty(len(districts))
    area = np.empty(len(districts))
    for index, state_code in enumerate(districts["state_code"].to_numpy()):
        lat_min, lat_max, lon_min, lon_max, state_area = config.STATE_GEOGRAPHY.get(
            state_code, config.DEFAULT_STATE_GEOGRAPHY
        )
        pad_lat = (lat_max - lat_min) * 0.08
        pad_lon = (lon_max - lon_min) * 0.08
        lat[index] = rng.uniform(lat_min + pad_lat, lat_max - pad_lat)
        lon[index] = rng.uniform(lon_min + pad_lon, lon_max - pad_lon)
        area[index] = state_area
    districts["latitude"] = np.round(lat, 5)
    districts["longitude"] = np.round(lon, 5)

    # Crude equal-split district area, used only for a density proxy.
    per_state = districts.groupby("state_code")["district_code"].transform("count")
    districts["area_km2_derived"] = np.round(area / per_state.to_numpy(), 1)
    return districts


# ── Outputs ────────────────────────────────────────────────────────────────


def write_district_master(districts: pd.DataFrame) -> pd.DataFrame:
    master = pd.DataFrame(
        {
            "country_code": config.COUNTRY_CODE,
            "state_code": districts["state_code"],
            "state_name": districts["state_name"],
            "district_code": districts["district_code"],
            "district_key": districts["district_key"],
            "district_name": districts["district_name"],
            # Block and locality codes are deliberately empty: no official
            # source in this pipeline supplies them, and inventing a code that
            # looks official is exactly what §2 of the brief forbids. Synthetic
            # localities are named, not coded, in the report generator.
            "block_code": "",
            "block_name": "",
            "locality_code": "",
            "locality_name": "",
            "latitude": districts["latitude"],
            "longitude": districts["longitude"],
            "coordinates_origin": DERIVED,
            "codes_origin": REAL,
            "source_name": "Census of India 2011, Primary Census Abstract (via data.gov.in)",
            "source_year": 2011,
        }
    )
    master.to_csv(config.MASTER / "district_master.csv", index=False)
    return master


def write_demographics(districts: pd.DataFrame) -> pd.DataFrame:
    population = districts["population"].replace(0, np.nan)
    rural = districts["population_rural"].fillna(0)
    urban = districts["population_urban"].fillna(0)
    split_total = (rural + urban).replace(0, np.nan)

    demographics = pd.DataFrame(
        {
            "district_key": districts["district_key"],
            "state_code": districts["state_code"],
            "state_name": districts["state_name"],
            "district_code": districts["district_code"],
            "district_name": districts["district_name"],
            "population": districts["population"],
            "households": districts["households"],
            "population_density": np.round(
                districts["population"] / districts["area_km2_derived"], 2
            ),
            "rural_population_pct": np.round(100 * rural / split_total, 2),
            "urban_population_pct": np.round(100 * urban / split_total, 2),
            "literacy_rate": np.round(100 * districts["population_literate"] / population, 2),
            "female_population_pct": np.round(100 * districts["population_female"] / population, 2),
            "sc_population_pct": np.round(100 * districts["population_sc"] / population, 2),
            "st_population_pct": np.round(100 * districts["population_st"] / population, 2),
            "working_population_pct": np.round(100 * districts["population_working"] / population, 2),
            "child_population_pct": np.round(
                100 * districts["population_child_0_6"] / population, 2
            ),
            # Every column above is a census figure or a ratio of two of them.
            # The density column is the one exception and says so.
            "data_origin": REAL,
            "population_density_origin": DERIVED,
            "source_name": "Census of India 2011, Primary Census Abstract (via data.gov.in)",
            "source_url": "https://api.data.gov.in/resource/<per-state PCA resource>",
            "source_year": 2011,
            "retrieved_at": now_iso(),
        }
    )
    demographics.to_csv(config.PROCESSED / "demographics.csv", index=False)
    return demographics


# ── Real sector fragments ──────────────────────────────────────────────────


def _load_sector_fragments() -> dict[str, pd.DataFrame]:
    """Real district-level sector rows, keyed by sector.

    Each source is a different state with a different schema, so each is mapped
    by hand to a single `value` plus the field it populates. Anything that does
    not map is dropped rather than guessed at.
    """
    out: dict[str, list[pd.DataFrame]] = {sector: [] for sector in config.SECTORS}

    def cached(key: str, sector: str) -> list[dict]:
        directory = {"water": "jjm", "roads": "pmgsy", "education": "udise", "health": "hmis"}[
            sector
        ]
        path = config.RAW / directory / f"{key}.json"
        if not path.exists():
            return []
        return json.loads(path.read_text(encoding="utf-8")).get("records", [])

    # Water — tap-water coverage, expressed as a percentage of households.
    rows = cached("water_mp_tap_connections", "water")
    if rows:
        frame = pd.DataFrame(rows)
        total = frame.get("total_households", pd.Series(dtype=float)).map(_num)
        with_tap = frame.filter(regex="tap_water_connection.*nos", axis=1)
        connected = with_tap.iloc[:, 0].map(_num) if with_tap.shape[1] else pd.Series(dtype=float)
        out["water"].append(
            pd.DataFrame(
                {
                    "name_key": frame["district"].map(normalise_name),
                    "tap_water_coverage_pct": (100 * connected / total.replace(0, np.nan)).clip(
                        0, 100
                    ),
                    "total_households_reported": total,
                    "source_key": "water_mp_tap_connections",
                }
            )
        )

    for key, hh_col, tap_col in (
        (
            "water_tn_jjm",
            "total_hhs_as_on_01_04_2021",
            "hhs_with_tap_water_supply__as_on_21_07_2021_",
        ),
        (
            "water_hr_tap",
            "total_rural_hhs",
            "rural_hhs_with_tap_water_connections___number",
        ),
    ):
        rows = cached(key, "water")
        if not rows:
            continue
        frame = pd.DataFrame(rows)
        if hh_col not in frame.columns or tap_col not in frame.columns:
            continue
        # Both tables are denominated in lakhs; the ratio is unit-free so the
        # scale cancels, and only the household count needs rescaling.
        total = frame[hh_col].map(_num)
        connected = frame[tap_col].map(_num)
        out["water"].append(
            pd.DataFrame(
                {
                    "name_key": frame["district"].map(normalise_name),
                    "tap_water_coverage_pct": (100 * connected / total.replace(0, np.nan)).clip(
                        0, 100
                    ),
                    "total_households_reported": total * 100_000,
                    "source_key": key,
                }
            )
        )

    # Roads — completed length in km.
    rows = cached("roads_od_completed", "roads")
    if rows:
        frame = pd.DataFrame(rows)
        length_columns = [c for c in frame.columns if c.startswith("road_length_completed")]
        if length_columns:
            total = sum(frame[c].map(_num).fillna(0) for c in length_columns)
            out["roads"].append(
                pd.DataFrame(
                    {
                        "name_key": frame["district_name"].map(normalise_name),
                        "completed_road_length_km": total,
                        "source_key": "roads_od_completed",
                    }
                )
            )

    rows = cached("roads_ka_constructed", "roads")
    if rows:
        frame = pd.DataFrame(rows)
        if "road_length_completed__in_km_" in frame.columns:
            out["roads"].append(
                pd.DataFrame(
                    {
                        "name_key": frame["district_name"].map(normalise_name),
                        "completed_road_length_km": frame["road_length_completed__in_km_"].map(_num),
                        "source_key": "roads_ka_constructed",
                    }
                )
            )

    # Education — school counts.
    rows = cached("education_hp_schools", "education")
    if rows:
        frame = pd.DataFrame(rows)
        parts = [
            frame[c].map(_num).fillna(0)
            for c in ("primary_schools", "middle_schools", "high_senior_secondary_schools_")
            if c in frame.columns
        ]
        if parts:
            out["education"].append(
                pd.DataFrame(
                    {
                        "name_key": frame["district"].map(normalise_name),
                        "school_count": sum(parts),
                        "source_key": "education_hp_schools",
                    }
                )
            )

    # Health — operational facility counts for aspirational districts.
    rows = cached("health_hwc_aspirational", "health")
    if rows:
        frame = pd.DataFrame(rows)
        name_column = next(
            (c for c in frame.columns if "district" in c or "name" in c), frame.columns[0]
        )
        phc = frame.filter(regex="phc$", axis=1)
        shc = frame.filter(regex="shc$", axis=1)
        out["health"].append(
            pd.DataFrame(
                {
                    "name_key": frame[name_column].map(normalise_name),
                    "phc_count": phc.iloc[:, 0].map(_num) if phc.shape[1] else np.nan,
                    "sub_centre_count": shc.iloc[:, 0].map(_num) if shc.shape[1] else np.nan,
                    "source_key": "health_hwc_aspirational",
                }
            )
        )

    return {
        sector: (
            pd.concat(frames, ignore_index=True).drop_duplicates(subset=["name_key"], keep="first")
            if frames
            else pd.DataFrame(columns=["name_key"])
        )
        for sector, frames in out.items()
    }


# ── Derived infrastructure ─────────────────────────────────────────────────


def _latent_quality(demographics: pd.DataFrame, seed: int) -> pd.DataFrame:
    """A 0–1 'how well served is this district' score per sector.

    Built from real census characteristics by an explicit, stated rule. The
    direction of each term is the only claim being made, and each is a
    commonplace of development statistics rather than anything novel:
    urbanised, literate districts tend to be better served by built
    infrastructure; sparsely populated and more remote districts tend to be
    less so. Magnitudes are chosen to spread the scores, not fitted to
    evidence.

    This is a **modelling convenience, not a measurement**. It produces the
    `derived` rows that stand in where no real district table exists, and its
    output must never be read as a finding about any real district.
    """
    rng = np.random.default_rng(seed ^ 0xA11CE)
    size = len(demographics)

    def unit(series: pd.Series) -> np.ndarray:
        values = pd.to_numeric(series, errors="coerce").to_numpy(dtype=float)
        finite = np.isfinite(values)
        if not finite.any():
            return np.full(size, 0.5)
        low, high = np.nanpercentile(values[finite], [5, 95])
        if not np.isfinite(low) or not np.isfinite(high) or high <= low:
            return np.full(size, 0.5)
        scaled = (values - low) / (high - low)
        return np.clip(np.nan_to_num(scaled, nan=0.5), 0, 1)

    urban = unit(demographics["urban_population_pct"])
    literacy = unit(demographics["literacy_rate"])
    density = unit(np.log1p(pd.to_numeric(demographics["population_density"], errors="coerce")))
    tribal = unit(demographics["st_population_pct"])
    child = unit(demographics["child_population_pct"])

    # A stable per-district "everything else" term: terrain, history, state
    # capacity. Without it every sector in a district would move together,
    # which is both unrealistic and would make the dataset trivially separable.
    district_effect = rng.normal(0, 0.16, size)

    weights = {
        "water": 0.34 * urban + 0.26 * literacy + 0.12 * density - 0.22 * tribal,
        "roads": 0.30 * urban + 0.34 * density + 0.14 * literacy - 0.20 * tribal,
        "education": 0.44 * literacy + 0.18 * urban - 0.16 * child - 0.10 * tribal,
        "health": 0.32 * urban + 0.24 * literacy + 0.18 * density - 0.18 * tribal,
    }

    scores = {}
    for sector, base in weights.items():
        sector_noise = rng.normal(0, 0.13, size)
        raw = 0.42 + base + district_effect + sector_noise
        scores[sector] = np.clip(raw, 0.03, 0.97)
    return pd.DataFrame(scores, index=demographics.index)


def build_infrastructure(
    demographics: pd.DataFrame, seed: int
) -> dict[str, pd.DataFrame]:
    """One table per sector: real rows where they exist, derived elsewhere."""
    quality = _latent_quality(demographics, seed)
    fragments = _load_sector_fragments()
    rng = np.random.default_rng(seed ^ 0xBEEF)

    population = pd.to_numeric(demographics["population"], errors="coerce").fillna(0).to_numpy()
    households = pd.to_numeric(demographics["households"], errors="coerce").fillna(0).to_numpy()
    child_pct = pd.to_numeric(demographics["child_population_pct"], errors="coerce").fillna(13).to_numpy()
    area = np.maximum(population / np.maximum(
        pd.to_numeric(demographics["population_density"], errors="coerce").fillna(300).to_numpy(), 1
    ), 1)
    name_key = demographics["district_name"].map(normalise_name)

    base = pd.DataFrame(
        {
            "district_key": demographics["district_key"],
            "state_code": demographics["state_code"],
            "state_name": demographics["state_name"],
            "district_code": demographics["district_code"],
            "district_name": demographics["district_name"],
            "name_key": name_key,
        }
    )

    tables: dict[str, pd.DataFrame] = {}

    # ── Water ─────────────────────────────────────────────────────────────
    score = quality["water"].to_numpy()
    water = base.copy()
    water["tap_water_coverage_pct"] = np.round(np.clip(100 * score + rng.normal(0, 4, len(base)), 1, 100), 2)
    water["total_households"] = households
    water["water_scheme_count"] = np.maximum(
        1, np.round(households / 2200 * (0.75 + 0.5 * score) + rng.normal(0, 3, len(base)))
    ).astype(int)
    water["functional_water_scheme_pct"] = np.round(
        np.clip(100 * (0.55 + 0.4 * score) + rng.normal(0, 6, len(base)), 5, 100), 2
    )
    water["data_origin"] = DERIVED

    real = fragments["water"]
    if not real.empty and "tap_water_coverage_pct" in real.columns:
        water = water.merge(real, on="name_key", how="left", suffixes=("", "_real"))
        has_real = water["tap_water_coverage_pct_real"].notna()
        water.loc[has_real, "tap_water_coverage_pct"] = water.loc[
            has_real, "tap_water_coverage_pct_real"
        ].round(2)
        water.loc[has_real, "data_origin"] = REAL
        water["real_source_key"] = water.get("source_key", "")
        water = water.drop(
            columns=[c for c in ("tap_water_coverage_pct_real", "total_households_reported", "source_key") if c in water.columns]
        )
    water["households_with_tap_water"] = np.round(
        water["total_households"] * water["tap_water_coverage_pct"] / 100
    ).astype("int64")
    tables["water"] = water

    # ── Roads ─────────────────────────────────────────────────────────────
    score = quality["roads"].to_numpy()
    roads = base.copy()
    roads["road_length_km"] = np.round(np.maximum(area * (0.18 + 0.55 * score) + rng.normal(0, 30, len(base)), 20), 1)
    roads["sanctioned_road_length_km"] = np.round(roads["road_length_km"] * (0.10 + 0.14 * (1 - score)), 1)
    roads["completed_road_length_km"] = np.round(
        roads["sanctioned_road_length_km"] * np.clip(0.45 + 0.5 * score + rng.normal(0, 0.09, len(base)), 0.08, 1.0), 1
    )
    roads["data_origin"] = DERIVED

    real = fragments["roads"]
    if not real.empty and "completed_road_length_km" in real.columns:
        roads = roads.merge(real, on="name_key", how="left", suffixes=("", "_real"))
        has_real = roads["completed_road_length_km_real"].notna()
        roads.loc[has_real, "completed_road_length_km"] = roads.loc[has_real, "completed_road_length_km_real"].round(1)
        roads.loc[has_real, "sanctioned_road_length_km"] = np.maximum(
            roads.loc[has_real, "sanctioned_road_length_km"],
            roads.loc[has_real, "completed_road_length_km"],
        )
        roads.loc[has_real, "data_origin"] = REAL
        roads = roads.drop(columns=[c for c in ("completed_road_length_km_real", "source_key") if c in roads.columns])

    roads["road_completion_pct"] = np.round(
        np.clip(100 * roads["completed_road_length_km"] / roads["sanctioned_road_length_km"].replace(0, np.nan), 0, 100), 2
    ).fillna(0)
    roads["road_project_count"] = np.maximum(1, np.round(roads["sanctioned_road_length_km"] / 11)).astype(int)
    tables["roads"] = roads

    # ── Education ─────────────────────────────────────────────────────────
    score = quality["education"].to_numpy()
    children = population * child_pct / 100
    education = base.copy()
    education["school_count"] = np.maximum(
        5, np.round(children / 210 * (0.8 + 0.35 * score) + rng.normal(0, 12, len(base)))
    ).astype(int)
    education["data_origin"] = DERIVED

    real = fragments["education"]
    if not real.empty and "school_count" in real.columns:
        education = education.merge(real, on="name_key", how="left", suffixes=("", "_real"))
        has_real = education["school_count_real"].notna()
        education.loc[has_real, "school_count"] = education.loc[has_real, "school_count_real"].round().astype("int64")
        education.loc[has_real, "data_origin"] = REAL
        education = education.drop(columns=[c for c in ("school_count_real", "source_key") if c in education.columns])

    education["student_enrolment"] = np.round(children * np.clip(0.72 + 0.22 * score, 0.4, 0.99)).astype("int64")
    for column, centre, spread in (
        ("schools_with_drinking_water_pct", 0.58, 0.40),
        ("schools_with_toilets_pct", 0.55, 0.42),
        ("schools_with_electricity_pct", 0.35, 0.60),
        ("schools_with_boundary_wall_pct", 0.40, 0.52),
    ):
        education[column] = np.round(np.clip(100 * (centre + spread * score) + rng.normal(0, 5, len(base)), 2, 100), 2)
    education["schools_requiring_major_repair_pct"] = np.round(
        np.clip(100 * (0.34 - 0.27 * score) + rng.normal(0, 3.5, len(base)), 0.5, 60), 2
    )
    education["pupil_teacher_ratio"] = np.round(np.clip(46 - 22 * score + rng.normal(0, 3, len(base)), 8, 90), 1)
    tables["education"] = education

    # ── Health ────────────────────────────────────────────────────────────
    score = quality["health"].to_numpy()
    health = base.copy()
    per_100k = population / 100_000
    health["phc_count"] = np.maximum(1, np.round(per_100k * (2.1 + 1.6 * score) + rng.normal(0, 1.5, len(base)))).astype(int)
    health["chc_count"] = np.maximum(0, np.round(per_100k * (0.45 + 0.4 * score) + rng.normal(0, 0.6, len(base)))).astype(int)
    health["data_origin"] = DERIVED

    real = fragments["health"]
    if not real.empty and "phc_count" in real.columns:
        health = health.merge(real, on="name_key", how="left", suffixes=("", "_real"))
        has_real = health["phc_count_real"].notna()
        health.loc[has_real, "phc_count"] = health.loc[has_real, "phc_count_real"].round().astype("int64")
        health.loc[has_real, "data_origin"] = REAL
        health = health.drop(
            columns=[c for c in ("phc_count_real", "sub_centre_count", "source_key") if c in health.columns]
        )

    health["hospital_count"] = np.maximum(0, np.round(per_100k * (0.30 + 0.55 * score) + rng.normal(0, 0.5, len(base)))).astype(int)
    health["health_facilities_per_100k"] = np.round(
        (health["phc_count"] + health["chc_count"] + health["hospital_count"]) / np.maximum(per_100k, 0.01), 2
    )
    health["bed_count"] = np.maximum(
        0, np.round(health["phc_count"] * 6 + health["chc_count"] * 30 + health["hospital_count"] * 95)
    ).astype("int64")
    health["beds_per_100k"] = np.round(health["bed_count"] / np.maximum(per_100k, 0.01), 2)
    health["doctor_or_staff_availability_indicator"] = np.round(np.clip(0.30 + 0.62 * score + rng.normal(0, 0.06, len(base)), 0.02, 1.0), 3)
    health["facility_utilization_indicator"] = np.round(np.clip(0.45 + 0.4 * (1 - score) + rng.normal(0, 0.07, len(base)), 0.05, 1.3), 3)
    tables["health"] = health

    # Shared provenance columns and the deficit score every later step uses.
    for sector, table in tables.items():
        table["infrastructure_score"] = np.round(100 * quality[sector].to_numpy(), 2)
        table["infrastructure_deficit_score"] = np.round(100 - table["infrastructure_score"], 2)
        table["sector"] = sector
        table["source_name"] = (
            "Real rows: data.gov.in district tables (see sources.csv). "
            "Derived rows: modelled from Census 2011 characteristics."
        )
        table["source_year"] = 2011
        table["retrieved_at"] = now_iso()
        if "real_source_key" not in table.columns:
            table["real_source_key"] = ""
        table["real_source_key"] = table["real_source_key"].fillna("")
        table.drop(columns=["name_key"], inplace=True, errors="ignore")

    filenames = {
        "water": "water_infrastructure.csv",
        "roads": "road_infrastructure.csv",
        "education": "education_infrastructure.csv",
        "health": "health_infrastructure.csv",
    }
    for sector, table in tables.items():
        table.to_csv(config.PROCESSED / filenames[sector], index=False)
    return tables


# ── Public investment / projects ───────────────────────────────────────────

#: The real central scheme each sector's work would sit under. The scheme NAME
#: is real; every project record generated against it is synthetic and says so
#: on the row. No figure below is a real sanction, release or expenditure, and
#: none should ever be quoted as one.
SECTOR_SCHEMES = {
    "water": ("Jal Jeevan Mission", "piped water supply"),
    "roads": ("Pradhan Mantri Gram Sadak Yojana", "rural road connectivity"),
    "education": ("Samagra Shiksha", "school infrastructure strengthening"),
    "health": ("Ayushman Bharat Health Infrastructure Mission", "health facility upgrade"),
}

SYNTHETIC_PROJECT_NOTICE = (
    "SYNTHETIC project record. Not a real sanction, release or expenditure. "
    "Generated for analytics evaluation only."
)

#: How many projects a cell gets, and what state they are in, per scenario
#: investment profile. `none` is the important one: Scenario A must have no
#: matching project, because that absence is the thing to be detected.
_PROFILE_PLAN = {
    "none": (0, 0, None),
    "active": (1, 2, "in_progress"),
    "completed_spent": (1, 2, "completed"),
    "stalled": (1, 1, "delayed"),
    "adequate": (1, 3, "completed"),
    "baseline": (0, 2, None),
}


def build_investments(
    demographics: pd.DataFrame,
    infrastructure: dict[str, pd.DataFrame],
    planted: pd.DataFrame,
    seed: int,
) -> pd.DataFrame:
    """Synthetic project records, shaped by need and by planted scenario.

    Ordinary cells get projects roughly in proportion to their deficit and
    population — the plausible baseline of a country that does spend money
    where problems are, imperfectly. Planted cells override that, because the
    presence, absence or completion of a matching project is precisely what
    separates scenarios A, B, C and E from each other.
    """
    rng = np.random.default_rng(seed ^ 0x9A17)
    window_end = pd.Timestamp(year=config.WINDOW_END_YEAR, month=config.WINDOW_END_MONTH, day=28)
    window_start = window_end - pd.DateOffset(months=config.MONTHS)

    profile_by_cell = {
        (row.district_key, row.sector): row.investment_profile
        for row in planted.itertuples()
    } if not planted.empty else {}

    population = pd.to_numeric(demographics["population"], errors="coerce").fillna(0)
    population_by_key = dict(zip(demographics["district_key"], population))
    meta = demographics.set_index("district_key")[["state_code", "district_code", "district_name", "state_name"]]

    rows: list[dict] = []
    counter = 0
    for sector in config.SECTORS:
        scheme, scope_label = SECTOR_SCHEMES[sector]
        table = infrastructure[sector]
        deficit = dict(zip(table["district_key"], table["infrastructure_deficit_score"]))

        for district_key in demographics["district_key"]:
            profile = profile_by_cell.get((district_key, sector), "baseline")
            low, high, forced_status = _PROFILE_PLAN[profile]
            district_deficit = float(deficit.get(district_key, 50.0))
            people = float(population_by_key.get(district_key, 0))

            if profile == "baseline":
                # More deficit and more people means more projects, on average,
                # but far from always — plenty of needy places get nothing.
                expected = 0.35 + 1.5 * (district_deficit / 100) ** 1.4 + min(people / 4_000_000, 0.8)
                count = int(rng.poisson(expected))
                count = min(count, 4)
            else:
                count = int(rng.integers(low, high + 1)) if high >= low else 0

            for _ in range(count):
                counter += 1
                sanctioned = float(np.round(rng.lognormal(mean=16.1, sigma=0.85), 2))
                sanction_date = window_start - pd.Timedelta(days=int(rng.integers(30, 900)))

                if forced_status == "completed":
                    status = "completed"
                elif forced_status == "in_progress":
                    status = "in_progress"
                elif forced_status == "delayed":
                    status = "delayed"
                else:
                    status = str(
                        rng.choice(
                            ["planned", "sanctioned", "in_progress", "completed", "delayed"],
                            p=[0.08, 0.14, 0.34, 0.31, 0.13],
                        )
                    )

                if status == "completed":
                    released_ratio = float(rng.uniform(0.86, 1.0))
                    spent_ratio = float(rng.uniform(0.82, released_ratio))
                elif status in ("in_progress", "delayed"):
                    released_ratio = float(rng.uniform(0.32, 0.78))
                    spent_ratio = float(rng.uniform(0.18, released_ratio))
                elif status == "sanctioned":
                    released_ratio = float(rng.uniform(0.0, 0.25))
                    spent_ratio = float(rng.uniform(0.0, released_ratio))
                else:  # planned
                    released_ratio = 0.0
                    spent_ratio = 0.0

                duration = int(rng.integers(240, 1000))
                start_date = sanction_date + pd.Timedelta(days=int(rng.integers(20, 180)))
                expected_completion = start_date + pd.Timedelta(days=duration)

                actual_completion = pd.NaT
                if status == "completed":
                    # Scenario C needs the completion to land *inside* the
                    # window, so that reports continuing after it are visible
                    # as a post-completion pattern rather than pre-history.
                    if profile == "completed_spent":
                        offset = int(rng.integers(4, 13))
                        actual_completion = window_start + pd.DateOffset(months=offset)
                    else:
                        actual_completion = expected_completion + pd.Timedelta(
                            days=int(rng.integers(-60, 220))
                        )
                elif status == "delayed":
                    expected_completion = window_start + pd.Timedelta(days=int(rng.integers(0, 300)))

                info = meta.loc[district_key]
                rows.append(
                    {
                        "project_id": f"VOICE-PRJ-{counter:07d}",
                        "sector": sector,
                        "state_code": info["state_code"],
                        "state_name": info["state_name"],
                        "district_code": info["district_code"],
                        "district_key": district_key,
                        "district_name": info["district_name"],
                        "project_name": f"{scope_label.title()} works, {info['district_name']} ({counter:05d})",
                        "scheme_name": scheme,
                        "sanctioned_amount": sanctioned,
                        "released_amount": float(np.round(sanctioned * released_ratio, 2)),
                        "spent_amount": float(np.round(sanctioned * spent_ratio, 2)),
                        "currency": "INR",
                        "sanction_date": sanction_date.date().isoformat(),
                        "start_date": start_date.date().isoformat(),
                        "expected_completion_date": expected_completion.date().isoformat(),
                        "actual_completion_date": (
                            actual_completion.date().isoformat()
                            if not pd.isna(actual_completion)
                            else ""
                        ),
                        "project_status": status,
                        "project_scope": scope_label,
                        "coverage_area": "district",
                        "source": "synthetic generator (pipelines/voice_data/prepare.py)",
                        "data_origin": "synthetic",
                        "notice": SYNTHETIC_PROJECT_NOTICE,
                    }
                )

    investments = pd.DataFrame(rows)
    investments.to_csv(config.PROCESSED / "public_investments.csv", index=False)
    return investments


# ── Entry point ────────────────────────────────────────────────────────────


def run(seed: int = config.DEFAULT_SEED) -> dict[str, pd.DataFrame]:
    config.ensure_dirs()

    pca = load_pca_records()
    districts = build_district_frame(pca)
    districts = attach_state_names(districts, pca)
    districts = derive_coordinates(districts, seed)
    print(f"  districts: {len(districts)} across {districts['state_code'].nunique()} states/UTs")

    master = write_district_master(districts)
    demographics = write_demographics(districts)
    print(f"  demographics: {len(demographics)} rows (real, Census 2011)")

    infrastructure = build_infrastructure(demographics, seed)
    for sector, table in infrastructure.items():
        real_rows = int((table["data_origin"] == REAL).sum())
        print(f"  {sector}: {len(table)} rows ({real_rows} anchored on real district data)")

    planted = scenarios_module().assign(demographics, infrastructure, seed)
    print(f"  scenarios: {len(planted)} district-sector cells planted")

    investments = build_investments(demographics, infrastructure, planted, seed)
    print(f"  investments: {len(investments)} synthetic project records")

    return {
        "district_master": master,
        "demographics": demographics,
        "investments": investments,
        "planted": planted,
        **infrastructure,
    }


def scenarios_module():
    from . import scenarios

    return scenarios
