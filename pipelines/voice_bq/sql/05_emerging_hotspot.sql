-- ANALYSIS 4 — Emerging hotspot.
--
-- Question: which issue is becoming urgent quickly, even if it is not yet the
-- biggest problem by raw count? Raw volume answers "where is it worst"; this
-- answers "where is it changing", and a national system that only ever reports
-- the former will always arrive late.
--
-- Method: compare each cell's trailing three months against its OWN earlier
-- baseline, as a z-score. Per-cell rather than national, because a district
-- that normally files forty reports a month and now files eighty is the signal;
-- a district that normally files two and now files four is not.
--
-- The baseline deliberately excludes the three most recent months (see the
-- w_baseline window in 01_features.sql). A surge included in its own baseline
-- raises the mean it is measured against and hides itself.
--
-- This is the interpretable baseline. BigQuery ML forecasting is a later task
-- and must be compared against these numbers before it replaces anything.

CREATE OR REPLACE VIEW {analytics_features}_emerging_hotspot AS
WITH latest AS (
  SELECT MAX(period_index) AS latest_index FROM {analytics_features}
),
current_state AS (
  SELECT
    f.district_key,
    f.state_code,
    f.state_name,
    f.district_name,
    f.sector,
    f.period,
    f.population,
    f.infrastructure_deficit_score,
    f.digital_participation_score,
    f.reports_3m,
    f.reports_12m,
    f.reports_per_10k_3m,
    f.baseline_mean_per_10k,
    f.baseline_stddev_per_10k,
    f.active_project_count,
    f.completed_project_count
  FROM {analytics_features} AS f, latest AS l
  WHERE f.period_index = l.latest_index
),
scored AS (
  SELECT
    c.*,
    -- A floor on the standard deviation stops a cell whose baseline happened
    -- to be perfectly flat from producing an infinite z-score off one report.
    (c.reports_per_10k_3m - c.baseline_mean_per_10k)
      / NULLIF(GREATEST(c.baseline_stddev_per_10k, 0.01), 0) AS growth_z_score,
    c.reports_per_10k_3m / NULLIF(c.baseline_mean_per_10k, 0) AS growth_ratio
  FROM current_state AS c
)
SELECT
  s.*,
  (s.reports_3m >= 15) AS sufficient_evidence,
  (
    s.reports_3m >= 15
    AND s.growth_z_score >= 2.0
    AND s.growth_ratio >= 1.5
  ) AS emerging_hotspot,
  CASE WHEN s.growth_z_score >= 2.0 THEN 'GROWTH_ABOVE_OWN_BASELINE,' ELSE '' END ||
  CASE WHEN s.growth_ratio >= 2.0 THEN 'VOLUME_AT_LEAST_DOUBLED,' ELSE '' END ||
  CASE WHEN s.reports_3m < 15 THEN 'TOO_FEW_RECENT_REPORTS,' ELSE '' END ||
  CASE WHEN s.infrastructure_deficit_score >= 50 THEN 'INFRASTRUCTURE_DEFICIT_CORROBORATES,' ELSE '' END ||
  CASE WHEN s.active_project_count = 0 THEN 'NO_ACTIVE_PROJECT,' ELSE '' END
    AS reason_codes
FROM scored AS s;
