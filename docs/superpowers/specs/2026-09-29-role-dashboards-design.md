# Role dashboards and the "Signal" theme — design

Date: 2026-09-29. Approved by the product owner in conversation.

## Problem

The sign-in page asks every visitor to work out which of five things they are:
it lists demo citizen accounts inline and links three staff workspaces, and each
workspace then asks for a second sign-in. The citizen app is one long page
holding consent, sign-in, the report form, tracking, lookup and discovery. Every
staff page carries a top nav linking every other workspace, so a department
staffer is shown a review queue they cannot use. Typography differs by page.

## Decisions

| Question         | Decision                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------ |
| Staff model      | Pick role, then that role's own dashboard (three sessions stay separate on the server)           |
| Resident model   | A sidebar that slides in and switches between options; one task visible at a time                |
| Visual direction | **C, "Signal"**: dot-matrix display face for headlines, Inter for everything else, violet accent |

## Flow

```
signin.html ──► Residents ──► app.html   (account picker if no session → resident dashboard)
            └─► Staff ─────► team.html  (1. role  2. demo account) ──► role dashboard
                                          Department staff → staff.html
                                          Reviewer         → reviewer.html
                                          Supervisor       → supervisor.html
                                                             (+ dashboard.html, compare.html)
```

### signin.html

Two large cards, **Residents** and **Staff**, under a dot-matrix headline. No
account lists, no workspace links, no background video (it made the headline
illegible); a solid surface with a faint dot-grid texture. Close returns home.

### Resident dashboard (app.html)

- No session: the existing account picker is the first screen (no sidebar yet).
- Session: sidebar with **Report a problem** (default), **Your reports**,
  **Find by receipt**, **Problems nearby**; footer carries the account line,
  language selector and Sign out.
- One view visible at a time, addressed by hash: `#report`, `#reports`,
  `#lookup`, `#nearby`. Unknown or empty hash → `#report`. Back/forward work.
- The report view keeps the whole capture flow together: drafts consent, form,
  review, receipt, the duplicate-candidate question and the evidence rail.
- Cross-view actions switch view: opening an issue from Your reports shows it
  in Problems nearby; "report another" returns to Report.
- Element ids are unchanged, so `main.ts` logic is untouched apart from calls
  into a small view controller.

### Staff door (team.html, new)

- Step 1: three role cards — Department staff, Reviewer, Supervisor.
- Step 2: that role's active demo accounts, read from the role's own session
  endpoint; choosing one calls that role's existing `…/auth/demo-login` and
  redirects to the role's dashboard. A role already signed in shows "Continue".
- Identity is simulated and the page says so.

### Role dashboards

Same sidebar shell as residents; each shows only its own role's options.

| Role             | Page                                          | Sidebar items                                                                         |
| ---------------- | --------------------------------------------- | ------------------------------------------------------------------------------------- |
| Department staff | staff.html                                    | the inbox filters (All routed, Not accepted, Unassigned, No recipient acknowledgment) |
| Reviewer         | reviewer.html                                 | the review-type filters                                                               |
| Supervisor       | supervisor.html, dashboard.html, compare.html | Oversight queues, Resolution durability, District dashboard, Compare policies         |

Footer: account line, **Switch role** (→ team.html), Sign out. The cross-linking
top nav is removed. Opening a workspace directly without a session still shows
its own (restyled) login panel, so no existing path breaks.

### Sidebar shell (shared)

`shell.css` + `shell.ts`. ≥ 960 px: persistent 260 px sidebar. Narrower: a top
bar with a menu button; the sidebar slides in from the left over a backdrop.
Escape and backdrop close it, focus is trapped while open, the main region is
`inert`, `aria-expanded` and `aria-current` are kept accurate, and motion is
dropped under `prefers-reduced-motion`.

## Theme — direction C, "Signal"

- `theme.css` is the single token source for every page: surfaces, ink, muted
  ink, border, violet accent and its ink, danger/warning, radius, spacing, and
  the type scale 12 / 14 / 16 / 20 / 28 / 40 / 56.
- Display face (BubbledotICG, self-hosted, CC BY 4.0 with its attribution kept)
  only for page titles, the sign-in headline, the wordmark and large figures —
  never below 28 px. It has no Devanagari; translated headings fall back to the
  sans stack.
- Inter for body, labels and eyebrows (eyebrows: 12 px uppercase, tracked).
- Light and dark schemes on every page. The contrast test covers the new
  tokens in both.

## Not changing

Server code, sessions, CSP (no new external assets), business logic in the
`*-main.ts` files beyond navigation wiring, the landing page and the public
intelligence page (they pick up shared tokens only). New sidebar strings are
added to both locale packs; the Marathi pack keeps its existing
"machine-drafted, pending native review" status.

## Verification

`npm run check` (all gates and tests), new unit tests for hash → view mapping
and role routing, and a browser walk-through at desktop and phone widths:
sign-in → each door → account → every sidebar item, for residents and all
three staff roles.
