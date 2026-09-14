# V008 — APIs, Events, and Replaceable Provider Adapters

**Status:** Ready for owner approval
**Roadmap task:** V008 (Foundation) · **Prerequisites:** V003, V006, V007 · **Owner:** Backend
**Code:** `packages/contracts/src/` · **Contract version:** `1.0.0`

**Revision note (dependency pass after V011–V015):** §5 now records the identity port's `issuer` and `CredentialStateObservation`, which arrived with the mutation-context hardening. `CONTRACT_VERSION` is still `1.0.0` despite the mutating-operation signatures having changed — see §9.

> These are contracts and fixtures, not endpoints. The submission, evidence, issue and analytics endpoints are built at V018 and later. What exists now is the shared vocabulary those endpoints and every provider adapter must use.

## 1. What this task delivers

| File            | Contents                                                                                                             |
| --------------- | -------------------------------------------------------------------------------------------------------------------- |
| `primitives.ts` | Branded identifiers, idempotency scope/fingerprint, timestamps and their strict validators                           |
| `errors.ts`     | 14 stable error codes with their HTTP mapping in one place                                                           |
| `outcomes.ts`   | Provenance model and the six adapter outcome kinds                                                                   |
| `capability.ts` | Machine-readable form of the [V002](V002-capability-evidence-matrix.md) matrix, plus the unlabelled-simulation guard |
| `envelope.ts`   | Request/response envelopes and the domain-event envelope with its payload privacy guard                              |
| `adapters.ts`   | Six provider categories expressed as seven replaceable ports                                                         |
| `fixtures.ts`   | Fixture coverage for every capability × every outcome kind                                                           |

## 2. Envelopes, idempotency, correlation, time

- Every request and response envelope carries `contract_version` and `correlation_id`.
- Every state-changing request uses `MutationRequestEnvelope` or `MutationAdapterCallContext`. Both require an `idempotency_key`, a server-derived `idempotency_scope` (actor/tenant + operation), and a SHA-256 `request_fingerprint` of the canonical request. A different payload under the same key and scope is a `conflict`, never a silent overwrite. Read-only calls use the smaller base envelope/context.
- **Event time and ingestion time are always distinct fields** (`observed_at`/`occurred_at` vs. `server_received_at`/`recorded_at`), per [V003 §3](V003-domain-and-lifecycle-contracts.md).
- `parseIsoTimestamp` accepts only a complete RFC 3339 date-time with an explicit offset and validates the actual Gregorian calendar date. It rejects date-only values, implementation-specific `Date.parse` formats, impossible dates and unsupported leap seconds.

## 3. The outcome model

Adapter failures are data, not exceptions. Every port returns `AdapterOutcome<T>` with exactly the six kinds V008 requires:

| Kind          | Meaning                                                  | Key property                                           |
| ------------- | -------------------------------------------------------- | ------------------------------------------------------ |
| `success`     | Completed; `value` is authoritative _for its provenance_ | —                                                      |
| `unavailable` | Transient failure                                        | `retryable: true`, optional `retry_after_ms`           |
| `pending`     | Accepted, not decided                                    | Neither success nor failure; optional `poll_reference` |
| `rejected`    | Actively refused                                         | `retryable: false` + `detail`                          |
| `duplicate`   | Already handled                                          | Optional `existing_value`; **not** treated as success  |
| `ambiguous`   | Needs a human                                            | `candidates` + `requires_review: true`                 |

`isSuccess()` deliberately excludes `duplicate`: a duplicate means _no new effect occurred_, which callers must handle explicitly rather than conflating with a fresh success.

## 4. Simulated versus authenticated-external — enforced by types

This is the V008 "done when" requirement, and it is a type-level guarantee rather than a convention:

```
SimulatedProvenance                → authenticity: "simulated_fixture"
AuthenticatedExternalProvenance    → provider_mode: "real"
                                     + provider_request_id (required)
                                     + authentication_method
UnauthenticatedExternalProvenance  → a real provider replied, unverified
```

Because `authenticity: "authenticated_external"` exists **only** on the variant that also requires `provider_mode: "real"` and a `provider_request_id`, one provenance value cannot simultaneously describe itself as simulated and authenticated. Reusable adapter suites additionally verify that a non-real adapter never returns external authority. `carriesExternalAuthority()` is the single predicate any surface must consult before describing something as confirmed by an external authority ([V002](V002-capability-evidence-matrix.md) row 16).

The contract test `no fixture can claim external authority` asserts this across every fixture, and the reusable adapter suites assert it for every adapter response.

## 5. The six provider categories

There are seven TypeScript ports because AI inference is deliberately split into separate classification and transcription consent boundaries.

| Port                         | Operations                            | Hackathon implementation          | Real implementation |
| ---------------------------- | ------------------------------------- | --------------------------------- | ------------------- |
| `IdentityProviderAdapter`    | `authenticate` (read-only context)    | Simulated fixed principals (V009) | V057                |
| `GovernmentRecipientAdapter` | `deliver`, `fetchAcknowledgment`      | Simulated department inbox (V010) | V058                |
| `ObjectStoreAdapter`         | `createUploadGrant`, `finalizeUpload` | Filesystem driver (V016)          | V051                |
| `TaskDeliveryAdapter`        | `enqueue`                             | Loopback relay (V017)             | V051                |
| `AiClassificationAdapter`    | `classify`                            | Stub → real Gemini (V023)         | V023                |
| `AiTranscriptionAdapter`     | `transcribe`                          | Stub → real Gemini (V023)         | V023                |
| `SourceImportAdapter`        | `fetchRecords`                        | Synthetic rows (V010)             | V040/V061           |

Two deliberate shapes worth noting:

- **Delivery is not acknowledgment.** `deliver` returns `RecipientDelivery` (transport accepted it); `fetchAcknowledgment` returns `RecipientAcknowledgment` separately. The port makes it awkward to conflate them, which is the point.
- **Transcription and classification are separate ports** with separate consent purposes. `ClassificationInput` accepts `text` and an _approved_ image reference only — never an audio reference — so the [V005 §8](V005-data-privacy-and-retention.md) rule that raw audio never reaches the classifier is expressed in the type, not just in prose.
- **Identity assertions carry explicit credential observations.** `issuer` is separate from the adapter's provider name, while the discriminated `credential_state` records `active`, `revoked`, or `expired` with the state-check time and the relevant revocation/expiry time. V009 must fail closed unless the observation is active.

Two identity-port details worth stating explicitly, because they are what stops a "found credential" being treated as a usable one:

- `IdentityAssertion` carries an `issuer` and a `CredentialStateObservation` — a discriminated union of `active` / `revoked` / `expired`, each with the time it was checked. A caller cannot read a state without also reading when it was observed.
- Only the `active` variant is usable. A revoked or expired credential is a `rejected` outcome with its own reason code, so failing closed is the default rather than something each caller must remember (see [V009](V009-sessions-and-simulated-identity.md)).

`ClassificationProposal.certainty_band` is an ordinal `low | medium | high`, never a percentage, because [V002](V002-capability-evidence-matrix.md) prohibition 9 forbids presenting an uncalibrated score as a probability of truth.

## 6. Event payload privacy

`EventEnvelope.payload` is typed to accept only JSON scalars and scalar arrays — no nested objects — and `findForbiddenPayloadKeys()` additionally rejects keys such as `transcript_text`, `object_reference`, `session_token`, `latitude`. This is defence in depth: the type stops a whole object being embedded, the guard stops a transcript being put in a string field ([V003](V003-domain-and-lifecycle-contracts.md) `StatusEvent` constraints, [V005 §8](V005-data-privacy-and-retention.md)).

## 7. Fixture coverage

`CONTRACT_FIXTURES` is indexed by capability and outcome kind. Completeness is **asserted by a test**, so a new capability cannot be added without its six fixtures:

| Capability                 | success | unavailable | pending | rejected | duplicate | ambiguous |
| -------------------------- | ------- | ----------- | ------- | -------- | --------- | --------- |
| `citizen_identity`         | ✓       | ✓           | ✓       | ✓        | ✓         | ✓         |
| `recipient_acknowledgment` | ✓       | ✓           | ✓       | ✓        | ✓         | ✓         |
| `object_storage`           | ✓       | ✓           | ✓       | ✓        | ✓         | ✓         |
| `task_delivery`            | ✓       | ✓           | ✓       | ✓        | ✓         | ✓         |
| `ai_classification`        | ✓       | ✓           | ✓       | ✓        | ✓         | ✓         |
| `ai_transcription`         | ✓       | ✓           | ✓       | ✓        | ✓         | ✓         |
| `source_import`            | ✓       | ✓           | ✓       | ✓        | ✓         | ✓         |

Recipient _delivery_ fixtures are exported separately (`recipientDeliveryFixtures`) since that capability has two operations. The contract tests independently assert all six delivery outcomes and their simulated provenance.

## 8. Deferred, with triggers

| Deferred                                                 | Why                                                                                                                    | Trigger                                               |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| OpenAPI document                                         | No HTTP endpoints beyond V009's session routes exist to describe; a spec written now would describe intentions         | V018, alongside the first durable submission endpoint |
| Submission / evidence / issue / analytics request shapes | They depend on V012 persistence and V014 domain transitions; guessing them now would bias both                         | V018–V039                                             |
| Runtime schema validation library                        | The hand-written validators cover the primitives actually in use; a library is warranted when request bodies get large | V018                                                  |
| Event payload schema registry                            | Only a handful of event types exist so far                                                                             | V014/V017, when events are first written              |

## 9. Approval record

| Decision                                                          | Proposed | Approved by / date |
| ----------------------------------------------------------------- | -------- | ------------------ |
| Outcome model and the six kinds                                   | §3       | Pending            |
| Provenance model and the type-level simulated/authenticated split | §4       | Pending            |
| Six provider categories represented by seven ports                | §5       | Pending            |
| Fixture coverage requirement                                      | §7       | Pending            |

**Open item raised by the dependency pass:** `CONTRACT_VERSION` is still `1.0.0`, but the mutating-operation signatures changed after the original draft — `deliver`, `createUploadGrant`, `finalizeUpload` and `enqueue` now require a `MutationAdapterCallContext`, and `IdentityAssertion` gained `issuer` and `credential_state`. Those are breaking changes to the port surface. Since every implementation in the tree was updated together, nothing is currently broken, but the version should be bumped before any consumer exists outside this repository (V018 at the latest). Flagged rather than changed here, because the version string is a contract decision for the Backend owner, not a documentation edit.
