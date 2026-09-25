# V050 — Monitoring and the demonstration operations runbook

**Roadmap task:** V050 · **Prerequisites:** V017, V022, V047, V048, V049 · **Owner:** Platform
**Code:** `packages/domain/src/observability.ts`, `packages/adapters/src/observability.ts` · **Command:** `npm run monitor:check` · **Runbook:** [V050-operations-runbook.md](../../deliverables/V050-operations-runbook.md)

V050's "done when" is unusually specific: a deliberate processing failure must produce an alert that can be **diagnosed using IDs and state**. That single sentence rules out both of the usual failure modes at once, and the code is built around refusing each.

## 1. An alert with no identifier is a feeling

`alert()` refuses to build one without the identifiers that lead to the thing and the state it was in. "Processing is failing" is not diagnosable; `stage_failures observed 3, threshold 0, ids 11982 11983 11984, state signal=stage_failures direction=at_most` is. The division of labour is deliberate: **the alert says where, the record says what.** `observability.dbtest.ts` follows that division — it breaks processing on purpose, asserts the alert names the task, and then reads the task's own row to find `terminal_failure_reason`.

Every alert also names a runbook section. That is V048's rule, kept because it is the same mistake: a detection nobody can act on is an alarm with no exit.

## 2. An alert is the most widely forwarded surface there is

It goes to a pager, an email, a group chat and a screenshot. So V005 §7's rule is at its **strictest** here rather than its loosest: readings carry identifiers, counts and codes, and `alert()` refuses anything that looks like prose in an identifier or a state field — four words in a row, which no id, code or version has.

The test plants a submission whose evidence reads _"The drain outside Shivaji Vidyalaya has been overflowing since Tuesday morning"_, puts those words in an event payload too, then breaks processing and asserts that no fragment of them appears anywhere in any reading or alert. Checked rather than intended: the payload is right there in the row the signal counts.

## 3. A silent signal is not a healthy one

A signal that cannot be read is recorded as **unreadable with its reason**, never as zero, because a signal that is silent because it is broken looks exactly like one that is silent because nothing is wrong — and only one of those is good news. `monitoringVerdict` refuses on an unreadable signal and on a signal nobody read at all.

That is tested by pointing the reader at a database connection whose `search_path` cannot see the tables, which fails the way a missing table or a revoked grant would.

## 4. The seven signals, and where their thresholds come from

| Signal                | Read from                                      | Budget                                           |
| --------------------- | ---------------------------------------------- | ------------------------------------------------ |
| `correlated_requests` | events in the window with no correlation id    | `untraceable_events` (0)                         |
| `outbox_lag`          | age of the oldest undelivered task             | `outbox_lag_seconds` (300)                       |
| `queue_age`           | age of the oldest **ready and unclaimed** task | `queue_age_seconds` (120)                        |
| `stage_failures`      | tasks carrying a terminal reason               | `stage_failures` (0)                             |
| `model_cost`          | rows added to `ai_result_cache` in the window  | `model_calls_per_hour` (200)                     |
| `database_saturation` | `pg_stat_activity` against `max_connections`   | `database_saturation_percent` (80, **measured**) |
| `summary_freshness`   | pending events plus unprojected issues         | `summary_lag_events` (50)                        |

The thresholds are V049's budgets, in the same pack, for a reason worth stating: **V049 set the budgets and V050 watches them.** A monitoring threshold invented separately from the budget it is supposed to enforce is a second opinion about the same number, and the two drift.

`queue_age` and `outbox_lag` are kept apart on purpose. `outbox_lag` alone with a healthy `queue_age` is exponential backoff working as designed; the two firing together is a stoppage. The runbook says which is which, because an operator reading one number cannot tell.

Adding these entries turned up a small bug in V049's loader: it required a positive limit, and _the acceptable number of terminal failures is zero_. A ceiling of zero is a real budget; a floor of zero is not one at all, since every possible value meets it including the ones that mean the system has stopped. The loader now allows the first and refuses the second.

## 5. Nothing here is a pager

The command reads signals and prints them. No alert is delivered anywhere, there is no rotation, and the runbook says so in its own table rather than letting somebody assume an alert will find them. That is a real limitation of this build and it is written where an operator will see it, not in a footnote.

## 6. The runbook

Ten sections, each reachable from the alert that needs it, with a named owner for each decision and one rule running through all of them: **prefer the narrowest action.** Restart before replaying, replay before rebuilding, rebuild before touching a row — because every step down that list destroys more of the evidence of why the step was needed.

It covers incident response, safe replay, migration rollback and demonstration data recovery, and §10 says what it is **not**. That section matters as much as the rest: this runbook does not cover a restore drill, because nothing here takes a backup; §9 regenerates synthetic data, while a restore recovers real data that cannot be regenerated. V062 is the pilot gate that proves a restore works, and it is a stronger thing in every way.

Two honest notes in §8 and §9. Migration rollback: there is no down migration by design, so reversing one means writing a new one — and the `delete from schema_migrations` escape hatch is described as what it is, _a lie you are choosing to tell the tool_. Data recovery: a reset does not restore reports filed by hand during a demonstration, and **a reset must not be used to clear an alert**, because it destroys the evidence along with the problem.

## 7. What this does not establish

- these are the seven signals V050 names; a failure that moves none of them produces no alert;
- every reading is a point in time, so nothing notices a slow drift between runs;
- an alert carries identifiers and codes and never a report's content, so diagnosing one always means opening the record it points at;
- nothing here delivers an alert anywhere.

## 8. Open

Delivery — a pager, a mailbox, anything — is not built, and is a deployment concern (V051). Nothing keeps a series, so trend detection is out of reach until something stores one. The signals were read against a development database with no worker running, which is why `outbox_lag` fires there: that is the signal working, not a fault, and it is the clearest demonstration in the repository that the threshold is set somewhere useful.
