-- 0003_events_and_outbox.sql
-- Roadmap: V012 — immutable events, processing stages and outbox rows.
--
-- status_event comes first because merge/alias decisions reference it.

-- Append-only domain history (V003 StatusEvent).
CREATE TABLE status_event (
    event_id                uuid        NOT NULL PRIMARY KEY,
    aggregate_type          text        NOT NULL,
    aggregate_id            text        NOT NULL,
    aggregate_version       integer     NOT NULL,
    event_type              text        NOT NULL,
    actor_type              text        NOT NULL,
    -- Restricted internal pseudonym; never published in a public timeline.
    actor_pseudonym         uuid,
    correlation_id          uuid        NOT NULL,
    -- Event time and ingestion time are separate columns, never one field.
    occurred_at             timestamptz NOT NULL,
    recorded_at             timestamptz NOT NULL DEFAULT now(),
    payload_schema_version  text        NOT NULL,
    payload                 jsonb       NOT NULL DEFAULT '{}'::jsonb,

    CONSTRAINT status_event_actor_type_ck CHECK (actor_type IN
        ('citizen','staff','reviewer','supervisor','administrator','system_worker')),
    CONSTRAINT status_event_version_positive_ck CHECK (aggregate_version >= 1),
    -- Ordering guarantee: one version per aggregate, so a concurrent writer
    -- cannot interleave two events at the same position.
    CONSTRAINT status_event_aggregate_version_uniq
        UNIQUE (aggregate_type, aggregate_id, aggregate_version)
);

COMMENT ON COLUMN status_event.occurred_at IS 'event time (may precede recorded_at for reconciliation)';
COMMENT ON COLUMN status_event.recorded_at IS 'ingestion time';

CREATE INDEX status_event_aggregate_idx ON status_event (aggregate_type, aggregate_id, aggregate_version);
CREATE INDEX status_event_correlation_idx ON status_event (correlation_id);

-- Transactional outbox (V006 §7). A row here is the authoritative record that
-- work is owed; a queue message is only a delivery hint.
CREATE TABLE outbox (
    outbox_id               bigserial   PRIMARY KEY,
    event_id                uuid        NOT NULL REFERENCES status_event (event_id),
    task_type               text        NOT NULL,
    payload                 jsonb       NOT NULL DEFAULT '{}'::jsonb,
    created_at              timestamptz NOT NULL DEFAULT now(),
    not_before              timestamptz NOT NULL DEFAULT now(),
    claimed_at              timestamptz,
    claimed_by              text,
    delivered_at            timestamptz,
    attempts                integer     NOT NULL DEFAULT 0,
    terminal_failure_reason text,

    -- One outbox row per event per task type: a retry of the same domain
    -- transaction cannot enqueue the same work twice.
    CONSTRAINT outbox_event_task_uniq UNIQUE (event_id, task_type),
    CONSTRAINT outbox_attempts_ck CHECK (attempts >= 0),
    CONSTRAINT outbox_terminal_requires_no_delivery_ck
        CHECK (terminal_failure_reason IS NULL OR delivered_at IS NULL)
);

-- Partial index over undelivered work only: the relay never scans history.
CREATE INDEX outbox_pending_idx ON outbox (not_before, outbox_id)
    WHERE delivered_at IS NULL AND terminal_failure_reason IS NULL;
