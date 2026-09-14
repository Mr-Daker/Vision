-- 0024_reviewer_dispute_override.sql
-- Roadmap: V035 — a reviewer resolving a dispute in favour of the claim.
--
-- The V003 lifecycle gained a `resolution_disputed -> resolution_confirmed`
-- edge, guarded so only a reviewer may use it and only where the loaded
-- category policy sets `reviewer_may_override`. The decision was reachable
-- through the domain and the state machine, and then failed at the audit
-- table: `review_decision_action_ck` did not list it, so the whole
-- transaction rolled back with a constraint error the reviewer saw as an
-- unexplained failure.
--
-- Recording it here is the point, not a formality. Overruling the people who
-- live with a problem is the heaviest thing a reviewer can do in this system,
-- and V032's rule is that every decision carries a reason a person wrote. An
-- action that cannot be written to `review_decision` is an action with no
-- audit trail, which is exactly what must not exist for this one.
--
-- The citizen's dispute is untouched by it: the override is an additional
-- `resolution_confirmation` row by a different actor, and the disputed row
-- stays exactly as the participant left it.
--
-- Forward-only: 0017's action list is replaced rather than edited.

ALTER TABLE review_decision
    DROP CONSTRAINT review_decision_action_ck;

ALTER TABLE review_decision
    ADD CONSTRAINT review_decision_action_ck CHECK (action IN
        ('accept_evidence','reject_evidence','approve_redaction','request_more_evidence',
         'attach_to_issue','separate_from_issue','accept_correction','reject_correction',
         'confirm_match','reject_match','return_disputed_work',
         'accept_classification','reject_classification','dismiss_trust_flag',
         'claim_jurisdiction','confirm_disputed_resolution'));

-- The same decision also has to be a *valid target shape*. 0015 introduced
-- `review_decision_one_target_ck` so exactly one target is named, and it
-- counts `canonical_issue_id` only for the actions it knew about. Without this
-- the insert fails on the constraint instead of the action list, which is the
-- same outage one step later.
ALTER TABLE review_decision
    DROP CONSTRAINT review_decision_one_target_ck;

ALTER TABLE review_decision
    ADD CONSTRAINT review_decision_one_target_ck CHECK (
        (CASE WHEN evidence_id IS NOT NULL THEN 1 ELSE 0 END)
      + (CASE WHEN match_id IS NOT NULL THEN 1 ELSE 0 END)
      + (CASE WHEN correction_request_id IS NOT NULL THEN 1 ELSE 0 END)
      + (CASE WHEN action IN ('return_disputed_work','claim_jurisdiction',
                              'confirm_disputed_resolution')
                   AND canonical_issue_id IS NOT NULL THEN 1 ELSE 0 END)
        = 1
    );
