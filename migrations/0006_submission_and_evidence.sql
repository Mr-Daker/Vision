-- 0006_submission_and_evidence.sql
-- Roadmap: V012 — submissions, evidence metadata and processing stages.

CREATE TABLE submission (
    submission_id           uuid        NOT NULL PRIMARY KEY,
    participant_id          uuid        NOT NULL REFERENCES participant (participant_id),
    -- Device-reported claim, not proof of presence (V002 rows 3-4).
    observed_location       geography(Point, 4326),
    observed_accuracy_m     double precision,
    observed_location_source text,
    -- Client-asserted event time, kept separate from server ingestion time.
    observed_at             timestamptz NOT NULL,
    server_received_at      timestamptz NOT NULL DEFAULT now(),
    interface_locale        text        NOT NULL,
    language_hint           text,
    locale_pack_version     text        NOT NULL,
    idempotency_key         text        NOT NULL,
    taxonomy_version        text        NOT NULL,
    processing_status       text        NOT NULL DEFAULT 'received',
    privacy_state           text        NOT NULL DEFAULT 'active',
    erased_at               timestamptz,
    current_version         integer     NOT NULL DEFAULT 1,

    -- Prevents repeated request acceptance: a retried submit under the same
    -- key can only ever resolve to the one committed row.
    CONSTRAINT submission_participant_idempotency_uniq UNIQUE (participant_id, idempotency_key),
    CONSTRAINT submission_status_ck CHECK (processing_status IN
        ('received','processing','needs_review','accepted','rejected','quarantined')),
    CONSTRAINT submission_privacy_state_ck CHECK (privacy_state IN ('active','erased')),
    CONSTRAINT submission_accuracy_ck CHECK (observed_accuracy_m IS NULL OR observed_accuracy_m >= 0),
    -- Erasure nulls precise location and records when it happened.
    CONSTRAINT submission_erased_location_ck
        CHECK (privacy_state <> 'erased' OR observed_location IS NULL),
    CONSTRAINT submission_erased_at_ck
        CHECK ((privacy_state = 'erased') = (erased_at IS NOT NULL)),
    CONSTRAINT submission_version_ck CHECK (current_version >= 1)
);

CREATE INDEX submission_participant_idx ON submission (participant_id);
CREATE INDEX submission_location_gix ON submission USING GIST (observed_location);
CREATE INDEX submission_status_idx ON submission (processing_status)
    WHERE processing_status IN ('received','processing','needs_review');

CREATE TABLE evidence_item (
    evidence_id             uuid        NOT NULL PRIMARY KEY,
    submission_id           uuid        NOT NULL REFERENCES submission (submission_id),
    media_type              text        NOT NULL,
    -- Private original; never public, never sent to a classifier.
    object_reference        text,
    content_text            text,
    fingerprint_hash        text,
    perceptual_hash         text,
    capture_metadata        jsonb,
    source_language         text,
    -- Voice transcript: the only voice-derived value that may reach the AI path.
    transcript_text         text,
    transcript_provenance   jsonb,
    processing_status       text        NOT NULL DEFAULT 'pending',
    redaction_status        text        NOT NULL DEFAULT 'pending',
    derivative_reference    text,
    privacy_state           text        NOT NULL DEFAULT 'active',
    erased_at               timestamptz,
    captured_at             timestamptz,
    ingested_at             timestamptz NOT NULL DEFAULT now(),
    current_version         integer     NOT NULL DEFAULT 1,

    CONSTRAINT evidence_item_media_type_ck CHECK (media_type IN ('photo','voice','text')),
    CONSTRAINT evidence_item_processing_status_ck CHECK (processing_status IN
        ('pending','usable','needs_review','quarantined','rejected')),
    CONSTRAINT evidence_item_redaction_status_ck CHECK (redaction_status IN
        ('pending','approved','not_required','needs_review')),
    CONSTRAINT evidence_item_privacy_state_ck CHECK (privacy_state IN ('active','erased')),
    -- Active media items require an object and a fingerprint; text requires
    -- content and no object (V003 §3).
    CONSTRAINT evidence_item_media_requires_object_ck CHECK (
        privacy_state <> 'active' OR media_type = 'text'
        OR (object_reference IS NOT NULL AND fingerprint_hash IS NOT NULL)
    ),
    CONSTRAINT evidence_item_text_requires_content_ck CHECK (
        privacy_state <> 'active' OR media_type <> 'text'
        OR (content_text IS NOT NULL AND object_reference IS NULL)
    ),
    -- Only voice items may carry a transcript.
    CONSTRAINT evidence_item_transcript_only_for_voice_ck
        CHECK (transcript_text IS NULL OR media_type = 'voice'),
    -- Erasure clears every restricted value but keeps the tombstone row.
    CONSTRAINT evidence_item_erased_ck CHECK (
        privacy_state <> 'erased' OR (
            object_reference IS NULL AND content_text IS NULL AND fingerprint_hash IS NULL
            AND perceptual_hash IS NULL AND capture_metadata IS NULL
            AND transcript_text IS NULL AND transcript_provenance IS NULL
            AND derivative_reference IS NULL
        )
    ),
    CONSTRAINT evidence_item_erased_at_ck
        CHECK ((privacy_state = 'erased') = (erased_at IS NOT NULL)),
    -- A public derivative requires an approved redaction decision (V005 §7).
    CONSTRAINT evidence_item_derivative_needs_approval_ck
        CHECK (derivative_reference IS NULL OR redaction_status IN ('approved','not_required')),
    CONSTRAINT evidence_item_version_ck CHECK (current_version >= 1)
);

CREATE INDEX evidence_item_submission_idx ON evidence_item (submission_id);
CREATE INDEX evidence_item_fingerprint_idx ON evidence_item (fingerprint_hash)
    WHERE fingerprint_hash IS NOT NULL;

-- Durable stage execution (V006 §7; implemented in V017).
CREATE TABLE processing_stage (
    stage_id            uuid        NOT NULL PRIMARY KEY,
    submission_id       uuid        NOT NULL REFERENCES submission (submission_id),
    stage               text        NOT NULL,
    pipeline_version    text        NOT NULL,
    state               text        NOT NULL DEFAULT 'pending',
    input_hash          text,
    -- Lease with a fencing token: an expired holder cannot overwrite a newer
    -- holder's result.
    lease_owner         text,
    lease_expires_at    timestamptz,
    fencing_token       bigint      NOT NULL DEFAULT 0,
    attempts            integer     NOT NULL DEFAULT 0,
    result              jsonb,
    failure_reason      text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),

    -- Prevents duplicate stage identities: at-least-once delivery cannot
    -- create two rows for the same unit of work.
    CONSTRAINT processing_stage_identity_uniq UNIQUE (submission_id, stage, pipeline_version),
    CONSTRAINT processing_stage_state_ck CHECK (state IN
        ('pending','leased','succeeded','failed_retryable','failed_terminal')),
    CONSTRAINT processing_stage_attempts_ck CHECK (attempts >= 0),
    CONSTRAINT processing_stage_fencing_ck CHECK (fencing_token >= 0),
    CONSTRAINT processing_stage_lease_ck
        CHECK ((state = 'leased') = (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL))
);

CREATE INDEX processing_stage_claimable_idx ON processing_stage (state, lease_expires_at)
    WHERE state IN ('pending','leased','failed_retryable');
