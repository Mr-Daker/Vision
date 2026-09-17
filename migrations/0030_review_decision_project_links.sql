-- 0030_review_decision_project_links.sql
-- Roadmap: V041 — a project-link decision must be writable to the audit table.
--
-- The same failure 0024 fixed for the dispute override, one task later and for
-- the same reason. `review_decision_action_ck` lists the actions a reviewer
-- may record; an action missing from it rolls the whole transaction back with
-- a constraint error the reviewer sees as an unexplained failure, and — worse
-- — an action that cannot be written to `review_decision` is an action with no
-- audit trail.
--
-- That matters more here than almost anywhere else. Saying "this citizen's
-- report concerns this piece of public spending" is a claim about public money
-- with a person's name against it. If the claim can be made but the name
-- cannot be recorded, the system has produced an anonymous assertion about
-- government funding, which is precisely what V041 exists to prevent.
--
-- The target shape is extended for the same reason 0024 extended it: the
-- decision names the issue, because `project_link` has no column in
-- `review_decision` and adding one would mean a target that only one action
-- ever uses. The link itself is identified in `prior_state` / `resulting_state`.

ALTER TABLE review_decision
    DROP CONSTRAINT review_decision_action_ck;

ALTER TABLE review_decision
    ADD CONSTRAINT review_decision_action_ck CHECK (action IN
        ('accept_evidence','reject_evidence','approve_redaction','request_more_evidence',
         'attach_to_issue','separate_from_issue','accept_correction','reject_correction',
         'confirm_match','reject_match','return_disputed_work',
         'accept_classification','reject_classification','dismiss_trust_flag',
         'claim_jurisdiction','confirm_disputed_resolution',
         'confirm_project_link','reject_project_link'));

ALTER TABLE review_decision
    DROP CONSTRAINT review_decision_one_target_ck;

ALTER TABLE review_decision
    ADD CONSTRAINT review_decision_one_target_ck CHECK (
        (CASE WHEN evidence_id IS NOT NULL THEN 1 ELSE 0 END)
      + (CASE WHEN match_id IS NOT NULL THEN 1 ELSE 0 END)
      + (CASE WHEN correction_request_id IS NOT NULL THEN 1 ELSE 0 END)
      + (CASE WHEN action IN ('return_disputed_work','claim_jurisdiction',
                              'confirm_disputed_resolution',
                              'confirm_project_link','reject_project_link')
                   AND canonical_issue_id IS NOT NULL THEN 1 ELSE 0 END)
        = 1
    );
