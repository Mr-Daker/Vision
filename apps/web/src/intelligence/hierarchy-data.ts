/**
 * Builds the drill-down hierarchy the visualisation renders.
 *
 *   country → state → city → category family → issue
 *
 * Every node's counts are computed from the issues beneath it, so a parent can
 * never disagree with its children. The visualisation consumes this tree and
 * does no arithmetic of its own — layout code that also aggregates is how a
 * node ends up showing a number nothing else in the interface agrees with.
 */

import {
  familyLabel,
  familyOf,
  getPeopleAffected,
  getSeverityDistribution,
  type CategoryFamilyKey,
} from "./issue-aggregation.ts";
import type { HierarchyNode, InfrastructureIssue } from "./intelligence.types.ts";

/** Node ids are path-shaped so a node can be addressed without a tree walk. */
export const ROOT_ID = "in";

const slug = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

const summarise = (
  id: string,
  level: HierarchyNode["level"],
  label: string,
  issues: readonly InfrastructureIssue[],
  children: readonly HierarchyNode[],
  issue?: InfrastructureIssue,
): HierarchyNode => {
  const severityMix = getSeverityDistribution(issues);
  return {
    id,
    level,
    label,
    issueCount: issues.length,
    criticalCount: severityMix.critical,
    highCount: severityMix.high,
    peopleAffected: getPeopleAffected(issues),
    severityMix,
    children,
    ...(issue === undefined ? {} : { issue }),
  };
};

const groupBy = <T, K>(items: readonly T[], key: (item: T) => K): Map<K, T[]> => {
  const out = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const bucket = out.get(k);
    if (bucket === undefined) out.set(k, [item]);
    else bucket.push(item);
  }
  return out;
};

/** Largest first, so the biggest problem is the most prominent node. */
const byIssueCount = (a: HierarchyNode, b: HierarchyNode): number =>
  b.issueCount - a.issueCount || a.label.localeCompare(b.label);

/**
 * Same, except the catch-all family sinks to the bottom regardless of size.
 * On an alphabetical tie-break "Other" landed above "Schools", which reads as
 * though the unclassified bucket outranks a named one.
 */
const byFamily = (a: HierarchyNode, b: HierarchyNode): number => {
  const aOther = a.id.endsWith("/other");
  const bOther = b.id.endsWith("/other");
  if (aOther !== bOther) return aOther ? 1 : -1;
  return byIssueCount(a, b);
};

/**
 * Builds the whole tree from a flat issue list.
 *
 * Called once per filter change rather than per frame. At 428 records this is
 * well under a millisecond, and doing it eagerly means the layout and the rail
 * always read the same numbers.
 */
export const buildCountryHierarchy = (issues: readonly InfrastructureIssue[]): HierarchyNode => {
  const states = [...groupBy(issues, (issue) => issue.state).entries()]
    .map(([stateName, stateIssues]) => {
      const stateId = `${ROOT_ID}/${slug(stateName)}`;

      const cities = [...groupBy(stateIssues, (issue) => issue.city).entries()]
        .map(([cityName, cityIssues]) => {
          const cityId = `${stateId}/${slug(cityName)}`;

          const families = [...groupBy(cityIssues, (issue) => familyOf(issue.category)).entries()]
            .map(([familyKey, familyIssues]) => {
              const familyId = `${cityId}/${familyKey}`;
              const leaves = familyIssues
                .map((issue) =>
                  summarise(`${familyId}/${issue.id}`, "issue", issue.title, [issue], [], issue),
                )
                // Most-reported first: the issue with the most citizen evidence
                // behind it is the one a policymaker should see first.
                .sort(
                  (a, b) =>
                    (b.issue?.citizenReportsCount ?? 0) - (a.issue?.citizenReportsCount ?? 0) ||
                    a.label.localeCompare(b.label),
                );
              return summarise(
                familyId,
                "category",
                familyLabel(familyKey as CategoryFamilyKey),
                familyIssues,
                leaves,
              );
            })
            .sort(byFamily);

          return summarise(cityId, "city", cityName, cityIssues, families);
        })
        .sort(byIssueCount);

      return summarise(stateId, "state", stateName, stateIssues, cities);
    })
    .sort(byIssueCount);

  return summarise(ROOT_ID, "country", "India", issues, states);
};

/**
 * The chain from the root down to `id`, root first. Empty when the id is not in
 * this tree — which happens legitimately when a filter removes the node the
 * viewer was looking at, and the caller walks back up the returned path.
 */
export const pathTo = (root: HierarchyNode, id: string): readonly HierarchyNode[] => {
  if (root.id === id) return [root];
  for (const child of root.children) {
    // Ids are path-shaped, so a subtree that cannot contain the target is
    // skipped without descending into it.
    if (!id.startsWith(`${child.id}/`) && child.id !== id) continue;
    const below = pathTo(child, id);
    if (below.length > 0) return [root, ...below];
  }
  return [];
};

export const findNode = (root: HierarchyNode, id: string): HierarchyNode | undefined => {
  const path = pathTo(root, id);
  return path.length === 0 ? undefined : path[path.length - 1];
};

/**
 * The deepest ancestor of `id` that still exists in `root`, falling back to the
 * root itself. Used when a filter removes the focused node: the view walks up
 * to the nearest place that still has something to show rather than snapping
 * all the way home.
 */
export const nearestSurviving = (root: HierarchyNode, id: string): HierarchyNode => {
  const segments = id.split("/");
  for (let depth = segments.length; depth > 0; depth -= 1) {
    const candidate = findNode(root, segments.slice(0, depth).join("/"));
    if (candidate !== undefined) return candidate;
  }
  return root;
};
