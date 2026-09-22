-- Shared feature view: district x sector x month, with the temporal context
-- every analysis needs.
--
-- Built once as a view rather than repeated in five queries, because five
-- copies of "what counts as the recent window" drift apart within a week.
--
-- Dialect note: this file runs unmodified on BigQuery and on DuckDB. That
-- constrains it to the shared subset — no DATE_TRUNC (argument order differs),
-- no COUNTIF/FILTER (spelled differently), no SAFE_DIVIDE. Periods are an
-- integer year*100+month, which sorts and lags correctly in both.

CREATE OR REPLACE VIEW {analytics_features} AS
WITH base AS (
  SELECT
    m.district_key,
    m.state_code,
    m.state_name,
    m.district_name,
    m.sector,
    m.year,
    m.month,
    m.year * 100 + m.month                        AS period,
    m.population,
    m.citizen_report_count,
    m.unique_citizen_count,
    m.canonical_issue_count,
    m.reports_per_10k,
    m.avg_severity,
    m.high_severity_report_count,
    m.persistent_issue_count,
    m.avg_persistence_days,
    m.infrastructure_score,
    m.infrastructure_deficit_score,
    m.infrastructure_data_origin,
    m.sanctioned_investment,
    m.released_investment,
    m.spent_investment,
    m.active_project_count,
    m.completed_project_count,
    m.delayed_project_count,
    m.months_since_last_completion,
    m.digital_participation_score,
    m.urbanization_proxy
  FROM {district_sector_month} AS m
),
indexed AS (
  SELECT
    base.*,
    -- 1..24 within each cell, so windows are expressed in months rather than
    -- in row counts that a missing month would silently shift.
    DENSE_RANK() OVER (ORDER BY period) AS period_index,
    MAX(period) OVER ()                  AS latest_period
  FROM base
)
SELECT
  i.*,

  -- Trailing three-month demand, and the baseline it should be judged against.
  AVG(i.reports_per_10k) OVER w3  AS reports_per_10k_3m,
  AVG(i.reports_per_10k) OVER w12 AS reports_per_10k_12m,

  -- The baseline deliberately EXCLUDES the three most recent months: a
  -- surge that is included in its own baseline cannot be detected.
  AVG(i.reports_per_10k) OVER w_baseline    AS baseline_mean_per_10k,
  STDDEV_SAMP(i.reports_per_10k) OVER w_baseline AS baseline_stddev_per_10k,

  SUM(i.citizen_report_count) OVER w3  AS reports_3m,
  SUM(i.citizen_report_count) OVER w12 AS reports_12m,

  LAG(i.citizen_report_count, 1) OVER (PARTITION BY i.district_key, i.sector ORDER BY i.period)
    AS reports_prev_month,
  LAG(i.citizen_report_count, 12) OVER (PARTITION BY i.district_key, i.sector ORDER BY i.period)
    AS reports_same_month_last_year
FROM indexed AS i
WINDOW
  w3 AS (
    PARTITION BY i.district_key, i.sector ORDER BY i.period
    ROWS BETWEEN 2 PRECEDING AND CURRENT ROW
  ),
  w12 AS (
    PARTITION BY i.district_key, i.sector ORDER BY i.period
    ROWS BETWEEN 11 PRECEDING AND CURRENT ROW
  ),
  w_baseline AS (
    PARTITION BY i.district_key, i.sector ORDER BY i.period
    ROWS BETWEEN 14 PRECEDING AND 3 PRECEDING
  );
