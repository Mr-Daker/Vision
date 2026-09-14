/**
 * Dataset integrity and aggregation (Public Intelligence).
 *
 * The page's whole claim is that the numbers on screen come from the records
 * beneath them. These assert that — at every level, in both directions — and
 * that the dataset itself is reproducible rather than a lucky snapshot.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

import {
  applyFilters,
  CATEGORY_FAMILIES,
  familyOf,
  getDuplicateClusterCount,
  getPeopleAffected,
  getSeverityDistribution,
  getTopIssueTypes,
  hasActiveFilters,
  NO_FILTERS,
} from "./issue-aggregation.ts";
import { buildCountryHierarchy, findNode, nearestSurviving, pathTo } from "./hierarchy-data.ts";
import type { InfrastructureIssue, IssueSeverity } from "./intelligence.types.ts";
import type { IssueMatchState, IssueStatus } from "@vision/domain";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "../../../..");
const DATA = join(REPO, "apps/web/public/data/vision-demo-issues.json");

const payload = JSON.parse(readFileSync(DATA, "utf8")) as {
  readonly synthetic: boolean;
  readonly issues: readonly InfrastructureIssue[];
};
const ISSUES = payload.issues;

test("PI: the dataset declares itself synthetic", () => {
  // The page leans on this flag to render its disclosure. If the data ever
  // stopped saying so, the disclosure would quietly stop appearing.
  assert.equal(payload.synthetic, true);
});

test("PI: every record carries a complete hierarchy path", () => {
  for (const issue of ISSUES) {
    for (const field of ["country", "state", "stateCode", "district", "city", "id"] as const) {
      assert.ok(
        typeof issue[field] === "string" && issue[field].length > 0,
        `${issue.id} has no ${field}`,
      );
    }
    assert.equal(issue.country, "India");
  }
});

test("PI: coordinates are inside the real world", () => {
  for (const issue of ISSUES) {
    assert.ok(
      issue.latitude >= -90 && issue.latitude <= 90,
      `${issue.id} latitude ${String(issue.latitude)}`,
    );
    assert.ok(
      issue.longitude >= -180 && issue.longitude <= 180,
      `${issue.id} longitude ${String(issue.longitude)}`,
    );
  }
});

test("PI: identifiers are unique", () => {
  const seen = new Set(ISSUES.map((issue) => issue.id));
  assert.equal(seen.size, ISSUES.length, "duplicate issue ids would break node identity");
});

test("PI: lifecycle vocabulary is a subset of the domain's own", () => {
  // The page must not invent states. These two assignments fail to compile if
  // a value here is not in the domain union, which is the actual guarantee —
  // the runtime check below only covers what the dataset happens to contain.
  const statuses: readonly IssueStatus[] = [
    "created",
    "routing_review",
    "routed_internal",
    "agency_ack_received",
    "work_planned",
    "resolution_claimed",
    "resolution_confirmed",
  ];
  const matches: readonly IssueMatchState[] = [
    "pending",
    "candidates_retrieved",
    "match_confirmed",
    "ambiguous",
    "no_match",
  ];

  for (const issue of ISSUES) {
    assert.ok(statuses.includes(issue.status), `${issue.id} status ${issue.status}`);
    assert.ok(matches.includes(issue.matchState), `${issue.id} match ${issue.matchState}`);
  }
});

test("PI: no record claims a verification the system cannot perform", () => {
  // "Verified" is not a state this product has. A record carrying it would put
  // the claim in front of a policymaker in the one view built to be trusted.
  for (const issue of ISSUES) {
    const text = `${issue.title} ${issue.description} ${issue.tags.join(" ")}`.toLowerCase();
    assert.doesNotMatch(text, /\bverified\b/, `${issue.id} claims verification`);
  }
});

test("PI: severity distribution is plausible rather than uniform or alarmist", () => {
  const mix = getSeverityDistribution(ISSUES);
  const share = (n: number) => n / ISSUES.length;
  assert.ok(share(mix.critical) <= 0.1, `critical is ${(share(mix.critical) * 100).toFixed(1)}%`);
  assert.ok(share(mix.critical) >= 0.04, "some issues must be critical or the encoding is dead");
  assert.ok(share(mix.medium) > share(mix.low), "medium should dominate a real backlog");
  assert.equal(mix.low + mix.medium + mix.high + mix.critical, ISSUES.length);
});

test("PI: the country total equals the sum of its states", () => {
  const root = buildCountryHierarchy(ISSUES);
  const fromStates = root.children.reduce((sum, state) => sum + state.issueCount, 0);
  assert.equal(root.issueCount, ISSUES.length);
  assert.equal(fromStates, root.issueCount);
});

test("PI: each state total equals the sum of its cities", () => {
  const root = buildCountryHierarchy(ISSUES);
  for (const state of root.children) {
    const fromCities = state.children.reduce((sum, city) => sum + city.issueCount, 0);
    assert.equal(fromCities, state.issueCount, `${state.label} disagrees with its cities`);
  }
});

test("PI: each city total equals the sum of its categories, and of its issues", () => {
  const root = buildCountryHierarchy(ISSUES);
  for (const state of root.children) {
    for (const city of state.children) {
      const fromFamilies = city.children.reduce((sum, family) => sum + family.issueCount, 0);
      assert.equal(fromFamilies, city.issueCount, `${city.label} disagrees with its categories`);
      for (const family of city.children) {
        assert.equal(
          family.children.length,
          family.issueCount,
          `${city.label}/${family.label} has ${String(family.children.length)} leaves for ${String(family.issueCount)} issues`,
        );
      }
    }
  }
});

test("PI: people affected reconciles from leaf to root", () => {
  const root = buildCountryHierarchy(ISSUES);
  assert.equal(root.peopleAffected, getPeopleAffected(ISSUES));
  for (const state of root.children) {
    const fromCities = state.children.reduce((sum, city) => sum + city.peopleAffected, 0);
    assert.equal(fromCities, state.peopleAffected, `${state.label} affected-count disagrees`);
  }
});

test("PI: severity counts reconcile from leaf to root", () => {
  const root = buildCountryHierarchy(ISSUES);
  for (const state of root.children) {
    const critical = state.children.reduce((sum, city) => sum + city.criticalCount, 0);
    const high = state.children.reduce((sum, city) => sum + city.highCount, 0);
    assert.equal(critical, state.criticalCount, `${state.label} critical count disagrees`);
    assert.equal(high, state.highCount, `${state.label} high count disagrees`);
  }
});

test("PI: every category belongs to exactly one display family", () => {
  const seen = new Map<string, string>();
  for (const [key, family] of Object.entries(CATEGORY_FAMILIES)) {
    for (const member of family.members) {
      assert.equal(seen.get(member), undefined, `${member} is in two families`);
      seen.set(member, key);
    }
  }
  for (const issue of ISSUES) {
    assert.ok(seen.has(issue.category), `${issue.category} belongs to no family`);
    assert.equal(familyOf(issue.category), seen.get(issue.category));
  }
});

test("PI: family shares sum to the whole set", () => {
  const families = getTopIssueTypes(ISSUES);
  const total = families.reduce((sum, family) => sum + family.count, 0);
  assert.equal(total, ISSUES.length);
  const shares = families.reduce((sum, family) => sum + family.share, 0);
  assert.ok(Math.abs(shares - 1) < 1e-9, `shares summed to ${String(shares)}`);
});

test("PI: filtering never mutates the source", () => {
  const before = JSON.stringify(ISSUES);
  const filtered = applyFilters(ISSUES, {
    severities: new Set<IssueSeverity>(["critical"]),
    categories: new Set(),
    windowDays: undefined,
  });
  assert.equal(JSON.stringify(ISSUES), before, "applyFilters must not touch its input");
  assert.ok(filtered.length < ISSUES.length);
  assert.ok(filtered.every((issue) => issue.severity === "critical"));
});

test("PI: an empty filter set is the identity, not an empty result", () => {
  assert.equal(hasActiveFilters(NO_FILTERS), false);
  assert.equal(applyFilters(ISSUES, NO_FILTERS).length, ISSUES.length);
});

test("PI: the time window is measured from the data, not the wall clock", () => {
  // A fixed dataset must not slowly empty out as real time passes, which is
  // what happens when a demo filters against Date.now().
  const windowed = applyFilters(ISSUES, { ...NO_FILTERS, windowDays: 30 });
  assert.ok(windowed.length > 0, "a 30-day window over this dataset must not be empty");
  assert.ok(windowed.length < ISSUES.length, "a 30-day window must actually exclude something");
});

test("PI: breadcrumb path runs root-first and ends at the requested node", () => {
  const root = buildCountryHierarchy(ISSUES);
  const chennai = root.children
    .find((state) => state.label === "Tamil Nadu")
    ?.children.find((city) => city.label === "Chennai");
  assert.notEqual(chennai, undefined);

  const path = pathTo(root, chennai?.id ?? "");
  assert.deepEqual(
    path.map((node) => node.label),
    ["India", "Tamil Nadu", "Chennai"],
  );
  assert.deepEqual(
    path.map((node) => node.level),
    ["country", "state", "city"],
  );
});

test("PI: the demo walk-through resolves end to end", () => {
  // India → Tamil Nadu → Chennai → Drainage → the hero issue. If this breaks,
  // the scripted demonstration breaks with it.
  const root = buildCountryHierarchy(ISSUES);
  const tn = root.children.find((s) => s.label === "Tamil Nadu");
  assert.equal(tn?.issueCount, 92);

  const chennai = tn?.children.find((c) => c.label === "Chennai");
  assert.equal(chennai?.issueCount, 31);

  const grouped = (chennai?.children ?? []).map((f) => `${f.label} ${String(f.issueCount)}`);
  assert.deepEqual(grouped, [
    "Roads 11",
    "Drainage 7",
    "Water 5",
    "Street lights 4",
    "Schools 2",
    "Other 2",
  ]);

  const drainage = chennai?.children.find((f) => f.label === "Drainage");
  const hero = drainage?.children.find((n) => n.issue?.id === "VIS-TN-0042");
  assert.notEqual(hero, undefined, "the hero issue must sit under Chennai / Drainage");
  assert.equal(hero?.issue?.severity, "high");
  assert.equal(hero?.issue?.citizenReportsCount, 12);
  assert.equal(hero?.issue?.matchState, "match_confirmed");
  assert.equal(hero?.issue?.status, "routed_internal");
  assert.ok((hero?.issue?.estimatedPeopleAffected ?? 0) >= 2000);
});

test("PI: a node removed by a filter falls back to its nearest surviving ancestor", () => {
  const onlyCritical = applyFilters(ISSUES, {
    severities: new Set<IssueSeverity>(["critical"]),
    categories: new Set(),
    windowDays: undefined,
  });
  const root = buildCountryHierarchy(onlyCritical);
  // Durgapur has two issues in the full set and none of them critical.
  const survivor = nearestSurviving(root, "in/west-bengal/durgapur/roads");
  assert.equal(
    findNode(root, "in/west-bengal/durgapur/roads"),
    undefined,
    "this node should not survive a critical-only filter",
  );
  assert.ok(
    ["country", "state", "city"].includes(survivor.level),
    `expected a surviving ancestor, got ${survivor.level}`,
  );
  assert.ok(survivor.issueCount > 0, "an ancestor we fall back to must have something to show");
});

test("PI: duplicate clusters exist so consolidation can be shown", () => {
  const clusters = getDuplicateClusterCount(ISSUES);
  assert.ok(clusters > 20, `only ${String(clusters)} clusters — the merge story needs examples`);
  const clustered = ISSUES.filter((issue) => issue.duplicateClusterId !== undefined);
  assert.ok(clustered.length > clusters, "a cluster should represent more than one report");
});

test("PI: regenerating from the seed reproduces the committed dataset", () => {
  const scratch = join(tmpdir(), `vision-demo-regen-${String(process.pid)}.json`);
  execFileSync("node", [join(REPO, "tools/generate-demo-issues.mjs"), scratch], { cwd: REPO });
  assert.equal(
    readFileSync(scratch, "utf8"),
    readFileSync(DATA, "utf8"),
    "the generator is not deterministic, or the committed file is stale",
  );
});
