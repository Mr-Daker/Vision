# V031 — Complete Citizen Duplicate Confirmation and Correction

**Status:** Ready for owner approval
**Roadmap task:** V031 · **Prerequisites:** V019, V027, V028, V029, V030 · **Owner:** Frontend + Backend
**Code:** `packages/adapters/src/citizen-confirmation.ts` · `apps/api/src/citizen-routes.ts` · `migrations/0012_citizen_corrections.sql`
**Tests:** `citizen-confirmation.dbtest.ts` (15) · `confirmation-routes.dbtest.ts` (9) · 0 mutation survivors

## 1. A question the citizen can actually answer

They are asked "is this the same problem you are reporting?" and shown the candidate's coarse location, distance, how long it has been open, how many entries it carries, and any **approved** preview. Rejecting carries **their own words**, never a category chosen from a government taxonomy — requiring someone to understand departmental categories in order to disagree is the same as not letting them disagree.

The API enforces this too: a decision body containing `category` or `defect_id` is a 400. Accepting one would quietly reintroduce the requirement the task exists to remove.

## 2. The answer can go stale

Between rendering the question and receiving the answer the candidate may have been merged away or removed. The candidate is therefore re-resolved at the moment of decision:

- merged away → the evidence attaches to the **surviving** issue, and `resolvedThroughAlias` says so;
- gone → `revalidate` (HTTP 409), and the question is asked again rather than answered approximately.

## 3. A citizen may dispute, but not undo

Confirming attaches the evidence **once** — a second confirmation is `already_attached` and adds nothing — and counts the citizen once as a contributor via V029's constraint.

But an attachment that already happened carries **other people's evidence and their counted participation**, so a citizen disputing it opens a `correction_request` a reviewer decides (V032). The attachment stands until then. The alternative would let one person detach a report several others had corroborated.

One open request per person per report, enforced by an exclusion constraint: tapping twice is not two disagreements.

## 4. Ownership everywhere

Every operation is bound to the participant behind the session: confirming, rejecting, disputing, and even _viewing_ a candidate. A stranger gets `404`, indistinguishable from "no such report", so submission ids cannot be probed — and the refusal body carries no issue reference. A citizen write additionally needs the CSRF token.

## 5. Verification

24 tests across the two layers. Mutation testing found two real route gaps — no test requested a candidate view for someone else's report (a location disclosure), and none posted a decision with no candidate id. Both are covered now.

One survivor is documented rather than faked: the preview's redaction filter is unreachable because `evidence_item_derivative_needs_approval_ck` makes an unapproved item with a derivative unstorable, and V030 pins that constraint directly.

## 6. Not done

Rejecting inherits the candidate's category as the new issue's, which is the best available label but is not a _classification_ of the new report.

**Closed since this was written**

- The citizen screen exists. `apps/web` renders the question, the reports list offers it on the report it belongs to (`awaitingAnswerForIssueId`, present only for an ambiguous match that is neither superseded nor already decided), and the whole flow was exercised in a browser: the question opened, reject posted, the answer was announced to the live region, and the question left the list.
- V027 → V028 is wired into the matching stage, so an ambiguous match now arises on the ordinary path rather than only from a test.

**Two real bugs the browser found that the unit tests did not**

1. **Every real reject returned HTTP 500.** `confirmMatch` and `rejectMatch` inserted a new `issue_match` row without retiring the active one, and `issue_match_one_active_per_submission_uniq` permits exactly one row per submission with `superseded_at IS NULL`. A citizen is asked _because_ the matcher left an ambiguous attempt active — so the constraint fired on every genuine answer. Every existing test passed because none of them created the row that makes the question exist. Both paths now supersede the attempt they answer (superseded, not deleted: the ambiguous attempt is the record that the system was unsure and a person resolved it) and record it through `supersedes_match_id`. Six tests now set up the state a citizen is actually asked in.
2. **"near [object Object]".** `coarse_location` arrives as `{lon, lat}`; the view's type said `string` and its test passed a string, so the object was interpolated straight into a sentence shown to the reader with every test green. Now formatted to the three decimal places the server publishes — no more, because adding digits would invent precision the server deliberately removed.

A third was mine alone: the listener wiring was added to the language-change handler instead of the boot sequence, so the buttons did nothing until the reader happened to switch language — silently, with no error anywhere.
