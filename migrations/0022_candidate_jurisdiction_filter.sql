-- 0022_candidate_jurisdiction_filter.sql
-- Roadmap: V033 — make the spatial scope of duplicate retrieval replayable.

ALTER TABLE candidate_query_log
    ADD COLUMN jurisdiction_filter_mode text NOT NULL DEFAULT 'all';

ALTER TABLE candidate_query_log
    ADD CONSTRAINT candidate_query_log_jurisdiction_filter_ck CHECK
        (jurisdiction_filter_mode IN ('all','resolved_or_unscoped','unscoped_only'));

COMMENT ON COLUMN candidate_query_log.jurisdiction_filter_mode IS
    'Whether retrieval was unrestricted, limited to a resolved jurisdiction plus unscoped issues, or limited to unscoped issues because V033 could not safely resolve a boundary.';
