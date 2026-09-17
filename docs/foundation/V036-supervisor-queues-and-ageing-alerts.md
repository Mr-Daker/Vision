# V036 — Supervisor Queues and Deterministic Ageing Alerts

**Status:** Implemented and verified end to end
**Roadmap task:** V036 · **Prerequisites:** V017, V033, V034, V035 · **Owner:** Backend + Frontend
**Code:** `packages/domain/src/ageing-policy.ts` · `packages/adapters/src/supervisor-queues.ts` · `apps/api/src/supervisor-routes.ts` · `apps/web/src/supervisor-{view,api,main}.ts` · `apps/web/public/supervisor.html`
**Tests:** `ageing-policy.test.ts` (15) · `supervisor-queues.dbtest.ts` (19) · `supervisor-routes.dbtest.ts` (8) · `supervisor-view.test.ts` (10)

## 1. An alert is about a clock, not about a problem

V034 declined to invent urgency: _"an urgency score makes a claim about the world, and nothing in this system can support such a claim."_ V036 asks for ageing alerts and a "critical" queue, which sounds like the same claim wearing a different hat. It is not, and the distinction is the whole design.

Saying **"this report has waited longer than this deployment said it would tolerate"** is a fact about a configured promise. Somebody wrote a number down, it is versioned, and the elapsed time either passed it or did not. Saying **"this problem is critical"** would be a measurement this system cannot take — no severity model exists and none has been calibrated (V046).

So nothing here computes a score. `evaluateAgeing` returns an elapsed time, the threshold that applied, where that threshold came from, and whether one passed the other. `ageing-policy.test.ts` asserts that the words _severity_, _urgency_, _priority_, _risk_ and _critical_ appear nowhere in an assessment except inside the pack's own disclaimer.

**The roadmap's "critical" queue is implemented as "Escalated"** — issues past the pack's second threshold. Same reasoning.

## 2. Two clocks, and only one of them alerts

| Clock          | Anchor                                       | Pauses? | Alerts? |
| -------------- | -------------------------------------------- | ------- | ------- |
| **Department** | `decided_at` of the current routing decision | Yes     | Yes     |
| **Citizen**    | `issue.opened_at`                            | Never   | Never   |

This is what makes _"age survives reassignment"_ true. Reassignment writes a new `assignment` row and supersedes the old one; the routing decision is untouched, so the clock a department is measured by does not reset. `supervisor-queues.dbtest.ts` asserts the age is byte-identical across two reassignments.

Re-_routing_ to a different department does open a new window — a newly responsible department should not inherit somebody else's delay — and `issue_alert.window_start` is the anchor, so the new department can be alerted about its own delay without the previous department's alert suppressing it.

The citizen clock exists because the department clock alone would lie. A re-route on day 40 would show "0 days" on a supervisor's screen. So both travel together, and `evaluateAgeing` adds an explicit sentence whenever the citizen wait is longer.

## 3. Pauses are explicit, subtractive and replayable

The department clock stops while the department is **not the party being waited on**:

- **Paused:** `resolution_claimed` (they have done the work and are waiting on people to confirm it), `resolution_confirmed`.
- **Not paused:** `resolution_disputed` and `reopened` — the work came back, and so does the clock.

Intervals are derived from the V035 resolution tables (`resolution_claim`, `resolution_confirmation`, `reopening`) rather than by replaying `status_event` type strings, which would break quietly the first time an event was renamed. Overlapping pauses are merged rather than summed: two overlapping pauses are one period of not-waiting, and adding them could drive the effective age negative.

## 4. Once per window, enforced by the database

`issue_alert` carries `UNIQUE (issue_id, rule_id, window_start)`. The acceptance clause is "alerts occur once per intended rule window", and a check-then-insert in application code is not that — two concurrent sweeps would both read "no alert yet" and both write one. A test runs two sweeps on **separate connections** simultaneously and asserts exactly two alerts exist between them.

The sweep takes `asOf` rather than reading a clock, so tests advance time explicitly rather than sleeping, and the same inputs always produce the same alerts.

**The queue read never writes.** Alerts come from the worker sweep. A GET that raised alerts would make "when did this fire" mean "when did a supervisor happen to look", which is not a clock. A test asserts reading the queue raises nothing.

## 5. Configured baseline, reviewed override

Two mechanisms, matching the roadmap's "configured ageing rules" and "reviewed severity overrides":

- **`ageing.json`** sets per-category thresholds. Its `note` is validated for an explicit "not a severity, risk or urgency" disclaimer, exactly as `triage.json` is — a pack whose note read "how quickly each category must be fixed" would let a severity-looking promise reach a screen with nothing contradicting it.
- **`issue_ageing_override`** lets a supervisor change the clock on one issue, with a mandatory reason, attributed and effective-dated. A second override supersedes the first rather than overwriting it, because _who decided this, when, and why_ cannot be answered from a row that was replaced.

`ageing.override` is a new authorization action held by `supervisor` **only**. Department staff extending their own deadline would not be oversight, and a reviewer's remit is evidence and matching.

**The fallback is lenient, and deliberately the opposite of `confirmation-policy.ts`.** There, a configuration gap must not make closing an issue easier, so the default is strict. Here, a gap must not manufacture an alert against a department for a category nobody set a promise for. The asymmetry has one rule behind it: strictness always runs towards the citizen.

## 6. Nothing is delivered

`issue_alert` is deliberately **not** routed through the outbox. The outbox exists to deliver things to recipients, and an alert sitting in it would be indistinguishable from a notification somebody tried to send to an official — which is exactly what the acceptance clause forbids.

Every payload and every screen carries: _"These alerts are internal records in this demonstration. Nothing here has been delivered or notified to any official, department or external system."_ Alerts are **raised** and **recorded**; `supervisor-view.test.ts` asserts no alert label contains _sent_, _notified_, _delivered_, _emailed_ or _alerted_.

## 7. Surfaces

`supervisor.html` is a fifth private workspace alongside `reviewer.html` and `staff.html`, with its own demo principal, session cookie (`vision_supervisor_session`) and grant. It loads `reviewer.css` for the operator theme and `staff.css` for the shared card patterns rather than duplicating them.

| Route                                                                     |                                                                     |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `GET /v1/supervisor/capabilities`                                         | demo principals, plus the internal-only note before anyone signs in |
| `POST /v1/supervisor/auth/demo-login` · `GET …/session` · `POST …/logout` | mirroring the reviewer surface                                      |
| `GET /v1/supervisor/queues?jurisdiction_id=…`                             | the five queues, both clocks, alerts and any override               |
| `POST /v1/supervisor/issues/:id/ageing-override`                          | CSRF, reason ≥ 8 characters                                         |
| `POST /v1/supervisor/alerts/:id/acknowledge`                              | marks an alert seen; never deletes it                               |

The ageing sweep runs in the existing `dev-worker.ts` polling loop, separate from the relay pass so an ageing failure cannot make a delivered task look unhandled.

## 8. The five queues

| Roadmap name   | Implemented as                                                           |
| -------------- | ------------------------------------------------------------------------ |
| Unacknowledged | `routed_internal` — routed, no recipient acknowledgment                  |
| Overdue        | past the pack's `alert_after_days`                                       |
| **Critical**   | **past `escalate_after_days`**, surfaced as _"Past the escalation wait"_ |
| Disputed       | `resolution_disputed`                                                    |
| Reopened       | `reopened`                                                               |

A `resolution_confirmed` issue never alerts: finished work is not a backlog item, and it would otherwise sit on a supervisor's screen forever.

## 9. Not done

- **Nothing notifies anybody.** Delivery is V070.
- **No cross-jurisdiction view.** Every read is scoped to one jurisdiction the supervisor holds a grant for, as V015 requires.
- **No recurring re-alerts.** A rule fires once per window. Re-alerting every N days would need a second window concept and is not what the acceptance clause asks for.
