/**
 * Public Intelligence — page controller.
 *
 * Holds the one piece of state that matters (which node is in focus, under
 * which filters) and lets everything else derive from it. The hierarchy is
 * rebuilt whenever the filters change and the view animates between the old
 * and new picture; nothing is recomputed per frame.
 *
 * Browser history carries the focus id, so Back walks out of the hierarchy the
 * way a reader expects rather than leaving the page.
 */

import { applyFilters, compactNumber, hasActiveFilters, NO_FILTERS } from "./issue-aggregation.ts";
import { buildCountryHierarchy, nearestSurviving, pathTo, ROOT_ID } from "./hierarchy-data.ts";
import { HierarchyView } from "./hierarchy-view.ts";
import { renderIssueDetail } from "./issue-detail.ts";
import { renderRail } from "./intelligence-rail.ts";
import type {
  HierarchyNode,
  InfrastructureIssue,
  IntelligenceFilters,
  IssueSeverity,
} from "./intelligence.types.ts";

const DATA_URL = "/data/vision-demo-issues.json";

const byId = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`missing element: ${id}`);
  return node as T;
};

type Payload = { readonly synthetic: boolean; readonly issues: readonly InfrastructureIssue[] };

class IntelligencePage {
  #all: readonly InfrastructureIssue[] = [];
  #filters: IntelligenceFilters = NO_FILTERS;
  #root: HierarchyNode;
  #focusId = ROOT_ID;
  #openIssue: InfrastructureIssue | undefined;
  #view: HierarchyView | undefined;

  constructor() {
    this.#root = buildCountryHierarchy([]);
  }

  async start(): Promise<void> {
    const status = byId("stage-status");
    try {
      const response = await fetch(DATA_URL, { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
      const payload = (await response.json()) as Payload;
      this.#all = payload.issues;
    } catch {
      // A demonstration that silently shows an empty country is worse than one
      // that says it could not load.
      status.textContent = "The demonstration dataset could not be loaded.";
      status.hidden = false;
      byId("stage-loading").hidden = true;
      return;
    }

    byId("stage-loading").hidden = true;
    this.#view = new HierarchyView(byId("stage-graph"), {
      onActivate: (node) => this.#activate(node),
      onHover: (node) => this.#view?.emphasise(node?.id),
    });

    this.#wireFilters();
    this.#wireSearch();
    this.#wireGlobalKeys();

    window.addEventListener("popstate", (event) => {
      const state = event.state as { focus?: string } | null;
      this.#focusId = state?.focus ?? ROOT_ID;
      this.#closeDrawer();
      this.#render();
    });

    this.#rebuild();
    history.replaceState({ focus: this.#focusId }, "");
  }

  /** Rebuilds the hierarchy from the current filters, then redraws. */
  #rebuild(): void {
    const filtered = applyFilters(this.#all, this.#filters);
    this.#root = buildCountryHierarchy(filtered);
    // A filter can remove the node being looked at; walk up rather than
    // snapping home, which would lose the reader's place entirely.
    this.#focusId = nearestSurviving(this.#root, this.#focusId).id;
    this.#render();
  }

  #render(): void {
    const path = pathTo(this.#root, this.#focusId);
    const focus = path[path.length - 1] ?? this.#root;

    const empty = this.#root.issueCount === 0;
    byId("stage-empty").hidden = !empty;
    byId("stage-graph").hidden = empty;

    if (!empty) this.#view?.render(focus);
    renderRail(byId("rail"), focus);
    this.#renderBreadcrumb(path);
    this.#renderMobileList(focus);
    byId("filters-clear").hidden = !hasActiveFilters(this.#filters);
  }

  #activate(node: HierarchyNode): void {
    if (node.level === "issue" && node.issue !== undefined) {
      this.#openDrawer(node.issue);
      return;
    }
    if (node.id === this.#focusId) return;
    this.#focusId = node.id;
    history.pushState({ focus: node.id }, "");
    this.#render();
  }

  #goTo(id: string): void {
    this.#focusId = id;
    history.pushState({ focus: id }, "");
    this.#closeDrawer();
    this.#render();
  }

  // ── Breadcrumb ───────────────────────────────────────────────

  #renderBreadcrumb(path: readonly HierarchyNode[]): void {
    const host = byId("breadcrumb");
    const list = document.createElement("ol");
    list.className = "crumb-list";

    for (const [index, node] of path.entries()) {
      const item = document.createElement("li");
      item.className = "crumb-item";
      const last = index === path.length - 1;

      if (last) {
        const current = document.createElement("span");
        current.className = "crumb-current";
        current.setAttribute("aria-current", "location");
        current.textContent = node.label;
        item.append(current);
      } else {
        const link = document.createElement("button");
        link.type = "button";
        link.className = "crumb-link";
        link.textContent = node.label;
        link.addEventListener("click", () => this.#goTo(node.id));
        // Hovering a crumb hints at the ancestor it would return to.
        link.addEventListener("pointerenter", () => this.#view?.emphasise(node.id));
        link.addEventListener("pointerleave", () => this.#view?.emphasise(undefined));
        item.append(link);
      }
      list.append(item);
    }
    host.replaceChildren(list);
  }

  // ── Mobile: a list navigator rather than a shrunken graph ────

  #renderMobileList(focus: HierarchyNode): void {
    const host = byId("mobile-list");
    const frame = document.createDocumentFragment();

    const head = document.createElement("div");
    head.className = "ml-head";
    const title = document.createElement("h2");
    title.className = "ml-title";
    title.textContent = focus.label;
    const count = document.createElement("p");
    count.className = "ml-count";
    count.textContent = `${compactNumber(focus.issueCount)} ${focus.issueCount === 1 ? "issue" : "issues"}`;
    head.append(title, count);
    frame.append(head);

    for (const child of focus.children) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "ml-row";
      row.dataset["level"] = child.level;

      const name = document.createElement("span");
      name.className = "ml-row-name";
      name.textContent = child.issue === undefined ? child.label : child.label;

      const meta = document.createElement("span");
      meta.className = "ml-row-meta";
      meta.textContent =
        child.issue === undefined
          ? String(child.issueCount)
          : `${String(child.issue.citizenReportsCount)} reports`;

      // Severity shows as a bar rather than a colour word, so the row carries
      // the same encoding as the graph.
      const serious = child.criticalCount + child.highCount;
      const share = child.issueCount === 0 ? 0 : serious / child.issueCount;
      const gauge = document.createElement("span");
      gauge.className = "ml-row-gauge";
      const fill = document.createElement("span");
      fill.className = "ml-row-gauge-fill";
      fill.style.width = `${(share * 100).toFixed(0)}%`;
      gauge.append(fill);

      row.append(name, gauge, meta);
      row.setAttribute(
        "aria-label",
        `${child.label}, ${String(child.issueCount)} issues, ${String(child.criticalCount)} critical`,
      );
      row.addEventListener("click", () => this.#activate(child));
      frame.append(row);
    }

    host.replaceChildren(frame);
  }

  // ── Drawer ───────────────────────────────────────────────────

  #openDrawer(issue: InfrastructureIssue): void {
    this.#openIssue = issue;
    const related = this.#all.filter(
      (other) =>
        other.id !== issue.id &&
        issue.duplicateClusterId !== undefined &&
        other.duplicateClusterId === issue.duplicateClusterId,
    );
    renderIssueDetail(byId("drawer-body"), issue, related);
    const drawer = byId("drawer");
    drawer.hidden = false;
    // Next frame, so the transition has a start state to run from.
    requestAnimationFrame(() => drawer.classList.add("is-open"));
    byId<HTMLButtonElement>("drawer-close").focus();
  }

  #closeDrawer(): void {
    const drawer = byId("drawer");
    if (drawer.hidden) return;
    this.#openIssue = undefined;
    drawer.classList.remove("is-open");
    const hide = (): void => {
      drawer.hidden = true;
    };
    drawer.addEventListener("transitionend", hide, { once: true });
    window.setTimeout(hide, 500);
  }

  // ── Filters ──────────────────────────────────────────────────

  #wireFilters(): void {
    for (const button of document.querySelectorAll<HTMLButtonElement>("[data-severity]")) {
      button.addEventListener("click", () => {
        const value = button.dataset["severity"] as IssueSeverity | undefined;
        const next = new Set(this.#filters.severities);
        if (value === undefined) next.clear();
        else if (next.has(value)) next.delete(value);
        else next.add(value);
        this.#filters = { ...this.#filters, severities: next };
        this.#syncFilterButtons();
        this.#rebuild();
      });
    }

    for (const button of document.querySelectorAll<HTMLButtonElement>("[data-window]")) {
      button.addEventListener("click", () => {
        const raw = button.dataset["window"];
        const days = raw === undefined || raw === "all" ? undefined : Number(raw);
        this.#filters = { ...this.#filters, windowDays: days };
        this.#syncFilterButtons();
        this.#rebuild();
      });
    }

    byId("filters-clear").addEventListener("click", () => {
      this.#filters = NO_FILTERS;
      this.#syncFilterButtons();
      this.#rebuild();
    });

    byId("empty-clear").addEventListener("click", () => {
      this.#filters = NO_FILTERS;
      this.#syncFilterButtons();
      this.#rebuild();
    });
  }

  #syncFilterButtons(): void {
    for (const button of document.querySelectorAll<HTMLButtonElement>("[data-severity]")) {
      const value = button.dataset["severity"];
      const on =
        value === undefined
          ? this.#filters.severities.size === 0
          : this.#filters.severities.has(value as IssueSeverity);
      button.setAttribute("aria-pressed", String(on));
    }
    for (const button of document.querySelectorAll<HTMLButtonElement>("[data-window]")) {
      const raw = button.dataset["window"];
      const days = raw === undefined || raw === "all" ? undefined : Number(raw);
      button.setAttribute("aria-pressed", String(days === this.#filters.windowDays));
    }
  }

  // ── Search ───────────────────────────────────────────────────

  #wireSearch(): void {
    const input = byId<HTMLInputElement>("search-input");
    const results = byId("search-results");

    const close = (): void => {
      results.replaceChildren();
      results.hidden = true;
    };

    input.addEventListener("input", () => {
      const query = input.value.trim().toLowerCase();
      if (query.length < 2) {
        close();
        return;
      }

      const matches: { label: string; hint: string; id: string }[] = [];
      const walk = (node: HierarchyNode, trail: readonly string[]): void => {
        if (matches.length >= 8) return;
        const hay = node.issue?.id.toLowerCase() ?? node.label.toLowerCase();
        if (hay.includes(query) || node.label.toLowerCase().includes(query)) {
          matches.push({ label: node.label, hint: trail.join(" › "), id: node.id });
        }
        for (const child of node.children) walk(child, [...trail, node.label]);
      };
      walk(this.#root, []);

      results.replaceChildren(
        ...matches.map((match) => {
          const row = document.createElement("button");
          row.type = "button";
          row.className = "search-result";
          const label = document.createElement("span");
          label.className = "search-result-label";
          label.textContent = match.label;
          const hint = document.createElement("span");
          hint.className = "search-result-hint";
          hint.textContent = match.hint;
          row.append(label, hint);
          row.addEventListener("click", () => {
            input.value = "";
            close();
            this.#goTo(match.id);
          });
          return row;
        }),
      );
      results.hidden = matches.length === 0;
    });

    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        input.value = "";
        close();
        event.stopPropagation();
      }
    });
  }

  #wireGlobalKeys(): void {
    byId("drawer-close").addEventListener("click", () => this.#closeDrawer());
    byId("drawer-scrim").addEventListener("click", () => this.#closeDrawer());

    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      // Escape closes the drawer first, then walks up a level. Doing both at
      // once would jump two steps for one keypress.
      if (this.#openIssue !== undefined) {
        this.#closeDrawer();
        return;
      }
      const path = pathTo(this.#root, this.#focusId);
      const parent = path[path.length - 2];
      if (parent !== undefined) this.#goTo(parent.id);
    });
  }
}

const page = new IntelligencePage();
void page.start();
