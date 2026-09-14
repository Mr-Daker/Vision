"""Vision system-design manuscript and primary-source register."""

SOURCES = {
 'event': ('Hack2skill', 'Code for Communities 2.0', 'https://hack2skill.com/event/codeforcommunities2', 'Live event page, checked 9 September 2026', 'Track requirements and submission deliverables.'),
 'requester': ('DigiLocker', 'Become a Requester', 'https://www.digilocker.gov.in/web/partners/requesters', 'Live partner documentation', 'Requester integration and partner credentials.'),
 'sop': ('DigiLocker', 'Standard Operating Procedure for Partners', 'https://cf-media.api-setu.in/resources/Partners-SOP.pdf', '5 June 2024, pages 1–4', 'Organisation eligibility, vetting, agreement and go-live process.'),
 'oidc': ('NeGD / MeitY', 'Requester Meri Pehchaan API specification v2.3', 'https://cf-media.api-setu.in/resources/Requester-MeriPehchaan-APISpecification-V2_3.pdf', 'September 2023; revision history 15 September 2023', 'Authorisation, consent, account identifiers and transient reference keys.'),
 'lgd': ('Ministry of Panchayati Raj / NIC', 'Local Government Directory', 'https://lgdirectory.gov.in/', 'Live directory', 'Dated government codes, historical changes and local-body mappings.'),
 'kys': ('Department of School Education and Literacy / NIC', 'Know Your School', 'https://kys.udiseplus.gov.in/home/?searchStrShowOnRsltPage=udrs+2.0', 'Displayed version 23 September 2025', 'Official public school lookup; not a verified bulk-data API.'),
 'udise': ('Department of School Education and Literacy / NIC', 'UDISE+ Data Sharing registration', 'https://microdata.udiseplus.gov.in/register', 'Undated live registration page', 'Separate registration and verification for shared datasets.'),
 'egram': ('National Informatics Centre', 'eGramSwaraj', 'https://www.nic.gov.in/project/egramswaraj/', 'Updated 27 May 2026', 'LGD-linked rural planning, progress, accounts, assets and geotagging.'),
 'dpdp': ('MeitY / Gazette of India', 'DPDP Act commencement notification G.S.R.843(E)', 'https://www.meity.gov.in/static/uploads/2025/11/c56ceae6c383460ca69577428d36828b.pdf', '13 November 2025', 'Staged commencement, not simultaneous operation of every provision.'),
 'geo': ('W3C', 'Geolocation', 'https://www.w3.org/TR/geolocation/', 'Living specification', 'Device-location permissions, accuracy and limits of location assurance.'),
 'pgportal': ('DARPG', 'CPGRAMS public grievance portal', 'https://pgportal.gov.in/', 'Live government portal', 'Official complaint channels; email is not an accepted grievance channel.'),
 'tasksrun': ('Google Cloud', 'Executing asynchronous tasks', 'https://docs.cloud.google.com/run/docs/triggering/using-tasks', 'Updated 1 September 2026', 'Private Cloud Run workers invoked through Cloud Tasks.'),
 'tasks': ('Google Cloud', 'Cloud Tasks issues and limitations', 'https://docs.cloud.google.com/tasks/docs/common-pitfalls', 'Updated 26 August 2026', 'Duplicate execution, unordered delivery and backoff.'),
 'pool': ('Google Cloud', 'Manage PostgreSQL database connections', 'https://docs.cloud.google.com/sql/docs/postgres/manage-connections', 'Updated 28 August 2026', 'Connection limits, bounded pooling and transaction retries.'),
 'serial': ('PostgreSQL Global Development Group', 'Transaction isolation', 'https://www.postgresql.org/docs/current/transaction-iso.html', 'PostgreSQL 18 documentation', 'Serializable isolation and complete-transaction retries.'),
 'postgis': ('PostGIS project', 'ST_DWithin', 'https://postgis.net/docs/ST_DWithin.html', 'Rolling reference', 'Index-aware proximity queries and geography distance in metres.'),
 'vector': ('pgvector project', 'pgvector README', 'https://github.com/pgvector/pgvector', 'Rolling repository; fetched documentation references v0.8.6', 'Exact search, approximate search and post-index filtering limitations.'),
 'gemini': ('Google AI for Developers', 'Structured outputs', 'https://ai.google.dev/gemini-api/docs/structured-output', 'Updated 2 September 2026', 'JSON Schema subset and semantic validation requirements.'),
 'security': ('Google Cloud', 'AI security and safety', 'https://docs.cloud.google.com/mcp/ai-security-safety', 'Updated 28 August 2026', 'Prompt injection and least-privilege boundaries; applied here to a non-agent classification pipeline.'),
 'bq': ('Google Cloud', 'Optimize query computation', 'https://docs.cloud.google.com/bigquery/docs/best-practices-performance-compute', 'Updated 3 September 2026', 'Partition pruning, preaggregation and unenforced key constraints.'),
 'signed': ('Google Cloud', 'Signed URLs', 'https://docs.cloud.google.com/storage/docs/access-control/signed-urls', 'Live documentation', 'Time-limited object access and bearer-link handling.'),
 'forms': ('W3C Web Accessibility Initiative', 'Forms Tutorial', 'https://www.w3.org/WAI/tutorials/forms/', 'Updated 27 March 2026', 'Short forms, labels, instructions and actionable errors.'),
 'offline': ('Google web.dev', 'Offline data', 'https://web.dev/learn/pwa/offline-data', 'Live PWA guidance', 'IndexedDB for structured data and blobs; cache storage for resources.'),
 'vitals': ('Google web.dev', 'Web Vitals', 'https://web.dev/articles/vitals', 'Updated 31 October 2024', 'LCP, INP and CLS targets measured at the 75th percentile.'),
}

PAGES = []
def page(*blocks): PAGES.append(list(blocks))
def H(text): return ('h1', text)
def S(text): return ('h3', text)
def P(text, *refs): return ('p', text, refs)
def B(text): return ('list', text)
def T(headers, rows): return ('table', headers, rows)
def F(kind,caption): return ('figure',kind,caption)

page(
 H('1. Abstract'),
 P('Vision is a single, accessible entry point for reporting physical public-infrastructure problems. A citizen supplies a location, evidence and a short description. The system proposes structure, connects reports about the same defect, preserves a traceable history, and gives a participating department an actionable queue. Public and policy views show outcomes without exposing citizen identity.'),
 P('Recommended implementation: a TypeScript progressive web app, a modular API and asynchronous worker, PostgreSQL with PostGIS and pgvector, private object storage, and Gemini for multilingual evidence understanding. Keep durable facts in PostgreSQL. Use AI for proposed observations, never as the authority for identity, official delivery, engineering safety certification or expenditure approval.'),
 H('2. Goals and Non-Goals'),
 T(['Goals','Non-goals'],[
 ['Reduce reporting effort and measure completion, time and abandonment.','Promise that identity checks or GPS make every submission genuine.'],
 ['One canonical issue with evidence, unique participation and a reversible history.','Count submissions as people or infer affected population from votes.'],
 ['Explain routing, ownership, resolution and category/geography analytics.','Claim government integration or physical repair merely because a record was created.'],
 ['Prove one district and school-infrastructure workflow, then expand.','Build every department, national warehouse and native app before demonstrating value.']]),
 H('3. Background and Problem Statement'),
 P('The supplied Team Vision brief identifies fragmented reporting, repeated complaints, weak trust, missing asset history and disconnected planning data. These are product hypotheses to test with citizens and operators, not proven adoption or impact results. The distinction is “report what you see; Vision structures it,” followed by a visible next action.'),
 P('The hackathon governance track calls for multilingual requests, public-context and investment data, hotspot analysis and development priorities. Therefore a polished complaint form alone is insufficient. The demo must connect reporting to a source-labelled planning view and an end-to-end outcome workflow, using real Google AI and clearly labelled sample integrations.', 'event'),
)

page(
 H('4. Proposed Architecture'),
 F('architecture','Figure 1. Operational architecture and external trust boundaries.'),
 T(['Component','Responsibility','Storage','Failure behavior'],[
 ['Citizen and staff PWA','Capture, receipts, issue history and scoped work queues.','Device drafts; API reads','Keep draft; show pending, not submitted.'],
 ['TypeScript API','Auth, contracts, quotas and atomic domain changes.','PostgreSQL','Return a durable receipt only after commit.'],
 ['Worker and relay','Media checks, Gemini, matching and notifications.','Jobs and outbox','Retry bounded stages; expose stuck work.'],
 ['Policy modules','Trust, routing, dedup, lifecycle and prioritisation.','Versioned rules and events','Unknowns enter review, not invented facts.'],
 ['External adapters','Identity, approved recipient and public-data imports.','Provenance and delivery receipts','Simulator in demo; unavailable in live UI.']]),
)

page(
 S('Architecture boundaries and repository design'),
 P('Use one repository and shared domain packages, not a microservice per feature. Deploy the web app, API and private worker separately for resource isolation. Suggested runtime is React/Next.js for the PWA, Fastify for the API, and a TypeScript HTTP worker. These are planning choices, not user-imposed technologies; pin supported versions when scaffolding.'),
 T(['Layer','Proposed location','Import rule'],[
 ['Contracts','packages/contracts','Schemas, identifiers, errors and adapter interfaces; imports no application layer.'],
 ['Domain','packages/domain','Pure policy and state transitions; imports contracts only.'],
 ['Adapters','packages/adapters','Postgres, storage, Gemini, identity and recipient clients implement interfaces.'],
 ['Applications','apps/web, apps/api, apps/worker','Compose domain and adapters. Domain never imports an application.'],
 ['Verification and operations','tests, infra, evals','Exercise published interfaces, migrations and deployable applications.']]),
 S('Recommended deployment'),
 P('Use Cloud Run for API and worker, Cloud SQL PostgreSQL for authoritative records, Cloud Storage for private media, Cloud Tasks for bounded HTTP jobs, Cloud Scheduler for an outbox relay, and Secret Manager for credentials. Use separate service accounts and development, staging and production environments. A task caller receives only worker-invocation permission.', 'tasksrun'),
 P('Start local development with PostgreSQL extensions, local object-storage and queue adapters, seeded identities and a deterministic AI stub. Keep the real Gemini adapter in the hackathon path. Replace approved identity and department adapters later without rewriting the UI or issue domain. A simulator must never mint a production verified badge.'),
 S('Three distinct user experiences'),
 P('Citizen: report, review a possible duplicate and track outcomes. Staff: accept or transfer work, inspect evidence, assign an owner and document action. Analyst: filter categories and boundaries, compare defined outcomes, inspect source coverage and drill down to redacted evidence. The citizen homepage is not the policy dashboard.'),
)

page(
 H('5. Request Lifecycle'),
 F('flow','Figure 2. Capture, durable processing, matching and resolution loop.'),
 S('Capture and durable submission'),
 B('Offer Marathi (mr-IN) and English (en-IN) locale selection throughout the citizen path, with photo and text or recorded voice in the first release; bounded video is a later extension. Preserve original-language input and retain the draft when locale changes. Ask location permission in context. Show an editable pin while retaining the device observation separately. Never require category, severity or department selection.'),
 B('Keep a device draft in IndexedDB with a client-generated request ID. Save progress across a connection loss. Clear sensitive drafts on explicit completion/logout under the agreed shared-device policy; explain that local-only data may be lost. Foreground retry must work even where background sync does not.',),
 B('Authenticate, show consent and complete the configured identity flow before counting a verified contribution. Request a short-lived upload session. Send bytes directly to private staging storage; finalize only after the server checks ownership, object generation, content size and permitted type.'),
 B('POST the description, observed location, upload IDs and capture claims with an idempotency key. One transaction writes the submission, receipt, initial processing state and outbox event. Return 202 with a status URL. AI processing never blocks the acknowledgement of durable receipt.'),
 P('IndexedDB is suitable for structured drafts and blobs; cache storage is for application resources. A signed storage URL is a bearer capability, so never log or publish it. Store provider secrets only on the server.', 'offline','signed'),
)

page(
 S('Processing and evidence assurance'),
 P('Each worker stage loads an immutable input version, claims a bounded lease and records its outcome. Media processing decodes files under memory/time limits, rejects unsupported or malicious content, creates thumbnails, extracts metadata and computes exact and perceptual hashes. Quarantine before publication. Keep a protected original only when the approved retention purpose requires it; expose redacted derivatives.'),
 T(['Signal','What it can support','What it cannot establish'],[
 ['Account verification','Link repeat participation to a provider-scoped account.','One natural person across all providers, truthful evidence or affected status.'],
 ['Location and freshness','Consistency of a claimed observation with time, accuracy and nearby asset.','Proof that a browser or person physically attended.'],
 ['Hash and media similarity','Reused bytes or visually similar content.','That a new file is authentic, or reused evidence is necessarily fraud.'],
 ['Multimodal agreement','Whether text, image and location appear consistent.','Engineering diagnosis or a calibrated truth probability.'],
 ['Independent corroboration','Additional observations from distinct qualifying identities.','The total population affected or absence of coordination.']]),
 P('Browser geolocation explicitly does not guarantee the device’s actual location. Keep the user’s onsite-only contribution policy as a product requirement, but label browser checks as location consistency. Stronger assurance needs an approved threat model, possible device attestation or an authorised field witness; even these are risk controls, not certainty.', 'geo'),
 S('AI understanding'),
 P('Gemini classification receives approved redacted media, transcript or text, and versioned taxonomy entries. Location remains a separate deterministic matching and routing signal and is not sent to classification. Gemini proposes source language, category ID, defect, asset clues, severity, evidence references and unknowns. Validate all fields server-side: schema-valid output can still be wrong. A separate embedding adapter produces versioned text and image vectors; matching never compares incompatible models or dimensions.', 'gemini'),
 P('Keep observed damage separate from the need for urgent inspection. A possible dangerous structure triggers human triage even when evidence is uncertain; it does not become a safety certificate. Unsupported “94% genuine” labels are excluded. Display individual assurance signals and a policy-based review state until a calibrated score is actually evaluated.'),
)

page(
 S('Issue matching and the owned next action'),
 B('Find candidate assets/issues using an indexed geography radius, GPS accuracy, asset type and time window. Include neighbours across administrative boundaries. ST_DWithin on geography uses metres; do not apply a metre threshold to longitude/latitude geometry degrees.'),
 B('Rerank the bounded candidates with exact semantic/image similarity and asset clues. Compare actual defects, not just proximity: a roof and a boundary wall at one school may be distinct. Ask “Is this the same problem?” for a plausible match. Low certainty goes to review; no match creates a new issue only after a transactional recheck.'),
 B('For an existing issue, attach evidence and upsert participation. One verified identity counts once per canonical issue, even after retries or merges. The same person may add later evidence, dispute closure or report another problem without another count on this issue.'),
 B('Resolve the asset custodian and jurisdiction against a dated routing registry. Vision proposes a responsible department; a reviewer handles ambiguous ownership. The recipient adapter creates an outbound delivery record and waits for a reference or signed acknowledgement. Unsupported jurisdictions remain visibly unconnected.'),
 B('A participating officer acknowledges, accepts or transfers the issue with a reason and next-action owner. A supervisor sees unacknowledged, ageing and critical queues. The SLA clock uses an agreed policy; internal reminders do not imply a statutory deadline or official escalation.'),
 B('Staff attach action and after-repair evidence before claiming resolution. Citizen corroboration and/or an authorised inspection verifies the outcome under a published policy. Disputes preserve the claim and reopen the issue. A later recurrence links to the same asset but may be a new issue episode.'),
 P('Exact spatial candidate selection is the initial default. Approximate pgvector filtering can miss candidates and cannot prove no duplicate exists. Store candidate lists and decisions so a mistaken merge can be reviewed and reversed.', 'postgis','vector'),
 P('Do not equate export, email or routing selection with official filing. CPGRAMS says emailed grievances are not entertained. A live recipient workflow needs its own permitted integration and acknowledgement; the hackathon can show a clearly labelled participating-department simulator.', 'pgportal'),
 S('Separate state machines'),
 P('Submission: draft → received → processing → needs review / accepted / rejected. Delivery: not connected → queued → sent → acknowledged / failed. Issue: open → assigned → in progress → resolution claimed → verified resolved; dispute leads to reopened. Keep who, when, why and prior version for every transition.'),
)

page(
 H('6. API and Data Contracts'),
 S('Authoritative entities'),
 T(['Entity','Identity and relationship','Invariant'],[
 ['Submission and media','Submission UUID; media ID and object generation.','Observation, not a unique issue or person.'],
 ['Issue and asset','Issue UUID, optional stable asset ID and episode.','Several defects and repair episodes per asset.'],
 ['Participation','Canonical issue ID + internal verified subject ID.','Database uniqueness; repeated evidence does not add participants.'],
 ['Verification','Provider-scoped subject, assurance method, scope, expiry and consent.','Separated protected mapping; no public government identifier.'],
 ['Issue event and merge','Event UUID, aggregate version, actor, reason and canonical aliases.','Append history; corrections and reversible merges are explicit events.'],
 ['Jurisdiction and routing','Source codes, dated boundary mappings and custodians.','Rural/urban paths and ownership, not one universal tree.'],
 ['Delivery and assignment','Issue, destination, attempt key, external reference and acknowledgement.','Assigned department and acknowledged receipt are different facts.'],
 ['Project and funding link','Source/project/contract IDs, stage, dates, match basis and review state.','No source match means unknown, never automatically unfunded.'],
 ['Job and outbox','Unique stage key, input hash, lease token, attempts and event ID.','Recoverable at-least-once work with idempotent database effects.']]),
 S('Storage and geographic model'),
 P('Use PostgreSQL relational constraints for facts, JSONB for versioned raw model/source payloads, a GiST spatial index for locations, and vectors for candidate ranking. Store images/audio/video in object storage, never base64 columns. Separate public read models from identity and raw-evidence tables.'),
 P('Persist UTC; localise display. Model dated village/panchayat/block and ward/urban-local-body paths to district/state separately. City totals require an explicit boundary; electoral areas are a separate overlay. Retain original and corrected geography for historical analysis.'),
)

page(
 S('Primary interfaces and validation'),
 T(['Interface','Input or action','Contract'],[
 ['POST /v1/uploads','Type, byte limit, draft ID','Authorised short-lived upload session; private destination.'],
 ['POST /v1/uploads/{id}/finalize','Object generation and upload reference','Server validation; owned, immutable media reference.'],
 ['POST /v1/submissions','Media IDs, text/voice, observations, consent version','Idempotency-Key required; 202 receipt and status URL.'],
 ['GET /v1/submissions/{id}','Receipt lookup','Owner-only detailed processing state; no guessed issue yet.'],
 ['POST /v1/submissions/{id}/match','Candidate ID or “different issue”','Server rechecks eligibility and canonical mapping.'],
 ['GET /v1/issues and /{id}','Bounds, category, status and cursor','Redacted results; capped radius/page size; canonical redirects.'],
 ['POST /v1/issues/{id}/actions','Assignment, transfer, resolution or dispute','Scoped actor, expected version and reason; invalid transitions fail.'],
 ['GET /v1/analytics','Boundary, cohort, category and as-of date','Defined metrics, coverage, sample flag and freshness watermark.'],
 ['POST /v1/integrations/{provider}/events','Signed external acknowledgement/update','Authenticate sender, reject replay and preserve external event ID.']]),
 S('Contract guarantees'),
 P('A submission carries coordinates and accuracy, observation and receipt times, capture claims, BCP 47 interface/source locales, locale-pack version, media IDs and optional text. Client-supplied identity, severity, trust or department fields are never authoritative. The server records pipeline, prompt, taxonomy, embedding and policy versions. Jurisdiction, locale, taxonomy and routing come from versioned configuration, never district-specific code.'),
 P('Use OpenAPI and shared runtime schemas as the interface source. Enforce bounds, media types, coordinate ranges, enumerations and ownership. Return actionable errors for validation, authorisation, version conflict, quota and unavailable dependencies. Never expose another citizen’s evidence through errors or hash lookup.'),
 P('Bind the idempotency key to actor, endpoint and request hash; a different payload with the same key returns conflict. Use optimistic version checks for staff changes. Paginate with opaque stable cursors, not unbounded offset queries. Notifications are a convenience; the receipt and issue timeline remain authoritative.'),
)

page(
 H('7. Consistency, Idempotency, and Replay'),
 P('Commit the domain change and outbox row together. The relay retries unsent rows; workers commit stage output and the next event before acknowledging. Cloud Tasks permits duplicate executions and does not guarantee order.', 'tasks'),
 T(['Scenario','Required behavior','Implementation'],[
 ['Submit retried after timeout','Same receipt, one submission.','Unique actor/idempotency key and request hash.'],
 ['Queue delivered twice','One committed stage result.','Unique submission/stage/pipeline key; completed stage is a no-op.'],
 ['Worker lease expires','An old worker cannot overwrite a new result.','Incrementing fencing token checked in the commit predicate.'],
 ['Database committed but enqueue failed','Receipt survives and processing resumes.','Transactional outbox plus relay and reconciliation alarms.'],
 ['Two concurrent “new issue” decisions','Recheck current candidates before final creation.','Short Serializable transaction; retry 40001 and refresh changed candidates.'],
 ['Merge and later unmerge','No lost evidence or inflated person counts.','Aliases, event history, set-union participation and reversible membership.'],
 ['Provider timeout after possible success','Do not blindly create a second external complaint.','Stable provider request ID; reconcile status or mark delivery uncertain.'],
 ['AI quota exhausted or permanent failure','Expose delayed/review state; no silent loss.','Bounded retries, backoff and persisted failed-job review/replay.']]),
 P('Run AI and media operations outside transactions. After inference, reread the candidate predicate and affected records in a short Serializable transaction; on conflict retry the entire transaction. If inputs or candidates changed, recompute outside it. Serializable isolation prevents transaction anomalies, not incorrect semantic matching.', 'serial'),
 P('Cache versioned model results by input hash. A crash after a paid call may incur another call; idempotent database outcomes do not mean exactly-once AI billing. Implement failed-job review explicitly; do not assume a Cloud Tasks dead-letter queue.'),
)

page(
 H('8. Security and Privacy Considerations'),
 S('Identity and participation policy'),
 P('DigiLocker is an identity adapter, not application login or proof of being affected. Requester access needs partner credentials; onboarding includes organisational eligibility, vetting, agreement and go-live approval. A student team cannot assume immediate production access.', 'requester','sop'),
 P('Demo identities must be visibly simulated. In a pilot, validate approved claim semantics, scopes and linking rules; map provider plus stable subject into a protected identity. DigiLocker’s ID identifies an account; reference_key is transient. Keep app login, verified account and onsite eligibility separate. Do not use raw Aadhaar hashes as universal person identifiers.', 'oidc'),
 P('One-person-per-issue is the policy; uniqueness of the approved identity key is the technical guarantee. Account verification cannot prove one natural person across all providers. Add rate limits, review and appeals. Hide identity publicly and restrict staff access.'),
 S('Accessible verification is a release decision'),
 P('Onsite verified participation can exclude people with poor GPS, identity-access barriers, disabilities or shared devices. Never ask someone to approach a dangerous structure. Assisted or unverified intake needs explicit policy approval before implementation. Measure verification drop-off separately from form speed; ease of reporting does not erase verification friction.'),
 S('Trust boundaries and data handling'),
 P('Apply role and jurisdiction checks on every server read/write; never trust a hidden UI button as authorisation. Require stronger staff sign-in, least-privilege service accounts and audited privileged actions. Use secure session handling, CSRF protection where cookie-authenticated, restricted CORS, upload quotas and rate limits. Isolate media decoders and validate content independently of filenames.'),
 P('Treat descriptions, OCR, transcripts and imported records as untrusted data. Classification has no SQL, publishing, identity-vault or arbitrary network capability. Reject fabricated reference IDs and policy changes in model output. Structured output and prompt wording do not create an authorisation boundary.', 'security'),
 P('Redact faces, children, number plates, contact details and sensitive locations before public display; allow human correction and takedown. Restrict originals and evidence hashes. Avoid logging text, precise coordinates, credentials and signed links. Configure retention by data class, purpose, consent and legal requirements; include derived media, vectors, exports and backups in deletion design.'),
 P('Before real intake, obtain qualified review of notice/consent, children’s data, processor terms, cross-border processing, retention and breach handling. The November2025 DPDP commencement notification is staged; not every provision is operative as of9September2026. Confirm launch-date obligations. This is not a compliance certification, and one hosting region does not establish residency across every provider.', 'dpdp'),
)

page(
 H('9. Operational Readiness'),
 S('Measure convenience and correctness before scale'),
 P('These are proposed targets, not results. Test 10–15 consenting people across Marathi and English, digital familiarity and accessibility needs. Compare the same scenario on Vision and a relevant portal, including verification time and abandonment. Report language-specific sample sizes and errors. Never file test grievances with real departments.'),
 T(['Signal','Proposed gate','Owner','Evidence'],[
 ['Citizen effort','≥80% unaided completion; median time and verification drop-off.','Product / UX','Observed sessions and sample limits.'],
 ['Web experience','p75 LCP ≤2.5s; INP ≤200ms; CLS ≤0.1.','Frontend','Declared device/network; lab and field tests.'],
 ['Model classification','Holdout macro-F1 ≥0.85; report language/category splits.','AI lead','Reviewed labels, confusion matrix and abstentions.'],
 ['Matching safety','No false merge in adversarial suite; measure recall.','Backend / AI','Nearby distinct defects, reuse and recurrence.'],
 ['Routing','≥95% correct among auto-routed in-scope cases; report coverage.','Domain owner','Reviewed custodian labels and abstentions.'],
 ['Receipt and processing','API p95 ≤500ms without upload; image pipeline p95 ≤60s.','Backend','Declared load, quotas, cold starts and errors.'],
 ['Integrity and privacy','Zero inflation or access leaks in defined tests.','QA / security','Race/retry/merge tests and access review.']]),
 P('Short forms, explicit labels, progress and recoverable errors support accessibility; keyboard, screen-reader, zoom and low-bandwidth tests are required. The Core Web Vitals thresholds use the 75th percentile and need field evidence for real-world claims.', 'forms','vitals'),
 P('Use a reviewed holdout of about 200 examples as a starting plan, split by asset/site so near-identical evidence does not leak between train/tuning and test. Include ambiguous ownership, unsupported languages, synthetic/reused media, injection text, low light and bad GPS. Publish small subgroup sizes and error examples; no observed zero-error sample proves universal reliability.'),
)

page(
 S('Analytics and development prioritisation'),
 F('intelligence','Figure 3. Evidence-linked public intelligence and planning decisions.'),
 P('Start with PostgreSQL materialised summaries and versioned metric definitions. Filter by category, issue type, jurisdiction, time and resolution state. Every number must identify its unit, denominator, as-of time, source coverage and whether data is observed or seeded. Drilldown ends at redacted original evidence and the event timeline.'),
 T(['Metric','Definition','Avoid'],[
 ['Open backlog','Canonical issues not verified resolved at the snapshot date.','Counting duplicate submissions or merged aliases as issues.'],
 ['Cohort resolution rate','Share of an accepted cohort currently verified resolved at the as-of date. Compare fixed-window outcomes only for cohorts with equal follow-up.','Mixing this month’s closures with unrelated reports, or hiding reopened issues.'],
 ['Time to resolution','Elapsed time from accepted report to verified resolution; report unresolved age separately.','Hiding pending cases by averaging only easy closures.'],
 ['Participation','Distinct qualifying identities per issue; distinct again for wider geography.','Summing per-issue counts into unique national citizens.'],
 ['Affected service population','Separately sourced estimate with method, date and overlap caveat.','Treating contributors as all affected people or as students.']]),
 P('Rank development needs with a versioned, explainable policy using inspected severity, persistence, service population, alternatives, service gaps and funding/execution stage. Keep data confidence separate from need. Saturate popularity effects and show under-reporting/coverage. Urgent safety triage overrides ranking; expenditure decisions remain human-owned. Demonstrate how a low-reporting underserved school can outrank a popular minor issue.'),
)

page(
 S('Asset history and public-data integration'),
 P('Maintain the asset timeline: observation → issue → inspection → project or repair → claimed completion → verified outcome → recurrence. Import source records into a staging area with source URL, retrieval date, licence/access basis, source ID, validity period and raw snapshot. Validate and normalise before linking; reviewed links carry their match rationale and confidence category.'),
 P('LGD provides dated codes and local-body mappings, not a guaranteed GPS-to-ward polygon service. Know Your School is an official discovery reference; UDISE+ data sharing has a separate registration process. Confirm actual fields and reuse rights before bulk joins. eGramSwaraj is a candidate for rural planning, progress and asset context; its PRI scope does not imply urban coverage or an open external API. Use approved snapshots or marked fixtures.', 'lgd','kys','udise','egram'),
 P('Link asset and issue to sanctioned project, funding stage, contract, executing agency and milestone only where evidence supports the link. Distinguish proposed, sanctioned, released, spent, completed and independently verified. “No matching record found” means unknown. Images and delayed repairs do not prove corruption or contractor fault.'),
 S('Capacity and operating cost'),
 P('Keep thumbnails on public read paths, originals private, and image/video processing asynchronous. Load the map only when needed; cap results by viewport and use clustered reads. Cache public summaries with a bounded TTL and freshness watermark, not identity responses. Limit media bytes, duration, model tokens and retry attempts per submission.'),
 P('Illustrative storage sizing, not a forecast: 100,000 submissions × two 1 MB retained images ≈200 GB of originals before derivatives, replicas and backups. At one million submissions the same assumptions imply about2 TB. Video and retention dominate this budget. Measure actual media distribution and storage growth before choosing archival periods.'),
 P('Budget database connections across API instances, workers, deployment overlap and an administrative reserve. Enforce maximum instances and pool limits together. Connection-pool retries do not repair a failed transaction; retry its full unit of work.', 'pool'),
 P('Introduce BigQuery when measured historical scans harm the operational database or exceed the pilot budget. Export event IDs and versions into partitioned tables, explicitly deduplicate and reconcile corrections. Partition pruning and preaggregation reduce work; declared BigQuery keys are not enforced. Keep the warehouse rebuildable, not the complaint system of record.', 'bq'),
 S('Production recovery and rollout'),
 P('Set proposed pilot objectives of99.5% monthly API availability, RPO≤15minutes and RTO≤4hours, then configure services and prove a restore meets them. Alert on outbox age, worker failures, unacknowledged deliveries, stale summaries, error budget and spend. Use expand/contract migrations, feature flags, canary rollout and a rollback runbook. Never call a backup “tested” until records and media references have been restored and checked.'),
)

page(
 H('10. Alternatives Considered'),
 T(['Alternative','Benefit','Decision'],[
 ['Microservice for every capability','Independent scaling and ownership.','Defer. A small team needs one domain model and fewer operational boundaries.'],
 ['Document database as the only store','Fast initial document capture.','Prefer relational constraints, geographic joins and transactional counts for the core.'],
 ['Synchronous AI in submission request','Simple happy-path wiring.','Reject. Media/AI delays and retries must not lose a citizen receipt.'],
 ['Native mobile app first','Potentially richer capture and device signals.','Defer. PWA reduces installation friction; add native capture only after measured need.'],
 ['National warehouse and automatic integrations first','Broad launch narrative.','Defer. Prove one asset/category/jurisdiction and an actual owner before multiplying scope.'],
 ['Composite “truth score” and popularity rank','Simple labels and leaderboards.','Reject as unvalidated. Show assurance dimensions, review states and explicit need factors.']]),
 H('11. Open Questions'),
 P('Resolve these before the relevant release gate, not before every prototype task. The companion checklist starts adapter contracts and access requests early, then isolates externally blocked work.'),
 B('Product owner: V001 locks Sangli district, government-school infrastructure, Marathi (mr-IN) and English (en-IN) as versioned jurisdiction, taxonomy and locale packs—not hard-coded branches. Remaining inputs are the detailed school-defect taxonomy and test cohort. Photo, text and voice are in scope; unrestricted video is deferred.'),
 B('Identity and inclusion owner: confirm an eligible DigiLocker partner, approved claims and onsite/assisted-intake policy. Until then use labelled demo identities; do not accept real verified participation.'),
 B('Department partner: confirm the recipient, roles, acknowledgement, transfer and escalation rules, and resolution verifier. A team demo inbox is not a government partnership.'),
 B('Data and privacy owner: approve source rights, asset/boundary fields, retention, public redaction, children’s evidence and processor terms before real intake.'),
 B('Team lead: confirm stack, budget and release ownership. Tenure-based outcome views are later extensions; show boundary/date context and never imply causal attribution.'),
)

page(
 H('12. Decision and Next Steps'),
 P('Proceed with a modular TypeScript PWA and one complete workflow. Build contracts, policies, fixtures and persistence before composed features. Request external access early; labelled adapters keep the hackathon independent of approval timing.'),
 T(['Milestone','Deliverable','Exit criteria'],[
 ['Foundation','Taxonomy, states, metrics, contracts, privacy decisions, repository and fixtures.','Core modules test independently; no UI or external approval is a hidden prerequisite.'],
 ['Hackathon vertical slice','Capture → real Gemini → canonical issue → simulated owner → closure → policy view.','Live link, reproducible sample data, measured tests and explicit demo limitations.'],
 ['Controlled pilot','Approved identity and real recipient; consent, moderation, restore and support.','Gates approved, real acknowledgement demonstrated, no unresolved critical security issue.'],
 ['Expansion','More assets/languages/jurisdictions, permitted messaging and planning sources.','Each jurisdiction has data mapping, ownership, coverage and operational capacity.'],
 ['Scale','Warehouse, heavier media, performance tuning and disaster recovery.','Measured load justifies complexity; correctness and cost targets still hold.']]),
 S('Hackathon demonstration sequence'),
 P('Demo a clearly synthetic Sangli school: submit consented Marathi voice evidence, attach an English report to the same issue and keep a nearby distinct defect separate. A labelled staff simulator claims repair; a citizen confirms or disputes it. Finish on a synthetic Sangli district priority view with coverage and denominators, separating district from parliamentary-constituency coverage and simulated routing from government receipt.'),
 P('Show measured effort, reviewed AI performance and correct counts—not a feature list. Deliver the required working Google-AI prototype, repository, live link, 3–5 minute demo and 10–12 slide deck. The event page lists 30 September 2026; recheck immediately before submission.', 'event'),
 S('How to use the companion checklist'),
 P('The checklist defines task IDs, dependencies, owners, scope and tests. Independent tasks may run in parallel, with separate Hackathon, Pilot and Scale gates. It is a build plan, not a claim that the app or integrations exist.'),
)
