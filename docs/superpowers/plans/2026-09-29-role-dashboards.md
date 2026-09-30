# Role Dashboards and "Signal" Theme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sign-in offers only Residents and Staff; each lands on its own sidebar dashboard showing only that audience's options, in one consistent "Signal" theme.

**Architecture:** One shared sidebar shell (`shell.css` + `shell.ts`) is added to the resident app and the five operator pages. A new `team.html` is the staff door (role → demo account → role home). The resident app keeps every element id and switches between four hash-addressed views. Colour and type live in `theme.css` as `--sg-*` tokens; page stylesheets map their existing token names onto them.

**Tech Stack:** Vanilla TypeScript compiled by `tsc` to `apps/web/public/js/app/`, plain CSS, `node:test`. No framework, no new dependency, no new external asset (CSP `style-src 'self'`, `script-src 'self'`).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-09-29-role-dashboards-design.md`.
- No inline `style="…"` attributes and no inline `<script>` — the base CSP blocks both.
- Display face `BubbledotICG-FinePos` only at ≥ 28 px (1.75rem): h1, sign-in headline, wordmark, large figures. Everything else Inter.
- Both colour schemes on every page; every text pair ≥ 4.5:1, focus ring ≥ 3:1 (asserted by tests).
- Every page: `lang`, exactly one `<main>`, a skip link to an existing id, headings start at h1 and never skip a level, no positive tabindex (`accessibility.test.ts`).
- Identity and department notices stay on every screen listed in `notices.test.ts`; `team.html` is added there. Operator pages keep a bare `<footer>` disclaimer.
- Element ids used by `*-main.ts` are never renamed.
- Every locale key must be rendered somewhere in the files `capture.test.ts` scans; new keys exist in both `en-IN` and `mr-IN`.
- Verify with `npm run check` and in the browser (`npm run build:web`, dev server on :3000).

---

### Task 1: Signal tokens in `theme.css`, mapped into the page stylesheets

**Files:**

- Modify: `apps/web/public/theme.css`
- Modify: `apps/web/public/app.css:31-73` (token values only)
- Modify: `apps/web/public/reviewer.css:31-96` (token values → `var(--sg-*)`)
- Test: `apps/web/src/contrast.test.ts` (add a `theme.css` block)

**Interfaces:**

- Produces: CSS custom properties `--sg-page --sg-sidebar --sg-panel --sg-line --sg-ink --sg-ink-muted --sg-ink-dim --sg-accent --sg-accent-hover --sg-accent-ink --sg-accent-soft --sg-accent-text --sg-danger --sg-danger-bg --sg-warning-ink --sg-warning-bg --sg-focus`, type tokens `--sg-text-xs|sm|base|md|lg|xl|2xl`, and `--font-headline`, `--font-label`.

- [ ] **Step 1: Write the failing test** — append to `contrast.test.ts`:

```ts
const THEME_PATH = join(dirname(fileURLToPath(import.meta.url)), "../public/theme.css");
const theme = readFileSync(THEME_PATH, "utf8");
const themeLight = readTokens(theme, 0);
const themeDark = { ...themeLight, ...readTokens(theme, 1) };

const SIGNAL_PAIRS: readonly (readonly [string, string, string, number])[] = [
  ["body text", "--sg-ink", "--sg-page", TEXT_MINIMUM],
  ["muted text on the page", "--sg-ink-muted", "--sg-page", TEXT_MINIMUM],
  ["muted text on a panel", "--sg-ink-muted", "--sg-panel", TEXT_MINIMUM],
  ["muted text in the sidebar", "--sg-ink-muted", "--sg-sidebar", TEXT_MINIMUM],
  ["dim text in the sidebar", "--sg-ink-dim", "--sg-sidebar", TEXT_MINIMUM],
  ["primary button label", "--sg-accent-ink", "--sg-accent", TEXT_MINIMUM],
  ["active nav item", "--sg-accent-text", "--sg-accent-soft", TEXT_MINIMUM],
  ["error text", "--sg-danger", "--sg-danger-bg", TEXT_MINIMUM],
  ["caution text", "--sg-warning-ink", "--sg-warning-bg", TEXT_MINIMUM],
  ["focus ring on the page", "--sg-focus", "--sg-page", NON_TEXT_MINIMUM],
  ["focus ring on a panel", "--sg-focus", "--sg-panel", NON_TEXT_MINIMUM],
];

for (const [schemeName, tokens] of [
  ["light", themeLight],
  ["dark", themeDark],
] as const) {
  test(`Signal theme: ${schemeName} scheme meets the contrast thresholds`, () => {
    for (const [description, foreground, background, minimum] of SIGNAL_PAIRS) {
      const fg = tokens[foreground];
      const bg = tokens[background];
      assert.notEqual(fg, undefined, `${schemeName}: ${foreground} is not defined`);
      assert.notEqual(bg, undefined, `${schemeName}: ${background} is not defined`);
      const measured = ratio(fg ?? "#000000", bg ?? "#ffffff");
      assert.ok(
        measured >= minimum,
        `${schemeName}: ${description} is ${measured.toFixed(2)}:1, below ${String(minimum)}:1`,
      );
    }
  });
}
```

- [ ] **Step 2: Run** `node --test apps/web/src/contrast.test.ts` — expect FAIL: `--sg-ink is not defined`.

- [ ] **Step 3: Implement.** In `theme.css`, fold the existing `:root` tokens and the light palette into the first `:root` block and add a dark override directly after it (block index 1):

```css
:root {
  /* existing --font-sans, --font-display, brand chrome, --radius-pill, --target-min stay */
  --font-headline: "BubbledotICG-FinePos", "Inter", "Noto Sans Devanagari", system-ui, sans-serif;
  --font-label: var(--font-sans);

  --sg-text-xs: 0.75rem;
  --sg-text-sm: 0.875rem;
  --sg-text-base: 1rem;
  --sg-text-md: 1.25rem;
  --sg-text-lg: 1.75rem;
  --sg-text-xl: 2.5rem;
  --sg-text-2xl: 3.5rem;

  --sg-page: #f8f7fb;
  --sg-sidebar: #f0eef6;
  --sg-panel: #ffffff;
  --sg-line: #d6d2e3;
  --sg-ink: #15131d;
  --sg-ink-muted: #4f4b5e;
  --sg-ink-dim: #625e72;
  --sg-accent: #4b3fc4;
  --sg-accent-hover: #3b30a6;
  --sg-accent-ink: #ffffff;
  --sg-accent-soft: #e6e2ff;
  --sg-accent-text: #3b30a6;
  --sg-danger: #a4231b;
  --sg-danger-bg: #fdf3f2;
  --sg-warning-ink: #6b4300;
  --sg-warning-bg: #fff8e6;
  --sg-focus: #1f6feb;
  --sg-radius: 0.75rem;
  --sg-radius-lg: 1.25rem;
}

@media (prefers-color-scheme: dark) {
  :root {
    --sg-page: #0d0c10;
    --sg-sidebar: #121117;
    --sg-panel: #17161d;
    --sg-line: #2c2a36;
    --sg-ink: #eeeef2;
    --sg-ink-muted: #a9a7b3;
    --sg-ink-dim: #8e8c99;
    --sg-accent: #b9b1ff;
    --sg-accent-hover: #cdc7ff;
    --sg-accent-ink: #16132b;
    --sg-accent-soft: #221f33;
    --sg-accent-text: #c9c2ff;
    --sg-danger: #ff8a80;
    --sg-danger-bg: #2b1a1c;
    --sg-warning-ink: #f2cf7a;
    --sg-warning-bg: #2a2116;
    --sg-focus: #9ec5ff;
  }
}
```

In `app.css` set the literal hex tokens to the same values (the V019 test reads literals): light `--page #f8f7fb --ink #15131d --ink-muted #4f4b5e --line #d6d2e3 --panel #ffffff --accent #4b3fc4 --accent-ink #ffffff --accent-hover #3b30a6 --focus #1f6feb`; dark `--page #0d0c10 --ink #eeeef2 --ink-muted #a9a7b3 --line #2c2a36 --panel #17161d --accent #b9b1ff --accent-ink #16132b --accent-hover #cdc7ff --focus #9ec5ff`. Danger/warning pairs keep their current values. In `reviewer.css` point `--page --ink --muted --dim --surface --accent --accent-hover --accent-ink --danger --caution --caution-soft --focus` at the matching `var(--sg-*)` in both blocks (remove the duplicated dark literals that the `--sg-*` dark block now supplies).

- [ ] **Step 4: Run** `node --test apps/web/src/contrast.test.ts` — expect PASS (all V019 and Signal cases).

- [ ] **Step 5: Commit** (only if the user has asked for commits) `feat(web): add Signal theme tokens`.

---

### Task 2: Shared sidebar shell

**Files:**

- Create: `apps/web/src/shell.ts`, `apps/web/src/shell.test.ts`, `apps/web/public/shell.css`

**Interfaces:**

- Produces (TS):
  - `resolveView<T extends string>(hash: string, views: readonly T[], fallback: T): T`
  - `trapIndex(current: number, count: number, backwards: boolean): number`
  - `mountShell(): Shell` where `type Shell = { setSignedIn(signedIn: boolean, account?: string): void; showView(view: string): void; close(): void }`
  - `wireFilterLinks(): void` — buttons `[data-filter-for][data-filter-value]` drive a `<select>`.
- Produces (markup contract):

```html
<div class="shell" data-signed-in="false">
  <div class="shell-bar">
    <button
      type="button"
      class="shell-menu"
      id="shell-menu"
      aria-controls="shell-sidebar"
      aria-expanded="false"
      aria-label="Menu"
    >
      <span class="shell-menu-icon" aria-hidden="true"></span>
    </button>
    <a class="shell-wordmark" href="/">Vision</a>
  </div>
  <aside class="shell-sidebar" id="shell-sidebar" aria-label="…">
    <a class="shell-wordmark" href="/">Vision</a>
    <p class="shell-role">…</p>
    <nav class="shell-nav-wrap" aria-label="…">
      <ul class="shell-nav">
        …
      </ul>
    </nav>
    <div class="shell-footer">
      <p class="shell-account" id="shell-account"></p>
      …
    </div>
  </aside>
  <div class="shell-backdrop" id="shell-backdrop" hidden></div>
  <main class="shell-main" id="…">…</main>
</div>
```

Nav items: `<a class="shell-link" href="#report" data-view-link="report">…</a>` (view switch), `<a class="shell-link" href="/dashboard.html" aria-current="page">…</a>` (page), `<button type="button" class="shell-link" data-filter-for="staff-filter" data-filter-value="unassigned">…</button>` (filter). Group labels: `<li class="shell-group">Oversight</li>`.

- [ ] **Step 1: Write the failing test** `shell.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveView, trapIndex } from "./shell.ts";

const VIEWS = ["report", "reports", "lookup", "nearby"] as const;

test("a known hash selects its view", () => {
  assert.equal(resolveView("#reports", VIEWS, "report"), "reports");
  assert.equal(resolveView("nearby", VIEWS, "report"), "nearby");
});

test("an empty, unknown or oddly cased hash falls back rather than hiding everything", () => {
  assert.equal(resolveView("", VIEWS, "report"), "report");
  assert.equal(resolveView("#", VIEWS, "report"), "report");
  assert.equal(resolveView("#admin", VIEWS, "report"), "report");
  assert.equal(resolveView("#Reports", VIEWS, "report"), "reports");
});

test("focus wraps inside an open drawer in both directions", () => {
  assert.equal(trapIndex(0, 4, false), 1);
  assert.equal(trapIndex(3, 4, false), 0);
  assert.equal(trapIndex(0, 4, true), 3);
  assert.equal(trapIndex(-1, 4, false), 0);
  assert.equal(trapIndex(0, 0, false), -1);
});
```

- [ ] **Step 2: Run** `node --test apps/web/src/shell.test.ts` — expect FAIL (module not found).

- [ ] **Step 3: Implement `shell.ts`:**

```ts
/**
 * The sidebar shell every dashboard shares (role dashboards design, 2026-09-29).
 *
 * Persistent at desktop width; below it, a drawer that slides in from the
 * left. While the drawer is open focus stays inside it, the page behind is
 * inert, and Escape or the backdrop closes it — the same contract a native
 * dialog keeps, because on a phone that is what an open drawer is.
 */

export const resolveView = <T extends string>(
  hash: string,
  views: readonly T[],
  fallback: T,
): T => {
  const name = hash.replace(/^#/, "").trim().toLowerCase();
  return (views as readonly string[]).includes(name) ? (name as T) : fallback;
};

/** The next focusable index when Tab is pressed inside the drawer; -1 when there is none. */
export const trapIndex = (current: number, count: number, backwards: boolean): number => {
  if (count <= 0) return -1;
  if (current < 0) return backwards ? count - 1 : 0;
  return backwards ? (current - 1 + count) % count : (current + 1) % count;
};

export type Shell = {
  readonly setSignedIn: (signedIn: boolean, account?: string) => void;
  readonly showView: (view: string) => void;
  readonly close: () => void;
};

const FOCUSABLE = "a[href], button:not([disabled]), select:not([disabled]), input:not([disabled])";
const DESKTOP = "(min-width: 60rem)";

export const mountShell = (): Shell => {
  const root = document.querySelector<HTMLElement>(".shell");
  const sidebar = document.getElementById("shell-sidebar");
  const menu = document.getElementById("shell-menu");
  const backdrop = document.getElementById("shell-backdrop");
  const main = document.querySelector<HTMLElement>(".shell-main");
  const noop: Shell = {
    setSignedIn: () => undefined,
    showView: () => undefined,
    close: () => undefined,
  };
  if (root === null || sidebar === null || menu === null || backdrop === null || main === null) {
    return noop;
  }
  const desktop = window.matchMedia(DESKTOP);

  const setOpen = (open: boolean): void => {
    const drawer = open && !desktop.matches;
    root.dataset["drawer"] = drawer ? "open" : "closed";
    menu.setAttribute("aria-expanded", String(drawer));
    backdrop.hidden = !drawer;
    main.inert = drawer;
    if (drawer) sidebar.querySelector<HTMLElement>(FOCUSABLE)?.focus();
  };
  const close = (): void => {
    const wasOpen = root.dataset["drawer"] === "open";
    setOpen(false);
    if (wasOpen) menu.focus();
  };

  menu.addEventListener("click", () => setOpen(root.dataset["drawer"] !== "open"));
  backdrop.addEventListener("click", close);
  desktop.addEventListener("change", () => setOpen(false));
  sidebar.addEventListener("keydown", (event) => {
    if (root.dataset["drawer"] !== "open") return;
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== "Tab") return;
    const items = [...sidebar.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (item) => item.offsetParent !== null,
    );
    const next = trapIndex(
      items.indexOf(document.activeElement as HTMLElement),
      items.length,
      event.shiftKey,
    );
    if (next < 0) return;
    event.preventDefault();
    items[next]?.focus();
  });
  // Choosing an item on a phone is the end of the drawer's job.
  sidebar.addEventListener("click", (event) => {
    if ((event.target as HTMLElement).closest(".shell-link") !== null) close();
  });

  setOpen(false);

  return {
    setSignedIn: (signedIn, account) => {
      root.dataset["signedIn"] = String(signedIn);
      const line = document.getElementById("shell-account");
      if (line !== null && account !== undefined) line.textContent = account;
      if (!signedIn) setOpen(false);
    },
    showView: (view) => {
      for (const region of main.querySelectorAll<HTMLElement>("[data-view]")) {
        region.hidden = region.dataset["view"] !== view;
      }
      for (const link of sidebar.querySelectorAll<HTMLElement>("[data-view-link]")) {
        if (link.dataset["viewLink"] === view) link.setAttribute("aria-current", "page");
        else link.removeAttribute("aria-current");
      }
    },
    close,
  };
};

/** Sidebar buttons that stand in for a page's filter `<select>`. */
export const wireFilterLinks = (): void => {
  const buttons = [...document.querySelectorAll<HTMLButtonElement>("[data-filter-for]")];
  const sync = (selectId: string, value: string): void => {
    for (const button of buttons) {
      if (button.dataset["filterFor"] !== selectId) continue;
      if (button.dataset["filterValue"] === value) button.setAttribute("aria-current", "true");
      else button.removeAttribute("aria-current");
    }
  };
  for (const button of buttons) {
    const selectId = button.dataset["filterFor"] ?? "";
    const select = document.getElementById(selectId);
    if (!(select instanceof HTMLSelectElement)) continue;
    button.addEventListener("click", () => {
      select.value = button.dataset["filterValue"] ?? "";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      sync(selectId, select.value);
    });
    select.addEventListener("change", () => sync(selectId, select.value));
    sync(selectId, select.value);
  }
};
```

Also create `apps/web/public/shell.css` with: grid layout `.shell { display:grid; grid-template-columns: 16.25rem minmax(0,1fr) }` at ≥ 60rem; sticky full-height `.shell-sidebar` on `--sg-sidebar` with a right hairline; `.shell-bar` shown only below 60rem; below 60rem `.shell-sidebar` is `position: fixed; inset: 0 auto 0 0; width: min(18rem, 86vw); transform: translateX(-100%); transition: transform 240ms cubic-bezier(.2,.8,.2,1)` and `.shell[data-drawer="open"] .shell-sidebar { transform: none }`; `.shell-backdrop` fixed, `rgb(0 0 0 / .5)`; `.shell[data-signed-in="false"] :is(.shell-sidebar,.shell-menu) { display:none }` and single-column grid; `.shell-link` 2.75rem min-height rows, `--sg-ink-muted`, hover `--sg-ink`, `[aria-current]` → `--sg-accent-soft` bg + `--sg-accent-text`; `.shell-group` Inter 12 px uppercase tracked `--sg-ink-dim`; `.shell-wordmark` in `--font-headline` at 1.75rem; `.shell-role` Inter 12 px uppercase `--sg-accent-text`; `.shell-footer` pinned at the bottom (`margin-top:auto`); `.shell-main h1` in `--font-headline`, `clamp(var(--sg-text-lg), 3.2vw, var(--sg-text-xl))`, `line-height: 1.1`, `letter-spacing: .01em`; a subtle dot grid on `.shell-main` via `background-image: radial-gradient(color-mix(in srgb, var(--sg-ink) 7%, transparent) 1px, transparent 1px); background-size: 22px 22px`; `@media (prefers-reduced-motion: reduce) { .shell-sidebar { transition: none } }`.

- [ ] **Step 4: Run** `node --test apps/web/src/shell.test.ts` and `npm run typecheck` — expect PASS.

- [ ] **Step 5: Commit** (only if asked) `feat(web): shared sidebar shell`.

---

### Task 3: Two-door sign-in page

**Files:**

- Modify: `apps/web/public/signin.html` (rewrite body), `apps/web/public/signin.css` (rewrite)
- Delete: `apps/web/public/signin.js`

- [ ] **Step 1: Rewrite `signin.html`.** Head loads only `theme.css` and `signin.css`. Body:

```html
<a class="skip-link" href="#signin-main">Skip to the two ways in</a>
<main class="door" id="signin-main">
  <a class="door-close" href="index.html" aria-label="Close and return to the home page">Close</a>
  <p class="door-eyebrow">Vision demonstration</p>
  <h1 class="door-title">Who are you?</h1>
  <p class="door-sub">
    Two ways in. Identity is simulated on both sides of this demonstration: no document is checked
    and no government system is contacted.
  </p>
  <div class="door-grid">
    <a class="door-card" href="app.html">
      <span class="door-card-eyebrow">Residents</span>
      <span class="door-card-title">Report and follow problems where you live</span>
      <span class="door-card-copy"
        >Send a report, see what is already reported nearby, and follow what happens to yours.</span
      >
      <span class="door-card-cta" aria-hidden="true">Continue →</span>
    </a>
    <a class="door-card" href="team.html">
      <span class="door-card-eyebrow">Staff</span>
      <span class="door-card-title">Work on reported problems</span>
      <span class="door-card-copy"
        >Department staff, reviewers and supervisors. Every department and staff account here is
        simulated.</span
      >
      <span class="door-card-cta" aria-hidden="true">Continue →</span>
    </a>
  </div>
</main>
<p class="font-credit">
  Font made from
  <a href="http://www.onlinewebfonts.com/fonts" rel="noopener noreferrer">Web Fonts</a> is licensed
  by CC BY 4.0
</p>
```

- [ ] **Step 2: Rewrite `signin.css`**: `body` on `--sg-page` with the dot grid; `.door` centred, max 64rem; `.door-title` `--font-headline` `clamp(2.5rem, 7vw, 3.5rem)`; `.door-grid` two columns ≥ 48rem, one below; `.door-card` `--sg-panel`, `1px solid var(--sg-line)`, radius `--sg-radius-lg`, padding 2rem, hover lifts border to `--sg-accent` and moves `.door-card-cta` 4px right (no motion under reduced-motion); `.door-card-eyebrow` Inter 12 px uppercase `--sg-accent-text`; `.door-card-title` Inter 600 1.5rem; `:focus-visible` 3px `--sg-focus` outline, 3px offset; `.skip-link` visible only on focus; `.font-credit` Inter 12 px `--sg-ink-dim`.

- [ ] **Step 3: Delete `signin.js`** (`git rm apps/web/public/signin.js`) — nothing else loads it.

- [ ] **Step 4: Run** `node --test apps/web/src/accessibility.test.ts apps/web/src/notices.test.ts` — expect PASS.

- [ ] **Step 5: Commit** (only if asked) `feat(web): two-door sign-in`.

---

### Task 4: Staff door `team.html`

**Files:**

- Create: `apps/web/src/team.ts`, `apps/web/src/team.test.ts`, `apps/web/src/team-main.ts`, `apps/web/public/team.html`, `apps/web/public/team.css`
- Modify: `apps/web/src/notices.test.ts:30-50` (add `"team.html"` to both screen lists)

**Interfaces:**

- Consumes: `StaffApiClient`, `ReviewerApiClient`, `SupervisorApiClient` (`capabilities()`, `session()`, `login(credential)`), `ApiResult` from `api.ts`.
- Produces: `STAFF_ROLES`, `type StaffRole = "department" | "reviewer" | "supervisor"`, `ROLE_HOME: Record<StaffRole, string>`, `roleFromHash(hash: string): StaffRole | undefined`, `usablePrincipals(value: unknown): readonly DemoPrincipal[]`.

- [ ] **Step 1: Write the failing test** `team.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { ROLE_HOME, STAFF_ROLES, roleFromHash, usablePrincipals } from "./team.ts";

test("every role has a home, and each home is a different workspace", () => {
  const homes = STAFF_ROLES.map((role) => ROLE_HOME[role]);
  assert.deepEqual(homes, ["/staff.html", "/reviewer.html", "/supervisor.html"]);
});

test("a role is chosen from the hash and nothing else", () => {
  assert.equal(roleFromHash("#reviewer"), "reviewer");
  assert.equal(roleFromHash("supervisor"), "supervisor");
  assert.equal(roleFromHash("#"), undefined);
  assert.equal(roleFromHash("#admin"), undefined);
});

test("only well-formed demo principals become buttons", () => {
  assert.deepEqual(
    usablePrincipals([
      { credential: "c1", label: "Demo staff 1" },
      { credential: "", label: "empty credential" },
      { credential: "c3" },
      "not an object",
    ]),
    [{ credential: "c1", label: "Demo staff 1" }],
  );
  assert.deepEqual(usablePrincipals(undefined), []);
});
```

- [ ] **Step 2: Run** `node --test apps/web/src/team.test.ts` — expect FAIL (module not found).

- [ ] **Step 3: Implement `team.ts`:**

```ts
/**
 * The staff door (role dashboards design, 2026-09-29).
 *
 * Three roles, three separate sessions on the server (V015). This page picks
 * which one, signs into it, and hands over to that role's own dashboard.
 */

export type StaffRole = "department" | "reviewer" | "supervisor";

export const STAFF_ROLES: readonly StaffRole[] = ["department", "reviewer", "supervisor"];

export const ROLE_HOME: Readonly<Record<StaffRole, string>> = {
  department: "/staff.html",
  reviewer: "/reviewer.html",
  supervisor: "/supervisor.html",
};

export const roleFromHash = (hash: string): StaffRole | undefined => {
  const name = hash.replace(/^#/, "").trim();
  return STAFF_ROLES.find((role) => role === name);
};

export type DemoPrincipal = { readonly credential: string; readonly label: string };

export const usablePrincipals = (value: unknown): readonly DemoPrincipal[] => {
  if (!Array.isArray(value)) return [];
  const result: DemoPrincipal[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const credential = record["credential"];
    const label = record["label"];
    if (typeof credential !== "string" || credential.length === 0) continue;
    if (typeof label !== "string" || label.length === 0) continue;
    result.push({ credential, label });
  }
  return result;
};
```

- [ ] **Step 4: Run** `node --test apps/web/src/team.test.ts` — expect PASS.

- [ ] **Step 5: `team.html`** (loads `theme.css`, `signin.css`, `team.css`, module `/js/app/team-main.js`):

```html
<a class="skip-link" href="#team-main">Skip to staff sign-in</a>
<main class="door" id="team-main">
  <a class="door-close" href="signin.html" aria-label="Back to the two ways in">Back</a>
  <p class="door-eyebrow">Staff</p>
  <h1 class="door-title" id="team-title" tabindex="-1">Choose your role</h1>
  <p class="door-sub">
    Simulated demonstration identity: not a real identity check. Every department and staff account
    is simulated, and being routed somewhere is not an acknowledgment by anybody.
  </p>
  <p class="team-error" id="team-error" role="alert" hidden></p>
  <section id="team-roles" aria-labelledby="team-title">
    <div class="door-grid door-grid-3">
      <button type="button" class="door-card" data-role="department">
        …Department staff / Work routed to your department…
      </button>
      <button type="button" class="door-card" data-role="reviewer">
        …Reviewer / Settle what a machine should not decide…
      </button>
      <button type="button" class="door-card" data-role="supervisor">
        …Supervisor / What is waiting too long, and did repairs last…
      </button>
    </div>
  </section>
  <section id="team-accounts" aria-labelledby="team-accounts-heading" hidden>
    <h2 id="team-accounts-heading" tabindex="-1">Choose a demo account</h2>
    <div id="team-account-list" class="team-accounts" aria-live="polite"></div>
    <button type="button" id="team-back" class="team-back">Choose a different role</button>
  </section>
</main>
```

(Inside each role button use `<span class="door-card-eyebrow">`, `<span class="door-card-title">`, `<span class="door-card-copy">` as on the sign-in page.)

- [ ] **Step 6: `team-main.ts`:**

```ts
import type { ApiResult } from "./api.ts";
import { ReviewerApiClient } from "./reviewer-api.ts";
import { StaffApiClient } from "./staff-api.ts";
import { SupervisorApiClient } from "./supervisor-api.ts";
import { ROLE_HOME, roleFromHash, usablePrincipals, type StaffRole } from "./team.ts";

type RoleClient = {
  capabilities(): Promise<ApiResult<{ readonly demo_principals: unknown }>>;
  session(): Promise<
    ApiResult<{ readonly authenticated: boolean; readonly identity_label?: string }>
  >;
  login(credential: string): Promise<ApiResult<unknown>>;
};

const clients: Readonly<Record<StaffRole, RoleClient>> = {
  department: new StaffApiClient(),
  reviewer: new ReviewerApiClient(),
  supervisor: new SupervisorApiClient(),
};

const ROLE_NAMES: Readonly<Record<StaffRole, string>> = {
  department: "Department staff",
  reviewer: "Reviewer",
  supervisor: "Supervisor",
};

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`missing #${id}`);
  return node as T;
};

const showError = (message: string | undefined): void => {
  const box = el("team-error");
  box.hidden = message === undefined;
  box.textContent = message ?? "";
};

const accountButton = (label: string, onChoose: () => Promise<void>): HTMLButtonElement => {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "team-account";
  button.textContent = label;
  button.addEventListener("click", () => {
    button.disabled = true;
    void onChoose().finally(() => {
      button.disabled = false;
    });
  });
  return button;
};

const showRoles = (): void => {
  el("team-accounts").hidden = true;
  el("team-roles").hidden = false;
  history.replaceState(null, "", location.pathname);
  el("team-title").textContent = "Choose your role";
  el("team-title").focus();
};

const showAccounts = async (role: StaffRole): Promise<void> => {
  showError(undefined);
  const client = clients[role];
  history.replaceState(null, "", `#${role}`);
  el("team-roles").hidden = true;
  el("team-accounts").hidden = false;
  el("team-title").textContent = ROLE_NAMES[role];
  const list = el("team-account-list");
  list.setAttribute("aria-busy", "true");
  list.replaceChildren();

  const [session, capabilities] = await Promise.all([client.session(), client.capabilities()]);
  list.removeAttribute("aria-busy");

  if (session.ok && session.value.authenticated) {
    const label = session.value.identity_label ?? ROLE_NAMES[role];
    list.append(
      accountButton(`Continue as ${label}`, async () => location.assign(ROLE_HOME[role])),
    );
  }
  if (!capabilities.ok) {
    showError(
      "The demonstration accounts could not be loaded. The API may not be running on this origin.",
    );
    return;
  }
  for (const principal of usablePrincipals(capabilities.value.demo_principals)) {
    list.append(
      accountButton(principal.label, async () => {
        const result = await client.login(principal.credential);
        if (!result.ok) {
          showError("That account could not be signed in just now. Try again, or choose another.");
          return;
        }
        location.assign(ROLE_HOME[role]);
      }),
    );
  }
  if (list.childElementCount === 0) {
    showError("No demonstration accounts are configured for this role on this server.");
  }
  el("team-accounts-heading").focus();
};

for (const card of document.querySelectorAll<HTMLButtonElement>("[data-role]")) {
  const role = roleFromHash(card.dataset["role"] ?? "");
  if (role !== undefined) card.addEventListener("click", () => void showAccounts(role));
}
el("team-back").addEventListener("click", showRoles);

const initial = roleFromHash(location.hash);
if (initial !== undefined) void showAccounts(initial);
```

- [ ] **Step 7: `team.css`**: `.door-grid-3` three columns ≥ 60rem; `.team-accounts` a column of full-width `.team-account` pills (min-height 3rem, `--sg-panel`, hairline, hover border `--sg-accent`); `.team-back` quiet text button; `.team-error` `--sg-danger` on `--sg-danger-bg`; `button.door-card` resets (`font: inherit; text-align: left; color: inherit; cursor: pointer`).

- [ ] **Step 8: Add `"team.html"` to `IDENTITY_SCREENS` and `DEPARTMENT_SCREENS` in `notices.test.ts`. Run** `node --test apps/web/src/team.test.ts apps/web/src/notices.test.ts apps/web/src/accessibility.test.ts` — expect PASS.

- [ ] **Step 9: Commit** (only if asked) `feat(web): staff door with role then account`.

---

### Task 5: Resident dashboard

**Files:**

- Create: `apps/web/src/resident-views.ts`, `apps/web/src/resident-views.test.ts`
- Modify: `apps/web/public/app.html`, `apps/web/public/app.css`, `apps/web/src/main.ts`
- Modify: `apps/web/src/locales/strings.ts`, `en-IN.ts`, `mr-IN.ts`
- Modify: `apps/web/src/capture.test.ts:694-710` (add `"resident-views.ts"` to the scanned sources)

**Interfaces:**

- Consumes: `mountShell`, `resolveView` (Task 2).
- Produces: `RESIDENT_VIEWS`, `type ResidentView`, `DEFAULT_RESIDENT_VIEW`, `RESIDENT_VIEW_TITLES: Record<ResidentView, StringKey>`.

- [ ] **Step 1: Write the failing test** `resident-views.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { enIN } from "./locales/en-IN.ts";
import { mrIN } from "./locales/mr-IN.ts";
import { DEFAULT_RESIDENT_VIEW, RESIDENT_VIEWS, RESIDENT_VIEW_TITLES } from "./resident-views.ts";

test("the resident dashboard has exactly the four options the design names", () => {
  assert.deepEqual([...RESIDENT_VIEWS], ["report", "reports", "lookup", "nearby"]);
  assert.equal(DEFAULT_RESIDENT_VIEW, "report");
});

test("every view title exists in both language packs", () => {
  for (const view of RESIDENT_VIEWS) {
    const key = RESIDENT_VIEW_TITLES[view];
    assert.ok(enIN.strings[key].length > 0);
    assert.ok(mrIN.strings[key].length > 0);
  }
});
```

- [ ] **Step 2: Run** `node --test apps/web/src/resident-views.test.ts` — expect FAIL (module not found).

- [ ] **Step 3: Implement `resident-views.ts`:**

```ts
/** The resident dashboard's four options (role dashboards design, 2026-09-29). */

import type { StringKey } from "./locales/strings.ts";

export const RESIDENT_VIEWS = ["report", "reports", "lookup", "nearby"] as const;
export type ResidentView = (typeof RESIDENT_VIEWS)[number];
export const DEFAULT_RESIDENT_VIEW: ResidentView = "report";

/** The page heading for each view. Reused keys, so no view title is untranslated. */
export const RESIDENT_VIEW_TITLES: Readonly<Record<ResidentView, StringKey>> = {
  report: "app.tagline",
  reports: "tracking.heading",
  lookup: "lookup.heading",
  nearby: "discovery.heading",
};
```

- [ ] **Step 4: Locale keys.** Add to `StringKey` in `strings.ts`: `"nav.report" | "nav.nearby" | "nav.label" | "nav.menu" | "nav.role"`. `en-IN`: `"nav.report": "Report a problem"`, `"nav.nearby": "Problems nearby"`, `"nav.label": "Resident options"`, `"nav.menu": "Menu"`, `"nav.role": "Resident"`; change `"app.skip_to_form"` to `"Skip to the main content"`. `mr-IN`: `"nav.report": "समस्या नोंदवा"`, `"nav.nearby": "जवळपासच्या समस्या"`, `"nav.label": "रहिवाशांसाठी पर्याय"`, `"nav.menu": "मेनू"`, `"nav.role": "रहिवासी"`; `"app.skip_to_form": "मुख्य मजकुराकडे जा"`.

- [ ] **Step 5: Restructure `app.html`.** Keep every existing id. Replace `<header class="app-header">` with the shell (Task 2 contract), `<aside id="shell-sidebar" data-i18n-label="nav.label">`, sidebar items:

```html
<p class="shell-role" data-i18n="nav.role">Resident</p>
<nav class="shell-nav-wrap" id="shell-nav">
  <ul class="shell-nav">
    <li>
      <a class="shell-link" href="#report" data-view-link="report" data-i18n="nav.report"
        >Report a problem</a
      >
    </li>
    <li>
      <a class="shell-link" href="#reports" data-view-link="reports" data-i18n="tracking.heading"
        >Your reports</a
      >
    </li>
    <li>
      <a class="shell-link" href="#lookup" data-view-link="lookup" data-i18n="lookup.heading"
        >Find a saved receipt</a
      >
    </li>
    <li>
      <a class="shell-link" href="#nearby" data-view-link="nearby" data-i18n="nav.nearby"
        >Problems nearby</a
      >
    </li>
  </ul>
</nav>
<div class="shell-footer">
  <p id="signed-in-as" class="shell-account" hidden></p>
  <label class="language-label" for="language-select" data-i18n="app.language_label"
    >Language</label
  >
  <select id="language-select" class="language-select"></select>
  <button type="button" id="sign-out" class="shell-signout" hidden data-i18n="login.sign_out">
    Sign out
  </button>
</div>
```

`<main class="app-main shell-main" id="main-content">`; skip link `href="#main-content"`. Inside `.app-column`: `h1#page-title` loses `data-i18n`; the always-visible block (`capability-label`, `translation-notice`, `live-status`, `error-summary`, the simulated notice, `login-panel`) stays first; then four wrappers:

- `<div data-view="report">` → `consent-panel`, `draft-restored`, `report-form`, `receipt-panel`
- `<div data-view="reports" hidden>` → `tracking-panel` (without the lookup form), `candidate-panel`
- `<div data-view="lookup" hidden>` → `<section id="lookup-panel" class="panel" aria-labelledby="receipt-lookup-heading">` containing the existing `receipt-lookup-form`, whose heading becomes `<h2 id="receipt-lookup-heading" class="visually-hidden">`
- `<div data-view="nearby" hidden>` → `discovery-panel`, `detail-panel`

`tracking-heading` and `discovery-heading` gain `class="visually-hidden"` (the h1 already names the view). The evidence rail `<aside>` gains `data-view="report"` and stays inside `<main>` as today. `.app-footer` stays.

- [ ] **Step 6: Wire `main.ts`:**

```ts
import { mountShell, resolveView } from "./shell.ts";
import {
  DEFAULT_RESIDENT_VIEW,
  RESIDENT_VIEWS,
  RESIDENT_VIEW_TITLES,
  type ResidentView,
} from "./resident-views.ts";

const shell = mountShell();
let currentView: ResidentView = resolveView(location.hash, RESIDENT_VIEWS, DEFAULT_RESIDENT_VIEW);

const showView = (view: ResidentView, focus = false): void => {
  currentView = view;
  shell.showView(view);
  el("page-title").textContent = t(RESIDENT_VIEW_TITLES[view]);
  if (location.hash !== `#${view}`) history.replaceState(null, "", `#${view}`);
  if (focus) el("page-title").focus();
};
```

- `applyStaticText`: after the `[data-i18n]` loop add `el("page-title").textContent = t(RESIDENT_VIEW_TITLES[currentView]);`, `el("shell-menu").setAttribute("aria-label", t("nav.menu"));`, `el("shell-nav").setAttribute("aria-label", t("nav.label"));`, `el("shell-sidebar").setAttribute("aria-label", t("nav.label"));`.
- `renderSignedIn`: add `shell.setSignedIn(true);` and `showView(currentView);`.
- `renderLoginPanel`: add `shell.setSignedIn(false);`.
- `wire()`: `window.addEventListener("hashchange", () => showView(resolveView(location.hash, RESIDENT_VIEWS, DEFAULT_RESIDENT_VIEW), true));`
- `openDetail` (after a successful fetch, before `renderDetail`): `showView("nearby");`.
- the "Open saved receipt" handler in `renderMyReports`: `() => { showView("lookup"); void lookupReceipt(row.submissionId); }`.
- `openCandidateQuestion` (before revealing the panel): `showView("reports");`.
- `startAnotherReport`: `showView("report");`.
- `signIn`: replace the `scrollIntoView` line with `showView(currentView, true);`.
- `h1#page-title` gets `tabindex="-1"` so focus can land on it.

- [ ] **Step 7: `app.css`**: remove the `.app-header` rules; add `.language-label`, `.language-select` sizing for the sidebar footer; `.app-main` keeps its column + rail grid inside `.shell-main`; `h1` uses `--font-headline` via shell.css. Add `<link rel="stylesheet" href="/shell.css" />` after `app.css` in the head.

- [ ] **Step 8: Add `"resident-views.ts"` to the sources list in `capture.test.ts`. Run** `npm run typecheck && node --test apps/web/src/*.test.ts` — expect PASS.

- [ ] **Step 9: Commit** (only if asked) `feat(web): resident dashboard with sidebar views`.

---

### Task 6: Department staff and reviewer dashboards

**Files:**

- Modify: `apps/web/public/staff.html`, `apps/web/public/reviewer.html`, `apps/web/src/staff-main.ts`, `apps/web/src/reviewer-main.ts`, `apps/web/public/reviewer.css`

- [ ] **Step 1: Markup.** In each page replace `<header class="reviewer-header">…</header>` with the shell. `staff.html` sidebar:

```html
<p class="shell-role">Department staff</p>
<nav class="shell-nav-wrap" aria-label="Department inbox">
  <ul class="shell-nav">
    <li class="shell-group">Inbox</li>
    <li>
      <button
        type="button"
        class="shell-link"
        data-filter-for="staff-filter"
        data-filter-value="all"
      >
        All routed issues
      </button>
    </li>
    <li>
      <button
        type="button"
        class="shell-link"
        data-filter-for="staff-filter"
        data-filter-value="unaccepted"
      >
        Not accepted internally
      </button>
    </li>
    <li>
      <button
        type="button"
        class="shell-link"
        data-filter-for="staff-filter"
        data-filter-value="unassigned"
      >
        Unassigned
      </button>
    </li>
    <li>
      <button
        type="button"
        class="shell-link"
        data-filter-for="staff-filter"
        data-filter-value="awaiting_recipient"
      >
        No recipient acknowledgment
      </button>
    </li>
  </ul>
</nav>
<div class="shell-footer">
  <p class="shell-account" id="shell-account"></p>
  <a class="shell-quiet" href="/team.html">Switch role</a>
  <button type="button" id="staff-signout" class="shell-signout" hidden>Sign out</button>
</div>
```

`reviewer.html` is the same shape with role "Reviewer", group "Review queue", one button per `#kind-filter` option (same values and labels as the `<option>`s), and `reviewer-signout`. `<main>` gains `class="shell-main"`; the filter `<select>`'s field wrapper gains `class="… shell-replaced"` (hidden at every width — the sidebar is the control; the select stays for the scripts).

- [ ] **Step 2: Script wiring.** In both mains: `import { mountShell, wireFilterLinks } from "./shell.ts"; const shell = mountShell(); wireFilterLinks();`. Where the sign-out button's `hidden` is set from `authenticated`, also call `shell.setSignedIn(authenticated, <identity label from the session payload, or the role name>)`.

- [ ] **Step 3: CSS.** Add `<link rel="stylesheet" href="/shell.css" />` last in both heads. In `reviewer.css` delete the `.reviewer-header` rules and add `.shell-replaced { display: none !important; }`.

- [ ] **Step 4: Run** `npm run typecheck && node --test apps/web/src/*.test.ts` — expect PASS.

- [ ] **Step 5: Commit** (only if asked) `feat(web): department and reviewer dashboards`.

---

### Task 7: Supervisor dashboards (oversight, district dashboard, compare)

**Files:**

- Modify: `apps/web/public/supervisor.html`, `dashboard.html`, `compare.html`, `apps/web/src/supervisor-main.ts`, `dashboard-main.ts`, `compare-main.ts`

- [ ] **Step 1: One sidebar, three pages:**

```html
<p class="shell-role">Supervisor</p>
<nav class="shell-nav-wrap" aria-label="Supervisor tools">
  <ul class="shell-nav">
    <li class="shell-group">Oversight</li>
    <li><a class="shell-link" href="/supervisor.html">Oversight queues</a></li>
    <li>
      <a class="shell-link" href="/supervisor.html#durability-heading">Resolution durability</a>
    </li>
    <li class="shell-group">District</li>
    <li><a class="shell-link" href="/dashboard.html">District dashboard</a></li>
    <li><a class="shell-link" href="/compare.html">Compare policies</a></li>
  </ul>
</nav>
<div class="shell-footer">
  <p class="shell-account" id="shell-account"></p>
  <a class="shell-quiet" href="/team.html">Switch role</a>
  <button type="button" id="…-signout" class="shell-signout" hidden>Sign out</button>
</div>
```

Each page marks its own link `aria-current="page"`. On `supervisor.html` the six `#queue-filter` options additionally appear as filter buttons under "Oversight queues" (`data-filter-for="queue-filter"`), and its select wrapper gets `shell-replaced`. The sign-out ids stay `supervisor-signout`, `dashboard-signout`, `compare-signout`.

- [ ] **Step 2: Script wiring** as Task 6 Step 2 in all three mains (`wireFilterLinks()` only matters on the supervisor page but is harmless elsewhere).

- [ ] **Step 3: CSS** — `shell.css` link last in each head.

- [ ] **Step 4: Run** `npm run typecheck && node --test apps/web/src/*.test.ts` — expect PASS.

- [ ] **Step 5: Commit** (only if asked) `feat(web): supervisor dashboards`.

---

### Task 8: Typography pass

**Files:**

- Modify: `apps/web/public/reviewer.css`, `staff.css`, `supervisor.css`, `dashboard.css`, `compare.css`, `app.css`

- [ ] **Step 1:** For every `font-family: var(--font-display)` in these files, read the rule's `font-size`. Below `1.75rem` (eyebrows, labels, chips, small figures) → `var(--font-label)`, keeping uppercase and tracking. At or above → `var(--font-headline)`.
- [ ] **Step 2:** `h1` on every dashboard page renders in `--font-headline` (from `shell.css`); h2/h3 are Inter 600 with `letter-spacing: -0.01em`.
- [ ] **Step 3: Run** `npm run check` — expect exit 0.
- [ ] **Step 4: Commit** (only if asked) `style(web): Signal typography across dashboards`.

---

### Task 9: Build and verify in the browser

- [ ] **Step 1:** `npm run build:web` — expect no errors.
- [ ] **Step 2:** With the dev server on :3000, walk through at desktop width and at 375 px:
  - `signin.html` shows two cards only; Residents → `app.html`; Staff → `team.html`.
  - Resident: account picker → sidebar with four items; each switches the view and the h1; the back button returns to the previous view; "Open details" from Your reports lands in Problems nearby; language switch translates the sidebar; Sign out returns to the picker.
  - Phone width: the menu button opens the drawer, Tab stays inside, Escape closes and returns focus to the button.
  - Staff: each role → accounts → lands on its dashboard already signed in; sidebar filters change the list; Switch role returns to `team.html`; department staff see no reviewer or supervisor links.
  - Light and dark schemes both render correctly.
- [ ] **Step 3:** `npm run check` — expect exit 0.
