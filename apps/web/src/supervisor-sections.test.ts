/**
 * The supervisor dashboard's addresses (supervisor sections design, 2026-09-29).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseSupervisorHash, supervisorHash } from "./supervisor-sections.ts";

test("each part and each queue has an address", () => {
  assert.deepEqual(parseSupervisorHash("#overview"), { view: "overview", queue: "all" });
  assert.deepEqual(parseSupervisorHash("#queues"), { view: "queues", queue: "all" });
  assert.deepEqual(parseSupervisorHash("#queues/overdue"), { view: "queues", queue: "overdue" });
  assert.deepEqual(parseSupervisorHash("#durability"), { view: "durability", queue: "all" });
});

test("anything unrecognised lands on the overview or on every queue, never on nothing", () => {
  assert.deepEqual(parseSupervisorHash(""), { view: "overview", queue: "all" });
  assert.deepEqual(parseSupervisorHash("#admin"), { view: "overview", queue: "all" });
  assert.deepEqual(parseSupervisorHash("#queues/bogus"), { view: "queues", queue: "all" });
});

test("the old in-page anchor still opens durability", () => {
  assert.deepEqual(parseSupervisorHash("#durability-heading"), {
    view: "durability",
    queue: "all",
  });
});

test("addresses round-trip", () => {
  assert.equal(supervisorHash("queues", "reopened"), "#queues/reopened");
  assert.equal(supervisorHash("queues", "all"), "#queues");
  assert.equal(supervisorHash("durability", "overdue"), "#durability");
  for (const hash of ["#overview", "#queues", "#queues/escalated", "#durability"]) {
    const { view, queue } = parseSupervisorHash(hash);
    assert.equal(supervisorHash(view, queue), hash);
  }
});
