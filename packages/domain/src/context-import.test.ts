/**
 * V040 contextual data import rules.
 *
 * The acceptance clauses this file holds:
 *
 *   * **invalid units are reported, not converted** — the single most important
 *     property here, because a conversion factor is an invention and an
 *     invented factor is indistinguishable from a correct one once the number
 *     is on a screen;
 *   * **stale records are reported, not refreshed or withheld**;
 *   * **unmatched subjects are reported, not attached to the nearest plausible
 *     one**;
 *   * **every displayed value links to a source or says it is synthetic**.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { IsoTimestamp, SourceRecordSnapshot, Uuid } from "@vision/contracts";

import {
  CONTEXT_KINDS,
  MISSING_INDICATORS,
  UNITS_BY_KIND,
  isDisplayable,
  lineageSentence,
  parseContextValue,
  stalenessOf,
  unitsFor,
  validateContextRow,
  type ContextDataset,
  type ContextRow,
  type DisplayableContextValue,
  type RejectionCode,
} from "./context-import.ts";

const DAY = 86_400_000;
const ASOF = Date.UTC(2026, 8, 17);

const syntheticSource: SourceRecordSnapshot = {
  source_record_id: "a0000000-0000-4000-8000-000000000040" as Uuid,
  source_name: "synthetic district context register",
  source_url_or_location: "packages/config-packs/src/packs/demo-district-a/context.json",
  retrieved_at: "2026-09-01T00:00:00Z" as IsoTimestamp,
  source_effective_at: "2026-01-01T00:00:00Z" as IsoTimestamp,
  licence_or_permission_status: "synthetic",
  demo_status: "team_created_synthetic",
};

const referenceOnlySource: SourceRecordSnapshot = {
  ...syntheticSource,
  source_name: "a public government lookup page",
  licence_or_permission_status: "reference_only",
  demo_status: "unavailable_not_approved",
};

const dataset = (over: Partial<ContextDataset> = {}): ContextDataset => ({
  datasetId: "demo-population",
  kind: "population",
  unit: "persons",
  label: "Population (synthetic)",
  source: syntheticSource,
  maxAgeDays: 365,
  ...over,
});

const row = (over: Partial<ContextRow> = {}): ContextRow => ({
  subjectKind: "jurisdiction",
  subjectId: "DDA-B1",
  value: 12400,
  unit: "persons",
  vintage: "2026-01-01T00:00:00Z",
  ...over,
});

const context = (over: Partial<Parameters<typeof validateContextRow>[2]> = {}) => ({
  knownSubjects: new Set(["DDA", "DDA-B1", "DDA-B2"]),
  asOfMs: ASOF,
  ...over,
});

const codes = (outcome: ReturnType<typeof validateContextRow>): readonly RejectionCode[] =>
  outcome.ok ? [] : outcome.rejections.map((rejection) => rejection.code);

// ---------------------------------------------------------------------------
// Units are never converted
// ---------------------------------------------------------------------------

test("a row in a different unit from its dataset is refused, not rescaled", () => {
  const outcome = validateContextRow(dataset(), row({ unit: "households" }), context());
  assert.deepEqual(codes(outcome), ["unit_mismatch"]);
  if (!outcome.ok) {
    assert.match(outcome.rejections[0]?.detail ?? "", /does not convert units/);
  }
});

test("a dataset unit outside the vocabulary for its kind is refused", () => {
  const outcome = validateContextRow(
    dataset({ unit: "families" }),
    row({ unit: "families" }),
    context(),
  );
  assert.ok(codes(outcome).includes("unknown_unit"));
  if (!outcome.ok) {
    assert.match(
      outcome.rejections[0]?.detail ?? "",
      /persons/,
      "the message names the valid units",
    );
  }
});

test("every kind has a closed unit vocabulary and none of them is empty", () => {
  for (const kind of CONTEXT_KINDS) {
    assert.ok(unitsFor(kind).length > 0, `${kind} must declare its units`);
    assert.deepEqual(unitsFor(kind), UNITS_BY_KIND[kind]);
  }
});

test("a share is a percentage, and a fraction written as one is refused", () => {
  const access = dataset({
    datasetId: "demo-access",
    kind: "access",
    unit: "percent_of_households",
  });
  const asShare = validateContextRow(
    access,
    row({ value: 0.62, unit: "percent_of_households" }),
    context(),
  );
  // 0.62 is a valid percentage on its face, so it passes — the guard catches
  // the other direction, where a fraction has been multiplied into nonsense.
  assert.equal(asShare.ok, true);

  const rescaled = validateContextRow(
    access,
    row({ value: 6200, unit: "percent_of_households" }),
    context(),
  );
  assert.ok(codes(rescaled).includes("share_out_of_range"));
});

// ---------------------------------------------------------------------------
// Missing stays missing
// ---------------------------------------------------------------------------

test("every missing-data indicator parses to an absence, never to zero", () => {
  for (const indicator of MISSING_INDICATORS) {
    const parsed = parseContextValue(indicator);
    assert.equal(parsed.kind, "missing", `'${indicator}' must read as missing`);
  }
  assert.equal(parseContextValue(null).kind, "missing");
  assert.equal(parseContextValue(undefined).kind, "missing");
});

test("a missing value survives validation as a null carrying its indicator", () => {
  const outcome = validateContextRow(dataset(), row({ value: "NA" }), context());
  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    assert.equal(outcome.row.value, null, "never 0");
    assert.equal(outcome.row.missingIndicator, "NA");
  }
});

test("a real zero is kept as a zero and carries no missing indicator", () => {
  const outcome = validateContextRow(dataset(), row({ value: 0 }), context());
  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    assert.equal(outcome.row.value, 0);
    assert.equal(outcome.row.missingIndicator, null);
  }
});

test("a malformed number is an error in the file, not an absence", () => {
  for (const malformed of ["12,400", "1 200", "₹4500", "12.4k", "abc"]) {
    const outcome = validateContextRow(dataset(), row({ value: malformed }), context());
    assert.ok(
      codes(outcome).includes("unparseable_value"),
      `'${malformed}' must be rejected rather than read as unknown`,
    );
  }
});

test("a negative quantity is refused", () => {
  assert.ok(
    codes(validateContextRow(dataset(), row({ value: -5 }), context())).includes("negative_value"),
  );
});

// ---------------------------------------------------------------------------
// Subjects and vintages
// ---------------------------------------------------------------------------

test("a row naming a subject that does not exist is reported, not attached to a neighbour", () => {
  const outcome = validateContextRow(dataset(), row({ subjectId: "DDA-B9" }), context());
  assert.deepEqual(codes(outcome), ["unmatched_subject"]);
  if (!outcome.ok) {
    assert.match(
      outcome.rejections[0]?.detail ?? "",
      /never attached to the nearest plausible one/,
    );
  }
});

test("a subject appearing twice is refused rather than one figure silently winning", () => {
  const outcome = validateContextRow(
    dataset(),
    row(),
    context({ seen: new Set(["jurisdiction:DDA-B1"]) }),
  );
  assert.deepEqual(codes(outcome), ["duplicate_subject"]);
});

test("a value with no vintage cannot be loaded, because it can be shown neither current nor stale", () => {
  assert.ok(
    codes(validateContextRow(dataset(), row({ vintage: "" }), context())).includes(
      "missing_vintage",
    ),
  );
  assert.ok(
    codes(validateContextRow(dataset(), row({ vintage: "not a date" }), context())).includes(
      "missing_vintage",
    ),
  );
});

test("a vintage in the future is refused", () => {
  const outcome = validateContextRow(
    dataset(),
    row({ vintage: new Date(ASOF + 30 * DAY).toISOString() }),
    context(),
  );
  assert.deepEqual(codes(outcome), ["future_vintage"]);
});

// ---------------------------------------------------------------------------
// The licence gate
// ---------------------------------------------------------------------------

test("a reference-only source cannot be ingested, however the row is presented", () => {
  const outcome = validateContextRow(dataset({ source: referenceOnlySource }), row(), context());
  assert.deepEqual(codes(outcome), ["source_not_ingestible"]);
  if (!outcome.ok) {
    assert.match(outcome.rejections[0]?.detail ?? "", /V004/);
  }
});

test("synthetic and consented data may be loaded; permitted data may be loaded", () => {
  for (const licence of ["synthetic", "consented", "permitted"] as const) {
    const demoStatus =
      licence === "synthetic"
        ? "team_created_synthetic"
        : licence === "consented"
          ? "consented_evaluation_data"
          : "permitted_source_data";
    const outcome = validateContextRow(
      dataset({
        source: {
          ...syntheticSource,
          licence_or_permission_status: licence,
          demo_status: demoStatus,
        },
      }),
      row(),
      context(),
    );
    assert.equal(outcome.ok, true, `${licence} must be loadable`);
  }
});

test("every reason a row failed is reported, so a file can be fixed in one pass", () => {
  const outcome = validateContextRow(
    dataset({ source: referenceOnlySource }),
    row({ subjectId: "DDA-B9", unit: "households", value: "12,400", vintage: "" }),
    context(),
  );
  assert.equal(outcome.ok, false);
  assert.deepEqual([...codes(outcome)].sort(), [
    "missing_vintage",
    "source_not_ingestible",
    "unit_mismatch",
    "unmatched_subject",
    "unparseable_value",
  ]);
});

// ---------------------------------------------------------------------------
// Staleness
// ---------------------------------------------------------------------------

test("a stale figure is reported as stale and is still the best figure available", () => {
  const staleness = stalenessOf(ASOF - 800 * DAY, ASOF, 365);
  assert.equal(staleness.stale, true);
  assert.equal(staleness.ageDays, 800);
  assert.match(staleness.explanation, /past the 365 days/);
  assert.match(
    staleness.explanation,
    /still the most recent figure available/,
    "staleness is a caveat on a usable number, not a reason to hide it",
  );
});

test("a current figure says how old it is anyway", () => {
  const staleness = stalenessOf(ASOF - 10 * DAY, ASOF, 365);
  assert.equal(staleness.stale, false);
  assert.match(staleness.explanation, /10 days ago/);
});

test("a vintage ahead of the horizon does not produce a negative age", () => {
  assert.equal(stalenessOf(ASOF + 5 * DAY, ASOF, 365).ageDays, 0);
});

// ---------------------------------------------------------------------------
// Lineage
// ---------------------------------------------------------------------------

const displayable = (over: Partial<DisplayableContextValue> = {}): DisplayableContextValue => ({
  datasetLabel: "Population (synthetic)",
  kind: "population",
  value: 12400,
  missingIndicator: null,
  unit: "persons",
  vintage: "2026-01-01T00:00:00Z",
  sourceName: "synthetic district context register",
  sourceLocation: "packages/config-packs/src/packs/demo-district-a/context.json",
  licence: "synthetic",
  synthetic: true,
  staleness: stalenessOf(Date.UTC(2026, 0, 1), ASOF, 365),
  ...over,
});

test("a synthetic figure says it is invented before anything else about it", () => {
  const sentence = lineageSentence(displayable());
  assert.match(sentence, /Invented for this demonstration/);
  assert.match(sentence, /describes no real place/);
  assert.match(sentence, /no external dataset was ingested/);
});

test("a sourced figure names its source, its location and its licence", () => {
  const sentence = lineageSentence(
    displayable({ synthetic: false, sourceName: "A permitted register", licence: "permitted" }),
  );
  assert.match(sentence, /A permitted register/);
  assert.match(sentence, /packs\/demo-district-a\/context\.json/);
  assert.match(sentence, /used under: permitted/);
});

test("a missing figure says the source did not know, and never shows a number", () => {
  const sentence = lineageSentence(displayable({ value: null, missingIndicator: "not surveyed" }));
  assert.match(sentence, /No figure is recorded/);
  assert.match(sentence, /"not surveyed"/);
  assert.doesNotMatch(sentence, /\b0 persons\b/);
});

test("every lineage sentence carries the age of the figure", () => {
  for (const value of [displayable(), displayable({ value: null, missingIndicator: "NA" })]) {
    assert.match(lineageSentence(value), /days ago/);
  }
});

test("a value with no source or no vintage is not displayable at all", () => {
  assert.equal(isDisplayable(displayable()), true);
  assert.equal(isDisplayable(displayable({ sourceName: "  " })), false);
  assert.equal(isDisplayable(displayable({ vintage: "not a date" })), false);
});
