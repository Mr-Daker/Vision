-- 0012_citizen_corrections.sql
-- Roadmap: V031 (citizen duplicate confirmation and correction), consumed by
-- the V032 review queue.
--
-- A citizen who disagrees with a proposed match is not making a mistake to be
-- discarded, and they are also not authorised to undo an attachment on their
-- own — an attachment carries other people's evidence. So disagreement becomes
-- a *request* that a reviewer decides, and the request keeps the citizen's own
-- words rather than a category they had to choose from a list.
--
-- Deliberately NOT a status on the issue: several citizens may disagree about
-- the same attachment, and each of those is a separate thing to answer.

CREATE TABLE correction_request (
    request_id          uuid        NOT NULL PRIMARY KEY,
    -- What the citizen is disagreeing about.
    kind                text        NOT NULL,
    -- The submission whose attachment is disputed. Always present: a request
    -- is always about a specific person's own report.
    submission_id       uuid        NOT NULL REFERENCES submission (submission_id),
    -- The issue the evidence was attached to, when there is one.
    canonical_issue_id  uuid        REFERENCES canonical_issue (issue_id),
    -- Who asked. A participant, because only the reporter may dispute their
    -- own attachment; staff corrections travel through V032 directly.
    requested_by_participant_id uuid NOT NULL REFERENCES participant (participant_id),
    -- The citizen's own wording. Never a category identifier: V031 requires
    -- that rejecting a match does not depend on understanding government
    -- categories.
    citizen_note        text,
    state               text        NOT NULL DEFAULT 'open',
    created_at          timestamptz NOT NULL DEFAULT now(),
    -- Resolution, written only by a reviewer (V032).
    decided_by_reviewer_id uuid,
    decided_at          timestamptz,
    decision            text,
    decision_reason     text,

    CONSTRAINT correction_request_kind_ck CHECK (kind IN
        ('not_the_same_problem','wrong_location','wrong_evidence','other')),
    CONSTRAINT correction_request_state_ck CHECK (state IN ('open','accepted','rejected')),
    -- A decision needs all of its parts or none: a reviewer id with no reason
    -- is an unexplained decision, and a reason with no reviewer is anonymous.
    CONSTRAINT correction_request_decision_complete_ck CHECK (
        (state = 'open') = (decided_by_reviewer_id IS NULL)
        AND (decided_by_reviewer_id IS NULL) = (decided_at IS NULL)
        AND (decided_by_reviewer_id IS NULL) = (decision IS NULL)
        AND (decided_by_reviewer_id IS NULL) = (decision_reason IS NULL)
    ),
    CONSTRAINT correction_request_decision_value_ck
        CHECK (decision IS NULL OR decision IN ('accepted','rejected')),
    CONSTRAINT correction_request_reason_nonempty_ck
        CHECK (decision_reason IS NULL OR length(btrim(decision_reason)) > 0),
    -- One open request per person per submission: tapping twice is not two
    -- disagreements.
    CONSTRAINT correction_request_one_open_uniq
        EXCLUDE (submission_id WITH =, requested_by_participant_id WITH =)
        WHERE (state = 'open')
);

CREATE INDEX correction_request_open_idx
    ON correction_request (state, created_at) WHERE state = 'open';

COMMENT ON TABLE correction_request IS
    'Citizen disagreement with a proposed or committed match (V031), decided by a reviewer (V032). Keeps the citizen''s own wording rather than a government category.';
