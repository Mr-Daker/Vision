"""The planted ground truth: eight regional situations analytics must tell apart.

Each scenario is a *cause*, expressed as a set of levers that the generator
applies — how much demand a district-sector produces, what shape that demand
takes over 24 months, whether a matching project exists, how well the
infrastructure actually performs, and how likely people are to report at all.
The label is then recorded separately, in `planted_scenarios.csv` and in the
`ground_truth_*` columns of the master table.

The separation matters. Nothing the generator writes into a citizen report says
which scenario produced it, and no single column in the analytical table gives
the answer away. An analyst has to combine demand, infrastructure, investment
and participation to recover the label — which is the thing we will later be
testing. A dataset whose answer can be read off one column tests nothing.

Two properties are deliberate:

- **The levers overlap.** Scenario A and Scenario B both produce heavy demand
  over poor infrastructure; only the investment record separates them. C looks
  like B until you compare report dates against the completion date. F looks
  like a crisis until you divide by population. This is what makes the dataset
  worth evaluating against.
- **The levers are noisy.** `config.NOISE_SD` and the per-district effects in
  `prepare.py` mean a planted district does not sit at a clean extreme, and
  some unplanted districts will look like planted ones by chance. Real data
  does that, and a method that only works on clean separation is not a method.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from . import config


@dataclass(frozen=True)
class Scenario:
    code: str
    name: str
    expected_interpretation: str
    #: Multiplier on the district-sector's baseline report rate.
    demand_multiplier: float
    #: "flat", "rising", "chronic", "declining" — resolved in generate.py.
    trend: str
    #: Where the latent infrastructure quality is forced to, 0–1. None = leave.
    forced_quality: tuple[float, float] | None
    #: What the investment record should look like for this cell.
    investment_profile: str
    #: Multiplier on reporting propensity — how likely people are to report.
    propensity_multiplier: float
    #: Ground-truth flags surfaced on the master table.
    unmet_need: bool
    investment_gap: bool
    execution_gap: bool
    emerging_hotspot: bool
    silent_need: bool


SCENARIOS: dict[str, Scenario] = {
    "A": Scenario(
        code="A",
        name="Genuine unmet need",
        expected_interpretation="NEW INVESTMENT GAP",
        demand_multiplier=3.1,
        trend="flat_high",
        forced_quality=(0.05, 0.28),
        investment_profile="none",
        propensity_multiplier=1.0,
        unmet_need=True,
        investment_gap=True,
        execution_gap=False,
        emerging_hotspot=False,
        silent_need=False,
    ),
    "B": Scenario(
        code="B",
        name="Existing project already covers the need",
        expected_interpretation="DO NOT RECOMMEND DUPLICATE INVESTMENT; MONITOR EXECUTION",
        demand_multiplier=2.8,
        trend="declining",
        forced_quality=(0.10, 0.34),
        investment_profile="active",
        propensity_multiplier=1.0,
        unmet_need=True,
        investment_gap=False,
        execution_gap=False,
        emerging_hotspot=False,
        silent_need=False,
    ),
    "C": Scenario(
        code="C",
        name="Execution / outcome gap",
        expected_interpretation="POSSIBLE EXECUTION / OUTCOME GAP",
        demand_multiplier=2.9,
        trend="flat_high",
        forced_quality=(0.12, 0.36),
        investment_profile="completed_spent",
        propensity_multiplier=1.0,
        unmet_need=True,
        investment_gap=False,
        execution_gap=True,
        emerging_hotspot=False,
        silent_need=False,
    ),
    "D": Scenario(
        code="D",
        name="Emerging crisis",
        expected_interpretation="EMERGING HOTSPOT",
        demand_multiplier=2.2,
        trend="rising",
        forced_quality=(0.18, 0.45),
        investment_profile="none",
        propensity_multiplier=1.05,
        unmet_need=True,
        investment_gap=True,
        execution_gap=False,
        emerging_hotspot=True,
        silent_need=False,
    ),
    "E": Scenario(
        code="E",
        name="Persistent chronic issue",
        expected_interpretation="PERSISTENT UNMET NEED",
        demand_multiplier=2.6,
        trend="chronic",
        forced_quality=(0.08, 0.30),
        investment_profile="stalled",
        propensity_multiplier=1.0,
        unmet_need=True,
        investment_gap=True,
        execution_gap=False,
        emerging_hotspot=False,
        silent_need=False,
    ),
    "F": Scenario(
        code="F",
        name="Popularity bias (large metro, high raw volume)",
        expected_interpretation="RAW REPORT COUNT SHOULD NOT DOMINATE",
        demand_multiplier=1.5,
        trend="flat",
        forced_quality=(0.58, 0.85),
        investment_profile="active",
        propensity_multiplier=3.4,
        unmet_need=False,
        investment_gap=False,
        execution_gap=False,
        emerging_hotspot=False,
        silent_need=False,
    ),
    "G": Scenario(
        code="G",
        name="Silent need / under-reporting",
        expected_interpretation="POSSIBLE UNDER-REPORTING",
        demand_multiplier=2.7,
        trend="flat_high",
        forced_quality=(0.03, 0.20),
        investment_profile="none",
        propensity_multiplier=0.13,
        unmet_need=True,
        investment_gap=True,
        execution_gap=False,
        emerging_hotspot=False,
        silent_need=True,
    ),
    "H": Scenario(
        code="H",
        name="Healthy / low-priority region",
        expected_interpretation="LOW PRIORITY",
        demand_multiplier=0.45,
        trend="flat",
        forced_quality=(0.70, 0.95),
        investment_profile="adequate",
        propensity_multiplier=1.0,
        unmet_need=False,
        investment_gap=False,
        execution_gap=False,
        emerging_hotspot=False,
        silent_need=False,
    ),
}

#: How many district-sector cells to plant per scenario. Enough of each that a
#: later evaluation has a real sample rather than an anecdote, while leaving
#: the large majority of the country unplanted and ordinary.
PLANT_COUNTS = {"A": 26, "B": 22, "C": 20, "D": 18, "E": 22, "F": 10, "G": 20, "H": 24}


def assign(
    demographics: pd.DataFrame,
    infrastructure: dict[str, pd.DataFrame],
    seed: int,
) -> pd.DataFrame:
    """Chooses which district-sector cells carry which scenario.

    Selection is deliberately *not* uniform across the map. Sectors are given
    regional centres of gravity first (§14 of the brief asks for clusters, not
    a national sprinkle), and scenarios are then drawn within those clusters.
    The result is that some states read as water-stressed and others as
    education-stressed, which is what a believable national picture looks like
    — while remaining, in every case, a synthetic assignment that says nothing
    about the real district it lands on.
    """
    rng = np.random.default_rng(seed ^ 0x5CE9A)

    population = pd.to_numeric(demographics["population"], errors="coerce").fillna(0)
    frame = demographics[["district_key", "state_code", "state_name", "district_name"]].copy()
    frame["population"] = population.to_numpy()

    states = sorted(frame["state_code"].unique())
    rng.shuffle(states)
    # Each sector gets a set of states it is over-represented in.
    cluster_size = max(2, len(states) // len(config.SECTORS))
    sector_states = {
        sector: set(states[i * cluster_size : (i + 1) * cluster_size])
        for i, sector in enumerate(config.SECTORS)
    }

    deficit = {
        sector: table.set_index("district_key")["infrastructure_deficit_score"]
        for sector, table in infrastructure.items()
    }

    taken: set[tuple[str, str]] = set()
    rows: list[dict] = []
    scenario_counter = 0

    for code, count in PLANT_COUNTS.items():
        scenario = SCENARIOS[code]
        wants_poor = scenario.forced_quality is not None and scenario.forced_quality[1] <= 0.5
        wants_large = code in ("A", "F")

        for _ in range(count):
            candidates = []
            for sector in config.SECTORS:
                pool = frame.copy()
                pool["deficit"] = pool["district_key"].map(deficit[sector]).fillna(50).to_numpy()
                pool = pool[~pool["district_key"].isin({k for k, s in taken if s == sector})]
                if pool.empty:
                    continue
                weight = np.ones(len(pool))
                # Cluster: a sector's own states are far more likely to be drawn.
                weight *= np.where(pool["state_code"].isin(sector_states[sector]), 3.2, 1.0)
                # Steer towards cells that already lean the right way, so the
                # planted signal sits on top of the derived indicators rather
                # than fighting them.
                if wants_poor:
                    weight *= 0.4 + (pool["deficit"].to_numpy() / 100) ** 2 * 3.0
                else:
                    weight *= 0.4 + ((100 - pool["deficit"].to_numpy()) / 100) ** 2 * 3.0
                if wants_large:
                    weight *= 0.5 + np.log1p(pool["population"].to_numpy()) / 14
                if code == "F":
                    # Popularity bias needs genuinely large populations.
                    weight *= (pool["population"].to_numpy() > pool["population"].quantile(0.88)) * 8 + 0.02
                if code == "G":
                    # Silent need belongs where participation would plausibly
                    # be lowest: small, rural, low-literacy districts.
                    weight *= (pool["population"].to_numpy() < pool["population"].quantile(0.55)) * 4 + 0.05
                weight = np.clip(weight, 1e-6, None)
                weight = weight / weight.sum()
                pick = rng.choice(len(pool), p=weight)
                candidates.append((sector, pool.iloc[pick]))

            if not candidates:
                continue
            sector, chosen = candidates[rng.integers(len(candidates))]
            key = (chosen["district_key"], sector)
            if key in taken:
                continue
            taken.add(key)
            scenario_counter += 1
            rows.append(
                {
                    "scenario_id": f"SCN-{code}-{scenario_counter:04d}",
                    "scenario_code": code,
                    "scenario_name": scenario.name,
                    "expected_interpretation": scenario.expected_interpretation,
                    "district_key": chosen["district_key"],
                    "state_code": chosen["state_code"],
                    "state_name": chosen["state_name"],
                    "district_name": chosen["district_name"],
                    "sector": sector,
                    "demand_multiplier": scenario.demand_multiplier,
                    "trend": scenario.trend,
                    "investment_profile": scenario.investment_profile,
                    "propensity_multiplier": scenario.propensity_multiplier,
                    "forced_quality_low": scenario.forced_quality[0] if scenario.forced_quality else "",
                    "forced_quality_high": scenario.forced_quality[1] if scenario.forced_quality else "",
                    "ground_truth_unmet_need": scenario.unmet_need,
                    "ground_truth_investment_gap": scenario.investment_gap,
                    "ground_truth_execution_gap": scenario.execution_gap,
                    "ground_truth_emerging_hotspot": scenario.emerging_hotspot,
                    "ground_truth_silent_need": scenario.silent_need,
                    "data_origin": "synthetic",
                    "notice": (
                        "Synthetic scenario planted for evaluation. It describes no real "
                        "condition in this district and must not be read as one."
                    ),
                }
            )

    planted = pd.DataFrame(rows)
    planted.to_csv(config.SYNTHETIC / "planted_scenarios.csv", index=False)
    return planted
