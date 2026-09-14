-- 0014_proposals_cache_and_trust.sql
-- Roadmap: closes labelled gaps in V023, V025 and V032.
--
-- Three tables, each one closing a gap that was recorded as "not done":
--
--  * V023 said "no result caching by input hash, so a repeat is a repeat
--    charge". `ai_result_cache` is that cache.
--  * V023/V032 said AI proposals "are not yet persisted against evidence", so
--    uncertain classifications could not reach the review queue.
--    `classification_proposal` persists them.
--  * V025 said "nothing consumes these checks yet" and V032 said
--    `flagged_evidence` "is declared but not populated".
--    `trust_signal_report` stores the evaluated checks so the queue can.

-- V023. Keyed by what was actually sent, so a repeat of the same input costs
-- nothing. The model and prompt versions are part of the key: a changed prompt
-- is a different question and must not be answered from an old cache.
CREATE TABLE ai_result_cache (
    cache_id        uuid        NOT NULL PRIMARY KEY,
    operation       text        NOT NULL,
    input_hash      text        NOT NULL,
    model_name      text        NOT NULL,
    prompt_version  text        NOT NULL,
    -- The provider's structured answer. Never the request: V005 §6 forbids
    -- storing raw request bodies, and the hash identifies the input already.
    result          jsonb       NOT NULL,
    provider_request_id text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    hit_count       integer     NOT NULL DEFAULT 0,

    CONSTRAINT ai_result_cache_operation_ck CHECK (operation IN
        ('classification','embedding','transcription')),
    CONSTRAINT ai_result_cache_hash_shape_ck CHECK (input_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ai_result_cache_hits_ck CHECK (hit_count >= 0),
    CONSTRAINT ai_result_cache_key_uniq
        UNIQUE (operation, input_hash, model_name, prompt_version)
);

COMMENT ON TABLE ai_result_cache IS
    'Caches provider answers by input hash (V023). The model and prompt version are part of the key: a changed prompt is a different question.';

-- V023/V032. A proposal is advice pending review, never a decision, so it is
-- stored beside the evidence rather than written into it.
CREATE TABLE classification_proposal (
    proposal_id         uuid        NOT NULL PRIMARY KEY,
    submission_id       uuid        NOT NULL REFERENCES submission (submission_id),
    evidence_id         uuid        REFERENCES evidence_item (evidence_id),
    taxonomy_version    text        NOT NULL,
    proposed_category_id text       NOT NULL,
    proposed_defect_id  text,
    -- An ordinal band only. V002 prohibition 9 forbids a calibrated-looking
    -- score, so there is deliberately no numeric confidence column.
    certainty_band      text        NOT NULL,
    requires_review     boolean     NOT NULL,
    model_name          text        NOT NULL,
    prompt_version      text        NOT NULL,
    input_hash          text        NOT NULL,
    -- Set once a reviewer accepts or rejects the proposal (V032).
    reviewed_at         timestamptz,
    review_decision_id  uuid        REFERENCES review_decision (decision_id),
    created_at          timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT classification_proposal_band_ck
        CHECK (certainty_band IN ('low','medium','high')),
    CONSTRAINT classification_proposal_reviewed_ck
        CHECK ((reviewed_at IS NULL) = (review_decision_id IS NULL))
);

CREATE INDEX classification_proposal_pending_idx
    ON classification_proposal (created_at)
    WHERE requires_review AND reviewed_at IS NULL;

COMMENT ON TABLE classification_proposal IS
    'AI category proposals pending review (V023). Advice, not a decision: it is never written into evidence_item, and there is no numeric confidence column.';

-- V025/V032. The evaluated trust checks, stored so a reviewer can see them and
-- so an inconsistent signal can reach the queue.
CREATE TABLE trust_signal_report (
    report_id       uuid        NOT NULL PRIMARY KEY,
    submission_id   uuid        NOT NULL REFERENCES submission (submission_id),
    canonical_issue_id uuid     REFERENCES canonical_issue (issue_id),
    -- True when at least one check came back inconsistent. `unknown` never
    -- sets this: missing metadata is not a fraud signal (V025).
    requires_review boolean     NOT NULL,
    -- The individual checks with their reasons, exactly as V025 produced them.
    checks          jsonb       NOT NULL,
    -- True when any input came from a fixture rather than live data.
    any_input_is_fixture boolean NOT NULL,
    evaluated_at    timestamptz NOT NULL DEFAULT now(),
    reviewed_at     timestamptz,
    review_decision_id uuid     REFERENCES review_decision (decision_id),

    CONSTRAINT trust_signal_report_reviewed_ck
        CHECK ((reviewed_at IS NULL) = (review_decision_id IS NULL)),
    -- One standing report per submission; recomputing replaces it.
    CONSTRAINT trust_signal_report_submission_uniq UNIQUE (submission_id)
);

CREATE INDEX trust_signal_report_flagged_idx
    ON trust_signal_report (evaluated_at)
    WHERE requires_review AND reviewed_at IS NULL;

COMMENT ON TABLE trust_signal_report IS
    'Evaluated V025 trust checks. `requires_review` is set only by an inconsistent check, never by an unknown one: missing metadata is not evidence of anything.';
