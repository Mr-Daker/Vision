/**
 * The resident dashboard's options (role dashboards design, 2026-09-29).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { enIN } from "./locales/en-IN.ts";
import { mrIN } from "./locales/mr-IN.ts";
import { DEFAULT_RESIDENT_VIEW, RESIDENT_VIEWS, RESIDENT_VIEW_TITLES } from "./resident-views.ts";

test("the resident dashboard has exactly the four options the design names", () => {
  assert.deepEqual([...RESIDENT_VIEWS], ["report", "reports", "lookup", "nearby"]);
  assert.equal(DEFAULT_RESIDENT_VIEW, "report");
});

test("every view title exists in both language packs", () => {
  for (const view of RESIDENT_VIEWS) {
    const key = RESIDENT_VIEW_TITLES[view];
    assert.ok(enIN.strings[key].length > 0, `${key} is empty in en-IN`);
    assert.ok(mrIN.strings[key].length > 0, `${key} is empty in mr-IN`);
  }
});
