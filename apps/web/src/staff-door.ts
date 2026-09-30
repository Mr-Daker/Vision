/**
 * Getting to and from the staff door (role dashboards design, 2026-09-29).
 *
 * A workspace page opened without a session has no sign-in of its own any
 * more: it sends the visitor to the staff door for its role, which signs in
 * and sends them straight back. The one failure worth designing for is a
 * sign-in that does not stick — the door would send the visitor back, the
 * page would find no session and send them to the door again, for ever. So
 * the door marks that it has just signed somebody in, and a page that still
 * finds no session straight after reports it instead of redirecting again.
 */

import { staffDoorUrl } from "./team.ts";

const JUST_SIGNED_IN = "vision.staff-door.signed-in-at";
const WINDOW_MS = 15_000;

/** Called by the door immediately before it sends a signed-in visitor back. */
export const markSignedInByDoor = (): void => {
  try {
    window.sessionStorage.setItem(JUST_SIGNED_IN, String(Date.now()));
  } catch {
    // Storage refused (private mode, a policy): the page just loses its loop
    // guard, and a sign-in that works still works.
  }
};

/** Clears the mark once a page has confirmed its session. */
export const confirmSignedIn = (): void => {
  try {
    window.sessionStorage.removeItem(JUST_SIGNED_IN);
  } catch {
    // Nothing to clear.
  }
};

/**
 * Sends this page's visitor to its staff door. Returns false — and sends
 * nobody anywhere — when the door signed them in moments ago and the session
 * is still missing, so the caller can say so rather than loop.
 */
export const sendToStaffDoor = (): boolean => {
  let justSignedIn = false;
  try {
    const at = Number(window.sessionStorage.getItem(JUST_SIGNED_IN));
    justSignedIn = at > 0 && Date.now() - at < WINDOW_MS;
    window.sessionStorage.removeItem(JUST_SIGNED_IN);
  } catch {
    justSignedIn = false;
  }
  if (justSignedIn) return false;
  window.location.replace(staffDoorUrl(window.location.pathname, window.location.hash));
  return true;
};

export const SIGN_IN_DID_NOT_STICK =
  "You were signed in, but this page could not confirm the session. Reload the page to try again.";

/** Signing out of any staff workspace ends at the two ways in, not at a sign-in form. */
export const leaveToSignIn = (): void => {
  window.location.assign("/signin.html");
};
