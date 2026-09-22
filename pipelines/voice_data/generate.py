"""Step 3 — canonical issues and the citizen reports that observe them.

The design in one paragraph: real district characteristics decide how much
demand a district-sector produces; planted scenarios bend that demand and its
shape over time; canonical issues are the real-world problems; citizen reports
are noisy, duplicated, multilingual observations *of* those issues. Ground
truth lives on the issue, never on the report, so deduplication and aggregation
have something real to recover.

Why it is built the way it is:

- **Conditioned, not random.** A district-sector's report rate is a product of
  population, infrastructure deficit, investment adequacy and reporting
  propensity — every one of which comes from the tables built in `prepare.py`.
  A district with poor tap-water coverage, many people and no water project
  tends to generate persistent water complaints. `config.NOISE_SD` then makes
  sure it is a tendency rather than a formula.

- **Vectorised and chunked.** Report attributes are drawn with NumPy across
  whole chunks and streamed to Parquet through `ParquetWriter`. Nothing loops
  per report, and the full table is never held in memory, so a million rows is
  a matter of seconds and a few hundred megabytes rather than an afternoon.

- **Reporting propensity is separate from need.** This is the point of
  Scenario G. Volume is `need × propensity`, so a district can have severe
  need and almost no reports. Any later analysis that ranks on raw counts will
  get those districts wrong, which is exactly what the dataset is for.
"""

from __future__ import annotations

import hashlib

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

from . import config, text
from .provenance import SYNTHETIC

REPORT_SCHEMA_VERSION = 1


def _month_index() -> pd.DatetimeIndex:
    end = pd.Timestamp(year=config.WINDOW_END_YEAR, month=config.WINDOW_END_MONTH, day=1)
    return pd.date_range(end=end, periods=config.MONTHS, freq="MS")


def _trend_shape(trend: str, months: int, rng: np.random.Generator) -> np.ndarray:
    """Relative demand over the window, by scenario trend type."""
    t = np.linspace(0, 1, months)
    if trend == "rising":
        # Emerging crisis: quiet, then a sharp late climb. Deliberately steep
        # enough that a trend test should find it, noisy enough that an
        # eyeballed threshold will not.
        shape = 0.25 + 0.2 * t + 3.6 * np.clip(t - 0.62, 0, None) ** 2.1 * 6
    elif trend == "chronic":
        # Persistently high with slow waves — never resolving, never spiking.
        shape = 1.35 + 0.18 * np.sin(2 * np.pi * t * 1.5)
    elif trend == "declining":
        # A project is working: demand decays but does not vanish.
        shape = 1.7 * np.exp(-1.5 * t) + 0.45
    elif trend == "flat_high":
        shape = np.full(months, 1.3)
    else:  # "flat"
        shape = np.full(months, 1.0)
    return shape * rng.lognormal(0, 0.06, months)


def build_demand(
    demographics: pd.DataFrame,
    infrastructure: dict[str, pd.DataFrame],
    investments: pd.DataFrame,
    planted: pd.DataFrame,
    seed: int,
) -> pd.DataFrame:
    """One row per district × sector × month, carrying its relative demand.

    This is the heart of the conditioning. `weight` is not a report count — it
    is a relative intensity that the allocation step turns into counts for
    whatever total was asked for, so --reports 100000 and --reports 1000000
    describe the same country at different sampling depths.
    """
    rng = np.random.default_rng(seed ^ 0xD3A11)
    months = _month_index()

    population = pd.to_numeric(demographics["population"], errors="coerce").fillna(0).to_numpy()
    literacy = pd.to_numeric(demographics["literacy_rate"], errors="coerce").fillna(65).to_numpy()
    urban = pd.to_numeric(demographics["urban_population_pct"], errors="coerce").fillna(25).to_numpy()
    district_keys = demographics["district_key"].to_numpy()

    # ── Digital participation: who is likely to report at all ─────────────
    # Urbanisation and literacy raise it; a per-district effect keeps it from
    # being a clean function of either. This is the variable that makes
    # under-reporting detectable later.
    participation = np.clip(
        0.16
        + 0.006 * urban
        + 0.005 * (literacy - 55)
        + rng.normal(0, 0.06, len(demographics)),
        0.03,
        1.0,
    )
    adoption = np.clip(participation * rng.uniform(0.75, 1.25, len(demographics)), 0.02, 1.0)

    # Investment adequacy per district-sector: spend per head against need.
    spend = (
        investments.groupby(["district_key", "sector"])["spent_amount"].sum()
        if not investments.empty
        else pd.Series(dtype=float)
    )
    sanctioned = (
        investments.groupby(["district_key", "sector"])["sanctioned_amount"].sum()
        if not investments.empty
        else pd.Series(dtype=float)
    )

    planted_by_cell = (
        {(r.district_key, r.sector): r for r in planted.itertuples()} if not planted.empty else {}
    )

    frames = []
    for sector in config.SECTORS:
        table = infrastructure[sector].set_index("district_key")
        deficit = table["infrastructure_deficit_score"].reindex(district_keys).fillna(50).to_numpy()

        cell_spend = np.array(
            [float(spend.get((k, sector), 0.0)) for k in district_keys], dtype=float
        )
        cell_sanctioned = np.array(
            [float(sanctioned.get((k, sector), 0.0)) for k in district_keys], dtype=float
        )
        spend_per_head = cell_spend / np.maximum(population, 1)
        # Squashed to 0..1: a lot of money per head means need is being met.
        adequacy = 1 - np.exp(-spend_per_head / 120.0)

        multiplier = np.ones(len(district_keys))
        propensity_multiplier = np.ones(len(district_keys))
        trends = np.array(["flat"] * len(district_keys), dtype=object)
        scenario_ids = np.array([""] * len(district_keys), dtype=object)
        scenario_codes = np.array([""] * len(district_keys), dtype=object)

        for index, key in enumerate(district_keys):
            row = planted_by_cell.get((key, sector))
            if row is None:
                continue
            multiplier[index] = row.demand_multiplier
            propensity_multiplier[index] = row.propensity_multiplier
            trends[index] = row.trend
            scenario_ids[index] = row.scenario_id
            scenario_codes[index] = row.scenario_code

        # Need: deficit dominates, unmet-ness is amplified where investment is
        # thin, and population sets the scale of how many people can complain.
        need = (deficit / 100.0) ** 1.5 * (1.25 - 0.55 * adequacy)
        base = np.maximum(population, 1) ** 0.82 * need * multiplier
        propensity = participation * propensity_multiplier

        # Trend shapes: only a handful of distinct names exist, so build each
        # once into a (n_trends x months) matrix and index it per district.
        trend_names = sorted(set(trends.tolist()))
        shape_matrix = np.vstack(
            [
                _trend_shape(name, config.MONTHS, np.random.default_rng(seed ^ (i + 1) * 7919))
                for i, name in enumerate(trend_names)
            ]
        )
        trend_row = np.array([trend_names.index(t) for t in trends])

        seasonality = np.array(config.SECTOR_SEASONALITY[sector])
        for month_position, month in enumerate(months):
            shapes = shape_matrix[trend_row, month_position]
            noise = rng.lognormal(0, config.NOISE_SD, len(district_keys))
            weight = base * propensity * shapes * seasonality[month.month - 1] * noise
            frames.append(
                pd.DataFrame(
                    {
                        "district_key": district_keys,
                        "sector": sector,
                        "year": month.year,
                        "month": month.month,
                        "month_start": month,
                        "weight": weight,
                        "deficit": deficit,
                        "adequacy": adequacy,
                        # The *realised* participation, scenario effect
                        # included. Scenario G is only detectable if the
                        # observable participation column actually shows the
                        # district participating less — publishing the
                        # unmodified baseline here would hide the very signal
                        # that makes under-reporting recoverable, and force an
                        # analyst onto a column they should not need.
                        "participation": propensity,
                        # District-wide platform reach, deliberately left
                        # sector-independent and noisy: a correlate of
                        # participation, not a copy of it.
                        "platform_adoption_score": adoption,
                        "propensity": propensity,
                        "sanctioned_total": cell_sanctioned,
                        "spent_total": cell_spend,
                        "scenario_id": scenario_ids,
                        "scenario_code": scenario_codes,
                    }
                )
            )

    demand = pd.concat(frames, ignore_index=True)
    demand["weight"] = demand["weight"].clip(lower=0)
    return demand


def allocate(demand: pd.DataFrame, total_reports: int, seed: int) -> np.ndarray:
    """Turns relative demand into integer report counts summing to the target."""
    rng = np.random.default_rng(seed ^ 0xA110C)
    weights = demand["weight"].to_numpy()
    if weights.sum() <= 0:
        raise SystemExit("demand collapsed to zero; check the prepare step")
    probabilities = weights / weights.sum()
    return rng.multinomial(total_reports, probabilities)


# ── Canonical issues ───────────────────────────────────────────────────────

#: Roughly how many reports observe one canonical issue. Drawn per issue, so
#: some problems are reported once and some hundreds of times — which is what
#: makes duplicate detection a real task rather than a lookup.
REPORTS_PER_ISSUE_MEAN = 7.5


def build_canonical_issues(
    demand: pd.DataFrame,
    counts: np.ndarray,
    master: pd.DataFrame,
    seed: int,
) -> pd.DataFrame:
    """The real-world problems that citizen reports are noisy observations of.

    An issue belongs to a district-sector and spans a stretch of months. Its
    ground-truth fields — true severity, true status, whether a project overlaps
    it, whether it reflects a genuine infrastructure deficit — are recorded here
    and nowhere in the report table, so recovering them is an actual inference
    task.
    """
    rng = np.random.default_rng(seed ^ 0x155E)

    cells = (
        demand.assign(n_reports=counts)
        .groupby(["district_key", "sector"], as_index=False)
        .agg(
            n_reports=("n_reports", "sum"),
            deficit=("deficit", "first"),
            adequacy=("adequacy", "first"),
            scenario_id=("scenario_id", "first"),
            scenario_code=("scenario_code", "first"),
        )
    )
    cells = cells[cells["n_reports"] > 0].reset_index(drop=True)

    # Issue count scales sublinearly with reports: a louder district has more
    # problems, but mostly it has more people reporting the same ones.
    n_issues = np.maximum(
        1, rng.poisson(np.maximum(cells["n_reports"].to_numpy() / REPORTS_PER_ISSUE_MEAN, 0.6))
    )
    cells["n_issues"] = n_issues

    total_issues = int(n_issues.sum())
    district_key = np.repeat(cells["district_key"].to_numpy(), n_issues)
    sector = np.repeat(cells["sector"].to_numpy(), n_issues)
    deficit = np.repeat(cells["deficit"].to_numpy(), n_issues)
    adequacy = np.repeat(cells["adequacy"].to_numpy(), n_issues)
    scenario_id = np.repeat(cells["scenario_id"].to_numpy(), n_issues)
    scenario_code = np.repeat(cells["scenario_code"].to_numpy(), n_issues)

    months = _month_index()
    start_month = rng.integers(0, config.MONTHS, total_issues)
    # Persistence is heavy-tailed: most problems are short, some never end.
    persistence_months = np.minimum(
        config.MONTHS - start_month,
        1 + rng.negative_binomial(2, 0.28, total_issues),
    )
    chronic = np.isin(scenario_code, ["E", "A", "G"])
    persistence_months = np.where(
        chronic,
        np.minimum(config.MONTHS - start_month, np.maximum(persistence_months, 9)),
        persistence_months,
    )

    first_seen = months[start_month]
    last_seen = months[np.minimum(start_month + persistence_months - 1, config.MONTHS - 1)]

    # Issue type and subtype drawn per sector.
    issue_type = np.empty(total_issues, dtype=object)
    issue_subtype = np.empty(total_issues, dtype=object)
    for sector_name in config.SECTORS:
        mask = sector == sector_name
        if not mask.any():
            continue
        types = list(text.ISSUE_TYPES[sector_name].keys())
        picked = rng.choice(len(types), mask.sum())
        issue_type[mask] = [types[i] for i in picked]
        subtypes = [
            text.ISSUE_TYPES[sector_name][types[i]][
                rng.integers(len(text.ISSUE_TYPES[sector_name][types[i]]))
            ]
            for i in picked
        ]
        issue_subtype[mask] = subtypes

    # Severity: driven by deficit, with real spread.
    severity_latent = deficit / 100 + rng.normal(0, 0.22, total_issues)
    severity = np.clip(np.round(1 + severity_latent * 4), 1, 5).astype(int)

    coords = master.set_index("district_key")[["latitude", "longitude"]]
    lat = coords["latitude"].reindex(district_key).to_numpy()
    lon = coords["longitude"].reindex(district_key).to_numpy()
    # Issues sit somewhere inside the district, not on its point.
    lat = np.round(lat + rng.normal(0, 0.05, total_issues), 5)
    lon = np.round(lon + rng.normal(0, 0.05, total_issues), 5)

    population_estimate = np.maximum(
        50, rng.lognormal(7.4, 1.05, total_issues) * (0.6 + deficit / 100)
    ).astype(int)

    # True status: whether it was actually fixed. Investment adequacy helps;
    # scenarios C, E and G override, because their whole point is that the
    # problem outlives the paperwork.
    resolved_probability = np.clip(0.18 + 0.55 * adequacy, 0.05, 0.85)
    resolved_probability = np.where(np.isin(scenario_code, ["C", "E", "G", "A"]), 0.05, resolved_probability)
    resolved_probability = np.where(scenario_code == "B", 0.55, resolved_probability)
    resolved_probability = np.where(scenario_code == "H", 0.8, resolved_probability)
    truly_resolved = rng.random(total_issues) < resolved_probability

    true_status = np.where(truly_resolved, "resolved", "unresolved")
    true_status = np.where(
        (~truly_resolved) & (persistence_months >= 12), "persistent_unresolved", true_status
    )

    # Overlap with a sanctioned project, and whether a real deficit underlies it.
    project_overlap = np.isin(scenario_code, ["B", "C", "H"]) | (
        (scenario_code == "") & (rng.random(total_issues) < np.clip(adequacy, 0.05, 0.75))
    )
    infrastructure_deficit = deficit > 50

    locality = _locality_names(district_key, issue_type, rng)

    issues = pd.DataFrame(
        {
            "canonical_issue_id": [f"VOICE-ISS-{i:08d}" for i in range(1, total_issues + 1)],
            "district_key": district_key,
            "sector": sector,
            "issue_type": issue_type,
            "issue_subtype": issue_subtype,
            "locality_name": locality,
            "lat": lat,
            "lon": lon,
            "severity_ground_truth": severity,
            "first_seen_at": first_seen,
            "last_seen_at": last_seen,
            "affected_population_estimate": population_estimate,
            "persistence_days": (persistence_months * 30).astype(int),
            "true_status": true_status,
            "true_project_overlap": project_overlap,
            "true_infrastructure_deficit": infrastructure_deficit,
            "scenario_id": scenario_id,
            "data_origin": SYNTHETIC,
            "_start_month": start_month,
            "_persistence_months": persistence_months,
        }
    )
    return issues


def _locality_names(district_key, issue_type, rng) -> np.ndarray:
    """Stable synthetic locality names — never a real village (§14)."""
    prefixes = np.array(text.LOCALITY_PREFIXES)
    suffixes = np.array(text.LOCALITY_SUFFIXES)
    p = rng.integers(0, len(prefixes), len(district_key))
    s = rng.integers(0, len(suffixes), len(district_key))
    return np.char.add(prefixes[p], suffixes[s])


# ── Reports ────────────────────────────────────────────────────────────────


def assign_reports_to_issues(
    demand: pd.DataFrame, counts: np.ndarray, issues: pd.DataFrame, seed: int
) -> tuple[np.ndarray, np.ndarray]:
    """Which canonical issue each report observes, and in which month.

    A report can only observe an issue that is active in that month, which is
    what makes `first_reported_at`/`last_reported_at` on the issue meaningful.
    Within the active set the draw is deliberately skewed: a few issues attract
    most of the reports, the long tail is reported once or twice. Uniform
    assignment would make duplicate clusters all the same size and the dedup
    task unrealistically easy.
    """
    rng = np.random.default_rng(seed ^ 0x2155)

    issue_positions: dict[tuple[str, str], np.ndarray] = {}
    for position, (district_key, sector) in enumerate(
        zip(issues["district_key"].to_numpy(), issues["sector"].to_numpy())
    ):
        issue_positions.setdefault((district_key, sector), []).append(position)
    issue_positions = {k: np.array(v) for k, v in issue_positions.items()}

    start = issues["_start_month"].to_numpy()
    persist = issues["_persistence_months"].to_numpy()

    demand_keys = demand["district_key"].to_numpy()
    demand_sectors = demand["sector"].to_numpy()
    demand_months = demand["month_start"].to_numpy()
    months = _month_index()
    month_lookup = {pd.Timestamp(m): i for i, m in enumerate(months)}

    issue_of_report: list[np.ndarray] = []
    month_of_report: list[np.ndarray] = []

    for row in np.nonzero(counts)[0]:
        count = int(counts[row])
        key = (demand_keys[row], demand_sectors[row])
        pool = issue_positions.get(key)
        if pool is None or pool.size == 0:
            continue
        month_position = month_lookup[pd.Timestamp(demand_months[row])]

        active = pool[(start[pool] <= month_position) & (month_position < start[pool] + persist[pool])]
        if active.size == 0:
            # No issue open that month: attribute to the nearest one in the
            # cell rather than dropping reports and losing the allocated total.
            nearest = pool[np.argmin(np.abs(start[pool] - month_position))]
            active = np.array([nearest])

        # Zipf-ish attention: rank the active issues and weight by 1/rank^0.9.
        ranks = np.arange(1, active.size + 1)
        weights = 1.0 / ranks**0.9
        weights /= weights.sum()
        chosen = rng.choice(active, size=count, p=weights)

        issue_of_report.append(chosen)
        month_of_report.append(np.full(count, month_position, dtype=np.int32))

    if not issue_of_report:
        raise SystemExit("no reports were allocated; check the demand model")
    return np.concatenate(issue_of_report), np.concatenate(month_of_report)


def _report_schema() -> pa.Schema:
    return pa.schema(
        [
            ("report_id", pa.string()),
            ("citizen_id_hash", pa.string()),
            ("created_at", pa.timestamp("s")),
            ("country_code", pa.string()),
            ("state_code", pa.string()),
            ("district_code", pa.string()),
            ("district_key", pa.string()),
            ("block_code", pa.string()),
            ("locality_code", pa.string()),
            ("locality_name", pa.string()),
            ("latitude", pa.float64()),
            ("longitude", pa.float64()),
            ("input_channel", pa.string()),
            ("language", pa.string()),
            ("input_mode", pa.string()),
            ("raw_description", pa.string()),
            ("normalized_description", pa.string()),
            ("raw_description_language_matched", pa.bool_()),
            ("sector", pa.string()),
            ("issue_type", pa.string()),
            ("issue_subtype", pa.string()),
            ("severity", pa.int8()),
            ("infrastructure_asset_id", pa.string()),
            ("duplicate_cluster_id", pa.string()),
            ("canonical_issue_id", pa.string()),
            ("evidence_confidence", pa.float32()),
            ("image_available", pa.bool_()),
            ("image_path_or_placeholder", pa.string()),
            ("image_authenticity_signal", pa.string()),
            ("verified_identity", pa.bool_()),
            ("anonymous_identity", pa.bool_()),
            ("support_count", pa.int32()),
            ("status", pa.string()),
            ("first_reported_at", pa.timestamp("s")),
            ("last_reported_at", pa.timestamp("s")),
            ("resolved_at", pa.timestamp("s")),
            ("data_origin", pa.string()),
            ("scenario_id", pa.string()),
        ]
    )


def write_reports(
    issues: pd.DataFrame,
    issue_of_report: np.ndarray,
    month_of_report: np.ndarray,
    master: pd.DataFrame,
    citizen_pool: dict[str, int],
    settings,
) -> dict[str, object]:
    """Streams the report table to Parquet (and a capped CSV) in chunks."""
    rng = np.random.default_rng(settings.seed ^ 0x8E90)
    months = _month_index()
    total = len(issue_of_report)

    meta = master.set_index("district_key")
    state_of = meta["state_code"].to_dict()
    district_of = meta["district_code"].to_dict()

    issue_arrays = {
        column: issues[column].to_numpy()
        for column in (
            "canonical_issue_id",
            "district_key",
            "sector",
            "issue_type",
            "issue_subtype",
            "locality_name",
            "lat",
            "lon",
            "severity_ground_truth",
            "scenario_id",
            "true_status",
        )
    }

    parquet_path = config.SYNTHETIC / "citizen_reports.parquet"
    writer = pq.ParquetWriter(parquet_path, _report_schema(), compression="zstd")

    channel_p = np.array([0.34, 0.15, 0.31, 0.14, 0.06])
    mode_p = np.array([0.52, 0.27, 0.14, 0.07])

    language_counter: dict[str, int] = {}
    csv_rows: list[pd.DataFrame] = []
    csv_budget = settings.csv_report_cap if settings.write_csv else 0

    # Per-issue accumulators for the issue-level first/last report timestamps.
    first_seen = np.full(len(issues), np.datetime64("2100-01-01"), dtype="datetime64[s]")
    last_seen = np.full(len(issues), np.datetime64("1970-01-01"), dtype="datetime64[s]")
    report_tally = np.zeros(len(issues), dtype=np.int64)

    written = 0
    for start in range(0, total, settings.chunk_rows):
        stop = min(start + settings.chunk_rows, total)
        size = stop - start
        issue_index = issue_of_report[start:stop]
        month_position = month_of_report[start:stop]

        district_key = issue_arrays["district_key"][issue_index]
        sector = issue_arrays["sector"][issue_index]
        issue_type = issue_arrays["issue_type"][issue_index]
        issue_subtype = issue_arrays["issue_subtype"][issue_index]
        locality = issue_arrays["locality_name"][issue_index]
        canonical_id = issue_arrays["canonical_issue_id"][issue_index]
        scenario_id = issue_arrays["scenario_id"][issue_index]

        # Timestamp: a uniform day inside the report's month, uniform seconds.
        month_start = months.to_numpy()[month_position].astype("datetime64[s]")
        days_in_month = np.array(
            [pd.Timestamp(m).days_in_month for m in months.to_numpy()[month_position]]
        )
        # days_in_month - 1: an offset of a full month from day 1 would land in
        # the next month, which pushes the last month's reports past the end of
        # the declared window.
        offset_days = (rng.random(size) * (days_in_month - 1)).astype("timedelta64[D]")
        offset_seconds = (rng.random(size) * 86399).astype("timedelta64[s]")
        created_at = month_start + offset_days.astype("timedelta64[s]") + offset_seconds

        state_code = np.array([state_of.get(k, "") for k in district_key])
        district_code = np.array([district_of.get(k, "") for k in district_key])

        # Language: regional first, then Hindi/English, then a thin tail.
        regional = np.array(
            [config.STATE_LANGUAGE.get(s, config.REGIONAL_FALLBACK) for s in state_code]
        )
        draw = rng.random(size)
        mix = config.LANGUAGE_MIX
        language = np.where(
            draw < mix["regional"],
            regional,
            np.where(
                draw < mix["regional"] + mix["hindi"],
                "Hindi",
                np.where(draw < mix["regional"] + mix["hindi"] + mix["english"], "English", ""),
            ),
        )
        tail = language == ""
        if tail.any():
            language[tail] = rng.choice(np.array(config.LANGUAGES), tail.sum())

        channel = rng.choice(np.array(config.INPUT_CHANNELS), size, p=channel_p)
        mode = rng.choice(np.array(config.INPUT_MODES), size, p=mode_p)

        # Text. English always exists; a native template is used when one is
        # written for that (language, sector, issue_type) and the flag records
        # whether the raw text really is in the stated language.
        english = np.empty(size, dtype=object)
        raw = np.empty(size, dtype=object)
        matched = np.zeros(size, dtype=bool)
        for sector_name in config.SECTORS:
            for type_name in text.ISSUE_TYPES[sector_name]:
                mask = (sector == sector_name) & (issue_type == type_name)
                if not mask.any():
                    continue
                templates = text.ENGLISH[(sector_name, type_name)]
                picks = rng.integers(0, len(templates), mask.sum())
                places = locality[mask]
                english[mask] = [
                    templates[p].format(place=place) for p, place in zip(picks, places)
                ]
        raw[:] = english
        for (lang, sector_name, type_name), templates in text.NATIVE.items():
            mask = (language == lang) & (sector == sector_name) & (issue_type == type_name)
            if not mask.any():
                continue
            picks = rng.integers(0, len(templates), mask.sum())
            places = locality[mask]
            raw[mask] = [templates[p].format(place=place) for p, place in zip(picks, places)]
            matched[mask] = True
        matched |= language == "English"

        severity_truth = issue_arrays["severity_ground_truth"][issue_index]
        # A reporter's severity is a noisy read of the truth, not the truth.
        severity = np.clip(
            severity_truth + rng.integers(-1, 2, size), 1, 5
        ).astype(np.int8)

        has_image = (rng.random(size) < np.where(np.isin(mode, ["image_text", "voice_image"]), 0.96, 0.12))
        verified = rng.random(size) < 0.42
        anonymous = (~verified) & (rng.random(size) < 0.55)

        evidence = np.clip(
            0.35 + 0.28 * has_image + 0.18 * verified + rng.normal(0, 0.12, size), 0.02, 1.0
        ).astype(np.float32)

        # Citizens are drawn from a bounded pool per district, not invented per
        # report: a platform's reporters are a small, repeat-heavy population,
        # and a dataset where every report has a distinct author would make
        # "unique citizens" identical to "reports" and destroy any per-person
        # analysis. The pool is sized from the district's own report volume and
        # drawn with a square-root skew, so a minority of residents file a
        # disproportionate share — which is what civic platforms actually see.
        pool = np.array([citizen_pool.get(k, 40) for k in district_key])
        member = (rng.random(size) ** 1.7 * pool).astype(np.int64)
        citizen_hash = np.array(
            [
                hashlib.blake2s(f"{settings.seed}:{k}:{m}".encode(), digest_size=8).hexdigest()
                for k, m in zip(district_key, member)
            ]
        )

        status = rng.choice(
            np.array(config.STATUSES), size, p=[0.44, 0.19, 0.17, 0.14, 0.06]
        )
        resolved_at = np.where(
            status == "resolved",
            created_at + (rng.random(size) * 120).astype("timedelta64[D]").astype("timedelta64[s]"),
            np.datetime64("NaT"),
        )

        frame = pd.DataFrame(
            {
                "report_id": [f"VOICE-RPT-{i:09d}" for i in range(start + 1, stop + 1)],
                "citizen_id_hash": citizen_hash,
                "created_at": created_at,
                "country_code": config.COUNTRY_CODE,
                "state_code": state_code,
                "district_code": district_code,
                "district_key": district_key,
                "block_code": "",
                "locality_code": "",
                "locality_name": locality,
                "latitude": np.round(issue_arrays["lat"][issue_index] + rng.normal(0, 0.004, size), 6),
                "longitude": np.round(issue_arrays["lon"][issue_index] + rng.normal(0, 0.004, size), 6),
                "input_channel": channel,
                "language": language,
                "input_mode": mode,
                "raw_description": raw,
                "normalized_description": english,
                "raw_description_language_matched": matched,
                "sector": sector,
                "issue_type": issue_type,
                "issue_subtype": issue_subtype,
                "severity": severity,
                "infrastructure_asset_id": "",
                # Left empty on purpose. This is the column a future
                # deduplicator *writes*; `canonical_issue_id` beside it is the
                # ground truth it should recover. Filling both with the same
                # value would hand the answer to the method being evaluated.
                "duplicate_cluster_id": "",
                "canonical_issue_id": canonical_id,
                "evidence_confidence": evidence,
                "image_available": has_image,
                "image_path_or_placeholder": np.where(has_image, "synthetic://no-image-generated", ""),
                "image_authenticity_signal": np.where(
                    has_image,
                    rng.choice(np.array(["not_checked", "no_signal", "possible_reuse"]), size, p=[0.72, 0.22, 0.06]),
                    "",
                ),
                "verified_identity": verified,
                "anonymous_identity": anonymous,
                "support_count": rng.poisson(1.6, size).astype(np.int32),
                "status": status,
                "first_reported_at": created_at,
                "last_reported_at": created_at,
                "resolved_at": resolved_at,
                "data_origin": SYNTHETIC,
                "scenario_id": scenario_id,
            }
        )

        np.minimum.at(first_seen, issue_index, created_at)
        np.maximum.at(last_seen, issue_index, created_at)
        np.add.at(report_tally, issue_index, 1)

        for value, count in zip(*np.unique(language, return_counts=True)):
            language_counter[value] = language_counter.get(value, 0) + int(count)

        writer.write_table(pa.Table.from_pandas(frame, schema=_report_schema(), preserve_index=False))
        if csv_budget > 0:
            take = min(csv_budget, len(frame))
            csv_rows.append(frame.iloc[:take])
            csv_budget -= take
        written += size

    writer.close()

    if csv_rows:
        pd.concat(csv_rows, ignore_index=True).to_csv(
            config.SYNTHETIC / "citizen_reports.csv", index=False
        )

    return {
        "written": written,
        "languages": language_counter,
        "issue_first_seen": first_seen,
        "issue_last_seen": last_seen,
        "issue_report_count": report_tally,
        "parquet_path": parquet_path,
    }


def _write_citizens(reports_parquet, settings) -> int:
    """A citizen-level table derived from the reports actually written.

    Deliberately thin: a hashed id, where they report and how, and nothing that
    would be personal data even in a synthetic setting. There is no name, no
    contact detail and no demographic attribute, because inventing those adds
    nothing an analysis needs and creates a file that looks like a person
    register.
    """
    columns = ["citizen_id_hash", "district_key", "state_code", "language", "input_channel", "verified_identity"]
    table = pq.read_table(reports_parquet, columns=columns).to_pandas()
    citizens = (
        table.groupby("citizen_id_hash")
        .agg(
            district_key=("district_key", "first"),
            state_code=("state_code", "first"),
            primary_language=("language", lambda s: s.mode().iat[0] if not s.mode().empty else ""),
            primary_channel=("input_channel", lambda s: s.mode().iat[0] if not s.mode().empty else ""),
            report_count=("district_key", "size"),
            ever_verified=("verified_identity", "max"),
        )
        .reset_index()
    )
    citizens["data_origin"] = SYNTHETIC
    citizens.to_csv(config.SYNTHETIC / "citizens.csv", index=False)
    return len(citizens)


def run(processed: dict, settings) -> dict:
    """Generates canonical issues, citizen reports and the citizen table."""
    config.ensure_dirs()

    demographics = processed["demographics"]
    master = processed["district_master"]
    investments = processed["investments"]
    planted = processed["planted"]
    infrastructure = {sector: processed[sector] for sector in config.SECTORS}

    demand = build_demand(demographics, infrastructure, investments, planted, settings.seed)
    counts = allocate(demand, settings.reports, settings.seed)
    print(f"  demand: {len(demand)} district-sector-month cells, {counts.sum():,} reports allocated")

    issues = build_canonical_issues(demand, counts, master, settings.seed)
    print(f"  canonical issues: {len(issues):,}")

    issue_of_report, month_of_report = assign_reports_to_issues(
        demand, counts, issues, settings.seed
    )
    print(f"  reports mapped to issues: {len(issue_of_report):,}")

    # Reporter pool per district, sized from that district's own volume so the
    # ratio of reports to people stays plausible at any --reports scale.
    district_volume = (
        demand.assign(n=counts).groupby("district_key")["n"].sum().to_dict()
    )
    citizen_pool = {
        key: max(25, int(volume / 2.6)) for key, volume in district_volume.items()
    }

    result = write_reports(
        issues, issue_of_report, month_of_report, master, citizen_pool, settings
    )
    print(f"  reports written: {result['written']:,} -> {result['parquet_path'].name}")

    # Fold the observed report window back onto the issues, then drop the
    # internal month columns that only the generator needed.
    observed = result["issue_report_count"] > 0
    issues = issues.copy()
    issues["report_count"] = result["issue_report_count"]
    issues.loc[observed, "first_seen_at"] = pd.to_datetime(result["issue_first_seen"][observed])
    issues.loc[observed, "last_seen_at"] = pd.to_datetime(result["issue_last_seen"][observed])
    issues["persistence_days"] = np.where(
        observed,
        (pd.to_datetime(issues["last_seen_at"]) - pd.to_datetime(issues["first_seen_at"])).dt.days,
        issues["persistence_days"],
    )
    issues = issues.drop(columns=["_start_month", "_persistence_months"])
    # Unplanted issues carry an empty scenario, not a NaN: "no scenario here"
    # is a fact about the row, and a null reads as missing data.
    issues["scenario_id"] = issues["scenario_id"].fillna("").replace("nan", "")
    issues["notice"] = (
        "Synthetic issue generated for analytics evaluation. Describes no real incident."
    )
    issues.to_csv(config.SYNTHETIC / "canonical_issues.csv", index=False)
    issues.to_parquet(config.SYNTHETIC / "canonical_issues.parquet", index=False)

    citizens = _write_citizens(result["parquet_path"], settings)
    print(f"  citizens: {citizens:,}")

    demand_out = demand.assign(report_count=counts)
    demand_out.to_parquet(config.SYNTHETIC / "_demand_cells.parquet", index=False)

    return {
        "issues": issues,
        "demand": demand_out,
        "languages": result["languages"],
        "reports_written": result["written"],
        "citizens": citizens,
    }
