# V022 — Verify Ingestion Recovery and Duplicate-Delivery Behaviour

**Status:** Ready for owner approval
**Roadmap task:** V022 · **Prerequisites:** V017, V018, V020, V021 · **Owner:** Backend + QA
**Code:** `packages/adapters/src/recovery.dbtest.ts` (8 scenarios) · fixes in `media-processing.ts` and `outbox.ts`
**Run it:** `npm run db:up && npm run db:migrate && npm run test:db`

## 1. What this task is, and what it is not

V017 already covered the lease and outbox _primitives_ in isolation — 19 tests for claiming, fencing, backoff and reconciliation. V022 covers the whole media stage under the failures that actually happen: a worker that dies, the same task delivered repeatedly, bytes that have gone missing, a lease that expires mid-work, and a crash landing between committing a result and acknowledging the task.

Running the real pipeline rather than the primitives found two defects the primitive tests could not.

## 2. Defect: missing bytes were an invisible failure

An evidence row can reference an object whose bytes are gone — a restore gap, a botched migration, a bug. `readOriginal` threw `ENOENT` straight out of `processEvidence`, so:

- nothing recorded why,
- the stage stayed **`leased`**, and
- the failure was visible only as an unhandled rejection in a log.

That is precisely the outcome V022 forbids. It now fails the stage with `missing_original` or `unreadable_original` and returns a recoverable failure, so the stage is `failed_retryable` with no lease holder and a reason an operator can read. A test proves the retry succeeds once the bytes are restored.

## 3. Defect: an abandoned unit of work could not be identified

`findExpiredStageLeases` returned only `{ stageId, attempts }`. An operator could see that _something_ was stuck but not what, turning every recovery into a second query. It now also returns the submission, stage, pipeline version and lease owner. Additive, so no caller broke.

## 4. The scenarios

| Scenario                              | Outcome asserted                                                                                                                         |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Bytes missing                         | `failed_retryable`, no lease owner, reason recorded, visible                                                                             |
| Bytes restored                        | Retry produces the one authoritative result                                                                                              |
| Worker died holding a lease           | Discoverable and reconciled to `failed_retryable`                                                                                        |
| **Really killed process (SIGKILL)**   | Leaves `state=leased`, owner recorded, **no** result; reconciliation correctly leaves it alone until the lease expires, then recovers it |
| Dead worker's late write              | Refused by the fencing token; the takeover's result stands                                                                               |
| Same task delivered 3×                | One stage row, one real run, `current_version` = 2 (not 3)                                                                               |
| Crash after commit, before ack        | Redelivery is `alreadyProcessed`, result byte-identical, fencing token unchanged                                                         |
| Repeat delivery with an external call | The call happens **once**                                                                                                                |

The SIGKILL case spawns a real child process that takes a lease and is killed. It asserts something worth knowing: a crashed worker's stage is **not** immediately reclaimable, and that is correct — reclaiming a lease early would let two workers run the same stage at once, which is worse than waiting.

## 5. The distinction the roadmap asks for

An idempotent _database_ outcome is not an idempotent _external_ one. The duplicate-delivery test proves the database side: one stage row, one version bump. A separate test counts invocations of a side-effecting operation standing in for a paid call, and proves the count stays at 1 across redeliveries — because the `already_succeeded` short-circuit stops it, not because the database did.

Stated plainly: **database idempotency alone would not have prevented a second charge.** V006 §12 consequence 6 already accepted that a crash _between_ a paid call and its commit can cause a repeat; nothing here removes that, and the roadmap's caching-by-input-hash mitigation belongs to V023's budget work.

## 6. Verification

6 mutations against the changed code, 0 survivors — including rethrowing a missing original, leaving the stage leased, reporting the failure as success, using a vague reason, and re-running the external call on a duplicate.

## 7. Not done

No chaos testing under concurrent load (V049) · no restore drill (V062) · the relay itself is in-process locally, so V006 §11's accepted divergence stands: local delivery is more orderly than production will be.
