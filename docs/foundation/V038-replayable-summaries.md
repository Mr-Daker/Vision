# V038 — Replayable regional and category summaries

**Roadmap task:** V038 · **Prerequisites:** V017, V028, V029, V035, V037 · **Owner:** Data + Backend
**Code:** `packages/domain/src/summary-projection.ts`, `packages/adapters/src/summaries.ts` · **Schema:** migration `0026`

V037 defined what the numbers mean. This projects the authoritative records into tables a dashboard can read without walking the whole ledger, in a way that can be rebuilt from scratch and continuously checked against itself. The district dashboard that reads these tables is V039.

## 1. The decision everything else follows from

**A projection stores state, not deltas.**

Projecting an issue recomputes its whole row from `canonical_issue`, `issue_alias` and `issue_participation`, and overwrites it. Nothing in this task ever adds one to a counter. Three of V038's requirements fall out of that rather than each being defended separately:

- **Retries cannot increase counts.** Replaying an event writes the same row. There is no code path on which applying twice differs from applying once, so the guarantee does not rest on `summary_applied_event` being perfect — that table exists to avoid wasted work and to make `events_applied` meaningful, not to keep the totals correct. The test proves this the hard way: it deletes the applied-event rows to force a full re-read, applies three more times, and compares the cells byte for byte.
- **Separations need no compensating write.** A merge reversal closes the alias edge; the next recompute sees an issue that is its own root again and says so. Nothing has to remember to undo an increment applied weeks earlier — which is the class of bug that makes delta-maintained summaries drift slowly and unfixably.
- **Corrected jurisdiction attribution moves rather than duplicates.** An issue's row names exactly one cell. Change the attribution and the row moves; both the old and the new cell are recomputed in the same pass, and a cell that has emptied is deleted rather than left holding the count it had when somebody last reported there.

## 2. The two paths, and why they are allowed to disagree

|                      | Driven by                | Scope                      | Purpose                          |
| -------------------- | ------------------------ | -------------------------- | -------------------------------- |
| `rebuildSummaries`   | the authoritative tables | every issue                | seed, and the independent answer |
| `applySummaryEvents` | the event ledger         | the issues the events name | keep up                          |
| `reconcileSummaries` | both                     | every issue                | say when they differ             |

They are genuinely different computations, which is what makes comparing them worth doing. The rebuild never reads `status_event` to decide anything; the incremental path uses it only to decide **which** issues to recompute. Reconciliation rebuilds in memory, compares, records the verdict, and **repairs nothing** — a reconciliation that fixed what it found would destroy the evidence of the bug it detected, and every run after it would pass.

A projection is seeded by a rebuild and maintained incrementally after it. That is the operating model, and it is the one the acceptance test measures: rebuild, replay a history containing a merge, a separation, a jurisdiction correction, a reassignment, a reopening and a backdated event, reconcile, rebuild again, compare.

## 3. Ingestion order, not event order

The incremental cursor advances on **`recorded_at`**. A backdated correction describes an earlier moment but arrives later; a cursor that advanced on `occurred_at` would have moved past it long before it existed, and it would never be projected at all. Ingestion order is the only order in which "everything since last time" is a complete answer.

This is the mirror image of V037, where `occurred_at` and `recorded_at` are two separate bounds a caller chooses between. A projection is not choosing a horizon — it is trying not to miss anything.

## 4. Merges, and what a cell may not be asked

The alias walk covers **every** issue on every pass, even when one issue is being refreshed. Folding participation into a root requires knowing every child of that root, and a child can easily sit outside the set an event named. Scoping the walk would make an incremental refresh cheaper and occasionally wrong.

`affectedIssueIds` widens the set before anything is recomputed: to the issues a merge event names in its payload — `issue_merged` is recorded against the **surviving** issue, so refreshing only the aggregate would leave the merged-away issue counted as separate open work forever — and to every issue whose stored row currently points at one of them as its root, without which a separation would leave the freed issue still claiming it had been merged away.

A third widening is not about merges at all. **No production path appends a `created` event when an issue is opened** — matching finalisation writes the row and records its decision elsewhere — so an event-driven projection would never learn that a new report existed, and the first time a district summary heard about it would be the next full rebuild. Every pass therefore also anti-joins `canonical_issue` against its own fact table and projects whatever has no row yet. The worker's own reconciliation pass found this defect, two issues at a time, before that sweep existed; the upstream gap is real and is recorded separately, but a projection whose completeness depends on every writer remembering to emit an event is a dependency it does not need.

An issue whose root cannot be established — a cycle, or a chain past 16 hops — is projected as `unknown`. This differs from V037 on purpose. A metric excludes what it cannot resolve, because an excluded row cannot corrupt a rate. A projection holds a row for every issue, so the honest representation is a visible `unknown` bucket rather than a gap in a table whose totals are read as complete.

`summary_cell.counted_participants` is a distinct count **within** a cell and is not additive across cells: the same person can report in two wards, and two cells of nine are not eighteen people. `rollUpCells` shares V037's refusals exactly, so a caller gets a refusal with a reason rather than a plausible wrong total. On the current demo database, rolling issue counts up across all 140 cells is also refused — for a second reason, that three different boundary directory versions are present and their total would describe no real area.

## 5. What the database enforces

- `summary_issue_fact (summary_name, issue_id)` — the primary key that makes an upsert idempotent.
- `summary_issue_fact_retired_ck` — `retired_by_merge` must agree with whether the root is the issue itself. Inverting those is precisely how a merged report gets counted twice.
- `summary_cell_partition_ck` — the state counts must add up to the issue count. A cell where they do not is a projection bug, and refusing the write is the difference between a failed refresh and a dashboard that is quietly wrong.
- `summary_applied_event (summary_name, event_id)` — two concurrent passes claiming the same event is the ordinary case under retry, and a check-then-insert is not a defence against it. A test runs two passes on separate connections and asserts each event was claimed exactly once.
- `summary_reconciliation_verdict_ck` — a run cannot record `reconciled` while also recording mismatches.

## 6. Observability

`summaryStatus` returns freshness and the last reconciliation verdict together, always. Either alone lets a reader draw the comfortable conclusion: a projection that ran a second ago having skipped four hundred events is not fresh, and one that reconciled cleanly last week has said nothing about today. `assessFreshness` reports `never_built` as its own state rather than as zero staleness, because a summary that has never been built has absent cells and nothing should be read from them.

The dev worker applies events every pass and reconciles every thirtieth (`SUMMARY_RECONCILE_EVERY`), logging a failure loudly and with the first five specific differences. A reconciliation failure that logs only "mismatch" gets muted rather than investigated.

## 7. Limits

- **Current state only.** A summary describes the present and records when it was built. Asking what the district looked like in March is V037's question, answered from the ledger; answering it from a table that only ever holds current state would be an invention.
- **Category and jurisdiction have no effective-dated history** (V037 §3), so a corrected attribution moves the issue's entire history into the new cell. The summary cannot say the issue was ever counted elsewhere.
- **No API and no screen.** Both are V039.
- **`rebuildSummaries` is single-transaction and whole-table.** At demo scale that is a few hundred milliseconds. A deployment with real volume would need a chunked rebuild that does not hold one transaction open across the whole district, and that is V049's work rather than a change to the contract above.
