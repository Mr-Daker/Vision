/**
 * V038 summary projection rules.
 *
 * The pure half of the acceptance clauses: which issues an event touches
 * (getting this wrong is how a merged report stays counted as separate work),
 * what a reconciliation failure looks like when reported rather than merely
 * detected, and what may not be added across cells.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SUMMARY_MEASURE_SAFETY,
  SUMMARY_STATES,
  UNKNOWN_CELL_KEY,
  affectedIssueIds,
  assessFreshness,
  cellKey,
  diffFacts,
  eventTouchesSummary,
  isOpenState,
  rollUpCells,
  summaryStateOf,
  type FactSnapshot,
  type ProjectionEvent,
} from "./summary-projection.ts";
import type { IssueStatus } from "./transitions.ts";

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

test("every lifecycle status maps to exactly one summary bucket", () => {
  const statuses: readonly IssueStatus[] = [
    "created",
    "routing_review",
    "routed_internal",
    "agency_ack_received",
    "work_planned",
    "resolution_claimed",
    "resolution_confirmed",
    "resolution_disputed",
    "reopened",
  ];
  for (const status of statuses) {
    assert.ok(SUMMARY_STATES.includes(summaryStateOf(status)), `${status} must have a bucket`);
    assert.notEqual(
      summaryStateOf(status),
      "unknown",
      `${status} is known and must not be unknown`,
    );
  }
});

test("an absent or unrecognised status is unknown, never assumed open", () => {
  assert.equal(summaryStateOf(null), "unknown");
  assert.equal(summaryStateOf(undefined), "unknown");
  assert.equal(summaryStateOf("a_status_from_the_future"), "unknown");
});

test("reopened and disputed are open work; only a standing confirmation is not", () => {
  assert.equal(isOpenState("reopened"), true, "a reopened issue counted as closed is the worst");
  assert.equal(isOpenState("disputed"), true);
  assert.equal(isOpenState("claimed"), true);
  assert.equal(isOpenState("open"), true);
  assert.equal(isOpenState("confirmed"), false);
  assert.equal(isOpenState("unknown"), false, "an unplaceable issue is not asserted to be open");
});

test("an issue with no jurisdiction gets a visible UNKNOWN cell, not a null one", () => {
  assert.equal(cellKey(null), UNKNOWN_CELL_KEY);
  assert.equal(cellKey(undefined), UNKNOWN_CELL_KEY);
  assert.equal(cellKey(""), UNKNOWN_CELL_KEY);
  assert.equal(cellKey("ward-7"), "ward-7");
});

// ---------------------------------------------------------------------------
// Which issues an event touches
// ---------------------------------------------------------------------------

const event = (over: Partial<ProjectionEvent>): ProjectionEvent => ({
  eventId: "e1",
  aggregateType: "canonical_issue",
  aggregateId: "issue-a",
  eventType: "resolution_claimed",
  payload: {},
  ...over,
});

test("an ordinary event touches its own issue", () => {
  assert.deepEqual(affectedIssueIds(event({})), ["issue-a"]);
});

test("a merge touches the issue that was merged away, not only the survivor", () => {
  const merged = affectedIssueIds(
    event({
      eventType: "issue_merged",
      aggregateId: "survivor",
      payload: { merged_issue_id: "retired", reason: "same pole" },
    }),
  );
  assert.deepEqual(merged, ["retired", "survivor"]);
});

test("a merge reversal touches both sides too, which is what frees the separated issue", () => {
  const reversed = affectedIssueIds(
    event({
      eventType: "issue_merge_reversed",
      aggregateId: "survivor",
      payload: { merged_issue_id: "freed" },
    }),
  );
  assert.ok(reversed.includes("freed"));
  assert.ok(reversed.includes("survivor"));
});

test("events on other aggregates do not touch this projection", () => {
  assert.equal(eventTouchesSummary(event({ aggregateType: "submission" })), false);
  assert.deepEqual(affectedIssueIds(event({ aggregateType: "submission" })), []);
  assert.equal(eventTouchesSummary(event({})), true);
});

test("a payload field that is not an identifier is ignored rather than trusted", () => {
  const ids = affectedIssueIds(event({ payload: { merged_issue_id: 42, issue_id: "" } }));
  assert.deepEqual(ids, ["issue-a"]);
});

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

const exclusive = { mutuallyExclusive: true } as const;

test("issue counts add across cells; distinct participant counts never do", () => {
  const parts = [
    { boundaryId: "ward-1", boundaryVersion: "v1", value: 9 },
    { boundaryId: "ward-2", boundaryVersion: "v1", value: 9 },
  ];

  const issues = rollUpCells("open", parts, exclusive);
  assert.equal(issues.ok, true);
  if (issues.ok) assert.equal(issues.value.value, 18);

  const people = rollUpCells("countedParticipants", parts, exclusive);
  assert.equal(people.ok, false, "the same person can report in two wards");
  if (!people.ok) assert.equal(people.unknownReason, "not_additive");
});

test("living in a projection table does not make a distinct count summable", () => {
  assert.equal(SUMMARY_MEASURE_SAFETY.countedParticipants, "not_additive");
  for (const measure of [
    "issues",
    "open",
    "claimed",
    "disputed",
    "confirmed",
    "reopened",
  ] as const) {
    assert.equal(SUMMARY_MEASURE_SAFETY[measure], "additive");
  }
});

// ---------------------------------------------------------------------------
// Reconciliation reporting
// ---------------------------------------------------------------------------

const fact = (over: Partial<FactSnapshot>): FactSnapshot => ({
  issueId: "i1",
  rootIssueId: "i1",
  retiredByMerge: false,
  jurisdictionKey: "ward-1",
  category: "water_supply",
  state: "open",
  countedParticipants: 2,
  ...over,
});

test("identical projections reconcile with nothing to report", () => {
  assert.deepEqual(diffFacts([fact({})], [fact({})]), []);
});

test("a reconciliation failure names the issue, the field, and both values", () => {
  const differences = diffFacts([fact({ state: "confirmed" })], [fact({ state: "reopened" })]);
  assert.equal(differences.length, 1);
  assert.deepEqual(differences[0], {
    issueId: "i1",
    field: "state",
    incremental: "confirmed",
    rebuilt: "reopened",
  });
});

test("an issue present on one side only is reported in both directions", () => {
  const extra = diffFacts([fact({}), fact({ issueId: "i2" })], [fact({})]);
  assert.deepEqual(extra, [
    { issueId: "i2", field: "presence", incremental: "present", rebuilt: "absent" },
  ]);

  const missing = diffFacts([fact({})], [fact({}), fact({ issueId: "i2" })]);
  assert.deepEqual(missing, [
    { issueId: "i2", field: "presence", incremental: "absent", rebuilt: "present" },
  ]);
});

test("a stale merge attribution is reported rather than tolerated", () => {
  const differences = diffFacts(
    [fact({ rootIssueId: "other", retiredByMerge: true })],
    [fact({ rootIssueId: "i1", retiredByMerge: false })],
  );
  assert.deepEqual(
    differences.map((difference) => difference.field),
    ["retiredByMerge", "rootIssueId"],
  );
});

test("differences are ordered, so two runs of the same failure read the same", () => {
  const differences = diffFacts(
    [fact({ issueId: "b", state: "open" }), fact({ issueId: "a", category: "x" })],
    [fact({ issueId: "b", state: "confirmed" }), fact({ issueId: "a", category: "y" })],
  );
  assert.deepEqual(
    differences.map((difference) => difference.issueId),
    ["a", "b"],
  );
});

// ---------------------------------------------------------------------------
// Freshness
// ---------------------------------------------------------------------------

const asOfMs = Date.UTC(2026, 8, 17, 12, 0, 0);

test("a summary that has never been built says so, rather than reporting zeros", () => {
  const verdict = assessFreshness(
    {
      lastRefreshedAtMs: null,
      lastRebuildAtMs: null,
      pendingEvents: 0,
      unprojectedIssues: 0,
      asOfMs,
    },
    120,
  );
  assert.equal(verdict.state, "never_built");
  assert.equal(verdict.stalenessSeconds, null);
  assert.match(verdict.explanation, /absent rather than zero/);
});

test("a projection that ran recently with nothing pending is fresh", () => {
  const verdict = assessFreshness(
    {
      lastRefreshedAtMs: asOfMs - 10_000,
      lastRebuildAtMs: asOfMs,
      pendingEvents: 0,
      unprojectedIssues: 0,
      asOfMs,
    },
    120,
  );
  assert.equal(verdict.state, "fresh");
  assert.equal(verdict.stalenessSeconds, 10);
});

test("a projection that ran a moment ago but skipped events is lagging, not fresh", () => {
  const verdict = assessFreshness(
    {
      lastRefreshedAtMs: asOfMs - 1_000,
      lastRebuildAtMs: asOfMs,
      pendingEvents: 400,
      unprojectedIssues: 0,
      asOfMs,
    },
    120,
  );
  assert.equal(verdict.state, "lagging", "recency alone is not freshness");
  assert.match(verdict.explanation, /400 event\(s\) not yet applied/);
  assert.match(verdict.explanation, /behind the record/);
});

test("a record that never emitted an event still makes the projection lagging", () => {
  // The case an event backlog cannot see: no production path appends an event
  // when an issue is opened, so a brand-new report adds nothing to the queue
  // while being entirely absent from the summary. Reporting "nothing pending"
  // here would be the most misleading thing this function could say.
  const verdict = assessFreshness(
    {
      lastRefreshedAtMs: asOfMs - 1_000,
      lastRebuildAtMs: asOfMs,
      pendingEvents: 0,
      unprojectedIssues: 1,
      asOfMs,
    },
    120,
  );
  assert.equal(verdict.state, "lagging");
  assert.match(verdict.explanation, /1 record\(s\) never projected/);
});

test("a projection older than its tolerance is lagging even with nothing pending", () => {
  const verdict = assessFreshness(
    {
      lastRefreshedAtMs: asOfMs - 600_000,
      lastRebuildAtMs: null,
      pendingEvents: 0,
      unprojectedIssues: 0,
      asOfMs,
    },
    120,
  );
  assert.equal(verdict.state, "lagging");
  assert.equal(verdict.stalenessSeconds, 600);
});

test("a clock that runs backwards does not produce a negative staleness", () => {
  const verdict = assessFreshness(
    {
      lastRefreshedAtMs: asOfMs + 5_000,
      lastRebuildAtMs: null,
      pendingEvents: 0,
      unprojectedIssues: 0,
      asOfMs,
    },
    120,
  );
  assert.equal(verdict.stalenessSeconds, 0);
});
