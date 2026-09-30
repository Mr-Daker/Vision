/**
 * The staff door (role dashboards design, 2026-09-29).
 *
 * Three roles, three separate sessions on the server (V015). This page asks
 * which role, signs into that one, and hands over to that role's own
 * dashboard — so a department staffer never meets a review queue they have no
 * grant for, and nobody signs in twice.
 */

export type StaffRole = "department" | "reviewer" | "supervisor";

export const STAFF_ROLES: readonly StaffRole[] = ["department", "reviewer", "supervisor"];

export const ROLE_HOME: Readonly<Record<StaffRole, string>> = {
  department: "/staff.html",
  reviewer: "/reviewer.html",
  supervisor: "/supervisor.html",
};

/** Every page each role's session opens. The supervisor's session spans three. */
const ROLE_PAGES: Readonly<Record<StaffRole, readonly string[]>> = {
  department: ["/staff.html"],
  reviewer: ["/reviewer.html"],
  supervisor: ["/supervisor.html", "/dashboard.html", "/compare.html"],
};

/** Which role's door a workspace page sends a visitor without a session to. */
export const roleForPage = (pathname: string): StaffRole | undefined =>
  STAFF_ROLES.find((role) => ROLE_PAGES[role].includes(pathname));

/**
 * Where to go once signed in: back to the page that sent the visitor, if that
 * page belongs to this role, otherwise the role's home.
 *
 * Only a path on this site's own list is accepted, with at most a plain
 * section hash, so `next` cannot be used to send somebody anywhere else.
 */
export const destinationFor = (role: StaffRole, next: string | null): string => {
  if (next === null) return ROLE_HOME[role];
  const match = /^(\/[a-z]+\.html)(#[a-z/-]*)?$/.exec(next);
  if (match === null) return ROLE_HOME[role];
  const [, path = "", hash = ""] = match;
  return ROLE_PAGES[role].includes(path) ? `${path}${hash}` : ROLE_HOME[role];
};

/**
 * The staff door for a workspace page opened without a session: that page's
 * role, and a `next` that brings the visitor back to exactly where they were.
 */
export const staffDoorUrl = (pathname: string, hash: string): string => {
  const role = roleForPage(pathname);
  if (role === undefined) return "/team.html";
  return `/team.html?next=${encodeURIComponent(`${pathname}${hash}`)}#${role}`;
};

export const roleFromHash = (hash: string): StaffRole | undefined => {
  const name = hash.replace(/^#/, "").trim();
  return STAFF_ROLES.find((role) => role === name);
};

export type DemoPrincipal = { readonly credential: string; readonly label: string };

/**
 * A principal the page can actually offer. Anything malformed is not a button,
 * and neither is a revoked credential: a button that fails after somebody has
 * committed to it is worse than one that is not there.
 */
export const usablePrincipals = (value: unknown): readonly DemoPrincipal[] => {
  if (!Array.isArray(value)) return [];
  const result: DemoPrincipal[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const credential = record["credential"];
    const label = record["label"];
    const state = record["credential_state"];
    if (typeof credential !== "string" || credential.length === 0) continue;
    if (typeof label !== "string" || label.length === 0) continue;
    if (state !== undefined && state !== "active") continue;
    result.push({ credential, label });
  }
  return result;
};
