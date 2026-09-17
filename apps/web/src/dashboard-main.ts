/**
 * District dashboard controller (roadmap V039).
 *
 * Reads only. The sign-in is the V036 supervisor flow reused unchanged, so a
 * supervisor who is already signed in arrives here signed in and no sixth role
 * had to be invented for a screen that needs exactly what they already hold.
 *
 * Two decisions worth stating, because both are visible in the DOM this file
 * builds. Every cell is a `<button>` when its records can be opened and a
 * `<span>` when they cannot — a control that looks operable and refuses is
 * worse than one that was never offered. And the three banners are written
 * before the table, not after it, because a reader who has scrolled past the
 * numbers has already taken them.
 */

import { SupervisorApiClient } from "./supervisor-api.ts";
import {
  DashboardApiClient,
  type DashboardIssueDetail,
  type DashboardIssueRow,
} from "./dashboard-api.ts";
import {
  CONTEXT_KIND_LABELS,
  EVIDENCE_LABELS,
  STATE_LABELS,
  byWard,
  categoriesOf,
  categoryLabel,
  contextByWard,
  contextFigure,
  contextImportBanner,
  coverageBanner,
  figure,
  freshnessBanner,
  measureText,
  reconciliationBanner,
  untrackedOf,
  type Banner,
  type DashboardCell,
  type DashboardPayload,
} from "./dashboard-view.ts";

const auth = new SupervisorApiClient();
const api = new DashboardApiClient();
let payload: DashboardPayload | undefined;

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`missing element: ${id}`);
  return node as T;
};

const announce = (message: string): void => {
  el("dashboard-live").textContent = message;
};

const showError = (message: string): void => {
  const error = el("dashboard-error");
  error.hidden = false;
  error.textContent = message;
  error.focus();
};

const clearError = (): void => {
  const error = el("dashboard-error");
  error.hidden = true;
  error.textContent = "";
};

const element = (tag: string, className?: string, text?: string): HTMLElement => {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const formatTime = (iso: string | null | undefined): string =>
  iso === null || iso === undefined ? "—" : new Date(iso).toLocaleString("en-IN");

// ---------------------------------------------------------------------------
// Banners
// ---------------------------------------------------------------------------

const bannerNode = (banner: Banner): HTMLElement => {
  const aside = element("aside", `dashboard-banner tone-${banner.tone}`);
  aside.append(
    element("strong", undefined, banner.heading),
    element("p", undefined, banner.detail),
  );
  return aside;
};

const renderBanners = (data: DashboardPayload): void => {
  const host = el("dashboard-banners");
  host.replaceChildren(
    bannerNode(reconciliationBanner(data)),
    bannerNode(freshnessBanner(data)),
    bannerNode(coverageBanner(data)),
  );
  el("dashboard-as-of").textContent =
    `Read at ${formatTime(data.asOf)} · summary last rebuilt ${formatTime(data.summary.lastRebuildAt)} · ${data.note}`;
};

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

const headerCell = (text: string, scope: "col" | "row"): HTMLElement => {
  const cell = element("th", undefined, text);
  cell.setAttribute("scope", scope);
  return cell;
};

/**
 * One cell.
 *
 * A projected cell with reports in it becomes a button that opens its records.
 * A projected zero and a `no_data` cell become plain text: there is nothing
 * behind either to open, and offering a control that refuses would teach a
 * reader to distrust the ones that work.
 */
const tableCell = (cell: DashboardCell): HTMLElement => {
  const shown = figure(cell);
  const container = element("td", `cell tone-${shown.tone}`);
  if (cell.coverage === "projected" && cell.issueCount > 0 && cell.drillDownAvailable) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cell-link";
    button.textContent = shown.text;
    button.title = shown.description;
    button.setAttribute("aria-label", `${shown.description} Open the reports behind this figure.`);
    button.addEventListener("click", () => {
      void openCell(cell);
    });
    container.append(button);
    return container;
  }
  const span = element("span", "cell-figure", shown.text);
  span.title = shown.description;
  span.setAttribute("aria-label", shown.description);
  container.append(span);
  return container;
};

const renderTable = (data: DashboardPayload): void => {
  const categories = categoriesOf(data);
  const head = el("dashboard-table-head");
  const headRow = element("tr");
  headRow.append(headerCell("Ward", "col"));
  for (const category of categories) headRow.append(headerCell(categoryLabel(category), "col"));
  headRow.append(headerCell("Other categories", "col"));
  headRow.append(headerCell("Ward total", "col"));
  head.replaceChildren(headRow);

  const body = el("dashboard-table-body");
  const rows: HTMLElement[] = [];
  for (const ward of byWard(data)) {
    const row = element("tr");
    if (!ward.hasAnyData) row.classList.add("ward-no-data");
    row.append(headerCell(ward.jurisdictionLabel, "row"));
    for (const category of categories) {
      const cell = ward.cells.find((item) => item.category === category);
      row.append(
        cell === undefined ? element("td", "cell tone-absent", "No data") : tableCell(cell),
      );
    }
    row.append(element("td", "cell", String(ward.untrackedTotal)));
    row.append(element("td", "cell cell-total", String(ward.total)));
    rows.push(row);
  }
  body.replaceChildren(...rows);
};

const renderUntracked = (data: DashboardPayload): void => {
  const untracked = untrackedOf(data);
  const section = el("untracked-section");
  section.hidden = untracked.length === 0;
  if (untracked.length === 0) return;
  el("untracked-summary").textContent =
    `Show the ${String(untracked.length)} untracked category group(s)`;
  const host = el("untracked-list");
  host.replaceChildren(
    ...untracked.map((cell) => {
      const row = element("div", "untracked-row");
      row.append(
        element("span", "untracked-category", cell.category),
        element("span", "untracked-ward", cell.jurisdictionLabel),
        element("span", "untracked-count", `${String(cell.issueCount)} report(s)`),
      );
      return row;
    }),
  );
};

// ---------------------------------------------------------------------------
// Context, with its lineage (V040)
// ---------------------------------------------------------------------------

/**
 * One context figure.
 *
 * `contextFigure` returns nothing for a value that could not carry a lineage
 * sentence, and that is the only branch here: a value with no source is not
 * rendered with a caveat, it is not rendered. The lineage is written into the
 * card rather than into a tooltip, because a claim a reader has to hover to
 * find is a claim the page did not make.
 */
const contextCard = (value: DashboardPayload["context"][number]): HTMLElement | undefined => {
  const shown = contextFigure(value);
  if (shown === undefined) return undefined;
  const card = element("article", `review-card context-card tone-${shown.tone}`);
  card.append(
    element("span", "kind-label", CONTEXT_KIND_LABELS[value.kind].label),
    element("p", "context-figure", shown.text),
  );
  if (shown.stale)
    card.append(element("span", "context-stale", "Older than this dataset's currency window"));
  card.append(element("p", "context-lineage", shown.lineage));
  return card;
};

const renderContext = (data: DashboardPayload): void => {
  el("context-banner").replaceChildren(bannerNode(contextImportBanner(data)));

  const wardLabel = new Map(
    data.cells.map((cell) => [cell.jurisdictionKey, cell.jurisdictionLabel] as const),
  );
  const groups = contextByWard(data);
  const host = el("context-list");
  const nodes: HTMLElement[] = [];
  for (const group of groups) {
    const section = element("section", "context-ward");
    section.append(
      element(
        "h4",
        "context-ward-heading",
        wardLabel.get(group.jurisdictionId) ?? group.jurisdictionId,
      ),
    );
    const cards = element("div", "context-cards");
    for (const value of group.values) {
      const card = contextCard(value);
      if (card !== undefined) cards.append(card);
    }
    section.append(cards);
    nodes.push(section);
  }
  host.replaceChildren(...nodes);

  const rejections = data.contextImports.flatMap((run) =>
    run.rejections.map((rejection) => ({ ...rejection, datasetId: run.datasetId })),
  );
  const details = el<HTMLDetailsElement>("context-rejections");
  details.hidden = rejections.length === 0;
  if (rejections.length === 0) return;
  el("context-rejections-summary").textContent =
    `Show the ${String(rejections.length)} refused row(s)`;
  el("context-rejection-list").replaceChildren(
    ...rejections.map((rejection) => {
      const row = element("div", "untracked-row");
      row.append(
        element("span", "untracked-category", rejection.code),
        element(
          "span",
          "untracked-ward",
          `${rejection.datasetId} row ${String(rejection.rowIndex)}`,
        ),
      );
      row.append(element("p", "context-lineage", rejection.detail));
      return row;
    }),
  );
};

// ---------------------------------------------------------------------------
// Measures, with their definitions
// ---------------------------------------------------------------------------

const renderMetrics = (data: DashboardPayload): void => {
  const host = el("dashboard-metrics");
  host.replaceChildren(
    ...data.metrics.map((metric) => {
      const card = element("article", "review-card metric-card");
      card.append(
        element("span", "kind-label", metric.id),
        element("h4", undefined, metric.title),
        element("p", "metric-value", measureText(metric.value, metric.unit)),
        element("p", "metric-population", metric.populationNote),
      );

      const definition = element("details", "ordering-detail");
      definition.append(element("summary", undefined, "What exactly is this measuring?"));
      const facts = element("dl", "staff-facts");
      for (const [term, detail] of [
        ["Meaning", metric.definition.meaning],
        ["Numerator", metric.definition.numerator],
        [
          "Denominator",
          metric.definition.denominator.of ??
            `None — ${metric.definition.denominator.why ?? "this is a count"}`,
        ],
        ["When it is not known", metric.definition.missingData],
      ] as const) {
        const group = element("div");
        group.append(element("dt", undefined, term), element("dd", undefined, detail));
        facts.append(group);
      }
      definition.append(facts);
      for (const disclosure of metric.definition.disclosures) {
        definition.append(element("p", "metric-disclosure", disclosure));
      }
      card.append(definition);
      return card;
    }),
  );
};

// ---------------------------------------------------------------------------
// Drill-down
// ---------------------------------------------------------------------------

const evidenceNode = (detail: DashboardIssueDetail): HTMLElement => {
  const wrapper = element("div", "evidence-block");
  wrapper.append(element("p", "evidence-note", detail.evidenceNote));
  if (detail.evidence.length === 0) {
    wrapper.append(element("p", "queue-note", "No evidence is attached to this report."));
    return wrapper;
  }
  const list = element("ul", "evidence-list");
  for (const item of detail.evidence) {
    const entry = element("li");
    entry.append(
      element("span", "evidence-kind", item.mediaType),
      element("span", "evidence-availability", EVIDENCE_LABELS[item.availability]),
    );
    if (item.availability === "approved_derivative" && item.derivativeReference !== null) {
      const image = document.createElement("img");
      image.className = "evidence-thumb";
      image.loading = "lazy";
      image.alt = `Redacted copy of ${item.mediaType} evidence for ${detail.publicReference}`;
      // The same public derivative route the citizen app uses. It serves only
      // the redaction-approved tree and never the private original.
      image.src = `/v1/media/${item.derivativeReference}`;
      entry.append(image);
    }
    list.append(entry);
  }
  wrapper.append(list);
  return wrapper;
};

const issueCard = (row: DashboardIssueRow): HTMLElement => {
  const card = element("article", "review-card");
  const top = element("div", "review-card-top");
  top.append(
    element("span", "kind-label", STATE_LABELS[row.state]),
    element("span", "age-label", `${String(Math.round(row.ageHours / 24))} days old`),
  );
  card.append(top, element("h4", undefined, row.publicReference));

  const facts = element("dl", "staff-facts");
  for (const [term, detail] of [
    ["Opened", formatTime(row.openedAt)],
    ["Counted demo participants", String(row.countedParticipants)],
    ["Evidence attached", String(row.activeEvidenceLinks)],
  ] as const) {
    const group = element("div");
    group.append(element("dt", undefined, term), element("dd", undefined, detail));
    facts.append(group);
  }
  card.append(facts);

  const open = document.createElement("button");
  open.type = "button";
  open.className = "review-action";
  open.textContent = "Open the evidence";
  open.addEventListener("click", () => {
    void (async () => {
      const result = await api.issue(row.publicReference);
      if (!result.ok) {
        showError(result.message);
        return;
      }
      open.hidden = true;
      card.append(evidenceNode(result.value));
      announce(`Evidence for ${row.publicReference} loaded.`);
    })();
  });
  card.append(open);
  return card;
};

const openCell = async (cell: DashboardCell): Promise<void> => {
  clearError();
  const result = await api.cellIssues(cell);
  if (!result.ok) {
    showError(result.message);
    return;
  }
  const panel = el("drilldown");
  panel.hidden = false;
  el("drilldown-summary").textContent =
    `${cell.jurisdictionLabel} · ${categoryLabel(cell.category)} — ${String(result.value.issues.length)} report(s). These are the records the figure you selected counts.`;
  el("drilldown-list").replaceChildren(...result.value.issues.map(issueCard));
  el("drilldown-heading").focus();
  announce(`${String(result.value.issues.length)} supporting record(s) listed.`);
};

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

const render = (data: DashboardPayload): void => {
  payload = data;
  renderBanners(data);
  renderTable(data);
  renderUntracked(data);
  renderContext(data);
  renderMetrics(data);
};

const load = async (): Promise<void> => {
  const result = await api.overview();
  if (!result.ok) {
    showError(result.message);
    return;
  }
  clearError();
  render(result.value);
  announce("District dashboard loaded.");
};

const showWorkspace = async (role: string | undefined): Promise<void> => {
  el("dashboard-login").hidden = true;
  el("dashboard-workspace").hidden = false;
  el("dashboard-signout").hidden = false;
  el("dashboard-role").textContent =
    role === undefined ? "Signed in" : `Signed in as ${role.replace(/_/g, " ")}`;
  await load();
};

const renderLoginChoices = async (): Promise<void> => {
  const capabilities = await auth.capabilities();
  const host = el("dashboard-login-choices");
  if (!capabilities.ok) {
    host.replaceChildren(element("p", "queue-note", capabilities.message));
    return;
  }
  host.replaceChildren(
    ...capabilities.value.demo_principals.map((principal) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "login-choice";
      button.textContent = principal.label;
      button.addEventListener("click", () => {
        void (async () => {
          button.disabled = true;
          const result = await auth.login(principal.credential);
          button.disabled = false;
          if (!result.ok) {
            showError(result.message);
            return;
          }
          await showWorkspace(result.value.role);
        })();
      });
      return button;
    }),
  );
};

el("refresh-dashboard").addEventListener("click", () => {
  void load();
});

el("close-drilldown").addEventListener("click", () => {
  el("drilldown").hidden = true;
  el("dashboard-workspace-heading").focus();
});

el("dashboard-signout").addEventListener("click", () => {
  void (async () => {
    await auth.logout();
    el("dashboard-workspace").hidden = true;
    el("dashboard-signout").hidden = true;
    el("dashboard-login").hidden = false;
    payload = undefined;
    await renderLoginChoices();
    announce("Signed out.");
  })();
});

void (async () => {
  await renderLoginChoices();
  const session = await auth.session();
  if (session.ok && session.value.authenticated) {
    await showWorkspace(session.value.role);
  }
})();

/** Exposed for the browser verification pass, which reads what was rendered. */
export const currentPayload = (): DashboardPayload | undefined => payload;
