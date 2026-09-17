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

const api = new SupervisorApiClient();
let queues: SupervisorQueueView | undefined;
let filter: SupervisorQueueId | "all" = "all";

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

const formatTime = (iso: string | undefined): string =>
  iso === undefined ? "—" : new Date(iso).toLocaleString("en-IN");

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

  const why = element("details", "ordering-detail");
  const summary = element("summary", undefined, "Why is this here?");
  const list = element("ul");
  for (const reason of row.reasons) list.append(element("li", undefined, reason));
  for (const queue of row.queues) {
    list.append(element("li", undefined, QUEUE_EXPLANATIONS[queue]));
  }
  why.append(summary, list);

  article.append(top, heading, status, clocks, facts, why);

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

  article.append(overrideField, daysRow, cardError, actions);
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
  }

  const list = el<HTMLDivElement>("supervisor-list");
  list.replaceChildren();
  const rows = visibleIssues();
  if (rows.length === 0) {
    list.append(
      element(
        "p",
        "empty-state",
        "Nothing in this jurisdiction is waiting past its configured time.",
      ),
    );
    return;
  }
  for (const row of rows) list.append(issueCard(row));
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
};

const showWorkspace = (
  jurisdictions: readonly {
    jurisdiction_id: string;
    internal_code: string;
    level_code: string;
    synthetic: boolean;
  }[],
): void => {
  el("supervisor-login").hidden = true;
  el("supervisor-workspace").hidden = false;
  el<HTMLButtonElement>("supervisor-signout").hidden = false;
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
};

const start = async (): Promise<void> => {
  const session = await api.session();
  if (session.ok && session.value.authenticated) {
    showWorkspace((session.value.jurisdictions ?? []) as never);
    await loadQueues();
    return;
  }
  const capabilities = await api.capabilities();
  if (!capabilities.ok) {
    showError("The supervisor sign-in options could not be loaded.");
    return;
  }
  const choices = el("supervisor-login-choices");
  choices.replaceChildren();
  for (const principal of capabilities.value.demo_principals) {
    const button = element("button", "login-choice", principal.label);
    (button as HTMLButtonElement).type = "button";
    button.addEventListener("click", () => {
      void (async () => {
        const result = await api.login(principal.credential);
        if (!result.ok) {
          showError(result.message);
          return;
        }
        showWorkspace((result.value.jurisdictions ?? []) as never);
        await loadQueues();
      })();
    });
    choices.append(button);
  }
};

el("refresh-queues").addEventListener("click", () => void loadQueues());
selectJurisdiction().addEventListener("change", () => void loadQueues());
el<HTMLSelectElement>("queue-filter").addEventListener("change", (event) => {
  filter = (event.target as HTMLSelectElement).value as SupervisorQueueId | "all";
  render();
});
el("supervisor-signout").addEventListener("click", () => {
  void (async () => {
    await api.logout();
    window.location.reload();
  })();
});

void start();
