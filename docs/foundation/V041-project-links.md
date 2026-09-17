# V041 — Linking issues to sanctioned projects with reviewable evidence

**Roadmap task:** V041 · **Prerequisites:** V028, V032, V040 · **Owner:** Data + Backend
**Code:** `packages/domain/src/project-match.ts`, `packages/adapters/src/project-links.ts` · **Schema:** migrations `0029`, `0030` · **Pack:** `packs/demo-district-a/projects.json`

Whether a piece of public infrastructure has been funded is the most politically loaded thing this system could appear to say, and the one it is least equipped to. Everything below follows from that.

## 1. Not finding a project is a fact about the register

The register searched is a synthetic fixture — V004 §5 approves no real funding dataset — and even a complete register would only ever hold the projects somebody entered into it.

So a no-match is **written down**. `proposeLinksForIssue` records an `unmatched` row rather than leaving the absence of a row to speak for itself, because an absent row is indistinguishable from "nobody has looked yet", and a reader who cannot tell those apart will read either as "this was never funded". The stored row names the register that was searched, the matcher version that searched it, and the note saying what the finding does and does not mean.

`readIssueProjectView` reports `searched` separately from `hasConfirmedLink` for the same reason, and renders the caveat even for a report nobody has searched yet.

The note travels on **every** row, not only the unmatched ones: a reviewer looking at one weak candidate is at the same risk of reading the gaps around it as absence of funding. `absenceOverclaims` is checked by test against everything the domain module and the stored rows can produce — _not funded_, _unfunded_, _no funding_, _government has not_, _no investment_ and three more.

## 2. Nothing is decided by the matcher

`REQUIRES_REVIEWER_DECISION` is a literal `true`, not a threshold somebody can tune past. The matcher writes `proposed`, `ambiguous` or `unmatched`; only a reviewer decision writes `confirmed` or `rejected`, and `project_link_reviewer_required_ck` refuses either without a name against it. An anonymous assertion about public money is what that constraint exists to prevent.

Migration `0030` adds both actions to `review_decision_action_ck` — the same failure `0024` fixed for the dispute override. An action that cannot be written to the audit table is an action with no audit trail, which here would mean an unattributable claim about government spending.

A rejection is **kept**, not deleted. That somebody looked at a pairing and said no is a finding, and re-running the matcher skips pairings a person has already settled: a rejection that comes back next week is not an answer.

## 3. How the signals are weighted

| Signal                  | Alone                         | Why                                                                                                                                     |
| ----------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Asset identifier        | **sufficient to propose**     | It names the physical thing the project was for, not a place near it.                                                                   |
| Geography               | never                         | A sanctioned drain two hundred metres from a broken light says only that both are in this street.                                       |
| Scope terms             | never                         | "Water supply" matches half the projects in a district.                                                                                 |
| Geography **and** scope | sufficient to propose         | Two weak signals corroborating. Enough to show a reviewer, never enough to conclude.                                                    |
| Dates                   | reported, never disqualifying | A project completed years before a report is exactly the funding history somebody asking "has this been paid for before?" wants to see. |

Two candidates tied on the strongest available signal are `ambiguous`, and neither is picked: a coin toss presented as a decision is worse than saying it is unclear. No confidence number is computed or stored — a percentage beside a funding claim reads as a probability somebody calibrated, and nothing here is calibrated. `match_basis` holds the methods that fired and the reasons in words.

## 4. What the demo shows

`npm run projects:seed` loads the register, attaches one report to a synthetic asset so the strongest path is exercised by the demonstration rather than only by tests, and runs the matcher over the profile.

- **One defensible link** — `VIS-V034-WTR` → `DDA-PRJ-001`, matched on `asset_identifier+scope_terms`, confirmed through the reviewer queue with a reason and recorded in `review_decision` with its prior and resulting state.
- **One ambiguity** — `VIS-V036-WAIT` → two sanitation projects 15 m and 25 m away sharing the same scope. Both reach the reviewer; neither is picked.
- **444 recorded no-matches**, each carrying the note. `npm run projects:report` prints these **first** and as a count with the note in full, because a report that lists only its links is how "we searched and found nothing" becomes invisible.

The reviewer card carries the caveat that matters most here: confirming means this report concerns that project, and rejecting means it does not — it is not a finding about whether the asset has been funded.

## 5. Limits

- **Every project is invented.** Nothing in the register describes real public spending. Moving to a real source requires the V004 Data-owner review, not a code change.
- **Scope matching is a set intersection against the report's category**, so a project's scope terms have to name the category rather than resemble it. Nothing here does semantic comparison; V026's embeddings are not used for projects, and using them would put an uncalibrated similarity between a citizen's report and a spending record.
- **No asset-level links.** `project_link` supports an asset target and the matcher does not produce one: a report is the subject throughout, because "is this asset funded" is a question the register cannot answer and "does this report concern this project" is one a reviewer can.
- **The dashboard does not show project links yet.** V042 and V046 are the tasks that would surface them to a citizen, and doing it here would publish a funding association before the surface that explains it exists.
