/**
 * V039 district dashboard presentation.
 *
 * The acceptance clause this file exists to hold: **a reader can tell zero
 * from missing coverage.** Not "the data distinguishes them" — the rendered
 * output distinguishes them, in the text and in the tone, because a reader
 * scanning a column of numbers will read any numeral as a measurement.
 *
 * Also pinned: an unknown measure never renders as a number, a failed
 * reconciliation is stated in the loud tone with both figures in it, and no
 * label on this screen claims more than V037 permits.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { vocabularyViolations } from "@vision/domain";

import {
  EVIDENCE_LABELS,
  STATE_LABELS,
  byWard,
  categoriesOf,
  categoryLabel,
  coverageBanner,
  figure,
  freshnessBanner,
  measureText,
  reconciliationBanner,
  untrackedOf,
  contextFigure,
  contextByWard,
  contextImportBanner,
  type ContextValue,
  type DashboardCell,
  type DashboardPayload,
} from "./dashboard-view.ts";

const cell = (over: Partial<DashboardCell>): DashboardCell => ({
  jurisdictionKey: "ward-1",
  jurisdictionLabel: "DDA-B1",
  category: "water_supply",
  coverage: "projected",
  tracked: true,
  issueCount: 4,
  open: 3,
  claimed: 1,
  disputed: 0,
  confirmed: 0,
  reopened: 0,
  unknownState: 0,
  countedParticipants: 3,
  drillDownAvailable: true,
  ...over,
});

const payload = (over: Partial<DashboardPayload>): DashboardPayload => ({
  asOf: "2026-09-17T00:00:00.000Z",
  cells: [cell({})],
  reconciliation: {
    sourcePopulation: 4,
    projectedTotal: 4,
    difference: 0,
    reconciles: true,
    definition: "Active canonical roots in the authorized jurisdictions.",
    explanation: "The 4 reports counted below are exactly the 4 active reports in the records.",
  },
  metrics: [],
  coverage: {
    rows: 4,
    anyDimensionUnknown: 0,
    jurisdictionUnknown: 0,
    wardsWithNoData: 0,
    wardsWithNoReports: 0,
    untrackedCategoryCells: 0,
    unplacedIssues: 0,
  },
  summary: {
    freshness: {
      state: "fresh",
      explanation: "Last projected 2s ago with nothing pending and nothing unprojected.",
      pendingEvents: 0,
      unprojectedIssues: 0,
    },
    lastRebuildAt: "2026-09-17T00:00:00.000Z",
    lastReconciliation: { ranAt: "2026-09-17T00:00:00.000Z", reconciled: true, mismatches: 0 },
  },
  context: [],
  contextImports: [],
  notAdditive: [],
  note: "Every figure here counts reports this demonstration received.",
  ...over,
});

const contextValue = (over: Partial<ContextValue> = {}): ContextValue => ({
  datasetId: "demo.population",
  datasetLabel: "Resident population (synthetic)",
  kind: "population",
  jurisdictionId: "ward-1",
  value: 18600,
  missingIndicator: null,
  unit: "persons",
  vintage: "2026-01-01T00:00:00Z",
  sourceName: "Demo District A synthetic context register",
  synthetic: true,
  staleness: { ageDays: 259, stale: false, explanation: "Recorded as true 259 days ago." },
  lineage:
    "18600 persons. Invented for this demonstration. It describes no real place and no external dataset was ingested to produce it. Recorded as true 259 days ago.",
  ...over,
});

// ---------------------------------------------------------------------------
// Zero is not missing
// ---------------------------------------------------------------------------

test("a ward with no data and a ward with no reports render differently", () => {
  const missing = figure(cell({ coverage: "no_data", issueCount: 0 }));
  const zero = figure(cell({ coverage: "zero", issueCount: 0 }));

  assert.notEqual(missing.text, zero.text, "the visible text must differ");
  assert.notEqual(missing.tone, zero.tone, "and so must the tone, for a reader who scans");
  assert.equal(zero.text, "0");
  assert.equal(missing.text, "No data");
  assert.equal(missing.tone, "absent");
});

test("missing coverage never renders as a numeral", () => {
  const missing = figure(cell({ coverage: "no_data" }));
  assert.doesNotMatch(missing.text, /\d/, "any numeral in this slot reads as a measurement");
});

test("a missing cell says in words that it is not evidence of nothing being wrong", () => {
  const missing = figure(cell({ coverage: "no_data" }));
  assert.match(missing.description, /not zero reports/i);
  assert.match(missing.description, /not evidence that there is nothing wrong/i);
});

test("a real zero says why it can be trusted as a zero", () => {
  assert.match(
    figure(cell({ coverage: "zero", issueCount: 0 })).description,
    /up to date and matches the records/,
  );
});

test("the same empty slot reads as zero when healthy and as no data when not", () => {
  const healthy = figure(cell({ coverage: "zero", issueCount: 0 }));
  const unhealthy = figure(cell({ coverage: "no_data", issueCount: 0 }));
  assert.equal(healthy.text, "0");
  assert.equal(unhealthy.text, "No data");
  assert.match(
    unhealthy.description,
    /behind the records or has not been checked/,
    "the reason a slot cannot be read as zero has to be on the slot",
  );
});

test("every cell carries a description naming its ward and category", () => {
  for (const coverage of ["projected", "no_data"] as const) {
    const described = figure(cell({ coverage }));
    assert.match(described.description, /DDA-B1/);
    assert.match(described.description, /water_supply/);
  }
});

// ---------------------------------------------------------------------------
// Unknown measures
// ---------------------------------------------------------------------------

test("an unknown measure renders as words and a reason, never as zero", () => {
  const text = measureText({ value: null, unknownReason: "empty_denominator" }, "percent");
  assert.match(text, /Not known/);
  assert.match(text, /nothing was in the population/);
  assert.doesNotMatch(text, /\b0\b/);
});

test("every unknown reason has words a reader can act on", () => {
  for (const reason of [
    "empty_denominator",
    "no_population_source",
    "dimension_not_reconstructible",
    "cohort_not_sufficiently_observed",
    "overlapping_boundaries",
    "mixed_boundary_versions",
    "not_additive",
  ] as const) {
    const text = measureText({ value: null, unknownReason: reason }, "count");
    assert.match(text, /Not known — .{10,}/, `${reason} needs an explanation`);
  }
});

test("a known zero percent is still rendered as zero percent", () => {
  assert.equal(measureText({ value: 0, unknownReason: null }, "percent"), "0%");
  assert.equal(measureText({ value: 41.5, unknownReason: null }, "hours"), "41.5 hours");
  assert.equal(measureText({ value: 7, unknownReason: null }, "count"), "7");
});

// ---------------------------------------------------------------------------
// Banners
// ---------------------------------------------------------------------------

test("totals that reconcile are stated with the population they reconcile to", () => {
  const banner = reconciliationBanner(payload({}));
  assert.equal(banner.tone, "neutral");
  assert.match(banner.detail, /Active canonical roots/);
  assert.match(banner.heading, /4 reports/);
});

test("totals that do not reconcile say so loudly, with both figures", () => {
  const banner = reconciliationBanner(
    payload({
      reconciliation: {
        sourcePopulation: 314,
        projectedTotal: 300,
        difference: -14,
        reconciles: false,
        definition: "Active canonical roots in the authorized jurisdictions.",
        explanation:
          "The table below counts 300 reports, but there are 314 active reports in the records right now — a difference of 14. The summary is behind or incorrect, and nothing on this page should be quoted until it is rebuilt.",
      },
    }),
  );
  assert.equal(banner.tone, "caution");
  assert.match(banner.heading, /do not add up/i);
  assert.match(banner.detail, /300/);
  assert.match(banner.detail, /314/);
  assert.match(banner.detail, /should be quoted/);
});

test("a stale summary is flagged even when its last check passed", () => {
  const banner = freshnessBanner(
    payload({
      summary: {
        freshness: {
          state: "lagging",
          explanation:
            "Last projected 4s ago with 412 event(s) not yet applied and 0 record(s) never projected.",
          pendingEvents: 412,
          unprojectedIssues: 0,
        },
        lastRebuildAt: "2026-09-17T00:00:00.000Z",
        lastReconciliation: { ranAt: "2026-09-16T00:00:00.000Z", reconciled: true, mismatches: 0 },
      },
    }),
  );
  assert.equal(banner.tone, "caution");
  assert.match(banner.heading, /behind the record/i);
  assert.match(banner.detail, /412/);
});

test("a fresh summary whose last check failed is still flagged", () => {
  const banner = freshnessBanner(
    payload({
      summary: {
        freshness: {
          state: "fresh",
          explanation: "Last projected 1s ago with nothing pending and nothing unprojected.",
          pendingEvents: 0,
          unprojectedIssues: 0,
        },
        lastRebuildAt: null,
        lastReconciliation: { ranAt: "2026-09-17T00:00:00.000Z", reconciled: false, mismatches: 3 },
      },
    }),
  );
  assert.equal(banner.tone, "caution", "recency is not correctness");
  assert.match(banner.detail, /3 mismatch/);
});

test("a summary that has never been built says so rather than showing zeros", () => {
  const banner = freshnessBanner(
    payload({
      summary: {
        freshness: {
          state: "never_built",
          explanation: "This summary has never been built.",
          pendingEvents: 9,
          unprojectedIssues: 40,
        },
        lastRebuildAt: null,
        lastReconciliation: null,
      },
    }),
  );
  assert.match(banner.heading, /never been built/i);
  assert.match(banner.detail, /never been checked/i);
});

test("the coverage banner names all three kinds of gap, and never implies a clean map", () => {
  const banner = coverageBanner(
    payload({
      coverage: {
        rows: 100,
        anyDimensionUnknown: 40,
        jurisdictionUnknown: 40,
        wardsWithNoData: 18,
        wardsWithNoReports: 4,
        untrackedCategoryCells: 66,
        unplacedIssues: 170,
      },
    }),
  );
  assert.equal(banner.tone, "caution");
  assert.match(banner.detail, /18 ward-and-category/);
  assert.match(banner.detail, /170 report\(s\) have not been placed/);
  assert.match(banner.detail, /66 group\(s\)/);
  assert.match(banner.detail, /not zero incidence/i);
});

// ---------------------------------------------------------------------------
// Shaping
// ---------------------------------------------------------------------------

test("a ward whose every cell is missing still gets a row", () => {
  const rows = byWard(
    payload({
      cells: [
        cell({
          jurisdictionKey: "ward-1",
          jurisdictionLabel: "A",
          coverage: "no_data",
          issueCount: 0,
        }),
        cell({
          jurisdictionKey: "ward-1",
          jurisdictionLabel: "A",
          category: "sanitation",
          coverage: "no_data",
          issueCount: 0,
        }),
      ],
    }),
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.hasAnyData, false, "the row exists precisely so the gap is visible");
  assert.equal(rows[0]?.total, 0);
});

test("the unplaced bucket sorts last, because it is a data-quality row and not a ward", () => {
  const rows = byWard(
    payload({
      cells: [
        cell({
          jurisdictionKey: "UNKNOWN",
          jurisdictionLabel: "Not yet placed in a ward",
          drillDownAvailable: false,
        }),
        cell({ jurisdictionKey: "ward-z", jurisdictionLabel: "Z ward" }),
        cell({ jurisdictionKey: "ward-a", jurisdictionLabel: "A ward" }),
      ],
    }),
  );
  assert.deepEqual(
    rows.map((row) => row.jurisdictionLabel),
    ["A ward", "Z ward", "Not yet placed in a ward"],
  );
});

test("unplaced reports are counted but cannot be opened", () => {
  const unplaced = cell({ jurisdictionKey: "UNKNOWN", drillDownAvailable: false, issueCount: 170 });
  assert.equal(figure(unplaced).text, "170", "the count is shown");
  assert.equal(unplaced.drillDownAvailable, false, "and the records behind it are not opened here");
});

test("only tracked categories become table columns; untracked ones are listed separately", () => {
  const shaped = payload({
    cells: [
      cell({ category: "water_supply", tracked: true }),
      cell({ category: "sanitation", tracked: true }),
      cell({ category: "c31-0211cb", tracked: false, issueCount: 2 }),
      cell({ category: "c99-empty", tracked: false, issueCount: 0 }),
    ],
  });
  assert.deepEqual(categoriesOf(shaped), ["sanitation", "water_supply"]);
  assert.deepEqual(
    untrackedOf(shaped).map((item) => item.category),
    ["c31-0211cb"],
    "an untracked category with no reports is not worth a row; one with reports is",
  );
});

test("category identifiers are shown as words without inventing a translation", () => {
  assert.equal(categoryLabel("water_supply"), "Water supply");
  assert.equal(categoryLabel("structural"), "Structural");
});

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

test("no label on this screen claims more than the system knows", () => {
  const everyLabel = [
    ...Object.values(STATE_LABELS),
    ...Object.values(EVIDENCE_LABELS),
    figure(cell({ coverage: "no_data" })).description,
    figure(cell({ issueCount: 0 })).description,
    reconciliationBanner(payload({})).heading,
    coverageBanner(payload({})).detail,
    measureText({ value: null, unknownReason: "empty_denominator" }, "percent"),
  ].join(" \n ");
  assert.deepEqual(vocabularyViolations(everyLabel), []);
});

test("a confirmed resolution is never labelled as verified or certified", () => {
  assert.equal(STATE_LABELS.confirmed, "Standing confirmed");
  assert.doesNotMatch(STATE_LABELS.confirmed, /verified|certified|closed/i);
  assert.match(STATE_LABELS.reopened, /reopened/i);
  assert.match(STATE_LABELS.disputed, /disputed/i);
});

test("evidence labels say what is available without implying the original is reachable", () => {
  assert.match(EVIDENCE_LABELS.approved_derivative, /redacted/i);
  for (const label of Object.values(EVIDENCE_LABELS)) {
    assert.doesNotMatch(label, /\boriginal\b/i, `"${label}" must not offer the private original`);
  }
});

// ---------------------------------------------------------------------------
// Context values (V040)
// ---------------------------------------------------------------------------

test("a context figure cannot be rendered without its lineage", () => {
  assert.notEqual(contextFigure(contextValue()), undefined);
  assert.equal(
    contextFigure(contextValue({ lineage: "   " })),
    undefined,
    "there is no way to obtain renderable text for a value with no lineage",
  );
  assert.equal(contextFigure(contextValue({ sourceName: "" })), undefined);
});

test("a synthetic figure's lineage says it is invented, and travels with the number", () => {
  const figure = contextFigure(contextValue());
  assert.match(figure?.text ?? "", /18600 people/);
  assert.match(figure?.lineage ?? "", /Invented for this demonstration/);
});

test("a context figure the source did not record reads as not known, never as zero", () => {
  const figure = contextFigure(
    contextValue({
      value: null,
      missingIndicator: "not surveyed",
      lineage:
        'No figure is recorded — the source said "not surveyed". Invented for this demonstration. Recorded as true 259 days ago.',
    }),
  );
  assert.equal(figure?.text, "Not known");
  assert.equal(figure?.tone, "absent");
  assert.doesNotMatch(figure?.text ?? "", /\d/);
});

test("a stale figure is shown, marked as stale, and says it is still the best available", () => {
  const figure = contextFigure(
    contextValue({
      value: 71.4,
      kind: "access",
      unit: "percent_of_households",
      staleness: {
        ageDays: 1265,
        stale: true,
        explanation:
          "Recorded as true 1265 days ago, past the 365 days this dataset is considered current for. It is still the most recent figure available.",
      },
      lineage:
        "71.4 percent_of_households. Invented for this demonstration. Recorded as true 1265 days ago, past the 365 days this dataset is considered current for. It is still the most recent figure available.",
    }),
  );
  assert.equal(figure?.stale, true);
  assert.equal(figure?.tone, "caution", "a caveat, not a refusal");
  assert.match(figure?.text ?? "", /71.4/, "the number is still shown");
  assert.match(figure?.lineage ?? "", /still the most recent figure available/);
});

test("context is grouped by ward in a stable order", () => {
  const grouped = contextByWard(
    payload({
      context: [
        contextValue({ jurisdictionId: "ward-2", kind: "population" }),
        contextValue({ jurisdictionId: "ward-1", kind: "population" }),
        contextValue({ jurisdictionId: "ward-1", kind: "access" }),
      ],
    }),
  );
  assert.deepEqual(
    grouped.map((group) => group.jurisdictionId),
    ["ward-1", "ward-2"],
  );
  assert.deepEqual(
    grouped[0]?.values.map((value) => value.kind),
    ["access", "population"],
  );
});

test("refused context rows are reported on the page, with a reason", () => {
  const banner = contextImportBanner(
    payload({
      contextImports: [
        {
          datasetId: "demo.population",
          ranAt: "2026-09-17T00:00:00.000Z",
          rowsRead: 4,
          rowsLoaded: 3,
          rowsRejected: 1,
          rejections: [
            {
              rowIndex: 2,
              code: "unit_mismatch",
              detail: "row is in households but the dataset is in persons",
            },
          ],
        },
      ],
    }),
  );
  assert.equal(banner.tone, "caution");
  assert.match(banner.heading, /1 context row\(s\) were refused/);
  assert.match(banner.detail, /rather than converted into a plausible figure/);
});

test("a clean import still says so, rather than showing nothing", () => {
  const banner = contextImportBanner(
    payload({
      contextImports: [
        {
          datasetId: "demo.population",
          ranAt: "2026-09-17T00:00:00.000Z",
          rowsRead: 3,
          rowsLoaded: 3,
          rowsRejected: 0,
          rejections: [],
        },
      ],
    }),
  );
  assert.equal(banner.tone, "neutral");
  assert.match(banner.heading, /none refused/);
  assert.match(banner.detail, /stored as unknown, not as zero/);
});

test("no context at all is its own statement, not an absent section", () => {
  const banner = contextImportBanner(payload({}));
  assert.equal(banner.tone, "absent");
  assert.match(banner.heading, /No context data has been imported/);
  assert.match(banner.detail, /not the same as those figures being zero/);
});
