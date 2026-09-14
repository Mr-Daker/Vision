/**
 * Derived summaries over the demonstration dataset.
 *
 * Everything the interface reports is computed here from the raw records. No
 * summary value is written down a second time: a headline that disagrees with
 * the rows beneath it is the classic way a dashboard starts lying, and
 * `issue-aggregation.test.ts` asserts the totals reconcile at every level.
 *
 * Pure, and free of DOM access, so the numbers can be checked without a browser.
 */

import type {
  InfrastructureIssue,
  IntelligenceFilters,
  IssueCategory,
  IssueSeverity,
  SeverityMix,
} from "./intelligence.types.ts";

/**
 * Display families. Thirteen categories is the right granularity for a record
 * and far too much for a node diagram, so related ones are grouped for display
 * while the underlying record keeps its specific category.
 */
export const CATEGORY_FAMILIES = {
  roads: { label: "Roads", members: ["road_damage", "pothole", "bridge"] },
  drainage: { label: "Drainage", members: ["drainage"] },
  water: { label: "Water", members: ["water_supply"] },
  lighting: { label: "Street lights", members: ["street_light"] },
  schools: { label: "Schools", members: ["school"] },
  sanitation: { label: "Sanitation & waste", members: ["sanitation", "waste"] },
  other: {
    label: "Other",
    members: ["traffic_signal", "public_transport", "public_health_facility", "other"],
  },
} as const satisfies Record<string, { label: string; members: readonly IssueCategory[] }>;

export type CategoryFamilyKey = keyof typeof CATEGORY_FAMILIES;

const FAMILY_OF: ReadonlyMap<IssueCategory, CategoryFamilyKey> = new Map(
  Object.entries(CATEGORY_FAMILIES).flatMap(([key, family]) =>
    family.members.map((member) => [member, key as CategoryFamilyKey] as const),
  ),
);

export const familyOf = (category: IssueCategory): CategoryFamilyKey =>
  FAMILY_OF.get(category) ?? "other";

export const familyLabel = (key: CategoryFamilyKey): string => CATEGORY_FAMILIES[key].label;

/** Human label for a specific category, used on an issue rather than a group. */
export const CATEGORY_LABELS: Record<IssueCategory, string> = {
  road_damage: "Road damage",
  pothole: "Potholes",
  drainage: "Drainage",
  street_light: "Street lighting",
  water_supply: "Water supply",
  sanitation: "Sanitation",
  bridge: "Bridges and crossings",
  school: "School infrastructure",
  public_health_facility: "Public health facility",
  waste: "Waste",
  traffic_signal: "Traffic signals",
  public_transport: "Public transport",
  other: "Other",
};

export const SEVERITY_ORDER: readonly IssueSeverity[] = ["critical", "high", "medium", "low"];

export const getSeverityDistribution = (issues: readonly InfrastructureIssue[]): SeverityMix => {
  const mix = { low: 0, medium: 0, high: 0, critical: 0 };
  for (const issue of issues) mix[issue.severity] += 1;
  return mix;
};

export const getOpenIssueCount = (issues: readonly InfrastructureIssue[]): number =>
  issues.filter((issue) => issue.status !== "resolution_confirmed").length;

export const getPeopleAffected = (issues: readonly InfrastructureIssue[]): number =>
  issues.reduce((total, issue) => total + issue.estimatedPeopleAffected, 0);

/**
 * Distinct consolidation clusters. Counts clusters, not clustered issues — the
 * interesting number is how many separate physical problems drew repeat
 * reports, not how many records carry a cluster id.
 */
export const getDuplicateClusterCount = (issues: readonly InfrastructureIssue[]): number => {
  const clusters = new Set<string>();
  for (const issue of issues) {
    if (issue.duplicateClusterId !== undefined) clusters.add(issue.duplicateClusterId);
  }
  return clusters.size;
};

export type FamilyTally = {
  readonly key: CategoryFamilyKey;
  readonly label: string;
  readonly count: number;
  readonly share: number;
};

/** Family tallies, largest first. Shares are of the supplied set, not of all. */
export const getTopIssueTypes = (
  issues: readonly InfrastructureIssue[],
  limit = Number.POSITIVE_INFINITY,
): readonly FamilyTally[] => {
  const counts = new Map<CategoryFamilyKey, number>();
  for (const issue of issues) {
    const key = familyOf(issue.category);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({
      key,
      label: familyLabel(key),
      count,
      share: issues.length === 0 ? 0 : count / issues.length,
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, limit);
};

export type PlaceTally = { readonly name: string; readonly count: number };

const tallyBy = (
  issues: readonly InfrastructureIssue[],
  field: (issue: InfrastructureIssue) => string,
  limit: number,
): readonly PlaceTally[] => {
  const counts = new Map<string, number>();
  for (const issue of issues) {
    const key = field(issue);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit);
};

export const getStateSummary = (
  issues: readonly InfrastructureIssue[],
  limit = 10,
): readonly PlaceTally[] => tallyBy(issues, (issue) => issue.state, limit);

export const getCitySummary = (
  issues: readonly InfrastructureIssue[],
  limit = 10,
): readonly PlaceTally[] => tallyBy(issues, (issue) => issue.city, limit);

export const getIssueCategorySummary = (
  issues: readonly InfrastructureIssue[],
): readonly FamilyTally[] => getTopIssueTypes(issues);

/** The newest `reportedAt` in the set, as epoch ms, or undefined when empty. */
export const newestReportedAt = (issues: readonly InfrastructureIssue[]): number | undefined => {
  let newest: number | undefined;
  for (const issue of issues) {
    const at = Date.parse(issue.reportedAt);
    if (newest === undefined || at > newest) newest = at;
  }
  return newest;
};

export const NO_FILTERS: IntelligenceFilters = {
  severities: new Set(),
  categories: new Set(),
  windowDays: undefined,
};

export const hasActiveFilters = (filters: IntelligenceFilters): boolean =>
  filters.severities.size > 0 || filters.categories.size > 0 || filters.windowDays !== undefined;

/**
 * Applies the filters, returning a new array. The source is never mutated —
 * the visualisation animates between filtered views and has to be able to go
 * back to the full set without reloading anything.
 *
 * The time window is measured from the dataset's own newest report rather than
 * from the wall clock, so a fixed demonstration dataset does not quietly empty
 * out as real time passes.
 */
export const applyFilters = (
  issues: readonly InfrastructureIssue[],
  filters: IntelligenceFilters,
): readonly InfrastructureIssue[] => {
  if (!hasActiveFilters(filters)) return issues;

  const newest = newestReportedAt(issues);
  const cutoff =
    filters.windowDays === undefined || newest === undefined
      ? undefined
      : newest - filters.windowDays * 86_400_000;

  return issues.filter((issue) => {
    if (filters.severities.size > 0 && !filters.severities.has(issue.severity)) return false;
    if (filters.categories.size > 0 && !filters.categories.has(issue.category)) return false;
    if (cutoff !== undefined && Date.parse(issue.reportedAt) < cutoff) return false;
    return true;
  });
};

/** Compact number for a node label: 1200 → "1.2K", 1_200_000 → "1.2M". */
export const compactNumber = (value: number): string => {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}K`;
  return String(value);
};
