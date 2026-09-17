-- 0027_summary_watermark_event_retention.sql
-- Roadmap: V038/V039 — projection bookkeeping must not pin the event ledger.
--
-- 0026 gave `summary_watermark.last_event_id` and `summary_applied_event.event_id`
-- plain foreign keys to `status_event`. Both were wrong in the same way: they
-- made a *record of having read an event* a reason the event itself can never
-- be removed. V005 retention will eventually prune the ledger, and a projection
-- that has already consumed an event has no claim on keeping it — the numbers
-- were derived long ago and do not become unsupported when the source row ages
-- out.
--
-- The two are fixed differently because they mean different things:
--
--   * `summary_watermark.last_event_id` is a human-readable marker of how far
--     the projection had read. It is informational, so the reference is dropped
--     and the column keeps whatever identifier it last held.
--
--   * `summary_applied_event.event_id` is the dedup claim. If the event is gone
--     the claim is meaningless rather than merely stale, so it cascades: no row
--     is left asserting that something which no longer exists was applied.
--
-- Found by a V039 test that deleted a fixture event and was refused. A
-- constraint that only breaks during retention would have been found in
-- production instead.

ALTER TABLE summary_watermark
    DROP CONSTRAINT summary_watermark_last_event_id_fkey;

COMMENT ON COLUMN summary_watermark.last_event_id IS
    'The last event this projection read, for reading by a human. Deliberately not a foreign key: a consumed event may be pruned by retention without invalidating the numbers derived from it.';

ALTER TABLE summary_applied_event
    DROP CONSTRAINT summary_applied_event_event_id_fkey;

ALTER TABLE summary_applied_event
    ADD CONSTRAINT summary_applied_event_event_id_fkey
        FOREIGN KEY (event_id) REFERENCES status_event (event_id) ON DELETE CASCADE;
