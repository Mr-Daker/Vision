-- 0017_claim_jurisdiction.sql
-- Roadmap: fixes the V032 defect that `awaitingJurisdictionCount` reported a
-- backlog nobody could ever act on.
--
-- Every review action is jurisdiction-scoped (V015), and an item's
-- jurisdiction comes from the issue it belongs to. An issue with no
-- jurisdiction therefore has no principal who could be authorised for it: the
-- count made the backlog visible and left it permanently stuck.
--
-- `claim_jurisdiction` lets a *person* say "this is in my area". It does not
-- resolve a jurisdiction from a location — that needs the reviewed boundaries
-- V059 supplies, and deriving one here would attribute somebody's report to an
-- authority that may not cover the place. It records a human claim, attributed
-- to the reviewer who made it, with their stated reason.
--
-- Forward-only: 0015's action list is replaced rather than edited.

ALTER TABLE review_decision
    DROP CONSTRAINT review_decision_action_ck;

ALTER TABLE review_decision
    ADD CONSTRAINT review_decision_action_ck CHECK (action IN
        ('accept_evidence','reject_evidence','approve_redaction','request_more_evidence',
         'attach_to_issue','separate_from_issue','accept_correction','reject_correction',
         'confirm_match','reject_match','return_disputed_work',
         'accept_classification','reject_classification','dismiss_trust_flag',
         'claim_jurisdiction'));
