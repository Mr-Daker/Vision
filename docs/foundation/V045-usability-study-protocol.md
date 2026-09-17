# V045 — Comparative citizen usability study: protocol

**Roadmap task:** V045 · **Prerequisites:** V019, V020, V024, V031, V044 · **Owner:** Product + QA
**Design as code:** `packages/domain/src/usability-study.ts` · **Results:** [V045-usability-results.md](../../deliverables/V045-usability-results.md)

This document is the instrument. The results are separate, and at the time of writing they record **no participant sessions**.

## 1. What is being compared, and what is not

Each participant attempts the same three flows twice: once in this prototype and once in a suitable existing flow. The three flows are the ones V045 names — **reporting**, **duplicate confirmation**, **report tracking** — and every one of them is attempted under every condition in §3.

**No real complaint is ever filed.** The existing flow is exercised up to, and never through, its submit step. A usability test that puts invented reports in front of a real authority has wasted somebody's afternoon and polluted a public record, and no finding is worth that.

## 2. Counterbalancing

`counterbalanceOrder(participantIndex)` alternates which arm a participant meets first. Whoever goes second has already solved the task once, so without alternation the comparison measures practice as much as design — and the bias always favours whichever arm came second.

`isCounterbalanced` checks the orders actually run, and `comparativeClaimVerdict` refuses a comparison when they are not balanced. The design is code so a run that departs from it produces a record that does not match, rather than a sentence somebody forgot.

## 3. Conditions, all of which apply to all three flows

| Condition                    | What it means                                              |
| ---------------------------- | ---------------------------------------------------------- |
| `keyboard_only`              | no pointer, at all, for the whole session                  |
| `screen_reader`              | the participant's own screen reader, at their own settings |
| `text_zoom_200`              | browser text size at 200%                                  |
| `language_en_IN`             | interface in English                                       |
| `language_mr_IN`             | interface in Marathi                                       |
| `constrained_mobile_network` | a phone-sized viewport on a throttled connection           |

A study that tested keyboard-only reporting but not keyboard-only tracking would have covered the word rather than the requirement.

## 4. What every session records

Per participant, per arm, per task: whether it was completed, completion time in seconds, the **count** of assistance events, the **count** of errors, the participant's own answer to a comprehension probe, and anything the observer noticed.

`understandingProbe` is the participant's answer, verbatim, not the observer's impression. "They seemed to understand" is the observation most likely to be wrong and least likely to be challenged.

The comprehension probe for each flow:

- **reporting** — _"What happens to what you just sent?"_ A correct answer says a record was received and does not say a repair was promised or that a department was contacted.
- **duplicate confirmation** — _"What did answering yes do to your report?"_ A correct answer says it joined an existing report and that their entry is counted once.
- **report tracking** — _"What does this status tell you, and what does it not?"_ A correct answer distinguishes a recorded claim from a verified repair.

## 5. Consent and ethics

Consent is recorded before any session and the study cannot be reported without it. Participants are told the system is a demonstration, that no report they make reaches any authority, and that they may stop at any point. No personal data is recorded in the session records: the schema has no name, contact or demographic field, and the participant is identified only by an index.

## 6. The claim this study gates

`comparativeClaimVerdict` refuses a comparative effort claim unless: both arms were run, at least five participants took part, the order was counterbalanced, every condition in §3 was run, consent was recorded, and no real complaint was filed. The refusal lists everything missing, so it reads as a next step rather than a wall.

`comparativeOverclaims` detects the phrasings this gate exists to prevent — _easier than_, _faster than_, _fewer errors than_, _participants preferred_, _40% quicker_ — in anything published.

## 7. What an automated pass cannot do

A machine pass can establish that controls have names, that structure exists, and that nothing is unreachable by keyboard. It cannot establish that anybody could complete the task, whether a sentence was understood, or whether somebody gave up. Screen-reader verification in the automated pass means the accessibility tree was inspected — not that somebody who uses a screen reader daily attempted the task.

Nothing in an automated pass supports a comparison with any other flow.
