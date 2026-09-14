-- 0011_issue_representative_embedding.sql
-- Roadmap: V026, completing 0010.
--
-- 0010 added `submission_embedding` — the cache V023 asked for, keyed by the
-- submission whose text was embedded. Retrieval needs something else: a vector
-- on the *issue*, so reranking candidates does not have to join through every
-- submission attached to every candidate.
--
-- Added as its own migration rather than by editing 0010, which has already
-- been applied and whose checksum is recorded (see migrations/README.md).
--
-- This is a denormalised representative copy, exactly like
-- `representative_location` in 0010: the authoritative per-text vectors stay
-- in `submission_embedding`. Both the model and the width are recorded so a
-- vector produced by a different model can never be silently compared with
-- one produced by this model.

ALTER TABLE canonical_issue
    ADD COLUMN representative_embedding vector(3072),
    ADD COLUMN representative_embedding_model text;

ALTER TABLE canonical_issue
    ADD CONSTRAINT canonical_issue_embedding_model_ck
        CHECK ((representative_embedding IS NULL) = (representative_embedding_model IS NULL));

COMMENT ON COLUMN canonical_issue.representative_embedding IS
    'Denormalised vector for exact candidate reranking (V026). Unindexed: 3072 dimensions exceed the pgvector index limit, and V026 specifies exact reranking over spatially bounded candidates.';
