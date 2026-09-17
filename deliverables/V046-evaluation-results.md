# V046 — Held-out evaluation results

**Run `20260917135352`** · split **holdout** · provider **real** · 2026-09-17T13:53:52.701Z → 2026-09-17T14:02:59.848Z (547 s)

> Recorded reason for unsealing: _V046 scored held-out evaluation run_
>
> Corpus provenance: team_created_synthetic

## What this run may not be used to say

This run **may not back a quality claim**. The reasons are listed in full, because a refusal that names what is missing is a next step and a refusal that does not is a wall.

1. the reviewed corpus and the deployment pack declare the same taxonomy version while using different category identifiers, so a classification figure would compare a model's answer against a list the reviewer never chose from
1. 4 of 8 corpus reports were withheld from every label-dependent figure, so the measured subset is not the corpus
1. every mr-IN row was withheld, so this run carries no per-language result for mr-IN — which is a result V046 explicitly requires
1. candidate recall rests on 1 reviewed duplicate pair(s); one pair is an example, not a recall measurement
1. the incorrect-merge figure rests on 1 reviewed distinct pair(s), which cannot distinguish a system that never merges wrongly from one that has not been given the chance
1. no figure in this run has a 95% interval narrower than 20 percentage points, so none may be written as a rate

## What was run

| Recorded version                           | Value                                      |
| ------------------------------------------ | ------------------------------------------ |
| Classification model requested             | `gemini-3.5-flash`                         |
| Classification model the provider reported | `gemini-3.5-flash`                         |
| Prompt version                             | `classify.v1`                              |
| Taxonomy                                   | `demo-taxonomy.v1`                         |
| Embedding model                            | `gemini-embedding-001` at 3072 dimensions  |
| Routing directory                          | `demo-routing.v1`                          |
| Jurisdiction profile / boundaries          | `demo-district-a` / `demo-jurisdiction.v1` |
| Retrieval bounds                           | `demo-matching.v1`                         |
| Locale pack                                | `demo-locales.v1`                          |

Retrieval bounds note, carried from the pack: _Retrieval bounds. These are reasoned defaults, NOT values measured against any labelled set — V046 is where they would be calibrated. Keeping them here rather than in code is what lets them be changed without a deployment and recorded when they are._

## Whether a version identifier names one thing

**No.** A version identifier exists so that a decision recorded today can be interpreted next year. The reviewed corpus (V011) and the `demo-district-a` deployment pack reuse identifiers for sets that are not the same:

| Identifier         | What it names          | In the reviewed corpus                                                                                               | In the deployment pack                                                      |
| ------------------ | ---------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `demo-taxonomy.v1` | category identifiers   | `electrical.lighting`, `sanitation.toilet`, `structure.roof`, `structure.wall`, `structure.window`, `water.drinking` | `electrical`, `sanitation`, `structural`, `water_supply`                    |
| `demo-routing.v1`  | department identifiers | `demo-dept-education-works`, `demo-dept-electrical`, `demo-dept-water-sanitation`                                    | `demo-buildings`, `demo-electrical`, `demo-sanitation`, `demo-water-supply` |

A proposal stored as `demo-taxonomy.v1` therefore does not say which vocabulary it chose from, and a routing decision recorded against a directory version does not say which directory. This run gave the classifier the **corpus** list, because that is the list the reviewers' labels are written in — so the classification figures below describe a configuration this deployment does not currently run. Nothing here changes either side: which list is right is an owner's decision, not a measurement.

## Which rows were allowed to back a figure

V011 §4 records that a row awaiting native-speaker review "must not back a V046 measurement until a native reviewer signs off". That was a sentence in a document; `labelAuthorityOf` makes it a gate, and this table is its output.

| Report      | Language | Scored | Reason if withheld                                                                                     |
| ----------- | -------- | ------ | ------------------------------------------------------------------------------------------------------ |
| `hold-0001` | en-IN    | yes    | —                                                                                                      |
| `hold-0002` | mr-IN    | **no** | the label is a team draft awaiting a native-speaker reviewer; V011 §4 forbids it backing a measurement |
| `hold-0003` | mr-IN    | **no** | the label is a team draft awaiting a native-speaker reviewer; V011 §4 forbids it backing a measurement |
| `hold-0004` | en-IN    | yes    | —                                                                                                      |
| `hold-0005` | mr-IN    | **no** | the label is a team draft awaiting a native-speaker reviewer; V011 §4 forbids it backing a measurement |
| `hold-0006` | en-IN    | yes    | —                                                                                                      |
| `hold-0007` | en-IN    | yes    | —                                                                                                      |
| `hold-0008` | mr-IN    | **no** | the label is a team draft awaiting a native-speaker reviewer; V011 §4 forbids it backing a measurement |

**4 of 8** rows are inside every label-dependent figure below. Latency, token counts, HTTP outcomes and claim-language findings are properties of the call rather than of the label, so those cover **all 8** rows.

## How to read every figure below

Each one is written as a count with a 95% Wilson interval. A percentage appears **only** when that interval is narrower than twenty percentage points, and that threshold is chosen by reasoning, not measured: a 95% interval wider than twenty percentage points cannot tell a system that is usually right apart from one that is right about as often as it is wrong, and that is the distinction every decision on this figure turns on. Where a figure says "too wide to be written as a rate", the counts are the result and the interval is what the counts are worth. Wilson rather than the textbook interval because the textbook one returns zero width at 4 of 4, which would report a four-example run as certainty.

## Classification

Two answers are scored, because there are two. The model **proposes**; `runMatchingStage` applies a proposal only at the `high` certainty band and otherwise keeps the deployment's fallback category. A fallback is recorded here as the system declining, never as an answer — on this deployment the fallback is a real category id, so a report whose reviewed label happened to equal it would otherwise have scored as correct while nothing classified it.

| Figure                                                    | Result                                                            |
| --------------------------------------------------------- | ----------------------------------------------------------------- |
| Model proposal matched the reviewed category              | 1 of 1 (95% interval 21%–100% — too wide to be written as a rate) |
| Model proposal matched the reviewed defect                | 1 of 1 (95% interval 21%–100% — too wide to be written as a rate) |
| Category the system applied matched the reviewed category | 1 of 1 (95% interval 21%–100% — too wide to be written as a rate) |

### Per language

| Language | Model proposal against the reviewed category                      |
| -------- | ----------------------------------------------------------------- |
| en-IN    | 1 of 1 (95% interval 21%–100% — too wide to be written as a rate) |
| mr-IN    | withheld — every row in this language is awaiting native review   |

### Per category

| Reviewed category     | Model proposal                                                           |
| --------------------- | ------------------------------------------------------------------------ |
| structure.roof        | 1 of 1 (95% interval 21%–100% — too wide to be written as a rate)        |
| sanitation.toilet     | nothing was scored into this cell, so there is no proportion to describe |
| (abstention expected) | nothing was scored into this cell, so there is no proportion to describe |
| electrical.lighting   | nothing was scored into this cell, so there is no proportion to describe |

### Every scored row

| Report      | Band | Model proposed           | System applied           |
| ----------- | ---- | ------------------------ | ------------------------ |
| `hold-0001` | high | matched (structure.roof) | matched (structure.roof) |
| `hold-0002` | high | withheld                 | withheld                 |
| `hold-0003` | —    | withheld                 | withheld                 |
| `hold-0004` | —    | outside the score        | outside the score        |
| `hold-0005` | —    | withheld                 | withheld                 |
| `hold-0006` | —    | outside the score        | outside the score        |
| `hold-0007` | —    | outside the score        | outside the score        |
| `hold-0008` | —    | withheld                 | withheld                 |

## Abstention coverage

0 of 0 reports where the corpus expects an abstention were abstained on; 0 asserted a category where none should be assertable; 0 of 1 scored reports were abstained on despite carrying a reviewed label.

Both directions are named every time. "It never over-asserted" means nothing without how often it had the opportunity to, and an abstention on a report that carried a perfectly good label is a cost too — it is a report nobody categorised.

## Routing

Routing is measured twice. End to end it uses whatever category the system settled on, which is what a citizen's report would actually get. From the reviewed label it forces the corpus's own category in and asks the directory the same question, which separates a wrong custodian caused by the directory from a wrong custodian caused by the classifier. The probe writes into a transaction that is always rolled back.

| Figure                                      | Result                                                            |
| ------------------------------------------- | ----------------------------------------------------------------- |
| Custodian correct, end to end               | 2 of 3 (95% interval 21%–94% — too wide to be written as a rate)  |
| Custodian correct, given the reviewed label | 3 of 3 (95% interval 44%–100% — too wide to be written as a rate) |

| Report      | Detail                                                                                                                                                         |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hold-0001` | end to end: routed to 'demo-dept-education-works'. From the reviewed label: routed to 'demo-dept-education-works'                                              |
| `hold-0002` | withheld — the label is a team draft awaiting a native-speaker reviewer; V011 §4 forbids it backing a measurement                                              |
| `hold-0003` | withheld — the label is a team draft awaiting a native-speaker reviewer; V011 §4 forbids it backing a measurement                                              |
| `hold-0004` | end to end: expected 'demo-dept-water-sanitation' and nothing was routed (no_directory_entry). From the reviewed label: routed to 'demo-dept-water-sanitation' |
| `hold-0005` | withheld — the label is a team draft awaiting a native-speaker reviewer; V011 §4 forbids it backing a measurement                                              |
| `hold-0006` | end to end: the corpus names no expected custodian for this report. From the reviewed label: no routing was produced for this report                           |
| `hold-0007` | end to end: left for operational review (no_directory_entry). From the reviewed label: left for operational review (no_directory_entry)                        |
| `hold-0008` | withheld — the label is a team draft awaiting a native-speaker reviewer; V011 §4 forbids it backing a measurement                                              |

## Candidate retrieval and merges

candidate recall and incorrect merges are reported separately and are never averaged into one figure: a missed duplicate produces two records of one problem, while a wrong merge produces one record of two problems and removes somebody's report from the count they were told they were part of

| Figure                                                                  | Result                                                            |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Reviewed duplicate pairs whose later report retrieved the earlier issue | 1 of 1 (95% interval 21%–100% — too wide to be written as a rate) |
| ...of those, merged onto one issue                                      | 1 of 1 (95% interval 21%–100% — too wide to be written as a rate) |
| Reviewed distinct pairs merged anyway                                   | 0 of 1 (95% interval 0%–79% — too wide to be written as a rate)   |
| Reviewed distinct pairs retrieved and correctly left separate           | 1 of 1 (95% interval 21%–100% — too wide to be written as a rate) |

| Pair            | Retrieved | Merged |
| --------------- | --------- | ------ |
| `dup-hold-001`  | yes       | yes    |
| `dist-hold-001` | yes       | no     |

## Unsupported statements in model replies

No reply carried a probability, a percentage, a numeric score, a severity assertion, a repair recommendation, a status assertion, or an echo of an instruction embedded in a report. 29 classification replies were scanned.

## Latency

Every observation is listed rather than summarised. With 37 calls a median and a 95th percentile would be a summary of almost nothing, and the two slowest calls are the interesting ones.

| Call        | Operation      | HTTP | Milliseconds |
| ----------- | -------------- | ---- | ------------ |
| `hold-0001` | classification | 200  | 30697        |
| `hold-0002` | classification | 200  | 16573        |
| `hold-0003` | classification | 503  | 705          |
| `hold-0003` | classification | 200  | 18618        |
| `hold-0004` | classification | 503  | 5345         |
| `hold-0004` | classification | 503  | 47173        |
| `hold-0004` | classification | 503  | 736          |
| `hold-0004` | classification | 503  | 28337        |
| `hold-0004` | classification | 503  | 925          |
| `hold-0005` | classification | 503  | 553          |
| `hold-0005` | classification | 503  | 555          |
| `hold-0005` | classification | 503  | 910          |
| `hold-0005` | classification | 503  | 882          |
| `hold-0005` | classification | 503  | 746          |
| `hold-0006` | classification | 503  | 549          |
| `hold-0006` | classification | 503  | 569          |
| `hold-0006` | classification | 503  | 1555         |
| `hold-0006` | classification | 503  | 1582         |
| `hold-0006` | classification | 503  | 2387         |
| `hold-0007` | classification | 503  | 994          |
| `hold-0007` | classification | 429  | 280          |
| `hold-0007` | classification | 429  | 334          |
| `hold-0007` | classification | 429  | 289          |
| `hold-0007` | classification | 429  | 298          |
| `hold-0008` | classification | 429  | 332          |
| `hold-0008` | classification | 429  | 598          |
| `hold-0008` | classification | 429  | 305          |
| `hold-0008` | classification | 429  | 314          |
| `hold-0008` | classification | 429  | 575          |
| `hold-0001` | embedding      | 200  | 663          |
| `hold-0002` | embedding      | 200  | 527          |
| `hold-0003` | embedding      | 200  | 549          |
| `hold-0004` | embedding      | 200  | 614          |
| `hold-0005` | embedding      | 200  | 664          |
| `hold-0006` | embedding      | 200  | 549          |
| `hold-0007` | embedding      | 200  | 607          |
| `hold-0008` | embedding      | 200  | 570          |

## Cost

37 provider call(s); 698 input tokens, 73 output tokens. No monetary cost is given: no price for this model is recorded in the source register, and a figure typed here would have no provenance.

## Error examples

- `hold-0004` (en-IN)
  - category: outside the score
  - routing: end to end: expected 'demo-dept-water-sanitation' and nothing was routed (no_directory_entry). From the reviewed label: routed to 'demo-dept-water-sanitation'

### Provider outcomes

The harness retries a retryable outcome on the deployment's own policy — the outbox allows five attempts with exponential backoff — because a run that gave up on the first 503 would measure a worse system than the one that is deployed. That policy has a consequence worth recording: its backoff (2, 4, 8, 16 seconds) fits inside the provider's per-minute window, so against a rate limit the retries are part of what sustains the limit. The provider's own `RetryInfo` hint is honoured when it sends one, and is the only thing that prevents that.

- `hold-0003`: no answer after 5 attempts
- `hold-0004`: no answer after 5 attempts
- `hold-0005`: no answer after 5 attempts
- `hold-0006`: no answer after 5 attempts
- `hold-0007`: no answer after 5 attempts
- `hold-0008`: no answer after 5 attempts

These rows had **no proposal at all** after the retry policy was exhausted. They are scored as unscorable, never as abstentions: a 503 is a property of an afternoon and declining to classify is a property of the system, and merging them would let an outage be read as care. A reason code beginning `provider_` is an outage; anything else is the reply being refused before it could become a proposal.

- `hold-0003`: unusable_model_output
- `hold-0004`: provider_http_503
- `hold-0005`: provider_http_503
- `hold-0006`: provider_http_503
- `hold-0007`: provider_http_429
- `hold-0008`: provider_http_429

## Limitations of this run

- The evaluation database held **only** the rows in this split. Retrieval was therefore measured against a near-empty district, which says nothing about how many wrong candidates would be retrieved at a real report density.
- No image or audio reached a model. The corpus carries no media bytes by design (V011), so this measures the text path only.
- Transcription (V024) is not exercised here: every row arrives as text, so nothing measures the voice path.
- The adversarial cases in `adversarial.json` are not scored by this run. Instruction-echo is detected in replies as an unsupported statement, but the injection boundary itself is V047's subject.
- Nothing here measures what a reviewer or a citizen does with a proposal. A proposal that is wrong and visibly low-certainty costs less than one that is wrong and confident, and this run does not observe that difference.

## Reproducibility, and what publishing this costs

The **method** is reproducible: the versions above, the disposable database, the seeding and the row order are all fixed, and the machine-readable record of every run is kept under `deliverables/v046-runs/`. The **provider is not deterministic**, and that is not a caveat to skip over — two runs of identical code against identical rows minutes apart can differ in how many calls the provider answers at all. Comparing two runs means comparing the records, not remembering the first one.

Publishing a result costs holdout. This document names report identifiers, their languages, their reviewed categories and the custodians expected for them, because V046 asks for per-category results and error examples and there is no way to give those without disclosing part of what was held out. So these 8 rows are now less held-out than they were this morning, and a future measurement that needs them unseen needs **new** rows rather than these ones again. That is an argument for growing the corpus, not for publishing less of what was measured.

## Reproducing this run

```bash
npm run eval:holdout -- --reason "V046 scored run" --split holdout --provider real
```

The seal additionally requires the environment variable `VISION_EVAL_RUN` to be set to `1` for that process. No script and no committed file sets it — `tools/check-holdout-seal.mjs` fails the build if one ever does — so unsealing the holdout is always a deliberate act typed at a command line, and the reason above is recorded with it.

The harness creates a disposable database, migrates it, seeds the corpus structure, runs every row through `runMatchingStage`, writes this document and a machine-readable record under `deliverables/v046-runs/`, and drops the database in a `finally`. The holdout is never written into a database anything else reads.
