# Vision — demonstration operations runbook

**Roadmap task:** V050 · **Owner:** Platform · **Scope:** the demonstration environment only

This runbook is for the **demonstration**. It assumes a local or demo database holding synthetic data, a worker that can be stopped and started freely, and no citizen depending on anything in it. A pilot needs more than this and V062 is where that is proved — see §10, which says what this deliberately does not cover.

Read the signal first: `npm run monitor:report`. Every alert names the section below that it belongs to.

| Role           | Who                                                     | What they decide                                                                                                |
| -------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Platform owner | the person who ran `npm run db:up` for this environment | whether to restart, replay or reset; the only role that may reset                                               |
| Backend owner  | whoever changed the code last                           | whether a terminal failure is a bug or a data problem                                                           |
| Data owner     | the person holding the fixture corpus                   | whether seeded data may be regenerated                                                                          |
| Nobody         | —                                                       | **there is no on-call rotation.** Nothing here pages anyone; the signals are read by a person running a command |

---

## §1 Incident response

1. **Read, do not act.** `npm run monitor:report` then `npm run integrity:check`. The first says what is moving; the second says whether what has already moved is consistent. Both are read-only.
2. **Write down what you saw before changing anything.** The alert's identifiers and state are the only record of the moment; a restart erases the evidence of why a restart was needed.
3. **Prefer the narrowest action.** Restart a worker before replaying a task; replay a task before rebuilding a projection; rebuild a projection before touching a row. Every step down that list destroys more of the evidence.
4. **Record what you did.** An operator note on the affected record, naming the alert. V048's unrecoverable findings exist precisely because somebody once changed a status without leaving one.

---

## §2 The queue has stopped moving

_Alerts: `outbox_lag`, `queue_age`._

**The common cause is that nothing is consuming**, not that something is failing. Check that first:

```bash
npm run worker
```

If the worker is running, ask which of the two signals fired. `queue_age` counts tasks that are **ready and unclaimed** — a consumer problem. `outbox_lag` counts every undelivered task, including ones scheduled for later, so `outbox_lag` alone with a healthy `queue_age` is backoff working as designed, not a stoppage.

If tasks are claimed but never delivered, a worker died holding a lease. The lease expires on its own (V017); the recovery is to wait for it, not to clear `claimed_by` by hand. Clearing a live claim lets two workers do the same work and V022 covers why the second one's result is fenced out.

---

## §3 Safe replay

_Alert: `stage_failures`._

A terminal failure is work this system has **given up on**. Replaying it without fixing the cause produces the same terminal failure, and the second one is harder to see because the first one is no longer surprising.

1. Read the reason: `select task_type, attempts, terminal_failure_reason from outbox where outbox_id = <id>`.
2. Read the stage's own record: `select stage, state, failure_reason, attempts from processing_stage where submission_id = <the id in the payload>`.
3. Decide with the Backend owner whether this is a bug or a data problem.
4. Only then clear the terminal reason and reset `not_before`, which makes the task claimable again.

**Replay is safe by construction and that is not an invitation.** V017's delivery is at-least-once and every stage is idempotent on its input hash, so a repeated delivery writes no second row — V022 proves it. What a replay does not do is repeat an _external_ cost: V022 tests that separately, and a replayed classification is a second paid call.

---

## §4 The dashboard is behind the records

_Alert: `summary_freshness`._

```bash
npm run summaries:rebuild && npm run integrity:check
```

The rebuild reads the records and replaces the projection, so the disagreement is resolved in favour of the records rather than the cache. It is safe to run at any time and loses nothing.

**The dashboard already says it is behind** — V039's banner goes to caution whenever the projection lags, so nobody is reading a figure that claims to be current. That is why this is a warning and not a page.

One cause is expected and not a fault: nothing in this system emits an event when an issue is opened, so an incremental pass cannot discover a new issue. The freshness report counts those separately as `unprojected`, and a rebuild is the only thing that finds them.

---

## §5 An event nobody can follow

_Alert: `correlated_requests`._

`status_event.correlation_id` is `NOT NULL`. This signal firing means the constraint is gone, and every event recorded since is one nobody can trace from a request to a stage to an outcome.

Stop. This is a schema problem, not an operational one. Do not replay, rebuild or reset — find the migration that dropped it. `npm run migrate:status` lists what has been applied.

---

## §6 A provider bill that is climbing

_Alert: `model_cost`._

Check the **cache key** before the provider. Every row in `ai_result_cache` is one paid call, and a changed prompt version or model name makes every previous answer a miss — correct behaviour, and an expensive surprise.

```sql
select model_name, prompt_version, count(*), sum(hit_count) from ai_result_cache group by 1,2;
```

Two rows for the same operation with different versions is the answer. V046 recorded the free tier's daily quota being exhausted by three evaluation runs in an afternoon, so this threshold is set to catch a loop rather than ordinary use.

`GEMINI_MAX_CALLS` is a hard per-process ceiling; setting it is the stop, not a discussion.

---

## §7 The database is running out of connections

_Alert: `database_saturation`._

**Reduce instance counts before pool sizes** (V006 §5). A service that cannot get a connection fails every request; a service with fewer instances fails none.

V049 measured this container: 47 usable connections against `max_connections=50`, with 3 reserved for superusers. The workload gate is 36. If saturation is high with few instances running, look for a leaked connection — a pool that was created per request rather than per process — before raising anything.

---

## §8 Migration rollback

**There is no down migration, by design.** `tools/migrate.mjs` is forward-only with checksums, and it refuses to run a migration file that has changed since it was applied.

To undo a migration in the demonstration environment:

1. Write a **new** migration that reverses it. This is the only route that works anywhere but a throwaway database.
2. If the database is genuinely disposable, the faster route is §9.

If you edited an applied migration file and the tool now refuses to run:

```sql
delete from schema_migrations where sequence = '00NN';
```

then re-run `npm run db:migrate`. This is safe **only** when you know the edited migration's effects are already present or absent consistently — it tells the tool to forget it ever ran, which is a lie you are choosing to tell it.

---

## §9 Demonstration data recovery

Everything in the demonstration database is synthetic (V004 §5). Losing it costs time, not information.

```bash
npm run db:reset && npm run db:migrate && npm run db:seed
npm run db:seed:v035 && npm run db:seed:v036
npm run context:import && npm run projects:seed && npm run summaries:rebuild
```

`db:reset` refuses unless `DATABASE_URL` points at loopback **and** `VISION_ALLOW_DESTRUCTIVE=yes` is set. Both guards are V013's and neither should be removed to make a bad afternoon shorter.

Two things a reset does not restore, because nothing generates them:

- reports filed by hand during a demonstration — they are gone;
- the V046 evaluation run records under `deliverables/v046-runs/`, which live in the repository rather than the database and are unaffected.

**Do not reset to clear an alert.** Every signal above has a narrower action, and a reset destroys the evidence of what happened along with the problem.

---

## §10 What this runbook is not

This is a **demonstration** runbook. It does not establish that this system can be operated, only that the people running the demonstration know what to do when it stops.

It deliberately does not cover, and must not be read as covering:

- **a restore drill.** Nothing here restores from a backup, because nothing here takes one. V062 is the pilot gate that proves a restore actually works, and it is a stronger thing than §9 in every way: §9 regenerates synthetic data, a restore recovers real data that cannot be regenerated.
- **an on-call rotation.** No signal in this build is delivered anywhere. A person runs a command and reads the output.
- **a pilot incident process.** There is nobody to notify, because there are no real reporters and no real departments (V010: every department here is simulated).
- **data-loss handling.** If real data ever enters this system, none of the above applies and V056's retention policy governs instead.
