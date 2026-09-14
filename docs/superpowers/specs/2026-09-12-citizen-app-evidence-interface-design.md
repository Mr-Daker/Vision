# Citizen app as evidence interface — design

Date: 2026-09-12
Status: approved, not yet implemented
Scope: `apps/web/public/app.html`, `apps/web/public/app.css`, new `apps/web/src/spatial-panel.ts`, new `apps/web/src/evidence-rail.ts`

## Problem

The landing page is cinematic. The citizen app is a 640 px column of flat panels on flat black, with 400 px of dead space either side at 1440 px. Moving from one to the other reads as moving to a different website.

The palette is not the gap — `app.css` already sets `--page: #000000` and `--ink: #ffffff` under `prefers-color-scheme: dark`, with a comment saying this is deliberately the landing page's ground. The gap is composition: no spatial language, no glass, no display type, nothing occupying the width, and no sense that a system is doing anything with what you supply.

## Intent

The app is **the instrument you enter after the trailer** — the same world at roughly 20–25% of the landing page's intensity. The form remains the dominant interaction at every viewport. Nothing added may slow, obscure, or distract from sending a report.

## Non-goals

- No change to form markup semantics, labels, validation, focus order, or any `data-i18n` key.
- No third-party requests of any kind. The CSP (`default-src 'self'`) stays exactly as it is.
- No new runtime dependency. `pg` remains the only one.
- No map tiles, and no invented geography.

## 1. Atmospheric ground

A single fixed layer behind all content, drawn entirely in CSS:

- Two large radial gradients in the landing wave's own colours (dusty violet, warm crest), at low alpha.
- A coordinate graticule at 64 px, hairline, ~3% opacity.
- Very fine grain.
- One 40-second drift on the gradient positions only. Removed entirely under `prefers-reduced-motion: reduce`.

Civic and geographic rather than neon-SaaS: straight ruled lines and signal falloff, not organic blobs. Downloads nothing.

## 2. Evidence rail

At `min-width: 1100px` the main area becomes two columns: the form keeps its 640 px measure on the left, and a sticky rail sits on the right. Below that breakpoint the rail's cards fold back into the single column, in step order.

**Rule that governs the whole rail: no information exists only in the rail.** Every value it shows is also present in the form flow. The rail is a second view of state, never the only one. This is what keeps the mobile and screen-reader experience whole.

### Cards

| Card                  | Neutral state                  | Resolved state                                                       |
| --------------------- | ------------------------------ | -------------------------------------------------------------------- |
| **Location Evidence** | "Waiting for location"         | the location instrument (§3)                                         |
| **Evidence**          | "Add evidence to analyse"      | photo preview, real byte size and type read from the `File`          |
| **Nearby**            | "Locate to see nearby reports" | real count from `nearbyIssues()`, e.g. "3 open reports within 500 m" |
| **Pipeline**          | always visible, stage 1 lit    | current stage lit (§4)                                               |

### Progressive states

Each card moves through `neutral → processing → resolved`, never appearing abruptly.

- `neutral` — dimmed label, hairline border, anticipatory copy. The composition is complete and intentional from the first paint.
- `processing` — a brief indeterminate sweep along the card's top edge while the underlying async work runs (geolocation fix, file read, nearby fetch).
- `resolved` — content crossfades in over 240 ms; the border picks up a faint accent.

`processing` is driven by real pending work, never by a timer pretending to compute. A card that resolves instantly goes straight to `resolved` rather than faking a delay.

## 3. Location instrument

An inline SVG rendered from the reading the app already holds (`LocationReading`: latitude, longitude, `accuracyMetres?`, `source`, `capturedAt`).

Every mark on it represents something the system genuinely knows:

- **Graticule** — true parallels and meridians at a real interval for the current scale, labelled in degrees. Not street-like lines. Fabricated streets were considered and rejected: a viewer could reasonably read them as the real layout, which is the invented-visual problem this product refuses everywhere else.
- **Pin** — the reported position, centre of the panel.
- **Accuracy ring** — `accuracyMetres` drawn to true scale against the graticule, so a ±40 m fix visibly covers more ground than a ±5 m one. Absent when accuracy is unknown, with the panel saying so rather than drawing a default circle.
- **Scan pulse** — a slow ring expanding from the pin. Decorative, and the only decorative element on the panel. Off under `prefers-reduced-motion`.
- **Nearby markers** — real issues from `nearbyIssues()`, plotted at their true relative bearing and distance from the pin. Never plotted when the data has not loaded.
- **Readout** — coordinates, capture time, and the source stated plainly as measured by the device or placed by hand.

`source === "manual_pin"` must never be presented with the language of a measurement. The existing `describeLocation()` already draws this distinction and is the source of truth for the wording.

## 4. Pipeline card

Four stages, each named for a state that actually exists:

| Card label   | Backing state                                   |
| ------------ | ----------------------------------------------- |
| **Captured** | `SubmissionStatus: received`                    |
| **Checked**  | `SubmissionStatus: accepted` (via `processing`) |
| **Matched**  | `IssueMatchState: match_confirmed`              |
| **Routed**   | `IssueStatus: routed_internal`                  |

**"Verified" is deliberately not used.** No such state exists in the lifecycle, and `packages/domain/src/transitions.ts` exists specifically to stop a status being asserted rather than earned. The product says elsewhere that a repair claim is not a verified resolution; a card reading "Verified" would contradict that in the citizen's own interface.

The routed stage must carry the simulated-department disclosure already used elsewhere, so the card cannot imply a real agency received anything.

Stages the citizen has not reached are dimmed, not hidden — seeing the whole path is the point. The tracking panel remains the place where the lifecycle beyond routing (acknowledgement, work, resolution, confirmation) is shown.

## 5. Type and glass

The display face (`BubbledotICG-FinePos`) takes a narrow, permanent role: step numbers, rail card labels, coordinate readouts, stage names. It is never used for body copy, form labels, error messages, or anything a citizen must read to complete the task — it is a display face and its legibility at small sizes is not good enough for that job.

Glass is `backdrop-filter: blur()` over the ground with a hairline top edge, applied to rail cards and the three opt-in panels only. Disabled below the rail breakpoint, where it falls back to a solid `--panel` surface: `backdrop-filter` is expensive on low-end phones, which are the target device.

## 6. Constraints that must hold

- **`:root` block order is load-bearing.** `contrast.test.ts` reads `:root` blocks by index — 0 is light, 1 is the dark override. Any new `:root` must come after the dark block.
- All nine contrast pairs stay at or above their WCAG thresholds in both schemes.
- `outline: none` must not appear; `[hidden] { display: none !important }` must remain; no `user-scalable=no`.
- The shared button block keeps `min-height: 2.75rem` and `min-width: 2.75rem`.
- `check:browser-safe` must pass: no Node APIs in browser-delivered files.
- New TypeScript compiles via `npm run build:web` into `public/js/app/`.

## 7. Code layout

`main.ts` is already 1389 lines; none of this goes there.

- **`apps/web/src/spatial-panel.ts`** — pure. Takes a `LocationReading` plus optional nearby issues, returns an SVG string and a readout model. No DOM, no network, no clock beyond what it is handed. Unit-testable directly, which is where the bearing/distance/scale maths gets its tests.
- **`apps/web/src/evidence-rail.ts`** — owns the four cards and their `neutral → processing → resolved` transitions. Subscribes to state the form already produces; holds no state of its own that the form does not have.
- **`app.css`** — new sections for ground, rail, cards, instrument. Existing rules edited only where the redesign requires it.
- **`app.html`** — rail container and card shells; existing form markup untouched apart from hooks.

## 8. Testing

- `spatial-panel.test.ts` — scale, bearing and distance maths; absent accuracy produces no ring; manual pin is never described as measured.
- `contrast.test.ts` — continues to pass unchanged; extended with any new token pair the redesign introduces.
- Browser verification at 1920×1080, 1440×900, 1280×800, 375×812, 390×640: rail present or folded as specified, no horizontal overflow, contrast measured against the real rendered ground rather than assumed.
- `prefers-reduced-motion` verified to stop drift, sweep, and scan pulse.

## 9. Risks

- **Glass cost on low-end phones.** Mitigated by disabling it below the rail breakpoint.
- **Rail becoming load-bearing for information.** Mitigated by the rule in §2 and checked by folding the rail away and confirming nothing is lost.
- **Display type creeping into body copy.** Mitigated by keeping its role to the enumerated list in §5.
- **The instrument implying precision it does not have.** Mitigated by drawing the accuracy ring to true scale and refusing to draw one when accuracy is unknown.
