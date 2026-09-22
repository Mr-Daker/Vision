-- ANALYSIS 1 — Unmet development need.
--
-- Question: where is citizen evidence consistently showing significant need,
-- corroborated by infrastructure indicators, and insufficiently covered by
-- existing investment?
--
-- Four named component signals, each independently inspectable, and a set of
-- reason codes. Deliberately NOT one composite score: a policymaker who cannot
-- argue with a number will not act on it, and `prioritization.ts` already
-- settled this question for the rest of the codebase by refusing to publish a
-- rank. The components are combined by a stated rule, not by learned weights.
--
-- Comparisons are made WITHIN sector. A water deficit score and an education
-- deficit score are not the same quantity, and ranking them against each other
-- would make whichever sector happens to score higher look like a national
-- emergency.

CREATE OR REPLACE VIEW {analytics_features}_unmet_need AS
WITH window_bounds AS (
  -- The assessment window: the six most recent months. Long enough that one
  -- quiet month does not hide a problem, short enough to describe the present.
  SELECT MAX(period_index) - 5 AS from_index FROM {analytics_features}
),
recent AS (
  SELECT
    f.district_key,
    f.state_code,
    f.state_name,
    f.district_name,
    f.sector,
    MAX(f.population)                        AS population,
    SUM(f.citizen_report_count)              AS reports_6m,
    SUM(f.unique_citizen_count)              AS unique_citizens_6m,
    SUM(f.canonical_issue_count)             AS canonical_issues_6m,
    SUM(f.persistent_issue_count)            AS persistent_issues_6m,
    AVG(f.reports_per_10k)                   AS reports_per_10k_avg,
    AVG(f.avg_severity)                      AS avg_severity,
    AVG(f.avg_persistence_days)              AS avg_persistence_days,
    MAX(f.infrastructure_deficit_score)      AS infrastructure_deficit_score,
    MAX(f.infrastructure_data_origin)        AS infrastructure_data_origin,
    MAX(f.sanctioned_investment)             AS sanctioned_investment,
    MAX(f.spent_investment)                  AS spent_investment,
    MAX(f.active_project_count)              AS active_project_count,
    MAX(f.completed_project_count)           AS completed_project_count,
    MAX(f.digital_participation_score)       AS digital_participation_score
  FROM {analytics_features} AS f, window_bounds AS b
  WHERE f.period_index >= b.from_index
  GROUP BY f.district_key, f.state_code, f.state_name, f.district_name, f.sector
),
scored AS (
  SELECT
    r.*,
    r.spent_investment / NULLIF(r.population / 10000.0, 0) AS spent_per_10k,

    -- Each component is a within-sector percentile so the four are on one
    -- scale and can be read side by side. The deficit is the exception: it is
    -- already an absolute 0-100 indicator, and re-ranking it would hide that a
    -- whole sector is badly served everywhere.
    PERCENT_RANK() OVER (PARTITION BY r.sector ORDER BY r.reports_per_10k_avg)
      AS citizen_demand_signal,
    r.infrastructure_deficit_score / 100.0
      AS infrastructure_deficit_signal,
    PERCENT_RANK() OVER (PARTITION BY r.sector ORDER BY r.population)
      AS population_exposure_signal,
    PERCENT_RANK() OVER (
      PARTITION BY r.sector
      ORDER BY r.spent_investment / NULLIF(r.population / 10000.0, 0)
    ) AS investment_coverage_signal
  FROM recent AS r
)
SELECT
  s.*,

  -- A per-capita rate computed from a handful of reports is noise wearing a
  -- decimal point: three reports in a small district can top the national
  -- demand ranking. The floor mirrors MINIMUM_CLOSURES_FOR_A_CONCERN = 10 in
  -- packages/domain/src/resolution-durability.ts, which settled the same
  -- question for durability concerns — do not send someone to investigate a
  -- place on the strength of a handful of events.
  (s.reports_6m >= 10) AS sufficient_evidence,

  -- Investment is deliberately NOT a condition here. This view answers "is
  -- there corroborated need?" and nothing else; whether that need is already
  -- funded is Analysis 2's question. An earlier version gated need on low
  -- investment and thereby made the most important classification in the
  -- system impossible: a district with high need AND an active project was
  -- filtered out before anything could label it MONITOR_EXISTING_PROJECT, so
  -- the duplicate-investment case could never be surfaced at all.
  --
  -- investment_coverage_signal is still computed and still reported — it is
  -- informative context, and Analysis 2 consumes it — it just does not decide
  -- whether need exists.
  -- FROZEN THRESHOLDS — selected on the development split only.
  --
  -- Selection rule, stated before the sweep was read: take the highest dev-set
  -- F1 among settings where the infrastructure condition actually binds, which
  -- means a deficit threshold above the national median of 0.30. The
  -- constraint is not cosmetic. The unconstrained dev optimum was
  -- demand>=0.97 with deficit>=0.30 (F1 0.530), but at the median the
  -- infrastructure term filters almost nothing, and this analysis claims
  -- citizen demand "corroborated by infrastructure indicators". A rule that
  -- does not mean what it says would score slightly better and be worth less.
  --
  -- Chosen: demand>=0.97, deficit>=0.40 — dev F1 0.512.
  -- The surface is flat here (0.95/0.30 scores 0.523), so the choice is not
  -- knife-edge and small perturbations do not change the conclusion.
  --
  -- The hidden 30% of planted cells took no part in this and is scored once.
  (
    s.reports_6m >= 10
    AND s.citizen_demand_signal         >= 0.97
    AND s.infrastructure_deficit_signal >= 0.40
  ) AS potential_unmet_need,

  -- Why this row looks the way it does, in the order a reader would ask.
  CASE WHEN s.citizen_demand_signal >= 0.97 THEN 'HIGH_CITIZEN_DEMAND,' ELSE '' END ||
  CASE WHEN s.infrastructure_deficit_signal >= 0.40 THEN 'INFRASTRUCTURE_DEFICIT_CORROBORATES,' ELSE '' END ||
  CASE WHEN s.investment_coverage_signal <= 0.40 THEN 'LOW_INVESTMENT_PER_CAPITA,' ELSE '' END ||
  CASE WHEN s.population_exposure_signal >= 0.75 THEN 'LARGE_POPULATION_EXPOSED,' ELSE '' END ||
  CASE WHEN s.persistent_issues_6m > 0 THEN 'PERSISTENT_ISSUES_PRESENT,' ELSE '' END ||
  CASE WHEN s.avg_severity >= 3.5 THEN 'HIGH_AVERAGE_SEVERITY,' ELSE '' END ||
  -- Stated whenever it applies, because a signal resting on modelled
  -- indicators deserves less confidence than one resting on a published table.
  CASE WHEN s.infrastructure_data_origin = 'derived' THEN 'INFRA_INDICATOR_IS_MODELLED,' ELSE '' END ||
  CASE WHEN s.reports_6m < 10 THEN 'TOO_FEW_REPORTS_TO_RATE,' ELSE '' END
    AS reason_codes
FROM scored AS s;
