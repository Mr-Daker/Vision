/**
 * Contextual intelligence rail.
 *
 * Re-reads whatever node is in focus and reports what the dataset says about
 * it. Every figure comes from the hierarchy the graph is drawing, so the rail
 * and the nodes can never disagree — the rail computes nothing of its own.
 *
 * Deliberately not a wall of cards: a headline, one breakdown, and one or two
 * signals per level. Twenty tiles would bury the thing the page is for.
 */

import {
  compactNumber,
  getDuplicateClusterCount,
  getTopIssueTypes,
  type FamilyTally,
} from "./issue-aggregation.ts";
import type { HierarchyNode, InfrastructureIssue } from "./intelligence.types.ts";

const collectIssues = (
  node: HierarchyNode,
  into: InfrastructureIssue[] = [],
): InfrastructureIssue[] => {
  if (node.issue !== undefined) into.push(node.issue);
  for (const child of node.children) collectIssues(child, into);
  return into;
};

const element = (tag: string, className?: string, text?: string): HTMLElement => {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const metric = (value: string, label: string): HTMLElement => {
  const wrap = element("div", "rail-metric");
  wrap.append(
    element("span", "rail-metric-value", value),
    element("span", "rail-metric-label", label),
  );
  return wrap;
};

/** A labelled bar. Width is the share, which is the only thing it encodes. */
const bar = (tally: FamilyTally): HTMLElement => {
  const row = element("div", "rail-bar");
  const head = element("div", "rail-bar-head");
  head.append(
    element("span", "rail-bar-label", tally.label),
    element("span", "rail-bar-value", `${String(Math.round(tally.share * 100))}%`),
  );
  const track = element("div", "rail-bar-track");
  const fill = element("span", "rail-bar-fill");
  // CSSOM rather than a style attribute: the CSP forbids parsed inline styles.
  fill.style.width = `${(tally.share * 100).toFixed(1)}%`;
  track.append(fill);
  row.append(head, track);
  return row;
};

const rankedList = (items: readonly { name: string; count: number }[]): HTMLElement => {
  const list = element("ol", "rail-rank");
  for (const [index, item] of items.entries()) {
    const row = element("li", "rail-rank-row");
    row.append(
      element("span", "rail-rank-index", String(index + 1).padStart(2, "0")),
      element("span", "rail-rank-name", item.name),
      element("span", "rail-rank-count", String(item.count)),
    );
    list.append(row);
  }
  return list;
};

const section = (title: string, body: HTMLElement): HTMLElement => {
  const wrap = element("section", "rail-section");
  wrap.append(element("h3", "rail-section-title", title), body);
  return wrap;
};

/**
 * Renders the rail for the focused node.
 *
 * Severity is reported as counts rather than as a score. There is no composite
 * "risk index" here and there should not be: nothing in this system is
 * calibrated to produce one, and a single invented number is exactly what a
 * policymaker would quote onward.
 */
export const renderRail = (host: HTMLElement, node: HierarchyNode): void => {
  const issues = collectIssues(node);
  const families = getTopIssueTypes(issues, 4);
  const clusters = getDuplicateClusterCount(issues);

  const frame = document.createDocumentFragment();

  const head = element("header", "rail-head");
  head.append(
    element("p", "rail-eyebrow", node.level === "country" ? "Country" : node.level),
    element("h2", "rail-title", node.label),
  );
  frame.append(head);

  const metrics = element("div", "rail-metrics");
  metrics.append(
    metric(compactNumber(node.issueCount), node.issueCount === 1 ? "issue" : "issues"),
    metric(compactNumber(node.criticalCount + node.highCount), "critical or high"),
    metric(compactNumber(node.peopleAffected), "people affected"),
  );
  frame.append(metrics);

  if (families.length > 0) {
    const bars = element("div", "rail-bars");
    for (const family of families) bars.append(bar(family));
    frame.append(section("Top signals", bars));
  }

  // Which places carry the weight — only meaningful above city level.
  if (node.level === "country" || node.level === "state") {
    const ranked = node.children
      .slice(0, 3)
      .map((child) => ({ name: child.label, count: child.issueCount }));
    if (ranked.length > 0) {
      frame.append(
        section(node.level === "country" ? "Most reported" : "Most affected", rankedList(ranked)),
      );
    }
  }

  if (node.level === "city" || node.level === "category") {
    const breakdown = element("ul", "rail-breakdown");
    for (const child of node.children.slice(0, 6)) {
      const row = element("li", "rail-breakdown-row");
      row.append(
        element("span", "rail-breakdown-count", String(child.issueCount)),
        element("span", "rail-breakdown-label", child.label),
      );
      breakdown.append(row);
    }
    if (node.children.length > 0) frame.append(section("Breakdown", breakdown));
  }

  if (clusters > 0) {
    const body = element("div", "rail-note-body");
    body.append(
      element("p", "rail-note-value", String(clusters)),
      element(
        "p",
        "rail-note-text",
        clusters === 1
          ? "group of repeat reports consolidated into one issue"
          : "groups of repeat reports consolidated into one issue each",
      ),
    );
    frame.append(section("Repeated citizen evidence", body));
  }

  const severity = element("div", "rail-severity");
  for (const [key, count] of [
    ["Critical", node.severityMix.critical],
    ["High", node.severityMix.high],
    ["Medium", node.severityMix.medium],
    ["Low", node.severityMix.low],
  ] as const) {
    const row = element("div", "rail-severity-row");
    row.dataset["severity"] = key.toLowerCase();
    row.append(
      element("span", "rail-severity-key", key),
      element("span", "rail-severity-count", String(count)),
    );
    severity.append(row);
  }
  frame.append(section("Severity as reported", severity));

  host.replaceChildren(frame);
};
