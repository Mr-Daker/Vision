-- 0004_identity_and_consent.sql
-- Roadmap: V012 — participant mappings, sessions and consent.
--
-- The V003 split is enforced by three separate tables: a stable pseudonymous
-- participant, a restricted provider mapping, and revocable sessions. Session
-- state can never mutate a participant because they are different rows with
-- no shared mutable column.

CREATE TABLE participant (
    participant_id  uuid        NOT NULL PRIMARY KEY,
    created_at      timestamptz NOT NULL DEFAULT now(),
    -- A deletion request tombstones the participant; the row survives so
    -- append-only event ordering and anti-double-count history stay coherent.
    tombstoned_at   timestamptz
);

-- Highly restricted (V005 L3a). The raw provider subject is never stored:
-- only a keyed hash produced inside the identity service.
CREATE TABLE identity_mapping (
    identity_mapping_id     uuid        NOT NULL PRIMARY KEY,
    participant_id          uuid        NOT NULL REFERENCES participant (participant_id),
    provider                text        NOT NULL,
    provider_subject_hash   text,
    provider_mode           text        NOT NULL,
    created_at              timestamptz NOT NULL DEFAULT now(),
    disabled_at             timestamptz,
    erased_at               timestamptz,

    CONSTRAINT identity_mapping_mode_ck CHECK (provider_mode IN ('simulated','real')),
    -- Erasure nulls the hash but keeps the row as a non-content tombstone.
    CONSTRAINT identity_mapping_erased_ck
        CHECK (erased_at IS NULL OR provider_subject_hash IS NULL),
    CONSTRAINT identity_mapping_hash_shape_ck
        CHECK (provider_subject_hash IS NULL OR provider_subject_hash ~ '^[0-9a-f]{64}$')
);

-- One provider subject maps to exactly one participant. Partial so erased
-- rows (hash nulled) do not collide with each other.
CREATE UNIQUE INDEX identity_mapping_provider_subject_uniq
    ON identity_mapping (provider, provider_subject_hash)
    WHERE provider_subject_hash IS NOT NULL;

CREATE INDEX identity_mapping_participant_idx ON identity_mapping (participant_id);

CREATE TABLE app_session (
    session_id          uuid        NOT NULL PRIMARY KEY,
    participant_id      uuid        NOT NULL REFERENCES participant (participant_id),
    -- Only the hash of the session credential is ever stored.
    token_hash          text        NOT NULL,
    issued_at           timestamptz NOT NULL,
    expires_at          timestamptz NOT NULL,
    revoked_at          timestamptz,
    revocation_reason   text,
    current_version     integer     NOT NULL DEFAULT 1,

    CONSTRAINT app_session_expiry_after_issue_ck CHECK (expires_at > issued_at),
    CONSTRAINT app_session_revocation_reason_ck CHECK (
        (revoked_at IS NULL AND revocation_reason IS NULL)
        OR (revoked_at IS NOT NULL AND revocation_reason IN
            ('logout','admin_revocation','security_incident'))
    ),
    CONSTRAINT app_session_token_hash_shape_ck CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT app_session_version_ck CHECK (current_version >= 1)
);

CREATE INDEX app_session_participant_active_idx ON app_session (participant_id)
    WHERE revoked_at IS NULL;

CREATE TABLE consent_record (
    consent_id          uuid        NOT NULL PRIMARY KEY,
    participant_id      uuid        NOT NULL REFERENCES participant (participant_id),
    notice_version      text        NOT NULL,
    notice_locale       text        NOT NULL,
    granted_purposes    text[]      NOT NULL,
    granted_at          timestamptz NOT NULL,
    withdrawn_at        timestamptz,
    withdrawal_reason   text,

    CONSTRAINT consent_record_purposes_nonempty_ck CHECK (array_length(granted_purposes, 1) >= 1),
    -- Optional purposes are never inferred from demo_processing (V003).
    CONSTRAINT consent_record_purposes_known_ck CHECK (
        granted_purposes <@ ARRAY['demo_processing','public_derivative',
                                  'gemini_classification','gemini_voice_transcription']::text[]
    ),
    CONSTRAINT consent_record_withdrawal_ck
        CHECK (withdrawn_at IS NULL OR withdrawn_at >= granted_at)
);

CREATE INDEX consent_record_participant_idx ON consent_record (participant_id, granted_at DESC);
