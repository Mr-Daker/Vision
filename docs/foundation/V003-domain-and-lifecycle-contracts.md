# V003 — Domain and Lifecycle Contracts

**Status:** Ready for owner approval  
**Roadmap task:** V003 (Foundation) · **Prerequisites:** V001, V002 · **Owner:** Product + Backend  
**Machine-readable companion:** [contracts/domain-contract.v1.yaml](contracts/domain-contract.v1.yaml) (contract version 3.0.0)

> This is a domain contract, not a database schema. V012 converts it into migrations and constraints. All provider-backed facts retain their provenance and simulation status.

## 1. Contract principles

1. A `Submission` is what a citizen sent; it is not a verified issue.
2. An `IssueMatch` records the duplicate/new-issue decision; matching states never become issue states.
3. `IssueEvidenceLink` attaches evidence to an issue through effective-dated, correctable links. Submitted source content is immutable during ordinary operations; derived processing fields are versioned.
4. `CanonicalIssue.current_status` contains only operational workflow state.
5. `Participant` is a stable pseudonymous application identity. `IdentityMapping` and `Session` are separate restricted records.
6. Evidence and participation stay attached to their original issue when issues merge. The active canonical issue is resolved through effective-dated alias edges.
7. Events are append-only. Their actor pseudonym is restricted metadata; their payload contains no raw evidence, identity-provider reference, secret, transcript or precise coordinates.
8. Event time and ingestion time are always distinct fields.
9. Privacy erasure is the only exception to ordinary source-content immutability: restricted values are nulled, a non-content tombstone remains, and the erasure is audit-recorded under V005.

## 2. Domain dictionary

| Entity                   | Stable identifier                              | Purpose and principal fields                                                                                                                                                                                                                | Mutation and provenance rules                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Submission`             | `submission_id` UUID                           | One authenticated citizen report: `participant_id`, device-reported location plus accuracy/source, client observation time, server receipt time, BCP 47 interface/source locale, locale-pack version, idempotency key and processing state. | Citizen-supplied fields are insert-once; processing state follows §4 with expected-version checks and events. `participant_id` is required at acceptance. Location/time are claims, not proof. Privacy erasure may null the precise location while retaining a tombstone. Evidence is related through `EvidenceItem.submission_id`; no duplicated `media_ids[]` list is stored. |
| `EvidenceItem`           | `evidence_id` UUID                             | One citizen photo, voice or text item. Media uses a private object reference; text uses `content_text`; voice may gain a transcript and transcription provenance.                                                                           | Source content and submission relationship are immutable in ordinary use. Processing/redaction/transcription fields are versioned and event-recorded. Privacy erasure nulls restricted content and fingerprints but retains a non-content tombstone. Type-specific constraints apply while the item is active.                                                                  |
| `IssueEvidenceLink`      | `issue_evidence_link_id` UUID                  | Effective-dated association between one evidence item and one original canonical issue, with `match_id`, decision basis and correction provenance.                                                                                          | At most one active link per evidence item. Correction closes the current link and creates a successor atomically; it never rewrites evidence.                                                                                                                                                                                                                                   |
| `IssueMatch`             | `match_id` UUID                                | One versioned matching attempt for a submission: candidates, decision, result issue, reason, actor and timestamps.                                                                                                                          | One active attempt per submission. A recheck atomically supersedes the old attempt. Terminal decisions are `no_match` or `match_confirmed`; both require a result issue.                                                                                                                                                                                                        |
| `CanonicalIssue`         | `issue_id` UUID + permanent `public_reference` | Original real-world problem record: asset, jurisdiction, category, operational status, opened time and version.                                                                                                                             | Created only during `IssueMatch.no_match` finalization. Field changes require expected-version checks and events. An issue with an active outgoing alias is retired from direct writes but remains an immutable lookup/history anchor.                                                                                                                                          |
| `IssueParticipation`     | `participation_id` UUID                        | Current materialized relationship between a participant and an original issue: counted state, reason, eligibility provenance and first/last evidence times.                                                                                 | Unique `(participant_id, canonical_issue_id)`. More evidence updates `last_evidence_at`. Count/eligibility corrections are allowed only with optimistic versioning and an append-only event. Effective canonical counts use distinct participants over the active alias closure.                                                                                                |
| `Participant`            | `participant_id` UUID                          | Stable internal pseudonymous anchor used for sessions, ownership and anti-duplicate counting.                                                                                                                                               | Contains no provider subject or credential. It survives logout/session expiry. A deletion request tombstones it after its identity mapping and private content are erased; it is never exposed publicly.                                                                                                                                                                        |
| `IdentityMapping`        | `identity_mapping_id` UUID                     | Restricted mapping between `(provider, provider_subject_reference)` and `participant_id`; simulated in the hackathon.                                                                                                                       | Isolated L3a store. Provider reference is encrypted or keyed-hashed as appropriate, unique per provider, never logged or sent to AI. Can be disabled/erased independently from the participant tombstone.                                                                                                                                                                       |
| `Session`                | `session_id` UUID                              | One login session for a participant: issued, expires, revoked and reason.                                                                                                                                                                   | Logout/expiry/revocation affects only the session. Tokens are stored only as secure hashes. Session activity never resets participation.                                                                                                                                                                                                                                        |
| `ConsentRecord`          | `consent_id` UUID                              | Versioned proof of the demonstration notice shown to a participant: notice version, BCP 47 locale, explicitly granted purposes and grant/withdrawal times.                                                                                  | Grant facts are append-only; withdrawal sets only withdrawal metadata and triggers V005 deletion/withdrawal work. Optional public-derivative and Gemini voice purposes are never inferred from general demo consent. Contains no report content.                                                                                                                                |
| `InfrastructureAsset`    | `asset_id` string                              | Versioned physical asset reference, source record, type, name, location and jurisdiction.                                                                                                                                                   | External stable ID where permitted; otherwise generated string ID. Corrections create an event and preserve source lineage/effective dates.                                                                                                                                                                                                                                     |
| `Jurisdiction`           | `jurisdiction_id` UUID                         | Effective-dated node in a versioned jurisdiction profile: optional parent, required internal code, optional permitted external source code and configurable administrative-level scheme/code.                                               | Versioned rows with source/synthetic provenance. Parent edges reject self-reference/cycles and stay inside one profile. Administrative levels are configuration, not a fixed India-only enum. Responsibility routing belongs to the versioned routing directory, not an unsupported legal claim.                                                                                |
| `Assignment`             | `assignment_id` UUID                           | Effective-dated issue ownership: department, optional staff, reason, `valid_from`, `valid_to`.                                                                                                                                              | Reassignment closes the prior assignment and creates a successor atomically. At most one active assignment per issue.                                                                                                                                                                                                                                                           |
| `ProjectLink`            | `project_link_id` UUID                         | Reviewable source-labelled association of exactly one issue or asset with a project source record.                                                                                                                                          | Exactly one of issue/asset is set. Review decisions are versioned and event-recorded; absence never proves no funding exists.                                                                                                                                                                                                                                                   |
| `StatusEvent`            | `event_id` UUID                                | Append-only domain event with aggregate, version, event type, actor class, restricted pseudonymous actor reference, occurred/recorded times and a non-sensitive payload.                                                                    | Never edited. Corrections append a referencing event. Only an authorized internal view may read the actor pseudonym; public timelines use a sanitized projection. Payload schema forbids L2 content, external identity references and secrets.                                                                                                                                  |
| `IssueMerge`             | `merge_id` UUID                                | Reviewable decision merging one issue into another, with reason, authorizing event and optional reversal details.                                                                                                                           | Does not move evidence, participation or history. Reversal closes the active alias; it does not create a replacement issue.                                                                                                                                                                                                                                                     |
| `IssueAlias`             | `alias_id` UUID                                | Effective-dated directed edge from a retired source issue to its active target issue.                                                                                                                                                       | Merge creates one active edge; reversal closes it. Resolution follows active edges recursively with cycle rejection and a bounded depth. Historical edges remain queryable.                                                                                                                                                                                                     |
| `ResolutionEvidenceItem` | `resolution_evidence_id` UUID                  | Private staff-supplied photo/document supporting one resolution claim, with fingerprint, capture metadata and optional approved redacted derivative.                                                                                        | Created with the claim. Source bytes are immutable in ordinary use; redaction is versioned; privacy/retention erasure leaves a non-content tombstone. It is separate from citizen `EvidenceItem`.                                                                                                                                                                               |
| `ResolutionClaim`        | `claim_id` UUID                                | Staff claim that work is complete, with one or more `ResolutionEvidenceItem` references and a description.                                                                                                                                  | Append-only and never itself a confirmed repair. At most one open claim per active issue.                                                                                                                                                                                                                                                                                       |
| `ResolutionConfirmation` | `confirmation_id` UUID                         | Exactly one eligible participant or reviewer confirms/disputes one claim.                                                                                                                                                                   | Append-only. Actor type remains visible so reviewer confirmation is never presented as citizen confirmation.                                                                                                                                                                                                                                                                    |
| `Reopening`              | `reopening_id` UUID                            | Explicit reopening of a previously confirmed issue, linked to the prior confirmation and a reason.                                                                                                                                          | Created only from `resolution_confirmed`; append-only and event-recorded.                                                                                                                                                                                                                                                                                                       |
| `SourceRecord`           | `source_record_id` UUID                        | Provenance metadata and, only when permitted, an immutable source snapshot for permitted, synthetic, consented, reference-only or unavailable material.                                                                                     | Raw snapshot is immutable when present. It must be null for reference-only, unavailable or verification-pending sources. Licence/demo classification changes require a dated decision event. Reference-only/unavailable material cannot back ingested demo claims.                                                                                                              |

## 3. Type-specific and cross-entity invariants

- `Submission.participant_id` is non-null because an accepted report requires a simulated or real authenticated participant. Device-only drafts are not submissions.
- While `EvidenceItem.privacy_state=active`, photo/voice items require `object_reference` and a media fingerprint; text requires `content_text` and a null `object_reference`. Erasure nulls all restricted content, fingerprints and derivatives and records `erased_at`.
- Voice transcription provenance records provider, model/version, request time and whether the processor was external. Raw voice never appears in application logs or event payloads.
- Every accepted evidence item belonging to a finalized submission receives exactly one active `IssueEvidenceLink` in the same finalization transaction.
- Every finalized submission creates or updates exactly one `IssueParticipation` for its participant and resulting original issue.
- An `IssueMatch` terminal decision requires `resulting_issue_id`, `decision_basis`, actor and `decided_at`. Non-terminal attempts must not pretend to have a final result.
- Exactly one active `IssueMatch` exists per submission. `(submission_id, attempt_number)` is unique.
- Exactly one active `IssueEvidenceLink` exists per evidence item.
- Exactly one active `Assignment` exists per issue.
- `ResolutionConfirmation` has exactly one of `responding_participant_id` and `reviewer_id`.
- `ProjectLink` has exactly one of `issue_id` and `asset_id`.
- Voice may be sent to Gemini only when an active `ConsentRecord` explicitly includes `gemini_voice_transcription`; public evidence likewise requires `public_derivative` consent plus redaction approval.
- Any operation that changes several records below is one transaction and uses the same correlation ID.

## 4. Submission lifecycle

| From                          | To             | Actor           | Guard                                             |
| ----------------------------- | -------------- | --------------- | ------------------------------------------------- |
| —                             | `received`     | API             | submission and outbox record committed atomically |
| `received`                    | `processing`   | worker          | leased durable task                               |
| `processing`                  | `needs_review` | worker          | usable content requires human decision            |
| `processing`                  | `accepted`     | worker          | required evidence usable and policy checks passed |
| `needs_review`                | `accepted`     | reviewer        | flags resolved                                    |
| `processing` / `needs_review` | `rejected`     | worker/reviewer | invalid or prohibited submission, with reason     |
| `processing` / `needs_review` | `quarantined`  | worker/reviewer | content isolated pending an explicit review path  |

`rejected` and `quarantined` are distinct terminal/current states. A quarantined submission can return to `needs_review`; a rejected submission can only be superseded by a new submission or an explicit appeal contract added later.

## 5. IssueMatch lifecycle and atomic finalization

| From                                 | To                     | Actor                   | Guard/effect                                                                      |
| ------------------------------------ | ---------------------- | ----------------------- | --------------------------------------------------------------------------------- |
| —                                    | `pending`              | matching worker         | accepted submission; unique active attempt                                        |
| `pending`                            | `candidates_retrieved` | system                  | bounded spatial/semantic query completed, including an empty result               |
| `candidates_retrieved`               | `ambiguous`            | system                  | human/citizen decision required                                                   |
| `candidates_retrieved` / `ambiguous` | `no_match`             | system/reviewer/citizen | create new issue and finalize to it                                               |
| `candidates_retrieved` / `ambiguous` | `match_confirmed`      | system/reviewer/citizen | resolve selected candidate through active aliases and finalize to the active root |
| non-terminal                         | `failed_retryable`     | system                  | retryable dependency failure; no authoritative result                             |

For both terminal outcomes, one short transaction must:

1. recheck the selected candidate/absence and active alias root;
2. create the new issue for `no_match`, or select the active issue for `match_confirmed`;
3. set the terminal match decision and result;
4. create active `IssueEvidenceLink` rows for **all accepted evidence items** in the submission;
5. create/update `IssueParticipation` using `participant_id`, never `session_id`;
6. append the domain events and pending outbox work.

Retries with the same submission and attempt return the committed result. A re-evaluation creates a new attempt with `supersedes_match_id` and atomically closes the old active attempt. If the successor resolves to a different issue, its finalization transaction also supersedes every affected `IssueEvidenceLink` and recomputes the two affected `IssueParticipation` materializations before publishing read-model work.

## 6. CanonicalIssue lifecycle

| From                         | To                     | Actor                                         | Guard                                                              |
| ---------------------------- | ---------------------- | --------------------------------------------- | ------------------------------------------------------------------ |
| —                            | `created`              | match finalization                            | `IssueMatch=no_match` transaction                                  |
| `created`                    | `routing_review`       | routing worker                                | jurisdiction/custodian ambiguous or unavailable                    |
| `created` / `routing_review` | `routed_internal`      | routing worker/reviewer                       | versioned directory decision recorded                              |
| `routed_internal`            | `agency_ack_received`  | authenticated or explicitly simulated adapter | provenance and simulated/real label recorded                       |
| `agency_ack_received`        | `work_planned`         | staff                                         | active assignment recorded                                         |
| `work_planned`               | `resolution_claimed`   | staff                                         | `ResolutionClaim` with evidence created                            |
| `resolution_claimed`         | `resolution_confirmed` | eligible participant/reviewer                 | `ResolutionConfirmation=confirmed`; confirming actor type retained |
| `resolution_claimed`         | `resolution_disputed`  | eligible participant/reviewer                 | `ResolutionConfirmation=disputed`                                  |
| `resolution_disputed`        | `work_planned`         | staff/reviewer                                | further work assigned                                              |
| `resolution_confirmed`       | `reopened`             | eligible participant/reviewer                 | `Reopening` created                                                |
| `reopened`                   | `work_planned`         | staff/reviewer                                | new work cycle begins                                              |

Adding/correcting an evidence link never changes `current_status`. Direct operational writes to an issue with an active outgoing `IssueAlias` are rejected; callers first resolve the active canonical root.

## 7. Merge, reversal and canonical resolution

### Merge

A merge transaction creates `IssueMerge(B → A)` and active `IssueAlias(source=B,target=A)`. B's evidence, participation and events remain attached to B. B becomes retired for direct writes because it has an active outgoing alias. Views of A aggregate records from every issue whose active alias chain resolves to A.

### Resolution algorithm

Starting with an issue ID:

1. load its active outgoing alias, if any;
2. if none exists, the current ID is the active root;
3. otherwise follow the target and repeat;
4. reject a merge that would introduce a cycle;
5. fail safely and require review if the chain exceeds 16 hops.

The final merge transaction repeats this resolution while holding the required database locks. Analytics count distinct `participant_id` values across all original issues resolving to the active root; evidence counts remain separate.

### Reversal

Reversal records `reversed_at`, reason and authorizing event on `IssueMerge`, then closes the corresponding active `IssueAlias.valid_to` in the same transaction. B immediately resolves to itself again; no replacement B-prime issue is created. Its original evidence, participation, public reference, status and event history were never moved, so no reconstruction is necessary. Evidence submitted during the mistaken-merge period can be corrected with superseding `IssueEvidenceLink` records and corresponding participation correction events.

## 8. Corrections, concurrency and deletion

- `CanonicalIssue`, `IssueParticipation`, `Assignment` closure, match supersession and project-link decisions require expected versions or transactional uniqueness guards.
- Domain corrections append a `StatusEvent` containing identifiers and reason codes, not sensitive content.
- A data-subject deletion erases the provider subject, precise location, private media, fingerprints, text/transcripts and attributable AI caches. Non-content submission/evidence tombstones and their referential links remain; affected participation is made non-counting and public aggregates are recomputed. The participant becomes a non-identifying tombstone so append-only event ordering remains valid; see V005 for public-read-model and backup rules.
- Event payload schema versions are mandatory. Unknown event/payload versions fail closed rather than being guessed.

## 9. Approval gate

The generic contract structure is ready for Product/Backend review. V001 now selects Sangli district with `mr-IN` and `en-IN`; V011/V019 must encode those values as versioned jurisdiction, taxonomy and locale fixtures rather than schema branches. V012 migrations must not begin until the Product Owner approves this document and the YAML companion together.
