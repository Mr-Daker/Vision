-- ANALYSIS 2 — Investment gap versus an existing project.
--
-- The single most consequential distinction in this system. Both of these look
-- identical in the citizen data:
--
--   high need + nothing sanctioned   -> a genuine funding gap
--   high need + project already live -> do NOT fund it twice; go and look at
--                                       why the funded work has not landed
--
-- Recommending a second project for a district that already has one funded is
-- how a system like this wastes public money and loses its credibility in one
-- move. The classification below exists to make that failure impossible by
-- construction: the investment record, not the complaint volume, decides.

CREATE OR REPLACE VIEW {analytics_features}_investment_classification AS
SELECT
  u.district_key,
  u.state_code,
  u.state_name,
  u.district_name,
  u.sector,
  u.population,
  u.reports_6m,
  u.unique_citizens_6m,
  u.canonical_issues_6m,
  u.persistent_issues_6m,
  u.avg_severity,
  u.infrastructure_deficit_score,
  u.infrastructure_data_origin,
  u.citizen_demand_signal,
  u.infrastructure_deficit_signal,
  u.population_exposure_signal,
  u.investment_coverage_signal,
  u.sufficient_evidence,
  u.potential_unmet_need,
  u.sanctioned_investment,
  u.spent_investment,
  u.active_project_count,
  u.completed_project_count,

  CASE
    WHEN NOT u.potential_unmet_need THEN 'NO_SIGNAL'
    -- Money is already committed here. The honest output is a monitoring
    -- instruction, never a second recommendation.
    WHEN u.active_project_count > 0 THEN 'MONITOR_EXISTING_PROJECT'
    -- Nothing live, but something was completed and demand persists. That is
    -- an outcome question for Analysis 3, not a funding question.
    WHEN u.completed_project_count > 0 THEN 'REVIEW_COMPLETED_PROJECT_OUTCOME'
    -- Sanctioned but nothing active and nothing finished: the money exists on
    -- paper and the work has not started.
    WHEN u.sanctioned_investment > 0 THEN 'MONITOR_STALLED_SANCTION'
    ELSE 'POTENTIAL_NEW_INVESTMENT_GAP'
  END AS investment_classification,

  CASE
    WHEN NOT u.potential_unmet_need THEN ''
    WHEN u.active_project_count > 0
      THEN 'Need signal is corroborated, and ' ||
           CAST(u.active_project_count AS STRING) ||
           ' project(s) are already active in this district and sector. ' ||
           'Investigate delivery before considering further investment.'
    WHEN u.completed_project_count > 0
      THEN 'Need signal persists despite ' ||
           CAST(u.completed_project_count AS STRING) ||
           ' completed project(s). Examine whether the completed work addressed this need.'
    WHEN u.sanctioned_investment > 0
      THEN 'Funds are sanctioned but no project is active or complete. Examine why work has not started.'
    ELSE 'No sanctioned, active or completed project was found for this district and sector.'
  END AS classification_note
FROM {analytics_features}_unmet_need AS u;
