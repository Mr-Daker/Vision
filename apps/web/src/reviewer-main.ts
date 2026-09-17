/** DOM controller for the separate V032 reviewer workspace. */

import { ReviewerApiClient, type ReviewerSession } from "./reviewer-api.ts";
import {
  ACTION_LABELS,
  ageLabel,
  KIND_LABELS,
  shortReference,
  toReviewerQueueView,
  type ReviewAction,
  type ReviewerQueueItem,
  type ReviewerQueueView,
} from "./reviewer-view.ts";

const api = new ReviewerApiClient();
let session: ReviewerSession | undefined;
let queue: ReviewerQueueView | undefined;
let filter = "all";
const originalObjectUrls = new Set<string>();

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`missing element: ${id}`);
  return node as T;
};

const announce = (message: string): void => {
  const live = el("reviewer-live");
  live.textContent = "";
  window.setTimeout(() => (live.textContent = message), 30);
};

const showError = (message?: string): void => {
  const box = el("reviewer-error");
  box.textContent = message ?? "";
  box.hidden = message === undefined;
  if (message !== undefined) box.focus();
};

const selectJurisdiction = (): HTMLSelectElement => el("jurisdiction-select");

const renderSession = (): void => {
  const authenticated = session?.authenticated === true;
  el("reviewer-login").hidden = authenticated;
  el("reviewer-workspace").hidden = !authenticated;
  el("reviewer-signout").hidden = !authenticated;
  if (!authenticated) return;

  const select = selectJurisdiction();
  const previous = select.value;
  select.replaceChildren();
  for (const jurisdiction of session?.jurisdictions ?? []) {
    const option = document.createElement("option");
    option.value = jurisdiction.jurisdiction_id;
    option.textContent = `${jurisdiction.internal_code} · ${jurisdiction.level_code}${jurisdiction.synthetic ? " · synthetic" : ""}`;
    select.append(option);
  }
  if ([...select.options].some((option) => option.value === previous)) select.value = previous;
  el("reviewer-role").textContent = "Reviewer · server-authorized scope";
};

/**
 * Which actions are drawn as the consequential ones.
 *
 * `confirm_disputed_resolution` is here because it overrules the people living
 * with the problem. It is legitimate where the category policy grants it, and
 * it is still the heaviest thing a reviewer can do on this screen — so it is
 * outlined rather than offered as the obvious next press.
 */
const actionTone = (action: ReviewAction): string =>
  action.startsWith("reject") ||
  action === "separate_from_issue" ||
  action === "confirm_disputed_resolution"
    ? "danger"
    : "normal";

const decisionTargetFor = (item: ReviewerQueueItem, card: HTMLElement): string | undefined => {
  if (item.permittedActions.includes("attach_to_issue")) {
    return card.querySelector<HTMLSelectElement>("[data-candidate]")?.value;
  }
  return undefined;
};

const decide = async (
  item: ReviewerQueueItem,
  action: ReviewAction,
  card: HTMLElement,
): Promise<void> => {
  const reason = card.querySelector<HTMLTextAreaElement>("[data-reason]")?.value.trim() ?? "";
  const error = card.querySelector<HTMLElement>("[data-error]");
  if (reason.length < 8) {
    if (error !== null) {
      error.hidden = false;
      error.textContent = "Write a specific reason of at least 8 characters before deciding.";
    }
    card.querySelector<HTMLTextAreaElement>("[data-reason]")?.focus();
    return;
  }
  const jurisdictionId = selectJurisdiction().value;
  const buttons = card.querySelectorAll<HTMLButtonElement>("button[data-action]");
  buttons.forEach((button) => (button.disabled = true));
  card.setAttribute("aria-busy", "true");
  if (error !== null) error.hidden = true;

  const candidateIssueId = action === "attach_to_issue" ? decisionTargetFor(item, card) : undefined;
  const result = await api.decide({
    kind: item.kind,
    targetId: item.targetId,
    jurisdictionId,
    action,
    reason,
    ...(candidateIssueId === undefined ? {} : { candidateIssueId }),
  });
  card.removeAttribute("aria-busy");
  if (!result.ok) {
    buttons.forEach((button) => (button.disabled = false));
    if (error !== null) {
      error.hidden = false;
      error.textContent = result.message;
    }
    announce(`Decision not saved. ${result.message}`);
    return;
  }
  announce(`${ACTION_LABELS[action]} saved with its reason and prior state.`);
  await loadQueue();
};

const reviewCard = (item: ReviewerQueueItem): HTMLElement => {
  const article = document.createElement("article");
  article.className = "review-card";
  article.dataset["kind"] = item.kind;

  const top = document.createElement("div");
  top.className = "review-card-top";
  const kind = document.createElement("span");
  kind.className = "kind-label";
  kind.textContent = KIND_LABELS[item.kind];
  const age = document.createElement("span");
  age.className = "age-label";
  age.textContent = ageLabel(item.waitingSince, Date.now());
  top.append(kind, age);

  const heading = document.createElement("h3");
  heading.textContent = `Submission ${shortReference(item.submissionId)}`;
  const reason = document.createElement("p");
  reason.className = "queue-reason";
  reason.textContent = item.reason;
  article.append(top, heading, reason);

  if (item.kind === "redaction_decision" || item.kind === "flagged_evidence") {
    const reveal = document.createElement("button");
    reveal.type = "button";
    reveal.className = "private-original-button";
    reveal.textContent = "View private original";
    reveal.addEventListener("click", async () => {
      reveal.disabled = true;
      reveal.textContent = "Opening with audited access…";
      const opened = await api.original({
        kind: item.kind,
        targetId: item.targetId,
        jurisdictionId: selectJurisdiction().value,
      });
      if (!opened.ok) {
        reveal.disabled = false;
        reveal.textContent = "View private original";
        const error = article.querySelector<HTMLElement>("[data-error]");
        if (error !== null) {
          error.hidden = false;
          error.textContent = opened.message;
        }
        return;
      }
      originalObjectUrls.add(opened.value.objectUrl);
      const figure = document.createElement("figure");
      figure.className = "private-original";
      const image = document.createElement("img");
      image.src = opened.value.objectUrl;
      image.alt = "Private photograph under review";
      const caption = document.createElement("figcaption");
      caption.textContent =
        "Private original · this successful access was recorded with its purpose and reviewer session.";
      figure.append(image, caption);
      reveal.replaceWith(figure);
    });
    article.append(reveal);
  }

  // V035. What a reviewer is deciding between here is a department's claim and
  // a resident's account, so the sentence about what agreement does and does
  // not establish belongs on this card too — including when the reviewer is
  // about to overrule the resident.
  if (item.kind === "disputed_resolution") {
    const caveat = document.createElement("p");
    caveat.className = "claim-caveat";
    caveat.textContent =
      "A confirmed repair means participants agreed the visible problem appears fixed. It is not a professional inspection, engineering certification, safety guarantee, or guarantee that the repair is permanent.";
    article.append(caveat);
    if (!item.permittedActions.includes("confirm_disputed_resolution")) {
      const policy = document.createElement("p");
      policy.className = "claim-progress";
      policy.textContent =
        "This category's confirmation policy does not let a reviewer override a dispute, so the only route is back to the crew.";
      article.append(policy);
    }
  }

  // V041. The caveat that has to sit on this card is the one about what a
  // *rejection* does not mean: deciding a report does not concern a project
  // says nothing about whether the asset has been paid for.
  if (item.kind === "project_link_proposal") {
    const caveat = document.createElement("p");
    caveat.className = "claim-caveat";
    caveat.textContent =
      "Confirming means this report concerns that project. Rejecting means it does not — it is not a finding about whether this asset has been funded, and no answer here is evidence about public spending.";
    article.append(caveat);
  }

  if (item.citizenNote !== undefined) {
    const note = document.createElement("blockquote");
    const label = document.createElement("strong");
    label.textContent =
      item.kind === "disputed_resolution" ? "What the participant says" : "Citizen note";
    const text = document.createElement("span");
    text.textContent = item.citizenNote;
    note.append(label, text);
    article.append(note);
  }

  if (item.candidateIssueIds.length > 0 && item.permittedActions.includes("attach_to_issue")) {
    const field = document.createElement("label");
    field.className = "card-field";
    field.textContent = "Candidate issue";
    const select = document.createElement("select");
    select.dataset["candidate"] = "true";
    for (const candidate of item.candidateIssueIds) {
      const option = document.createElement("option");
      option.value = candidate;
      option.textContent = shortReference(candidate);
      select.append(option);
    }
    field.append(select);
    article.append(field);
  }

  const reasonField = document.createElement("label");
  reasonField.className = "card-field";
  reasonField.textContent = "Reason for this decision";
  const textarea = document.createElement("textarea");
  textarea.rows = 3;
  textarea.maxLength = 600;
  textarea.dataset["reason"] = "true";
  textarea.placeholder = "Record what you checked and why this action is justified.";
  reasonField.append(textarea);

  const cardError = document.createElement("p");
  cardError.className = "card-error";
  cardError.dataset["error"] = "true";
  cardError.hidden = true;

  const actions = document.createElement("div");
  actions.className = "card-actions";
  for (const action of item.permittedActions) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset["action"] = action;
    button.className = actionTone(action) === "danger" ? "review-action danger" : "review-action";
    button.textContent = ACTION_LABELS[action];
    button.addEventListener("click", () => void decide(item, action, article));
    actions.append(button);
  }
  article.append(reasonField, cardError, actions);
  return article;
};

const renderQueue = (): void => {
  for (const url of originalObjectUrls) URL.revokeObjectURL(url);
  originalObjectUrls.clear();
  const list = el("review-list");
  list.replaceChildren();
  const items = (queue?.items ?? []).filter((item) => filter === "all" || item.kind === filter);
  el("queue-count").textContent = String(queue?.items.length ?? 0);
  el("visible-count").textContent = String(items.length);
  el("orphan-count").textContent = String(queue?.awaitingJurisdictionCount ?? 0);
  const orphan = el("orphan-note");
  orphan.hidden = (queue?.awaitingJurisdictionCount ?? 0) === 0;
  orphan.textContent = queue?.awaitingJurisdictionNote ?? "";
  el("queue-bound").textContent = queue?.exhaustive
    ? "All currently authorized items are shown."
    : `Showing the oldest ${String(queue?.appliedLimit ?? 0)} authorized items.`;

  if (items.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent =
      queue?.items.length === 0
        ? "No items are waiting in this scope."
        : "No items match this filter.";
    list.append(empty);
    return;
  }
  for (const item of items) list.append(reviewCard(item));
};

const loadQueue = async (): Promise<void> => {
  const jurisdictionId = selectJurisdiction().value;
  if (jurisdictionId.length === 0) {
    showError("This reviewer has no active jurisdiction grant.");
    return;
  }
  showError();
  el("refresh-queue").setAttribute("aria-busy", "true");
  const result = await api.queue(jurisdictionId);
  el("refresh-queue").removeAttribute("aria-busy");
  if (!result.ok) {
    showError(result.message);
    return;
  }
  const parsed = toReviewerQueueView(result.value);
  if (parsed === undefined) {
    showError("The queue response was incomplete, so no decisions are available.");
    return;
  }
  queue = parsed;
  renderQueue();
};

const showLoginChoices = async (): Promise<void> => {
  const choices = el("reviewer-login-choices");
  choices.replaceChildren();
  const result = await api.capabilities();
  if (!result.ok) {
    showError(result.message);
    return;
  }
  el("identity-disclosure").textContent = result.value.identity_label;
  for (const principal of result.value.demo_principals) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "login-choice";
    button.textContent = principal.label;
    button.addEventListener("click", async () => {
      button.disabled = true;
      button.textContent = "Signing in…";
      const login = await api.login(principal.credential);
      if (!login.ok) {
        button.disabled = false;
        button.textContent = principal.label;
        showError(login.message);
        return;
      }
      session = login.value;
      renderSession();
      await loadQueue();
      el("workspace-heading").focus();
    });
    choices.append(button);
  }
};

const initialize = async (): Promise<void> => {
  el("refresh-queue").addEventListener("click", () => void loadQueue());
  selectJurisdiction().addEventListener("change", () => void loadQueue());
  el<HTMLSelectElement>("kind-filter").addEventListener("change", (event) => {
    filter = (event.currentTarget as HTMLSelectElement).value;
    renderQueue();
  });
  el("reviewer-signout").addEventListener("click", async () => {
    await api.logout();
    session = undefined;
    queue = undefined;
    renderSession();
    await showLoginChoices();
    el("reviewer-login-heading").focus();
  });

  const existing = await api.session();
  if (existing.ok && existing.value.authenticated) {
    session = existing.value;
    renderSession();
    await loadQueue();
    return;
  }
  renderSession();
  await showLoginChoices();
};

void initialize();
