/**
 * The resident dashboard's four options (role dashboards design, 2026-09-29).
 *
 * One task on screen at a time, each addressed by a hash so the back button
 * and a shared link both land where they should.
 */

import type { StringKey } from "./locales/strings.ts";

export const RESIDENT_VIEWS = ["report", "reports", "lookup", "nearby"] as const;

export type ResidentView = (typeof RESIDENT_VIEWS)[number];

export const DEFAULT_RESIDENT_VIEW: ResidentView = "report";

/**
 * The page heading for each view. Keys that already exist, so no heading is
 * waiting on a translation.
 */
export const RESIDENT_VIEW_TITLES: Readonly<Record<ResidentView, StringKey>> = {
  report: "app.tagline",
  reports: "tracking.heading",
  lookup: "lookup.heading",
  nearby: "discovery.heading",
};
