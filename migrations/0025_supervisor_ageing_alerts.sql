-- 0025_supervisor_ageing_alerts.sql
-- Roadmap: V036 — supervisor queues and deterministic ageing alerts.
--
-- Two tables, and one rule each that the database enforces rather than the
-- application:
--
--   * `issue_alert` fires at most once per (issue, rule, window). The V036
--     acceptance clause is "alerts occur once per intended rule window", and a
--     check-then-insert in application code is not that — two concurrent sweeps
--     would both read "no alert yet" and both write one. A UNIQUE constraint is
--     the layer a test can actually distinguish.
--
--   * `issue_ageing_override` is effective-dated rather than mutable. A
--     supervisor shortening the clock on somebody's report is a decision with a
--     name against it, and "who decided this, when, and why" cannot be answered
--     from a row that was overwritten (V003 effective dating).
--
-- Deliberately NOT in this migration: anything resembling delivery. These
-- alerts are internal records. The outbox exists to send things to recipients,
-- and an alert routed through it would be indistinguishable from a
-- notification someone tried to deliver to an official — which V036 forbids
-- and V070 is the task that would earn.

CREATE TABLE issue_alert (
    alert_id        uuid        NOT NULL PRIMARY KEY,
    issue_id        uuid        NOT NULL REFERENCES canonical_issue (issue_id),
    -- Which configured promise passed. Not a severity.
    rule_id         text        NOT NULL,
    -- The start of the window this alert belongs to: the moment the current
    -- department became responsible. A re-route opens a new window, so a newly
    -- responsible department can be alerted about its own delay without the
    -- previous one's alert suppressing it.
    window_start    timestamptz NOT NULL,
    raised_at       timestamptz NOT NULL DEFAULT now(),
    -- The effective, pause-adjusted department age when it fired.
    department_age_days numeric  NOT NULL,
    -- The raw citizen wait at the same moment, recorded so a later reader can
    -- see what a re-route did to the two clocks.
    citizen_age_days    numeric  NOT NULL,
    threshold_days      numeric  NOT NULL,
    -- Where the applied threshold came from, so an alert can be explained.
    rule_source     text        NOT NULL,
    policy_version  text        NOT NULL,
    reasons         jsonb       NOT NULL DEFAULT '[]'::jsonb,
    -- A supervisor marking an alert as seen. Never deletes it.
    acknowledged_at timestamptz,
    acknowledged_by uuid,

    CONSTRAINT issue_alert_rule_ck CHECK (rule_id IN ('overdue','escalated')),
    CONSTRAINT issue_alert_source_ck CHECK (rule_source IN ('override','category','fallback')),
    CONSTRAINT issue_alert_ages_nonneg_ck
        CHECK (department_age_days >= 0 AND citizen_age_days >= 0 AND threshold_days > 0),
    CONSTRAINT issue_alert_ack_pairs_ck
        CHECK ((acknowledged_at IS NULL) = (acknowledged_by IS NULL)),
    -- The whole point: one alert per rule per window.
    CONSTRAINT issue_alert_once_per_window_uniq UNIQUE (issue_id, rule_id, window_start)
);

CREATE INDEX issue_alert_issue_idx ON issue_alert (issue_id);
CREATE INDEX issue_alert_open_idx ON issue_alert (rule_id) WHERE acknowledged_at IS NULL;

CREATE TABLE issue_ageing_override (
    override_id             uuid        NOT NULL PRIMARY KEY,
    issue_id                uuid        NOT NULL REFERENCES canonical_issue (issue_id),
    alert_after_days        numeric     NOT NULL,
    escalate_after_days     numeric     NOT NULL,
    -- Required. A shortened deadline nobody had to justify is exactly the
    -- "policy decision disguised as a field" V034 declined to build.
    reason                  text        NOT NULL,
    supervisor_id           uuid        NOT NULL,
    recorded_at             timestamptz NOT NULL DEFAULT now(),
    superseded_at           timestamptz,
    supersedes_override_id  uuid        REFERENCES issue_ageing_override (override_id),

    CONSTRAINT issue_ageing_override_reason_nonempty_ck
        CHECK (length(btrim(reason)) > 0),
    CONSTRAINT issue_ageing_override_positive_ck
        CHECK (alert_after_days > 0 AND escalate_after_days > alert_after_days)
);

-- At most one override standing per issue at a time. A second live override
-- would leave two different deadlines on record with nothing saying which one
-- the alert used.
CREATE UNIQUE INDEX issue_ageing_override_one_live_uniq
    ON issue_ageing_override (issue_id)
    WHERE superseded_at IS NULL;

COMMENT ON TABLE issue_alert IS
    'Internal ageing alerts (V036). A record that a configured time promise passed, never a severity judgement and never a notification delivered to anyone.';
