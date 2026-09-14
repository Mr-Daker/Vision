-- 0021_jurisdiction_resolution.sql
-- Roadmap: V033 — versioned location-to-jurisdiction resolution.
--
-- A jurisdiction on an issue is consequential: it decides which private
-- reviewer queue and responsibility directory may see it. Keep the spatial
-- decision as its own immutable record rather than leaving only the current
-- foreign key on canonical_issue.

CREATE TABLE jurisdiction_resolution (
    resolution_id             uuid        NOT NULL PRIMARY KEY,
    submission_id             uuid        NOT NULL REFERENCES submission (submission_id),
    issue_id                  uuid        REFERENCES canonical_issue (issue_id),
    jurisdiction_profile_id   text        NOT NULL,
    boundary_version          text        NOT NULL,
    method                    text        NOT NULL,
    outcome                   text        NOT NULL,
    selected_jurisdiction_id  uuid        REFERENCES jurisdiction (jurisdiction_id),
    candidate_jurisdiction_ids uuid[]     NOT NULL DEFAULT '{}',
    applied_to_issue          boolean     NOT NULL DEFAULT false,
    reason                    text        NOT NULL,
    synthetic_provenance      boolean     NOT NULL,
    resolved_at               timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT jurisdiction_resolution_method_ck CHECK
        (method = 'point_in_versioned_boundary'),
    CONSTRAINT jurisdiction_resolution_outcome_ck CHECK (outcome IN
        ('resolved','ambiguous','outside_profile','boundary_uncertain','no_active_boundaries')),
    CONSTRAINT jurisdiction_resolution_reason_ck CHECK (length(btrim(reason)) > 0),
    CONSTRAINT jurisdiction_resolution_selected_ck CHECK (
        (outcome = 'resolved') = (selected_jurisdiction_id IS NOT NULL)
    ),
    CONSTRAINT jurisdiction_resolution_applied_ck CHECK (
        NOT applied_to_issue
        OR (outcome = 'resolved' AND issue_id IS NOT NULL)
    )
);

CREATE INDEX jurisdiction_resolution_submission_idx
    ON jurisdiction_resolution (submission_id, resolved_at DESC);
CREATE INDEX jurisdiction_resolution_issue_idx
    ON jurisdiction_resolution (issue_id, resolved_at DESC)
    WHERE issue_id IS NOT NULL;

ALTER TABLE routing_decision
    ADD COLUMN jurisdiction_resolution_id uuid
    REFERENCES jurisdiction_resolution (resolution_id);

CREATE INDEX routing_decision_jurisdiction_resolution_idx
    ON routing_decision (jurisdiction_resolution_id)
    WHERE jurisdiction_resolution_id IS NOT NULL;

-- Candidate retrieval must record the jurisdiction boundary it was scoped to;
-- otherwise a later reader cannot tell whether a cross-boundary candidate was
-- deliberately excluded or never considered.
ALTER TABLE candidate_query_log
    ADD COLUMN jurisdiction_id uuid REFERENCES jurisdiction (jurisdiction_id);

COMMENT ON TABLE jurisdiction_resolution IS
    'Immutable, versioned point-in-boundary result used to scope matching, review and routing. Synthetic provenance is explicit; unresolved or ambiguous locations never become guessed jurisdictions (V033).';
