/**
 * Private worker description tests (roadmap V006 D3, V017).
 *
 * The worker used to be an honest placeholder — `not_implemented_no_stages_registered`
 * — and these tests existed to stop that self-description going stale. It has
 * now stopped being a placeholder: `buildStageHandlers` registers the media and
 * matching stages and `runRelayOnce` runs them.
 *
 * So the property under test inverts. It is no longer "does it still admit it
 * runs nothing", it is "does it name exactly the stages it actually registers".
 * A worker that overstates what it runs is the same class of defect as one that
 * understated it, and harder to notice.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { WORKER_STATUS, describeWorker, REGISTERED_TASK_TYPES } from "./index.ts";

test("V017: the worker no longer claims to register nothing", () => {
  assert.doesNotMatch(WORKER_STATUS, /not_implemented/);
  assert.doesNotMatch(describeWorker(), /no stages registered/);
});

test("V017: the worker names exactly the task types it handles", () => {
  // Not a superset and not a subset. A name here that no handler serves would
  // have the relay claim work it then cannot do, and a handler missing from
  // this list would never be claimed at all.
  assert.deepEqual([...REGISTERED_TASK_TYPES].sort(), [
    "match_submission",
    "process_submission_media",
  ]);
  for (const taskType of REGISTERED_TASK_TYPES) {
    assert.match(describeWorker(), new RegExp(taskType));
  }
});

test("V017/V033: the description says how jurisdiction is resolved", () => {
  // A reader must know that the worker uses a versioned boundary pack and
  // refuses to guess when a point or its accuracy range is ambiguous.
  const text = describeWorker();

  assert.match(text, /jurisdiction/i);
  assert.match(text, /versioned boundary pack/i);
  assert.match(text, /uncertain edges.*review/i);
});
