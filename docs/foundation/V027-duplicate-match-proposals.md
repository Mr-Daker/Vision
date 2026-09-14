# V027 — Propose Duplicate Matches with Reviewable Reasons

**Status:** Ready for owner approval
**Roadmap task:** V027 · **Prerequisites:** V011, V024, V025, V026 · **Owner:** AI + Backend
**Code:** `packages/domain/src/match-proposal.ts`
**Tests:** `match-proposal.test.ts` (17) · 17 mutations, 0 survivors

## 1. A proposal is advice, not a decision

`proposeMatch` returns one of three outcomes with its reasons attached, and nothing else happens. V028 is what commits anything, and it refuses to act on an ambiguous proposal — which is why `mayMerge` is a literal `false` on that branch rather than a value a caller could set.

## 2. How the signals are weighted, and why

- **Category is a gate, not a score.** A different defect at the same place is a _different problem_; no amount of proximity or similarity may collapse the two. This is the hard negative the task exists to get right, and it holds even for an exact asset match.
- **Asset identity is the strongest positive signal** and can carry a match alone: it names the physical thing rather than a place near it.
- **Semantics is the main discriminator** among nearby candidates.
- **Proximity is the weakest signal and never sufficient alone.** Two unrelated problems metres apart are ordinary. A candidate with no semantic vector is therefore never matched on distance alone.
- **Media reuse is reported but decides nothing.** Identical bytes mean one photograph submitted twice, which is not evidence that two reports describe one problem. It is recorded _before_ the category gate, so a reviewer still learns that the same photograph appeared under two categories — worth seeing, whichever way the decision goes.
- **Recurrence always defers to a person**, per the domain contract: reopening a resolved issue and opening a fresh one are different acts with different histories.

## 3. When the answer is "unclear"

Two cases produce `ambiguous` rather than a guess:

- two candidates scoring too closely to separate — ranking them would be arbitrary, and an arbitrary ranking presented as a decision is worse than saying it is unclear;
- a single candidate whose description is similar but not clearly the same.

A description that is _clearly different_ is **not** ambiguous — it is a new issue. Proximity does not make two unlike reports uncertain. (An earlier version of this record's test expected otherwise; the threshold semantics are now stated in the tests.)

No score is published. `thresholds` travel with every proposal alongside `matcherVersion`, so a later reader can tell a changed rule from a changed input.

## 4. Verification

17 tests, 17 mutations, 0 survivors — including dropping the category gate, letting an ambiguous proposal authorise a merge (tested on both the recurrence branch and the close-scores branch), matching on proximity with no vector, and picking arbitrarily between close candidates.

Two of the original test expectations were wrong about what the thresholds meant and were corrected rather than the implementation bent to match them; one implementation gap (media reuse swallowed by the category gate) was a real fix.

## 5. Not done

Thresholds are chosen by reasoning, **not** calibrated against any labelled set — V046 is where they would be measured, and until then they are defaults, not tuned values · media similarity is passed in as a boolean rather than computed here · no reviewer interface presents these reasons (V032).
