# V042 — Transparent prioritization and sensitivity checks

**Roadmap task:** V042 · **Prerequisites:** V002, V025, V037, V040, V041 · **Owner:** Data + Product
**Code:** `packages/domain/src/prioritization.ts`, `packages/adapters/src/prioritization.ts` · **Pack:** `packs/demo-district-a/prioritization.json`

Every earlier task in this system refused to produce a score: V034 refused urgency, V036 refused severity, V041 refused a confidence number. This one is asked for a weighted ordering, and those refusals still hold. What it produces is not a score with a ranking attached — it is **an ordering together with how much that ordering depends on assumptions nobody has validated.**

## 1. You cannot get an ordering without its sensitivity

`prioritise` takes a _set_ of plausible weightings and returns a rank **interval** per candidate. There is no single-weighting entry point to reach by mistake, and `loadPrioritizationPolicy` refuses a pack declaring fewer than two. A position that swings from 7th to 16th across weightings somebody could equally have chosen is not a finding about the world, and the only way to know that is to be shown both.

There is deliberately **no published score field and no single `rank`**. A test asserts that nothing in the placement type is named `score`, `priority` or `rank` — the same structural device as V037's `ResolutionSpeed`, which has no field that reads as a headline.

Stability is measured against the candidate's **own** position rather than the length of the list: a swing of nine places matters enormously at position seven and not at all at position ninety. A proportion-of-the-list measure gets this backwards — in a long list every swing looks small, so the top of the ordering, the only part anybody reads, would always report as robust however much the weighting moved it.

## 2. Missing data redistributes weight; it never scores zero

A factor with no value has its weight redistributed proportionally across the factors that remain. Counting it as zero would push a ward to the bottom of every ordering **for having been measured less**, which is precisely the failure the equity clause exists to prevent.

Below `minimumFactorsForRanking`, a candidate is reported as `not_ranked` and still listed — an ordering built on one factor is that factor wearing a ranking's clothes, and a candidate missing from a list reads as one nobody needed to consider.

The adapter withholds rather than substitutes: a ward with no population figure arrives as `null`, and its report count is withheld with it, because reports per head is undefined without a denominator and a volume presented as a rate is how a large ward looks like a troubled one.

## 3. Low reporting is not low need

The equity factor is **inverted on purpose**: few reports per head raises a candidate rather than lowering it, because a quiet ward is at least as likely to be one where reporting is hard as one where nothing is wrong. This is the mechanism by which a lower-reporting high-need case can rank at all, and it is a stated assumption printed beside the figure, not a discovery.

On the demo data the top-ranked report sits in a ward recording **1 report per 1000 residents against a reference of 8**, and its explanation says so in those words.

## 4. A candidate does not depend on its cohort

Every transform uses absolute reference points from the policy pack — no cohort percentiles, no z-scores. Adding an unrelated report therefore cannot move another candidate's contribution, and an explanation that was true yesterday is still true. A test adds two unrelated candidates and asserts the subject's factors are byte-identical.

## 5. Factors with no source are declared, not omitted

| Factor             | Status                                    | Why                                                                                                                                                        |
| ------------------ | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| severity           | **no source in deployment**               | No calibrated severity model has ever existed here; V046 is the task that would evaluate one. Nothing in this ordering reflects how dangerous anything is. |
| accessibility      | **no source in deployment**               | V040 imports population, enrolment, access and investment only.                                                                                            |
| persistence        | available                                 | Days open against a configured reference, plus a configured increment per reopening.                                                                       |
| service population | available where imported                  | From the V040 context import.                                                                                                                              |
| reporting equity   | available where a population exists       | Reports per 1000 residents, inverted.                                                                                                                      |
| alternatives       | available where the report has a position | Comparable assets within a configured radius.                                                                                                              |
| existing project   | available where the register was searched | Direction is a **policy choice**, stated with its rationale.                                                                                               |

Leaving `severity` out of the factor list entirely would hide that the ordering is made without it. Declaring it empty puts that absence into every explanation the policy produces.

The existing-project direction is configured because both readings are defensible — already funded may mean already handled, or may mean the money did not fix it — so the pack chooses one and says why, and the code refuses to pick. V041's distinction between "searched and found nothing" and "nobody has looked" survives into the factor: the second is missing data, not an absence of projects.

## 6. Disclosures

`orderingDisclosures` is assembled from the policy rather than written at a call site, so an ordering cannot be obtained without them. They state the budget assumption — **no budget, cost, capacity or delivery-time information is used anywhere** — the number of weightings, the redistribution rule, and that this is an ordering of reports by configured factors rather than a finding about need or a statement about how public money should be spent.

`priorityOverclaims` checks eight banned phrasings (_optimal_, _best use of_, _should be funded_, _priority score_, _most urgent_, _highest need_, _recommended spend_, _where the money should go_) against everything an ordering can put on a screen.

`npm run priority:report` prints the sensitivity summary **before** any position, and adds a caveat when almost everything reads as robust: on near-identical synthetic reports a stable ordering is stability, not evidence, and a reader seeing a column of "robust" would otherwise take the ordering as well supported.

## 7. Limits

- **No severity, no accessibility, no cost.** Three of the factors the roadmap names have no source here, and two are declared permanently empty.
- **Scope of the demonstration.** The candidate list is capped, and the result says so rather than letting an unchosen cut-off look like the end of the list.
- **No screen.** V043 is the policy decision and investment comparison view; the per-factor contributions and per-weighting positions this produces are shaped for it, and building it here would show component scores without the drill-down and scenario comparison that make them readable.
