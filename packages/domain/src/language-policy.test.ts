/**
 * Multilingual understanding policy (roadmap V024).
 *
 * The failure this exists to prevent: a report in a language nobody has
 * evaluated being machine-translated into a confident English label, so the
 * uncertainty disappears and a reviewer never learns it was there. The rules
 * are therefore about what stays *visible*.
 *
 * The enabled language list is data supplied by the caller, never a branch in
 * this file (V001 Appendix G rule 7).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  assessTranscription,
  decideLanguageHandling,
  TRANSCRIPT_UNCERTAINTY_FLOOR,
} from "./language-policy.ts";

const ENABLED = ["en-IN", "mr-IN"];

test("V024: an enabled language is handled normally", () => {
  const decision = decideLanguageHandling({ detected: "mr-IN", enabled: ENABLED });

  assert.equal(decision.enabled, true);
  assert.equal(decision.requiresReview, false);
  assert.equal(decision.mayAutoClassify, true);
});

test("V024: a language outside the enabled pack is visible, never silently translated", () => {
  const decision = decideLanguageHandling({ detected: "ta-IN", enabled: ENABLED });

  assert.equal(decision.enabled, false);
  assert.equal(decision.requiresReview, true);
  assert.equal(decision.mayAutoClassify, false);
  assert.match(decision.reasons.join(" "), /not .*enabled|outside/i);
  assert.equal(decision.translated, false, "translating an unevaluated language hides the risk");
});

test("V024: a base language matches an enabled regional tag", () => {
  // Someone reporting in "mr" must not be treated as unsupported because the
  // pack happens to name "mr-IN".
  const decision = decideLanguageHandling({ detected: "mr", enabled: ENABLED });

  assert.equal(decision.enabled, true);
});

test("V024: an undetected language is review, not an assumed default", () => {
  const decision = decideLanguageHandling({ detected: undefined, enabled: ENABLED });

  assert.equal(decision.enabled, false);
  assert.equal(decision.requiresReview, true);
  assert.match(decision.reasons.join(" "), /not detected|unknown/i);
});

test("V024: the enabled list comes from the caller, so an empty pack enables nothing", () => {
  const decision = decideLanguageHandling({ detected: "en-IN", enabled: [] });

  assert.equal(decision.enabled, false);
  assert.equal(decision.mayAutoClassify, false);
});

test("V024: a confident transcript in an enabled language may be classified", () => {
  const assessment = assessTranscription({
    transcriptText: "The classroom roof leaks whenever it rains.",
    detectedLanguage: "en-IN",
    enabled: ENABLED,
    modelReportedUncertain: false,
  });

  assert.equal(assessment.usableForClassification, true);
  assert.equal(assessment.requiresReview, false);
});

test("V024: a transcript the model called uncertain is flagged, not quietly used", () => {
  const assessment = assessTranscription({
    transcriptText: "the ... roof ... rain",
    detectedLanguage: "en-IN",
    enabled: ENABLED,
    modelReportedUncertain: true,
  });

  assert.equal(assessment.usableForClassification, false);
  assert.equal(assessment.requiresReview, true);
  assert.match(assessment.reasons.join(" "), /uncertain/i);
});

test("V024: an empty or near-empty transcript reads as noisy audio, not as silence meaning nothing", () => {
  for (const text of ["", "   ", "..."]) {
    const assessment = assessTranscription({
      transcriptText: text,
      detectedLanguage: "en-IN",
      enabled: ENABLED,
      modelReportedUncertain: false,
    });

    assert.equal(
      assessment.usableForClassification,
      false,
      `${JSON.stringify(text)} must not be usable`,
    );
    assert.match(assessment.reasons.join(" "), /too little|noisy|no speech/i);
  }
});

test("V024: punctuation and filler are not counted as speech", () => {
  // A noisy recording often comes back as dots, dashes and spaces. Counting
  // those as content would let pure noise through as classifiable, and the
  // length alone is long enough here to clear the floor.
  for (const text of ["... ... ... ... ...", "-- -- -- -- -- -- --", "?!?!?!?!?!?!?!?!"]) {
    const assessment = assessTranscription({
      transcriptText: text,
      detectedLanguage: "en-IN",
      enabled: ENABLED,
      modelReportedUncertain: false,
    });

    assert.ok(text.length > TRANSCRIPT_UNCERTAINTY_FLOOR, "the raw length must clear the floor");
    assert.equal(
      assessment.usableForClassification,
      false,
      `${JSON.stringify(text)} contains no speech`,
    );
  }
});

test("V024: a very short transcript is below the usable floor", () => {
  const assessment = assessTranscription({
    transcriptText: "a".repeat(TRANSCRIPT_UNCERTAINTY_FLOOR - 1),
    detectedLanguage: "en-IN",
    enabled: ENABLED,
    modelReportedUncertain: false,
  });

  assert.equal(assessment.usableForClassification, false);
});

test("V024: the original wording is preserved exactly, never replaced", () => {
  const original = "शाळेच्या गेटबाहेरची गटार तुंबली आहे.";
  const assessment = assessTranscription({
    transcriptText: original,
    detectedLanguage: "mr-IN",
    enabled: ENABLED,
    modelReportedUncertain: false,
  });

  assert.equal(assessment.originalText, original, "the citizen's own words must survive unchanged");
  assert.equal(assessment.translatedText, undefined, "nothing here translates anything");
});

test("V024: a correction replaces the machine transcript without destroying it", () => {
  const assessment = assessTranscription({
    transcriptText: "the rooftop leeks",
    detectedLanguage: "en-IN",
    enabled: ENABLED,
    modelReportedUncertain: true,
    correction: { text: "the rooftop leaks", correctedBy: "reviewer-7" },
  });

  assert.equal(assessment.effectiveText, "the rooftop leaks");
  assert.equal(
    assessment.originalText,
    "the rooftop leeks",
    "the machine output stays on the record",
  );
  assert.equal(assessment.corrected, true);
  // A human correction resolves the uncertainty the model reported.
  assert.equal(assessment.usableForClassification, true);
  assert.equal(assessment.requiresReview, false);
});

test("V024: a correction cannot be blank, because that would erase the report", () => {
  const assessment = assessTranscription({
    transcriptText: "the rooftop leaks",
    detectedLanguage: "en-IN",
    enabled: ENABLED,
    modelReportedUncertain: false,
    correction: { text: "   ", correctedBy: "reviewer-7" },
  });

  assert.equal(assessment.corrected, false);
  assert.equal(assessment.effectiveText, "the rooftop leaks");
  assert.match(assessment.reasons.join(" "), /blank correction/i);
});
