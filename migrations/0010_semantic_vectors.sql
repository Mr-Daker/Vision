-- 0010_semantic_vectors.sql
-- Roadmap: V026 (candidate retrieval), consuming the V023 embedding adapter.
--
-- 0002 enabled pgvector but deliberately created no embedding column, because
-- no embedding provider existed and a column whose width is a guess is worse
-- than none. V023 has now measured the provider: `gemini-embedding-001`
-- returns 3072 dimensions, already unit length.
--
-- WHY THERE IS NO VECTOR INDEX. pgvector's `ivfflat` and `hnsw` index types
-- cap at 2000 dimensions, and 3072 exceeds that. Rather than reduce the
-- vector's width to fit an index, this follows the V026 instruction directly:
-- "use exact vector reranking over bounded candidates initially". The spatial
-- index does the pruning, and the vector comparison runs exactly over the
-- small candidate set that survives. That is more accurate than an
-- approximate index, and it is honest about scale — V069 is where growth is
-- benchmarked and an index strategy chosen against measured data.
--
-- The model and dimension count are stored per row, so a provider or width
-- change cannot silently make old and new vectors comparable.

CREATE TABLE submission_embedding (
    submission_id       uuid        NOT NULL PRIMARY KEY
                                    REFERENCES submission (submission_id) ON DELETE CASCADE,
    -- 3072 matches gemini-embedding-001 as measured at V023. A row whose
    -- model or dimension count differs must not be compared with these.
    embedding           vector(3072) NOT NULL,
    model_name          text        NOT NULL,
    dimensions          integer     NOT NULL,
    -- True when the provider returned unit length, so a caller doing cosine
    -- work knows whether normalisation already happened.
    normalized          boolean     NOT NULL,
    -- Hash of the exact text embedded, so a stale vector is detectable after
    -- a correction changes the text (V024 correction path).
    input_hash          text        NOT NULL,
    embedded_at         timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT submission_embedding_dimensions_ck CHECK (dimensions = 3072),
    CONSTRAINT submission_embedding_model_nonempty_ck CHECK (length(model_name) > 0),
    CONSTRAINT submission_embedding_hash_nonempty_ck CHECK (length(input_hash) > 0)
);

COMMENT ON TABLE submission_embedding IS
    'Semantic vectors for candidate reranking (V026). Deliberately unindexed: 3072 dimensions exceed the pgvector index limit, and V026 specifies exact reranking over spatially bounded candidates.';

-- Retrieval diagnostics, retained as V026 requires. Without these an empty
-- candidate list is indistinguishable from a query that never ran, and V026
-- forbids reading an empty approximate result as proof that no candidate
-- exists.
CREATE TABLE candidate_query_log (
    query_id            uuid        NOT NULL PRIMARY KEY,
    submission_id       uuid        NOT NULL REFERENCES submission (submission_id),
    -- What was actually searched, so a result can be re-derived.
    radius_metres       double precision NOT NULL,
    accuracy_metres     double precision,
    time_window_hours   integer     NOT NULL,
    asset_id            text,
    category            text,
    spatial_candidates  integer     NOT NULL,
    reranked_candidates integer     NOT NULL,
    -- False when a bound (row cap) was hit, so the search was not exhaustive
    -- and absence proves nothing.
    exhaustive          boolean     NOT NULL,
    duration_ms         integer     NOT NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT candidate_query_log_radius_ck CHECK (radius_metres > 0),
    CONSTRAINT candidate_query_log_window_ck CHECK (time_window_hours > 0),
    CONSTRAINT candidate_query_log_counts_ck
        CHECK (spatial_candidates >= 0 AND reranked_candidates >= 0
               AND reranked_candidates <= spatial_candidates)
);

CREATE INDEX candidate_query_log_submission_idx
    ON candidate_query_log (submission_id, created_at DESC);

-- Issues need a location to be found near one. Denormalised from the
-- submission that opened the issue and maintained as evidence accrues, so a
-- candidate search does not have to join through every submission.
ALTER TABLE canonical_issue
    ADD COLUMN representative_location geography(Point, 4326),
    ADD COLUMN representative_accuracy_m double precision,
    ADD COLUMN last_evidence_at timestamptz;

ALTER TABLE canonical_issue
    ADD CONSTRAINT canonical_issue_representative_accuracy_ck
        CHECK (representative_accuracy_m IS NULL OR representative_accuracy_m >= 0);

CREATE INDEX canonical_issue_location_gix
    ON canonical_issue USING GIST (representative_location);

CREATE INDEX canonical_issue_category_opened_idx
    ON canonical_issue (category, opened_at DESC);
