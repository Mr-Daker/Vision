/**
 * Redaction policy tests (roadmap V021, enforcing V005 §§4-7).
 *
 * Two separable concerns live here:
 *
 *  1. Contact details in text and transcripts, which can be found
 *     deterministically and so are genuinely redacted.
 *  2. Faces and number plates in photographs, which cannot be found without a
 *     detector. This codebase has no detector, so the policy must treat every
 *     photograph as an *unresolved* case and quarantine it rather than
 *     pretending it was checked.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  redactContactDetails,
  decidePhotoRedaction,
  CONTACT_PLACEHOLDER,
  type RedactionRegion,
} from "./redaction-policy.ts";

test("V021: a telephone number is removed from report text", () => {
  const result = redactContactDetails("Call me on 9876543210 about the broken tap");

  assert.doesNotMatch(result.redactedText, /9876543210/);
  assert.match(result.redactedText, /broken tap/, "the report itself must survive redaction");
  assert.deepEqual(
    result.redactions.map((r) => r.kind),
    ["phone_number"],
  );
});

test("V021: an email address is removed", () => {
  const result = redactContactDetails("reach me at person@example.org please");

  assert.doesNotMatch(result.redactedText, /person@example\.org/);
  assert.deepEqual(
    result.redactions.map((r) => r.kind),
    ["email_address"],
  );
});

test("V021: a long digit sequence that could be a national identifier is removed", () => {
  const result = redactContactDetails("my number is 1234 5678 9012 on the card");

  assert.doesNotMatch(result.redactedText, /1234 5678 9012/);
  assert.deepEqual(
    result.redactions.map((r) => r.kind),
    ["long_digit_sequence"],
  );
});

test("V021: ordinary measurements and counts are not redacted", () => {
  // Over-redaction destroys the report. A citizen writing "3 of 12 taps are
  // broken since 2024" must keep every one of those numbers.
  const original = "3 of 12 taps are broken since 2024, room 7 is worst";

  const result = redactContactDetails(original);

  assert.equal(result.redactedText, original);
  assert.deepEqual(result.redactions, []);
});

test("V021: redaction reports every occurrence, not just the first", () => {
  const result = redactContactDetails("9876543210 or a@b.org or 9123456789");

  assert.deepEqual(
    result.redactions.map((r) => r.kind),
    ["phone_number", "email_address", "phone_number"],
  );
});

test("V021: redaction is idempotent", () => {
  const once = redactContactDetails("call 9876543210");
  const twice = redactContactDetails(once.redactedText);

  assert.equal(twice.redactedText, once.redactedText);
  assert.deepEqual(twice.redactions, [], "the placeholder must not itself look redactable");
});

test("V021: the placeholder states that something was removed", () => {
  // A silently deleted phone number would misrepresent what the citizen
  // wrote; the reader must be able to see that a removal happened.
  const result = redactContactDetails("call 9876543210");

  assert.match(result.redactedText, new RegExp(CONTACT_PLACEHOLDER.replace(/[[\]]/g, "\\$&")));
});

test("V021: a photograph with no detector available is never approved", () => {
  const decision = decidePhotoRedaction({ regions: undefined, detectorLabel: undefined });

  assert.equal(decision.status, "needs_review");
  assert.match(decision.reasons.join(" "), /no detector/i);
  assert.equal(decision.mayEnterPublicView, false);
  assert.equal(decision.mayEnterAiPath, false);
});

test("V021: a photograph a simulated detector cleared is still not treated as verified", () => {
  const decision = decidePhotoRedaction({
    regions: [],
    detectorLabel: "simulated fixture detector",
  });

  // An empty region list from a simulated detector is not evidence that the
  // photograph contains no face, so it cannot be auto-approved.
  assert.equal(decision.status, "needs_review");
  assert.match(decision.reasons.join(" "), /simulated/i);
});

test("V021: redacted regions are recorded so a reviewer can see what was covered", () => {
  const regions: readonly RedactionRegion[] = [
    { x: 10, y: 20, width: 30, height: 40, kind: "face", detectedBy: "fixture" },
  ];

  const decision = decidePhotoRedaction({ regions, detectorLabel: "simulated fixture detector" });

  assert.equal(decision.regions.length, 1);
  assert.equal(decision.regions[0]?.kind, "face");
  assert.equal(decision.status, "needs_review");
});

test("V021: a spaced list of small numbers is not mistaken for a contact number", () => {
  // This reaches the digit-count guard, which the sentence in the test above
  // does not: letters there break the run before the count is consulted. A
  // citizen listing affected rooms must keep every number.
  const original = "taps in rooms 1 2 3 4 5 are dry";

  const result = redactContactDetails(original);

  assert.equal(result.redactedText, original);
  assert.deepEqual(result.redactions, []);
});
