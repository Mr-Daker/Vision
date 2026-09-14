# V023 — Connect Real Gemini Inference Behind the AI Adapter

**Status:** Ready for owner approval
**Roadmap task:** V023 · **Prerequisites:** V008, V011, V015, V017, V021 · **Owner:** AI + Backend
**Code:** `packages/adapters/src/gemini.ts`
**Tests:** `gemini.test.ts` (27, offline and deterministic) · `gemini.livetest.ts` (4, real calls)
**Run it:** `npm test` for the offline suite; `npm run test:live` with a key configured for the real one

## 1. Distrustful in both directions

**Inbound, the citizen's words are untrusted input.** They travel as a delimited data part and are never merged into the instruction, so a report reading "ignore previous instructions" gets classified rather than obeyed. Asserted by inspecting the request body. No identity value, session or reference to one is ever present — asserted by scanning the serialised request for `participant`, `session`, `identity`, `provider_subject`.

**Outbound, the model's reply is untrusted output.** A category identifier becomes a proposal only if it exists in the supplied taxonomy; a defect identifier is validated independently of the category; a certainty value survives only as one of three ordinal bands. Anything else yields a review or retry state rather than a guess. Only the agreed fields are carried forward, so a `confidence: 0.87` the model volunteers is **discarded** rather than becoming a number an interface could present as calibrated (V002 prohibition 9).

The model is given no tool, no action and no route to a record. It returns a small JSON object and nothing else.

## 2. Keys, errors and cost

- The key travels in `x-goog-api-key`, never in a URL — a key in a URL ends up in logs, proxies and history. Asserted.
- **No provider error text is echoed.** An error body can quote the request, and the request contains the citizen's words. `UnavailableOutcome` carries no free-text detail at all, so the reason travels as a code (`provider_unreachable`, `provider_http_429`). A test asserts the key never appears in any outcome.
- A timeout aborts the request rather than hanging the stage.
- `maxCalls` is a hard ceiling; exceeding it **throws** rather than quietly charging again.

## 3. Two defects found by running it for real

- **A blank model name was reported as a retryable outage.** `.env` carried `GEMINI_CLASSIFICATION_MODEL=`, and `??` does not replace an empty string, so the URL became `/models/:generateContent`. The adapter called it and returned "unavailable, retryable" — which would have a relay retry a URL that can never work, forever. Misconfiguration now throws `GeminiConfigurationError` at construction. `.env.example` documents that a blank value is not an absent one.
- **The provider's own retry hint was being discarded.** A 429 carries a `google.rpc.RetryInfo` (`"retryDelay": "38s"`). It is now passed through as `retry_after_ms`, so a relay backs off by the amount asked for instead of retrying into the same limit. A missing hint stays missing — a fabricated delay is worse than none.

## 4. Provenance: a proposal is not an authority

A model reply is recorded as `unauthenticated_external`, so `carriesExternalAuthority()` is **false**. `authenticated_external` is reserved for a response an outside authority actually stands behind; marking a vendor model's proposal as authenticated would let a surface present it as confirmed (V002 row 16). The provider's `responseId` is recorded as `provider_request_id`; the request body is not stored (V005 §6).

## 5. Embeddings, measured rather than assumed

`gemini-embedding-001` returns **3072 dimensions, already unit length** — measured against the live endpoint, not taken from documentation. `expectedDimensions` is required configuration and a mismatch is **rejected**, because a vector of the wrong width stored beside correct ones corrupts every later comparison silently. Whether the provider returned unit length is reported, so a caller doing cosine work knows.

**Open item for V026:** 3072 exceeds pgvector's 2000-dimension limit for `ivfflat`/`hnsw` indexes. Either `outputDimensionality` reduction or a different index strategy must be chosen before vectors are stored. Not decided here.

Image similarity still uses media fingerprints (V021); no image-embedding provider has been selected, per the roadmap's default.

## 6. What the live run actually showed

On a run recorded 2026-09-11, with `gemini-3.6-flash` and `gemini-embedding-001`:

| Check                 | Result                                                                         |
| --------------------- | ------------------------------------------------------------------------------ |
| English report        | `sanitation` / `blockage`, band `high`                                         |
| **Marathi report**    | `sanitation`, band `high`                                                      |
| Injected instructions | Model returned `water_supply` — in-taxonomy; the injection did not take effect |
| Embedding             | 3072 dimensions, unit length                                                   |

**What this does and does not establish.** It establishes that the integration works: the request is accepted, the reply parses, the schema guard holds against real output, and Marathi input produces a structured result. It does **not** establish model quality, accuracy, or injection resistance — those are properties of the model, measured only by a held-out evaluation (V046). The live test deliberately does not assert that the model resists injection; it asserts only that whatever the model says is forced through the taxonomy guard.

**Operational limit found:** the configured project is on the **free tier — 5 requests per minute per model**. The demo will hit this. The live suite runs serially and skips on 429 rather than failing, because a quota is an environmental limit, not a defect; treating it as a failure would teach the team to ignore the suite.

## 7. Verification

27 offline tests, 21 mutations, 0 survivors. The offline suite makes no network call and costs nothing, so it can run in CI without a key.

## 8. Not done

No classification of images (V021 leaves every photograph unresolved, so none may reach the AI path) · no held-out quality measurement (V046) · transcription is V024.

The prompt itself stays fixed text in `packages/adapters/src/gemini.ts` and is deliberately **not** loadable. Making the instruction data would give a configuration pack a way to tell the model what to do, which is the same injection route the adapter keeps citizen text away from. Identifiers are data; instructions are code.

**Closed since this was written: the stage classifies.** `runMatchingStage` takes an optional `classify` port, calls it through `withAiCache`, stores the proposal against the evidence, and applies the category only when the band is `high` — anything less is advice pending review, and using it would route the report on a guess nobody confirmed. The port is optional because a deployment with no API key must keep working: without one the stage uses the fallback and records it as the fallback it is. A classifier outage never loses the report.

**A latency defect the live calls found.** `DEFAULT_TIMEOUT_MS` was 20 s. Measured against the live endpoint on 2026-09-11, a prompt of "Reply with the single word: ok" took **35 s**, and 49 s with a 128-token thinking budget; `thinkingBudget: 0` is rejected with HTTP 400, so this model always thinks and the latency cannot be opted out of. Earlier the same day it answered in 2.6 s — the range is wide and load-dependent. At 20 s a _working_ provider came back as `provider_unreachable, retryable: true`, and a relay would retry it forever. Two live classification calls in the suite take 44.9 s and 21.5 s; both would have failed.

The stage lease was 60 s against a call that may take the full provider budget, so a slow call could outlast the lease and let another worker fence the first one's writes out. `MATCHING_LEASE_SECONDS` is now sized against the timeout, and `provider-latency.test.ts` pins the relationship so the two cannot drift apart again.

**Closed since this was written**

- Result caching by input hash — `packages/adapters/src/ai-cache.ts`. Keyed by operation, input hash, model _and_ prompt version, so a changed prompt is a different question rather than an old answer. Failures are never cached (a cached outage is a permanent one), a hit reports `firstObtainedAt` so a three-day-old answer cannot be presented as current, and `cachedEmbedText` puts the most-repeated call in the pipeline behind it. 13 tests; 14 mutants including "cache failures too" and "date a cached answer to now()" all caught.
- The taxonomy through the config loader — `packages/config-packs/src/packs/demo-district-a/taxonomy.json` and `loadTaxonomy`, composed in `apps/api/src/pack-composition.ts`. Before this the taxonomy reached the classifier only from test fixtures, so a deployed classifier had no permitted identifiers and would have rejected every reply it received. Cross-pack tests check that every category the routing directory owns and the confirmation policy rules on actually exists in the taxonomy.
- Proposals persisted against evidence — `classification_proposal` (migration 0014) and `recordClassificationProposal`. Stored beside the evidence, never written into it: a proposal is advice pending review. `requires_review` is derived from the ordinal band rather than supplied alongside it, and a test asserts the table has **no numeric column at all** (V002 prohibition 9).
