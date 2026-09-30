/**
 * The sidebar shell every dashboard shares (role dashboards design, 2026-09-29).
 *
 * At desktop width the sidebar is simply there. Below it, the sidebar is a
 * drawer that slides in from the left, and while it is open it behaves like
 * the dialog it is on a phone: focus stays inside, the page behind is inert,
 * and Escape or the backdrop closes it and hands focus back to the button
 * that opened it.
 *
 * The markup contract lives in each page (there is no templating here):
 * `.shell` › `#shell-menu`, `#shell-sidebar`, `#shell-backdrop`,
 * `.shell-main`. A page without it gets a shell that does nothing, so a
 * script shared by pages can call this unconditionally.
 */

/** The view a location hash selects, or `fallback` for anything unrecognised. */
export const resolveView = <T extends string>(
  hash: string,
  views: readonly T[],
  fallback: T,
): T => {
  const name = hash.replace(/^#/, "").trim().toLowerCase();
  return (views as readonly string[]).includes(name) ? (name as T) : fallback;
};

/** Where Tab moves focus inside an open drawer; -1 when nothing is focusable. */
export const trapIndex = (current: number, count: number, backwards: boolean): number => {
  if (count <= 0) return -1;
  if (current < 0) return backwards ? count - 1 : 0;
  return backwards ? (current - 1 + count) % count : (current + 1) % count;
};

export type Shell = {
  /** Signed out, the sidebar keeps only what is not an option: the wordmark and the footer. */
  readonly setSignedIn: (signedIn: boolean, account?: string) => void;
  /** Shows the `[data-view]` region named `view` and marks its sidebar link. */
  readonly showView: (view: string) => void;
  readonly close: () => void;
};

const FOCUSABLE = "a[href], button:not([disabled]), select:not([disabled]), input:not([disabled])";

/** Kept equal to the breakpoint in shell.css. */
const DESKTOP = "(min-width: 60rem)";

const NO_SHELL: Shell = {
  setSignedIn: () => undefined,
  showView: () => undefined,
  close: () => undefined,
};

export const mountShell = (): Shell => {
  const root = document.querySelector<HTMLElement>(".shell");
  const sidebar = document.getElementById("shell-sidebar");
  const menu = document.getElementById("shell-menu");
  const backdrop = document.getElementById("shell-backdrop");
  const main = document.querySelector<HTMLElement>(".shell-main");
  if (root === null || sidebar === null || menu === null || backdrop === null || main === null) {
    return NO_SHELL;
  }
  // Everything beside the sidebar goes inert while the drawer is open —
  // the page and its footer, not only <main>.
  const content = document.querySelector<HTMLElement>(".shell-column") ?? main;
  const desktop = window.matchMedia(DESKTOP);
  const isOpen = (): boolean => root.dataset["drawer"] === "open";

  const setOpen = (open: boolean): void => {
    const drawer = open && !desktop.matches;
    root.dataset["drawer"] = drawer ? "open" : "closed";
    menu.setAttribute("aria-expanded", String(drawer));
    backdrop.hidden = !drawer;
    content.inert = drawer;
    // The current option rather than the wordmark, which would leave the page
    // on a stray Enter. No scroll: the drawer is fixed and still sliding in,
    // and asking the page to scroll to it moved the page underneath instead.
    if (drawer) {
      const start =
        sidebar.querySelector<HTMLElement>(".shell-link[aria-current]") ??
        sidebar.querySelector<HTMLElement>(FOCUSABLE);
      start?.focus({ preventScroll: true });
    }
  };

  const close = (): void => {
    const wasOpen = isOpen();
    setOpen(false);
    if (wasOpen) menu.focus();
  };

  // The drawer's own close control, in exactly the place the menu button
  // occupies. The drawer's wordmark used to sit there, so a double tap on the
  // menu opened the drawer and then followed the wordmark home. Built here
  // rather than in six copies of the markup; it takes the menu button's
  // (translated) name and reports itself as the expanded toggle it is.
  const closer = document.createElement("button");
  closer.type = "button";
  closer.className = "shell-close";
  closer.setAttribute("aria-controls", sidebar.id);
  closer.setAttribute("aria-expanded", "true");
  const glyph = document.createElement("span");
  glyph.className = "shell-close-icon";
  glyph.setAttribute("aria-hidden", "true");
  closer.append(glyph);
  sidebar.prepend(closer);
  closer.addEventListener("click", close);

  menu.addEventListener("click", () => {
    closer.setAttribute("aria-label", menu.getAttribute("aria-label") ?? "Menu");
    setOpen(!isOpen());
  });
  backdrop.addEventListener("click", close);
  // Widening past the breakpoint with the drawer open would leave the page
  // inert behind a sidebar that is no longer a drawer.
  desktop.addEventListener("change", () => setOpen(false));

  sidebar.addEventListener("keydown", (event) => {
    if (!isOpen()) return;
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== "Tab") return;
    const items = [...sidebar.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (item) => item.offsetParent !== null,
    );
    const next = trapIndex(
      items.indexOf(document.activeElement as HTMLElement),
      items.length,
      event.shiftKey,
    );
    if (next < 0) return;
    event.preventDefault();
    items[next]?.focus({ preventScroll: true });
  });

  // On a phone, choosing an option is the end of the drawer's job.
  sidebar.addEventListener("click", (event) => {
    if ((event.target as HTMLElement).closest(".shell-link") !== null) close();
  });

  setOpen(false);

  return {
    setSignedIn: (signedIn, account) => {
      root.dataset["signedIn"] = String(signedIn);
      const line = document.getElementById("shell-account");
      if (line !== null && account !== undefined) line.textContent = account;
      if (!signedIn) setOpen(false);
    },
    showView: (view) => {
      for (const region of main.querySelectorAll<HTMLElement>("[data-view]")) {
        region.hidden = region.dataset["view"] !== view;
      }
      for (const link of sidebar.querySelectorAll<HTMLElement>("[data-view-link]")) {
        if (link.dataset["viewLink"] === view) link.setAttribute("aria-current", "page");
        else link.removeAttribute("aria-current");
      }
    },
    close,
  };
};

/**
 * Sidebar buttons that stand in for a page's filter `<select>`.
 *
 * The select stays in the page and keeps its listeners, so the page script is
 * untouched: a button sets the select's value and fires the same `change` a
 * person choosing an option would, and the button for the current value is
 * marked either way.
 */
export const wireFilterLinks = (): void => {
  const buttons = [...document.querySelectorAll<HTMLButtonElement>("[data-filter-for]")];
  const sync = (selectId: string, value: string): void => {
    for (const button of buttons) {
      if (button.dataset["filterFor"] !== selectId) continue;
      if (button.dataset["filterValue"] === value) button.setAttribute("aria-current", "true");
      else button.removeAttribute("aria-current");
    }
  };
  for (const button of buttons) {
    const selectId = button.dataset["filterFor"] ?? "";
    const select = document.getElementById(selectId);
    if (!(select instanceof HTMLSelectElement)) continue;
    button.addEventListener("click", () => {
      select.value = button.dataset["filterValue"] ?? "";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      sync(selectId, select.value);
    });
    select.addEventListener("change", () => sync(selectId, select.value));
    sync(selectId, select.value);
  }
};
