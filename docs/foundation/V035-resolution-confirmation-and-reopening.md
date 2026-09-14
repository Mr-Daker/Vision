# V035 — Resolution Claims, Confirmation, Dispute and Reopening

**Status:** Implemented and verified end to end
**Roadmap task:** V035 · **Prerequisites:** V003, V014, V015, V030, V032, V034 · **Owner:** Backend + Frontend
**Code:** `packages/domain/src/confirmation-policy.ts` · `packages/domain/src/transitions.ts` · `packages/adapters/src/resolution.ts` · `packages/adapters/src/issue-lifecycle.ts` · `packages/adapters/src/staff-inbox.ts` · `packages/adapters/src/review-queue.ts` · `apps/api/src/staff-routes.ts` · `apps/api/src/citizen-routes.ts` · `apps/api/src/reviewer-routes.ts` · `apps/web/src/staff-main.ts` · `apps/web/src/main.ts` · `apps/web/src/tracking.ts`
**Tests:** `confirmation-policy.test.ts` (12) · `resolution.dbtest.ts` (35) · `resolution-routes.dbtest.ts` (25) · `staff-inbox.dbtest.ts` (+5 lifecycle) · `staff-view.test.ts` (+6) · `tracking.test.ts` (+10) · `reviewer-view.test.ts` (+3)

## 1. A repair claim is not a verified resolution

A claim moves the issue to `resolution_claimed` and **no further**. It requires at least one piece of completion evidence — a claim with nothing to look at gives a citizen nothing to confirm — and it is idempotent per (staff member, key). The event it writes says `is_verified_resolution: false` in the payload, because an event stream is read by things that will not have read this file.

Whether it becomes confirmed is decided by the category's confirmation policy, and enforced by `canTransitionIssue`, which refuses a confirmed status with no persisted confirmation record whatever a caller sends.

## 2. Two asymmetries in the policy, both deliberate

**A dispute outweighs confirmations.** One person saying it is not fixed stops the claim, however many said it was. The people living with a problem know better than a count does, and treating agreement as a vote would let a majority close something still broken for someone.

**An unknown category falls back to the strictest rule, not the loosest** — two confirmations, no reviewer override. A gap in the configuration pack must not make closing an issue _easier_.

The policy is data supplied by the caller; no category name appears in the module (V001 Appendix G rule 7). Its version is recorded on every evaluation.

## 3. Two contract facts that shaped this task

**One confirmation per claim.** `resolution_confirmation.claim_id` is `UNIQUE`. So a category whose policy requires two confirmations **cannot reach a confirmed resolution at all** — it stays a claim. That is a real dead end for such categories, and it is stated rather than worked around: the alternative was to change a V003/V012 contract to fit a policy dimension, which is the owner's call, not mine. **This needs a decision** before a safety-type category is used in the demo.

**A reviewer cannot overrule a dispute.** The V003 lifecycle has no edge from `resolution_disputed` to `resolution_confirmed`; the only way out is back to `work_planned`. So "authorized reviewers resolve disagreements" means **returning the work**, and the citizen's dispute stays on the record. `resolveDispute` does exactly that, with a reason, and a test asserts a reviewer cannot convert a dispute into a confirmation by any route. That is a stronger guarantee than the policy flag I had originally written, and it is the contract's, not mine.

## 4. Reopening genuinely reverses the closure

Only a confirmed resolution can be reopened, it requires a reason, and it records the prior confirmation it reverses. Afterwards `countsAsClosed` is **false** and `isVerifiedResolution` is **false** — so a closure metric cannot keep counting a live problem as resolved. The full event sequence (`resolution_claimed` → `resolution_confirmed` → `issue_reopened`) is retained with contiguous versions, and a test asserts the contiguity so nothing was quietly dropped.

## 5. Photographs are not a certification

Every resolution state carries the disclosure that _"a confirmed repair here means people agreed the problem looks fixed; it is not an inspection, not an engineer's certification, and not a guarantee the repair is permanent"_. A category marked as needing qualified inspection carries a second, distinct disclosure saying no such inspection has happened.

A routine category gets the first and **not** the second: claiming an inspection is needed where the policy does not say so would be its own overstatement. Both directions are tested, after mutation testing showed a loose assertion had let the second disclosure be droppable.

## 6. Verification

33 tests across the two layers, 33 mutations, 0 survivors. Several survivors along the way were redundant service-level checks whose enforcing layer is `canTransitionIssue` or a database constraint; each is documented in place, and the enforcing layer is pinned by a test.

## 7. The workflow as shipped

Everything below is reachable from a browser. The services are unchanged in
substance; what follows is the surface that makes them usable, and the one
correction that made the lifecycle reachable at all.

### 7.1 The lifecycle gap V034 left

V034 recorded acknowledgments and assignments and never touched
`current_status`, so every routed issue sat at `routed_internal` and
`work_planned -> resolution_claimed` was unreachable in the running product
even though both layers were built and tested.

`packages/adapters/src/issue-lifecycle.ts` supplies `advanceIssueStatus`, and
two guarded advances now use it. Neither bypasses `canTransitionIssue`:

| Trigger                                                      | Move                                     | What the guard still requires                                               |
| ------------------------------------------------------------ | ---------------------------------------- | --------------------------------------------------------------------------- |
| `recordAcknowledgment` with `kind: recipient_acknowledgment` | `routed_internal -> agency_ack_received` | recorded provider provenance, including whether the responder was simulated |
| `assignIssue`                                                | `agency_ack_received -> work_planned`    | an active assignment, written in the same transaction                       |
| `assignIssue`                                                | `reopened -> work_planned`               | the same, so a reopened issue is live work again                            |

An internal acceptance advances nothing: internal state is not an
acknowledgment by anyone outside, and the lifecycle must not borrow the word.
A repeated delivery callback is a no-op rather than a second advance — the
`UPDATE` is guarded by the current status, so two concurrent requests cannot
both believe they performed it.

### 7.2 HTTP surface

**Staff (`/v1/staff/…`, staff session + CSRF on every write)**

| Route                                                                 | What it does                                                             |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `POST /v1/staff/uploads`                                              | a scoped upload grant for one completion photograph                      |
| `PUT /v1/staff/uploads/:reference?token=…`                            | the bytes                                                                |
| `POST /v1/staff/uploads/:reference/finalize`                          | completion validation: the bytes must _be_ what they were declared to be |
| `POST /v1/staff/issues/:id/actions` with `action: "claim_resolution"` | the claim                                                                |

The claim body carries `note` (the description), `idempotency_key`, and
`completion_evidence: [{ object_reference }]`. Each reference must already be a
finalised object — the route checks the store, reads the bytes back and decodes
them through `processPhotoBytes`, and refuses anything that is not a real
JPEG or PNG. `claimResolution` no longer invents object references; it takes
the reference and the fingerprint of the bytes that were actually stored.

A successful claim answers with `issue_status: "resolution_claimed"`,
`is_verified_resolution: false`, `awaiting_confirmation: true`, the applied
policy version, the required confirmation count, and the disclosures. Replaying
the same key returns the first claim with `replayed: true`.

**Citizen (`/v1/me/…`, session-bound; CSRF on both writes)**

| Route                                                    | What it does                                                                                                                                                               |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/me/issues/:publicReference/resolution`          | the claim, its description, approved derivatives only, the policy version and required count, current totals, the disclosures, the history, and what _this_ session may do |
| `POST /v1/me/issues/:publicReference/resolution/respond` | `confirmed` or `disputed`; a dispute requires a comment                                                                                                                    |
| `POST /v1/me/issues/:publicReference/reopen`             | requires a reason                                                                                                                                                          |

The responder is derived from the session. A body naming `participant_id` is
**refused**, not ignored: a client sending one has misunderstood who decides,
and silently dropping it would leave that belief in place. The payload selects
`derivative_reference` and never reads `object_reference`, so there is no field
that could carry a private original.

Each refusal names its own cause — `not_a_counted_participant`,
`already_answered`, `no_claim_awaiting_an_answer`, `policy_excludes_citizens` —
because "you cannot answer" with no reason is indistinguishable from a fault.
A stale view gets **409**, not 403: the answer was about a world that has moved.

**Reviewer (`/v1/reviewer/…`)**

Disputed claims are a new kind in the existing queue, `disputed_resolution`,
with the citizen's own words attached. Two actions:

- `return_disputed_work` — always offered; sends the work back and leaves the
  dispute standing;
- `confirm_disputed_resolution` — offered **only** where the loaded category
  policy sets `reviewer_may_override`, and refused with 403 if forced.

Both require a reason. Migration `0024` adds the override to
`review_decision_action_ck` and to `review_decision_one_target_ck`, because a
decision that cannot be written to the audit table is a decision with no audit
trail — which is exactly what must not exist for this one. The override's state
change and its audit row commit together, through `respondToClaim`'s
`alsoRecord` hook; written afterwards, a failing insert once left a confirmed
resolution standing with nothing saying who decided it.

### 7.3 Interface

No new page. The controls live inside the three shells that already existed:

- **`staff.html`** — a _Completion claim_ block below the delivery lifecycle in
  the existing issue card: the stage, the confirmation count against the
  configured bar, a file input, and a claim button that is enabled only at
  `work_planned`. It reuses the card's own note field as the description.
- **`app.html`** — inside the existing _Issue details_ panel: the state, the
  claim description, completion evidence, the disclosures, the confirm/dispute
  controls as **two equal buttons**, the reopen control, and the history.
- **`reviewer.html`** — the new kind renders through the existing review card.
- **`intelligence.html`** — untouched, and still read-only.

Five states are distinguished in words, never by colour alone: _claimed and
awaiting confirmation_, _disputed_, _confirmed by participants_, _confirmed by
a reviewer over a dispute_, _reopened_. The fourth exists because telling
somebody who disputed a claim that "people who reported this agreed" would be
false to their face.

`staff-view.test.ts` asserts that no staff-facing label uses _resolved_,
_verified_, _inspected_, _certified_, _guaranteed_ or _safe_ as an assertion,
and `tracking.test.ts` asserts that an unrecognised status falls back to the
**claim** wording rather than the confirmed one.

### 7.4 Demo fixture

`npm run db:seed:v035` creates two deterministic issues from a fixed seed: a
routine one (one confirmation, reviewer override permitted) and a safety one
(two confirmations from two different people, no override, second disclosure).
Both are routed to departments the demo staff account holds, with counted
participation for both demo citizens.

It adopts an existing identity mapping when one is there rather than forcing a
new participant. It also writes the subject hash with a **NUL** separator,
exactly as `IdentityService.hashProviderSubject` does — a space produces a hash
nothing will ever look up, so the demo citizen signs in as a different
participant and is told they are not counted on their own report.

## 8. Still not done

- **A completion photograph is stored but not shown.** No face or number-plate
  detector is configured, so `decidePhotoRedaction` returns `needs_review` and
  no derivative is published — the same rule citizen evidence follows. The
  citizen sees the claim description and a line saying plainly why the
  photograph cannot be displayed. Publishing it would mean either configuring a
  detector or adding resolution evidence to the redaction review queue; neither
  is in this task.
- **Nothing notifies the crew** when disputed work is returned (**V070**).
- **Departments remain simulated.** Every acknowledgment is labelled as such,
  and the event carries `is_government_acknowledgment: false`.

## 9. Corrections to earlier versions of this document

Three claims in §3 and §7 of the original were wrong by the time they were
read, and are corrected above rather than left standing:

- _"One confirmation per claim… a category requiring two cannot be closed at
  all."_ Migration `0016` replaced that constraint with one answer per person
  per claim. A two-confirmation category closes on two different people.
- _"A reviewer cannot overrule a dispute."_ The `resolution_disputed ->
resolution_confirmed` edge exists, guarded so only a reviewer may use it and
  only where the policy grants it.
- _"No staff or citizen screen. No staff member can authenticate."_ Staff
  authenticate through V034's simulated surface, and all three screens ship.
