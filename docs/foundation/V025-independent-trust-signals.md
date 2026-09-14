# V025 — Explain Independent Trust Signals Without Overstating Verification

**Status:** Ready for owner approval
**Roadmap task:** V025 · **Prerequisites:** V002, V021, V023, V024 · **Owner:** AI + Product
**Code:** `packages/domain/src/trust-signals.ts` · `packages/adapters/src/corroboration.ts`
**Tests:** `trust-signals.test.ts` (13) · `corroboration.test.ts` (6)

## 1. There is no trust score, and there never will be one here

Five observations are reported as five observations. A single combined number would be read as a probability that the reporter is honest, nothing here is calibrated against anything, and V002 prohibition 9 forbids presenting an uncalibrated number as calibrated.

`TrustSignalReport.calibratedScore` exists only as a permanently `undefined` field, so a consumer looking for a score finds an explicit absence instead of computing its own. A test asserts no `score` or `trustScore` property exists at all.

## 2. Missing metadata is unknown, never inconsistent

This is the rule that does the most work in the file. A cheap phone that strips EXIF, or one that cannot get a GPS fix indoors, must not look like a fraud attempt. Penalising missing data falls hardest on exactly the reporters this system exists to hear.

So: absent capture timestamp → `unknown`. Typed location → `unknown` (a claim about a place, not a failed measurement). No image/text comparison available → `unknown`. And **`unknown` alone never triggers review** — otherwise every low-end device would generate a queue item, making the queue useless and penalising the least-equipped.

Only an `inconsistent` verdict asks for review, and the reasons travel with it.

## 3. The five checks

| Signal                          | Says                                                                     | Explicitly does not establish                                                           |
| ------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `capture_consistency`           | Whether the photograph's capture time sits within 72 h before the report | That a gap was deliberate; an old photograph of a long-standing problem looks identical |
| `known_media_reuse`             | Whether these exact bytes were submitted before                          | Who submitted them, that reuse was deliberate, or **independent corroboration**         |
| `image_description_consistency` | Whether text and image agree, when a comparison exists                   | That the event happened, the severity, or that the image is authentic                   |
| `timestamp_availability`        | Whether a capture time could be read                                     | That a photograph without one is less truthful                                          |
| `independent_corroboration`     | How many eligible participants reported separately                       | That the reports are accurate — agreement is not truth                                  |

Every check carries an inspectable `reason` in plain language and a `doesNotEstablish` list. A test asserts both are non-trivial for every check.

A device clock set wrongly produces a capture time _after_ submission; that is reported as inconsistent but explicitly not as dishonesty.

## 4. Four claims stay four claims

`claimsNotEstablished` is `["identity", "physical_presence", "image_authenticity", "factual_severity"]` on every report, and a test fails if the list is narrowed. No combination of these signals establishes who someone is, that they were physically present, that the image is authentic, or that the severity they describe is accurate.

## 5. Corroboration is a fixture, and says so

Live eligible participation depends on the canonical-issue and participation work at V029. Until then `FixtureCorroborationAdapter` supplies the count, and the only thing that makes that acceptable is that every consumer can tell:

- `inputIsFixture: true` on every response, propagated to `report.anyInputIsFixture`;
- the descriptor reads `provider_mode: "simulated"` with a label naming the fixture;
- provenance carries `simulated_fixture` and the fixture id.

An issue with no fixture entry returns a **successful** count of zero with a note that this is _unknown rather than zero corroboration_ — reading absence as "nobody else has this problem" is exactly what V002 row 20 forbids, and V010 already established that an empty result is a success rather than an error.

## 6. Verification

Trust signals: 13 tests, 17 mutations, 0 survivors — including turning a missing timestamp into an inconsistency, making `unknown` demand review, counting reuse as independent, publishing a calibrated score, and narrowing the distinct-claims list. Corroboration adapter: 6 tests, 6 mutations, 0 survivors.

## 7. Not done

`image_description_consistency` expects a verdict from a multimodal comparison, which cannot run while V021 leaves every photograph redaction-unresolved — so that signal is `unknown` today. It is reported as `unknown` and never as a verdict: supplying one would be reporting a comparison that never happened. A pipeline test pins that specifically.

No calibration of any signal (V046). The citizen-facing explanation of a flag is later still.

**Closed since this was written**

- The checks are consumed and stored — `trust_signal_report` (migration 0014) and `recordTrustSignalReport`, called from `runMatchingStage`. A check nobody stores is not a safeguard.
- `requires_review` is **derived from the checks**, not accepted from the caller. A report claiming review with nothing inconsistent behind it is refused, and so is one carrying an inconsistent check while claiming to be unremarkable. That is what stops an `unknown` verdict quietly becoming suspicion — the rule this deliverable exists for.
- Live corroboration (V029) is wired, so `independent_corroboration` now reports `inputIsFixture: false` against a real counted-participant query. A pipeline test asserts that, because continuing to claim "fixture" would understate what the system knows.
- A recomputed report replaces the standing one and clears any earlier review, so new evidence of an inconsistency is not pre-dismissed by a dismissal of the old report.

29 tests across `proposals.dbtest.ts` and `matching-pipeline.dbtest.ts`; every mutant caught, including "let an unknown verdict flag a report" and "quote every check's reason, unknowns included, as the case for the flag".
