/**
 * The sidebar shell's pure decisions (role dashboards design, 2026-09-29).
 *
 * The drawer itself is DOM and is checked in a browser; what is checked here
 * is the part that decides things — which view a hash selects, and where
 * focus goes next inside an open drawer.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveView, trapIndex } from "./shell.ts";

const VIEWS = ["report", "reports", "lookup", "nearby"] as const;

test("a known hash selects its view", () => {
  assert.equal(resolveView("#reports", VIEWS, "report"), "reports");
  assert.equal(resolveView("nearby", VIEWS, "report"), "nearby");
});

test("an empty, unknown or oddly cased hash falls back rather than hiding everything", () => {
  assert.equal(resolveView("", VIEWS, "report"), "report");
  assert.equal(resolveView("#", VIEWS, "report"), "report");
  assert.equal(resolveView("#admin", VIEWS, "report"), "report");
  assert.equal(resolveView("#Reports", VIEWS, "report"), "reports");
});

test("focus wraps inside an open drawer in both directions", () => {
  assert.equal(trapIndex(0, 4, false), 1);
  assert.equal(trapIndex(3, 4, false), 0);
  assert.equal(trapIndex(0, 4, true), 3);
  assert.equal(trapIndex(-1, 4, false), 0);
  assert.equal(trapIndex(-1, 4, true), 3);
  assert.equal(trapIndex(0, 0, false), -1);
});
