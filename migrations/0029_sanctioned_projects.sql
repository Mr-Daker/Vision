-- 0029_sanctioned_projects.sql
-- Roadmap: V041 — link issues to sanctioned projects with reviewable evidence.
--
-- One new table and four columns on the existing `project_link`.
--
-- `sanctioned_project` holds the register itself: what was funded, where, for
-- which asset, between which dates, and — mandatory — which source record it
-- came from. V004 §5 approves no real funding dataset, so everything loaded is
-- team-created synthetic and `synthetic_provenance` is derived from the source
-- rather than asserted beside it. Whether public infrastructure has been paid
-- for is the most politically loaded thing this system could appear to say,
-- and it is the one it is least equipped to; a project record with no source
-- behind it must therefore be unstorable.
--
-- `project_link` gains the state V041 names and 0007 did not have:
--
--   * **`unmatched`** — the register was searched for this report and held no
--     matching record. This is a *recorded finding*, not an absent row, and
--     that distinction is the whole task: an absent row is indistinguishable
--     from "nobody has looked yet", and a reader who cannot tell them apart
--     will read either as "this was never funded". The row carries the
--     register that was searched and the matcher version that searched it.
--
--   * `project_id`, so a link names the project rather than only the dataset
--     it came from. `source_project_id` stays as the lineage pointer to the
--     source record and stays NOT NULL, including on an `unmatched` row —
--     "we searched *this* register and found nothing" is the finding.
--
--   * `match_method` and `matcher_version`, so a link can be re-derived and a
--     rule change is visible in the record rather than only in the code. The
--     reasons in words go in the existing `match_basis` jsonb.
--
-- Deliberately NOT in this migration: any column expressing confidence as a
-- number. A percentage beside a funding claim would be read as a probability
-- somebody calibrated, and nothing here is calibrated. The record carries the
-- methods that fired and the reasons in words, and a person decides.

CREATE TABLE sanctioned_project (
    project_id          text        NOT NULL PRIMARY KEY,
    project_name        text        NOT NULL,
    -- Free-text scope, plus the normalised terms the matcher compares.
    scope_description   text        NOT NULL,
    scope_terms         text[]      NOT NULL DEFAULT '{}',
    asset_id            text        REFERENCES infrastructure_asset (asset_id),
    jurisdiction_id     uuid        REFERENCES jurisdiction (jurisdiction_id),
    location            geography(Point, 4326),
    sanctioned_at       timestamptz NOT NULL,
    completed_at        timestamptz,
    amount              numeric,
    amount_unit         text,
    -- Mandatory. A funding record with no source behind it is a rumour about
    -- public money.
    source_record_id    uuid        NOT NULL REFERENCES source_record (source_record_id),
    synthetic_provenance boolean    NOT NULL,
    loaded_at           timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT sanctioned_project_dates_ck
        CHECK (completed_at IS NULL OR completed_at >= sanctioned_at),
    -- An amount without a unit is a number nobody can read, and a unit without
    -- an amount is a label on nothing.
    CONSTRAINT sanctioned_project_amount_pairs_ck
        CHECK ((amount IS NULL) = (amount_unit IS NULL)),
    CONSTRAINT sanctioned_project_amount_non_negative_ck CHECK (amount IS NULL OR amount >= 0)
);

CREATE INDEX sanctioned_project_asset_idx ON sanctioned_project (asset_id) WHERE asset_id IS NOT NULL;
CREATE INDEX sanctioned_project_jurisdiction_idx ON sanctioned_project (jurisdiction_id);

ALTER TABLE project_link
    ADD COLUMN project_id text REFERENCES sanctioned_project (project_id),
    ADD COLUMN match_method text,
    ADD COLUMN matcher_version text;

-- 0007 allowed four states. `unmatched` is the fifth and the one V041 turns on.
ALTER TABLE project_link DROP CONSTRAINT project_link_status_ck;
ALTER TABLE project_link
    ADD CONSTRAINT project_link_status_ck CHECK (match_status IN
        ('proposed','confirmed','rejected','ambiguous','unmatched'));

-- A link names a project; a recorded no-match names none, by construction.
ALTER TABLE project_link
    ADD CONSTRAINT project_link_project_presence_ck CHECK (
        (match_status = 'unmatched' AND project_id IS NULL)
        OR (match_status <> 'unmatched' AND project_id IS NOT NULL)
    );

-- 0007 required a decision time for anything that was not `proposed`. Two of
-- the states below are matcher output rather than decisions: `ambiguous` means
-- the matcher could not separate two candidates, and `unmatched` means it
-- found none. Demanding a decision time on either would have forced the
-- importer to invent one, and an invented decision time is how a machine's
-- output later reads as a person's judgement.
ALTER TABLE project_link DROP CONSTRAINT project_link_decided_ck;
ALTER TABLE project_link
    ADD CONSTRAINT project_link_decided_ck CHECK (
        match_status IN ('proposed','ambiguous','unmatched') OR decided_at IS NOT NULL
    );

-- The two states that ARE decisions must name who made them. Linking a
-- citizen's report to a public spending record is a claim with a name against
-- it, and the name has to be a person's.
ALTER TABLE project_link
    ADD CONSTRAINT project_link_reviewer_required_ck CHECK (
        match_status IN ('proposed','ambiguous','unmatched') OR reviewer_id IS NOT NULL
    );

-- One live row per (issue, project), so re-running the matcher cannot stack
-- duplicate proposals against the same pair.
CREATE UNIQUE INDEX project_link_one_per_issue_project_uniq
    ON project_link (issue_id, project_id)
    WHERE issue_id IS NOT NULL AND project_id IS NOT NULL;

-- And one recorded no-match per issue, for the same reason.
CREATE UNIQUE INDEX project_link_one_unmatched_per_issue_uniq
    ON project_link (issue_id)
    WHERE match_status = 'unmatched';

COMMENT ON COLUMN project_link.match_status IS
    'proposed, ambiguous and unmatched are matcher output; confirmed and rejected are reviewer decisions. An unmatched row means the register was searched and held nothing — never that the asset was not funded (V041).';

COMMENT ON COLUMN project_link.match_basis IS
    'The methods that fired and the reasons in words, plus the absence note. Deliberately not a confidence number: a percentage beside a funding claim reads as a probability somebody calibrated, and nothing here is calibrated.';
