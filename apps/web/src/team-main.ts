/**
 * The staff door, wired (role dashboards design, 2026-09-29).
 *
 * Role, then straight into that role's dashboard. The three API clients
 * already speak the same shape — capabilities, session, login — so this page
 * treats them as one kind of thing and never knows more about a role than
 * where its dashboard lives.
 */

import type { ApiResult } from "./api.ts";
import { ReviewerApiClient } from "./reviewer-api.ts";
import { StaffApiClient } from "./staff-api.ts";
import { SupervisorApiClient } from "./supervisor-api.ts";
import { destinationFor, roleFromHash, usablePrincipals, type StaffRole } from "./team.ts";
import { markSignedInByDoor } from "./staff-door.ts";

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
  if (node === null) throw new Error(`team.html is missing #${id}`);
  return node as T;
};

const showError = (message: string | undefined): void => {
  const box = el("team-error");
  box.hidden = message === undefined;
  box.textContent = message ?? "";
};

const showRoles = (): void => {
  showError(undefined);
  el("team-accounts").hidden = true;
  el("team-roles").hidden = false;
  history.replaceState(null, "", location.pathname);
  el("team-title").textContent = "Choose your role";
  el("team-title").focus();
};

/**
 * Signs into a role and goes to its dashboard, or back to the page that sent
 * the visitor here. No account list: the role is the choice, and the server's
 * first account for it is the one used.
 */
const signInAs = async (role: StaffRole): Promise<void> => {
  showError(undefined);
  const client = clients[role];
  const next = new URLSearchParams(location.search).get("next");
  history.replaceState(null, "", `${location.pathname}${location.search}#${role}`);
  el("team-roles").hidden = true;
  el("team-accounts").hidden = false;
  el("team-title").textContent = ROLE_NAMES[role];
  const status = el("team-status");
  status.textContent = `Signing you in as ${ROLE_NAMES[role].toLowerCase()}…`;
  el("team-accounts-heading").focus();

  const session = await client.session();
  if (session.ok && session.value.authenticated) {
    markSignedInByDoor();
    location.replace(destinationFor(role, next));
    return;
  }

  const capabilities = await client.capabilities();
  if (!capabilities.ok) {
    status.textContent = "";
    showError(
      capabilities.offline
        ? "You appear to be offline. Nothing was sent."
        : "Sign-in is not available on this server right now.",
    );
    return;
  }
  const [account] = usablePrincipals(capabilities.value.demo_principals);
  if (account === undefined) {
    status.textContent = "";
    showError("No account is configured for this role on this server.");
    return;
  }
  const result = await client.login(account.credential);
  if (!result.ok) {
    status.textContent = "";
    showError("You could not be signed in just now. Try again.");
    return;
  }
  markSignedInByDoor();
  location.replace(destinationFor(role, next));
};

for (const card of document.querySelectorAll<HTMLButtonElement>("[data-role]")) {
  const role = roleFromHash(card.dataset["role"] ?? "");
  if (role !== undefined) card.addEventListener("click", () => void signInAs(role));
}
el("team-back").addEventListener("click", showRoles);

// A link straight to one role (team.html#reviewer, which a workspace page
// opened without a session uses) signs in without the extra step, and so does
// changing the hash on an open page.
const followHash = (): void => {
  const role = roleFromHash(location.hash);
  if (role !== undefined) void signInAs(role);
  else if (el("team-accounts").hidden === false) showRoles();
};
window.addEventListener("hashchange", followHash);
followHash();
