/**
 * Deterministic triage ordering (roadmap V034).
 *
 * V034 recorded that "urgency is not implemented ... inventing one here would
 * be a policy decision disguised as a field". That reasoning still holds, so
 * this is deliberately **not** an urgency model. It is an *ordering policy*:
 * whoever configures the deployment says which categories they want to see
 * first, and this puts the list in that order and states why.
 *
 * The distinction is the whole point. An urgency score would claim something
 * about the world — that this pothole is more dangerous than that drain. An
 * ordering policy claims only that somebody decided to look at one kind of
 * report before another. So:
 *
 *  * the result carries no score, only a position and the reasons for it;
 *  * the policy's version and its own caveat travel with every ordering;
 *  * ties break deterministically, so the same input always gives the same
 *    list — a queue that reshuffles between page loads loses items.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { orderTriageQueue, type TriagePolicy, type TriageCandidate } from "./triage-order.ts";

const policy: TriagePolicy = {
  version: "demo-triage.v1",
  note: "An ordering chosen by this deployment. Not a severity, risk or urgency assessment.",
  categoryOrder: ["structural", "electrical", "water_supply", "sanitation"],
  ageEscalationDays: 14,
};

const item = (overrides: Partial<TriageCandidate> = {}): TriageCandidate => ({
  issueId: "issue-1",
  publicReference: "VIS-00000001",
  category: "sanitation",
  ageDays: 1,
  countedParticipants: 1,
  ...overrides,
});

test("V034: the configured category order is what decides the list", () => {
  const ordered = orderTriageQueue(
    [
      item({ issueId: "a", publicReference: "VIS-A", category: "sanitation" }),
      item({ issueId: "b", publicReference: "VIS-B", category: "structural" }),
    ],
    policy,
  );

  assert.deepEqual(
    ordered.map((entry) => entry.issueId),
    ["b", "a"],
  );
  assert.equal(ordered[0]?.position, 1);
});

test("V034: a category the policy does not list goes last, not first", () => {
  // An unlisted category is one nobody has decided about. Putting it first
  // would be a decision the policy never made; putting it last at least keeps
  // it behind everything that was decided — and it is still reported, not
  // dropped.
  const ordered = orderTriageQueue(
    [
      item({ issueId: "unlisted", publicReference: "VIS-U", category: "never-configured" }),
      item({ issueId: "known", publicReference: "VIS-K", category: "sanitation" }),
    ],
    policy,
  );

  assert.deepEqual(
    ordered.map((entry) => entry.issueId),
    ["known", "unlisted"],
  );
  assert.match(ordered[1]?.basis.join(" ") ?? "", /no ordering rule|not listed/i);
});

test("V034: nothing in the result is a score", () => {
  // A number between 0 and 1, or 0 and 100, invites being read as a
  // measurement of how bad the problem is. There is no such measurement
  // (V046 is where calibration would live), so there is no such number.
  const ordered = orderTriageQueue([item()], policy);
  const entry = ordered[0];

  assert.ok(entry !== undefined);
  assert.equal(Object.hasOwn(entry, "score"), false);
  assert.equal(Object.hasOwn(entry, "urgency"), false);
  assert.equal(Object.hasOwn(entry, "severity"), false);
  assert.equal(Object.hasOwn(entry, "priorityScore"), false);
  // The position is a place in a list, and says so.
  assert.equal(entry.position, 1);
});

test("V034: the policy version and its caveat travel with every entry", () => {
  const ordered = orderTriageQueue([item()], policy);

  assert.equal(ordered[0]?.policyVersion, "demo-triage.v1");
  assert.match(ordered[0]?.policyNote ?? "", /[Nn]ot a severity/);
});

test("V034: the basis names the actual reason for the position", () => {
  const ordered = orderTriageQueue(
    [item({ category: "structural" }), item({ issueId: "z", category: "sanitation" })],
    policy,
  );

  // Asserting the two names appear is too weak — any string containing them
  // passes. The basis has to state what the policy actually did: which
  // category, at which position, out of how many.
  assert.match(
    ordered[0]?.basis.join(" ") ?? "",
    /policy 'demo-triage\.v1' places category 'structural' at position 1 of 4/,
  );
  assert.match(
    ordered[1]?.basis.join(" ") ?? "",
    /places category 'sanitation' at position 4 of 4/,
  );
});

test("V034: within one category the oldest report comes first", () => {
  // Both ages are under the 14-day escalation threshold, so this exercises the
  // within-category ordering rather than the escalation branch. An earlier
  // version used 30 days, which escalated and therefore proved nothing about
  // ordering inside a category.
  const ordered = orderTriageQueue(
    [
      item({ issueId: "new", publicReference: "VIS-N", ageDays: 3 }),
      item({ issueId: "old", publicReference: "VIS-O", ageDays: 10 }),
    ],
    policy,
  );

  assert.deepEqual(
    ordered.map((entry) => entry.issueId),
    ["old", "new"],
  );
});

test("V034: a report older than the escalation threshold overtakes its category", () => {
  // Without this a low-placed category is never looked at. The threshold is
  // configured, not chosen here — the policy decides how long is too long.
  const ordered = orderTriageQueue(
    [
      item({
        issueId: "fresh-structural",
        publicReference: "VIS-S",
        category: "structural",
        ageDays: 1,
      }),
      item({
        issueId: "stale-sanitation",
        publicReference: "VIS-T",
        category: "sanitation",
        ageDays: 40,
      }),
    ],
    policy,
  );

  assert.deepEqual(
    ordered.map((entry) => entry.issueId),
    ["stale-sanitation", "fresh-structural"],
  );
  assert.match(ordered[0]?.basis.join(" ") ?? "", /waiting|40 days|longer than/i);
});

test("V034: participant count does not change the order", () => {
  // A count of reporters measures who has a phone and who knows the service
  // exists, not how bad the problem is. Ordering by it would put the
  // best-connected neighbourhoods first, which is the failure mode this
  // project exists to avoid.
  const ordered = orderTriageQueue(
    [
      item({ issueId: "few", publicReference: "VIS-F", countedParticipants: 1, ageDays: 5 }),
      item({ issueId: "many", publicReference: "VIS-M", countedParticipants: 99, ageDays: 5 }),
    ],
    policy,
  );

  // Same category, same age: the tiebreak is the reference, not the count.
  assert.deepEqual(
    ordered.map((entry) => entry.issueId),
    ["few", "many"],
  );
});

test("V034: the same input always gives the same order", () => {
  // A queue that reshuffles between page loads loses items: a reviewer
  // working down it sees some twice and some never.
  // Twenty items in the same category at the same age, so every comparison
  // falls through to the final tiebreak. Three items were not enough: a
  // random comparator can return the same order by chance, and a test that
  // sometimes passes against a broken comparator is no test at all.
  const items = Array.from({ length: 20 }, (_, index) =>
    item({
      issueId: `issue-${String(index)}`,
      publicReference: `VIS-${String(index).padStart(3, "0")}`,
      category: "sanitation",
      ageDays: 5,
    }),
  );

  const first = orderTriageQueue(items, policy).map((entry) => entry.publicReference);
  const reversed = orderTriageQueue([...items].reverse(), policy).map(
    (entry) => entry.publicReference,
  );

  assert.deepEqual(first, reversed);
  // And the tiebreak is specifically the public reference, ascending — stated
  // rather than merely stable, so "deterministic" cannot be satisfied by any
  // arbitrary fixed order.
  assert.deepEqual(first, [...first].sort());
});

test("V034: ordering does not mutate the list it was given", () => {
  const items = [
    item({ issueId: "a", publicReference: "VIS-A", category: "sanitation" }),
    item({ issueId: "b", publicReference: "VIS-B", category: "structural" }),
  ];
  const before = items.map((entry) => entry.issueId);

  orderTriageQueue(items, policy);

  assert.deepEqual(
    items.map((entry) => entry.issueId),
    before,
  );
});

test("V034: an empty list orders to an empty list", () => {
  assert.deepEqual(orderTriageQueue([], policy), []);
});

test("V034: a policy with no note is refused", () => {
  // The note is the only place the ordering says it is not a severity
  // judgement. Without it the field is exactly the "policy decision disguised
  // as a field" V034 refused to build.
  assert.throws(() => orderTriageQueue([item()], { ...policy, note: "  " }), /note/i);
});

test("V034: a policy with no version is refused", () => {
  assert.throws(() => orderTriageQueue([item()], { ...policy, version: "" }), /version/i);
});
