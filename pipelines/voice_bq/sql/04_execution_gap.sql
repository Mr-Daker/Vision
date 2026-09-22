-- ANALYSIS 3 — Execution / outcome gap.
--
-- Question: a project was funded and reported complete. Did ground-level
-- citizen evidence actually improve afterwards?
--
-- Method: compare the six months before the completion date against the six
-- months after, for the same district and sector, on a per-capita rate so a
-- growing population does not read as a failing project.
--
-- Language discipline, and it is not decoration. This analysis can only ever
-- observe that reports did not fall. It cannot see whether the work was done
-- badly, whether money went missing, or whether the project was ever meant to
-- address the issues being reported. Outputs are therefore phrased as
-- observations with an explicit alternative-explanations field, in the same
-- spirit as BANNED_DURABILITY_PHRASES in packages/domain/src/resolution-durability.ts.
-- Nothing here asserts fault.

CREATE OR REPLACE VIEW {analytics_features}_execution_gap AS
WITH completions AS (
  -- The most recent completion per district-sector that leaves at least three
  -- months of observable history on each side.
  SELECT
    p.district_key,
    p.sector,
    MAX(p.actual_completion_date) AS completion_date,
    COUNT(*)                      AS completed_projects,
    SUM(p.spent_amount)           AS spent_on_completed
  FROM {public_projects} AS p
  WHERE p.project_status = 'completed'
    AND p.actual_completion_date IS NOT NULL
  GROUP BY p.district_key, p.sector
),
anchored AS (
  SELECT
    c.*,
    -- EXTRACT rather than a format function: BigQuery spells it
    -- FORMAT_DATE and DuckDB spells it strftime, but EXTRACT is identical
    -- in both and yields the same year*100+month key used everywhere else.
    EXTRACT(YEAR FROM c.completion_date) * 100 + EXTRACT(MONTH FROM c.completion_date)
      AS completion_period
  FROM completions AS c
),
windows AS (
  SELECT
    a.district_key,
    a.sector,
    a.completion_date,
    a.completion_period,
    a.completed_projects,
    a.spent_on_completed,
    MAX(f.population) AS population,
    MAX(f.infrastructure_deficit_score) AS infrastructure_deficit_score,

    SUM(CASE WHEN f.period <  a.completion_period THEN f.citizen_report_count ELSE 0 END) AS reports_before,
    SUM(CASE WHEN f.period >= a.completion_period THEN f.citizen_report_count ELSE 0 END) AS reports_after,
    SUM(CASE WHEN f.period <  a.completion_period THEN 1 ELSE 0 END) AS months_before,
    SUM(CASE WHEN f.period >= a.completion_period THEN 1 ELSE 0 END) AS months_after,
    SUM(CASE WHEN f.period >= a.completion_period THEN f.canonical_issue_count ELSE 0 END) AS new_issues_after,
    AVG(CASE WHEN f.period <  a.completion_period THEN f.avg_severity END) AS severity_before,
    AVG(CASE WHEN f.period >= a.completion_period THEN f.avg_severity END) AS severity_after
  FROM anchored AS a
  JOIN {analytics_features} AS f
    ON f.district_key = a.district_key
   AND f.sector = a.sector
   -- Six months either side of completion.
   AND f.period >= a.completion_period - 6
   AND f.period <= a.completion_period + 6
  GROUP BY a.district_key, a.sector, a.completion_date, a.completion_period,
           a.completed_projects, a.spent_on_completed
),
rates AS (
  SELECT
    w.*,
    -- Monthly report rate per 10k people, each side of the completion.
    (w.reports_before / NULLIF(w.months_before, 0)) / NULLIF(w.population / 10000.0, 0)
      AS rate_before_per_10k,
    (w.reports_after  / NULLIF(w.months_after, 0))  / NULLIF(w.population / 10000.0, 0)
      AS rate_after_per_10k
  FROM windows AS w
  -- Both sides must be observable, or the comparison is not a comparison.
  WHERE w.months_before >= 3 AND w.months_after >= 3
)
SELECT
  r.district_key,
  r.sector,
  r.completion_date,
  r.completed_projects,
  r.spent_on_completed,
  r.population,
  r.infrastructure_deficit_score,
  r.reports_before,
  r.reports_after,
  r.months_before,
  r.months_after,
  r.rate_before_per_10k,
  r.rate_after_per_10k,
  r.new_issues_after,
  r.severity_before,
  r.severity_after,
  (r.rate_after_per_10k - r.rate_before_per_10k) / NULLIF(r.rate_before_per_10k, 0)
    AS rate_change_ratio,

  -- Same evidence floor as Analysis 1: a change from 2 reports to 3 is not a
  -- finding about a public project.
  (r.reports_before + r.reports_after >= 10) AS sufficient_evidence,

  CASE
    WHEN r.reports_before + r.reports_after < 10 THEN 'INSUFFICIENT_EVIDENCE'
    -- A quarter or more reduction in the per-capita rate.
    WHEN r.rate_after_per_10k <= r.rate_before_per_10k * 0.75 THEN 'EXPECTED_IMPROVEMENT_OBSERVED'
    -- No material movement AND the infrastructure indicator is still poor.
    -- The deficit condition is not decoration: if the indicator has recovered,
    -- continuing reports are more likely to be about something the project
    -- never scoped than about the project having failed to land.
    WHEN r.rate_after_per_10k >= r.rate_before_per_10k * 0.95
     AND r.infrastructure_deficit_score >= 40 THEN 'POSSIBLE_OUTCOME_GAP'
    ELSE 'PARTIAL_IMPROVEMENT_OBSERVED'
  END AS execution_finding,

  -- Shipped with the finding, not buried in a footnote. Every one of these is
  -- a reason the observation above might mean nothing.
  'Reports may cover issues the project did not scope,' ||
  'reporting may have risen because the project raised local awareness,' ||
  'completion date is recorded not verified,' ||
  'population is Census 2011 and may have changed'
    AS alternative_explanations
FROM rates AS r;
