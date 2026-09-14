# V019 — Citizen Capture and Submission Interface

**Status:** Ready for owner approval
**Roadmap task:** V019 · **Prerequisites:** V009, V016, V018 · **Owner:** Frontend
**Code:** `apps/web/` (`src/main.ts` + pure modules, `public/index.html`, `public/app.css`)
**Tests:** `capture.test.ts` (39), `contrast.test.ts` (4), plus a browser walkthrough recorded in §7
**Run it:** `npm run db:up && npm run db:migrate && npm run build:web && npm run dev` → <http://127.0.0.1:8787>

## 1. What was built, and with what

A mobile-first PWA in plain TypeScript: **no framework, no bundler, no new dependency**. `tsc` emits browser ESM and `tools/rewrite-web-imports.mjs` turns the two workspace specifiers into absolute paths, so the page loads modules directly.

The API serves the interface, because the session cookie is `SameSite=Strict` and CSRF is a double-submit token — both need one origin. `apps/api/src/static-files.ts` does it with a resolved-root traversal check, an extension allowlist, no directory listing, no dotfiles, and a strict `Content-Security-Policy`. [V006](V006-architecture-and-deployment-decisions.md) D3 still treats the PWA as its own deployable unit; this is how it is served locally.

All decision logic lives in pure modules and is unit-tested: `i18n.ts`, `location.ts`, `upload.ts`, `submission.ts`, `drafts.ts`. `main.ts` is the only file that touches the DOM.

## 2. A captured position and a typed position are different things

This is the requirement the interface exists to get right, and it is enforced in four places at once:

- **Wording.** "Location captured by this device" versus "Location you entered yourself", each with its own explanation ("saved as a location you claim, not as location evidence from your device").
- **Appearance.** A claimed pin renders with a different border colour and background (`[data-location-source="manual_pin"]`), so the distinction is not carried by wording alone.
- **The payload.** `observed.source` is `device_geolocation` or `manual_pin`, stored as a column ([V018](V018-submission-acceptance-and-receipt.md) §3).
- **Accuracy.** A device reading shows the accuracy the device reported. A typed position shows "the device did not report how accurate this position is" and sends `accuracy_m: null` — never 0.

Neither is called verified. The [V002](V002-capability-evidence-matrix.md) prohibition on "proof of presence" holds.

**This surfaced a real bug in V018.** `SubmissionInput.accuracyMetres` was a required `number`, so a manual pin had to send something, and 0 would have been stored as a perfect measurement. The field is now optional, **required** for a device reading and **refused** for a manual pin, with the column left NULL. Three new database tests cover it.

## 3. Permission handling and the paths that actually fail

| Situation                         | What the citizen gets                                                               |
| --------------------------------- | ----------------------------------------------------------------------------------- |
| Location permission denied        | An explanation, and the manual-entry fields opened and focused                      |
| Position unavailable or timed out | A different message: try again, or enter it yourself                                |
| Geolocation unsupported           | Manual entry, no dead end                                                           |
| Position captured 10+ minutes ago | A prompt to capture again, and a re-capture button (V020)                           |
| Microphone denied or unsupported  | A message pointing at the textarea, which was always available                      |
| Upload interrupted                | The upload stays `failed` with an explicit retry that **reuses the granted object** |
| Send interrupted                  | "Nothing was sent", the draft kept, the same idempotency key retried                |

A denied permission never blocks the report, and a failed step is never presented as a completed one.

## 4. An upload is "uploaded" only when the server says so

`upload.ts` is a state machine over `idle → selected → granting → sending → finalizing → accepted | failed`. `isAttachable` is true **only** in `accepted`, and `blocksSubmission` is true while an upload is selected, in flight or failed — so sending cannot silently drop a photo the citizen believes is attached. Progress comes from real `XMLHttpRequest` upload events, and "sending 100%" is deliberately not the same message as "uploaded and saved".

## 5. No classification is asked for

There is no category, department, severity or priority control, and the review step says so in words. A test asserts that no locale key matching those names exists, so adding one is a deliberate act rather than a drift.

## 6. Localisation and translation honesty

`en-IN` and `mr-IN` ship as **locale packs under `src/locales/`** — data, not code, per [V001](V001-scope-and-release-boundaries.md) Appendix G rule 7. Nothing outside that directory names a language; `main.ts` takes a catalogue.

The Marathi pack is marked `machine_drafted_pending_native_review`, and **the interface displays that**: "This translation was drafted without a native reviewer… It is not an official translation." Sign-off by a Marathi speaker is **verification pending**, and the pilot must not ship it unreviewed. Switching language also sets `<html lang>`, and a restored draft comes back in the language it was written in.

Tests assert both packs define exactly the same keys, that no key is defined without being rendered (a disclosed draft lifetime that is never shown is a broken promise), and that no rendered key is undefined.

V019 also exposed a scope-guard gap: `check:scope` only matched `"mr-IN"` as a whole string literal, so a `"en-IN,mr-IN"` default inside `server.ts` had slipped through. The pattern now matches a locale tag anywhere in a string, `SUPPORTED_LOCALES` is required configuration with no default in code, and paths into `locales/` or `packs/` are exempt because referring to a resource is how locale data is meant to be reached.

## 7. Accessibility — what was verified, and how

Measured in a real browser (Chromium) against the running app, not asserted from the source:

| Check                          | Result                                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Touch targets                  | 13 visible interactive controls, **none** below 44×44 CSS px                                           |
| Tab order                      | Follows visual order; **no positive `tabindex`** anywhere                                              |
| Accessible names               | Every visible `input`/`select`/`textarea` has a label or `aria-label`                                  |
| Focus visibility               | `:focus-visible { outline: 3px solid; outline-offset: 2px }`; **no `outline: none` in the stylesheet** |
| Live regions                   | `role="status" aria-live="polite"` for progress and state, `role="alert"` for errors                   |
| Focus movement                 | Focus moves to the receipt heading on acceptance and to the error summary on failure                   |
| Zoom                           | At a halved viewport (≈200% zoom) there is **no horizontal scrolling** and nothing overflows           |
| Viewport                       | `width=device-width, initial-scale=1` — no `maximum-scale`, no `user-scalable=no`                      |
| Contrast                       | All 9 rendered text/UI pairs pass AA in **both** light and dark schemes (worst text pair 6.80:1)       |
| Reduced motion, forced colours | Honoured                                                                                               |

`contrast.test.ts` reads the real stylesheet and recomputes every ratio, so a future colour change fails the suite instead of quietly breaking the claim. It was negative-tested: lightening one token to 2.53:1 fails it.

**Not verified, and not claimed:** no screen reader was actually run (no VoiceOver/NVDA/TalkBack pass), and no real assistive-technology user has tried this. The live regions and focus moves are correct by construction and by DOM inspection, which is weaker evidence than someone listening to it. A screen-reader pass and a real-device pass on a low-end Android phone are **owner checks still outstanding**. The browser walkthrough also drove events programmatically because the automation pane renders headless, so pointer hit-testing and visual appearance were not exercised.

## 8. Bugs this task found in its own work

- **The CSP blocked the import map.** An import map is an inline `<script>`, and the interface is served under `script-src 'self'`, so the module graph never resolved and the page rendered as an empty shell with no server-side error. Fixed by rewriting specifiers at build time rather than weakening the policy or pinning a fragile inline-script hash.
- **`hidden` did not hide.** `.button { display: inline-flex }` is an author style and beats the browser's `[hidden] { display: none }`, so the hidden "Sign out" and "Retry" buttons were rendering and being exposed. Fixed with `[hidden] { display: none !important }`, now asserted by a test.
- **A misleading error heading.** "Please fix the highlighted fields" appeared above "You appear to be offline", telling the citizen to correct a field when nothing they typed was wrong. A single message now stands alone.
- **A button labelled with a heading.** The manual-location action read "Location you entered yourself"; it now has its own label.
- **A client/server rule mismatch.** The server requires a description, photo or recording (`no_observation`); the client thought a location alone was enough, so a citizen could be rejected by the server for a rule the form never mentioned. The client now applies the same rule.
- **A restored draft lost the language.** The draft recorded `interfaceLocale` and restoring ignored it, so someone working in Marathi came back to English.

## 9. Not yet done

Service worker and offline shell caching (V020 territory and beyond) · photo bytes are not retained on the device, so an upload interrupted mid-send must be re-selected rather than resumed (V016 grant state is a process-local map) · tracking a submitted report over time (V030+) · staff and reviewer surfaces (V031+) · real device testing on a low-end Android phone · a Marathi native review.
