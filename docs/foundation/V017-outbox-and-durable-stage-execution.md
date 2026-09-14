# V017 — Outbox Delivery and Durable Stage Execution

**Status:** Ready for owner approval
**Roadmap task:** V017 · **Prerequisites:** V008, V012, V013, V014 · **Owner:** Backend + Platform
**Code:** `packages/adapters/src/outbox.ts` · **Tests:** `outbox.dbtest.ts` (17, real PostgreSQL)

> These are database tests, not mocks: claim contention and lease takeover open a **second connection**, because `FOR UPDATE SKIP LOCKED` and lease fencing cannot be demonstrated inside one transaction. Run with `npm run db:up && npm run db:migrate && npm run test:db`.

## 1. Domain change and pending work commit together

`appendEventWithOutbox(tx, event, tasks)` inserts the `status_event` row and its `outbox` rows **inside the caller's transaction**. There is no queue client, so there is no window in which a domain change is committed but its follow-up work is lost, and none in which work is queued for a change that rolled back. Both directions are tested: after commit the event and its two tasks are visible together; after rollback neither exists.

`outbox_event_task_uniq (event_id, task_type)` means a retried domain transaction cannot enqueue the same work twice.

## 2. Delivery is at-least-once, so effects must be idempotent

| Behaviour                 | Mechanism                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------ |
| Bounded dispatch          | `claimOutboxBatch({limit})`, 1–1000; a relay pass stays bounded regardless of backlog            |
| No double-claiming        | `FOR UPDATE SKIP LOCKED`; two relays on separate connections claim disjoint sets, covering all   |
| Backoff                   | `not_before = now() + base * 2^attempts` (base 2 s); work scheduled ahead is not claimed early   |
| Terminal failure          | after `maxAttempts` (5) the row stops being claimable and is reported as terminal                |
| Abandoned claims          | `reclaimAbandonedClaims` returns claims older than `claimStaleAfterSeconds` (300 s) to claimable |
| Duplicate acknowledgement | `markDelivered` returns `false` the second time — a no-op, not a second effect                   |

A duplicate delivery of the same task does not duplicate the committed effect: the effect is keyed, and the test asserts the second delivery changes nothing.

## 3. Stage leases with fencing tokens

A processing stage is keyed by `(submission_id, stage, pipeline_version)` — unique, so the same stage of the same pipeline version cannot run twice concurrently. `acquireStageLease` issues a monotonically increasing **fencing token** with each lease.

Every write-back (`completeStage`, `failStage`, `renewStageLease`) is conditional on `stage_id = $1 AND fencing_token = $2 AND state = 'leased'` and reports whether it actually applied. **An expired worker that wakes up late cannot overwrite the result of a newer lease** — its token no longer matches, its update touches zero rows, and it learns that it lost. That is the property the roadmap's "done when" asks for, and it is tested directly: a stale holder's `completeStage` returns `false` while the newer lease's result survives.

`findExpiredStageLeases` and `reconcileExpiredStages` make expired work discoverable and return it to claimable, so a crashed worker loses the lease, not the work.

## 4. A precedence bug worth recording

The claim predicate mixes `state IN (...)` with `state = 'leased' AND lease_expires_at < now()`. Written without parentheses, `AND` binds tighter than `OR` and the expiry condition silently applies to only one branch — a query that returns plausible results and is wrong under contention. The group is now explicitly parenthesised.

## 5. Test isolation (learned the hard way, twice)

Relay claiming is **global by design**: a relay claims whatever is due, not whatever a given test created. That made the first version of these tests depend on owning the outbox table, which broke in two different ways.

- **Parallel dbtest files.** `npm run test:db` now runs with `--test-concurrency=1`. The dbtest files share one mutable database, so running them in parallel was never sound — one file's committed rows are visible to another's queries.
- **Requiring an empty outbox.** The next attempt asserted no pending rows existed before the tests ran. That failed the moment anyone used the demo interface, because a real submission enqueues real pending work — the guard was blaming the developer for using the product.

The fix is proper isolation rather than a precondition: `claimOutboxBatch` takes an optional **`taskTypes`** filter, and the tests enqueue and claim their own task type. This is a production capability, not a test hook — a deployment can run one relay per handler so a slow recipient notification does not hold up projection refreshes — and it is covered by its own test, including that an empty filter is refused rather than silently claiming nothing.

The database suite now passes twice in a row **with unrelated demo rows pending**, and leaves the database exactly as it found it.

## 6. The relay now runs (added after the fact)

This section used to say "no relay process runs yet — these are the primitives". That was accurate and it was also the single most consequential gap in the system: `apps/worker` registered **no stage handlers**, and its own status string said so. A citizen submitted a report, received a durable receipt, and then nothing happened to it. The `process_submission_media` task that `submissions.ts` enqueues in the same commit as the submission sat in `outbox` forever. Every stage was built and tested; none of them ran.

`apps/worker/src/relay.ts` claims a bounded batch and runs it, `handlers.ts` registers the stages, and `dev-worker.ts` is the loop. One pass is a function rather than a loop so it is testable without timers and a deployment chooses its own cadence. The chain is two stages, because that is what the outbox is for — each is independently retryable, so a slow classification does not force the media work to be redone:

    submission_received -> process_submission_media -> match_submission

**Verified by running it**, not only by tests. A report submitted through the real API produced: matching stage `succeeded`, issue `VIS-27405DD8` opened and jurisdiction-scoped, routed to `demo-sanitation` with `recipient_mode` `simulated`, a trust report with five checks stored and not flagged, and an empty backlog.

The failure behaviour is the part that needed pinning, because a relay that loses work is worse than no relay at all: an unhandled task type is never marked delivered, a throwing handler leaves the work to be retried, a refused task stays visible, and an `already_processed` result is acknowledged rather than retried — which is the crash window this deliverable exists for.

**Two bugs the live run found that the tests did not**

1. **Every real report was refused.** `submissions.ts` enqueues `[{ task_type: "process_submission_media" }]` with **no payload**, and the handler required a `submission_id` from it — because this file's fixture supplied one, having been written from an assumption rather than from the producer. The submission is now resolved from `status_event.aggregate_id`, which is authoritative and also works for rows already queued.
2. **The reporter is never counted.** Counting a contribution needs `demo_processing` consent (V014). The adapter that writes a consent record exists and **nothing calls it** — 572 participants in the development database have none — so every real report is "recorded but not counted". Writing the capture notice that grants that consent is **V044**, owned by Security; inventing the wording here would decide a privacy question that task exists to decide. What was fixed is the interface consequence: discovery said "0 people reported this" about an issue that exists _because_ somebody reported it.

## 7. Not yet done

`dev-worker.ts` is development-grade: it polls on a fixed interval and loads the selected versioned profile pack. Since V033 it seeds that pack idempotently and resolves each report against its synthetic boundaries rather than taking a jurisdiction ID from the environment. A deployed worker takes work from the authenticated relay, and **V049** is where the poll interval would be chosen from evidence rather than picked. Real recipient delivery is **V058**; the current delivery target is the simulated adapter (V010). Crash-recovery and replay verification is **V022**. The consent that makes a contribution countable is **V044**.
