/**
 * V044 sample-data privacy audit rules.
 *
 * Two properties are load-bearing and are pinned here:
 *
 *   * **the scanner finds what it claims to find** — every planted probe is
 *     detected, because an audit that always passes is indistinguishable from
 *     one that does not work;
 *   * **a finding never reproduces what it found** — a report carrying the
 *     leaked value has moved that value into a more widely read file.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AUDIT_LIMITS,
  AUDIT_SCOPES,
  IDENTITY_HASH_SHAPE,
  PERSONAL_DATA_PATTERNS,
  PLANTED_PROBES,
  PUBLIC_VIEW_ALLOWED_FIELDS,
  isKeyedHash,
  maskMatch,
  scanText,
  unexpectedPublicFields,
} from "./privacy-audit.ts";

// ---------------------------------------------------------------------------
// The scanner finds what it claims to
// ---------------------------------------------------------------------------

test("every planted probe is detected by its own pattern", () => {
  for (const [patternId, probe] of Object.entries(PLANTED_PROBES)) {
    const definition = PERSONAL_DATA_PATTERNS.find((pattern) => pattern.id === patternId);
    assert.notEqual(definition, undefined, `${patternId} has a probe but no pattern`);
    const scope = definition?.scopes[0];
    assert.notEqual(scope, undefined);
    const findings = scanText(`before ${probe} after`, scope!, "probe");
    assert.ok(
      findings.some((finding) => finding.patternId === patternId),
      `${patternId} was planted and not found`,
    );
  }
});

test("every detectable pattern has a probe, so none is trusted untested", () => {
  for (const pattern of PERSONAL_DATA_PATTERNS) {
    assert.ok(
      Object.hasOwn(PLANTED_PROBES, pattern.id),
      `${pattern.id} claims to detect something with nothing proving it does`,
    );
  }
});

test("a pattern is only checked in the scopes it belongs to", () => {
  // A precise coordinate is a finding in a public view and ordinary in a log.
  assert.ok(scanText("74.512345", "public_view", "x").length > 0);
  assert.equal(scanText("74.512345", "log", "x").length, 0);
});

test("scanning twice finds the same things, because no regex carries its cursor", () => {
  const text = `a@example.invalid and b@example.invalid`;
  const first = scanText(text, "log", "x");
  const second = scanText(text, "log", "x");
  assert.equal(first.length, 2, "both matches, not one");
  assert.deepEqual(second, first);
});

test("every pattern says why the thing it found must not be there", () => {
  for (const pattern of PERSONAL_DATA_PATTERNS) {
    assert.ok(pattern.why.length > 40, `${pattern.id} must explain itself`);
    assert.ok(pattern.scopes.length > 0);
    for (const scope of pattern.scopes) assert.ok(AUDIT_SCOPES.includes(scope));
  }
});

// ---------------------------------------------------------------------------
// A finding never reproduces what it found
// ---------------------------------------------------------------------------

test("a finding carries a masked excerpt and never the value", () => {
  const secret = "someone.real@example.invalid";
  const [finding] = scanText(`note: ${secret}`, "log", "logs/handler.log");
  assert.notEqual(finding, undefined);
  assert.equal(finding?.location, "logs/handler.log");
  assert.doesNotMatch(finding?.maskedExcerpt ?? "", /someone\.real/);
  assert.doesNotMatch(JSON.stringify(finding), /someone\.real/);
});

test("nothing in a whole scan result reproduces a planted value", () => {
  const text = Object.values(PLANTED_PROBES).join(" \n ");
  for (const scope of AUDIT_SCOPES) {
    const serialised = JSON.stringify(scanText(text, scope, "probe"));
    for (const probe of Object.values(PLANTED_PROBES)) {
      // The masked excerpt keeps first and last characters, so compare against
      // the revealing middle of each probe.
      const middle = probe.slice(1, -1);
      if (middle.length < 6) continue;
      assert.doesNotMatch(
        serialised,
        new RegExp(middle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        `a ${scope} finding reproduced a planted value`,
      );
    }
  }
});

test("a short match is fully masked rather than half revealed", () => {
  assert.equal(maskMatch("abcd"), "****");
  assert.match(maskMatch("abcdefghij"), /^a\*+j \(10 chars\)$/);
});

// ---------------------------------------------------------------------------
// Identity records
// ---------------------------------------------------------------------------

test("only a keyed hash counts as a stored identity mapping", () => {
  assert.equal(isKeyedHash("a".repeat(64)), true);
  assert.equal(isKeyedHash("not-a-real-subject"), false);
  assert.equal(isKeyedHash("A".repeat(64)), false, "uppercase is not the digest shape produced");
  assert.equal(isKeyedHash("a".repeat(63)), false);
  assert.match("0123456789abcdef".repeat(4), IDENTITY_HASH_SHAPE);
});

// ---------------------------------------------------------------------------
// Public views
// ---------------------------------------------------------------------------

test("a public view is checked against an allowlist, so a new field is excluded by default", () => {
  const clean = Object.fromEntries(PUBLIC_VIEW_ALLOWED_FIELDS.map((field) => [field, 1]));
  assert.deepEqual(unexpectedPublicFields(clean), []);
  assert.deepEqual(
    unexpectedPublicFields({ ...clean, reporter_participant_id: "x", precise_location: {} }),
    ["reporter_participant_id", "precise_location"],
  );
});

test("the allowlist carries no field that identifies a person or a doorway", () => {
  for (const field of PUBLIC_VIEW_ALLOWED_FIELDS) {
    // `counted_participants` is a count and is allowed; an identifier for one
    // of them is not.
    assert.doesNotMatch(field, /participant_id|reporter|precise|original|raw_/);
  }
  assert.ok(PUBLIC_VIEW_ALLOWED_FIELDS.includes("counted_participants"));
});

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

test("a clean result is never presented as a guarantee", () => {
  const limits = AUDIT_LIMITS.join(" ");
  assert.match(limits, /does not attempt to recognise people's names/);
  assert.match(limits, /not a guarantee that nothing personal is present/);
  assert.match(limits, /does not read image or audio content/);
});
