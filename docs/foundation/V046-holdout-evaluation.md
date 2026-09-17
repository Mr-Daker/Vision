# V046 — Held-out AI, routing and deduplication evaluation

**Roadmap task:** V046 · **Prerequisites:** V011, V023, V024, V025, V027, V028, V033, V041, V042 · **Owner:** AI + QA
**Code:** `packages/domain/src/evaluation.ts`, `packages/adapters/src/evaluation-run.ts`, `apps/eval/src/` · **Command:** `npm run eval:holdout` · **Results:** [V046-evaluation-results.md](../../deliverables/V046-evaluation-results.md)

Nineteen earlier tasks refused to publish a number and named this one as the place the number would be measured. V026's retrieval window, V027's thresholds, V023's model quality, V024's per-language claim, V025's trust signals, V034's and V042's severity — each of them says "V046". So the first thing this task has to be able to do is say **not from this run**, because a measuring device that cannot report insufficiency reports confidence instead.

It ran. It is reproducible. It measured less than V046 asks for, and the reasons are specific and fixable.

## 1. The thing measured is the thing that runs

Each corpus row is inserted as an ordinary submission — participant, consent, a located report, one piece of text evidence — and handed to `runMatchingStage`, the same function `apps/worker` calls for a report a citizen filed. Retrieval, the duplicate proposal, the commit, participation and routing are the deployed code. A harness that reimplemented any stage would have measured the harness.

The classifier and the embedder are the real V023 Gemini adapters, unchanged, behind a **recording transport** that reads latency, HTTP status, token counts and the reply text off each call. The adapter does not know it is being observed.

The harness also mirrors the deployment's **retry policy**. The first live run lost three of eight classification calls to two 503s and one reply the schema guard refused, and scored them. But the deployment retries — the outbox allows five attempts with exponential backoff — so a run that gave up on the first 503 measures a worse system than the one that exists. It now retries on the same policy and records how many attempts each row took.

## 2. A disposable database, because the holdout may not be seeded

V011's seal forbids the holdout entering a seeded database. A transaction rolled back at the end would not have been enough: `assignSubmissionToIssue` opens its own `SERIALIZABLE` transaction, so running it inside a caller's transaction would have committed the caller's. So the run **creates a database, migrates it, uses it and drops it in a `finally`**. Nothing the demonstration reads is touched.

The evaluation database holds only the rows of one split — no development reports — so a merge is attributable to a reviewer-labelled pair rather than to whatever else happened to be nearby. That is also a limitation, and the results document states it: retrieval measured in a district holding eight reports says nothing about how many wrong candidates appear at a real report density.

`apps/eval/src/holdout-run.ts` is the only file in the repository permitted to call `loadHoldoutCorpus`, and `tools/check-holdout-seal.mjs` enforces it. That checker previously allowlisted a root `evals/` directory which **could never match**: the scanner walks `packages`, `apps`, `tools` and `.github`, so a file outside those was neither allowed nor checked — including for a committed `VISION_EVAL_RUN=1`, in exactly the place that flag would be set. The harness lives under `apps/eval`, inside the walk, the typechecker and the formatter.

## 3. Three refusals, in code

**A row whose labels are not signed off cannot back a figure.** V011 §4 recorded that every `mr-IN` fixture is `pending_native_review` and "must not back a V046 measurement until a native reviewer signs off". That was a sentence in a document. `labelAuthorityOf` makes it a gate, and the results document prints its output row by row. Four of the eight holdout rows are withheld from every label-dependent figure — including `hold-0002`, the second half of the corpus's own "primary cross-language matching test for V046".

**A proportion is not written as a rate unless the interval permits it.** `figureOf` always carries a numerator, a denominator and a 95% Wilson interval, and a percentage appears only when that interval is narrower than twenty percentage points — a threshold chosen by reasoning and recorded as chosen, the way V026's retrieval bounds are. Wilson rather than the textbook interval because the textbook one returns zero width at 4 of 4, which would report a four-example run as certainty. Wilson returns 51–100%: the same data, honestly described. No figure in this run passes the gate, so this evaluation publishes **no percentage at all**.

**Candidate recall and incorrect merges are never combined.** They are different failures with different costs: a missed duplicate makes two records of one problem; a wrong merge makes one record of two problems and removes somebody's report from the count V029 told them they were part of. `matchingFigures` returns both and there is deliberately no function returning one.

`qualityClaimVerdict` collects every condition and refuses with all of them listed, the same shape as V045's `comparativeClaimVerdict` — a refusal that names what is missing is a next step, and one that does not is a wall.

## 4. What the run found about the system

Five findings, none of which a unit test would have produced.

**The deployed worker has no classifier.** `apps/worker/src/dev-worker.ts` calls `buildStageHandlers` with no `classify` and no `embed`. V023 built the adapter and proved it against the live endpoint; nothing ever composed it into a deployment. Every report filed today therefore keeps `WORKER_FALLBACK_CATEGORY`, and since the fallback is not a category the routing directory knows, every report also routes to `no_directory_entry`. Wiring it changes what the demonstration costs per report and which vocabulary it classifies into, so it is recorded here rather than done here.

**One version identifier names two different things.** `demo-taxonomy.v1` is the reviewed corpus's six dotted categories (`structure.roof`, `sanitation.toilet`, …) **and** the deployment pack's four flat ones (`structural`, `sanitation`, …). `demo-routing.v1` is the corpus's three `demo-dept-*` departments **and** the pack's `demo-*` ones. A version identifier exists so that a decision recorded today can be interpreted next year; these cannot be. The run detects the collision and refuses on it, and gave the classifier the **corpus** list, because that is the list the reviewers' labels are written in — so the classification figures describe a configuration this deployment does not currently run.

**A deployed classifier is never told the report's language.** The pipeline's `ClassifyText` port passes only text. The Gemini adapter takes a `source_language`, and nothing can supply it. The harness knows the language because it sets it per row; the worker would not. Per-language quality is exactly what V046 is asked for, and the deployed path cannot vary on language.

**An outage is not an abstention, and the first version of the scorer could not tell them apart.** `proposal === undefined` is true both when the model declines and when the provider is down. The first live run had three calls fail, and the abstention figure reported them as the system behaving carefully. A row with no proposal after the retry policy is exhausted is now `unscorable`, with the reason code, and the provider outcomes are reported separately.

**A fallback category can coincide with a label.** `runMatchingStage` applies a proposal only at the `high` band and otherwise keeps the deployment's fallback, which is a real category id. A report whose reviewed label happened to equal the fallback would have scored as correct while nothing classified it. Below the high band the system is recorded as having declined, whatever the fallback says. Both of these have tests in `apps/eval/src/score.test.ts`.

## 5. The provider decided how much could be measured

Four scored runs of the holdout were made on 17 September 2026, all against the live endpoint, all with the same code and the same rows. Read back from `deliverables/v046-runs/` by `readRunHistory`, not from memory:

| Run              | Classification calls answered | Rows with usable labels | Rows that produced an answer | Category matches |
| ---------------- | ----------------------------- | ----------------------- | ---------------------------- | ---------------- |
| `20260917130311` | 6 of 8                        | 4                       | 3                            | 1                |
| `20260917130732` | 8 of 8                        | 4                       | 3                            | 3                |
| `20260917132343` | 0 of 40                       | 4                       | 0                            | 0                |
| `20260917135352` | 3 of 29                       | 4                       | 1                            | 1                |

The column that moves is the first. **On this evidence, provider availability rather than model behaviour decided how much of the corpus could be scored at all**, and the free tier's quota was exhausted by the day's own evaluation runs — forty-nine of the fifty-four classification attempts in the last two runs were refused. The `20260917135352` run had to be made against `gemini-3.5-flash` because the configured `gemini-3.6-flash` had no quota left; the document records which model answered, which is the whole reason it records it.

Two consequences worth keeping:

- **The deployment's retry policy retries inside the provider's rate-limit window.** The outbox backs off 2, 4, 8 then 16 seconds — all four attempts inside one minute. Against a per-minute limit the retries are part of what sustains the limit, and the only thing that prevents a tight loop is the provider's own `RetryInfo` hint, which it does not always send.
- **An evaluation cannot be re-run casually on this tier.** That is an argument for the run record being the durable artifact and the document being a rendering of it, which is how this is built.

[V046-evaluation-results.md](../../deliverables/V046-evaluation-results.md) is the `20260917135352` run. The cross-run table is generated into the document by later runs; the records are the source either way, and [the record directory's README](../../deliverables/v046-runs/README.md) says which scorer produced which record.

## 6. What the evaluation cannot do, and why

| V046 asks for        | State                                                                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per-language results | **English only.** Every `mr-IN` row is withheld by V011 §4 until a native reviewer signs off.                                                           |
| Per-category results | One or two examples per category. Reported as counts; no rate is permitted.                                                                             |
| Candidate recall     | One reviewed duplicate pair in the holdout. One pair is an example.                                                                                     |
| Incorrect merges     | One reviewed distinct pair. It cannot distinguish a system that never merges wrongly from one that has not been asked to.                               |
| Abstention coverage  | Reported, in both directions, over three scorable rows.                                                                                                 |
| Error examples       | Reported, with the reply excerpt bounded and never reproduced.                                                                                          |
| Latency              | Every observation listed rather than summarised; sixteen calls do not have a median worth printing.                                                     |
| Cost                 | Calls and tokens. **No monetary figure**: no price for this model is recorded in the source register, and a number typed here would have no provenance. |

Nothing was substituted for the holdout. `--split development` exists so the harness can be exercised without unsealing anything, and a run that used it is refused as a rehearsal by name, in the verdict, at the top of its own report.

## 7. What publishing a result costs

The results document names report identifiers, their languages, their reviewed categories and the custodians expected for them, because V046 asks for per-category results and error examples and there is no way to give those without disclosing part of what was held out. Those eight rows are now less held-out than they were. A future measurement that needs them unseen needs **new** rows, not these again — an argument for growing the corpus, not for publishing less of what was measured.

## 8. Open

A native-speaker review of the four Marathi rows (V024/V019) is the single change that most increases what this evaluation can say: it would double the scorable sample and restore the cross-language duplicate pair that the corpus was built around. A larger holdout is the second. Deciding which taxonomy and which routing directory are the real ones is the third, and it is an owner's decision rather than a measurement. Until all three, every figure here is an observation about a handful of reports, and the intervals say so.

Image and audio are not evaluated (the corpus carries no media bytes by design), transcription is not exercised, and the adversarial cases are V047's subject — instruction-echo is detected in replies here, but the injection boundary is tested there.
