/**
 * Audio container tests (roadmap V021).
 *
 * The load-bearing case is `audio-webm-no-duration`: a browser recording
 * routinely states no duration, and the prober must report that honestly
 * instead of estimating one from the byte length, because a guessed duration
 * would become a cost projection and a review flag downstream.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { MAX_AUDIO_SECONDS, probeAudio } from "./audio.ts";
import { MediaDecodeError } from "./raster.ts";

const TESTDATA = join(import.meta.dirname, "testdata");
const bytes = (name: string): Uint8Array => new Uint8Array(readFileSync(join(TESTDATA, name)));

const expectRefusal = (run: () => unknown, reasonCode: string): void => {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof MediaDecodeError, `expected MediaDecodeError, got ${error}`);
    assert.equal(error.reasonCode, reasonCode);
    return true;
  });
};

test("V021: an Ogg Opus recording reports its codec, channels and duration", () => {
  const probe = probeAudio(bytes("audio-opus-2s.ogg"), "audio/ogg");
  assert.equal(probe.container, "ogg");
  assert.equal(probe.codec, "opus");
  assert.equal(probe.channels, 1);
  // Opus granule positions are always 48 kHz: 96000 granules is two seconds.
  assert.equal(probe.durationSeconds, 2);
  assert.deepEqual(probe.warnings, []);
});

test("V021: a corrupted Ogg page is caught by its checksum", () => {
  expectRefusal(() => probeAudio(bytes("audio-opus-bad-crc.ogg"), "audio/ogg"), "ogg_bad_crc");
});

test("V021: a truncated Ogg stream is refused", () => {
  expectRefusal(() => probeAudio(bytes("audio-opus-truncated.ogg"), "audio/ogg"), "ogg_truncated");
});

test("V021: a WebM stating a duration reports it in seconds", () => {
  const probe = probeAudio(bytes("audio-webm-3s.webm"), "audio/webm");
  assert.equal(probe.container, "webm");
  assert.equal(probe.durationSeconds, 3);
});

test("V021: a browser recording without a Duration element is valid with unknown length", () => {
  const probe = probeAudio(bytes("audio-webm-no-duration.webm"), "audio/webm");
  assert.equal(probe.container, "webm");
  assert.equal(probe.durationSeconds, undefined);
  assert.ok(
    probe.warnings.some((warning) => warning.includes("no duration")),
    `expected an unknown-duration warning, got ${JSON.stringify(probe.warnings)}`,
  );
});

test("V021: a recording longer than the accepted ceiling is refused", () => {
  expectRefusal(
    () => probeAudio(bytes("audio-webm-too-long.webm"), "audio/webm"),
    "audio_too_long",
  );
  assert.equal(MAX_AUDIO_SECONDS, 300);
});

test("V021: an EBML file of the wrong DocType is refused", () => {
  expectRefusal(
    () => probeAudio(bytes("audio-webm-wrong-doctype.webm"), "audio/webm"),
    "webm_doctype",
  );
});

test("V021: bytes that are not the declared container are refused", () => {
  // A photograph renamed to .ogg must not probe as audio.
  expectRefusal(() => probeAudio(bytes("png-rgb-8x8.png"), "audio/ogg"), "ogg_no_capture_pattern");
  expectRefusal(() => probeAudio(bytes("png-rgb-8x8.png"), "audio/webm"), "webm_no_ebml");
});

test("V021: an unaccepted content type is refused before any parsing", () => {
  expectRefusal(
    () => probeAudio(bytes("audio-opus-2s.ogg"), "audio/mpeg"),
    "audio_unsupported_type",
  );
});
