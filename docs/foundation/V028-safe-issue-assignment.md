# V028 — Finalise Canonical Issue Assignment Safely Under Concurrency

**Status:** Ready for owner approval
**Roadmap task:** V028 · **Prerequisites:** V014, V017, V022, V026, V027 · **Owner:** Backend
**Code:** `packages/adapters/src/issue-assignment.ts`
**Tests:** `issue-assignment.dbtest.ts` (12) · 18 mutations, 0 survivors

## 1. The failure this exists to prevent

Two citizens report the same pothole at the same moment. Both candidate searches legitimately find nothing. Two canonical issues are created for one problem. **Neither transaction did anything wrong in isolation** — this is write skew, and no amount of care inside a single transaction's own logic prevents it.

## 2. Strategy: SERIALIZABLE with a bounded retry

Chosen over the alternative — an explicit advisory lock on a coarse spatial bucket — because with a bucket, correctness depends on geometry: two reports thirty metres apart can straddle a boundary, take different locks, and the bug comes straight back.

Under SERIALIZABLE each transaction's read predicate covers the other's insert, so PostgreSQL detects the conflict and aborts one. The retry re-reads, sees the issue that was created, and reports the decision **stale** rather than duplicating it. The test runs two genuinely concurrent transactions on separate connections and asserts exactly one issue exists.

Retries are capped at 5 and the ceiling is asserted, so a pathological conflict fails loudly instead of spinning.

## 3. Expensive inference stays outside the transaction

The proposal is computed first and passed in. A transaction held open across a provider call is how a connection pool is exhausted by a slow third party (V006 §5). A test passes a classifier that throws if called, and the assignment completes without touching it.

The transaction is deliberately short: a recheck, a few inserts, a commit.

## 4. Staleness is judged only on what could change the decision

The recheck filters to the **same category**, because V027 gates on category before anything else — a different defect appearing nearby cannot alter the proposal and must not force a rerun. A stale attempt is recorded as `failed_retryable` with both candidate sets in its basis, so the rerun is visible rather than a silent retry.

## 5. Aliases and versions at commit

A proposal may name an issue that a merge has since retired. `resolveActiveRoot` resolves it at commit and the result records `resolved_through_alias`, so evidence lands on the issue that survived rather than on a tombstone. A cycle or over-deep alias chain **throws** rather than attaching somewhere arbitrary: hiding evidence in a broken chain is worse than failing.

An optional `expectedIssueVersion` makes the attachment conditional on the target not having moved.

## 6. Merge and separation are reversible, and atomic

A merge is a reviewer command, never a matcher output. It records an event, a merge row and an alias edge. Reversal — the separation command — **keeps** the merge row and marks it reversed, and closes the alias rather than deleting it: a reader asking why an issue was briefly unreachable deserves an answer.

**A real bug found by mutation testing:** the three writes were not in a transaction. A merge naming a non-existent issue passes the event insert (no foreign key) and fails the merge row, leaving a committed event permanently asserting a merge that never happened — the log and the state disagreeing, with the log being what a reviewer trusts. Both commands are now atomic, and a test injects exactly that failure.

## 7. Verification

12 database tests, 18 mutations, 0 survivors. Also improved the test harness itself: a failing `after` hook left its connection open, so the file hung with every test passing and the error never printed. Cleanup now runs on a fresh connection with a statement timeout, and the underlying fault — deleting `issue_match` before the links referencing it — was a cleanup ordering bug the hang had been masking.

## 8. Not done

The V032 reviewer interface now invokes merge and separation through a simulated, explicitly labelled reviewer identity backed by durable role and jurisdiction grants. Replacing that simulation with production staff authentication remains **V057**. Load testing of serialization-failure rates remains **V049**.

**Closed since this was written**

- V026 → V027 → V028 → V029 → V033 is wired end to end in `packages/adapters/src/matching-pipeline.ts`, inside one V017 stage lease.
- `assignSubmissionToIssueInTransaction` is the savepoint variant. A caller that must write atomically alongside the assignment can now do so, and a caller's rollback undoes the assignment with it.

Two preconditions are checked rather than assumed, because getting either wrong fails silently rather than loudly:

- **Already in a transaction.** A stray `SAVEPOINT` raises `25P01`, which is how this is detected; in autocommit each statement would commit on its own and the caller would believe they had atomicity without having it.
- **SERIALIZABLE.** The recheck is only sound at that level. At READ COMMITTED two callers can both recheck, both see no conflict, and both open an issue for the same problem — the duplicate protection would look present while doing nothing. Note that "read committed" is also what autocommit reports, so the two failures are distinguished and get different messages.

It deliberately does **not** retry. This was checked against PostgreSQL rather than assumed, and the first version of this note was wrong: rolling back to the savepoint _does_ leave the transaction able to commit — without the rolled-back work. What it cannot do is succeed at the _same_ work, because the serialization conflict is recorded against the transaction. So an internal retry loop would burn its attempts and fail anyway, and the result is `caller_must_retry` instead. A permanent error still throws, because a caller told to "retry" acts on that in a loop.

18 tests; every mutant caught, including "silently open its own transaction when not in one", "retry internally instead of telling the caller" and "treat every error as retryable".
