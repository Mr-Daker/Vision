/** DOM controller for the separate V034 department staff workspace. */

import { StaffApiClient, type StaffSessionPayload } from "./staff-api.ts";
import {
  categoryLabel,
  daysWaitingLabel,
  confirmationProgressLabel,
  resolutionStageLabel,
  resolutionStageOf,
  shortStaffId,
  toStaffInboxView,
  toStaffWorkspaces,
  type StaffInboxItem,
  type StaffInboxView,
  type StaffWorkspace,
} from "./staff-view.ts";

const api = new StaffApiClient();
let session: StaffSessionPayload | undefined;
let workspaces: readonly StaffWorkspace[] = [];
let inbox: StaffInboxView | undefined;
let filter = "all";

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`missing element: ${id}`);
  return node as T;
};

const announce = (message: string): void => {
  const live = el("staff-live");
  live.textContent = "";
  window.setTimeout(() => (live.textContent = message), 30);
};

const showError = (message?: string): void => {
  const box = el("staff-error");
  box.textContent = message ?? "";
  box.hidden = message === undefined;
  if (message !== undefined) box.focus();
};

const workspaceSelect = (): HTMLSelectElement => el("workspace-select");

const selectedWorkspace = (): StaffWorkspace | undefined => {
  const index = Number(workspaceSelect().value);
  return Number.isInteger(index) ? workspaces[index] : undefined;
};

const formatTime = (value: string | undefined): string =>
  value === undefined
    ? "Not recorded"
    : new Intl.DateTimeFormat("en-IN", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(value));

const renderSession = (): void => {
  const authenticated = session?.authenticated === true;
  el("staff-login").hidden = authenticated;
  el("staff-workspace").hidden = !authenticated;
  el("staff-signout").hidden = !authenticated;
  if (!authenticated) return;

  const select = workspaceSelect();
  const previous = select.value;
  select.replaceChildren();
  workspaces.forEach((workspace, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = `${workspace.internalCode} · ${workspace.departmentLabel}`;
    select.append(option);
  });
  if ([...select.options].some((option) => option.value === previous)) select.value = previous;
  el("staff-role").textContent = "Department staff · server-authorized responsibility";
};

/**
 * Completion photographs uploaded but not yet claimed, per issue.
 *
 * Held here rather than on the element so a re-render — which `loadInbox`
 * does after every action — cannot lose an upload the staff member has
 * already waited for. Cleared once the claim it belongs to is recorded.
 */
const claimUploads = new Map<string, string[]>();

const lifecycleStep = (
  label: string,
  state: "complete" | "waiting" | "simulated",
  detail: string,
): HTMLElement => {
  const item = document.createElement("li");
  item.className = `lifecycle-step ${state}`;
  const marker = document.createElement("span");
  marker.className = "lifecycle-marker";
  marker.setAttribute("aria-hidden", "true");
  marker.textContent = state === "waiting" ? "○" : "✓";
  const copy = document.createElement("span");
  const strong = document.createElement("strong");
  strong.textContent = label;
  const small = document.createElement("small");
  small.textContent = detail;
  copy.append(strong, small);
  item.append(marker, copy);
  return item;
};

const act = async (
  item: StaffInboxItem,
  action:
    "accept_internal" | "assign_to_self" | "simulate_recipient_acknowledgment" | "claim_resolution",
  card: HTMLElement,
): Promise<void> => {
  const workspace = selectedWorkspace();
  if (workspace === undefined) return;
  const note = card.querySelector<HTMLTextAreaElement>("[data-note]")?.value.trim() ?? "";
  const error = card.querySelector<HTMLElement>("[data-error]");
  if (note.length < 8) {
    if (error !== null) {
      error.hidden = false;
      error.textContent = "Write a specific note of at least 8 characters before saving.";
    }
    card.querySelector<HTMLTextAreaElement>("[data-note]")?.focus();
    return;
  }
  // A claim is answered by people who live with the problem, so it needs
  // something for them to check against: a specific description and at least
  // one photograph that finished uploading.
  const claimEvidence = claimUploads.get(item.issueId) ?? [];
  if (action === "claim_resolution") {
    if (note.length < 12) {
      if (error !== null) {
        error.hidden = false;
        error.textContent =
          "Describe what was actually done, in at least 12 characters. A citizen is being asked whether this matches what they can see.";
      }
      card.querySelector<HTMLTextAreaElement>("[data-note]")?.focus();
      return;
    }
    if (claimEvidence.length === 0) {
      if (error !== null) {
        error.hidden = false;
        error.textContent = "Add at least one completion photograph before recording a claim.";
      }
      card.querySelector<HTMLInputElement>("[data-completion-photo]")?.focus();
      return;
    }
  }

  const buttons = card.querySelectorAll<HTMLButtonElement>("button[data-action]");
  buttons.forEach((button) => (button.disabled = true));
  card.setAttribute("aria-busy", "true");
  if (error !== null) error.hidden = true;
  const result = await api.act({
    issueId: item.issueId,
    action,
    jurisdictionId: workspace.jurisdictionId,
    departmentId: workspace.departmentId,
    note,
    ...(action === "claim_resolution"
      ? {
          completionEvidence: claimEvidence,
          // Stable per issue and per set of photographs, so pressing the
          // button twice records one claim rather than two.
          idempotencyKey: `${item.issueId}:${claimEvidence.join(",")}`,
        }
      : {}),
  });
  card.removeAttribute("aria-busy");
  if (!result.ok) {
    buttons.forEach((button) => (button.disabled = false));
    if (error !== null) {
      error.hidden = false;
      error.textContent = result.message;
    }
    announce(`Action not saved. ${result.message}`);
    return;
  }
  if (action === "claim_resolution") {
    claimUploads.delete(item.issueId);
    // The words here are load-bearing. "Saved" and "recorded" are fine;
    // "resolved" would tell a staff member the opposite of what happened.
    announce(
      "Completion claim recorded. The issue is now awaiting confirmation from people who reported it, and is not a verified resolution.",
    );
    await loadInbox();
    return;
  }
  const labels = {
    accept_internal: "Internal acceptance",
    assign_to_self: "Assignment",
    simulate_recipient_acknowledgment: "Simulated recipient acknowledgment",
  } as const;
  announce(`${labels[action]} saved with its actor, time and note.`);
  await loadInbox();
};

const staffCard = (item: StaffInboxItem): HTMLElement => {
  const article = document.createElement("article");
  article.className = "review-card staff-card";

  const top = document.createElement("div");
  top.className = "review-card-top";
  const position = document.createElement("span");
  position.className = "kind-label";
  position.textContent = `Queue ${String(item.queuePosition)} · ${categoryLabel(item.category)}`;
  const age = document.createElement("span");
  age.className = "age-label";
  age.textContent = daysWaitingLabel(item.ageDays);
  top.append(position, age);

  const heading = document.createElement("h3");
  heading.textContent = item.publicReference;
  const status = document.createElement("p");
  status.className = "staff-status-label";
  status.textContent = item.statusLabel;

  const facts = document.createElement("dl");
  facts.className = "staff-facts";
  for (const [label, value] of [
    ["Evidence", String(item.evidenceCount)],
    ["Counted citizens", String(item.countedParticipants)],
    ["Issue state", item.currentStatus.replaceAll("_", " ")],
  ] as const) {
    const group = document.createElement("div");
    const term = document.createElement("dt");
    term.textContent = label;
    const detail = document.createElement("dd");
    detail.textContent = value;
    group.append(term, detail);
    facts.append(group);
  }

  const lifecycleHeading = document.createElement("h4");
  lifecycleHeading.textContent = "Delivery and acknowledgment record";
  const lifecycle = document.createElement("ol");
  lifecycle.className = "lifecycle";
  lifecycle.append(
    lifecycleStep(
      "Delivery",
      item.deliveryAccepted ? "complete" : "waiting",
      item.deliveryAccepted
        ? `Transport accepted · ${formatTime(item.deliveryAcceptedAt)}`
        : item.deliveryAttempted
          ? `Attempted · ${formatTime(item.deliveryAttemptedAt)}`
          : "No delivery has been attempted",
    ),
    lifecycleStep(
      "Internal acceptance",
      item.internallyAccepted ? "complete" : "waiting",
      item.internallyAccepted
        ? `Accepted by staff · ${formatTime(item.internallyAcceptedAt)}`
        : "Nobody has accepted this internally",
    ),
    lifecycleStep(
      "Recipient acknowledgment",
      item.recipientAcknowledged
        ? item.recipientAcknowledgmentIsSimulated
          ? "simulated"
          : "complete"
        : "waiting",
      item.recipientAcknowledged
        ? `${item.recipientAcknowledgmentIsSimulated ? "Simulated recipient" : "Recipient"} · ${formatTime(item.recipientAcknowledgedAt)}${item.recipientAcknowledgmentReference === undefined ? "" : ` · ${item.recipientAcknowledgmentReference}`}`
        : "No recipient acknowledgment exists",
    ),
  );

  const assignment = document.createElement("p");
  assignment.className = "assignment-line";
  assignment.textContent =
    item.assignedStaffId === undefined
      ? "Unassigned"
      : `Assigned to staff ${shortStaffId(item.assignedStaffId)} · ${formatTime(item.assignedAt)}`;

  // ── V035 completion claim ───────────────────────────────────────────────
  //
  // Placed directly below the delivery lifecycle, because it is the next stage
  // of the same record rather than a separate feature. It reuses the card's
  // own note field as the description: a second textarea would suggest two
  // different things are being written down.
  const stage = resolutionStageOf(item);
  const resolution = document.createElement("div");
  resolution.className = "claim-block";
  resolution.dataset["stage"] = stage;

  const resolutionHeading = document.createElement("h4");
  resolutionHeading.textContent = "Completion claim";
  const resolutionState = document.createElement("p");
  resolutionState.className = "claim-state";
  resolutionState.textContent = resolutionStageLabel(stage);
  resolution.append(resolutionHeading, resolutionState);

  const progress = confirmationProgressLabel(item);
  if (progress !== undefined) {
    const line = document.createElement("p");
    line.className = "claim-progress";
    line.textContent = `${progress} · policy applies to this category`;
    resolution.append(line);
  }
  if (item.resolutionClaimDescription !== undefined) {
    const claimed = document.createElement("blockquote");
    const label = document.createElement("strong");
    label.textContent = `Claimed ${formatTime(item.resolutionClaimedAt)}`;
    const text = document.createElement("span");
    text.textContent = item.resolutionClaimDescription;
    claimed.append(label, text);
    resolution.append(claimed);
  }

  if (stage === "claimable") {
    const photoField = document.createElement("label");
    photoField.className = "card-field";
    photoField.textContent = "Completion photograph";
    const photo = document.createElement("input");
    photo.type = "file";
    photo.accept = "image/jpeg,image/png";
    photo.dataset["completionPhoto"] = "true";
    photoField.append(photo);

    const photoStatus = document.createElement("p");
    photoStatus.className = "claim-upload-status";
    const already = claimUploads.get(item.issueId) ?? [];
    photoStatus.textContent =
      already.length === 0
        ? "A JPEG or PNG of the completed work. Required before a claim can be recorded."
        : `${String(already.length)} photograph${already.length === 1 ? "" : "s"} uploaded and ready.`;

    photo.addEventListener("change", () => {
      const file = photo.files?.[0];
      if (file === undefined) return;
      photoStatus.textContent = `Uploading ${file.name}…`;
      photo.disabled = true;
      void (async () => {
        const uploaded = await api.uploadCompletionPhoto(file);
        photo.disabled = false;
        if (!uploaded.ok) {
          photoStatus.textContent = `That photograph was not accepted: ${uploaded.message}`;
          return;
        }
        const references = claimUploads.get(item.issueId) ?? [];
        references.push(uploaded.value.objectReference);
        claimUploads.set(item.issueId, references);
        photoStatus.textContent = `${String(references.length)} photograph${references.length === 1 ? "" : "s"} uploaded and ready.`;
        announce("Completion photograph uploaded.");
      })();
    });
    resolution.append(photoField, photoStatus);
  }

  // The sentence that has to travel with every claim state, on the screen that
  // creates one.
  const caveat = document.createElement("p");
  caveat.className = "claim-caveat";
  caveat.textContent =
    "A confirmed repair means participants agreed the visible problem appears fixed. It is not a professional inspection, engineering certification, safety guarantee, or guarantee that the repair is permanent.";
  resolution.append(caveat);

  const basis = document.createElement("details");
  basis.className = "ordering-detail";
  const basisSummary = document.createElement("summary");
  basisSummary.textContent = "Why this queue position?";
  const basisList = document.createElement("ul");
  for (const explanation of item.orderingBasis) {
    const line = document.createElement("li");
    line.textContent = explanation;
    basisList.append(line);
  }
  basis.append(basisSummary, basisList);

  const noteField = document.createElement("label");
  noteField.className = "card-field";
  noteField.textContent = "Action note";
  const textarea = document.createElement("textarea");
  textarea.rows = 3;
  textarea.maxLength = 600;
  textarea.dataset["note"] = "true";
  textarea.placeholder = "Record what happened and why this action is justified.";
  noteField.append(textarea);

  const cardError = document.createElement("p");
  cardError.className = "card-error";
  cardError.dataset["error"] = "true";
  cardError.hidden = true;

  const actions = document.createElement("div");
  actions.className = "card-actions";
  const definitions = [
    {
      action: "accept_internal" as const,
      label: item.internallyAccepted ? "Accepted internally" : "Accept internally",
      disabled: item.internallyAccepted,
      className: "review-action",
    },
    {
      action: "assign_to_self" as const,
      label: item.assignedStaffId === undefined ? "Assign to me" : "Reassign to me",
      disabled: false,
      className: "review-action secondary-action",
    },
    {
      action: "simulate_recipient_acknowledgment" as const,
      label: item.recipientAcknowledged
        ? "Simulated reply recorded"
        : "Record simulated recipient reply",
      disabled: item.recipientAcknowledged,
      className: "review-action simulation-action",
    },
    {
      action: "claim_resolution" as const,
      // Not "Mark resolved". Staff record that they believe the work is done;
      // whether it is resolved is not theirs to say.
      label:
        stage === "claimable"
          ? "Record completion claim"
          : stage === "awaiting_confirmation"
            ? "Claim awaiting confirmation"
            : "Completion claim",
      disabled: stage !== "claimable",
      className: "review-action",
    },
  ];
  for (const definition of definitions) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset["action"] = definition.action;
    button.className = definition.className;
    button.textContent = definition.label;
    button.disabled = definition.disabled;
    button.addEventListener("click", () => void act(item, definition.action, article));
    actions.append(button);
  }
  article.append(
    top,
    heading,
    status,
    facts,
    lifecycleHeading,
    lifecycle,
    assignment,
    resolution,
    basis,
    noteField,
    cardError,
    actions,
  );
  return article;
};

const filteredItems = (): readonly StaffInboxItem[] => {
  const items = inbox?.items ?? [];
  if (filter === "unaccepted") return items.filter((item) => !item.internallyAccepted);
  if (filter === "unassigned") return items.filter((item) => item.assignedStaffId === undefined);
  if (filter === "awaiting_recipient") return items.filter((item) => !item.recipientAcknowledged);
  return items;
};

const renderInbox = (): void => {
  const list = el("staff-list");
  list.replaceChildren();
  const items = filteredItems();
  el("staff-count").textContent = String(inbox?.items.length ?? 0);
  el("unaccepted-count").textContent = String(
    (inbox?.items ?? []).filter((item) => !item.internallyAccepted).length,
  );
  el("unassigned-count").textContent = String(
    (inbox?.items ?? []).filter((item) => item.assignedStaffId === undefined).length,
  );
  el("ordering-note").textContent = inbox?.orderingNote ?? "";
  el("queue-bound").textContent = inbox?.exhaustive
    ? "All currently authorized issues are shown."
    : `Showing the first ${String(inbox?.appliedLimit ?? 0)} authorized issues.`;
  if (items.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent =
      inbox?.items.length === 0
        ? "No routed issues are waiting in this responsibility scope."
        : "No issues match this filter.";
    list.append(empty);
    return;
  }
  for (const item of items) list.append(staffCard(item));
};

const loadInbox = async (): Promise<void> => {
  const workspace = selectedWorkspace();
  if (workspace === undefined) {
    showError("This staff account has no active responsibility grant.");
    return;
  }
  showError();
  el("refresh-inbox").setAttribute("aria-busy", "true");
  const result = await api.inbox(workspace.jurisdictionId, workspace.departmentId);
  el("refresh-inbox").removeAttribute("aria-busy");
  if (!result.ok) {
    showError(result.message);
    return;
  }
  const parsed = toStaffInboxView(result.value);
  if (parsed === undefined) {
    showError("The inbox response was incomplete, so no staff action is available.");
    return;
  }
  inbox = parsed;
  renderInbox();
};

const acceptSession = (payload: StaffSessionPayload): boolean => {
  const parsed = toStaffWorkspaces(payload.workspaces);
  if (
    payload.authenticated !== true ||
    payload.role !== "department_staff" ||
    parsed === undefined
  ) {
    return false;
  }
  session = payload;
  workspaces = parsed;
  return true;
};

const showLoginChoices = async (): Promise<void> => {
  const choices = el("staff-login-choices");
  choices.replaceChildren();
  const result = await api.capabilities();
  if (!result.ok) {
    showError(result.message);
    return;
  }
  el("staff-identity-disclosure").textContent = result.value.identity_label;
  for (const principal of result.value.demo_principals) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "login-choice";
    button.textContent = principal.label;
    button.addEventListener("click", async () => {
      button.disabled = true;
      button.textContent = "Signing in…";
      const login = await api.login(principal.credential);
      if (!login.ok || !login.value.authenticated || !acceptSession(login.value)) {
        button.disabled = false;
        button.textContent = principal.label;
        showError(login.ok ? "The staff responsibility grant is incomplete." : login.message);
        return;
      }
      renderSession();
      await loadInbox();
      el("staff-workspace-heading").focus();
    });
    choices.append(button);
  }
};

const initialize = async (): Promise<void> => {
  el("refresh-inbox").addEventListener("click", () => void loadInbox());
  workspaceSelect().addEventListener("change", () => void loadInbox());
  el<HTMLSelectElement>("staff-filter").addEventListener("change", (event) => {
    filter = (event.currentTarget as HTMLSelectElement).value;
    renderInbox();
  });
  el("staff-signout").addEventListener("click", async () => {
    await api.logout();
    session = undefined;
    workspaces = [];
    inbox = undefined;
    renderSession();
    await showLoginChoices();
    el("staff-login-heading").focus();
  });

  const existing = await api.session();
  if (existing.ok && existing.value.authenticated && acceptSession(existing.value)) {
    renderSession();
    await loadInbox();
    return;
  }
  renderSession();
  await showLoginChoices();
};

void initialize();
