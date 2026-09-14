-- 0005_reference_data.sql
-- Roadmap: V012 — source lineage, jurisdictions and assets.

-- Provenance for every imported row (V003 SourceRecord, V004 §5).
CREATE TABLE source_record (
    source_record_id            uuid        NOT NULL PRIMARY KEY,
    source_name                 text        NOT NULL,
    source_url_or_location      text        NOT NULL,
    -- Ingestion time and source-declared effective time are separate.
    retrieved_at                timestamptz NOT NULL,
    source_effective_at         timestamptz,
    licence_or_permission_status text       NOT NULL,
    demo_status                 text        NOT NULL,
    raw_snapshot                jsonb,
    current_version             integer     NOT NULL DEFAULT 1,

    CONSTRAINT source_record_licence_ck CHECK (licence_or_permission_status IN
        ('permitted','synthetic','consented','reference_only','unavailable','verification_pending')),
    CONSTRAINT source_record_demo_status_ck CHECK (demo_status IN
        ('permitted_source_data','team_created_synthetic','consented_evaluation_data',
         'unavailable_not_approved')),
    -- Reference-only / unavailable / pending material must not carry a
    -- snapshot: the database refuses to hold data we may not reuse.
    CONSTRAINT source_record_no_snapshot_when_unusable_ck CHECK (
        licence_or_permission_status NOT IN ('reference_only','unavailable','verification_pending')
        OR raw_snapshot IS NULL
    ),
    -- Reference-only and unavailable always map to unavailable_not_approved.
    CONSTRAINT source_record_demo_status_consistency_ck CHECK (
        licence_or_permission_status NOT IN ('reference_only','unavailable')
        OR demo_status = 'unavailable_not_approved'
    )
);

-- Effective-dated node in a configurable hierarchy (V003 Jurisdiction).
CREATE TABLE jurisdiction (
    jurisdiction_id         uuid        NOT NULL PRIMARY KEY,
    jurisdiction_profile_id text        NOT NULL,
    parent_jurisdiction_id  uuid        REFERENCES jurisdiction (jurisdiction_id),
    internal_code           text        NOT NULL,
    external_source_code    text,
    directory_version       text        NOT NULL,
    level_scheme            text        NOT NULL,
    level_code              text        NOT NULL,
    boundary                geography(MultiPolygon, 4326),
    effective_from          timestamptz NOT NULL,
    effective_to            timestamptz,
    source_record_id        uuid        REFERENCES source_record (source_record_id),
    synthetic_provenance    boolean     NOT NULL,

    CONSTRAINT jurisdiction_no_self_parent_ck CHECK (parent_jurisdiction_id <> jurisdiction_id),
    CONSTRAINT jurisdiction_effective_range_ck
        CHECK (effective_to IS NULL OR effective_to > effective_from),
    -- Either a real source record or an explicit synthetic label (V003).
    CONSTRAINT jurisdiction_provenance_required_ck
        CHECK (synthetic_provenance OR source_record_id IS NOT NULL),
    -- An external identifier requires a real source record behind it (V004 §5).
    CONSTRAINT jurisdiction_external_code_needs_source_ck
        CHECK (external_source_code IS NULL OR source_record_id IS NOT NULL)
);

CREATE UNIQUE INDEX jurisdiction_profile_code_version_uniq
    ON jurisdiction (jurisdiction_profile_id, internal_code, directory_version);
CREATE INDEX jurisdiction_parent_idx ON jurisdiction (parent_jurisdiction_id);
CREATE INDEX jurisdiction_boundary_gix ON jurisdiction USING GIST (boundary);

CREATE TABLE infrastructure_asset (
    asset_id            text        NOT NULL PRIMARY KEY,
    asset_type          text        NOT NULL,
    source_record_id    uuid        REFERENCES source_record (source_record_id),
    synthetic_provenance boolean    NOT NULL,
    name                text        NOT NULL,
    location            geography(Point, 4326) NOT NULL,
    jurisdiction_id     uuid        NOT NULL REFERENCES jurisdiction (jurisdiction_id),
    effective_from      timestamptz NOT NULL,
    effective_to        timestamptz,
    current_version     integer     NOT NULL DEFAULT 1,

    CONSTRAINT infrastructure_asset_provenance_required_ck
        CHECK (synthetic_provenance OR source_record_id IS NOT NULL),
    CONSTRAINT infrastructure_asset_effective_range_ck
        CHECK (effective_to IS NULL OR effective_to > effective_from),
    CONSTRAINT infrastructure_asset_version_ck CHECK (current_version >= 1)
);

-- Index-aware proximity queries need this (V006); ST_DWithin on geography
-- measures metres.
CREATE INDEX infrastructure_asset_location_gix ON infrastructure_asset USING GIST (location);
CREATE INDEX infrastructure_asset_jurisdiction_idx ON infrastructure_asset (jurisdiction_id);

-- Responsibility directory: which department owns a category in a
-- jurisdiction, as of a directory version (V033 consumes this).
CREATE TABLE responsibility_directory (
    responsibility_id   uuid        NOT NULL PRIMARY KEY,
    directory_version   text        NOT NULL,
    jurisdiction_id     uuid        NOT NULL REFERENCES jurisdiction (jurisdiction_id),
    category            text        NOT NULL,
    department_id       text        NOT NULL,
    department_label    text        NOT NULL,
    provider_mode       text        NOT NULL,
    effective_from      timestamptz NOT NULL,
    effective_to        timestamptz,

    CONSTRAINT responsibility_directory_mode_ck CHECK (provider_mode IN ('simulated','real')),
    CONSTRAINT responsibility_directory_range_ck
        CHECK (effective_to IS NULL OR effective_to > effective_from)
);

CREATE UNIQUE INDEX responsibility_directory_active_uniq
    ON responsibility_directory (directory_version, jurisdiction_id, category)
    WHERE effective_to IS NULL;
