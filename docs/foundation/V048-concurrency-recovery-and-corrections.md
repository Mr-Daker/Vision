# V048 — Concurrency, recovery and analytics corrections

**Roadmap task:** V048 · **Prerequisites:** V022, V028, V029, V035, V036, V038, V041 · **Owner:** Backend + QA
**Code:** `packages/domain/src/integrity.ts`, `packages/adapters/src/integrity.ts` · **Suites:** `packages/adapters/src/histories.dbtest.ts`, `packages/adapters/src/integrity.dbtest.ts` · **Command:** `npm run integrity:check`

Every component this task covers was already tested on its own: the assignment race in V028, delivery in V017, crash boundaries in V022, the projection in V038. What none of them covered is the **history** — the sequence a real afternoon produces, where a merge lands between a question and its answer and a projection has to survive both — and the clause V048 adds at the end: unrecoverable states must be **visible, with an operator repair procedure**.

## 1. A finding an operator cannot act on is an alarm with no exit

`integrityFinding` refuses to build a finding without three things: what is wrong, **what happens if nobody acts**, and **what to do**. An `unrecoverable` finding must additionally say what was lost, and a repairable one may not claim a loss — otherwise every alert reads the same and the severity stops carrying information.

That is why `procedure` is a sentence and not a category. "Reconcile the projection" is a category. "Run `npm run summaries:rebuild`, which recomputes every cell from the records and is safe to run at any time" is something somebody can do at three in the morning.

`unrecoverable` does not mean stuck. It means **the information needed to decide correctly no longer exists**, so whatever happens next is a person choosing rather than a repair — and the record should say a person chose. Both unrecoverable checks here end with that instruction, and the transition one explicitly refuses the obvious wrong move: _do not edit the status to match a guess; a fabricated history is worse than a gap that says it is one._

## 2. Half the checks were looking for states the schema forbids

Each check is planted before its clean result is believed — V044's device, for V044's reason. Planting them found something better than a bug: **four of the ten conditions cannot be created at all**, because the database refuses them on write.

| Condition                                   | Refused by                                         |
| ------------------------------------------- | -------------------------------------------------- |
| evidence live on two issues at once         | `issue_evidence_link_one_active_per_evidence_uniq` |
| two issues sharing a public reference       | `canonical_issue_public_reference_key`             |
| one participant counted twice on one issue  | `issue_participation_participant_issue_uniq`       |
| a task both delivered and terminally failed | `outbox_terminal_requires_no_delivery_ck`          |

Those checks stay, because a migration can drop a constraint — but what `integrity.dbtest.ts` proves for them is the **constraint**, not the query, since a query that has never been able to return a row proves nothing about itself. The tool says so on every run: _the condition cannot occur: `<constraint>` refuses it on write_. A guarantee enforced on every write is stronger than one a script looks for once a night, and saying which is which is the whole point.

The six that can fire are proved the other way: the condition is planted inside a transaction, the check is required to find it, and the transaction is rolled back so the development database is not left holding the corruption the suite invents.

## 3. Three faults the check found, two of them in itself

Running it against the real database immediately found two bugs **in the checks**:

- the transition check compared `status_event.aggregate_id` to a `uuid` without a cast, so it did not run at all — and reported that it had not run, which is the only reason it was noticed;
- the denominator check counted facts retired by a merge, which V038 holds deliberately and counts in no cell, so it reported a correct projection as broken.

The third was real and is recorded rather than fixed: the development database holds **67 issues in a status no event ever moved them to**, left by suites whose fixtures insert `canonical_issue` rows directly. That is a true finding about that database. The procedure is the right one — record an operator note, do not invent the missing history — and the histories suite excludes this one check from its own assertion, with the reason written where the exclusion is, because failing on somebody else's leftovers would teach people to ignore the suite.

A fourth check was **deleted**. It reported evidence whose live link still named an issue a merge had retired, which sounds like a fault and is in fact how V028's merge works: the merge record is authoritative and reads resolve through the alias, so the link keeps naming where the evidence actually landed. It fired on every correct merge. A check that fires on correct behaviour is worse than no check, because it is the one that teaches people to skip the output.

## 4. The eight histories

Each runs end to end through the real functions and ends the same way.

| History                    | What it establishes                                                                                                         |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| simultaneous first reports | two reports racing on separate connections never both create an issue, and both end on one issue with nobody counted twice  |
| stale confirmation         | a citizen confirming a candidate that was merged away between the question and the answer attaches to the **survivor**      |
| overlapping merges         | A→B then B→C resolves through two hops and is not reported as a cycle                                                       |
| repeated acknowledgments   | a callback arriving twice is one acknowledgment                                                                             |
| reopened closure           | a full six-step lifecycle ending in a reopening keeps every transition on the record, and moves nobody's contribution count |
| task reordering            | events applied twice after a crash before the acknowledgment move nothing                                                   |
| crash boundaries           | the same, from the projection's side: the claim row is deleted and the pass is repeated                                     |
| late corrections           | a jurisdiction corrected after the fact **moves** the issue's fact rather than adding a second one                          |

## 5. The ending is the assertion

Every history closes with two questions, in that order, because they are different questions.

**Does the projection say when it is behind?** Applying events incrementally cannot discover a newly opened issue, because nothing in this system emits an event when one opens — a gap V039 already found and answered with `unprojectedIssues` in the freshness report. So a projection that is behind and says so is sound; one that is behind and reports itself fresh is the fault, and that is what is asserted.

**Is it reconcilable with the records at all?** A rebuild reads the records and recomputes; reconciliation compares. A history that moved a count the records cannot account for fails here, and no rebuild would fix it.

## 6. The command

```bash
npm run integrity:check     # exits non-zero on any finding, so it can gate a release
npm run integrity:report    # the same run, printed for a person
```

The difference is the exit code and nothing else: a check only a human reads is a check nobody runs on a Sunday, and a gate that prints nothing useful is a gate somebody disables. It repairs nothing — `reconcileSummaries` set that rule for the projection and it is the right one generally, because a tool that quietly fixes what it finds destroys the evidence of how it broke.

## 7. What a clean run does not establish

- these are the invariants somebody wrote down; a corruption that breaks none of them produces no finding;
- a check compares derived state against the records it was derived from, so a fault in the records themselves is invisible to it;
- it reads identifiers and counts, never report content;
- a clean result describes the moment it ran;
- four of these conditions cannot occur at all, and those checks have never been able to fire.

## 8. Open

Nothing emits an event when an issue opens, so the incremental projection cannot discover one without a rebuild; the freshness report says so on every read, and closing it is a change to the assignment path rather than to this task. The development database's 67 issues without provenance are a fixture practice worth changing — fixtures that insert advanced statuses directly leave states an operator cannot distinguish from a fault.
