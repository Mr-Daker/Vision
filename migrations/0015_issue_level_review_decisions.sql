-- 0015_issue_level_review_decisions.sql
-- Roadmap: closes V035's note that a returned dispute "records an event but
-- not a review_decision row, so it is not in V032's audit table".
--
-- `review_decision` required exactly one of evidence / match / correction as
-- its target. A reviewer returning disputed work to the crew has none of
-- those: the decision is about the *issue*. So the rule becomes "exactly one
-- target, and an issue counts as one", rather than leaving the one table built
-- for reasoned reviewer decisions unable to hold this one.
--
-- Forward-only: 0013's constraint is replaced rather than edited.

ALTER TABLE review_decision
    DROP CONSTRAINT review_decision_one_target_ck;

ALTER TABLE review_decision
    ADD CONSTRAINT review_decision_one_target_ck CHECK (
        (CASE WHEN evidence_id IS NOT NULL THEN 1 ELSE 0 END)
      + (CASE WHEN match_id IS NOT NULL THEN 1 ELSE 0 END)
      + (CASE WHEN correction_request_id IS NOT NULL THEN 1 ELSE 0 END)
      + (CASE WHEN action IN ('return_disputed_work') AND canonical_issue_id IS NOT NULL
              THEN 1 ELSE 0 END) = 1
    );

-- The new action. Named for what it does: the lifecycle has no edge from
-- disputed to confirmed, so a reviewer returns the work rather than overruling
-- the citizen (V035 §3).
ALTER TABLE review_decision
    DROP CONSTRAINT review_decision_action_ck;

ALTER TABLE review_decision
    ADD CONSTRAINT review_decision_action_ck CHECK (action IN
        ('accept_evidence','reject_evidence','approve_redaction','request_more_evidence',
         'attach_to_issue','separate_from_issue','accept_correction','reject_correction',
         'confirm_match','reject_match','return_disputed_work',
         'accept_classification','reject_classification','dismiss_trust_flag'));
