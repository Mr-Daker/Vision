-- 0019_staff_grants.sql
-- Roadmap: V032 reviewer authentication and jurisdiction-scoped authorization.
--
-- Application sessions continue to belong to pseudonymous participants. A
-- staff role is a separate, server-side grant looked up *after* the session is
-- validated. This means a request cannot become a reviewer by posting a role
-- or jurisdiction, and disabling one staff account takes effect for every
-- outstanding session on the next request.

CREATE TABLE staff_account (
    staff_id        uuid        NOT NULL PRIMARY KEY,
    participant_id  uuid        NOT NULL UNIQUE REFERENCES participant (participant_id),
    role            text        NOT NULL,
    account_state   text        NOT NULL DEFAULT 'active',
    provider_mode   text        NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    disabled_at     timestamptz,

    CONSTRAINT staff_account_role_ck CHECK (role IN
        ('reviewer','department_staff','supervisor','administrator')),
    CONSTRAINT staff_account_state_ck CHECK (account_state IN ('active','disabled')),
    CONSTRAINT staff_account_provider_mode_ck CHECK (provider_mode IN ('simulated','real')),
    CONSTRAINT staff_account_disabled_ck CHECK (
        (account_state = 'disabled') = (disabled_at IS NOT NULL)
    )
);

CREATE TABLE staff_jurisdiction_grant (
    staff_id        uuid        NOT NULL REFERENCES staff_account (staff_id),
    jurisdiction_id uuid        NOT NULL REFERENCES jurisdiction (jurisdiction_id),
    granted_at      timestamptz NOT NULL DEFAULT now(),
    revoked_at      timestamptz,
    PRIMARY KEY (staff_id, jurisdiction_id)
);

CREATE INDEX staff_jurisdiction_active_idx
    ON staff_jurisdiction_grant (jurisdiction_id, staff_id)
    WHERE revoked_at IS NULL;

COMMENT ON TABLE staff_account IS
    'Server-side role grants resolved from a validated application session. The client never supplies a role or staff id.';

COMMENT ON TABLE staff_jurisdiction_grant IS
    'Effective jurisdiction scope for a staff account. Revocation is retained rather than deleting the grant history.';
