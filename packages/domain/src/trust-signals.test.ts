/**
 * Independent trust signals (roadmap V025, bounded by V002).
 *
 * The failure this exists to prevent is a single "trust score". Four separate
 * observations, each with its own meaning and its own limits, must stay four
 * separate observations — and none of them may be read as proof that a person
 * is who they say, was where they say, took the photograph they submitted, or
 * described the severity accurately. Those are four different claims.
 *
 * The rule that does the most work: missing metadata is *unknown*, never
 * *inconsistent*. A cheap phone that strips EXIF is not a fraud signal.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { evaluateTrustSignals, SIGNAL_IDS, type TrustSignalInput } from "./trust-signals.ts";

const baseline: TrustSignalInput = {
  capture: {
    source: "device_geolocation",
    accuracyMetres: 12,
    observedAt: "2026-09-10T10:00:00Z",
    submittedAt: "2026-09-10T10:05:00Z",
  },
  media: {
    hasPhoto: true,
    captureTimestampPresent: true,
    capturedAt: "2026-09-10T09:58:00Z",
    fingerprintSeenBefore: false,
    otherEvidenceIds: [],
  },
  descriptionConsistency: { verdict: "consistent", reason: "the text and the image agree" },
  corroboration: { eligibleParticipants: 3, inputIsFixture: true },
};

const findSignal = (report: ReturnType<typeof evaluateTrustSignals>, id: string) => {
  const check = report.checks.find((candidate) => candidate.signal === id);
  assert.notEqual(check, undefined, `${id} must be reported`);
  return check;
};

test("V025: every signal is reported separately, with no combined score", () => {
  const report = evaluateTrustSignals(baseline);

  assert.deepEqual(
    report.checks.map((check) => check.signal),
    [...SIGNAL_IDS],
  );
  // No aggregate. A single number would be read as a probability of honesty,
  // and nothing here is calibrated (V002 prohibition 9).
  assert.equal("score" in report, false);
  assert.equal("trustScore" in report, false);
  assert.equal(report.calibratedScore, undefined);
});

test("V025: every check carries an inspectable reason", () => {
  const report = evaluateTrustSignals(baseline);

  for (const check of report.checks) {
    assert.ok(
      check.reason.length > 10,
      `${check.signal} needs a real reason, got: ${check.reason}`,
    );
    assert.ok(
      check.doesNotEstablish.length > 0,
      `${check.signal} must state what it does not establish`,
    );
  }
});

test("V025: a missing capture timestamp is unknown, not inconsistent", () => {
  const report = evaluateTrustSignals({
    ...baseline,
    media: { ...baseline.media, captureTimestampPresent: false, capturedAt: undefined },
  });

  const check = findSignal(report, "timestamp_availability");
  assert.equal(check?.verdict, "unknown");
  assert.notEqual(check?.verdict, "inconsistent");
  assert.match(check?.reason ?? "", /not record|absent|did not/i);
  assert.match(check?.doesNotEstablish.join(" ") ?? "", /fraud|dishonest|false/i);
});

test("V025: a typed location is not treated as an inconsistency", () => {
  // A manual pin is a claim, not a failed measurement. Marking it
  // inconsistent would punish anyone whose phone cannot get a fix.
  const report = evaluateTrustSignals({
    ...baseline,
    capture: { ...baseline.capture, source: "manual_pin", accuracyMetres: undefined },
  });

  const check = findSignal(report, "capture_consistency");
  assert.notEqual(check?.verdict, "inconsistent");
  assert.equal(check?.verdict, "unknown");
});

test("V025: a photo captured long before the report is flagged as inconsistent", () => {
  const report = evaluateTrustSignals({
    ...baseline,
    media: { ...baseline.media, capturedAt: "2026-08-01T09:00:00Z" },
  });

  const check = findSignal(report, "capture_consistency");
  assert.equal(check?.verdict, "inconsistent");
  assert.match(check?.reason ?? "", /before/i);
  // Even an inconsistency is not proof of anything about the person.
  assert.match(check?.doesNotEstablish.join(" ") ?? "", /fraud|deliberate|who/i);
});

test("V025: reused media is reported and is never corroboration", () => {
  const report = evaluateTrustSignals({
    ...baseline,
    media: { ...baseline.media, fingerprintSeenBefore: true, otherEvidenceIds: ["e1", "e2"] },
  });

  const reuse = findSignal(report, "known_media_reuse");
  assert.equal(reuse?.verdict, "inconsistent");
  assert.match(reuse?.reason ?? "", /submitted before|reuse/i);
  assert.match(reuse?.doesNotEstablish.join(" ") ?? "", /corroborat/i);
  // "The same bytes appeared twice" says nothing about *who* submitted them.
  // Reading reuse as evidence about a person is the specific wrong inference
  // this check has to head off.
  assert.match(reuse?.doesNotEstablish.join(" ") ?? "", /who the reporter is/i);

  // And it must not inflate the corroboration signal.
  const corroboration = findSignal(report, "independent_corroboration");
  assert.equal(corroboration?.countsReuseAsIndependent, false);
});

test("V025: a fixture-backed corroboration input is labelled as a fixture", () => {
  const report = evaluateTrustSignals(baseline);

  const check = findSignal(report, "independent_corroboration");
  assert.equal(check?.inputIsFixture, true);
  assert.match(check?.reason ?? "", /fixture|simulat/i);
  assert.equal(report.anyInputIsFixture, true);
});

test("V025: live corroboration is not labelled a fixture", () => {
  const report = evaluateTrustSignals({
    ...baseline,
    corroboration: { eligibleParticipants: 4, inputIsFixture: false },
  });

  const check = findSignal(report, "independent_corroboration");
  assert.equal(check?.inputIsFixture, false);
  assert.equal(report.anyInputIsFixture, false);
});

test("V025: an absent image-description verdict is unknown rather than assumed consistent", () => {
  const report = evaluateTrustSignals({ ...baseline, descriptionConsistency: undefined });

  const check = findSignal(report, "image_description_consistency");
  assert.equal(check?.verdict, "unknown");
});

test("V025: a report with no photo marks the photo-only signals not applicable", () => {
  const report = evaluateTrustSignals({
    ...baseline,
    media: {
      hasPhoto: false,
      captureTimestampPresent: false,
      capturedAt: undefined,
      fingerprintSeenBefore: false,
      otherEvidenceIds: [],
    },
    descriptionConsistency: undefined,
  });

  assert.equal(findSignal(report, "image_description_consistency")?.verdict, "not_applicable");
  assert.equal(findSignal(report, "known_media_reuse")?.verdict, "not_applicable");
  assert.equal(findSignal(report, "timestamp_availability")?.verdict, "not_applicable");
});

test("V025: the four distinct claims are never merged", () => {
  const report = evaluateTrustSignals(baseline);

  // Identity, physical presence, image authenticity and factual severity are
  // separate claims, and nothing in this report may assert any of them.
  assert.deepEqual(report.claimsNotEstablished, [
    "identity",
    "physical_presence",
    "image_authenticity",
    "factual_severity",
  ]);
});

test("V025: review is requested when any signal is inconsistent, with the reasons attached", () => {
  const report = evaluateTrustSignals({
    ...baseline,
    media: { ...baseline.media, fingerprintSeenBefore: true, otherEvidenceIds: ["e1"] },
  });

  assert.equal(report.requiresReview, true);
  assert.ok(report.reviewReasons.length >= 1);
  assert.match(report.reviewReasons.join(" "), /reuse|submitted before/i);
});

test("V025: unknown signals alone do not demand review", () => {
  // Otherwise every cheap phone would generate a review queue item, which
  // makes the queue useless and penalises the least-equipped reporters.
  const report = evaluateTrustSignals({
    ...baseline,
    capture: { ...baseline.capture, source: "manual_pin", accuracyMetres: undefined },
    media: { ...baseline.media, captureTimestampPresent: false, capturedAt: undefined },
    descriptionConsistency: undefined,
  });

  assert.equal(report.requiresReview, false);
  assert.ok(report.checks.some((check) => check.verdict === "unknown"));
});
