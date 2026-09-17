-- 0026_summary_projection.sql
-- Roadmap: V038 — replayable regional and category summaries.
--
-- Four tables, and one rule each that the database enforces rather than the
-- application.
--
--   * `summary_issue_fact` holds one row per canonical issue: the cell it
--     belongs to and the state it is in. It stores **state, not deltas**, and
--     `issue_id` is its primary key. Projecting an issue is an upsert, so
--     replaying the same event writes the same row and the totals do not move.
--     That is the V038 acceptance clause "retries cannot increase counts",
--     enforced by a key rather than defended by dedup logic that has to be
--     right every time.
--
--   * `summary_cell` is the aggregate a dashboard reads. `jurisdiction_key` is
--     text rather than a nullable uuid so that "we do not know where this is"
--     is a visible row called UNKNOWN instead of a row that quietly does not
--     exist. Zero and missing must not render the same (V037 M15).
--
--   * `summary_watermark` records how far the incremental projection has read,
--     ordered by `recorded_at` — ingestion order, not event order. A backdated
--     event carries an `occurred_at` in the past and would sit behind a cursor
--     that advanced on event time, so it would never be projected at all.
--
--   * `summary_applied_event` makes "this event has been projected" a primary
--     key. Two concurrent projection passes claiming the same event is the
--     ordinary case under retry, and a check-then-insert in application code
--     is not a defence against it.
--
-- Deliberately NOT in this migration: any counter column that is incremented.
-- Every number here is derived by aggregation from `summary_issue_fact`, which
-- is why a merge reversal needs no compensating write — the next recompute
-- simply sees an issue that is its own root again.

CREATE TABLE summary_issue_fact (
    summary_name        text        NOT NULL,
    issue_id            uuid        NOT NULL REFERENCES canonical_issue (issue_id),
    -- The canonical root at projection time. Equal to `issue_id` for a root.
    root_issue_id       uuid        NOT NULL REFERENCES canonical_issue (issue_id),
    -- True when an active alias points away from this issue: it is the same
    -- report as another one and must be counted in no cell.
    retired_by_merge    boolean     NOT NULL,
    -- 'UNKNOWN' where the issue has no jurisdiction. Never null.
    jurisdiction_key    text        NOT NULL,
    boundary_version    text,
    category            text        NOT NULL,
    state               text        NOT NULL,
    counted_participants integer    NOT NULL,
    active_evidence_links integer   NOT NULL,
    opened_at           timestamptz NOT NULL,
    -- The event that last caused this row to be recomputed. Null after a full
    -- rebuild, which is driven by authoritative state rather than by an event.
    source_event_id     uuid        REFERENCES status_event (event_id),
    projected_at        timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT summary_issue_fact_pk PRIMARY KEY (summary_name, issue_id),
    CONSTRAINT summary_issue_fact_state_ck CHECK (state IN
        ('open','claimed','disputed','confirmed','reopened','unknown')),
    CONSTRAINT summary_issue_fact_counts_ck
        CHECK (counted_participants >= 0 AND active_evidence_links >= 0),
    -- A retired issue belongs to another issue's root, and a live one is its
    -- own or a survivor's. Both directions are wrong to invert, and inverting
    -- them is exactly how a merged report gets counted twice.
    CONSTRAINT summary_issue_fact_retired_ck
        CHECK (retired_by_merge = (root_issue_id <> issue_id))
);

CREATE INDEX summary_issue_fact_cell_idx
    ON summary_issue_fact (summary_name, jurisdiction_key, category);
CREATE INDEX summary_issue_fact_root_idx ON summary_issue_fact (summary_name, root_issue_id);

CREATE TABLE summary_cell (
    summary_name        text        NOT NULL,
    jurisdiction_key    text        NOT NULL,
    category            text        NOT NULL,
    boundary_version    text,
    issue_count         integer     NOT NULL DEFAULT 0,
    open_count          integer     NOT NULL DEFAULT 0,
    claimed_count       integer     NOT NULL DEFAULT 0,
    disputed_count      integer     NOT NULL DEFAULT 0,
    confirmed_count     integer     NOT NULL DEFAULT 0,
    reopened_count      integer     NOT NULL DEFAULT 0,
    unknown_state_count integer     NOT NULL DEFAULT 0,
    -- Distinct people within this cell. NOT summable across cells: the same
    -- person can report in two wards, and two cells of nine are not eighteen
    -- people. `rollUpCells` refuses to add this column (V037 M12).
    counted_participants integer    NOT NULL DEFAULT 0,
    active_evidence_links integer   NOT NULL DEFAULT 0,
    refreshed_at        timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT summary_cell_pk PRIMARY KEY (summary_name, jurisdiction_key, category),
    CONSTRAINT summary_cell_counts_ck CHECK (
        issue_count >= 0 AND open_count >= 0 AND claimed_count >= 0
        AND disputed_count >= 0 AND confirmed_count >= 0 AND reopened_count >= 0
        AND unknown_state_count >= 0 AND counted_participants >= 0
        AND active_evidence_links >= 0
    ),
    -- The states must partition the issues. A cell where they do not is a
    -- projection bug, and finding it at write time is the difference between
    -- a failed refresh and a dashboard that is quietly wrong.
    CONSTRAINT summary_cell_partition_ck CHECK (
        issue_count = open_count + claimed_count + disputed_count
                    + confirmed_count + reopened_count + unknown_state_count
    )
);

COMMENT ON COLUMN summary_cell.counted_participants IS
    'Distinct counted demo participants within this cell. Never sum this column across cells (V037 M12, V038).';

CREATE TABLE summary_watermark (
    summary_name        text        NOT NULL PRIMARY KEY,
    -- Ingestion order, not event order: a backdated event has an older
    -- occurred_at and would sit behind an event-time cursor forever.
    last_recorded_at    timestamptz,
    last_event_id       uuid        REFERENCES status_event (event_id),
    last_refreshed_at   timestamptz,
    last_rebuild_at     timestamptz,
    events_applied      bigint      NOT NULL DEFAULT 0,
    issues_projected    bigint      NOT NULL DEFAULT 0,

    CONSTRAINT summary_watermark_counts_ck
        CHECK (events_applied >= 0 AND issues_projected >= 0)
);

CREATE TABLE summary_applied_event (
    summary_name        text        NOT NULL,
    event_id            uuid        NOT NULL REFERENCES status_event (event_id),
    applied_at          timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT summary_applied_event_pk PRIMARY KEY (summary_name, event_id)
);

CREATE TABLE summary_reconciliation (
    run_id              uuid        NOT NULL PRIMARY KEY,
    -- Insertion order. `ran_at` alone cannot order two runs in the same
    -- transaction or the same millisecond, and "which verdict is the current
    -- one" is exactly the question a stale-summary banner has to answer.
    run_seq             bigserial   NOT NULL,
    summary_name        text        NOT NULL,
    ran_at              timestamptz NOT NULL DEFAULT now(),
    checked_facts       integer     NOT NULL,
    mismatched_facts    integer     NOT NULL,
    checked_cells       integer     NOT NULL,
    mismatched_cells    integer     NOT NULL,
    -- What differed, not merely that something did. A reconciliation failure
    -- nobody can investigate gets silenced rather than fixed.
    differences         jsonb       NOT NULL DEFAULT '[]'::jsonb,
    reconciled          boolean     NOT NULL,

    CONSTRAINT summary_reconciliation_counts_ck CHECK (
        checked_facts >= 0 AND mismatched_facts >= 0
        AND checked_cells >= 0 AND mismatched_cells >= 0
    ),
    CONSTRAINT summary_reconciliation_verdict_ck
        CHECK (reconciled = (mismatched_facts = 0 AND mismatched_cells = 0))
);

CREATE INDEX summary_reconciliation_recent_idx
    ON summary_reconciliation (summary_name, run_seq DESC);
