-- 0023_staff_department_grants.sql
-- Roadmap: V034 authenticated, department-scoped staff triage.
--
-- A jurisdiction grant alone is not enough for a department inbox: without
-- this second scope, a staff member could change `department_id` in a request
-- and read or mutate another department's queue in the same jurisdiction.
-- The pair is durable, server-side and resolved only after session validation.

CREATE TABLE staff_department_grant (
    staff_id        uuid        NOT NULL REFERENCES staff_account (staff_id),
    jurisdiction_id uuid        NOT NULL REFERENCES jurisdiction (jurisdiction_id),
    department_id   text        NOT NULL,
    granted_at      timestamptz NOT NULL DEFAULT now(),
    revoked_at      timestamptz,
    PRIMARY KEY (staff_id, jurisdiction_id, department_id)
);

CREATE INDEX staff_department_active_idx
    ON staff_department_grant (jurisdiction_id, department_id, staff_id)
    WHERE revoked_at IS NULL;

COMMENT ON TABLE staff_department_grant IS
    'Server-side V034 responsibility scope. A department staff session may open or act on only these exact jurisdiction and department pairs.';
