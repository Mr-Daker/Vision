-- 0013_review_and_routing.sql
-- Roadmap: V032 (review queue and reasoned decisions), V033 (routing),
-- V034 (staff acknowledgment).
--
-- Three records that all exist for the same reason: a decision without its
-- reason, its author and the state it replaced is not auditable, and an
-- unauditable decision about someone's report is indistinguishable from an
-- arbitrary one.

-- V032. Every reviewer action, with the state it replaced preserved in place
-- rather than overwritten. `prior_state` is the record that lets a public
-- display change without erasing the history behind it.
CREATE TABLE review_decision (
    decision_id         uuid        NOT NULL PRIMARY KEY,
    -- What was reviewed. Exactly one target, checked below.
    evidence_id         uuid        REFERENCES evidence_item (evidence_id),
    match_id            uuid        REFERENCES issue_match (match_id),
    correction_request_id uuid      REFERENCES correction_request (request_id),
    canonical_issue_id  uuid        REFERENCES canonical_issue (issue_id),
    action              text        NOT NULL,
    -- Mandatory. A decision nobody has to explain is one nobody can question.
    reason              text        NOT NULL,
    reviewer_id         uuid        NOT NULL,
    decided_at          timestamptz NOT NULL DEFAULT now(),
    -- The state this decision replaced, kept so a later reader can see what
    -- changed rather than only what is current.
    prior_state         jsonb       NOT NULL,
    resulting_state     jsonb       NOT NULL,
    decision_event_id   uuid        REFERENCES status_event (event_id),

    CONSTRAINT review_decision_action_ck CHECK (action IN
        ('accept_evidence','reject_evidence','approve_redaction','request_more_evidence',
         'attach_to_issue','separate_from_issue','accept_correction','reject_correction',
         'confirm_match','reject_match')),
    CONSTRAINT review_decision_reason_nonempty_ck CHECK (length(btrim(reason)) > 0),
    -- Exactly one target: a decision about "something" is not reviewable.
    CONSTRAINT review_decision_one_target_ck CHECK (
        (CASE WHEN evidence_id IS NOT NULL THEN 1 ELSE 0 END)
      + (CASE WHEN match_id IS NOT NULL THEN 1 ELSE 0 END)
      + (CASE WHEN correction_request_id IS NOT NULL THEN 1 ELSE 0 END) = 1
    )
);

CREATE INDEX review_decision_reviewer_idx ON review_decision (reviewer_id, decided_at DESC);
CREATE INDEX review_decision_issue_idx ON review_decision (canonical_issue_id, decided_at DESC);

COMMENT ON TABLE review_decision IS
    'Reasoned reviewer decisions with the prior state preserved (V032). A public display may change; this record is what stops the original decision history being erased.';

-- V033. Which directory version produced a route, and to whom. Separate from
-- the AI classification that proposed the category: a routing decision is a
-- deterministic directory lookup, and conflating the two would make an
-- unreviewed model output look like an authority decision.
CREATE TABLE routing_decision (
    routing_id          uuid        NOT NULL PRIMARY KEY,
    issue_id            uuid        NOT NULL REFERENCES canonical_issue (issue_id),
    -- The exact directory version consulted. Required: a route nobody can
    -- re-derive is not explainable.
    directory_version   text        NOT NULL,
    -- The category used for the lookup, recorded so a later category change
    -- does not silently rewrite why this route was chosen.
    category            text        NOT NULL,
    jurisdiction_id     uuid        REFERENCES jurisdiction (jurisdiction_id),
    responsibility_id   uuid        REFERENCES responsibility_directory (responsibility_id),
    department_id       text,
    department_label    text,
    -- 'simulated' whenever the recipient is not a real authority. The demo
    -- must never present a simulated route as a government relationship.
    recipient_mode      text        NOT NULL,
    outcome             text        NOT NULL,
    reason              text        NOT NULL,
    decided_at          timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT routing_decision_mode_ck CHECK (recipient_mode IN ('simulated','real','none')),
    CONSTRAINT routing_decision_outcome_ck CHECK (outcome IN
        ('routed','unknown_owner_review','ambiguous_owner_review','no_directory_entry')),
    CONSTRAINT routing_decision_reason_nonempty_ck CHECK (length(btrim(reason)) > 0),
    -- A routed decision must name who it went to; a review outcome must not
    -- pretend to have a recipient.
    CONSTRAINT routing_decision_recipient_ck CHECK (
        (outcome = 'routed') = (department_id IS NOT NULL AND responsibility_id IS NOT NULL)
    ),
    CONSTRAINT routing_decision_mode_matches_outcome_ck CHECK (
        (outcome = 'routed') = (recipient_mode <> 'none')
    )
);

CREATE INDEX routing_decision_issue_idx ON routing_decision (issue_id, decided_at DESC);

COMMENT ON TABLE routing_decision IS
    'Explainable routing: which directory version, which recipient, and whether that recipient is simulated (V033).';

-- V034. Three things that are constantly conflated in civic software and are
-- kept as separate rows here: we sent it, we accepted it internally, and the
-- recipient acknowledged it. Only the third involves the outside world.
CREATE TABLE acknowledgment (
    acknowledgment_id   uuid        NOT NULL PRIMARY KEY,
    issue_id            uuid        NOT NULL REFERENCES canonical_issue (issue_id),
    kind                text        NOT NULL,
    actor_type          text        NOT NULL,
    actor_id            uuid,
    -- Provider-side reference, present only for an external acknowledgment.
    provider_reference  text,
    provider_mode       text,
    authenticity        text,
    occurred_at         timestamptz NOT NULL,
    recorded_at         timestamptz NOT NULL DEFAULT now(),
    note                text,
    event_id            uuid        REFERENCES status_event (event_id),

    CONSTRAINT acknowledgment_kind_ck CHECK (kind IN
        ('delivery_attempted','delivery_accepted','internal_acceptance',
         'recipient_acknowledgment')),
    CONSTRAINT acknowledgment_actor_type_ck CHECK (actor_type IN
        ('system_worker','staff','reviewer','supervisor','external_provider')),
    -- An external acknowledgment must carry its provenance, including whether
    -- the responder was simulated. Internal acceptance must NOT claim any.
    CONSTRAINT acknowledgment_external_provenance_ck CHECK (
        (kind = 'recipient_acknowledgment')
        = (provider_mode IS NOT NULL AND authenticity IS NOT NULL)
    ),
    CONSTRAINT acknowledgment_provider_mode_ck
        CHECK (provider_mode IS NULL OR provider_mode IN ('simulated','real')),
    CONSTRAINT acknowledgment_authenticity_ck CHECK (authenticity IS NULL OR authenticity IN
        ('simulated_fixture','authenticated_external','unauthenticated_external')),
    -- One acknowledgment of each kind per issue: a repeated delivery callback
    -- is not a second acknowledgment.
    CONSTRAINT acknowledgment_kind_uniq UNIQUE (issue_id, kind)
);

CREATE INDEX acknowledgment_issue_idx ON acknowledgment (issue_id, occurred_at);

COMMENT ON TABLE acknowledgment IS
    'Delivery, internal acceptance and recipient acknowledgment as separate facts (V034). Only recipient_acknowledgment involves an outside party, and it must carry provenance saying whether that party was simulated.';
