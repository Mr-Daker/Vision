# V043 — The policy decision and investment comparison view

**Roadmap task:** V043 · **Prerequisites:** V030, V039, V041, V042 · **Owner:** Frontend + Data
**Code:** `packages/domain/src/outcome-attribution.ts`, `packages/adapters/src/comparison.ts`, `apps/web/src/compare-view.ts` · **Screen:** `apps/web/public/compare.html`

The screen where V042's ordering, V041's project links and V040's context meet. It exists to let a reviewer answer three questions, and each one is a function rather than a layout decision.

## 1. Why does this rank above that?

`factorComparison` does the subtraction. It returns every factor ordered by how much of the gap it accounts for, with the ones carrying it marked, and `separationSummary` names them in a sentence. A comparison that lists factors in a fixed order leaves the reviewer to do the arithmetic, and the arithmetic _is_ the answer to "why".

Two candidates that differ by less than a rounding margin are said to: _"Nothing separates VIS-A and VIS-B by more than a rounding margin. Their order here is not a finding about either of them."_ An order between indistinguishable candidates is not evidence, and on synthetic data most pairs are indistinguishable.

A factor one side has no value for accounts for **none** of the gap and says so — scoring it as a difference of zero would read as the two agreeing, which is a different statement from one of them being unmeasured.

## 2. Which assumptions would I argue with?

`assumptionsOf` derives the list from the policy rather than writing it out by hand, so adding a weighting or changing a reference point cannot leave a stale list behind. Each is labelled:

| Label                         | Meaning                                                                                                                                  |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **No source exists**          | nothing in this deployment could support it — severity, accessibility, cost                                                              |
| **Chosen by this deployment** | a configuration decision with no evidence behind the choice — the equity inversion, the existing-project direction, the reference points |
| **Backed by a loaded source** | the context lineage, the plurality of weightings                                                                                         |

`assumptionsByScrutiny` puts the absent ones first and the evidenced ones last. A list that opens with what is well supported invites a reader to stop there. `assumptionsAreCandid` exists to assert the inverse property: an ordering claiming _every_ assumption is evidenced is the one to distrust, because some of these are choices and saying otherwise is the overclaim.

## 3. Did the money do this?

No, and this is the part the screen works hardest at.

A comparison view puts two things side by side that a reader joins up on their own: money sanctioned for an asset, and something good happening to a report about that asset afterwards. The join is the error. This system records that a repair was claimed and confirmed; it has no counterfactual, no control, no measurement of the work.

So recorded outcomes are **placed against the project's own dates** — `during`, `before`, `after`, `unknown` — and `outcomeStatement` counts all four, because showing only the overlap is how an overlap starts to look like a mechanism. An open-ended project yields `unknown` rather than `during` for everything after its sanction: _"still running, so everything since counts"_ is the assumption that turns an indefinite project into credit for every improvement in its area.

No outcome is ever toned as a success. `during` is toned as a **caveat**, because it is the one a reader is most likely to read as a result, and the attribution note is written into the card beside it rather than into a tooltip or a footer.

The demo shows this as sharply as it can: `VIS-V035-WATER` is attached to an asset with a sanctioned project running 10–30 September, and **six of its recorded events fall inside those dates — including a dispute and a reopening.** A naive "linked project plus confirmed resolution means the money worked" reading is impossible to sustain when the reopening is inside the window too.

`attributionOverclaims` checks nine phrasings (_thanks to_, _resulted in_, _led to_, _the project fixed_, _impact of the investment_, _money well spent_, _demonstrates the value_, and two more) against everything this module and the screen can render.

## 4. Scenario comparison preserves the policy version

The scenario selector reorders the list by one weighting's positions. It never changes the policy: `render` re-states `Policy demo-priority.v1 · 4 weightings` on every pass, scenario changes included, and the live region says _"the policy version is unchanged."_ A reviewer switching weightings is never looking at a page whose policy moved underneath them.

Positions themselves are **always intervals**. `positionText` has no branch producing a single number, including when best and worst agree — "3 to 3" says the weightings agreed, where a bare "3" says the system knows. A scenario comparison built on this cannot collapse into a leaderboard.

## 5. What it reuses

The supervisor session (V036), the district dashboard's stylesheet and card patterns (V039), the V040 context lineage rendered per candidate, V041's project links including the distinction between _searched and found nothing_ and _nobody has looked_, and V042's ordering with its per-factor contributions and per-weighting positions. No new role, no new session, no new visual language.

## 6. Limits

- **Read-only.** There is no endpoint on this surface that changes anything; a comparison that could alter what it compares would make the ordering depend on who had been looking at it.
- **The candidate detail is capped** at eight by default while the ordering is computed over every candidate — a position among twelve is a different statement from a position among two hundred, so the ordering is never narrowed to the page.
- **No costs anywhere.** The comparison cannot say what any of this would cost or what could be afforded, and says so in its own assumptions list.
- **Recorded outcomes are lifecycle events only.** Nothing measures the work itself, and the screen has no field that could hold such a measurement.
