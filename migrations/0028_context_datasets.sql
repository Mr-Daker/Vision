-- 0028_context_datasets.sql
-- Roadmap: V040 — scoped contextual data with lineage.
--
-- Population, enrolment, access and investment figures, and the record of
-- every row that was refused on the way in.
--
-- Four tables, and one rule each the database enforces rather than the
-- application:
--
--   * `context_dataset` cannot exist without a `source_record`. The column is
--     NOT NULL, so there is no path by which a figure reaches a screen with
--     nothing behind it. V004's downgrade rule says no external dataset is
--     approved for ingestion, so everything loaded today is team-created
--     synthetic — and `synthetic_provenance` is derived from the source rather
--     than asserted alongside it.
--
--   * `context_observation` has a value or a missing-data indicator, never
--     both and never neither. Substituting `0` for "this ward was never
--     surveyed" is the failure this constraint exists to make impossible:
--     a NULL value without a reason cannot be stored at all.
--
--   * `context_import_rejection` persists **why** a row was refused. The V040
--     acceptance clause is that invalid units, stale records and unmatched
--     assets are reported rather than converted into plausible values, and a
--     rejection that only ever existed in a log line is not reportable after
--     the fact.
--
--   * `context_import_run` records the counts, so "how much of this file
--     actually loaded" is answerable without re-reading the file.
--
-- Deliberately NOT in this migration: any column holding a converted value, a
-- conversion factor, or a second unit. There is no unit conversion in this
-- system. A row whose unit disagrees with its dataset is refused, because the
-- factor that would reconcile them is an invention and an invented factor is
-- indistinguishable from a correct one once the number is on a screen.

CREATE TABLE context_dataset (
    dataset_id          text        NOT NULL PRIMARY KEY,
    kind                text        NOT NULL,
    unit                text        NOT NULL,
    label               text        NOT NULL,
    -- Mandatory. A context figure with no source is a rumour with a number
    -- attached, and this column is why one cannot be stored.
    source_record_id    uuid        NOT NULL REFERENCES source_record (source_record_id),
    synthetic_provenance boolean    NOT NULL,
    -- How old a vintage may be before a reader is told the figure is stale.
    max_age_days        integer     NOT NULL,
    jurisdiction_profile_id text    NOT NULL,
    loaded_at           timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT context_dataset_kind_ck CHECK (kind IN
        ('population','enrolment','access','investment')),
    -- The unit vocabulary, closed per kind. A fifth unit is a decision about
    -- what this product claims to know, not a configuration value.
    CONSTRAINT context_dataset_unit_ck CHECK (
        (kind = 'population' AND unit = 'persons')
        OR (kind = 'enrolment' AND unit = 'students')
        OR (kind = 'access' AND unit = 'percent_of_households')
        OR (kind = 'investment' AND unit = 'inr')
    ),
    CONSTRAINT context_dataset_max_age_ck CHECK (max_age_days > 0)
);

COMMENT ON COLUMN context_dataset.synthetic_provenance IS
    'True when the backing source is team-created synthetic data. Every value from this dataset must say so on screen before its number is discussed (V040).';

CREATE TABLE context_observation (
    observation_id      uuid        NOT NULL PRIMARY KEY,
    dataset_id          text        NOT NULL REFERENCES context_dataset (dataset_id),
    subject_kind        text        NOT NULL,
    jurisdiction_id     uuid        REFERENCES jurisdiction (jurisdiction_id),
    asset_id            text        REFERENCES infrastructure_asset (asset_id),
    -- Null exactly when the source said it did not know.
    value               numeric,
    -- The indicator the file used, kept verbatim so a reader sees the source's
    -- own words rather than this system's paraphrase of them.
    missing_indicator   text,
    unit                text        NOT NULL,
    -- When the source says the figure was true. Separate from `loaded_at`.
    vintage             timestamptz NOT NULL,
    loaded_at           timestamptz NOT NULL DEFAULT now(),
    raw                 jsonb       NOT NULL DEFAULT '{}'::jsonb,

    CONSTRAINT context_observation_subject_kind_ck CHECK (subject_kind IN ('jurisdiction','asset')),
    -- Exactly one subject, matching its declared kind.
    CONSTRAINT context_observation_one_subject_ck CHECK (
        (subject_kind = 'jurisdiction' AND jurisdiction_id IS NOT NULL AND asset_id IS NULL)
        OR (subject_kind = 'asset' AND asset_id IS NOT NULL AND jurisdiction_id IS NULL)
    ),
    -- A value or a reason there is none. Never both, and never neither: an
    -- unexplained NULL is exactly the state that later becomes a zero.
    CONSTRAINT context_observation_value_or_reason_ck
        CHECK ((value IS NULL) <> (missing_indicator IS NULL)),
    CONSTRAINT context_observation_non_negative_ck CHECK (value IS NULL OR value >= 0),
    -- One figure per subject per dataset. Which of two duplicates stands is
    -- not a decision this system may make silently.
    CONSTRAINT context_observation_one_per_subject_uniq
        UNIQUE (dataset_id, subject_kind, jurisdiction_id, asset_id)
);

CREATE INDEX context_observation_jurisdiction_idx
    ON context_observation (jurisdiction_id) WHERE jurisdiction_id IS NOT NULL;
CREATE INDEX context_observation_asset_idx
    ON context_observation (asset_id) WHERE asset_id IS NOT NULL;

CREATE TABLE context_import_run (
    run_id              uuid        NOT NULL PRIMARY KEY,
    dataset_id          text        NOT NULL REFERENCES context_dataset (dataset_id),
    ran_at              timestamptz NOT NULL DEFAULT now(),
    rows_read           integer     NOT NULL,
    rows_loaded         integer     NOT NULL,
    rows_rejected       integer     NOT NULL,

    CONSTRAINT context_import_run_counts_ck CHECK (
        rows_read >= 0 AND rows_loaded >= 0 AND rows_rejected >= 0
        AND rows_read = rows_loaded + rows_rejected
    )
);

CREATE TABLE context_import_rejection (
    rejection_id        uuid        NOT NULL PRIMARY KEY,
    run_id              uuid        NOT NULL REFERENCES context_import_run (run_id)
                                    ON DELETE CASCADE,
    row_index           integer     NOT NULL,
    reason_code         text        NOT NULL,
    detail              text        NOT NULL,
    -- The row exactly as it arrived, so a refusal can be investigated without
    -- the original file.
    raw                 jsonb       NOT NULL DEFAULT '{}'::jsonb,

    CONSTRAINT context_import_rejection_reason_ck CHECK (reason_code IN
        ('source_not_ingestible','unknown_unit','unit_mismatch','unparseable_value',
         'negative_value','share_out_of_range','missing_subject','unmatched_subject',
         'missing_vintage','future_vintage','duplicate_subject')),
    CONSTRAINT context_import_rejection_index_ck CHECK (row_index >= 0)
);

CREATE INDEX context_import_rejection_run_idx ON context_import_rejection (run_id, row_index);
