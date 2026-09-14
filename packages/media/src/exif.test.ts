/**
 * Capture-metadata tests (roadmap V021).
 *
 * The assertions that matter most are the honesty ones: a missing UTC offset is
 * reported rather than invented, and unreadable metadata degrades to a warning
 * instead of failing an otherwise valid photograph (V002 prohibition 2).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { orientationSwapsAxes, orientedDimensions, readJpegExif } from "./exif.ts";

const TESTDATA = join(import.meta.dirname, "testdata");
const bytes = (name: string): Uint8Array => new Uint8Array(readFileSync(join(TESTDATA, name)));

test("V021: capture metadata is extracted from EXIF", () => {
  const metadata = readJpegExif(bytes("jpeg-exif-16x16.jpg"));
  assert.equal(metadata.capturedAtLocal, "2026-09-09T14:30:05");
  assert.equal(metadata.orientation, 6);
  assert.equal(metadata.make, "VisionTest");
  assert.equal(metadata.model, "FixtureCam");
});

test("V021: an EXIF timestamp without a zone is never given a fabricated offset", () => {
  const metadata = readJpegExif(bytes("jpeg-exif-16x16.jpg"));
  // The fixture records DateTimeOriginal but no OffsetTimeOriginal, which is
  // the overwhelmingly common real-world case.
  assert.equal(metadata.captureOffsetKnown, false);
  assert.equal(metadata.capturedAt, undefined);
  assert.ok(
    metadata.warnings.some((warning) => warning.includes("no UTC offset")),
    `expected a missing-offset warning, got ${JSON.stringify(metadata.warnings)}`,
  );
});

test("V021: GPS coordinates are resolved with their hemisphere references", () => {
  const metadata = readJpegExif(bytes("jpeg-exif-16x16.jpg"));
  assert.equal(metadata.gpsPresent, true);
  assert.ok(
    Math.abs((metadata.gpsLatitude ?? 0) - 16.85) < 1e-6,
    `latitude ${metadata.gpsLatitude}`,
  );
  assert.ok(
    Math.abs((metadata.gpsLongitude ?? 0) - 74.5666667) < 1e-5,
    `longitude ${metadata.gpsLongitude}`,
  );
});

test("V021: a photograph with no EXIF is reported as such, not as a finding", () => {
  const metadata = readJpegExif(bytes("jpeg-420-16x16.jpg"));
  assert.equal(metadata.capturedAtLocal, undefined);
  assert.equal(metadata.gpsPresent, false);
  assert.deepEqual(metadata.warnings, ["no EXIF metadata present"]);
});

test("V021: non-JPEG bytes yield empty metadata rather than an error", () => {
  const metadata = readJpegExif(bytes("png-rgb-8x8.png"));
  assert.equal(metadata.gpsPresent, false);
  assert.deepEqual(metadata.warnings, ["no EXIF metadata present"]);
});

test("V021: corrupt EXIF degrades to a warning and never throws", () => {
  // A well-formed APP1 "Exif" segment whose TIFF header is nonsense. The
  // segment length (0x000A) covers its own two bytes, "Exif\0\0", and the two
  // garbage bytes, so the segment is structurally valid and the failure lands
  // where it should: on the byte-order marker.
  const header = [0xff, 0xd8, 0xff, 0xe1, 0x00, 0x0a, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00];
  const nonsense = [0x00, 0x01];
  const metadata = readJpegExif(Uint8Array.from([...header, ...nonsense]));
  assert.equal(metadata.capturedAtLocal, undefined);
  assert.equal(metadata.warnings.length, 1);
  assert.match(metadata.warnings[0] ?? "", /byte order/);
});

test("V021: an out-of-range orientation is ignored with a warning", () => {
  // II byte order, TIFF magic, IFD0 at offset 8, one entry: orientation = 99.
  const exif = Uint8Array.from([
    0xff, 0xd8, 0xff, 0xe1, 0x00, 0x20, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x49, 0x49, 0x2a, 0x00,
    0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x63, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  ]);
  const metadata = readJpegExif(exif);
  assert.equal(metadata.orientation, undefined);
  assert.ok(metadata.warnings.some((warning) => warning.includes("orientation")));
});

test("V021: orientation is recorded rather than applied to the stored bytes", () => {
  // Rotating an original would change the bytes its fingerprint covers, so the
  // pipeline only reports the display size implied by the flag.
  assert.equal(orientationSwapsAxes(6), true);
  assert.equal(orientationSwapsAxes(1), false);
  assert.equal(orientationSwapsAxes(undefined), false);

  const image = { width: 16, height: 9, pixels: new Uint8Array(16 * 9 * 3) };
  assert.deepEqual(orientedDimensions(image, 6), { width: 9, height: 16 });
  assert.deepEqual(orientedDimensions(image, 1), { width: 16, height: 9 });
});
