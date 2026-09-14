# V024 — Support and Verify Multilingual Voice and Text Understanding

**Status:** Ready for owner approval
**Roadmap task:** V024 · **Prerequisites:** V011, V019, V023 · **Owner:** AI + Frontend
**Code:** `packages/domain/src/language-policy.ts` · `packages/adapters/src/gemini-transcription.ts`
**Tests:** `language-policy.test.ts` (13) · `gemini-transcription.test.ts` (14) · the Marathi case in `gemini.livetest.ts`

## 1. The failure this exists to prevent

A report in a language nobody has evaluated being machine-translated into a confident English label, so the uncertainty disappears before a reviewer ever learns it was there. Every rule here is about keeping doubt visible.

**Nothing in this codebase translates anything.** `TranscriptionAssessment.translatedText` is a permanently `undefined` field and `LanguageHandlingDecision.translated` is a literal `false`, so a consumer that looks for a translation finds an explicit absence rather than inventing one.

## 2. Language handling

| Situation                                       | Handling                                                                                                                        |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Tag in the enabled pack                         | Normal processing                                                                                                               |
| Tag outside it                                  | `requiresReview`, original wording preserved, **not** translated                                                                |
| Base tag vs regional tag (`mr` against `mr-IN`) | Matches — the citizen did not choose the tag, and refusing on a missing region would report a supported language as unsupported |
| No language detected                            | Review. "Not detected" is unknown, **not** English                                                                              |
| Empty enabled list                              | Nothing is enabled                                                                                                              |

The enabled list arrives as data from the caller. No language name appears in `language-policy.ts` at all, because a locale is scope and scope lives in configuration (V001 Appendix G rule 7).

## 3. Transcript quality, and what silence means

- A transcript the provider called uncertain is **flagged**, not quietly used.
- A reply that **omits** the uncertainty flag is treated as uncertain. "The model did not say" is not "the model was confident".
- Too little speech is reported as possibly noisy or silent — which is explicitly not the same as "there is nothing to report". Only letters and digits count toward the floor, so a recording that transcribes as `"... ... ... ..."` is noise however long it is.

## 4. The correction path

A human correction becomes the effective text and resolves the model's uncertainty — that is the point of offering one — but the machine output **stays on the record** as `originalText`. A blank correction is refused, because it would erase the report under the guise of fixing it.

## 5. Consent is a type, not a code path

Sending raw audio to an external processor is the most sensitive thing this system does. So the consent check is not a line inside a method that could be reordered or forgotten: `GeminiTranscriptionAdapter` requires a `VoiceConsentProof` in its constructor, and that branded type can only be produced by `proveVoiceConsent`, which verifies an active record naming `gemini_voice_transcription`.

"Transcribe now, check consent later" is **unexpressible**, not merely discouraged. Tests assert that a withdrawn record cannot be proved, and that general demonstration consent — even alongside `public_derivative` and `gemini_classification` — never implies the voice purpose, per V003.

`processed_externally` is always `true` for this adapter, because the audio genuinely left the boundary and the notice promises to say so. A transcript's provenance is `unauthenticated_external`: a model's reading of audio is never a confirmed record of speech.

## 6. Equivalence across languages

`gemini.livetest.ts` records a Marathi report reaching `sanitation` with band `high`, the same category the equivalent English report reached, on a run dated 2026-09-11.

**This is an observation from one run, not a measured property.** Two matching results are not evidence of equivalent quality. Per-language accuracy remains **verification pending** until V046's held-out evaluation, and V002 row 23's bound stands: no claim that this works accurately in every Marathi dialect.

## 7. Verification

Language policy: 13 tests, 11 mutations, 0 survivors. Transcription adapter: 14 tests, 14 mutations, 0 survivors. Four mutants initially survived and each exposed a real gap — an omitted uncertainty flag, a transcript silently trimmed and lower-cased, provenance never asserted, and a reply carrying no transcript or no language. All four are now covered.

## 8. Not done

No reviewer interface for applying a correction (V032) · no per-language quality measurement (V046) · the Marathi interface pack remains machine-drafted pending native review (V019).

**Real audio has now been transcribed.** `gemini-transcription.livetest.ts` has a Gemini text-to-speech model speak a known sentence, wraps the returned PCM in a WAV header, and sends that to `gemini-3.5-transcribe`. The words come back exactly:

    live transcription: "The drain outside the school gate is blocked."

The audio is generated rather than recorded on purpose: a real person's voice is what V005 says not to collect for a test, and no citizen has consented to their recording living in a repository.

**Three defects the live call found, none of which any unit test could**

Every one of them meant that _no real transcription had ever been possible_, while the suite stayed green — because the fixtures asserted against a response shape this adapter had invented for itself.

1. **`system_instruction` → HTTP 400**, "Developer instruction is not enabled for this model". The instruction now travels as the leading text part instead. The separation that matters survives: the recording is its own part, and the model is asked to transcribe rather than to follow what it hears.
2. **`responseMimeType: application/json` → HTTP 400**, "JSON mode is not enabled for this model". The request no longer asks for it.
3. **The transcript arrives in `parts[].audioTranscription.text`**, not `parts[].text`. The adapter read the latter, so even a successful call parsed to nothing and was reported as `unusable_model_output`.

**Two further corrections that follow from it**

- A **4xx is no longer reported as retryable**. The contract types `UnavailableOutcome.retryable` as literally `true`, so a permanent failure cannot be one — it is `rejected`. A 400 reported as a retryable outage is how a relay spends its whole budget on a request that can never succeed, the same failure family as the blank model name in V023. 408 and 429 stay retryable: those are timing, not shape.
- **No language is claimed to have been detected.** This model returns words and no language tag. The declared hint is echoed, and with no hint the result is `und` — "undetermined". Reporting the caller's expectation as a detection would have a Marathi recording submitted with an `en-IN` hint come back asserting English.
