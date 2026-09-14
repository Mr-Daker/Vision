# V032 — Build the Evidence and Matching Review Queue

**Status:** Complete and verified
**Roadmap task:** V032 · **Prerequisites:** V015, V025, V028, V030, V031 · **Owner:** Frontend + Backend
**Code:** `packages/adapters/src/review-queue.ts` · `packages/adapters/src/staff-grants.ts` · `apps/api/src/reviewer-routes.ts` · `apps/web/public/reviewer.html` · `apps/web/src/reviewer-main.ts`
**Schema:** `migrations/0013_review_and_routing.sql` · `migrations/0019_staff_grants.sql` · `migrations/0020_private_evidence_access_log.sql`

## 1. Three rules, because a reviewer is the first actor with power over someone else's report

**Every decision carries a reason** — prose a person wrote, not a code. A decision nobody has to explain is one nobody can question, and the citizen whose report it was has the strongest claim to an explanation. `review_decision.reason` is `NOT NULL` with a non-empty check.

**Nothing is erased.** A rejected photograph is `quarantined`, not deleted — erasure is a V005 retention act with its own ledger, not a review outcome. A separated attachment is superseded with its correction reason. A refused correction request is closed with its reasoning intact. The public display changes; the history behind it stays readable, in `prior_state` and `resulting_state`.

**Permissions come from V015.** Every action maps to an `Action` and is checked with `authorize`.

## 2. What that permission model turned out to require

_Every_ review action is jurisdiction-scoped. A queue ignoring jurisdiction would be a **permission bypass**, not a convenience — so `jurisdictionId` is required to list the working queue, and a reviewer scoped elsewhere is refused both the list and the decision.

That exposed a dependency the roadmap does not list. An item is only jurisdiction-scoped once it is attached to an issue that has a jurisdiction; resolving a _submission's_ own jurisdiction from its location is **V033's** work and needs the boundaries **V059** supplies. Until then such items cannot be authorised to anyone.

And they cannot be shown to anyone either: the **administrator role has `configuration.write` and `audit.read` and deliberately no evidence access at all** — separation of duties. My first design surfaced the unscoped backlog to an administrator; the model refused it, correctly. They are now reported as a **count**, which makes the backlog visible while disclosing nothing about anyone's report.

## 3. A real bug found by mutation testing

`decideReview` was not transactional. The evidence update committed before the audit insert ran, so a decision the audit trail rejected still altered the evidence — **a state change with nothing explaining it**, which is the one outcome this task forbids. Both now commit together, proven by a test that makes the audit insert fail _after_ the state change (two targets at once, which `review_decision_one_target_ck` refuses).

## 4. Scope of a reviewer's choice

`attach_to_issue` accepts only an issue that was **among the candidates** the matcher found. Redirecting a report to an unrelated issue is a different act and must be recorded as one, not slipped through the ambiguity path.

The queue selects no `object_reference` in any query: it is a worklist. `GET /v1/reviewer/queue/:kind/:target/original` resolves the evidence again on the server, rechecks the current queue and jurisdiction, requires a named access purpose, authorizes `evidence.read_original`, and appends `private_evidence_access_log` before returning non-cacheable image bytes. A private object reference never reaches the browser.

## 5. Verification

Verified 12 September 2026:

- 59 focused PostgreSQL service tests cover every queue kind, action, jurisdiction boundary, rollback and immutable decision state.
- 7 reviewer HTTP tests cover simulated reviewer-only login, durable role grants, stored jurisdiction scope, CSRF, arbitrary-target refusal, decision audit, and purpose-bound original access.
- 4 pure browser-view tests reject unknown kinds/actions and pin queue/reference/age presentation.
- Live browser verification covered reviewer sign-in, scoped queue loading, empty-reason refusal, audited private-original viewing, a reasoned redaction approval, removal of the completed row, sign-out, and mobile reflow with no horizontal overflow.
- Full gates: **595/595 unit tests** and **432/432 PostgreSQL tests** pass.

## 6. Authentication and interface boundary

`reviewer.html` is a separate private workspace, so the citizen interface remains unchanged. It supports queue filtering, jurisdiction selection, private-original inspection, mandatory reasons and only the actions returned for each live queue item.

The Hackathon reviewer credential is still explicitly **simulated**; it does not claim DigiLocker or government-directory verification. It does exercise the production-shaped boundary: the identity adapter accepts only the reviewer fixture, the normal application session is issued, then role, internal staff id and jurisdiction scope are loaded from `staff_account` and `staff_jurisdiction_grant`. The request body can supply none of them. A citizen credential and a citizen session cookie cannot enter this surface, and its separate cookies let the citizen app stay signed in in another tab. V057 replaces the simulated identity adapter; it does not need to replace the role or jurisdiction authorization model.

## 7. Additional closed gaps

**Closed since this was written**

- `flagged_evidence` is populated. `listReviewQueue` reads `trust_signal_report` rows whose `requires_review` is set, jurisdiction-scoped like every other review surface (V015). The queue's reason quotes only the _inconsistent_ checks' own words — an `unknown` check's reason read alongside a flag would look like part of the case for it, and it is not one — and a test asserts the wording never implies fraud, dishonesty or falsity.
- Uncertain AI classifications are in the queue, as a new `uncertain_classification` kind. A `high`-band proposal never appears: sending every proposal to review buries the ones that need it.
- Three actions are implemented with audit rows: `dismiss_trust_flag`, `accept_classification`, `reject_classification` (migration 0015 permits them). Each needs `evidence.redaction_decide` — a test uses `department_staff`, which _has_ `issue.read_private` but not the evidence power, so the boundary is pinned as "needs the evidence power" rather than merely "needs some private access".
- Dismissing a flag does **not** alter the evidence or its processing state: it says the discrepancy was explained, not that the photograph is approved for publication.
- A decided flag or proposal cannot be decided again, so one judgement leaves one attributable audit row.

**Accepting a classification now applies it.** Recording the agreement and changing nothing meant a reviewer could work the entire queue while every issue kept the fallback category it was opened with. Accepting writes the category and re-resolves the route, because ownership is looked up by category — `routing_decision` records the category each decision was made under, so the re-route appends rather than rewriting why the original route was chosen. A re-route that finds no owner is reported rather than swallowed: the reviewer's decision stands and the missing owner is an operational gap for someone to close. Rejecting still changes nothing, and the audit row says so.

**The unscoped backlog is actionable.** `awaitingJurisdictionCount` reported items no principal could ever act on: every review action is jurisdiction-scoped (V015) and these items have no jurisdiction, so the count made the problem visible and left it permanently stuck. `claim_jurisdiction` (migrations 0017, 0018) lets a _person_ say "this is in my area".

V033 now resolves locations that safely fall inside the active, explicitly synthetic Hackathon boundary pack. The manual claim remains necessary for outside-profile points, overlapping sibling boundaries and accuracy ranges that reach an edge. It is authorised against the jurisdiction being claimed _into_, not the item's own, so a reviewer can only pull work towards themselves and never push it into somebody else's queue; an issue that already has a jurisdiction is refused, because moving work already in progress is a different decision.
