-- 0002_extensions.sql
-- Roadmap: V012. Enables the extensions V006 D4 commits to.
--
-- Verified on this stack rather than assumed (V013): PostGIS 3.6.4 and
-- pgvector 0.8.6 on PostgreSQL 17.11. `node tools/db.mjs verify` re-checks
-- capability with real spatial and vector queries.
--
-- pgvector is enabled now so V013 can verify capability, but NO embedding
-- column is created yet: embedding model, dimensions and normalisation are
-- V023 decisions, and guessing them here would freeze the wrong shape.

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS vector;
