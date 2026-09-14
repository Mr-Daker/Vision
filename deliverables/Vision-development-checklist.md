# Vision development checklist

Dependency-ordered implementation plan · 9 September 2026

Every prerequisite points to an earlier task. Work from the top; tasks whose prerequisites are complete may run in parallel. This file is also the progress record: a checked box means the task's stated deliverable and "Done when" conditions were verified; unresolved owner approvals or external gates are recorded explicitly. Owner labels are roles to assign, not staffing assumptions.

Use the companion Vision system design for policies, contracts, metrics and architecture. Foundation and Hackathon form the prototype path. Pilot adds approved real-person and recipient integration; Scale expands validated operations. External approvals are explicit gates, never assumed to be granted.

| Phase      | Tasks     | Outcome                                                               |
| ---------- | --------- | --------------------------------------------------------------------- |
| Foundation | V001–V017 | Contracts, fixtures, privacy boundaries, persistence and durable jobs |
| Hackathon  | V018–V054 | Complete working demonstration with real Google AI                    |
| Pilot      | V055–V064 | Approved real identity, actual recipient and production safeguards    |
| Scale      | V065–V072 | Validated expansion; optional features require a build/defer decision |

Start with V001. Your first functioning vertical slice is durable reporting at V018–V020. Canonical issues and citizen confirmation arrive by V031; staff resolution by V035; the policy view by V043; the evaluated demo release at V054. These checkpoints do not replace their listed prerequisites.

Parallel work is allowed when dependencies are satisfied: for example, after V008 and its prerequisites, demo identity V009, recipient adapters V010, reviewed fixtures V011 and schema V012 can proceed independently. Do not treat a simulated adapter test as a live-provider approval.

V001 locks Sangli district, Maharashtra, with Marathi (`mr-IN`) and English (`en-IN`); V019 implements the localized capture experience. Government school infrastructure is the locked first category. These are versioned configuration choices, not hard-coded platform limits. No task duration is asserted without team size, experience and access information.

## Foundation

- [x] **V001 — Freeze the first decision workflow and release boundaries**
  - Prerequisites: None
  - Owner: Product
  - Build: Choose one district, one infrastructure category, supported demonstration languages, target citizen and staff roles, and the complete report-to-priority-to-resolution demonstration. Start with photos, text, and recorded voice; place richer video in the later media task. Separate hackathon, authorized pilot, and national expansion scope.
  - Done when: The team approves a one-page scope, explicit exclusions, demo acceptance criteria, and measurable pilot learning goals. No later-phase integration is required to demonstrate the first workflow.
  - Verified: 9 September 2026 — [V001](../docs/foundation/V001-scope-and-release-boundaries.md) locks Sangli district, government school infrastructure, Marathi + English, observable demo acceptance criteria, explicit exclusions, pilot learning goals and a configuration-based future-extension contract.

- [x] **V002 — Publish the capability and evidence-claim matrix**
  - Prerequisites: V001
  - Owner: Product + AI
  - Build: Mark each planned capability as real, simulated, proposed, or unsupported. Distinguish verified identity, location evidence, independent contributors, media consistency, estimated population served, and engineering confirmation.
  - Done when: The matrix prohibits perfect AI-image detection, uncalibrated confidence probabilities, GPS-as-proof claims, and claims of official receipt or repair certification based solely on internal state.
  - Verified: 9 September 2026 — [capability/evidence matrix](../docs/foundation/V002-capability-evidence-matrix.md) covers all required claim classes and explicitly enforces all prohibited claims.

- [x] **V003 — Define versioned domain and lifecycle contracts**
  - Prerequisites: V001, V002
  - Owner: Product + Backend
  - Build: Define submission, evidence item, canonical issue, infrastructure asset, participant, jurisdiction, assignment, project link, status event, merge, and reopening. Specify actors, allowed transitions, immutable facts, and correction semantics.
  - Done when: A versioned domain dictionary and transition matrix distinguish submission acceptance, agency acknowledgment, resolution claim, resolution confirmation, and reopening; recurrence and mistaken merges have explicit treatment.
  - Verified: 9 September 2026 — [domain/lifecycle specification](../docs/foundation/V003-domain-and-lifecycle-contracts.md) and [machine-readable contract](../docs/foundation/contracts/domain-contract.v1.yaml) parse and agree on 22 entities, 3 lifecycles and 5 atomic transaction contracts.

- [x] **V004 — Create the source and reuse register**
  - Prerequisites: V001, V003
  - Owner: Data
  - Build: Inventory candidate complaint, asset, boundary, population, project, and investment datasets. Record publisher, exact source, access method, dates, license or permission, update cadence, useful identifiers, and known gaps. Identify an eligible identity partner and prospective department recipient; prepare and, through the authorized project owner, initiate needed onboarding or data-access requests early.
  - Done when: Each proposed demo input is either permitted source data or explicitly labeled synthetic data. Public visibility is not treated as blanket permission to copy personal information. The external-access register names owners and outstanding requests, but neither approval nor live credentials are prerequisites for completing this task or the demonstration.
  - Verified: 9 September 2026 — [source/reuse policy](../docs/foundation/V004-source-and-reuse-register.md), [source register](../docs/foundation/registers/source-register.csv) and [external-access register](../docs/foundation/registers/external-access-register.csv) parse successfully and keep unlicensed/reference-only records out of demo fixtures. Outreach drafts are prepared but intentionally unsent pending an authorized owner.

- [x] **V005 — Draft data classes, trust boundaries, and retention rules**
  - Prerequisites: V002, V003, V004
  - Owner: Security + Product
  - Build: Classify identity mappings, precise coordinates, private originals, redacted public evidence, model inputs, logs, and aggregates. Draft access, retention, deletion, and disclosure rules for a demonstration using consenting participants.
  - Done when: The design keeps identity mappings separate from public records, excludes identity documents from AI context, and identifies the policy and consent decisions requiring approval before a real pilot.
  - Verified: 9 September 2026 — [privacy/trust/retention specification](../docs/foundation/V005-data-privacy-and-retention.md) covers data classes, resource access, trust boundaries, consent, retention, erasure/tombstones, logging and pre-pilot approval gates.

- [x] **V006 — Record the initial architecture and deployment decisions**
  - Prerequisites: V003, V005
  - Owner: Platform + Backend
  - Build: Document TypeScript PWA, API, private HTTP worker, PostgreSQL/PostGIS/pgvector, object storage, and durable task delivery. Define authoritative records, service identities, connection budgets, deployment region choices, and deferred components.
  - Done when: Architecture decisions explain why BigQuery, Redis, native mobile attestation, and additional services are deferred until a measured requirement or pilot decision justifies them.
  - Verified: 12 September 2026 — [architecture decisions](../docs/foundation/V006-architecture-and-deployment-decisions.md) define authoritative records, trust boundaries, bounded connections, regional deployment rules, and measurable adoption triggers for every deferred component.

- [x] **V007 — Prepare the development workspace and automated checks**
  - Prerequisites: V006
  - Owner: Platform
  - Build: Establish application packages, versioned migrations, environment templates, secret handling, formatting, type checks, test commands, and CI. Pin supported runtime and database-extension versions after compatibility checks.
  - Done when: A clean checkout can run the documented local workflow and checks without production credentials; secrets and private media are excluded from version control and build artifacts.
  - Verified: 12 September 2026 — `npm run check` passed formatting, both TypeScript targets, import/scope/secret/holdout/browser/migration gates, and 582 unit tests. Runtime, lockfile, database image, extensions, CI permissions, ignored secrets, and private-media paths are pinned or guarded in the workspace.

- [x] **V008 — Specify APIs, events, and replaceable provider adapters**
  - Prerequisites: V003, V006, V007
  - Owner: Backend
  - Build: Define versioned request, response, error, event, and adapter contracts for identity, government routing, object storage, task delivery, AI inference, and source imports. Include idempotency, correlation IDs, timestamps, and provider capabilities.
  - Done when: Contract fixtures cover success, unavailable, pending, rejected, duplicate, and ambiguous outcomes. Interfaces distinguish simulated provider responses from authenticated external responses.
  - Verified: 12 September 2026 — versioned envelopes, mutation idempotency bindings, correlation IDs, strict timestamps, provider capabilities and provenance are executable contracts; completeness tests cover all six outcomes for every adapter capability and keep simulated provenance distinct from authenticated external authority.

- [x] **V009 — Implement application sessions and clearly simulated demo identity**
  - Prerequisites: V005, V008
  - Owner: Backend + Frontend
  - Build: Implement the identity adapter using fixed demo principals and internal pseudonymous participant IDs. Build real application session issuance, expiry, rotation, logout, protected cookies, CSRF defenses where applicable, and a documented demo recovery path. Model credential state, issuer, revocation, and uniqueness without claiming real DigiLocker verification.
  - Done when: The UI and API capability metadata identify demo identity as simulated. Repeated login for the same fixture yields the same internal participant; expired or revoked sessions fail, logout clears protected local state under the agreed policy, and no live identity-provider approval is needed.
  - Verified: 12 September 2026 — unit, HTTP and PostgreSQL tests cover stable pseudonymous identity, credential issuer/state, expiry, revocation, atomic rotation, CSRF, protected cookies and logout; the running interface and capability metadata visibly label identity as simulated, and V020 clears consented device drafts on sign-out.

- [x] **V010 — Implement a simulated department recipient and source adapters**
  - Prerequisites: V004, V008
  - Owner: Backend + Data
  - Build: Create controlled department-inbox, acknowledgment, project-data, and demographic-data adapters using reviewed fixtures. Include delayed acknowledgment, rejected routing, stale records, and missing project matches.
  - Done when: Every simulated agency event and synthetic source row is labeled. Adapter contract tests make later real providers replaceable without changing the citizen or staff workflow.
  - Verified: 12 September 2026 — recipient and source contract suites pass for delayed, rejected, unavailable, duplicate, stale, missing and unknown outcomes; simulated/synthetic provenance is enforced at adapter boundaries and idempotent mutation bindings prevent conflicting replay.

- [x] **V011 — Build reviewed fixtures and a sealed evaluation holdout**
  - Prerequisites: V002, V003, V004, V008
  - Owner: AI + Data
  - Build: Prepare permitted multilingual reports, media, routing labels, duplicate pairs, nearby distinct defects, recurrence examples, and adversarial inputs. Include a small versioned demo taxonomy, asset registry, jurisdiction mapping, permitted or synthetic boundaries, and responsibility directory for seeding before matching and routing are built. Separate development and holdout sets by real issue or asset to reduce leakage.
  - Done when: The corpus has provenance, reviewer decisions, label definitions, language and category coverage, and unresolved-label flags. Holdout examples are excluded from prompts, tuning, and demo rehearsal.
  - Verified: 12 September 2026 — fixture tests validate provenance, reviewer-state and unresolved-label fields, multilingual/category/adversarial coverage, asset-separated development and holdout splits, and a holdout loader that remains sealed unless an explicit evaluation run and reason are supplied.

- [x] **V012 — Create database schemas and enforce core invariants**
  - Prerequisites: V003, V005, V008
  - Owner: Backend
  - Build: Create migrations for domain records, participant mappings, evidence metadata, current state, immutable events, processing stages, outbox rows, source lineage, and issue aliases. Define foreign keys, unique keys, timestamps, and version columns.
  - Done when: Database constraints prevent repeated request acceptance, duplicate stage identities, and repeated participation on the same canonical issue. Event and source records preserve event time separately from ingestion time.
  - Verified: 12 September 2026 — 18 forward migrations are applied; real-database tests and `db:verify` confirm idempotency, stage, participation, event-ordering, active-link/assignment/alias and provenance constraints, including separate event and ingestion times.

- [x] **V013 — Run the local persistence stack and test migrations**
  - Prerequisites: V007, V011, V012
  - Owner: Platform + Backend
  - Build: Run the selected PostgreSQL and extensions, apply migrations, and seed the isolated taxonomy, asset, jurisdiction, responsibility, and evidence fixtures from V011. Configure bounded connection pools and statement timeouts. Document development resets that cannot target shared or production data.
  - Done when: Fresh installation and forward migration checks pass on the selected database version; spatial and vector capabilities are verified rather than assumed from upstream documentation.
  - Verified: 12 September 2026 — the local stack is healthy on PostgreSQL 17.11, PostGIS 3.6.4 and pgvector 0.8.6; all 18 checksummed migrations are applied, and `npm run db:verify` passed real metre-distance, GiST, vector-distance, dimension, connection-setting and invariant queries.

- [x] **V014 — Implement and test domain transitions and persistence invariants**
  - Prerequisites: V003, V011, V012, V013
  - Owner: Backend + QA
  - Build: Implement pure domain functions for transition validation, participant eligibility, recurrence, alias rules, and correction semantics. Add unit tests and real-database tests for constraints, request replay, optimistic version conflicts, and event ordering. Use constructed histories here; complete matching, merging, and reopening workflows are implemented and exercised in their later tasks.
  - Done when: Executable domain policies and persistence tests demonstrate business invariants independently of UI code or later workflow implementations. A resolution claim cannot become externally confirmed merely because a status field is supplied by a client.
  - Verified: 12 September 2026 — pure policy tests and real PostgreSQL tests cover transition authority, eligibility, recurrence, aliases, correction semantics, optimistic conflicts, replay and event ordering; resolution tests prove a staff claim alone never produces confirmed resolution.

- [x] **V015 — Enforce authorization and private-data boundaries**
  - Prerequisites: V005, V009, V012, V014
  - Owner: Backend + Security
  - Build: Implement citizen, reviewer, department staff, supervisor, and administrator permissions with jurisdiction scoping. Derive identities and roles from the application sessions built in V009, and filter public versus authorized private representations. Add server-enforced request limits and per-principal upload/submission quotas with actionable retry errors.
  - Done when: Authorization and limit tests reject forged principal IDs, cross-jurisdiction writes, public access to originals or identity mappings, unauthorized status transitions, and requests beyond configured quotas. Simulated identity still exercises real application authorization.
  - Verified: 12 September 2026 — authorization tests cover all five roles, jurisdiction denial, session-derived identity, private/public projections, original-media purpose grants, transition permissions, upload/submission limits and actionable retry errors; no client-supplied principal is trusted.

- [x] **V016 — Implement private object-storage upload contracts**
  - Prerequisites: V005, V008, V013, V015
  - Owner: Backend + Platform
  - Build: Implement narrowly scoped upload authorization, unique object paths, upload completion validation, quarantine states, size and type limits, and temporary-object cleanup. Keep original evidence private and separate derived previews.
  - Done when: An authorized client uploads only to its assigned object; forged completion, oversized content, mismatched metadata, and unauthorized reads fail without creating accepted evidence.
  - Verified: 12 September 2026 — object-store, HTTP and database tests cover scoped grants, unique paths, size/type sniffing, finalization replay, quarantine, expiry cleanup, private-original access and derivative approval; forged tokens/completion and mismatched bytes are refused.

- [x] **V017 — Implement outbox delivery and durable stage execution**
  - Prerequisites: V008, V012, V013, V014
  - Owner: Backend + Platform
  - Build: Implement transactional outbox publication, bounded dispatch, unique processing-stage keys, renewable leases with fencing tokens, retry policy, terminal failure state, and reconciliation of expired or undelivered work.
  - Done when: A transaction can atomically save domain changes and pending work. Duplicate queue delivery does not duplicate committed effects, and an expired worker cannot overwrite results from a newer lease.
  - Verified: 12 September 2026 — outbox, relay, lease/fencing, retry/terminal and recovery tests pass against PostgreSQL. The previously intermittent API-test teardown was isolated and fixed; the affected file passed 3 consecutive runs and the full 425-test database suite then passed 3 consecutive runs.

## Hackathon

- [x] **V018 — Accept a submission and return a durable receipt**
  - Prerequisites: V014, V015, V016, V017
  - Owner: Backend
  - Build: Implement submission creation using validated location, description, completed-upload references, and an idempotency key. Save the submission and first outbox event atomically before returning a processing receipt.
  - Done when: Network retries return the original receipt. A saved submission remains discoverable during worker outages; a failed database commit cannot be presented as a successful report.
  - Verified: 12 September 2026 — adapter and end-to-end HTTP database tests prove atomic submission/outbox commit, participant-scoped idempotent replay, durable receipt lookup, worker-outage discoverability, validation, CSRF/session enforcement and rollback without a false receipt.

- [ ] **V019 — Build the citizen capture and submission interface**
  - Prerequisites: V009, V016, V018
  - Owner: Frontend
  - Build: Build location capture with accuracy disclosure, photo upload, short text or voice description, permission handling, upload progress, and a durable receipt screen. Localize the selected demonstration languages and implement labels, keyboard navigation, visible focus, screen-reader announcements, sufficient contrast, usable touch targets, zoom support, and text alternatives to voice controls. Keep category, department, and severity selection out of the required form.
  - Done when: A citizen completes the core flow on a mobile browser, including denied-permission and interrupted-upload paths. Keyboard and screen-reader checks pass for that flow. The interface clearly distinguishes a manually claimed pin from captured location evidence.
  - Verification gap: 12 September 2026 — automated tests and a read-only 390×844 browser audit passed load, keyboard order, labels, focus movement, zero horizontal overflow and the manual-pin distinction. The task remains open because no actual screen-reader pass or real-device/pointer pass has been performed, as its own task record states. UI was not changed during this audit.

- [x] **V020 — Make drafts and submission retries resilient**
  - Prerequisites: V005, V018, V019
  - Owner: Frontend + Backend
  - Build: Add consent-aware local draft persistence, safe upload resumption where supported, explicit retry, duplicate-tap prevention, and stale-location prompts. Define expiry and cleanup for device drafts and unfinished uploads.
  - Done when: Loss of connectivity does not falsely show server acceptance or inflate submissions. Reconnecting preserves the original idempotency key, and locally retained sensitive content follows the disclosed cleanup rule.
  - Verified: 12 September 2026 — draft, submit-guard and upload-state tests cover consent-before-storage, expiry/deletion, sign-out cleanup, corrupt/full storage, duplicate taps, offline failure without a receipt, stable retry keys, stale locations and same-object upload retry.

- [x] **V021 — Process media into usable, traceable evidence**
  - Prerequisites: V016, V017, V018
  - Owner: Backend + AI
  - Build: Validate actual media formats, normalize safe derivatives, generate thumbnails, compute cryptographic and perceptual fingerprints, and extract relevant capture metadata. Implement the approved face, number-plate, and contact-detail redaction policy for AI inputs and public derivatives; unresolved redaction cases remain quarantined. Preserve private originals under the retention policy and record derivative provenance and approval state.
  - Done when: Malformed media and unresolved redaction cases cannot enter public views or the normal AI path. Approved fixtures exercise redaction and derivative generation before the later review interface exists. Reused bytes are recognized without treating reuse as independent corroboration or deleting another contributor's evidence record.
  - Verified: 12 September 2026 — decoder, deterministic text/region-redaction, derivative, fingerprint and PostgreSQL tests fail closed on malformed or unresolved media, strip metadata from approved derivatives, preserve private originals and provenance, and treat byte reuse as non-independent evidence without deleting either record.

- [x] **V022 — Verify ingestion recovery and duplicate-delivery behavior**
  - Prerequisites: V017, V018, V020, V021
  - Owner: Backend + QA
  - Build: Exercise worker crashes, duplicate deliveries, missing uploads, expired leases, and a crash after stage commit but before task acknowledgment. Verify reconciliation and controlled replay of recoverable failures.
  - Done when: Each scenario ends in one authoritative stage result or a visible recoverable failure. Tests distinguish idempotent database outcomes from possible repeated external processing costs.
  - Verified: 12 September 2026 — real-database recovery tests pass for missing/restored bytes, killed workers, lease takeover/fencing, triple delivery and crash-after-stage-commit; tests explicitly distinguish one committed database result from potentially repeated provider cost.

- [x] **V023 — Connect real Gemini inference behind the AI adapter**
  - Prerequisites: V008, V011, V015, V017, V021
  - Owner: AI + Backend
  - Build: Use a supported Google AI endpoint server-side for multimodal classification with a compact versioned output schema. Generate and cache semantic embeddings through a separately configured supported endpoint before V026 uses vectors; record embedding model/version, dimensions, normalization, and input hash. Use media fingerprints for initial image similarity unless an image-embedding provider is explicitly selected. Validate identifiers and values, record prompt versions, enforce timeouts and budgets, and isolate untrusted input from application authority.
  - Done when: Real inference and compatible stored semantic vectors are produced from representative approved evidence; invalid or unavailable output produces an explicit review or retry state. Dimension/version mismatches fail validation. API keys remain server-side, and the model cannot execute administrative actions or access identity records.
  - Verified: 12 September 2026 — 6/6 live Gemini tests passed for real transcription, English/Marathi classification, injection-shaped input and a normalized 3072-dimension embedding; offline, cache, pipeline and persistence tests validate taxonomy/schema/dimension/version failures, retry/review states, server-only keys and the no-tools/no-identity boundary.

- [ ] **V024 — Support and verify multilingual voice and text understanding**
  - Prerequisites: V011, V019, V023
  - Owner: AI + Frontend
  - Build: Process the selected demonstration languages and voice inputs while preserving original wording and derived transcripts. Map equivalent descriptions to versioned categories and issue types, retaining uncertainty and a correction path.
  - Done when: Reviewed examples in the chosen languages reach equivalent structured outcomes when appropriate. Unsupported language, noisy audio, and uncertain transcription are visible rather than silently mistranslated.
  - Verification gap: 12 September 2026 — live English/Marathi classification and live transcription passed, while unsupported/noisy/uncertain paths and correction semantics pass deterministic tests. The task remains open because the Marathi corpus/locale pack is explicitly pending native review, so the “reviewed examples in the chosen languages” acceptance clause is not yet met.

- [x] **V025 — Explain independent trust signals without overstating verification**
  - Prerequisites: V002, V021, V023, V024
  - Owner: AI + Product
  - Build: Combine capture consistency, known-media reuse, image-description consistency, and timestamp availability into individual evidence checks and review flags. Define a corroboration-signal adapter using clearly marked fixtures until V029 supplies live eligible participation. Separate observations from any experimentally calibrated model scores.
  - Done when: Users can inspect the reason for each flag and whether its corroboration input is a fixture. Missing metadata is not proof of fraud; identity, physical presence, image authenticity, and factual severity remain distinct claims.
  - Verified: 12 September 2026 — trust-policy, pipeline, review-queue and citizen-detail tests preserve each observation and reason separately, identify live versus fixture corroboration, treat missing metadata as unknown, avoid fraud/authenticity/severity claims, and expose review reasons without private originals.

- [x] **V026 — Retrieve nearby and asset-related issue candidates**
  - Prerequisites: V011, V013, V021, V023
  - Owner: Backend + Data
  - Build: Add indexed spatial candidate queries with correct distance units, asset identifiers, time windows, and configurable accuracy-aware radii. Use exact vector reranking over bounded candidates initially and retain candidate-query diagnostics.
  - Done when: Tests include boundary-adjacent locations, inaccurate GPS, repeated assets, and nearby different defects. Empty approximate-search results are never used as proof that no candidate exists.
  - Verified: 12 September 2026 — indexed PostGIS queries and bounded exact vector reranking pass real-database cases for metre boundaries, poor/unknown accuracy, time windows, repeated/far assets, nearby different defects, capped/non-exhaustive searches and durable query diagnostics.

- [x] **V027 — Propose duplicate matches with reviewable reasons**
  - Prerequisites: V011, V024, V025, V026
  - Owner: AI + Backend
  - Build: Evaluate candidates using location, asset identity, semantics, media similarity, history, and recurrence context. Produce existing-issue, new-issue, or ambiguous proposals with evidence references and versioned decision metadata.
  - Done when: Hard negatives remain separate, recurrence is handled according to the domain contract, and an ambiguous proposal cannot silently cause an irreversible issue merge.
  - Verified: 12 September 2026 — proposal tests cover location, asset, semantics, media reuse, history and recurrence; hard negatives stay separate, recurrence is referred for review, all outcomes carry versioned reasons/evidence, and ambiguous proposals create neither issue links nor merges.

- [x] **V028 — Finalize canonical issue assignment safely under concurrency**
  - Prerequisites: V014, V017, V022, V026, V027
  - Owner: Backend
  - Build: Implement a short transactional candidate recheck before attachment or creation, using the selected serializable or explicit-guard strategy. Implement the reviewed merge and separation commands and reversible membership records that later review screens will invoke. Retry conflicts, rerun stale decisions, and keep external inference outside database transactions.
  - Done when: Concurrent first reports do not bypass the final matching decision because both previously saw no issue. Alias resolution and issue-version changes are checked at commit, with reversible merge records retained.
  - Verified: 12 September 2026 — serializable PostgreSQL tests cover concurrent first reports, transactional candidate recheck, stale versions, alias resolution, caller retry, bounded conflicts and reversible merge/separation history, with inference kept outside transactions.

- [x] **V029 — Enforce unique contribution counts across merges**
  - Prerequisites: V009, V014, V025, V028
  - Owner: Backend + QA
  - Build: Implement one counted participant per canonical issue, allow fresh evidence from existing participants, and union contributor identities when issues merge. Supply live eligible-participation signals to the V025 corroboration adapter and recompute them after merges or corrections. Separate submitted media, unique contributors, onsite evidence, and population estimates.
  - Done when: Repeated accounts in the same demo identity mapping, retries, new evidence, and merges cannot inflate unique-participant counts. Reversal and reopening preserve an auditable contribution history.
  - Verified: 12 September 2026 — the live matching pipeline records eligibility and participation; PostgreSQL tests cover repeated evidence, stable identity mapping, retries, merge union, merge reversal, uncounted consent, erasure and separate media/contributor/onsite counts without inflation.

- [x] **V030 — Build citizen tracking, issue discovery, and infrastructure history views**
  - Prerequisites: V015, V021, V025, V028, V029
  - Owner: Frontend + Backend
  - Build: Implement a private My Reports list and receipt lookup, bounded nearby issue discovery with list/map filters and cursor pagination, and canonical issue details. Display evidence, contributor counts, trust checks, history, and recurrence. Render assignment and resolution fields from contracts or labeled fixtures until V034 and V035 provide their live workflow events. Provide authorized access to originals and public access to approved derivatives only.
  - Done when: Citizens can return to a saved report and discover nearby public issues without retaining a special link. A reader can trace a summary back to its evidence and dates, see what is uncertain or simulated, and distinguish infrastructure history from repeated complaint entries.
  - Verified: 12 September 2026 — the session-bound My Reports view now exposes each receipt and reloads immediately after login/submission; typed receipt lookup handles valid, malformed, unknown and non-owned references without creating bearer access; the nearby coordinate map and equivalent numbered list use only coarse public locations, share category/cursor results, disclose bounds and unmappable rows, and drill into canonical issue evidence. Browser verification covered submission → tracking → receipt reopen, category-filtered map results and marker → detail navigation; 72 V030 assertions, all 591 unit tests and all 425 PostgreSQL tests pass.

- [x] **V031 — Complete citizen duplicate confirmation and correction**
  - Prerequisites: V019, V027, V028, V029, V030
  - Owner: Frontend + Backend
  - Build: Show a possible existing problem with location, preview, and issue history; let the citizen confirm or reject the match. Route disagreement and mistaken attachments through a reviewed correction path.
  - Done when: Confirmation adds evidence once to the current canonical issue. A match that changes during interaction is revalidated, and rejection does not require the citizen to understand government categories.
  - Verified: 12 September 2026 — citizen view, HTTP and PostgreSQL tests cover preview/history, approved derivatives, ownership, CSRF, once-only confirm, canonical-alias revalidation, vanished/stale candidates, category-free reject, disagreement/correction audit and superseded matching attempts; the citizen question is wired into the current interface.

- [x] **V032 — Build the evidence and matching review queue**
  - Prerequisites: V015, V025, V028, V030, V031
  - Owner: Frontend + Backend
  - Build: Provide authorized reviewers with flagged evidence, uncertain classifications, ambiguous matches, redaction decisions, and correction requests. Require reasoned decisions and preserve prior states and reviewer identity in the audit trail.
  - Done when: Review can accept, reject, correct, attach, separate, or request more evidence within defined permissions; public displays update without erasing the original decision history.
  - Verified: 12 September 2026 — the separate reviewer workspace now uses a simulated reviewer-only identity exchange followed by a real application session and durable server-side role/jurisdiction grants; citizen credentials and out-of-scope queues are refused. Live HTTP and browser flows cover the bounded queue, all service-level accept/reject/correct/attach/separate/request-more-evidence actions, mandatory reasons, CSRF, current-queue target revalidation, purpose-bound private-original viewing with an append-only access log, immutable prior/resulting decision state, filtering, sign-out and mobile reflow. All 595 unit tests and all 432 PostgreSQL tests pass.

- [x] **V033 — Resolve department routing through a versioned directory**
  - Prerequisites: V003, V010, V023, V028, V032
  - Owner: Backend + Data
  - Build: Map proposed issue category and location to a reviewed jurisdiction and responsibility directory. Keep deterministic authority checks, unknown-owner review, and provider submission capability separate from AI classification.
  - Done when: Each route has an explainable directory version and recipient. The demo makes clear when routing is internal or simulated and never invents an official government acknowledgment.
  - Verified: 13 September 2026 — the worker resolves each report against a named synthetic boundary version, chooses the deepest active boundary, uses GPS accuracy to refuse edge uncertainty, preserves overlaps/outside-profile cases for review, scopes duplicate retrieval, and links the immutable spatial decision to the versioned category/department route. Pack seeding is idempotent, same-version boundary or owner drift is refused, all recipients remain explicitly simulated, and no routing outcome claims government acknowledgment. All 596 unit tests and all 443 PostgreSQL tests pass; no UI file changed.

- [x] **V034 — Build staff triage and acknowledgment**
  - Prerequisites: V010, V015, V030, V033
  - Owner: Frontend + Backend
  - Build: Create the department inbox with ownership, age, urgency, evidence, and assignment controls. Record internal acceptance and simulated external acknowledgment as separate events with actor, timestamp, and reference.
  - Done when: An authorized staff member can acknowledge and assign a routed issue. Delivery, internal acceptance, and actual recipient acknowledgment have distinct statuses and cannot be conflated by the interface.
  - Verified: 13 September 2026 — a separate staff workspace now authenticates only the simulated department fixture, derives exact jurisdiction/department responsibility pairs from durable server-side grants, and provides a bounded inbox with age, evidence totals, configured queue placement, assignment, internal acceptance and explicitly simulated recipient reply controls. Delivery, internal acceptance and recipient acknowledgment remain separate actor/time/provenance records; current routing is revalidated before each action, cross-department requests and missing CSRF are refused, retries are idempotent, and assignment history is retained. The UI exposes the versioned triage explanation instead of inventing an uncalibrated urgency score. All 601 unit tests and 451 PostgreSQL tests pass; the real browser flow has no console errors and reflows without horizontal overflow at 390 px.

- [x] **V035 — Implement resolution claims, confirmation, dispute, and reopening**
  - Prerequisites: V003, V014, V015, V030, V032, V034
  - Owner: Backend + Frontend
  - Build: Allow staff to provide completion evidence, citizens to corroborate or dispute, and authorized reviewers to resolve disagreements. Apply the category-specific confirmation policy and retain the full transition history.
  - Done when: A repair claim does not automatically count as verified resolution. Reopening reverses current-state closure metrics, and photographs are not presented as professional structural-safety certification.
  - Verified: 13 September 2026 — the workflow is reachable from a browser end to end. Staff upload a real completion photograph through the object-store grant/put/finalize path and record a claim; `claimResolution` no longer fabricates object references, and the route decodes the stored bytes before anything names them. V034 left no route out of `routed_internal`, so two guarded advances were added through `canTransitionIssue` (`recipient_acknowledgment` → `agency_ack_received`, assignment → `work_planned`, and `reopened` → `work_planned`) rather than bypassing the state machine. Citizens confirm or dispute inside the existing Issue details panel with the responder derived from the session — a body naming `participant_id` is refused — and disputes reach the existing reviewer queue as a new `disputed_resolution` kind whose override is offered only where the loaded category policy grants it (migration `0024` adds that decision to the audit table's action and target constraints, and it commits atomically with the state change). Reopening requires a reason, links the confirmation it reverses, and leaves `countsAsClosed` and `isVerifiedResolution` false. Browser verification at 1440px and 390px covered claim → "claimed, awaiting confirmation" → dispute → reviewer decision with a recorded reason → confirm → reopen → history, with no horizontal overflow, visible keyboard focus and no new console errors. A follow-up integrity review added compare-and-set lifecycle writes, request-bound claim idempotency, upload-owner enforcement, and persisted confirmation IDs in lifecycle events. 621 unit tests, 492 PostgreSQL tests, `npm run check` and `npm run build:web` all pass. Known limitation: no face or number-plate detector is configured, so a completion photograph stays `needs_review` with no published derivative — the citizen sees the claim description and a line saying why the photograph cannot be shown.

- [ ] **V036 — Add supervisor queues and deterministic ageing alerts**
  - Prerequisites: V017, V033, V034, V035
  - Owner: Backend + Frontend
  - Build: Provide supervisor views of unacknowledged, overdue, critical, disputed, and reopened issues. Implement configured ageing and escalation rules with explicit pause conditions, deduplicated alert events, and reviewed severity overrides.
  - Done when: Clock-driven tests show alerts occur once per intended rule window; age survives reassignment, and internal demo alerts are not represented as notifications delivered to real officials.

- [ ] **V037 — Specify analytics populations, denominators, and time semantics**
  - Prerequisites: V003, V029, V035
  - Owner: Data + Product
  - Build: Define current backlog, accepted issue cohorts, fixed-window resolution, time to resolution, disputed closures, reopening, unique contributors, and estimated population served. Keep cohort status as of a date separate from fixed-window comparisons; include only sufficiently observed cohorts in the latter and specify whether reopening within the observation window invalidates resolution. Specify boundary versions, unknown values, and late corrections.
  - Done when: Every metric has a reproducible formula and denominator. Resolved-only speed does not hide unresolved cases; local distinct counts and population estimates cannot be summed without valid aggregation rules.

- [ ] **V038 — Build replayable regional and category summaries**
  - Prerequisites: V017, V028, V029, V035, V037
  - Owner: Data + Backend
  - Build: Project authoritative records and events into summary tables for the chosen district and categories. Deduplicate events and handle merges, separations, late updates, reassignment, reopening, and corrected jurisdiction attribution.
  - Done when: A clean rebuild matches incremental summaries on test histories. Summary freshness and reconciliation failures are observable, and retries cannot increase counts.

- [ ] **V039 — Build the district dashboard with evidence drill-down**
  - Prerequisites: V030, V036, V037, V038
  - Owner: Frontend + Data
  - Build: Display category, jurisdiction, backlog age, closure cohorts, and reopening using prepared summaries. Show data coverage, metric definitions, update timestamps, and links through canonical issues to original authorized evidence.
  - Done when: Dashboard totals reconcile to the defined source population; users can distinguish zero from missing coverage and navigate from a regional indicator to its supporting records.

- [ ] **V040 — Import scoped contextual data with lineage**
  - Prerequisites: V004, V010, V011, V012, V013
  - Owner: Data
  - Build: Load permitted or clearly synthetic asset, enrolment or population, access, and investment records for the selected district. Preserve source snapshots, licenses, units, identifiers, extraction dates, and missing-data indicators.
  - Done when: Every displayed context value links to a source record or is visibly synthetic. Invalid units, stale records, and unmatched assets are reported rather than converted into plausible values.

- [ ] **V041 — Link issues to sanctioned projects with reviewable evidence**
  - Prerequisites: V028, V032, V040
  - Owner: Data + Backend
  - Build: Propose project links using asset identifiers, geography, scope, dates, and source evidence. Store confirmed, rejected, ambiguous, and unmatched links separately, with matching method and reviewer provenance.
  - Done when: The demo shows one defensible link and one ambiguous or absent match. No match is never translated into a claim that government has not funded the asset.

- [ ] **V042 — Implement transparent prioritization and sensitivity checks**
  - Prerequisites: V002, V025, V037, V040, V041
  - Owner: Data + Product
  - Build: Implement a versioned deterministic recommendation policy using available severity, persistence, service population, alternatives, accessibility, equity, and existing-project context. Disclose weights, missing data, budget assumptions, and evidence limits.
  - Done when: A lower-reporting high-need case can rank appropriately for explainable reasons. Changing plausible weights exposes rank sensitivity, and neither an arbitrary score nor model prose is presented as optimal public spending.

- [ ] **V043 — Build the policy decision and investment comparison view**
  - Prerequisites: V030, V039, V041, V042
  - Owner: Frontend + Data
  - Build: Show candidate interventions, component scores, source-backed need, linked sanctioned projects, alternatives, and recorded outcomes. Permit drill-down and scenario comparison while preserving the recommendation policy version.
  - Done when: A reviewer can explain why one intervention ranks above another, identify unsupported assumptions, and distinguish recorded outcomes during a project from proof that spending caused those outcomes.

- [ ] **V044 — Complete demo notices and private-data handling**
  - Prerequisites: V002, V005, V015, V019, V021, V030, V032
  - Owner: Security + Frontend
  - Build: Apply the approved demonstration data rules to capture notices, public redaction, model inputs, draft cleanup, logs, exports, and deletion requests. Explain simulated identity and departmental integration at the relevant screens.
  - Done when: A documented sample-data audit finds no undisclosed identity records or unnecessary personal information in public views, model traces, logs, or repository fixtures.

- [ ] **V045 — Run the comparative citizen usability experiment**
  - Prerequisites: V019, V020, V024, V031, V044
  - Owner: Product + QA
  - Build: Test the same representative reporting task with a small consenting participant group using the prototype and a suitable existing flow without filing real complaints. Counterbalance order and record completion time, assistance, errors, and understanding. Explicitly test keyboard-only operation, a screen reader, text zoom, selected UI languages, and a constrained mobile/network profile; include reporting, duplicate confirmation, and report tracking.
  - Done when: Results include sample size, test conditions, accessibility observations, and limitations. Blocking accessibility and reporting failures are corrected and retested before release or comparative effort claims; foundational accessibility is not deferred to V065.

- [ ] **V046 — Run held-out AI, routing, and deduplication evaluation**
  - Prerequisites: V011, V023, V024, V025, V027, V028, V033, V041, V042
  - Owner: AI + QA
  - Build: Run the frozen holdout with recorded model, prompt, taxonomy, and data versions. Compare classification and routing to reviewed labels, measure candidate recall and incorrect merges separately, and assess unsupported recommendation statements.
  - Done when: A reproducible report gives per-language and per-category results, abstention coverage, error examples, latency, and cost. No failures are hidden by replacing the holdout with rehearsal examples.

- [ ] **V047 — Exercise security and abuse boundaries end to end**
  - Prerequisites: V015, V016, V023, V029, V032, V035, V044
  - Owner: Security + QA
  - Build: Test authorization bypass, cross-jurisdiction access, media abuse, forged identity fields, repeated contribution requests, secret exposure, and instructions embedded in text or images. Verify output validation and bounded server resource use.
  - Done when: Critical findings are fixed and regression checked. Untrusted evidence cannot invoke administrative operations, change credentials, fetch arbitrary internal URLs, or silently publish private content.

- [ ] **V048 — Test concurrency, recovery, and analytics corrections**
  - Prerequisites: V022, V028, V029, V035, V036, V038, V041
  - Owner: Backend + QA
  - Build: Exercise simultaneous first reports, stale confirmations, overlapping merges, repeated acknowledgments, task reordering, crash boundaries, reopened closures, and late project corrections. Compare derived state with an authoritative rebuild.
  - Done when: All targeted histories preserve canonical issue membership, uniqueness, permitted state transitions, and metric denominators. Unrecoverable states are visible with an operator repair procedure.

- [ ] **V049 — Measure performance and establish operating budgets**
  - Prerequisites: V006, V013, V023, V026, V039, V043, V048
  - Owner: Platform + QA
  - Build: Measure receipt latency, processing delay, candidate-query latency, dashboard latency, upload behavior, database connections, storage growth, and AI cost under an explicitly sized synthetic workload. Tune indexes, pools, and queue limits from results.
  - Done when: The team records workload, hardware or service settings, percentile results, cost assumptions, and failure limits. No national-scale capacity claim is extrapolated solely from a small demonstration.

- [ ] **V050 — Install monitoring and prepare the demo operations runbook**
  - Prerequisites: V017, V022, V047, V048, V049
  - Owner: Platform
  - Build: Instrument correlated requests, outbox lag, queue age, stage failures, model cost, database saturation, and summary freshness without logging private payloads. Document incident response, safe replay, migration rollback, and demo data recovery.
  - Done when: A deliberate processing failure produces a useful alert and can be diagnosed using IDs and state. Runbooks name owners and distinguish demo recovery from the stronger pilot restore-drill gate.

- [ ] **V051 — Deploy the demonstration environment reproducibly**
  - Prerequisites: V006, V016, V017, V043, V044, V047, V049, V050
  - Owner: Platform + Backend
  - Build: Deploy the selected API, private worker, PWA, database, task queue, and private storage with explicit service identities, secrets, origins, and resource caps. Load permitted demo fixtures and enable real Gemini through the adapter.
  - Done when: The deployed environment passes smoke checks, uses genuine Google AI, and labels mock identity and government providers. Deployment does not wait for DigiLocker onboarding or a government partnership.

- [ ] **V052 — Pass the full hackathon demonstration acceptance test**
  - Prerequisites: V031, V035, V036, V043, V045, V046, V047, V048, V049, V050, V051
  - Owner: Product + QA
  - Build: Demonstrate multilingual capture, same-issue confirmation, a nearby distinct defect, unique counts, staff action, a sourced project match, need-based prioritization, closure dispute, and reopening in the deployed environment.
  - Done when: The rehearsed path uses real inference and clearly labeled simulated history where needed. The team records unresolved limitations, measured results, and a recoverable fallback for a live provider outage.

- [ ] **V053 — Prepare the hackathon submission package**
  - Prerequisites: V004, V006, V046, V049, V052
  - Owner: Product + Team
  - Build: Prepare the evaluator-accessible repository, deployed prototype, demo video, pitch deck, concise solution description, architecture, setup instructions, source attribution, and AI evaluation evidence to the current organizer requirements.
  - Done when: All links and credentials intended for evaluators work; media and slide lengths meet the current rules; contributions, reused components, synthetic data, and simulated integrations are disclosed consistently.

- [ ] **V054 — Approve the hackathon release gate**
  - Prerequisites: V001, V002, V003, V004, V005, V006, V007, V008, V009, V010, V011, V012, V013, V014, V015, V016, V017, V018, V019, V020, V021, V022, V023, V024, V025, V026, V027, V028, V029, V030, V031, V032, V033, V034, V035, V036, V037, V038, V039, V040, V041, V042, V043, V044, V045, V046, V047, V048, V049, V050, V051, V052, V053
  - Owner: Product + Team
  - Build: Review the complete Foundation and Hackathon checklist, submission rules, demo claims, unresolved defects, and evidence for each acceptance criterion. Freeze the demonstrated scope and preserve the evaluated version.
  - Done when: All required release acceptance criteria pass, declared demonstration limitations match the capability matrix, and the evaluated submission version is preserved. No Pilot or Scale task is a dependency, and the package accurately represents delivered capability.

## Pilot

- [ ] **V055 — Agree an authorized pilot with named operational owners**
  - Prerequisites: V054
  - Owner: Product + Partnerships
  - Build: Select a participating authority, geography, category, reviewer team, and actual receiving department. Agree permitted data exchanges, staff capacity, escalation responsibilities, success measures, stop conditions, and pilot duration.
  - Done when: Named partners accept the operating workflow and acknowledge their responsibilities. A public routing directory alone does not count as a government integration or pilot commitment.

- [ ] **V056 — Approve pilot consent, privacy, identity, and retention policy**
  - Prerequisites: V005, V044, V055
  - Owner: Security + Product + Partnerships
  - Build: Review the actual pilot data flows with appropriate privacy and legal advisers. Finalize notices, consent records, identity purpose, location requirements, access roles, public redaction, retention, deletion, incident handling, and applicable participant restrictions.
  - Done when: Accountable owners approve the policy and operational procedures before collecting real pilot identity or location evidence. Storage, AI processing, backups, and downstream exports follow the same approved policy.

- [ ] **V057 — Integrate real citizen identity and production staff authentication**
  - Prerequisites: V008, V009, V015, V055, V056
  - Owner: Backend + Partnerships
  - Build: Complete the required DigiLocker or other approved provider onboarding and implement only documented supported flows. Verify the identifier available to this integration, consent exchange, token validation, account linking, recovery, revocation, and secure pseudonymous mapping. Connect production citizen sign-in to the application sessions from V009. Implement approved staff sign-in with MFA, controlled invitations and role/jurisdiction grants, account suspension, recovery, and session revocation; citizen verification cannot confer staff privileges.
  - Done when: Provider-approved test cases demonstrate the intended uniqueness behavior and failure paths. Real identity verification is enabled only after credentials, permissions, and identifier semantics are confirmed; simulated accounts remain distinguishable and cannot authenticate in production. Staff onboarding, least-privilege access, recovery, and deprovisioning are tested.

- [ ] **V058 — Integrate an authorized government recipient with acknowledgment**
  - Prerequisites: V008, V010, V033, V034, V036, V055, V056
  - Owner: Backend + Partnerships
  - Build: Replace the simulated recipient with an approved API, partner dashboard, or explicitly agreed operational channel. Implement reference mapping, authenticated receipt or acknowledgment, rejection, retries, reconciliation, and recipient ownership.
  - Done when: A controlled test produces a verifiable acknowledgment from the actual receiving authority. Transport delivery and Vision's own staff action are not substituted for evidence of official receipt.

- [ ] **V059 — Validate the pilot's identity and onsite-evidence gate**
  - Prerequisites: V002, V020, V025, V056, V057
  - Owner: Security + Mobile or Frontend + QA
  - Build: Implement the approved onsite policy using fresh location, accuracy, capture timing, replay resistance, and available platform signals. Test poor GPS, denied permissions, stale drafts, shared devices, account recovery, and attempted spoofing.
  - Done when: Measured platform limitations and false rejections are documented, review paths are staffed, and presence labels reflect supported evidence strength. Identity verification is not used as a substitute for physical-presence evidence.

- [ ] **V060 — Validate pilot boundaries, assets, and responsibility mappings**
  - Prerequisites: V004, V026, V033, V040, V055, V056
  - Owner: Data + Partnerships
  - Build: Replace demonstration directories with reviewed pilot assets, jurisdiction boundaries, and department responsibility rules. Preserve effective dates, stable source identifiers, overlaps, ownership disputes, and rural or urban hierarchy differences.
  - Done when: Partner-reviewed samples route to the correct authority, boundary changes preserve history, and missing or contested ownership enters an operational review queue.

- [ ] **V061 — Operationalize contextual and project data feeds**
  - Prerequisites: V004, V040, V041, V042, V055, V056, V060
  - Owner: Data + Partnerships
  - Build: Implement approved pilot source refreshes with licensing, authentication, schema checks, lineage, freshness monitoring, and reconciliation. Review project matching and priority assumptions with staff who understand local delivery constraints.
  - Done when: Real source updates reproduce a source-backed recommendation; stale or absent feeds are visible, and operational reviewers approve how uncertainty affects project links and priority.

- [ ] **V062 — Pass the pilot security, retention, and restore drill**
  - Prerequisites: V047, V048, V049, V050, V056, V057, V058, V059, V060, V061
  - Owner: Platform + Security + QA
  - Build: Exercise backups and restoration in an isolated environment, including database state, evidence access, outbox replay, secrets, audit history, and deletion propagation. Recheck real adapters, pilot load, alerts, support ownership, and access boundaries.
  - Done when: Measured recovery point and recovery time satisfy agreed pilot objectives. Restored systems do not resurrect deleted public data or replay external actions incorrectly; critical findings and retention failures are resolved.

- [ ] **V063 — Run partner acceptance across a controlled real workflow**
  - Prerequisites: V035, V036, V043, V055, V056, V057, V058, V059, V060, V061, V062
  - Owner: Product + Partnerships + QA
  - Build: Using agreed test records and consenting participants, exercise real identity, onsite evidence, actual recipient acknowledgment, staff ownership, contextual prioritization, completion evidence, dispute, and reopening with the pilot team.
  - Done when: Both Vision and the receiving authority sign off the controlled results, observed limitations, support process, and response expectations. Any unavailable required integration remains a pilot blocker rather than a simulated success.

- [ ] **V064 — Approve limited pilot launch and review its outcomes**
  - Prerequisites: V055, V056, V057, V058, V059, V060, V061, V062, V063
  - Owner: Product + Partnerships + Security
  - Build: Authorize the agreed cohort, geography, and duration only after consent, identity and presence limits, actual acknowledgment, privacy and retention, security, restore, and staff-capacity gates pass. Review outcomes at the pre-agreed checkpoints.
  - Done when: The pilot has explicit launch approval, monitored operating limits, stop conditions, and a recorded continuation decision based on adoption, response, correction, and resolution evidence rather than report volume alone.

## Scale

- [ ] **V065 — Extend accessibility and low-connectivity participation**
  - Prerequisites: V020, V045, V056, V059, V064
  - Owner: Product + Frontend + Partnerships
  - Build: Review screen-reader access, language coverage, constrained devices, assisted reporting, intermittent connectivity, and mobility-related barriers using pilot findings. Define any alternative participation modes with explicit identity and presence semantics.
  - Done when: Representative users validate the added modes and policy owners approve them. Remote support or assisted input cannot silently count as independently verified onsite evidence.

- [ ] **V066 — Add richer media and longer infrastructure histories**
  - Prerequisites: V021, V025, V030, V049, V056, V062, V064
  - Owner: Backend + AI + Platform
  - Build: Add bounded video and richer audio processing, long-running job orchestration where justified, lifecycle storage classes, efficient previews, and longitudinal comparison. Preserve originals, derivation lineage, and meaningful recurrence evidence.
  - Done when: If adopted, new media paths meet measured cost and latency budgets, support recovery and deletion, and expose comparison uncertainty without claiming automated engineering certification or perfect manipulation detection. If pilot evidence does not justify richer media, record a reviewed deferral and retain the validated photo/text/voice path; video is not a prerequisite for geographic expansion.

- [ ] **V067 — Onboard additional jurisdictions, categories, and languages**
  - Prerequisites: V046, V056, V058, V060, V061, V064, V065
  - Owner: Data + AI + Partnerships
  - Build: Review each new authority's responsibility mapping, assets, boundaries, taxonomy, language data, partner workflow, and consent requirements. Run targeted evaluation and capacity checks before enabling public reporting in that jurisdiction.
  - Done when: Each expansion has named recipients, reviewed mappings, source coverage, documented model performance, and operational support; national geography is not enabled merely because a map can display it.

- [ ] **V068 — Introduce BigQuery when historical analytics warrants it**
  - Prerequisites: V037, V038, V049, V056, V062, V064, V067
  - Owner: Data + Platform
  - Build: Implement a measured migration to partitioned historical tables, deduplicated ingestion, current-state snapshots, and regional summaries. Validate event time, corrections, canonical aliases, jurisdiction history, deletion propagation, and distinct-person aggregation.
  - Done when: If adopted, warehouse results reconcile with authoritative records and replayed histories under late events, merges, and reopening; partition filters, costs, freshness, and integrity checks are enforced independently of unenforced key declarations. If measurements do not justify a warehouse, record a reviewed deferral with capacity evidence and continue using reconciled PostgreSQL summaries.

- [ ] **V069 — Scale transactional storage and delivery from measured bottlenecks**
  - Prerequisites: V026, V028, V048, V049, V062, V064, V067
  - Owner: Platform + Backend
  - Build: Benchmark growth and selectively add archival or partitioning, read replicas, caching, improved vector retrieval, or queue segmentation. Preserve global uniqueness, matching recall, migration safety, connection budgets, and outbox correctness.
  - Done when: Each change resolves a measured constraint and passes invariant and recovery tests. Approximate matching recall and replica staleness cannot silently change canonical issue or staff-action decisions.

- [ ] **V070 — Add authorized notification and submission channels**
  - Prerequisites: V008, V017, V036, V056, V058, V064, V065, V067
  - Owner: Backend + Product + Partnerships
  - Build: Review and integrate needed messaging, email, SMS, or partner channels through provider adapters with consent and preferences, signed callbacks, rate limits, deduplicated delivery, and clear identity-linking rules.
  - Done when: Each adopted channel passes provider and privacy review, duplicate and opt-out tests, and failure reconciliation. Message delivery does not count as agency acknowledgment, onsite presence, or a new unique participant. A reviewed decision to retain the web receipt and tracking flow is valid when no additional channel is justified for the expansion.

- [ ] **V071 — Extend investment, contractor, and historical outcome analysis**
  - Prerequisites: V037, V041, V042, V056, V061, V064, V067, V068
  - Owner: Data + Product + Partnerships
  - Build: Add reviewed funding, procurement, contractor, execution, recurring-defect, and contextual tenure histories when reliable sources exist. Preserve project identity, agency responsibility, inherited backlog, boundary versions, coverage, and source corrections.
  - Done when: Adopted comparisons use documented comparable cohorts and denominators, provide source drill-down and correction routes, and distinguish outcomes recorded during a tenure from claims of individual causation or an authoritative political score. Where sources are insufficient or the feature is not justified, record a reviewed deferral; tenure and contractor comparisons are not prerequisites for geographic expansion.

- [ ] **V072 — Approve staged national expansion using operational evidence**
  - Prerequisites: V064, V065, V066, V067, V068, V069, V070, V071
  - Owner: Product + Platform + Partnerships + Security
  - Build: Review adoption, actual acknowledgment, resolution and reopening cohorts, model errors, low-reporting coverage, accessibility, equity sensitivity, capacity, cost, privacy, source freshness, and disaster recovery for each expansion wave. Review both implemented results and explicit evidence-backed deferrals for optional media, warehouse, messaging, and historical-analysis tasks.
  - Done when: Expansion proceeds only where recipients and operational capacity exist and agreed measures remain acceptable; it does not require adopting an optional technology or feature that measurements do not justify. Unsupported geography or data gaps remain visible; rollback, retraining review, and corrective action have named owners.
