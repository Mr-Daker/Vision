-- 0020_private_evidence_access_log.sql
-- Roadmap: V015/V032 purpose-bound reviewer access to private originals.
--
-- A review decision cannot be responsible if the reviewer cannot inspect the
-- evidence, but a private original must never become an ordinary static URL.
-- Each successful read is therefore tied to the validated session, durable
-- staff account, jurisdiction and stated purpose. Rows are append-only from
-- the application; there is no update path.

CREATE TABLE private_evidence_access_log (
    access_id       uuid        NOT NULL PRIMARY KEY,
    evidence_id     uuid        NOT NULL REFERENCES evidence_item (evidence_id),
    staff_id        uuid        NOT NULL REFERENCES staff_account (staff_id),
    session_id      uuid        NOT NULL REFERENCES app_session (session_id),
    jurisdiction_id uuid        NOT NULL REFERENCES jurisdiction (jurisdiction_id),
    purpose         text        NOT NULL,
    accessed_at     timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT private_evidence_access_purpose_ck CHECK (length(btrim(purpose)) >= 8)
);

CREATE INDEX private_evidence_access_staff_idx
    ON private_evidence_access_log (staff_id, accessed_at DESC);
CREATE INDEX private_evidence_access_evidence_idx
    ON private_evidence_access_log (evidence_id, accessed_at DESC);

COMMENT ON TABLE private_evidence_access_log IS
    'Append-only audit of successful, purpose-bound staff reads of private evidence originals.';
