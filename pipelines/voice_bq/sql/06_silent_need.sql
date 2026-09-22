-- ANALYSIS 5 — Silent need / under-reporting.
--
-- Question: which region has poor infrastructure indicators but unexpectedly
-- LOW citizen reporting?
--
-- This is the fairness analysis, and it is the one that most justifies building
-- the system at all. Every other signal rewards places that complain loudly.
-- Volume is need multiplied by the ability and willingness to report, so a
-- district with severe need and little connectivity produces the same quiet
-- data as a district with no problems. Ranking on report counts would send
-- money to the places best at asking for it.
--
-- Method: compare each cell's observed reporting rate against what comparable
-- cells produce. "Comparable" is same sector and similar infrastructure
-- deficit — districts facing a similar level of need. A large shortfall
-- against that expectation, in a place with low digital participation, is the
-- signal.
--
-- Portability note: the expected rate is a MEAN rather than a median, because
-- BigQuery and DuckDB spell median differently and this file must run on both
-- unmodified. A median would be more robust to outliers; deficit banding
-- limits the spread enough that the difference is small, and this is recorded
-- as a known limitation rather than hidden.

CREATE OR REPLACE VIEW {analytics_features}_silent_need AS
WITH latest AS (
  SELECT MAX(period_index) - 5 AS from_index FROM {analytics_features}
),
recent AS (
  SELECT
    f.district_key,
    f.state_code,
    f.state_name,
    f.district_name,
    f.sector,
    MAX(f.population)                   AS population,
    SUM(f.citizen_report_count)         AS reports_6m,
    SUM(f.unique_citizen_count)         AS unique_citizens_6m,
    AVG(f.reports_per_10k)              AS observed_per_10k,
    MAX(f.infrastructure_deficit_score) AS infrastructure_deficit_score,
    MAX(f.infrastructure_data_origin)   AS infrastructure_data_origin,
    MAX(f.digital_participation_score)  AS digital_participation_score,
    MAX(f.urbanization_proxy)           AS urbanization_proxy,
    MAX(f.active_project_count)         AS active_project_count
  FROM {analytics_features} AS f, latest AS l
  WHERE f.period_index >= l.from_index
  GROUP BY f.district_key, f.state_code, f.state_name, f.district_name, f.sector
),
banded AS (
  SELECT
    r.*,
    -- Ten bands of comparable need within each sector.
    NTILE(10) OVER (PARTITION BY r.sector ORDER BY r.infrastructure_deficit_score) AS deficit_band,
    PERCENT_RANK() OVER (PARTITION BY r.sector ORDER BY r.digital_participation_score)
      AS participation_percentile
  FROM recent AS r
),
expectation AS (
  SELECT
    b.*,
    -- What districts facing a similar level of need actually report.
    AVG(b.observed_per_10k) OVER (PARTITION BY b.sector, b.deficit_band) AS expected_per_10k
  FROM banded AS b
)
SELECT
  e.*,
  e.observed_per_10k / NULLIF(e.expected_per_10k, 0) AS reporting_ratio,
  e.expected_per_10k - e.observed_per_10k            AS reporting_shortfall_per_10k,

  (
    -- Genuinely poor infrastructure, not merely below average.
    e.infrastructure_deficit_score >= 55
    -- Reporting well under what comparable districts produce.
    AND e.observed_per_10k <= e.expected_per_10k * 0.5
    -- And a plausible reason for the silence rather than an absence of need.
    -- Bottom quartile: "low participation" ought to mean unusually low, and
    -- the bottom two quintiles is most of the distribution rather than a tail.
    AND e.participation_percentile <= 0.25
  ) AS possible_under_reporting,

  CASE WHEN e.infrastructure_deficit_score >= 55 THEN 'POOR_INFRASTRUCTURE_INDICATOR,' ELSE '' END ||
  CASE WHEN e.observed_per_10k <= e.expected_per_10k * 0.5 THEN 'REPORTING_BELOW_COMPARABLE_DISTRICTS,' ELSE '' END ||
  CASE WHEN e.participation_percentile <= 0.25 THEN 'LOW_DIGITAL_PARTICIPATION,' ELSE '' END ||
  CASE WHEN e.urbanization_proxy <= 25 THEN 'PREDOMINANTLY_RURAL,' ELSE '' END ||
  CASE WHEN e.active_project_count = 0 THEN 'NO_ACTIVE_PROJECT,' ELSE '' END ||
  CASE WHEN e.infrastructure_data_origin = 'derived' THEN 'INFRA_INDICATOR_IS_MODELLED,' ELSE '' END
    AS reason_codes,

  'Low reporting is not evidence of low need; it may reflect connectivity, ' ||
  'language, trust, or awareness of the platform rather than conditions on the ground'
    AS interpretation_caveat
FROM expectation AS e;
