# V010 — Simulated Department Recipient and Source Adapters

**Status:** Technical implementation verified; owner approval pending
**Roadmap task:** V010 (Foundation) · **Prerequisites:** V004, V008 · **Owner:** Backend + Data
**Code:** `packages/adapters/src/{recipient,sources,contract-tests}.ts`

**Revision note (dependency pass after V011–V015):** `deliver` now requires a bound mutation context (§3), synthetic labelling is validated at the adapter boundary rather than trusted (§5), and the persistence deferral in §7 is unblocked now that V012/V013 have landed.

> No government department has been contacted, and no external dataset is ingested. Every acknowledgment produced here is simulated and every source row is team-created synthetic data ([V004](V004-source-and-reuse-register.md) §5).

## 1. What is implemented

| Adapter                               | Port                         | Behaviour                                                                                                    |
| ------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `SimulatedDepartmentRecipientAdapter` | `GovernmentRecipientAdapter` | Department inbox + acknowledgment, with scripted scenarios                                                   |
| `SyntheticSourceImportAdapter`        | `SourceImportAdapter`        | `projects` and `demographics` datasets from synthetic rows                                                   |
| Shared contract suites                | —                            | `describeRecipientAdapterContract`, `describeSourceImportAdapterContract`, `describeIdentityAdapterContract` |

## 2. Delivery is not acknowledgment

The two are separate operations returning separate types, and the adapter is built so they cannot be conflated:

- `deliver()` succeeding means **the channel accepted the message**.
- `fetchAcknowledgment()` returning `pending` is the normal answer until the recipient responds.
- With the `never_acknowledge` scenario, delivery succeeds and acknowledgment stays `pending` indefinitely — asserted by the test _"delivery success is not acknowledgment"_.
- Once an acknowledgment succeeds, repeat polls return the same acknowledgment facts and timestamp rather than manufacturing a new event.

This directly serves [V002](V002-capability-evidence-matrix.md) row 16: internal routing and external acknowledgment are distinct facts, and neither may be presented as official government receipt.

## 3. Modelled awkward cases

The default scenario is `acknowledge_after_polls: 1`, not instant success, because agencies do not answer synchronously and a workflow that only handles instant acknowledgment is the workflow that breaks in a pilot.

| Requirement            | Scenario                                         | Outcome                                            | Verified by                                                          |
| ---------------------- | ------------------------------------------------ | -------------------------------------------------- | -------------------------------------------------------------------- |
| Delayed acknowledgment | `acknowledge_after_polls: n`                     | `pending` × n, then `success`                      | _"delayed acknowledgment reports pending before it reports success"_ |
| Rejected routing       | `reject_routing`                                 | `rejected`, `retryable: false`, reason code        | _"rejected routing is reported as rejected and not retryable"_       |
| Transient failure      | `unavailable`                                    | `unavailable`, `retryable: true`, `retry_after_ms` | _"a transient channel failure is retryable"_                         |
| Duplicate delivery     | same scope + key + request fingerprint           | `duplicate` pointing at the committed delivery     | _"a retried delivery is a duplicate, not a second delivery"_         |
| Conflicting key reuse  | same scope + key, different request fingerprint  | `rejected`, never silently treated as the old call | _"one idempotency key cannot be rebound to a different request"_     |
| Cross-scope key reuse  | same client key, different server-derived scopes | two independent deliveries                         | _"the same client key is independent across idempotency scopes"_     |
| Stable acknowledgment  | poll again after `success`                       | original acknowledgment facts are returned         | _"a successful acknowledgment remains stable across repeat polls"_   |
| Never acknowledged     | `never_acknowledge`                              | `pending` forever                                  | _"delivery success is not acknowledgment"_                           |
| Unknown delivery       | —                                                | `rejected`, never `success`                        | _"an unknown delivery cannot be acknowledged"_                       |

Scenarios can be assigned **per department**, so one demonstration can show a fast recipient, a slow recipient, and a refusing recipient simultaneously without code changes.

Every delivery call also supplies a client idempotency key, a server-derived scope, and a canonical-request fingerprint. The adapter binds all three to the committed delivery. This prevents one participant or operation from colliding with another and makes changed-payload key reuse an explicit rejection.

## 4. Source adapters: stale records and missing matches

| Requirement            | Behaviour                                                                                                                                                   | Verified by                                                           |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Stale records          | The `projects` fixture set deliberately contains one current row and one row with a 2024 `source_effective_at`; `isStale(row, now, maxAgeDays)` surfaces it | _"stale records are detectable rather than silently used"_            |
| Unknown effective date | Treated as stale, never as fresh                                                                                                                            | _"a record without a source-effective date is treated as stale"_      |
| Missing project match  | An **empty successful result**, meaning _unknown_                                                                                                           | _"a missing project match is an empty success meaning unknown"_       |
| Unknown dataset        | `rejected`, never invented rows                                                                                                                             | _"an unknown dataset is rejected instead of returning invented rows"_ |
| Degraded feed          | `unavailable`, retryable                                                                                                                                    | _"a degraded feed reports unavailable and is retryable"_              |

The empty-result rule matters: [V002](V002-capability-evidence-matrix.md) row 20 forbids translating an absent match into "government has not funded this asset". An empty list is returned as a success so callers must render it as unknown rather than as an error or as absence of funding.

## 5. Labelling guarantees

Every simulated agency event and every synthetic source row is labelled, and this is asserted rather than assumed:

- **Provenance:** every outcome from both adapters carries `authenticity: "simulated_fixture"`, so `carriesExternalAuthority()` is `false` for all of them. A simulated adapter _cannot_ construct an authenticated-external provenance (V008 §4).
- **Acknowledgment text:** the note reads "simulated acknowledgment — not a real government confirmation".
- **Capability labels:** "Simulated department inbox — not a real government acknowledgment" and "Simulated source import — team-created synthetic records only". The API refuses to start if either label loses its simulation wording (V009 §6).
- **Source rows:** every row is `licence_or_permission_status: "synthetic"` + `demo_status: "team_created_synthetic"`, and each `raw_snapshot` carries a visible `SYNTHETIC` marker in its own payload. The adapter validates these properties at construction and fails closed even for injected test/demo rows.
- **Fixture isolation:** configured rows and successful results are defensively cloned, so later mutation by the fixture owner or a caller cannot silently relabel the adapter's stored data.
- **Reference-only material stays out:** `isIngestible()` returns `false` for `reference_only` and `unavailable` sources, and the contract suite asserts that a non-ingestible row carries no `raw_snapshot` — matching [V003](V003-domain-and-lifecycle-contracts.md) `SourceRecord` and [V004 §5](V004-source-and-reuse-register.md).

## 6. Replaceability — how it is proved, not asserted

`contract-tests.ts` exports suites of **provider-agnostic** assertions. The simulated adapters are run through them today. A real DigiLocker (V057), department integration (V058), or source feed (V040/V061) supplies provider-specific accepted/unknown test cases to the same suite code; the citizen and staff callers do not change. Each suite checks:

- the adapter and capability descriptor agree on provider name and mode, and a non-real provider is labelled as such;
- the configured known-good delivery or source query must actually succeed — a permanently unavailable adapter cannot pass by skipping assertions;
- every exercised operation returns a declared outcome kind and echoes the exact `correlation_id`;
- provenance agrees with the descriptor, and a non-real provider never claims external authenticity;
- an unknown delivery never yields an acknowledgment;
- the same scoped key and request fingerprint does not deliver twice, and a changed request under that binding is rejected;
- an unknown dataset never returns success;
- every returned row carries source provenance, a non-ingestible row carries no snapshot, and non-real source adapters emit only visibly synthetic rows.

Because these suites reference only the V008 ports, they define the compatibility gate a future adapter must pass **without changing the citizen or staff workflow** — V010's acceptance condition. They do not claim that an as-yet-unbuilt external integration already works. The suites are not re-exported from the package index, so production code never pulls the test runner into its module graph.

## 7. Deliberate non-scope

| Not implemented                                                    | Owner                                                                                                                   |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Routing decisions — which department owns an issue                 | V033 (versioned responsibility directory); this adapter takes `department_id` as input                                  |
| Persisting deliveries, acknowledgments and source records          | **Now unblocked** — the V012 schema exists; adapter state here is still in-memory pending the `pg` port implementations |
| Staff triage and acknowledgment UI                                 | V034                                                                                                                    |
| Real recipient integration                                         | V058, gated on V055/V056                                                                                                |
| Real project/demographic feeds                                     | V040 (import with lineage), V061 (operationalized feeds)                                                                |
| Asset and jurisdiction fixtures for the locked demonstration scope | V011                                                                                                                    |

## 8. Technical verification

Verified on **9 September 2026**:

- `node --test packages/adapters/src/recipient.test.ts packages/adapters/src/sources.test.ts` — **30/30 tests passed**.
- The focused run covers delayed/rejected/unavailable recipient paths, exact retry and changed-request idempotency, stable acknowledgments, every simulated provenance path, both source datasets, stale and missing records, fail-closed row labelling, defensive copying, and the provider-agnostic contract suites.
- Formatting was applied only to the V010 implementation, tests, shared contract-suite file, and this document.

This is a technical verification record, not owner approval and not evidence of any government or source-provider integration. Repository-wide release checks remain the parent checklist gate.

## 9. Approval record

| Decision                                                                                    | Proposed | Approved by / date |
| ------------------------------------------------------------------------------------------- | -------- | ------------------ |
| Scenario set (delayed, rejected, unavailable, duplicate, never) and the non-instant default | §3       | Pending            |
| Empty result means unknown, not absence                                                     | §4       | Pending            |
| Labelling guarantees and their enforcement                                                  | §5       | Pending            |
| Contract suites as the replaceability gate for V057/V058                                    | §6       | Pending            |
