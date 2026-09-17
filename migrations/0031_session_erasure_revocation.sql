-- 0031_session_erasure_revocation.sql
-- Roadmap: V044 — a session ended by the participant's own erasure request.
--
-- 0004 allowed three revocation reasons: logout, admin_revocation and
-- security_incident. A session closed because the person asked to be erased is
-- none of them. Recording it as `admin_revocation` would put a staff decision
-- in the audit trail where a citizen's request belongs, and the audit trail is
-- the one place that distinction has to survive — it is what somebody would
-- read months later to answer "who ended this, and why".
--
-- `logout` would be worse: it reads as the person closing a tab.

ALTER TABLE app_session DROP CONSTRAINT app_session_revocation_reason_ck;

ALTER TABLE app_session
    ADD CONSTRAINT app_session_revocation_reason_ck CHECK (
        (revoked_at IS NULL AND revocation_reason IS NULL)
        OR (revoked_at IS NOT NULL AND revocation_reason IN
            ('logout','admin_revocation','security_incident','erasure'))
    );

COMMENT ON COLUMN app_session.revocation_reason IS
    'Why the session ended. `erasure` means the participant asked to be erased and this session was closed as part of acting on that (V044) — not an administrator decision and not the person closing a tab.';
