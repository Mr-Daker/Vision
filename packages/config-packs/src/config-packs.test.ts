import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ConfigPackError,
  depthOf,
  listJurisdictionProfileIds,
  loadJurisdictionProfile,
  rootsOf,
} from "./index.ts";

test("V001 Appendix G rule 7: at least two jurisdiction packs load through one code path", () => {
  const ids = listJurisdictionProfileIds();
  assert.ok(
    ids.length >= 2,
    "portability requires a second synthetic pack, not just the demonstration one",
  );

  for (const id of ids) {
    const profile = loadJurisdictionProfile(id);
    assert.equal(profile.jurisdiction_profile_id, id);
    assert.equal(rootsOf(profile).length, 1, `${id} must have exactly one root`);
    assert.ok(profile.nodes.length > 0);
    assert.match(profile.notice, /synthetic/i);
    assert.ok(profile.nodes.every((node) => node.boundary_multipolygon.length > 0));
  }
});

test("packs may declare different level schemes without code changes", () => {
  const a = loadJurisdictionProfile("demo-district-a");
  const b = loadJurisdictionProfile("demo-district-b");

  assert.notEqual(
    a.level_scheme,
    b.level_scheme,
    "the two packs should exercise different hierarchy shapes",
  );

  const aLevels = new Set(a.nodes.map((node) => node.level_code));
  const bLevels = new Set(b.nodes.map((node) => node.level_code));
  assert.notDeepEqual(aLevels, bLevels, "administrative levels are configuration, not an enum");

  // The urban-style pack is deeper, which proves depth is not hard-coded.
  assert.equal(depthOf(b, "DDB-ULB1-W7"), 2);
  assert.equal(depthOf(a, "DDA-B1"), 1);
});

test("every shipped pack is labelled synthetic", () => {
  for (const id of listJurisdictionProfileIds()) {
    assert.equal(
      loadJurisdictionProfile(id).provenance,
      "team_created_synthetic",
      `${id} must be labelled synthetic until an approved permitted source exists (V004)`,
    );
  }
});

test("an unknown pack fails closed", () => {
  assert.throws(() => loadJurisdictionProfile("no-such-pack"), ConfigPackError);
});
