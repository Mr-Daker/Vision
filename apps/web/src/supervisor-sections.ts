/**
 * The supervisor dashboard's three parts (supervisor sections design,
 * 2026-09-29).
 *
 * The page used to be one 15,500px column: counts, notes, every waiting issue
 * in full, and the durability panel under all of it. Now it is three parts,
 * one on screen at a time, and each queue has an address of its own
 * (`#queues/overdue`), so the sidebar is plain links and the back button walks
 * through them.
 */

import type { SupervisorQueueId } from "./supervisor-view.ts";

export const SUPERVISOR_VIEWS = ["overview", "queues", "durability"] as const;

export type SupervisorView = (typeof SUPERVISOR_VIEWS)[number];

const QUEUES: readonly SupervisorQueueId[] = [
  "unacknowledged",
  "overdue",
  "escalated",
  "disputed",
  "reopened",
];

/** The page heading for each part. */
export const SUPERVISOR_VIEW_TITLES: Readonly<Record<SupervisorView, string>> = {
  overview: "At a glance",
  queues: "What is still waiting",
  durability: "Did the work last?",
};

export type SupervisorLocation = {
  readonly view: SupervisorView;
  readonly queue: SupervisorQueueId | "all";
};

export const parseSupervisorHash = (hash: string): SupervisorLocation => {
  const [head = "", tail = ""] = hash.replace(/^#/, "").trim().split("/");
  // The anchor the district dashboard and comparison pages linked to before
  // durability had a part of its own.
  if (head === "durability" || head === "durability-heading") {
    return { view: "durability", queue: "all" };
  }
  if (head === "queues") {
    const queue = QUEUES.find((candidate) => candidate === tail);
    return { view: "queues", queue: queue ?? "all" };
  }
  return { view: "overview", queue: "all" };
};

export const supervisorHash = (view: SupervisorView, queue: SupervisorQueueId | "all"): string =>
  view === "queues" && queue !== "all" ? `#queues/${queue}` : `#${view}`;
