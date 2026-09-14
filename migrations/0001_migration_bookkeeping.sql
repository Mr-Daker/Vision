-- 0001_migration_bookkeeping.sql
-- Roadmap: V007 (workspace). Establishes ONLY the migration bookkeeping table.
--
-- No domain table is created here. The V003 domain contract becomes schema at
-- V012, and V013 verifies extensions and forward migration on the selected
-- PostgreSQL version. Creating domain tables now would freeze the schema before
-- its invariants are reviewed.
--
-- Forward-only: never edit an applied migration; add a new one.

CREATE TABLE IF NOT EXISTS schema_migrations (
    sequence     text        NOT NULL PRIMARY KEY,
    filename     text        NOT NULL UNIQUE,
    checksum     text        NOT NULL,
    applied_at   timestamptz NOT NULL DEFAULT now(),
    applied_by   text        NOT NULL DEFAULT current_user
);

COMMENT ON TABLE schema_migrations IS
    'Applied migration ledger. Checksum detects an edited migration (V007).';
