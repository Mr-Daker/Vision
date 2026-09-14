import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isIngestible,
  newCorrelationId,
  unsafeTimestamp,
  type AdapterCallContext,
  type SourceRecordSnapshot,
} from "@vision/contracts";

import {
  SYNTHETIC_SOURCE_ROWS,
  SyntheticSourceImportAdapter,
  isLabelledSynthetic,
  isStale,
} from "./sources.ts";
import { describeSourceImportAdapterContract } from "./contract-tests.ts";

const ctx = (): AdapterCallContext => ({ correlation_id: newCorrelationId() });
const NOW = unsafeTimestamp("2026-09-09T10:00:00Z");

describeSourceImportAdapterContract(
  "SyntheticSourceImportAdapter",
  () => new SyntheticSourceImportAdapter(),
);

test("V010: every synthetic source row is labelled synthetic", async () => {
  const adapter = new SyntheticSourceImportAdapter();

  for (const dataset of Object.keys(SYNTHETIC_SOURCE_ROWS)) {
    const outcome = await adapter.fetchRecords(
      { dataset, jurisdiction_profile_id: "demo-district-a" },
      ctx(),
    );
    assert.equal(outcome.kind, "success", `${dataset} should resolve`);
    if (outcome.kind !== "success") continue;

    assert.ok(outcome.value.length > 0, `${dataset} should have rows`);
    for (const row of outcome.value) {
      assert.equal(isLabelledSynthetic(row), true, `${dataset} row is not labelled synthetic`);
      assert.equal(row.demo_status, "team_created_synthetic");
      assert.equal(isIngestible(row), true, "synthetic rows are ingestible for the demo");
      assert.match(
        JSON.stringify(row.raw_snapshot ?? {}),
        /SYNTHETIC|synthetic/,
        "the row payload should also carry a visible synthetic marker",
      );
    }
  }
});

test("V010: configured rows fail closed when synthetic labelling is missing", () => {
  const baseline = SYNTHETIC_SOURCE_ROWS["projects"]![0]!;

  assert.throws(
    () =>
      new SyntheticSourceImportAdapter({
        rows: {
          projects: [
            {
              ...baseline,
              licence_or_permission_status: "permitted",
              demo_status: "permitted_source_data",
            },
          ],
        },
      }),
    /must be labelled synthetic/,
  );
});

test("V010: configured rows require a snapshot with a visible synthetic marker", () => {
  const baseline = SYNTHETIC_SOURCE_ROWS["projects"]![0]!;
  const { raw_snapshot: _omitted, ...withoutSnapshot } = baseline;

  assert.throws(
    () => new SyntheticSourceImportAdapter({ rows: { projects: [withoutSnapshot] } }),
    /visible SYNTHETIC marker/,
  );
  assert.throws(
    () =>
      new SyntheticSourceImportAdapter({
        rows: { projects: [{ ...baseline, raw_snapshot: { asset_id: "demo-asset-001" } }] },
      }),
    /visible SYNTHETIC marker/,
  );
});

test("V010: configured and returned source rows are defensively copied", async () => {
  const inputPayload: Record<string, unknown> = {
    asset_id: "demo-asset-copy-test",
    label: "SYNTHETIC — copy test",
  };
  const inputRow: SourceRecordSnapshot = {
    ...SYNTHETIC_SOURCE_ROWS["projects"]![0]!,
    raw_snapshot: inputPayload,
  };
  const adapter = new SyntheticSourceImportAdapter({ rows: { projects: [inputRow] } });

  inputPayload["label"] = "mutated after construction";
  const first = await adapter.fetchRecords(
    { dataset: "projects", jurisdiction_profile_id: "demo-district-a" },
    ctx(),
  );
  assert.equal(first.kind, "success");
  if (first.kind !== "success") return;
  assert.equal(first.value[0]?.raw_snapshot?.["label"], "SYNTHETIC — copy test");

  const exposed = first.value[0]?.raw_snapshot as Record<string, unknown>;
  exposed["label"] = "mutated by caller";
  const second = await adapter.fetchRecords(
    { dataset: "projects", jurisdiction_profile_id: "demo-district-a" },
    ctx(),
  );
  assert.equal(second.kind, "success");
  if (second.kind === "success") {
    assert.equal(second.value[0]?.raw_snapshot?.["label"], "SYNTHETIC — copy test");
  }
});

test("V010: a missing project match is an empty success meaning unknown", async () => {
  // No matching project rows for this jurisdiction's asset.
  const adapter = new SyntheticSourceImportAdapter({ rows: { projects: [] } });

  const outcome = await adapter.fetchRecords(
    { dataset: "projects", jurisdiction_profile_id: "demo-district-a" },
    ctx(),
  );

  assert.equal(outcome.kind, "success", "absence of a match is not an error");
  if (outcome.kind === "success") {
    assert.deepEqual(outcome.value, [], "no rows means unknown, not 'no funding exists'");
  }
});

test("V010: stale records are detectable rather than silently used", async () => {
  const adapter = new SyntheticSourceImportAdapter();
  const outcome = await adapter.fetchRecords(
    { dataset: "projects", jurisdiction_profile_id: "demo-district-a" },
    ctx(),
  );
  assert.equal(outcome.kind, "success");
  if (outcome.kind !== "success") return;

  const stale = outcome.value.filter((row) => isStale(row, NOW, 180));
  const fresh = outcome.value.filter((row) => !isStale(row, NOW, 180));

  assert.ok(stale.length > 0, "the fixture set must include a deliberately stale record");
  assert.ok(fresh.length > 0, "the fixture set must also include a fresh record");
});

test("V010: a record without a source-effective date is treated as stale", () => {
  const row = SYNTHETIC_SOURCE_ROWS["projects"]![0]!;
  const { source_effective_at: _omitted, ...withoutDate } = row;
  assert.equal(
    isStale(withoutDate, NOW, 3650),
    true,
    "unknown effective date must not pass as fresh",
  );
});

test("V010: an unknown dataset is rejected instead of returning invented rows", async () => {
  const adapter = new SyntheticSourceImportAdapter();
  const outcome = await adapter.fetchRecords(
    { dataset: "contractors", jurisdiction_profile_id: "demo-district-a" },
    ctx(),
  );
  assert.equal(outcome.kind, "rejected");
  if (outcome.kind === "rejected") {
    assert.equal(outcome.reason_code, "unknown_dataset");
  }
});

test("V010: a degraded feed reports unavailable and is retryable", async () => {
  const adapter = new SyntheticSourceImportAdapter({ forceUnavailable: true });
  const outcome = await adapter.fetchRecords(
    { dataset: "projects", jurisdiction_profile_id: "demo-district-a" },
    ctx(),
  );
  assert.equal(outcome.kind, "unavailable");
  if (outcome.kind === "unavailable") {
    assert.equal(outcome.retryable, true);
  }
});

test("V010: reference-only material is never ingestible", () => {
  const referenceOnly = {
    source_record_id: SYNTHETIC_SOURCE_ROWS["projects"]![0]!.source_record_id,
    source_name: "Local Government Directory",
    source_url_or_location: "https://lgdirectory.gov.in/",
    retrieved_at: NOW,
    licence_or_permission_status: "reference_only" as const,
    demo_status: "unavailable_not_approved" as const,
  };
  assert.equal(isIngestible(referenceOnly), false);
  assert.equal(isLabelledSynthetic(referenceOnly), false);
});
