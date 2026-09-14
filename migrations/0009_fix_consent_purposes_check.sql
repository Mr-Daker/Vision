-- 0009_fix_consent_purposes_check.sql
-- Roadmap: V012 correction, found by the V014 real-database tests.
--
-- BUG: `array_length(granted_purposes, 1) >= 1` does NOT reject an empty
-- array. `array_length('{}'::text[], 1)` returns NULL, and a CHECK constraint
-- passes when its expression is NULL — so a consent record with zero granted
-- purposes was accepted, contradicting V003's `minimum_items: 1`.
--
-- Forward-only: the faulty constraint is replaced by a new one here rather
-- than by editing 0004, which has already been applied.

ALTER TABLE consent_record
    DROP CONSTRAINT consent_record_purposes_nonempty_ck;

ALTER TABLE consent_record
    ADD CONSTRAINT consent_record_purposes_nonempty_ck
    CHECK (coalesce(array_length(granted_purposes, 1), 0) >= 1);

COMMENT ON CONSTRAINT consent_record_purposes_nonempty_ck ON consent_record IS
    'coalesce is required: array_length of an empty array is NULL, and a NULL CHECK passes.';
