# V030 — Citizen Tracking, Issue Discovery and Infrastructure History Views

**Status:** Complete and verified
**Roadmap task:** V030 · **Prerequisites:** V015, V021, V025, V028, V029 · **Owner:** Frontend + Backend
**Code:** `packages/adapters/src/citizen-views.ts` · `apps/api/src/citizen-routes.ts` · `apps/web/src/tracking.ts` + `main.ts` + `public/app.html`
**Tests:** 72 V030 assertions across `citizen-views.dbtest.ts`, `citizen-routes.dbtest.ts`, and `tracking.test.ts` · browser walkthrough in §6
**Run it:** `npm run db:up && npm run db:migrate && npm run build:web && npm run dev` → <http://127.0.0.1:8787>

## 1. Two obligations pulling against each other

A citizen must be able to return to their own report **without keeping a secret link**, so every private view is bound to the participant behind the session. A submission id is not a bearer token: it appears in a receipt a citizen may screenshot or forward, and holding one grants nothing. A stranger asking for someone else's receipt gets the same answer as for a receipt that does not exist, so the endpoint cannot be used to probe which ids are real.

A stranger must be able to discover nearby public issues **without learning anything private**, so the public shape comes from V015's `toPublicIssueView` and the location is coarsened to three decimals (~110 m). A precise pin on a public map can be walked back to a reporter's doorstep.

## 2. Paging by cursor, not offset

With an offset, a row inserted between two pages makes a citizen see the same report twice. Two real bugs were found here:

- the cursor compared `server_received_at::text`, and PostgreSQL trims trailing zeros from a timestamp — so `…:00.1` sorts before `…:00.12` as a string while being _later_ as a time, and pages overlapped;
- rebuilding the cursor from the driver's parsed value truncated microseconds to milliseconds, so rows inside the same millisecond were skipped entirely.

The key is now selected as text, compared as a typed tuple with the submission id as a tiebreaker, and never round-tripped through a JS `Date`.

## 3. Bounded discovery, and what an empty list means

The applied radius, page size and category are returned on **every** response, not only when the result is empty, and the server's bounded-search note travels through to the interface. An empty list renders as "Nothing was found within the area searched", never as "no problems nearby".

An issue retired by a merge is excluded from discovery: its reference still resolves, but listing it beside its survivor would read as two problems where there is one.

## 4. Only approved derivatives reach a reader

A photograph is viewable only through an approved derivative. When none exists — V021's normal state, since no detector is configured — the reader is told **why** rather than shown a blank.

`GET /v1/media/derivatives/...` serves published derivatives publicly (requiring an account to see a redacted image would defeat the point). Its safety rests on the object store's tree confinement, which resolves strictly inside `derivatives/` — mutation testing confirms that is the enforcing layer, and the route's own prefix check is documented as defence in depth. The content type comes from **magic bytes**: a file this service cannot identify is not served, because an unidentifiable file handed to a browser is how a stored object becomes active content. Responses carry `nosniff`, `default-src 'none'; sandbox` and `no-referrer`.

`/v1/me/reports` is `no-store`: a shared cache holding one citizen's report list would hand it to the next person behind the same proxy.

## 5. Distinguishing history from complaints

`uniqueContributors` and `complaintEntries` render as **two different sentences**, because they are two different facts — two reports by one person are two entries, not two events. `infrastructureHistory` is empty until V040 imports asset records, and the empty state is explained rather than left blank; inventing a history would be the worst kind of confident-looking summary.

Every detail view carries its disclosures, and a view arriving with **none** substitutes a warning rather than rendering silently: a page showing no disclosures has either lost them in transit or is claiming more certainty than the system has.

Interface counts read "1 person reported this" / "3 people reported this" — never "affected", and with real singular and plural strings rather than a bracketed "(s)".

## 6. Verified in a browser

Against the running local app and PostgreSQL database:

| Check                     | Result                                                                                                                                                                                                                                                               |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Panels and initial states | Tracking is session-bound; discovery remains public; receipt, map, and detail results remain hidden until requested                                                                                                                                                  |
| Receipt lookup            | A newly submitted report appeared in My Reports without reloading; its receipt reopened by button and by typed reference; malformed input was blocked locally; an unknown valid reference returned the non-enumerating account-scoped message                        |
| Discovery map             | 23 returned issues plotted from rounded public coordinates around the selected search centre; changing the category rebuilt both map and list to the same 17 results; the applied 2,000 m radius remained visible                                                    |
| Detail drill-down         | A numbered map marker opened its canonical issue details and moved focus to the details heading; the list remains an equivalent non-map route                                                                                                                        |
| Location honesty          | The map says it is an approximate coordinate plot, not a street map; markers without a publishable location or moved outside the displayed extent by public-coordinate rounding remain in the list and are counted in a disclosure rather than clamped or fabricated |
| Layout                    | At the verification viewport, `scrollWidth` equalled `innerWidth` (542 px), so the new controls introduced no horizontal overflow                                                                                                                                    |
| Validation                | Missing, non-numeric, or out-of-range discovery positions are refused rather than replaced with guessed defaults                                                                                                                                                     |

## 7. Verification

72 V030 tests across the three layers, including coordinate projection, server-applied radius, missing-location disclosure, out-of-extent rounding, receipt-reference normalization, participant-scoped receipt access, public projection, cursor pagination, derivative access, and detail disclosures. The repository-wide suite passes 591 unit tests and 425 serial PostgreSQL tests.

## 8. Boundaries that remain visible

The nearby view is deliberately a **coordinate map without a third-party basemap**. Adding streets would require a tile provider, an external-network failure mode, and a new privacy decision; the current view plots only server-returned coarse public positions and keeps the accessible list beside it.

Assignment and resolution are now connected through the authenticated V034 and V035 workflows. Marathi strings remain machine-drafted and visibly await the native review tracked by V024 · authorized reviewer access to private originals belongs to V032 and is never exposed through this citizen screen.

**Closed since this was written**

Discovery's category filter is populated from the taxonomy pack (V023), served by `GET /v1/taxonomy` — public, with no session, because discovery is public and requiring one would make the filter unusable for exactly the people browsing without signing in.

Only categories are served. Defect identifiers are what a reviewer confirms, and V018 §2 is explicit that a citizen is never asked to classify, so serving them here would invite an interface that does; a test asserts they are absent.

The labels are English and **say so**. The pack declares `label_language` and a `label_note`, and the interface shows that note whenever the page is not in that language — verified in a browser: on the Marathi page the "all categories" option is translated, the reader's chosen filter survives the language switch, and the untranslated-label disclosure appears; on the English page it does not, because "these are in English" on an English page is noise, and noise teaches people to skip the disclosures that matter. Translating the labels needs the native review V019 is waiting on.
