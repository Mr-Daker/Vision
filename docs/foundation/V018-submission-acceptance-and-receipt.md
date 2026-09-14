# V018 — Accept a Submission and Return a Durable Receipt

**Status:** Ready for owner approval
**Roadmap task:** V018 · **Prerequisites:** V014, V015, V016, V017 · **Owner:** Backend
**Code:** `packages/adapters/src/submissions.ts`, `apps/api/src/submission-routes.ts`
**Tests:** `submissions.dbtest.ts` (11), `submission-routes.dbtest.ts` (11), both against real PostgreSQL

## 1. A receipt is only ever issued after a commit

`SubmissionService.create` opens one transaction and inside it inserts the submission, its text evidence, its media evidence links, the `submission_received` event and the `process_submission_media` outbox row — then commits once. The receipt is built from the **returned committed row**, not from the input.

So a failed commit cannot be presented as a successful report: there is no code path that produces a receipt from anything other than a committed row. On error the transaction rolls back and the caller gets an error, never a receipt.

Because the submission and the first outbox event commit together ([V017](V017-outbox-and-durable-stage-execution.md) §1), **a saved submission stays discoverable during a worker outage** — the receipt and the status endpoint read the submission row directly and do not depend on the worker having run. The status they report is `processing_status`, which is honest about work not yet done.

## 2. A network retry returns the original receipt

Every write requires an `Idempotency-Key` header; a request without one is refused (`validation_failed`), not silently accepted. The key is scoped per participant, so:

- the same key retried by the same participant returns the **original** receipt with `replayed: true`, and the test asserts exactly one submission row exists afterwards;
- the same key from a **different** participant is a different report, not a collision;
- a concurrent duplicate loses the unique-index race, and the loser re-reads the winner's receipt rather than failing — the `catch` re-checks for an existing receipt before rethrowing.

## 3. Location is a claim, and its origin is recorded

`observed.source` is `device_geolocation` or `manual_pin`, stored as a column. `accuracyMetres` is stored, not rounded away. Nothing in the model calls a location verified: the [V002](V002-capability-evidence-matrix.md) prohibition on "proof of presence" holds, and the client is required to show the distinction (V019).

Validation returns **per-field issues** rather than one opaque message: longitude/latitude range, accuracy ceiling, future `observedAt`, unsupported locale, text length, and unknown or unfinalized evidence references. An evidence reference that was never finalized through V016 is refused, so an unaccepted upload cannot become part of an accepted report.

## 4. HTTP surface

| Method + path                     | Purpose                                 |
| --------------------------------- | --------------------------------------- |
| `POST /v1/uploads`                | request a scoped upload grant (V016)    |
| `PUT /v1/uploads/{reference}`     | write staged bytes for that grant       |
| `POST /v1/uploads/{ref}/finalize` | validate and accept the object          |
| `POST /v1/submissions`            | create a submission, return the receipt |
| `GET /v1/submissions/{id}`        | read own receipt/status                 |

Every write requires a validated session **and** the double-submit CSRF token. A receipt belonging to another participant returns `not_found`, deliberately indistinguishable from a receipt that does not exist, so a stranger cannot probe which submission ids are real. The principal comes only from the validated session ([V015](V015-authorization-and-private-data-boundaries.md) §1) — no request field influences it.

The [V015](V015-authorization-and-private-data-boundaries.md) §4 quota policy is applied on upload grants, submissions and receipt reads, and a refusal sets `Retry-After` from the policy's own `retryAfterMs`. The **counter store is a process-local `QuotaStore`**, so limits are per instance and reset on restart; a shared counter store is later work (V049 tunes the numbers).

## 5. Two real defects found and fixed here

**Identity was in memory while submissions were in PostgreSQL.** V009 shipped in-memory repositories because the schema did not exist yet, and that was correct then. It stopped being correct here: `submission.participant_id` references `participant`, so a demo login that created a participant only in a `Map` made every submission fail its foreign key. `packages/adapters/src/postgres-repositories.ts` now supplies PostgreSQL implementations of all three V009 ports, and `buildAppWithDatabase` uses them. Nothing in `IdentityService` or `SessionService` changed — which is what the ports were for. Verified by `postgres-repositories.dbtest.ts` (6 tests), including that a stale compare-and-swap loses and that the expiry invariant is enforced by the schema rather than only by the service.

**An unexpected throw produced no response at all.** The route error escaped into a floating promise, so a caller that invokes the handler directly waited forever, and a foreign-key violation looked like a hang. `createRequestHandler` now wraps dispatch and answers `internal_error` (500) with no detail echoed and nothing logged (V005 §8). A hang hides a fault; a 500 reports it. Regression-tested in `app.test.ts`.

## 6. Not yet done

Media processing, fingerprints and redaction (V021) · matching the submission to a canonical issue (V024+) · recipient delivery (V058) · the citizen interface that drives these endpoints (V019) · draft persistence and upload resumption (V020) · a shared/persisted quota counter store, since the current one is per process (§4).
