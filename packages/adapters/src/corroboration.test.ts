/**
 * Corroboration-signal adapter tests (roadmap V025).
 *
 * Live eligible participation arrives at V029. Until then the count comes from
 * fixtures, and the only way this is acceptable is if every consumer can tell.
 * So the adapter reports `inputIsFixture: true` and labels itself simulated —
 * it cannot quietly pass for the real thing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { newCorrelationId, type AdapterCallContext } from "@vision/contracts";

import { FixtureCorroborationAdapter } from "./corroboration.ts";

const context = (): AdapterCallContext => ({ correlation_id: newCorrelationId() });

const adapter = () =>
  new FixtureCorroborationAdapter({
    counts: { "issue-with-three": 3, "issue-with-one": 1 },
  });

test("V025: the adapter labels itself simulated", () => {
  const descriptor = adapter().descriptor;

  assert.equal(descriptor.provider_mode, "simulated");
  assert.match(descriptor.capability.display_label.toLowerCase(), /simulated|fixture/);
});

test("V025: every count is marked as coming from a fixture", async () => {
  const outcome = await adapter().countEligibleParticipants("issue-with-three", context());

  assert.equal(outcome.kind, "success");
  if (outcome.kind !== "success") return;
  assert.equal(outcome.value.eligibleParticipants, 3);
  assert.equal(outcome.value.inputIsFixture, true);
});

test("V025: an unknown issue reports zero rather than inventing a count", async () => {
  const outcome = await adapter().countEligibleParticipants("never-seen", context());

  assert.equal(outcome.kind, "success");
  if (outcome.kind !== "success") return;
  assert.equal(outcome.value.eligibleParticipants, 0);
  assert.match(outcome.value.note, /no fixture|not .*fixture/i);
});

test("V025: an absent count is not reported as an error", async () => {
  // V010's rule: an empty result is a successful "we know of none", not a
  // failure, and never "nobody else has this problem".
  const outcome = await adapter().countEligibleParticipants("never-seen", context());

  assert.equal(outcome.kind, "success");
});

test("V025: the count is never presented as carrying external authority", async () => {
  const outcome = await adapter().countEligibleParticipants("issue-with-three", context());

  assert.equal(outcome.provenance.provider_mode, "simulated");
  assert.equal((outcome.provenance as { authenticity?: string }).authenticity, "simulated_fixture");
  assert.equal((outcome.provenance as { fixture_id?: string }).fixture_id !== undefined, true);
});

test("V025: a negative or non-integer fixture count is refused at construction", () => {
  for (const counts of [{ a: -1 }, { a: 1.5 }]) {
    assert.throws(() => new FixtureCorroborationAdapter({ counts }), /count/i);
  }
});
