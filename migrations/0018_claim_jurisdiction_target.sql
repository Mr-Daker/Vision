-- 0018_claim_jurisdiction_target.sql
-- Roadmap: completes 0017.
--
-- 0015 made `canonical_issue_id` count as a review target, but only for
-- `return_disputed_work`. A `claim_jurisdiction` decision is also about the
-- issue and nothing else, so without this it has zero targets and
-- `review_decision_one_target_ck` rejects the row.
--
-- Separate from 0017 because 0017 is already applied, and migrations here are
-- forward-only and checksummed — editing an applied file would invalidate the
-- ledger that makes the schema re-derivable.

ALTER TABLE review_decision
    DROP CONSTRAINT review_decision_one_target_ck;

ALTER TABLE review_decision
    ADD CONSTRAINT review_decision_one_target_ck CHECK (
        (CASE WHEN evidence_id IS NOT NULL THEN 1 ELSE 0 END)
      + (CASE WHEN match_id IS NOT NULL THEN 1 ELSE 0 END)
      + (CASE WHEN correction_request_id IS NOT NULL THEN 1 ELSE 0 END)
      + (CASE WHEN action IN ('return_disputed_work','claim_jurisdiction')
                AND canonical_issue_id IS NOT NULL
              THEN 1 ELSE 0 END) = 1
    );
