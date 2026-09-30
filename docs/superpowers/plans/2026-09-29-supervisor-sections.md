# Supervisor Dashboard in Three Parts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `supervisor.html` into Overview, Waiting issues and Resolution durability, switched from the sidebar, with compact issue cards.

**Architecture:** A pure module parses the hash into `{ view, queue }`; `supervisor-main.ts` applies it through the existing shell (`shell.showView`) and its own `filter` variable. Markup groups the existing ids into three `[data-view]` regions under one scope bar.

**Tech Stack:** Vanilla TypeScript, `node:test`, plain CSS.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-09-29-supervisor-sections-design.md`.
- No server change; every element id `supervisor-main.ts` uses stays except `queue-filter`, which is removed.
- No inline styles or scripts (CSP). Headings h1 → h2 → h3 in every part.
- Durability wording, refusals and notes are unchanged.

---

### Task 1: Hash parsing

**Files:**

- Create: `apps/web/src/supervisor-sections.ts`, `apps/web/src/supervisor-sections.test.ts`

**Interfaces:**

- Produces: `SUPERVISOR_VIEWS`, `type SupervisorView = "overview" | "queues" | "durability"`, `SUPERVISOR_VIEW_TITLES: Record<SupervisorView, string>`, `parseSupervisorHash(hash: string): { view: SupervisorView; queue: SupervisorQueueId | "all" }`, `supervisorHash(view, queue): string`.

- [ ] **Step 1: Failing test**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSupervisorHash, supervisorHash } from "./supervisor-sections.ts";

test("each part and each queue has an address", () => {
  assert.deepEqual(parseSupervisorHash("#overview"), { view: "overview", queue: "all" });
  assert.deepEqual(parseSupervisorHash("#queues"), { view: "queues", queue: "all" });
  assert.deepEqual(parseSupervisorHash("#queues/overdue"), { view: "queues", queue: "overdue" });
  assert.deepEqual(parseSupervisorHash("#durability"), { view: "durability", queue: "all" });
});

test("anything unrecognised lands on the overview or on every queue, never on nothing", () => {
  assert.deepEqual(parseSupervisorHash(""), { view: "overview", queue: "all" });
  assert.deepEqual(parseSupervisorHash("#admin"), { view: "overview", queue: "all" });
  assert.deepEqual(parseSupervisorHash("#queues/bogus"), { view: "queues", queue: "all" });
});

test("the old in-page anchor still opens durability", () => {
  assert.deepEqual(parseSupervisorHash("#durability-heading"), {
    view: "durability",
    queue: "all",
  });
});

test("addresses round-trip", () => {
  assert.equal(supervisorHash("queues", "reopened"), "#queues/reopened");
  assert.equal(supervisorHash("queues", "all"), "#queues");
  assert.equal(supervisorHash("durability", "overdue"), "#durability");
});
```

- [ ] **Step 2:** `node --test apps/web/src/supervisor-sections.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement** (see the module in Task 1 of the commit; keys above).
- [ ] **Step 4:** rerun → PASS.

### Task 2: Markup

**Files:** Modify `apps/web/public/supervisor.html`, `dashboard.html`, `compare.html`.

- [ ] Sidebar (supervisor.html): `Oversight` group → `#overview` (data-view-link), `#queues` "Waiting issues" + `<span class="shell-count" id="nav-count-all">`, nested `<ul class="shell-subnav">` with six `#queues/<id>` links (`data-queue-link`, count spans `nav-count-<id>`), `#durability` (data-view-link); then District links.
- [ ] dashboard/compare: durability link → `/supervisor.html#durability`; add `/supervisor.html#overview` as "Overview".
- [ ] Workspace: `.scope-bar` (role, jurisdiction select, `as-of`, `refresh-queues`); `[data-view="overview"]` with h2 "What is waiting", five `<a class="overview-tile" href="#queues/<id>">` holding `count-<id>`, h2 "Did the work last?" with `<a class="overview-durability" href="#durability"><span id="overview-durability-line">`; `[data-view="queues" hidden]` with intro paragraph, h2 `supervisor-workspace-heading`, `queue-bound-note`, both notes, map, list; `[data-view="durability" hidden]` with the durability panel (refresh, preamble, h2 "Units that can be told apart" + concerns, h2 "Every signal" + signals, ranking note, limits). Remove `queue-filter` label.
- [ ] `h1` gets `id="supervisor-title" tabindex="-1"`.

### Task 3: Script

**Files:** Modify `apps/web/src/supervisor-main.ts`, `apps/web/public/supervisor.css`, `apps/web/public/shell.css`.

- [ ] `applyHash()`: parse; set `filter`; `shell.showView(view)`; mark `[data-queue-link]` and un-mark the parent when a queue is chosen; set h1 text; `render()`. Wire `hashchange`; call after sign-in.
- [ ] `render()`: set `nav-count-*` (all = issues in any queue) and the queue heading.
- [ ] `renderDurability()`: set `overview-durability-line`; concern/signal headings h4 → h3.
- [ ] `issueCard()`: facts + reasons into one `<details>` "Why is this here?"; override field/days/error/actions into `<details class="card-override">` "Change this issue's clock".
- [ ] Remove the `queue-filter` listener and `wireFilterLinks` import.
- [ ] CSS: `.scope-bar`, `.overview-tiles`, `.overview-tile`, `.overview-durability`, `.shell-subnav`, `.shell-count`, `.card-override`.

### Task 4: Verify

- [ ] `npm run check` → exit 0; `npm run build:web`.
- [ ] Browser: sign in as supervisor → Overview; each tile and sidebar queue opens its list with the right count and heading; back/forward; Durability view; folded override saves; dashboard/compare links reach durability; phone width.
