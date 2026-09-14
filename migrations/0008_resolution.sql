-- 0008_resolution.sql
-- Roadmap: V012 — resolution claims, their evidence, confirmations, reopenings.

CREATE TABLE resolution_claim (
    claim_id        uuid        NOT NULL PRIMARY KEY,
    issue_id        uuid        NOT NULL REFERENCES canonical_issue (issue_id),
    staff_id        uuid        NOT NULL,
    idempotency_key text        NOT NULL,
    claimed_at      timestamptz NOT NULL,
    description     text        NOT NULL,

    CONSTRAINT resolution_claim_staff_idempotency_uniq UNIQUE (staff_id, idempotency_key)
);

CREATE INDEX resolution_claim_issue_idx ON resolution_claim (issue_id);

CREATE TABLE resolution_evidence_item (
    resolution_evidence_id  uuid        NOT NULL PRIMARY KEY,
    claim_id                uuid        NOT NULL REFERENCES resolution_claim (claim_id),
    media_type              text        NOT NULL,
    object_reference        text,
    fingerprint_hash        text,
    capture_metadata        jsonb,
    redaction_status        text        NOT NULL DEFAULT 'pending',
    derivative_reference    text,
    privacy_state           text        NOT NULL DEFAULT 'active',
    erased_at               timestamptz,
    current_version         integer     NOT NULL DEFAULT 1,

    CONSTRAINT resolution_evidence_media_type_ck CHECK (media_type IN ('photo','document')),
    CONSTRAINT resolution_evidence_redaction_ck CHECK (redaction_status IN
        ('pending','approved','not_required','needs_review')),
    CONSTRAINT resolution_evidence_privacy_state_ck CHECK (privacy_state IN ('active','erased')),
    CONSTRAINT resolution_evidence_active_requires_object_ck CHECK (
        privacy_state <> 'active' OR (object_reference IS NOT NULL AND fingerprint_hash IS NOT NULL)
    ),
    CONSTRAINT resolution_evidence_erased_ck CHECK (
        privacy_state <> 'erased' OR (
            object_reference IS NULL AND fingerprint_hash IS NULL
            AND capture_metadata IS NULL AND derivative_reference IS NULL
        )
    ),
    CONSTRAINT resolution_evidence_derivative_needs_approval_ck
        CHECK (derivative_reference IS NULL OR redaction_status IN ('approved','not_required'))
);

CREATE INDEX resolution_evidence_claim_idx ON resolution_evidence_item (claim_id);

-- A staff claim is not a confirmed repair: confirmation is a separate record
-- written by a different actor (V002 row 17).
CREATE TABLE resolution_confirmation (
    confirmation_id             uuid        NOT NULL PRIMARY KEY,
    -- One confirmation per claim.
    claim_id                    uuid        NOT NULL UNIQUE
                                            REFERENCES resolution_claim (claim_id),
    responding_participant_id   uuid        REFERENCES participant (participant_id),
    reviewer_id                 uuid,
    decision                    text        NOT NULL,
    decided_at                  timestamptz NOT NULL,
    comment                     text,

    CONSTRAINT resolution_confirmation_decision_ck CHECK (decision IN ('confirmed','disputed')),
    -- Exactly one of participant or reviewer, so reviewer confirmation is
    -- never presented as citizen confirmation.
    CONSTRAINT resolution_confirmation_exactly_one_actor_ck
        CHECK ((responding_participant_id IS NULL) <> (reviewer_id IS NULL))
);

CREATE TABLE reopening (
    reopening_id            uuid        NOT NULL PRIMARY KEY,
    issue_id                uuid        NOT NULL REFERENCES canonical_issue (issue_id),
    prior_confirmation_id   uuid        NOT NULL
                                        REFERENCES resolution_confirmation (confirmation_id),
    reopened_at             timestamptz NOT NULL,
    reason                  text        NOT NULL,
    actor_type              text        NOT NULL,
    actor_id                uuid        NOT NULL,

    CONSTRAINT reopening_actor_type_ck CHECK (actor_type IN
        ('citizen','staff','reviewer','supervisor'))
);

CREATE INDEX reopening_issue_idx ON reopening (issue_id);
