/**
 * The inventory the abuse suite is driven from (roadmap V047).
 *
 * If this ever silently returned fewer routes than exist, the cross-site sweep
 * would pass by attacking less. So the shapes it understands are pinned, and
 * the shape it does not understand is required to raise.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RouteInventoryError, ROUTE_MODULES, stateChangingRoutes } from "./route-inventory.ts";

test("every route module is read, and every one contributes or is read-only", () => {
  const routes = stateChangingRoutes();
  assert.ok(routes.length >= 20, `expected the whole surface, got ${String(routes.length)}`);
  const modules = new Set(routes.map((route) => route.module));
  for (const module of ROUTE_MODULES) {
    if (module === "dashboard-routes.ts") {
      assert.equal(modules.has(module), false, "the dashboard surface is read-only by design");
      continue;
    }
    assert.ok(modules.has(module), `${module} contributed no state-changing route`);
  }
});

test("the four guard shapes in use are all resolved", () => {
  const keys = stateChangingRoutes().map((route) => route.key);
  // A literal path.
  assert.ok(keys.includes("POST /v1/submissions"));
  // Two literals on one guard: both, or the second would go unattacked.
  assert.ok(keys.some((key) => key.includes("/v1/auth/logout | /v1/auth/rotate")));
  // A prefix test.
  assert.ok(keys.includes("PUT /v1/uploads/*"));
  // A named matcher declared elsewhere in the module, including across lines.
  assert.ok(keys.some((key) => key.includes("confirm-match|reject-match")));
});

test("a guard shape the scanner does not understand raises rather than being skipped", () => {
  const directory = mkdtempSync(join(tmpdir(), "vision-route-inventory-"));
  for (const name of ROUTE_MODULES) {
    writeFileSync(
      join(directory, name),
      name === "app.ts"
        ? 'if (method === "POST" && somethingElse(path)) {\n}\n'
        : "export const nothing = 1;\n",
      "utf8",
    );
  }
  assert.throws(() => stateChangingRoutes(directory), RouteInventoryError);
});
