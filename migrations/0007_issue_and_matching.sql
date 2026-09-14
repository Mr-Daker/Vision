-- 0007_issue_and_matching.sql
-- Roadmap: V012 — canonical issues, matching, evidence links, participation,
-- assignment, merges and issue aliases.
--
-- The "exactly one active row" rules from V003 are expressed as PARTIAL UNIQUE
-- INDEXES, which is the substantive work this migration exists to do: they are
-- what makes the invariants enforceable rather than aspirational.

CREATE TABLE canonical_issue (
    issue_id            uuid        NOT NULL PRIMARY KEY,
    -- Stable and permanent; still resolvable after a merge retires the issue.
    public_reference    text        NOT NULL UNIQUE,
    asset_id            text        REFERENCES infrastructure_asset (asset_id),
    jurisdiction_id     uuid        REFERENCES jurisdiction (jurisdiction_id),
    category            text        NOT NULL,
    current_status      text        NOT NULL DEFAULT 'created',
    opened_at           timestamptz NOT NULL,
    current_version     integer     NOT NULL DEFAULT 1,

    -- Operational workflow states only: no matching state and no
    -- evidence-attached state ever appears here (V003 CanonicalIssue).
    CONSTRAINT canonical_issue_status_ck CHECK (current_status IN
        ('created','routing_review','routed_internal','agency_ack_received','work_planned',
         'resolution_claimed','resolution_confirmed','resolution_disputed','reopened')),
    CONSTRAINT canonical_issue_version_ck CHECK (current_version >= 1)
);

CREATE INDEX canonical_issue_asset_idx ON canonical_issue (asset_id);
CREATE INDEX canonical_issue_jurisdiction_status_idx
    ON canonical_issue (jurisdiction_id, current_status);

-- Versioned duplicate/new-issue decision (V003 IssueMatch).
CREATE TABLE issue_match (
    match_id                uuid        NOT NULL PRIMARY KEY,
    submission_id           uuid        NOT NULL REFERENCES submission (submission_id),
    attempt_number          integer     NOT NULL,
    state                   text        NOT NULL DEFAULT 'pending',
    candidate_issue_ids     uuid[],
    resulting_issue_id      uuid        REFERENCES canonical_issue (issue_id),
    decision_basis          jsonb,
    decided_by_actor_type   text,
    decided_by_actor_id     uuid,
    decided_at              timestamptz,
    supersedes_match_id     uuid        REFERENCES issue_match (match_id),
    superseded_at           timestamptz,
    current_version         integer     NOT NULL DEFAULT 1,

    CONSTRAINT issue_match_attempt_uniq UNIQUE (submission_id, attempt_number),
    CONSTRAINT issue_match_attempt_positive_ck CHECK (attempt_number >= 1),
    CONSTRAINT issue_match_state_ck CHECK (state IN
        ('pending','candidates_retrieved','ambiguous','no_match','match_confirmed',
         'failed_retryable')),
    CONSTRAINT issue_match_actor_type_ck
        CHECK (decided_by_actor_type IS NULL OR decided_by_actor_type IN
            ('system','citizen','reviewer')),
    -- A terminal decision must carry its result and its basis; a non-terminal
    -- attempt must not pretend to have one.
    CONSTRAINT issue_match_terminal_requires_result_ck CHECK (
        state NOT IN ('no_match','match_confirmed')
        OR (resulting_issue_id IS NOT NULL AND decision_basis IS NOT NULL
            AND decided_by_actor_type IS NOT NULL AND decided_at IS NOT NULL)
    ),
    CONSTRAINT issue_match_nonterminal_has_no_result_ck CHECK (
        state IN ('no_match','match_confirmed') OR resulting_issue_id IS NULL
    ),
    CONSTRAINT issue_match_no_self_supersede_ck CHECK (supersedes_match_id <> match_id)
);

-- Exactly one active matching attempt per submission.
CREATE UNIQUE INDEX issue_match_one_active_per_submission_uniq
    ON issue_match (submission_id) WHERE superseded_at IS NULL;

CREATE INDEX issue_match_resulting_issue_idx ON issue_match (resulting_issue_id);

-- Effective-dated evidence-to-issue association (V003 IssueEvidenceLink).
-- Evidence carries no issue_id of its own; this table is the association.
CREATE TABLE issue_evidence_link (
    issue_evidence_link_id  uuid        NOT NULL PRIMARY KEY,
    evidence_id             uuid        NOT NULL REFERENCES evidence_item (evidence_id),
    canonical_issue_id      uuid        NOT NULL REFERENCES canonical_issue (issue_id),
    match_id                uuid        REFERENCES issue_match (match_id),
    decision_basis          jsonb       NOT NULL DEFAULT '{}'::jsonb,
    effective_from          timestamptz NOT NULL,
    effective_to            timestamptz,
    supersedes_link_id      uuid        REFERENCES issue_evidence_link (issue_evidence_link_id),
    superseded_by_link_id   uuid        REFERENCES issue_evidence_link (issue_evidence_link_id),
    corrected_by_actor_id   uuid,
    correction_reason       text,

    CONSTRAINT issue_evidence_link_range_ck
        CHECK (effective_to IS NULL OR effective_to > effective_from),
    CONSTRAINT issue_evidence_link_no_self_supersede_ck
        CHECK (supersedes_link_id <> issue_evidence_link_id
               AND superseded_by_link_id <> issue_evidence_link_id)
);

-- Exactly one active link per evidence item.
CREATE UNIQUE INDEX issue_evidence_link_one_active_per_evidence_uniq
    ON issue_evidence_link (evidence_id) WHERE effective_to IS NULL;

CREATE INDEX issue_evidence_link_issue_idx ON issue_evidence_link (canonical_issue_id)
    WHERE effective_to IS NULL;

-- Materialised participation decision (V003 IssueParticipation).
CREATE TABLE issue_participation (
    participation_id        uuid        NOT NULL PRIMARY KEY,
    participant_id          uuid        NOT NULL REFERENCES participant (participant_id),
    canonical_issue_id      uuid        NOT NULL REFERENCES canonical_issue (issue_id),
    counted                 boolean     NOT NULL DEFAULT true,
    non_counted_reason      text,
    eligibility_provenance  jsonb       NOT NULL DEFAULT '{}'::jsonb,
    first_evidence_at       timestamptz NOT NULL,
    last_evidence_at        timestamptz NOT NULL,
    created_at              timestamptz NOT NULL DEFAULT now(),
    current_version         integer     NOT NULL DEFAULT 1,

    -- Prevents repeated participation on the same canonical issue, however
    -- much evidence one participant contributes.
    CONSTRAINT issue_participation_participant_issue_uniq
        UNIQUE (participant_id, canonical_issue_id),
    CONSTRAINT issue_participation_reason_required_ck
        CHECK (counted OR non_counted_reason IS NOT NULL),
    CONSTRAINT issue_participation_evidence_order_ck
        CHECK (first_evidence_at <= last_evidence_at),
    CONSTRAINT issue_participation_version_ck CHECK (current_version >= 1)
);

CREATE INDEX issue_participation_issue_counted_idx
    ON issue_participation (canonical_issue_id) WHERE counted;

CREATE TABLE assignment (
    assignment_id           uuid        NOT NULL PRIMARY KEY,
    issue_id                uuid        NOT NULL REFERENCES canonical_issue (issue_id),
    department_id           text        NOT NULL,
    assigned_staff_id       uuid,
    reason                  text        NOT NULL,
    valid_from              timestamptz NOT NULL,
    valid_to                timestamptz,
    supersedes_assignment_id uuid       REFERENCES assignment (assignment_id),
    current_version         integer     NOT NULL DEFAULT 1,

    CONSTRAINT assignment_range_ck CHECK (valid_to IS NULL OR valid_to > valid_from),
    CONSTRAINT assignment_no_self_supersede_ck CHECK (supersedes_assignment_id <> assignment_id)
);

-- Exactly one active assignment per issue.
CREATE UNIQUE INDEX assignment_one_active_per_issue_uniq
    ON assignment (issue_id) WHERE valid_to IS NULL;

CREATE TABLE issue_merge (
    merge_id            uuid        NOT NULL PRIMARY KEY,
    surviving_issue_id  uuid        NOT NULL REFERENCES canonical_issue (issue_id),
    merged_issue_id     uuid        NOT NULL REFERENCES canonical_issue (issue_id),
    merged_at           timestamptz NOT NULL,
    reason              text        NOT NULL,
    decision_event_id   uuid        NOT NULL REFERENCES status_event (event_id),
    reversed_at         timestamptz,
    reversal_reason     text,
    reversal_event_id   uuid        REFERENCES status_event (event_id),

    CONSTRAINT issue_merge_distinct_ck CHECK (surviving_issue_id <> merged_issue_id),
    CONSTRAINT issue_merge_reversal_ck
        CHECK ((reversed_at IS NULL) = (reversal_reason IS NULL))
);

-- Effective-dated active-canonical edge (V003 IssueAlias). Merge creates one
-- active edge; reversal closes it. No replacement issue is created.
CREATE TABLE issue_alias (
    alias_id            uuid        NOT NULL PRIMARY KEY,
    source_issue_id     uuid        NOT NULL REFERENCES canonical_issue (issue_id),
    target_issue_id     uuid        NOT NULL REFERENCES canonical_issue (issue_id),
    merge_id            uuid        NOT NULL REFERENCES issue_merge (merge_id),
    valid_from          timestamptz NOT NULL,
    valid_to            timestamptz,
    closed_by_event_id  uuid        REFERENCES status_event (event_id),

    CONSTRAINT issue_alias_distinct_ck CHECK (source_issue_id <> target_issue_id),
    CONSTRAINT issue_alias_range_ck CHECK (valid_to IS NULL OR valid_to > valid_from)
);

-- One active outgoing alias per issue: an issue resolves to exactly one root.
CREATE UNIQUE INDEX issue_alias_one_active_outgoing_uniq
    ON issue_alias (source_issue_id) WHERE valid_to IS NULL;

CREATE INDEX issue_alias_target_idx ON issue_alias (target_issue_id) WHERE valid_to IS NULL;

CREATE TABLE project_link (
    project_link_id     uuid        NOT NULL PRIMARY KEY,
    issue_id            uuid        REFERENCES canonical_issue (issue_id),
    asset_id            text        REFERENCES infrastructure_asset (asset_id),
    source_project_id   uuid        NOT NULL REFERENCES source_record (source_record_id),
    match_basis         jsonb       NOT NULL,
    match_status        text        NOT NULL DEFAULT 'proposed',
    reviewer_id         uuid,
    proposed_at         timestamptz NOT NULL,
    decided_at          timestamptz,
    current_version     integer     NOT NULL DEFAULT 1,

    -- Exactly one of issue or asset (V003 ProjectLink).
    CONSTRAINT project_link_exactly_one_target_ck
        CHECK ((issue_id IS NULL) <> (asset_id IS NULL)),
    CONSTRAINT project_link_status_ck CHECK (match_status IN
        ('proposed','confirmed','rejected','ambiguous')),
    CONSTRAINT project_link_decided_ck
        CHECK (match_status = 'proposed' OR decided_at IS NOT NULL)
);
