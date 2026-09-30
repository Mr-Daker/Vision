/**
 * Supervisor workspace controller (roadmap V036).
 *
 * Mirrors the reviewer and department workspaces: a simulated sign-in, a
 * jurisdiction selector, and a worklist built from server-resolved rows. It
 * adds one write a supervisor alone may make — a reviewed override of the
 * ageing clock on a single issue, with a reason.
 *
 * Every alert on this screen says it was *recorded*, never that it was sent.
 * V036's acceptance clause requires internal demo alerts not to be presented
 * as notifications delivered to real officials, and the wording here is the
 * place that promise is kept or broken.
 */

import { SupervisorApiClient } from "./supervisor-api.ts";
import { mountShell } from "./shell.ts";
import {
  SIGN_IN_DID_NOT_STICK,
  confirmSignedIn,
  leaveToSignIn,
  sendToStaffDoor,
} from "./staff-door.ts";
import {
  parseSupervisorHash,
  SUPERVISOR_VIEW_TITLES,
  type SupervisorView,
} from "./supervisor-sections.ts";
import {
  figureText,
  panelPreamble,
  signalLabel,
  toDurabilityView,
  type DurabilityView,
} from "./durability-view.ts";
import {
  ALERT_LABELS,
  clockSummary,
  dayLabel,
  isOverridden,
  QUEUE_EXPLANATIONS,
  QUEUE_LABELS,
  toSupervisorQueueView,
  type SupervisorIssueRow,
  type SupervisorQueueId,
  type SupervisorQueueView,
} from "./supervisor-view.ts";
import { renderIssueOverviewMap, type IssueMapPoint } from "./issue-map.ts";

const api = new SupervisorApiClient();
const shell = mountShell();
let queues: SupervisorQueueView | undefined;
let durability: DurabilityView | undefined;
/** Which queue the Waiting issues part shows. Set from the hash, nowhere else. */
let filter: SupervisorQueueId | "all" = "all";
let view: SupervisorView = "overview";

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`missing element: ${id}`);
  return node as T;
};

const announce = (message: string): void => {
  el("supervisor-live").textContent = message;
};

const showError = (message: string): void => {
  const error = el("supervisor-error");
  error.hidden = false;
  error.textContent = message;
  error.focus();
};

const element = (tag: string, className?: string, text?: string): HTMLElement => {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const selectJurisdiction = (): HTMLSelectElement => el<HTMLSelectElement>("jurisdiction-select");

// "am"/"pm" in upper case: the facts lists capitalise every word (so a status
// like "work planned" reads well), which turned "10:30:00 am" into "10:30:00 Am".
const uppercaseMeridiem = (text: string): string =>
  text.replace(/\b([ap])m\b/i, (m) => m.toUpperCase());

const formatTime = (iso: string | undefined): string =>
  iso === undefined ? "—" : uppercaseMeridiem(new Date(iso).toLocaleString("en-IN"));

/** One issue, with both clocks and whatever alerts stand against it. */
const issueCard = (row: SupervisorIssueRow): HTMLElement => {
  const article = element("article", "review-card supervisor-card");
  article.dataset["status"] = row.currentStatus;

  const top = element("div", "review-card-top");
  top.append(
    element("span", "kind-label", row.queues.map((queue) => QUEUE_LABELS[queue]).join(" · ")),
    element("span", "age-label", `${dayLabel(row.departmentAgeDays)} with department`),
  );

  const heading = element("h3", undefined, row.publicReference);
  const status = element(
    "p",
    "staff-status-label",
    `${row.category} · ${row.currentStatus.replace(/_/g, " ")}${
      row.departmentId === undefined ? "" : ` · ${row.departmentId}`
    }`,
  );

  // The two clocks, always together.
  const clocks = element("p", "clock-summary", clockSummary(row));

  const facts = element("dl", "staff-facts");
  for (const [term, detail] of [
    ["Configured wait", dayLabel(row.alertAfterDays)],
    ["Escalation wait", dayLabel(row.escalateAfterDays)],
    ["Threshold from", isOverridden(row) ? "Supervisor override" : (row.ruleSource ?? "—")],
  ] as const) {
    const group = element("div");
    group.append(element("dt", undefined, term), element("dd", undefined, detail));
    facts.append(group);
  }

  // The configured waits and the reasons are what a supervisor reads when
  // deciding what to do, not in order to find the issue, so they fold away.
  const why = element("details", "ordering-detail");
  const summary = element("summary", undefined, "Why is this here?");
  const list = element("ul");
  for (const reason of row.reasons) list.append(element("li", undefined, reason));
  for (const queue of row.queues) {
    list.append(element("li", undefined, QUEUE_EXPLANATIONS[queue]));
  }
  why.append(summary, facts, list);

  article.append(top, heading, status, clocks, why);

  if (row.override !== undefined) {
    const quote = element("blockquote");
    quote.append(
      element("strong", undefined, `Override recorded ${formatTime(row.override.recordedAt)}`),
      element("span", undefined, row.override.reason),
    );
    article.append(quote);
  }

  // Alerts: recorded, never sent.
  if (row.alerts.length > 0) {
    const alerts = element("ul", "alert-list");
    for (const alert of row.alerts) {
      const item = element("li", "alert-row");
      item.append(
        element(
          "span",
          "alert-label",
          `${ALERT_LABELS[alert.ruleId] ?? alert.ruleId} · recorded ${formatTime(alert.raisedAt)}`,
        ),
      );
      if (alert.acknowledgedAt === undefined) {
        const button = element("button", "review-action secondary-action", "Mark as seen");
        (button as HTMLButtonElement).type = "button";
        button.addEventListener("click", () => {
          void (async () => {
            const result = await api.acknowledge({
              alertId: alert.alertId,
              jurisdictionId: selectJurisdiction().value,
            });
            if (!result.ok) {
              showError(result.message);
              return;
            }
            announce("Alert marked as seen. The alert itself stays on the record.");
            await loadQueues();
          })();
        });
        item.append(button);
      } else {
        item.append(element("span", "alert-seen", `Seen ${formatTime(alert.acknowledgedAt)}`));
      }
      alerts.append(item);
    }
    article.append(alerts);
  }

  // The one write a supervisor may make.
  const overrideField = element("label", "card-field");
  overrideField.textContent = "Reason for changing this issue's clock";
  const reason = document.createElement("textarea");
  reason.rows = 2;
  reason.maxLength = 500;
  reason.dataset["reason"] = "true";
  reason.placeholder = "Say why this issue should be chased on a different clock.";
  overrideField.append(reason);

  const daysRow = element("div", "override-days");
  const alertInput = document.createElement("input");
  alertInput.type = "number";
  alertInput.min = "1";
  alertInput.value = String(Math.max(1, Math.round((row.alertAfterDays ?? 7) / 2)));
  alertInput.dataset["alertDays"] = "true";
  alertInput.setAttribute("aria-label", "Days before an alert");
  const escalateInput = document.createElement("input");
  escalateInput.type = "number";
  escalateInput.min = "2";
  escalateInput.value = String(Math.max(2, Math.round(row.escalateAfterDays ?? 14) - 1));
  escalateInput.dataset["escalateDays"] = "true";
  escalateInput.setAttribute("aria-label", "Days before escalation");
  daysRow.append(
    element("span", "override-days-label", "Alert after"),
    alertInput,
    element("span", "override-days-label", "escalate after"),
    escalateInput,
  );

  const cardError = element("p", "card-error");
  cardError.dataset["error"] = "true";
  cardError.hidden = true;

  const actions = element("div", "card-actions");
  const save = element("button", "review-action", "Record clock override");
  (save as HTMLButtonElement).type = "button";
  save.addEventListener("click", () => {
    void (async () => {
      const text = reason.value.trim();
      if (text.length < 8) {
        cardError.hidden = false;
        cardError.textContent =
          "Write a specific reason of at least 8 characters. Changing a deadline without one is not a reviewed decision.";
        reason.focus();
        return;
      }
      cardError.hidden = true;
      const result = await api.override({
        issueId: row.issueId,
        alertAfterDays: Number(alertInput.value),
        escalateAfterDays: Number(escalateInput.value),
        reason: text,
      });
      if (!result.ok) {
        cardError.hidden = false;
        cardError.textContent = result.message;
        return;
      }
      // Never "escalated" or "prioritised": the clock changed, nothing else.
      announce("Clock override recorded with your reason. It is not a severity judgement.");
      await loadQueues();
    })();
  });
  actions.append(save);

  // Folded: every card used to carry this form open, which made nineteen
  // issues a fifteen-thousand-pixel page. It is still one click away, and
  // still demands a reason.
  const override = element("details", "ordering-detail card-override");
  override.append(
    element("summary", undefined, "Change this issue's clock"),
    overrideField,
    daysRow,
    cardError,
    actions,
  );
  article.append(override);
  return article;
};

const visibleIssues = (): readonly SupervisorIssueRow[] => {
  const issues = queues?.issues ?? [];
  const inAQueue = issues.filter((issue) => issue.queues.length > 0);
  const selected = filter;
  if (selected === "all") return inAQueue;
  return inAQueue.filter((issue) => issue.queues.includes(selected));
};

const render = (): void => {
  if (queues === undefined) return;
  el("policy-note").textContent = `${queues.policyNote} (policy ${queues.policyVersion})`;
  el("delivery-note").textContent = queues.deliveryNote;
  el("as-of").textContent = `Assessed at ${formatTime(queues.asOf)}`;

  for (const queue of ["unacknowledged", "overdue", "escalated", "disputed", "reopened"] as const) {
    el(`count-${queue}`).textContent = String(queues.counts[queue]);
    el(`nav-count-${queue}`).textContent = String(queues.counts[queue]);
  }
  const waiting = queues.issues.filter((issue) => issue.queues.length > 0).length;
  el("nav-count-all").textContent = String(waiting);

  const rows = visibleIssues();
  el("supervisor-workspace-heading").textContent =
    filter === "all" ? "Every queue" : QUEUE_LABELS[filter];
  el("queue-count-line").textContent =
    `${String(rows.length)} issue${rows.length === 1 ? "" : "s"} in this queue`;

  const list = el<HTMLDivElement>("supervisor-list");
  list.replaceChildren();
  if (rows.length === 0) {
    list.append(
      element(
        "p",
        "empty-state",
        "Nothing in this jurisdiction is waiting past its configured time.",
      ),
    );
    void renderIssueOverviewMap(el("supervisor-map"), []);
    return;
  }
  for (const row of rows) list.append(issueCard(row));

  const points: IssueMapPoint[] = rows
    .filter(
      (row): row is SupervisorIssueRow & { latitude: number; longitude: number } =>
        row.latitude !== undefined && row.longitude !== undefined,
    )
    .map((row) => ({
      key: row.issueId,
      lat: row.latitude,
      lon: row.longitude,
      label: `${row.publicReference} · ${row.category}`,
    }));
  void renderIssueOverviewMap(el("supervisor-map"), points);
};

/**
 * Draws the durability panel.
 *
 * Every concern renders its alternatives **inline**, in the same block as the
 * count. On a terminal a caveat three lines down is read; on a screen a
 * collapsed one is not, and these figures are about people's work.
 */
const renderDurability = (): void => {
  if (durability === undefined) return;
  el("durability-preamble").textContent = panelPreamble(durability);
  // The overview's one line. Worded like the empty state below it: no concern
  // is not the same as every unit being fine.
  const concernCount = durability.concerns.length;
  el("overview-durability-line").textContent =
    durability.totalClaims === 0
      ? `No completion claim in the last ${String(durability.windowDays)} days, so there is nothing to measure yet.`
      : `${String(durability.totalClaims)} completion claim(s) over ${String(durability.windowDays)} days. ${
          concernCount === 0
            ? "No unit can be told apart from the rest on this evidence."
            : `${String(concernCount)} figure(s) can be told apart from the rest.`
        }`;
  el("durability-ranking-note").textContent = durability.rankingNote;

  const limits = el("durability-limits");
  limits.replaceChildren();
  for (const limit of durability.limits) limits.append(element("li", undefined, limit));

  const concerns = el("durability-concerns");
  concerns.replaceChildren();
  if (durability.concerns.length === 0) {
    concerns.append(
      element(
        "p",
        "queue-empty",
        durability.totalClaims === 0
          ? "No completion claim in this window, so there is nothing to measure."
          : "No ward's figure can be told apart from the rest of the district on this evidence. That is not the same as every ward being fine.",
      ),
    );
  }
  for (const concern of durability.concerns) {
    const card = element("article", "durability-concern");
    card.append(element("h3", undefined, `${concern.unit} · ${signalLabel(concern.signal)}`));
    card.append(element("p", "durability-figure", `This ward: ${figureText(concern.figure)}`));
    card.append(
      element("p", "durability-figure", `Every other ward: ${figureText(concern.baseline)}`),
    );
    card.append(element("p", "durability-observed", concern.observed));

    // Not collapsed, not a footnote, not optional.
    card.append(element("p", "durability-alternatives-heading", "This cannot rule out:"));
    const alternatives = element("ul", "durability-alternatives");
    for (const alternative of concern.alternatives) {
      alternatives.append(element("li", undefined, alternative));
    }
    card.append(alternatives);
    card.append(element("p", "durability-next", concern.nextStep));
    concerns.append(card);
  }

  const signals = el("durability-signals");
  signals.replaceChildren();
  for (const signal of durability.signals) {
    const block = element("div", "durability-signal");
    block.append(element("h3", undefined, signalLabel(signal.signal)));
    block.append(element("p", "durability-observed", signal.observed));
    const list = element("ul", "durability-units");
    for (const unit of signal.units) {
      list.append(element("li", undefined, `${unit.label}: ${figureText(unit.figure)}`));
    }
    block.append(list);
    signals.append(block);
  }
};

const loadDurability = async (): Promise<void> => {
  const jurisdictionId = selectJurisdiction().value;
  if (jurisdictionId.length === 0) return;
  el("refresh-durability").setAttribute("aria-busy", "true");
  const result = await api.durability(jurisdictionId);
  el("refresh-durability").removeAttribute("aria-busy");
  if (!result.ok) {
    showError(result.message);
    return;
  }
  const view = toDurabilityView(result.value);
  if (view === undefined) {
    showError("The durability panel could not be read.");
    return;
  }
  durability = view;
  renderDurability();
};

const loadQueues = async (): Promise<void> => {
  const jurisdictionId = selectJurisdiction().value;
  if (jurisdictionId.length === 0) return;
  el("refresh-queues").setAttribute("aria-busy", "true");
  const result = await api.queues(jurisdictionId);
  el("refresh-queues").removeAttribute("aria-busy");
  if (!result.ok) {
    showError(result.message);
    return;
  }
  const view = toSupervisorQueueView(result.value);
  if (view === undefined) {
    showError("The supervisor queue could not be read.");
    return;
  }
  el("supervisor-error").hidden = true;
  queues = view;
  render();
  void loadDurability();
};

const showWorkspace = (
  jurisdictions: readonly {
    jurisdiction_id: string;
    internal_code: string;
    level_code: string;
    synthetic: boolean;
  }[],
): void => {
  el("supervisor-workspace").hidden = false;
  el<HTMLButtonElement>("supervisor-signout").hidden = false;
  shell.setSignedIn(true);
  const select = selectJurisdiction();
  const previous = select.value;
  select.replaceChildren();
  for (const jurisdiction of jurisdictions) {
    const option = document.createElement("option");
    option.value = jurisdiction.jurisdiction_id;
    option.textContent = `${jurisdiction.internal_code} · ${jurisdiction.level_code}${
      jurisdiction.synthetic ? " · synthetic" : ""
    }`;
    select.append(option);
  }
  if ([...select.options].some((option) => option.value === previous)) select.value = previous;
  el("supervisor-role").textContent = "Supervisor · server-authorized jurisdictions";
  applyHash(false);
};

const start = async (): Promise<void> => {
  const session = await api.session();
  if (session.ok && session.value.authenticated) {
    confirmSignedIn();
    showWorkspace((session.value.jurisdictions ?? []) as never);
    await loadQueues();
    return;
  }
  if (!sendToStaffDoor()) showError(SIGN_IN_DID_NOT_STICK);
};

el("refresh-queues").addEventListener("click", () => void loadQueues());
el("refresh-durability").addEventListener("click", () => void loadDurability());
selectJurisdiction().addEventListener("change", () => void loadQueues());

/**
 * Shows the part and the queue the hash names. The sidebar's items are plain
 * links, so this is also what the back and forward buttons run.
 */
const applyHash = (focus: boolean): void => {
  const location_ = parseSupervisorHash(window.location.hash);
  view = location_.view;
  filter = location_.queue;
  shell.showView(view);
  // "Waiting issues" is the current page only while it shows every queue;
  // with one queue chosen, that queue's own link is.
  for (const link of document.querySelectorAll<HTMLElement>("[data-queue-link]")) {
    const current = view === "queues" && link.dataset["queueLink"] === filter;
    if (current) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  if (view === "queues" && filter !== "all") {
    document.querySelector('[data-view-link="queues"]')?.removeAttribute("aria-current");
  }
  el("supervisor-title").textContent = SUPERVISOR_VIEW_TITLES[view];
  render();
  if (focus) el("supervisor-title").focus();
};
window.addEventListener("hashchange", () => applyHash(true));
el("supervisor-signout").addEventListener("click", () => {
  void (async () => {
    await api.logout();
    leaveToSignIn();
  })();
});

void start();
