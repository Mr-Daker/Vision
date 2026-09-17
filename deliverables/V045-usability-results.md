# V045 — Comparative citizen usability study: results

**Protocol:** [V045-usability-study-protocol.md](../docs/foundation/V045-usability-study-protocol.md) · **Recorded:** 17 September 2026

## Sample size

**Zero.** No participant session has been run, in either arm.

Nothing in this document is a comparative claim, and none can be made from it. `comparativeClaimVerdict` refuses at n = 0 and lists what is missing: participants, a second arm, counterbalanced orders, consent records. That refusal is enforced in code, not by convention.

What follows is an **accessibility and interface pass**, run without participants. It is a prerequisite for the study, not a substitute for it: V045's clause that "blocking accessibility and reporting failures are corrected and retested" is what this pass discharges, and the comparative experiment remains to be run with people.

## Conditions exercised, without participants

| Condition                    | Exercised | How                                                                                                                                                                                                                                                        |
| ---------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| keyboard-only                | yes       | real `Tab` traversal of every operator screen and the citizen app; focus visibility and order checked at each stop                                                                                                                                         |
| screen reader                | partly    | the accessibility tree was inspected and every control's accessible name checked; **no person who uses a screen reader daily has attempted any task**                                                                                                      |
| text zoom 200%               | yes       | citizen app at 200% root font size: no horizontal overflow, no clipped content (the one element reported as clipped is the visually-hidden live region, which is meant to be)                                                                              |
| English                      | yes       | full traversal                                                                                                                                                                                                                                             |
| Marathi                      | yes       | full traversal, including the duplicate-confirmation panel                                                                                                                                                                                                 |
| constrained mobile / network | partly    | 375×812 viewport verified on the citizen app: no horizontal overflow, no control under 44px. **Network throttling was not exercised** — the harness available here cannot throttle a connection, so the slow-connection half of this condition is untested |

## Flows covered

Reporting, duplicate confirmation and report tracking were each traversed in the citizen app. The duplicate-confirmation panel was inspected in both languages.

## Blocking failures found, corrected and retested

Four. Each was found by this pass, fixed, and re-checked.

1. **The duplicate-confirmation screen was English-only.** `toCandidateView` built every sentence as an English literal, so a Marathi reader reached the one screen where the system asks them a direct question — _is this the same problem?_ — and was answered in English. Twelve strings moved into both locale packs and the view builder now takes a translator. Retested in the browser: the panel renders in Marathi, and no visible `data-i18n` element is left untranslated.
2. **The landing page and the sign-in page had no skip link**, so a keyboard user traversed the whole header on every visit. Added, using the same off-screen-until-focused pattern as the operator screens rather than a second pattern.
3. **The public-intelligence page had no headings at all** — every landmark carried an `aria-label` and nothing else. Landmark labels do not appear in the heading list a screen-reader user navigates by, so the page was reachable only by walking it. An `h1` and two `h2`s added, visually hidden because the visual design already names those areas.
4. **The two duplicate-confirmation buttons were empty in the markup**, named only once the script had run. The panel is hidden until then, so no reader met an unnamed button — but a button with no fallback is one missing sentence from being unnamed, and an audit cannot tell the two apart. Localised fallbacks added.

## Other defects found and fixed

**Nine Content Security Policy violations on the landing and sign-in pages.** The staggered entrance animation set its delays as `style="--d: …"` attributes and, in `landing.js`, through `element.style.setProperty`. The policy is `style-src 'self'`, so every one was refused: the animation silently never ran and nine errors were logged on each visit. Delays are now carried as classes. Verified afterwards on both pages: **zero elements with an inline style, zero console errors, and the stagger applying** (`rd-2` → `0.16s`).

## Standing findings, not corrected here

- **`#photo-input` is a 1px file input.** Checked and cleared: it is the standard visually-hidden pattern behind a 585×96 label, and the input remains keyboard-focusable. Not a defect.
- **Network throttling untested.** See the table above.
- **Marathi is team-authored throughout.** V024's native-speaker review has not happened, and the twelve strings added by this pass are part of what it must cover. Until then, "the interface is in Marathi" means the strings exist, not that they read well to a Marathi speaker.

## Limitations

- **No participants, so no usability finding of any kind.** Everything above concerns whether the interface can be operated, not whether anybody succeeded at anything.
- **No comparison.** The existing-flow arm has not been run. No statement about relative effort, speed, error rate or preference is supported by this document.
- **A repeatable floor, not a ceiling.** `accessibility.test.ts` runs on every commit and checks the shipped markup; focus order, zoom behaviour and what a screen reader announces were checked by hand on the date above and are not re-checked automatically.
- **One operator, one browser engine, one machine.** The pass was run in a single browser in the development environment.
