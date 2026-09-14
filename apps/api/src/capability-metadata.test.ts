/**
 * Capability metadata assembly tests (roadmap V009, enforcing V002 row 16).
 *
 * `findUnlabelledSimulations` is covered in the contracts package. What is
 * asserted here is the composition-root consequence: an unlabelled simulation
 * must stop the process from starting, because a running API that serves a
 * misleading label is worse than one that refuses to boot.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { CONTRACT_VERSION, type CapabilityDescriptor } from "@vision/contracts";

import { buildCapabilityMetadata } from "./capability-metadata.ts";

const descriptor = (overrides: Partial<CapabilityDescriptor> = {}): CapabilityDescriptor => ({
  capability: "citizen_identity",
  provider_name: "simulated-identity",
  provider_mode: "simulated",
  display_label: "Simulated demonstration identity",
  v002_row: 1,
  may_claim: [],
  must_not_claim: [],
  ...overrides,
});

test("V009: an unlabelled simulated capability refuses to start", () => {
  assert.throws(
    () =>
      buildCapabilityMetadata({
        descriptors: [descriptor({ display_label: "Identity verified" })],
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /refusing to start/);
      // The offending capability must be named, or the operator cannot tell
      // which provider is mislabelled.
      assert.match(error.message, /citizen_identity/);
      return true;
    },
  );
});

test("V009: the error names every offending capability, not just the first", () => {
  try {
    buildCapabilityMetadata({
      descriptors: [
        descriptor({ capability: "citizen_identity", display_label: "Identity verified" }),
        descriptor({ capability: "ai_classification", display_label: "Category confirmed" }),
      ],
    });
    assert.fail("expected a refusal");
  } catch (error) {
    assert.ok(error instanceof Error);
    assert.match(error.message, /citizen_identity/);
    assert.match(error.message, /ai_classification/);
  }
});

test("V009: a labelled simulation builds and keeps its descriptors unchanged", () => {
  const descriptors = [descriptor()];

  const document = buildCapabilityMetadata({ descriptors });

  assert.equal(document.contract_version, CONTRACT_VERSION);
  assert.deepEqual(document.capabilities, descriptors);
});

test("V009: a real provider is not required to carry simulation wording", () => {
  // The guard must not force an honest real provider to describe itself as
  // simulated — that would be the opposite error.
  const document = buildCapabilityMetadata({
    descriptors: [
      descriptor({
        provider_mode: "real",
        provider_name: "a-real-provider",
        display_label: "Verified by the provider",
      }),
    ],
  });

  assert.equal(document.capabilities.length, 1);
});

test("V009: an empty provider list is not treated as a labelling success", () => {
  // Nothing wired in means nothing to mislabel, so this must build — but it
  // must also not silently claim capabilities it does not have.
  const document = buildCapabilityMetadata({ descriptors: [] });

  assert.deepEqual(document.capabilities, []);
});

test("V009: the document is stamped with a generation time", () => {
  const before = Date.now();
  const document = buildCapabilityMetadata({ descriptors: [descriptor()] });
  const stamped = Date.parse(document.generated_at);

  assert.ok(Number.isFinite(stamped), "generated_at must be a parseable timestamp");
  assert.ok(stamped >= before - 1000 && stamped <= Date.now() + 1000);
});
