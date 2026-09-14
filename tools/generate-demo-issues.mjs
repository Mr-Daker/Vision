#!/usr/bin/env node
/**
 * Generates the Public Intelligence demonstration dataset.
 *
 * Deterministic: the same seed produces byte-identical output, so the demo is
 * the same on every machine and a diff shows a real change rather than noise.
 * The generated file is committed — the page must not depend on a build step
 * having been run, and a reviewer should be able to read the data.
 *
 *   node tools/generate-demo-issues.mjs
 *
 * To change the dataset size, edit `issueCount` on a city in
 * `apps/web/src/intelligence/fixtures/demo-geography.ts` and re-run. The total
 * is derived from those numbers, never written down separately.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const { DEMO_STATES } = await import("../apps/web/src/intelligence/fixtures/demo-geography.ts");

const SEED = 0x5f1_53a7;
/** Output path. Overridable so a test can regenerate elsewhere and compare. */
const OUT = process.argv[2] ?? join(process.cwd(), "apps/web/public/data/vision-demo-issues.json");

/** mulberry32 — small, fast, and good enough for reproducible demo data. */
const rng = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), 1 | t);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

let next = rng(SEED);
const pick = (list) => list[Math.floor(next() * list.length)];
const between = (lo, hi) => lo + Math.floor(next() * (hi - lo + 1));

/**
 * Chennai is pinned rather than weighted. It is the city the demo walks
 * through, so its shape is a fixed part of the story instead of a draw that
 * could shift the moment a weight elsewhere changes.
 * Grouped for display this reads: Roads 11, Drainage 7, Water 5,
 * Street lights 4, Schools 2, Other 2.
 */
const PINNED = {
  Chennai: {
    road_damage: 8,
    pothole: 3,
    drainage: 7,
    water_supply: 5,
    street_light: 4,
    school: 2,
    // Both land in the "Other" display family, so grouped Chennai reads
    // Roads 11 / Drainage 7 / Water 5 / Street lights 4 / Schools 2 / Other 2.
    traffic_signal: 1,
    public_transport: 1,
  },
};

/**
 * Splits a city's issue count across categories by weight, using largest
 * remainder so the parts sum to exactly the whole. Rounding each share
 * independently would drift, and a country total that does not equal the sum
 * of its states is the one defect this dataset cannot have.
 */
const allocate = (total, weights) => {
  const entries = Object.entries(weights);
  const sum = entries.reduce((acc, [, w]) => acc + w, 0);
  const exact = entries.map(([key, w]) => ({ key, want: (total * w) / sum }));
  const out = exact.map((e) => ({ key: e.key, n: Math.floor(e.want), rem: e.want % 1 }));
  let assigned = out.reduce((acc, e) => acc + e.n, 0);
  out.sort((a, b) => b.rem - a.rem);
  for (let i = 0; assigned < total; i += 1, assigned += 1) out[i % out.length].n += 1;
  return out.filter((e) => e.n > 0);
};

/**
 * Target shares. Assigned by exact allocation rather than per-record rolls:
 * rolling independently drifts, and an earlier version of this landed critical
 * at 12% when the brief asked for under 10%.
 */
const SEVERITY_SHARES = [
  ["low", 0.18],
  ["medium", 0.45],
  ["high", 0.29],
  ["critical", 0.08],
];

/**
 * How readily a category is filed as serious. A bridge defect is rarely
 * cosmetic; a bus shelter rarely life-threatening. This orders the dataset so
 * the exact allocation above lands on plausible records instead of at random.
 */
const SEVERITY_PRONENESS = {
  bridge: 0.95,
  drainage: 0.8,
  public_health_facility: 0.72,
  water_supply: 0.68,
  road_damage: 0.6,
  school: 0.58,
  pothole: 0.52,
  sanitation: 0.45,
  traffic_signal: 0.42,
  waste: 0.35,
  street_light: 0.3,
  public_transport: 0.25,
  other: 0.3,
};

const TITLES = {
  road_damage: ["Road surface broken along a stretch", "Carriageway damaged after rain"],
  pothole: ["Cluster of potholes on a junction approach", "Deep pothole on a bus route"],
  drainage: ["Storm drain blocked and overflowing", "Drainage channel obstructed"],
  street_light: ["Street lights not working along a stretch", "Unlit road at a junction"],
  water_supply: ["Piped supply interrupted for several days", "Leaking main losing water"],
  sanitation: ["Public toilet block out of service", "Sanitation facility needs repair"],
  bridge: ["Footbridge handrail damaged", "Culvert showing structural damage"],
  school: ["School boundary wall damaged", "Classroom roof leaking"],
  public_health_facility: ["Health centre water supply failing", "Clinic access road unusable"],
  waste: ["Waste not collected at a collection point", "Dumping at an unmanaged site"],
  traffic_signal: ["Signal dark at a busy junction", "Pedestrian signal not working"],
  public_transport: ["Bus shelter damaged", "Stop has no usable seating or shade"],
  other: ["Public infrastructure defect reported", "Civic asset needs attention"],
};

/**
 * One line each. The "this is synthetic" disclaimer is rendered once by the
 * page rather than repeated in all 428 records — saying it in every row made
 * the payload 40% larger and said it nowhere a reader would actually look.
 */
const DESCRIPTIONS = {
  road_damage: ["Citizen evidence describes a broken road surface affecting daily access."],
  pothole: ["Repeat reports describe potholes on an approach used by buses and two-wheelers."],
  drainage: ["Citizen evidence describes standing water following an obstructed drain."],
  street_light: ["Reports describe an unlit stretch raising night-time safety concerns."],
  water_supply: ["Reports describe interrupted piped supply across several households."],
  sanitation: ["Reports describe a public sanitation facility that is not usable."],
  bridge: ["Citizen evidence describes visible damage to a pedestrian crossing structure."],
  school: ["Reports describe damage to school premises affecting use of the building."],
  public_health_facility: ["Reports describe a facility problem affecting access to care."],
  waste: ["Reports describe uncollected waste accumulating at a collection point."],
  traffic_signal: ["Reports describe a signal that is not operating at a busy junction."],
  public_transport: ["Reports describe a damaged waiting area at a stop."],
  other: ["Citizen evidence describes a civic asset needing attention."],
};

const DEPARTMENTS = {
  road_damage: "Roads and highways (demo)",
  pothole: "Roads and highways (demo)",
  bridge: "Roads and highways (demo)",
  drainage: "Storm water and drainage (demo)",
  water_supply: "Water supply (demo)",
  sanitation: "Sanitation (demo)",
  waste: "Solid waste management (demo)",
  street_light: "Public lighting (demo)",
  school: "School infrastructure (demo)",
  public_health_facility: "Public health facilities (demo)",
  traffic_signal: "Traffic engineering (demo)",
  public_transport: "Public transport (demo)",
  other: "General civic works (demo)",
};

const STATUSES = [
  "created",
  "routing_review",
  "routed_internal",
  "agency_ack_received",
  "work_planned",
  "resolution_claimed",
  "resolution_confirmed",
];

const MATCH_STATES = [
  "pending",
  "candidates_retrieved",
  "match_confirmed",
  "ambiguous",
  "no_match",
];

/** Newest report in the set. Fixed so the time filter is reproducible too. */
const NOW = Date.parse("2026-09-10T09:00:00.000Z");
const DAY = 86_400_000;

const issues = [];
let serial = 0;
let clusterSerial = 0;

for (const state of DEMO_STATES) {
  for (const city of state.cities) {
    const weights = PINNED[city.name] ?? city.weights;
    const allocation = PINNED[city.name]
      ? Object.entries(weights).map(([key, n]) => ({ key, n }))
      : allocate(city.issueCount, weights);

    for (const { key: category, n } of allocation) {
      for (let i = 0; i < n; i += 1) {
        serial += 1;
        const proneness = (SEVERITY_PRONENESS[category] ?? 0.3) * 0.7 + next() * 0.3;
        const reports = between(1, 14);

        const ageDays = between(0, 180);
        const reportedAt = new Date(NOW - ageDays * DAY).toISOString();
        const updatedAt = new Date(NOW - between(0, Math.max(0, ageDays - 1)) * DAY).toISOString();

        const device = next() < 0.78;
        const jitter = () => (next() - 0.5) * 0.09;

        issues.push({
          id: `VIS-${state.code}-${String(serial).padStart(4, "0")}`,
          country: "India",
          countryCode: "IN",
          state: state.name,
          stateCode: state.code,
          district: city.district,
          city: city.name,
          locality: pick(city.localities),
          latitude: Number((city.lat + jitter()).toFixed(5)),
          longitude: Number((city.lon + jitter()).toFixed(5)),
          category,
          title: pick(TITLES[category] ?? TITLES.other),
          description: pick(DESCRIPTIONS[category] ?? DESCRIPTIONS.other),
          severity: "medium",
          proneness,
          status: pick(STATUSES),
          matchState: pick(MATCH_STATES),
          reportedAt,
          updatedAt,
          citizenReportsCount: reports,
          estimatedPeopleAffected: reports * between(80, 420),
          department: DEPARTMENTS[category] ?? DEPARTMENTS.other,
          source: next() < 0.86 ? "citizen_upload" : next() < 0.6 ? "field_staff" : "department",
          classificationConfidence: Number((0.62 + next() * 0.35).toFixed(2)),
          locationCaptureMethod: device ? "device" : "manual",
          ...(device ? { locationAccuracyMetres: between(4, 40) } : {}),
          tags: [category],
        });
      }
    }
  }
}

/**
 * Severity, allocated exactly rather than rolled.
 *
 * Records are ordered by how readily their category is filed as serious, then
 * the target shares are cut off that ordering. The result hits the intended mix
 * to the record while still putting the critical ones on bridges and drains
 * rather than on bus shelters.
 */
const ordered = [...issues].sort((a, b) => b.proneness - a.proneness);
// Most-prone first, so the share list is walked from critical down. The last
// slice takes the remainder, which is what makes the parts sum to the whole.
const REVERSED = [...SEVERITY_SHARES].reverse();
let cursor = 0;
for (const [index, [name, share]] of REVERSED.entries()) {
  const isLast = index === REVERSED.length - 1;
  const take = isLast ? ordered.length - cursor : Math.round(issues.length * share);
  for (const issue of ordered.slice(cursor, cursor + take)) issue.severity = name;
  cursor += take;
}

for (const issue of issues) {
  delete issue.proneness;
  issue.tags = [issue.category, issue.severity];
  // Report volume follows severity: a critical issue is one many people notice.
  if (issue.severity === "low") issue.citizenReportsCount = Math.min(issue.citizenReportsCount, 4);
  if (issue.severity === "critical")
    issue.citizenReportsCount = Math.max(issue.citizenReportsCount, 6);
  issue.estimatedPeopleAffected =
    issue.citizenReportsCount * Math.round(80 + ((issue.latitude * 37) % 340));
}

/**
 * Duplicate clusters.
 *
 * A cluster is several records that describe one physical problem. The first
 * version of this gave every clustered record its own id, which produced 191
 * clusters of exactly one — a label rather than a consolidation, and useless
 * for showing the merge the product is built around. Clusters are now formed
 * within a single city and category, which is the only place repeat reports of
 * one problem could plausibly land.
 */
const clusterKey = (issue) => `${issue.city}|${issue.category}`;
const buckets = new Map();
for (const issue of issues) {
  const key = clusterKey(issue);
  const bucket = buckets.get(key);
  if (bucket === undefined) buckets.set(key, [issue]);
  else bucket.push(issue);
}

for (const bucket of buckets.values()) {
  let index = 0;
  while (index + 1 < bucket.length) {
    // Not every repeat is a duplicate; roughly half of the eligible runs merge.
    if (next() < 0.45) {
      index += 1;
      continue;
    }
    const size = Math.min(bucket.length - index, between(2, 4));
    clusterSerial += 1;
    const id = `CL-${String(clusterSerial).padStart(3, "0")}`;
    for (let n = 0; n < size; n += 1) {
      bucket[index + n].duplicateClusterId = id;
      // A consolidated issue is one the matcher actually settled.
      bucket[index + n].matchState = "match_confirmed";
    }
    index += size;
  }
}

/**
 * The issue the demo walks to. Planted rather than drawn, because the
 * walk-through has to land on the same record every time. It takes over a
 * Chennai drainage record, so the city and category totals are unchanged, and
 * swaps IDs with whichever record already held VIS-TN-0042 so the set stays
 * unique.
 */
const heroIndex = issues.findIndex((i) => i.city === "Chennai" && i.category === "drainage");
if (heroIndex === -1) throw new Error("expected a Chennai drainage issue to promote");

const HERO_ID = "VIS-TN-0042";
const displaced = issues.findIndex((i) => i.id === HERO_ID);
if (displaced !== -1 && displaced !== heroIndex) issues[displaced].id = issues[heroIndex].id;

issues[heroIndex] = {
  ...issues[heroIndex],
  id: HERO_ID,
  title: "Persistent drainage overflow near a public-school corridor",
  description:
    "Repeated citizen reports describe standing water across a pedestrian corridor used to " +
    "reach a school, following an obstructed storm drain. Twelve separate reports were " +
    "consolidated into this issue.",
  severity: "high",
  status: "routed_internal",
  matchState: "match_confirmed",
  citizenReportsCount: 12,
  estimatedPeopleAffected: 3400,
  duplicateClusterId: "CL-HERO",
  locationCaptureMethod: "device",
  locationAccuracyMetres: 8,
  classificationConfidence: 0.94,
  tags: ["drainage", "high", "school_access"],
};

/**
 * Real cluster-mates for the hero. The demo says several reports of one
 * drainage problem were consolidated, so three other Chennai drainage records
 * join its cluster — a viewer can count them instead of taking it on trust.
 */
const heroMates = issues
  .filter((i) => i.city === "Chennai" && i.category === "drainage" && i.id !== HERO_ID)
  .slice(0, 3);
for (const mate of heroMates) {
  mate.duplicateClusterId = "CL-HERO";
  mate.matchState = "match_confirmed";
  // Moved next to the hero as well as into its cluster. Reports of one physical
  // problem are metres apart, and the spatial panel refuses to clamp a marker
  // that falls outside its span — cluster-mates left scattered across the city
  // simply did not appear, which made the merge impossible to see.
  mate.latitude = Number((issues[heroIndex].latitude + (next() - 0.5) * 0.0009).toFixed(5));
  mate.longitude = Number((issues[heroIndex].longitude + (next() - 0.5) * 0.0009).toFixed(5));
}

/**
 * A cluster of one is a label, not a consolidation. Dropped rather than left
 * for the interface to count as evidence of repeated reporting.
 */
const clusterSizes = new Map();
for (const issue of issues) {
  if (issue.duplicateClusterId === undefined) continue;
  clusterSizes.set(issue.duplicateClusterId, (clusterSizes.get(issue.duplicateClusterId) ?? 0) + 1);
}
for (const issue of issues) {
  if (issue.duplicateClusterId !== undefined && clusterSizes.get(issue.duplicateClusterId) === 1) {
    delete issue.duplicateClusterId;
  }
}

const ids = new Set(issues.map((i) => i.id));
if (ids.size !== issues.length) throw new Error(`duplicate ids: ${issues.length - ids.size}`);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(
  OUT,
  `${JSON.stringify({ generatedFrom: "tools/generate-demo-issues.mjs", seed: SEED, synthetic: true, issues }, null, 1)}\n`,
);
console.log(`generate-demo-issues OK — ${issues.length} synthetic records written to ${OUT}`);
