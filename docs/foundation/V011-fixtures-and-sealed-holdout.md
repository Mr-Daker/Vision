# V011 — Reviewed Fixtures and a Sealed Evaluation Holdout

**Status:** Ready for owner approval
**Roadmap task:** V011 · **Prerequisites:** V002, V003, V004, V008 · **Owner:** AI + Data
**Code:** `packages/fixtures/src/` · **Guard:** `tools/check-holdout-seal.mjs`

> Every row is team-created synthetic data. **No fixture carries image or audio bytes** — a test asserts this. Real consented media is a separate collection activity under V005 consent, not part of this corpus.

## 1. What exists

| File                                   | Contents                                                                                      |
| -------------------------------------- | --------------------------------------------------------------------------------------------- |
| `corpus/taxonomy.v1.json`              | 6 categories, 9 defects, `mr-IN`/`en-IN` labels, 3 severity bands, explicit label definitions |
| `corpus/jurisdictions.json`            | 3-node synthetic hierarchy with invented boundary polygons                                    |
| `corpus/assets.json`                   | 6 synthetic assets across two blocks                                                          |
| `corpus/responsibility-directory.json` | 3 simulated departments, 11 routing rules, **1 deliberate gap**                               |
| `corpus/reports.development.json`      | 12 reports — 7 `en-IN`, 4 `mr-IN`, 1 `und`                                                    |
| `corpus/reports.holdout.json`          | 8 sealed reports — 4 `en-IN`, 4 `mr-IN`                                                       |
| `corpus/relations.json`                | 2 duplicate pairs, 3 nearby-distinct pairs, 1 recurrence pair                                 |
| `corpus/adversarial.json`              | 12 cases, each with required handling and forbidden behaviour                                 |

## 2. The seal

`loadHoldoutCorpus(reason)` throws unless `VISION_EVAL_RUN=1` **and** a recorded reason of ≥8 characters is supplied. `holdoutMetadataOnly()` exposes counts/coverage without content, so leakage tests need no unsealing.

`tools/check-holdout-seal.mjs` fails CI on two independent conditions: a holdout reference outside an evaluation path, and any committed `VISION_EVAL_RUN=1`. Both were negative-tested.

## 3. Leakage separation

Split by **asset**: development uses assets 001/002/004/005; holdout uses 003/006. Asset overlap is asserted empty, and relations are asserted never to cross the split. A model therefore cannot have learned a holdout asset's phrasing, coordinates, or routing from the development set.

The seeder (`tools/seed-fixtures.mjs`) loads the development split only and does not import the holdout loader at all.

## 4. Honesty properties asserted by test

- Every report has a reviewer decision, reviewer notes, and a resolved-or-flagged label set.
- Every `mr-IN` row is `reviewed_by: pending_native_review` with `reviewed_at: null` — the Marathi text is a team draft and **must not back a V046 measurement until a native reviewer signs off**.
- Unresolved labels are recorded per report (4 in development, 3 in holdout) rather than silently absent.
- `media_with_bytes === 0`.
- Every simulated department label contains "simulated".
- The declared routing gap is genuinely unmapped, so `routing_review` is exercised rather than a custodian being invented.

## 5. Deliberate awkward cases

Poor GPS (120 m, 200 m), text-only evidence, mixed-language text, an uninformative report requiring abstention, a cross-language duplicate pair, a same-asset different-defect hard negative, and a recurrence whose treatment is **undecided by design** (V003 §8 forbids the system settling it).

## 6. Open items

Marathi native review · consented real media collection · a locale resource pack (V019) · the frozen evaluation run itself (V046).
