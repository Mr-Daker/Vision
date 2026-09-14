import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ACTION_LABELS,
  KIND_LABELS,
  ageLabel,
  shortReference,
  toReviewerQueueView,
} from "./reviewer-view.ts";

const payload = {
  jurisdiction_id: "11111111-1111-4111-8111-111111111111",
  applied_limit: 50,
  exhaustive: true,
  awaiting_jurisdiction_count: 2,
  awaiting_jurisdiction_note: "two items await a reviewed jurisdiction",
  items: [
    {
      kind: "ambiguous_match",
      target_id: "22222222-2222-4222-8222-222222222222",
      submission_id: "33333333-3333-4333-8333-333333333333",
      reason: "the matcher could not decide",
      permitted_actions: ["attach_to_issue"],
      waiting_since: "2026-09-12T08:00:00.000Z",
      citizen_note: null,
      candidate_issue_ids: ["44444444-4444-4444-8444-444444444444"],
    },
  ],
};

test("V032: a valid queue payload becomes a bounded reviewer view", () => {
  const view = toReviewerQueueView(payload);
  assert.ok(view);
  assert.equal(view.items.length, 1);
  assert.deepEqual(view.items[0]?.permittedActions, ["attach_to_issue"]);
  assert.equal(view.awaitingJurisdictionCount, 2);
});

test("V032: an unknown action or kind fails closed", () => {
  assert.equal(
    toReviewerQueueView({
      ...payload,
      items: [{ ...payload.items[0], permitted_actions: ["delete_report"] }],
    }),
    undefined,
  );
  assert.equal(
    toReviewerQueueView({ ...payload, items: [{ ...payload.items[0], kind: "anything" }] }),
    undefined,
  );
});

test("V032: references are shortened without losing their distinguishing tail", () => {
  assert.equal(shortReference("1234567890abcdef"), "12345678…cdef");
  assert.equal(shortReference("short"), "short");
});

test("V032: queue age is expressed without false precision", () => {
  assert.equal(
    ageLabel("2026-09-12T08:00:00.000Z", Date.parse("2026-09-12T10:10:00Z")),
    "2 hr waiting",
  );
  assert.equal(
    ageLabel("2026-09-10T08:00:00.000Z", Date.parse("2026-09-12T10:10:00Z")),
    "2 days waiting",
  );
});

// ---------------------------------------------------------------------------
// V035 — disputed repair claims as a review kind
// ---------------------------------------------------------------------------

test("V035: a disputed resolution parses as a queue item with its two actions", () => {
  const view = toReviewerQueueView({
    jurisdiction_id: "11111111-1111-4111-8111-111111111111",
    applied_limit: 50,
    exhaustive: true,
    awaiting_jurisdiction_count: 0,
    awaiting_jurisdiction_note: "note",
    items: [
      {
        kind: "disputed_resolution",
        target_id: "22222222-2222-4222-8222-222222222222",
        submission_id: "VIS-ABC",
        reason: "a participant disputes the repair claim for VIS-ABC",
        permitted_actions: ["return_disputed_work", "confirm_disputed_resolution"],
        waiting_since: "2026-09-11T00:00:00.000Z",
        citizen_note: "The pole is still live after rain.",
        candidate_issue_ids: [],
      },
    ],
  });
  assert.equal(view?.items[0]?.kind, "disputed_resolution");
  assert.deepEqual(view?.items[0]?.permittedActions, [
    "return_disputed_work",
    "confirm_disputed_resolution",
  ]);
  // The citizen's own words travel with the row; a reviewer deciding between a
  // department and a resident needs to read what the resident said.
  assert.equal(view?.items[0]?.citizenNote, "The pole is still live after rain.");
});

test("V035: an unknown review action fails the whole payload closed", () => {
  const view = toReviewerQueueView({
    jurisdiction_id: "11111111-1111-4111-8111-111111111111",
    applied_limit: 50,
    exhaustive: true,
    awaiting_jurisdiction_count: 0,
    awaiting_jurisdiction_note: "note",
    items: [
      {
        kind: "disputed_resolution",
        target_id: "22222222-2222-4222-8222-222222222222",
        submission_id: "VIS-ABC",
        reason: "a participant disputes the repair claim",
        permitted_actions: ["overrule_everyone"],
        waiting_since: "2026-09-11T00:00:00.000Z",
        candidate_issue_ids: [],
      },
    ],
  });
  // Invalid private data becomes nothing, never a card offering a power the
  // server did not grant.
  assert.equal(view, undefined);
});

test("V035: the dispute labels name what the decision actually does", () => {
  assert.equal(KIND_LABELS["disputed_resolution"], "Disputed repair claim");
  assert.match(ACTION_LABELS["return_disputed_work"], /back to the crew/i);
  // The override says whose decision it overrides. "Approve" would hide that.
  assert.match(ACTION_LABELS["confirm_disputed_resolution"], /dispute/i);
  for (const label of Object.values(ACTION_LABELS)) {
    assert.doesNotMatch(label, /\bverified\b/i, `an action label claims verification: ${label}`);
  }
});
