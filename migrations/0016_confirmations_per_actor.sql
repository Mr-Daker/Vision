-- 0016_confirmations_per_actor.sql
-- Roadmap: fixes the V035 defect that a category requiring two confirmations
-- could never be closed.
--
-- 0008 declared `claim_id UNIQUE` with the comment "one confirmation per
-- claim". The confirmation policy pack, however, requires **two** for a safety
-- category (electrical, structural), on the reasoning that one neighbour
-- agreeing is not enough to call a dangerous repair done. Those two rules
-- contradict each other, and the database won: the second confirmation was
-- rejected, the issue stayed in `resolution_claimed` forever, and the person
-- who confirmed was told nothing had happened.
--
-- That is not a stricter bar. It is a broken one — a bar nobody can clear
-- fails closed in a way that looks like the system ignoring people.
--
-- The rule that replaces it is per *actor*:
--
--   * one confirmation per participant per claim, so "two confirmations"
--     cannot be satisfied by one person answering twice;
--   * at most one reviewer decision per claim, so a reviewer cannot leave two
--     contradictory decisions on record with nothing saying which stands.
--
-- Forward-only: 0008's constraint is replaced rather than edited.

ALTER TABLE resolution_confirmation
    DROP CONSTRAINT resolution_confirmation_claim_id_key;

-- One answer per person per claim. `responding_participant_id` is NULL on a
-- reviewer row and NULLs are distinct in PostgreSQL, so this constrains
-- participants only — reviewers are covered by the partial index below.
ALTER TABLE resolution_confirmation
    ADD CONSTRAINT resolution_confirmation_one_per_participant_uniq
        UNIQUE (claim_id, responding_participant_id);

-- At most one reviewer decision per claim.
CREATE UNIQUE INDEX resolution_confirmation_one_reviewer_per_claim_uniq
    ON resolution_confirmation (claim_id)
    WHERE reviewer_id IS NOT NULL;

COMMENT ON COLUMN resolution_confirmation.claim_id IS
    'The claim being answered. No longer unique: a category may require more than one confirmation, and each must come from a different person (V035).';
