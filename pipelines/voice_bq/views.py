"""Step 3 — the `analytics_safe_*` views every analysis reads.

These exist for two reasons.

**A single place the analyses agree on.** Five analyses that each re-derive
"reports per 10k" or "is a project active this month" will drift apart within a
week. The joins and the shared derivations live here once.

**A named boundary.** The analytics dataset already contains no labels, so a
view cannot make it safer in the strict sense. What the naming does is make an
unsafe query obvious in review: anything selecting from `voice_eval` is
visible at a glance, and everything else reads from a view whose name says what
it is. Belt as well as braces, with `validate.py` checking the braces.

Every view carries its provenance caveats in its description, because the first
person to query these in a year will read the schema, not this file.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ViewSpec:
    name: str
    description: str
    sql: str

    def create_sql(self, dataset: str) -> str:
        return (
            f"CREATE OR REPLACE VIEW `{dataset}.{self.name}`\n"
            f'OPTIONS(description="""{self.description.strip()}""")\n'
            f"AS\n{self.sql.format(d=dataset).strip()}"
        )


VIEWS: tuple[ViewSpec, ...] = (
    ViewSpec(
        name="analytics_safe_district_sector_month",
        description=(
            "THE analytical grain for every VOICE analysis: district x sector x month, with "
            "citizen signal, infrastructure position, investment position and participation "
            "on one row. Contains NO evaluation labels — those live in voice_eval and are "
            "joined only by the evaluation harness.\n\n"
            "Provenance varies by column. Demographics are real (Census 2011). "
            "infrastructure_data_origin says whether that district-sector's indicators came "
            "from a published table ('real') or were modelled ('derived' — a modelling input, "
            "not a statistic about the district). Citizen reports and projects are synthetic."
        ),
        sql="""
SELECT
  m.* EXCEPT (month_start),
  m.month_start,

  -- Investment intensity per head. Expressed per 10k people so it sits on the
  -- same scale as the demand signal it will be compared against.
  m.spent_investment / NULLIF(m.population / 10000, 0) AS spent_per_10k,
  m.sanctioned_investment / NULLIF(m.population / 10000, 0) AS sanctioned_per_10k,

  -- Is there *any* live commitment in this cell? The distinction between
  -- "nothing sanctioned" and "something already running" is the whole of
  -- Analysis 2, so it is named once here rather than re-derived per query.
  (m.active_project_count > 0) AS has_active_project,
  (m.sanctioned_investment > 0) AS has_any_sanction,

  d.households,
  d.literacy_rate,
  d.rural_population_pct,
  d.st_population_pct,
  d.sc_population_pct,
  d.child_population_pct,
  d.data_origin AS demographics_data_origin
FROM `{d}.district_sector_month` AS m
LEFT JOIN `{d}.district_demographics` AS d
  USING (district_key)
""",
    ),
    ViewSpec(
        name="analytics_safe_district_profile",
        description=(
            "One row per district: real Census 2011 demographics plus the four sector "
            "infrastructure positions pivoted into columns. For map and drill-down surfaces "
            "that need a district at a glance. Coordinates are DERIVED (a point inside the "
            "state, not a centroid) — fine for placing a marker, not for distance work."
        ),
        sql="""
SELECT
  dm.country_code,
  dm.state_code,
  dm.state_name,
  dm.district_code,
  dm.district_key,
  dm.district_name,
  dm.latitude,
  dm.longitude,
  -- BigQuery does not allow GEOGRAPHY expressions in GROUP BY. The point is
  -- deterministic from the grouped coordinates, so rebuild it after grouping
  -- rather than grouping on dm.location (which DuckDB accepts but BigQuery
  -- correctly refuses).
  ST_GEOGPOINT(dm.longitude, dm.latitude) AS location,
  d.population,
  d.households,
  d.population_density,
  d.literacy_rate,
  d.rural_population_pct,
  d.urban_population_pct,
  MAX(IF(i.sector = 'water', i.infrastructure_deficit_score, NULL)) AS water_deficit,
  MAX(IF(i.sector = 'roads', i.infrastructure_deficit_score, NULL)) AS roads_deficit,
  MAX(IF(i.sector = 'education', i.infrastructure_deficit_score, NULL)) AS education_deficit,
  MAX(IF(i.sector = 'health', i.infrastructure_deficit_score, NULL)) AS health_deficit,
  -- How much of this district's infrastructure picture is measured rather
  -- than modelled. Surfaced so a reader can discount a district where it is 0.
  COUNTIF(i.data_origin = 'real') AS sectors_with_real_indicators
FROM `{d}.district_master` AS dm
LEFT JOIN `{d}.district_demographics` AS d USING (district_key)
LEFT JOIN `{d}.district_infrastructure` AS i USING (district_key)
GROUP BY
  dm.country_code, dm.state_code, dm.state_name, dm.district_code, dm.district_key,
  dm.district_name, dm.latitude, dm.longitude,
  d.population, d.households, d.population_density, d.literacy_rate,
  d.rural_population_pct, d.urban_population_pct
""",
    ),
    ViewSpec(
        name="analytics_safe_citizen_reports",
        description=(
            "Citizen reports with their district and state names attached. SYNTHETIC — these "
            "are not real complaints. canonical_issue_id is retained because it is the "
            "operational grouping key the product genuinely assigns; the deduplication "
            "evaluation withholds it separately."
        ),
        sql="""
SELECT
  r.*,
  dm.state_name,
  dm.district_name
FROM `{d}.citizen_reports` AS r
LEFT JOIN `{d}.district_master` AS dm USING (district_key)
""",
    ),
    ViewSpec(
        name="analytics_safe_project_coverage",
        description=(
            "Projects rolled up to district x sector, with the most recent completion date. "
            "SYNTHETIC records. Feeds the investment-gap and execution-gap analyses, which "
            "need 'is anything already funded here' and 'when did it finish' as one lookup."
        ),
        sql="""
SELECT
  district_key,
  sector,
  COUNT(*) AS project_count,
  COUNTIF(project_status IN ('sanctioned', 'in_progress')) AS active_project_count,
  COUNTIF(project_status = 'completed') AS completed_project_count,
  COUNTIF(project_status = 'delayed') AS delayed_project_count,
  SUM(sanctioned_amount) AS sanctioned_amount,
  SUM(released_amount) AS released_amount,
  SUM(spent_amount) AS spent_amount,
  MAX(actual_completion_date) AS last_completion_date,
  MIN(sanction_date) AS first_sanction_date
FROM `{d}.public_projects`
GROUP BY district_key, sector
""",
    ),
)
