import { test } from "node:test";
import assert from "node:assert/strict";

import {
  HOLDOUT_SEAL_ENV,
  HoldoutSealError,
  assetLeakage,
  coverageOf,
  holdoutMetadataOnly,
  loadAdversarialCases,
  loadAssets,
  loadDevelopmentCorpus,
  loadHoldoutCorpus,
  loadJurisdictions,
  loadRelations,
  loadResponsibilityDirectory,
  loadTaxonomy,
} from "./index.ts";

// ---------------------------------------------------------------------------
// The seal
// ---------------------------------------------------------------------------

test("V011: the holdout is sealed by default", () => {
  delete process.env[HOLDOUT_SEAL_ENV];
  assert.throws(() => loadHoldoutCorpus("scored evaluation run"), HoldoutSealError);
});

test("V011: the holdout refuses to open without a recorded reason", () => {
  process.env[HOLDOUT_SEAL_ENV] = "1";
  try {
    assert.throws(() => loadHoldoutCorpus("x"), /recorded reason/);
  } finally {
    delete process.env[HOLDOUT_SEAL_ENV];
  }
});

test("V011: the holdout opens only for an explicit evaluation run", () => {
  process.env[HOLDOUT_SEAL_ENV] = "1";
  try {
    const corpus = loadHoldoutCorpus("V046 scored evaluation run");
    assert.equal(corpus.split, "holdout");
    assert.ok(corpus.reports.length >= 8);
  } finally {
    delete process.env[HOLDOUT_SEAL_ENV];
  }
});

test("V011: holdout metadata is readable without unsealing content", () => {
  delete process.env[HOLDOUT_SEAL_ENV];
  const metadata = holdoutMetadataOnly();
  assert.equal(metadata.sealed, true);
  assert.ok(metadata.report_count > 0);
  // Metadata exposes no report text, labels or coordinates.
  assert.equal(Object.hasOwn(metadata, "reports"), false);
});

// ---------------------------------------------------------------------------
// Leakage
// ---------------------------------------------------------------------------

test("V011: development and holdout share no asset (leakage rule)", () => {
  assert.deepEqual(
    assetLeakage(),
    [],
    "an asset appearing in both splits would let a model learn the holdout's phrasing and routing",
  );
});

test("V011: relations never cross the split boundary", () => {
  const relations = loadRelations();
  const developmentIds = new Set(loadDevelopmentCorpus().reports.map((r) => r.report_id));

  const crossing: string[] = [];
  const check = (relationId: string, split: string, ids: readonly string[]) => {
    const inDevelopment = ids.filter((id) => developmentIds.has(id)).length;
    if (split === "development" && inDevelopment !== ids.length) crossing.push(relationId);
    if (split === "holdout" && inDevelopment !== 0) crossing.push(relationId);
  };

  for (const pair of relations.duplicate_pairs) {
    check(pair.relation_id, pair.split, [pair.report_a, pair.report_b]);
  }
  for (const pair of relations.nearby_distinct) {
    check(pair.relation_id, pair.split, [pair.report_a, pair.report_b]);
  }
  for (const item of relations.recurrence) {
    check(item.relation_id, item.split, [item.earlier_report, item.later_report]);
  }

  assert.deepEqual(crossing, []);
});

// ---------------------------------------------------------------------------
// Corpus completeness (V011 "done when")
// ---------------------------------------------------------------------------

test("V011: every report carries provenance, a reviewer decision and a resolved label set", () => {
  const corpus = loadDevelopmentCorpus();
  assert.equal(corpus.provenance, "team_created_synthetic");
  assert.match(corpus.notice, /SYNTHETIC/);

  const taxonomy = loadTaxonomy();
  const categories = new Set(taxonomy.categories.map((c) => c.category_id));
  const defects = new Set(
    taxonomy.categories.flatMap((c) => c.defects.map((d) => `${c.category_id}/${d.defect_id}`)),
  );

  for (const report of corpus.reports) {
    assert.ok(report.report_id.length > 0);
    assert.ok(report.reviewer.decision.length > 0, `${report.report_id} lacks a reviewer decision`);
    assert.ok(report.reviewer.notes.length > 0, `${report.report_id} lacks reviewer notes`);
    assert.ok(Array.isArray(report.unresolved_labels));

    // A label is either in the taxonomy or explicitly flagged unresolved.
    if (report.expected.category_id !== null) {
      const known = categories.has(report.expected.category_id);
      const flagged = report.unresolved_labels.includes("category_id");
      assert.ok(known || flagged, `${report.report_id}: unknown category not flagged unresolved`);
      if (known && report.expected.defect_id !== null) {
        const defectKnown = defects.has(
          `${report.expected.category_id}/${report.expected.defect_id}`,
        );
        const defectFlagged = report.unresolved_labels.includes("defect_id");
        assert.ok(
          defectKnown || defectFlagged,
          `${report.report_id}: defect '${report.expected.defect_id}' is not in the taxonomy and is not flagged`,
        );
      }
    }
  }
});

test("V011: language and category coverage is recorded for both splits", () => {
  const development = coverageOf(loadDevelopmentCorpus());
  assert.ok(development.by_language["en-IN"]! >= 3, "en-IN coverage");
  assert.ok(development.by_language["mr-IN"]! >= 3, "mr-IN coverage");
  assert.ok(Object.keys(development.by_category).length >= 5, "category breadth");
  assert.ok(development.with_unresolved_labels >= 1, "unresolved-label flags must exist");

  const holdout = holdoutMetadataOnly();
  assert.ok(holdout.locales.includes("mr-IN") && holdout.locales.includes("en-IN"));
});

test("V011: Marathi rows are honestly flagged as pending native review", () => {
  const development = loadDevelopmentCorpus();
  const marathi = development.reports.filter((r) => r.source_language === "mr-IN");
  assert.ok(marathi.length > 0);
  for (const report of marathi) {
    assert.equal(
      report.reviewer.reviewed_by,
      "pending_native_review",
      `${report.report_id}: Marathi text drafted by the team must not claim a completed review`,
    );
    assert.equal(report.reviewer.reviewed_at, null);
  }
});

test("V011: no fixture claims to carry real media bytes", () => {
  const coverage = coverageOf(loadDevelopmentCorpus());
  assert.equal(
    coverage.media_with_bytes,
    0,
    "the corpus contains no image or audio bytes; consented media collection is separate",
  );
});

// ---------------------------------------------------------------------------
// Seed material for matching and routing (V011 seeding requirement)
// ---------------------------------------------------------------------------

test("V011: taxonomy, assets, jurisdictions and routing are internally consistent", () => {
  const jurisdictions = loadJurisdictions();
  const assets = loadAssets();
  const routing = loadResponsibilityDirectory();
  const taxonomy = loadTaxonomy();

  const codes = new Set(jurisdictions.nodes.map((node) => node.internal_code));
  const categories = new Set(taxonomy.categories.map((c) => c.category_id));
  const departments = new Set(routing.departments.map((d) => d.department_id));

  for (const node of jurisdictions.nodes) {
    if (node.parent_internal_code !== null) {
      assert.ok(codes.has(node.parent_internal_code), `${node.internal_code}: unknown parent`);
    }
    assert.equal(node.external_source_code, null, "no external code without an approved source");
    assert.ok(node.boundary_multipolygon.length > 0, `${node.internal_code}: missing boundary`);
  }

  for (const asset of assets.assets) {
    assert.ok(
      codes.has(asset.jurisdiction_internal_code),
      `${asset.asset_id}: unknown jurisdiction`,
    );
    assert.ok(asset.lon > -180 && asset.lon < 180 && asset.lat > -90 && asset.lat < 90);
  }

  for (const rule of routing.rules) {
    assert.ok(codes.has(rule.jurisdiction_internal_code));
    assert.ok(categories.has(rule.category_id));
    assert.ok(departments.has(rule.department_id));
  }

  // Every simulated department must say it is simulated (V002 row 15).
  for (const department of routing.departments) {
    assert.equal(department.provider_mode, "simulated");
    assert.match(department.label, /simulated/i);
  }
});

test("V011: the routing directory has a deliberate gap so routing_review is exercised", () => {
  const routing = loadResponsibilityDirectory();
  assert.ok(routing.deliberate_gaps.length >= 1);

  const gap = routing.deliberate_gaps[0]!;
  const covered = routing.rules.some(
    (rule) =>
      rule.jurisdiction_internal_code === gap.jurisdiction_internal_code &&
      rule.category_id === gap.category_id,
  );
  assert.equal(covered, false, "a declared gap must not also be mapped");
});

test("V011: every expected routing target exists, unless review is expected", () => {
  const routing = loadResponsibilityDirectory();
  const rules = new Map(
    routing.rules.map((rule) => [
      `${rule.jurisdiction_internal_code}/${rule.category_id}`,
      rule.department_id,
    ]),
  );

  for (const report of loadDevelopmentCorpus().reports) {
    if (report.expected.routing_review_expected === true) continue;
    if (report.expected.category_id === null) continue;

    const key = `${report.jurisdiction_internal_code}/${report.expected.category_id}`;
    assert.equal(
      rules.get(key),
      report.expected.department_id,
      `${report.report_id}: expected department does not match the directory`,
    );
  }
});

// ---------------------------------------------------------------------------
// Adversarial inputs
// ---------------------------------------------------------------------------

test("V011: adversarial cases state required handling and forbidden behaviour", () => {
  const { cases } = loadAdversarialCases();
  assert.ok(cases.length >= 10, "expected a meaningful adversarial set");

  for (const item of cases) {
    assert.ok(item.required_handling.length > 20, `${item.case_id}: handling not specified`);
    assert.ok(item.must_not.length > 0, `${item.case_id}: no forbidden behaviour listed`);
  }

  const kinds = new Set(cases.map((item) => item.kind));
  for (const required of [
    "prompt_injection_in_description",
    "prompt_injection_in_transcript",
    "reused_media_fingerprint",
    "claimed_presence_without_evidence",
    "unsupported_language",
    "coordinates_out_of_range",
  ]) {
    assert.ok(kinds.has(required), `missing adversarial kind: ${required}`);
  }
});
