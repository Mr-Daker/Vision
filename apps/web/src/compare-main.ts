/**
 * Comparison workspace controller (roadmap V043).
 *
 * Read-only, on the V036 supervisor session like the district dashboard.
 *
 * Two decisions worth stating because both are visible in the DOM this builds.
 * The **policy version is re-rendered on every pass**, including when only the
 * scenario changes, so a reviewer switching weightings is never looking at a
 * page that has quietly changed policy underneath them. And the **attribution
 * note is written into the project block**, not into a tooltip or a footer: a
 * caveat a reader has to go looking for is a caveat the page did not make.
 */

import { SupervisorApiClient } from "./supervisor-api.ts";
import type { ApiResult } from "./api.ts";
import {
  ASSUMPTION_HEADINGS,
  ASSUMPTION_TONES,
  OUTCOME_RELATION_LABELS,
  OUTCOME_TONES,
  STABILITY_LABELS,
  STABILITY_TONES,
  UNSEARCHED_REGISTER_NOTE,
  assumptionsByScrutiny,
  factorComparison,
  positionText,
  projectSummary,
  rankUnder,
  separationSummary,
  type ComparisonCandidateView,
  type ComparisonPayload,
  type LinkedProjectView,
} from "./compare-view.ts";

const auth = new SupervisorApiClient();
let payload: ComparisonPayload | undefined;
let scenario = "";

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`missing element: ${id}`);
  return node as T;
};

const element = (tag: string, className?: string, text?: string): HTMLElement => {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const announce = (message: string): void => {
  el("compare-live").textContent = message;
};

const showError = (message: string): void => {
  const error = el("compare-error");
  error.hidden = false;
  error.textContent = message;
  error.focus();
};

const fetchComparison = async (): Promise<ApiResult<ComparisonPayload>> => {
  let response: Response;
  try {
    response = await fetch("/v1/dashboard/comparison?detail=8", {
      method: "GET",
      credentials: "same-origin",
    });
  } catch {
    return {
      ok: false,
      status: 0,
      code: "offline",
      message: "The request did not reach the server.",
      issues: [],
      offline: true,
    };
  }
  const text = await response.text();
  let body: unknown;
  try {
    body = text.length === 0 ? undefined : JSON.parse(text);
  } catch {
    body = undefined;
  }
  if (!response.ok) {
    const envelope = body as { error?: { code?: unknown; message?: unknown } } | undefined;
    return {
      ok: false,
      status: response.status,
      code: String(envelope?.error?.code ?? "unknown"),
      message: String(envelope?.error?.message ?? "The request was refused."),
      issues: [],
      offline: false,
    };
  }
  return { ok: true, status: response.status, value: body as ComparisonPayload };
};

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

const projectBlock = (project: LinkedProjectView): HTMLElement => {
  const block = element("div", "project-block");
  block.append(
    element("span", "project-heading", "Linked sanctioned project"),
    element("p", "context-lineage", projectSummary(project)),
  );

  if (project.outcomes.length > 0) {
    const list = element("ul", "outcome-list");
    for (const outcome of project.outcomes) {
      const row = element("li", `outcome-row tone-${OUTCOME_TONES[outcome.relation]}`);
      row.append(
        element("span", "outcome-when", OUTCOME_RELATION_LABELS[outcome.relation]),
        element("span", "outcome-what", outcome.description),
      );
      row.title = outcome.explanation;
      list.append(row);
    }
    block.append(list);
  }

  // Always, and beside the outcomes rather than under the page.
  block.append(element("p", "attribution-note", project.attributionNote));
  return block;
};

const candidateCard = (candidate: ComparisonCandidateView): HTMLElement => {
  const card = element("article", "review-card");
  const top = element("div", "review-card-top");
  const position = element("span", "position-range", positionText(candidate.placement));
  const stability = element(
    "span",
    `stability-label tone-${STABILITY_TONES[candidate.placement.stability]}`,
    STABILITY_LABELS[candidate.placement.stability],
  );
  top.append(position, stability);
  card.append(top, element("h4", undefined, candidate.label));
  card.append(element("p", "context-lineage", candidate.placement.explanation));

  // Where this candidate sits under each weighting, so a reviewer can see which
  // scenario produced which position rather than inferring it.
  const scenarios = element("p", "scenario-rank");
  scenarios.textContent = (payload?.weightingIds ?? [])
    .map((id) => `${id}: ${rankUnder(candidate.placement, id)}`)
    .join(" · ");
  card.append(scenarios);

  const facts = element("dl", "staff-facts");
  for (const factor of candidate.placement.factors) {
    const group = element("div");
    const value =
      factor.contribution === null
        ? `not counted — ${factor.status.replace(/_/g, " ")}`
        : `${String(factor.contribution)} at weight ${String(factor.appliedWeight)}`;
    group.append(
      element("dt", undefined, factor.factor.replace(/_/g, " ")),
      element("dd", undefined, value),
    );
    facts.append(group);
  }
  card.append(facts);

  const why = element("details", "ordering-detail");
  why.append(element("summary", undefined, "What each factor means here"));
  const reasons = element("ul");
  for (const factor of candidate.placement.factors) {
    reasons.append(
      element("li", undefined, `${factor.factor.replace(/_/g, " ")}: ${factor.explanation}`),
    );
  }
  why.append(reasons);
  card.append(why);

  if (candidate.context.length > 0) {
    const context = element("details", "ordering-detail");
    context.append(element("summary", undefined, "Source-backed context for this ward"));
    const list = element("ul");
    for (const value of candidate.context) {
      list.append(element("li", undefined, value.lineage));
    }
    context.append(list);
    card.append(context);
  }

  if (candidate.projectRegisterUnsearched) {
    card.append(element("p", "attribution-note", UNSEARCHED_REGISTER_NOTE));
  }
  for (const project of candidate.projects) card.append(projectBlock(project));

  return card;
};

// ---------------------------------------------------------------------------
// Separation
// ---------------------------------------------------------------------------

const renderSeparation = (data: ComparisonPayload): void => {
  const left = data.candidates.find(
    (candidate) => candidate.candidateId === el<HTMLSelectElement>("left-select").value,
  );
  const right = data.candidates.find(
    (candidate) => candidate.candidateId === el<HTMLSelectElement>("right-select").value,
  );
  const host = el("separation");
  const head = el("separation-head");
  const body = el("separation-body");

  if (left === undefined || right === undefined || left.candidateId === right.candidateId) {
    host.replaceChildren(
      element("p", "queue-note", "Choose two different candidates to see what separates them."),
    );
    head.replaceChildren();
    body.replaceChildren();
    return;
  }

  const differences = factorComparison(left.placement, right.placement);
  const banner = element("aside", "dashboard-banner tone-neutral");
  banner.append(
    element("strong", undefined, `${left.label} against ${right.label}`),
    element("p", undefined, separationSummary(left.placement, right.placement, differences)),
  );
  host.replaceChildren(banner);

  const headRow = element("tr");
  for (const [text, scope] of [
    ["Factor", "col"],
    [left.label, "col"],
    [right.label, "col"],
    ["Weighted difference", "col"],
  ] as const) {
    const cell = element("th", undefined, text);
    cell.setAttribute("scope", scope);
    headRow.append(cell);
  }
  head.replaceChildren(headRow);

  body.replaceChildren(
    ...differences.map((difference) => {
      const row = element("tr");
      const name = element("th", "factor-name", difference.factor.replace(/_/g, " "));
      name.setAttribute("scope", "row");
      const show = (value: number | null): string => (value === null ? "no value" : String(value));
      row.append(
        name,
        element("td", "cell", show(difference.leftContribution)),
        element("td", "cell", show(difference.rightContribution)),
        element(
          "td",
          `cell ${difference.separates ? "separates" : "not-separating"}`,
          difference.separates
            ? `${difference.weightedDifference > 0 ? "+" : ""}${String(difference.weightedDifference)}`
            : "—",
        ),
      );
      row.title = difference.explanation;
      return row;
    }),
  );
};

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const fillSelect = (id: string, data: ComparisonPayload, index: number): void => {
  const select = el<HTMLSelectElement>(id);
  const previous = select.value;
  select.replaceChildren(
    ...data.candidates.map((candidate) => {
      const option = document.createElement("option");
      option.value = candidate.candidateId;
      option.textContent = `${candidate.label} (${positionText(candidate.placement)})`;
      return option;
    }),
  );
  const fallback = data.candidates[index]?.candidateId ?? "";
  select.value = data.candidates.some((candidate) => candidate.candidateId === previous)
    ? previous
    : fallback;
};

const render = (data: ComparisonPayload): void => {
  payload = data;

  // Re-stated on every render, scenario changes included: a reviewer switching
  // weightings must never be looking at a page whose policy changed underneath.
  el("compare-policy").textContent =
    `Policy ${data.policyVersion} · ${String(data.weightingIds.length)} weightings`;
  el("compare-scope").textContent =
    `${String(data.candidateCount)} open report(s) ordered at ${new Date(data.asOf).toLocaleString("en-IN")}` +
    (data.exhaustive
      ? ""
      : " — the candidate limit was reached, so this is not every open report") +
    ` · ${data.note}`;

  const scenarioSelect = el<HTMLSelectElement>("scenario-select");
  if (scenarioSelect.options.length !== data.weightingIds.length) {
    scenarioSelect.replaceChildren(
      ...data.weightingIds.map((id) => {
        const option = document.createElement("option");
        option.value = id;
        option.textContent = id;
        return option;
      }),
    );
  }
  if (scenario === "") scenario = data.weightingIds[0] ?? "";
  scenarioSelect.value = scenario;

  // The scenario reorders the list; it never changes a position's interval,
  // which is what the cards show.
  const ordered = [...data.candidates].sort((a, b) => {
    const left = rankUnder(a.placement, scenario);
    const right = rankUnder(b.placement, scenario);
    if (left === "not ranked") return 1;
    if (right === "not ranked") return -1;
    return Number(left) - Number(right);
  });
  el("candidate-list").replaceChildren(...ordered.map(candidateCard));

  fillSelect("left-select", data, 0);
  fillSelect("right-select", data, 1);
  renderSeparation(data);

  el("assumptions").replaceChildren(
    ...assumptionsByScrutiny(data).map((assumption) => {
      const block = element("div", `assumption tone-${ASSUMPTION_TONES[assumption.support]}`);
      block.append(
        element("span", "assumption-heading", ASSUMPTION_HEADINGS[assumption.support]),
        element("p", "assumption-statement", assumption.statement),
        element("p", "assumption-detail", assumption.detail),
      );
      return block;
    }),
  );

  el("compare-disclosures").replaceChildren(
    ...data.disclosures.map((disclosure) => element("li", undefined, disclosure)),
  );
};

const load = async (): Promise<void> => {
  const result = await fetchComparison();
  if (!result.ok) {
    showError(result.message);
    return;
  }
  el("compare-error").hidden = true;
  render(result.value);
  announce("Comparison loaded.");
};

const showWorkspace = async (): Promise<void> => {
  el("compare-login").hidden = true;
  el("compare-workspace").hidden = false;
  el("compare-signout").hidden = false;
  await load();
};

const renderLoginChoices = async (): Promise<void> => {
  const capabilities = await auth.capabilities();
  const host = el("compare-login-choices");
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
          await showWorkspace();
        })();
      });
      return button;
    }),
  );
};

el("refresh-compare").addEventListener("click", () => {
  void load();
});

el("scenario-select").addEventListener("change", () => {
  scenario = el<HTMLSelectElement>("scenario-select").value;
  if (payload !== undefined) render(payload);
  announce(`Scenario ${scenario} applied. The policy version is unchanged.`);
});

for (const id of ["left-select", "right-select"]) {
  el(id).addEventListener("change", () => {
    if (payload !== undefined) renderSeparation(payload);
  });
}

el("compare-signout").addEventListener("click", () => {
  void (async () => {
    await auth.logout();
    el("compare-workspace").hidden = true;
    el("compare-signout").hidden = true;
    el("compare-login").hidden = false;
    payload = undefined;
    await renderLoginChoices();
  })();
});

void (async () => {
  await renderLoginChoices();
  const session = await auth.session();
  if (session.ok && session.value.authenticated) await showWorkspace();
})();
