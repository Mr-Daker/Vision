/**
 * Media pipeline tests (roadmap V021).
 *
 * The pipeline turns uploaded bytes into traceable evidence. Its obligations
 * are negative as much as positive: malformed media and unresolved redaction
 * cases must not reach a public view or the normal AI path, and a derivative
 * must carry no metadata from the original.
 *
 * Pure by design — no database, no object store, no clock — so these are unit
 * tests over real fixture bytes rather than an integration harness.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PHASH_HEX_LENGTH, decodePng, type RasterImage } from "@vision/media";

import { processPhotoBytes, MEDIA_PIPELINE_VERSION, type PhotoDetector } from "./media-pipeline.ts";

const TESTDATA = join(import.meta.dirname, "../../media/src/testdata");
const fixture = (name: string): Buffer => readFileSync(join(TESTDATA, name));

const JPEG = "image/jpeg";
const PNG = "image/png";

/** Stands in for a real, approved detector so the resolved branch is exercised. */
const evidenceGradeDetector = (
  regions: readonly { x: number; y: number; width: number; height: number }[],
): PhotoDetector => ({
  label: "approved-vendor-detector v3",
  detect: () =>
    regions.map((r) => ({
      ...r,
      kind: "face" as const,
      detectedBy: "approved-vendor-detector v3",
    })),
});

test("V021: bytes that do not match the declared type are quarantined", () => {
  const result = processPhotoBytes({
    declaredContentType: JPEG,
    bytes: fixture("png-rgb-8x8.png"),
  });

  assert.equal(result.ok, false);
  assert.equal(result.processingStatus, "quarantined");
  assert.match(result.reasonCode, /format_mismatch/);
});

test("V021: malformed media is refused and never yields a derivative", () => {
  const result = processPhotoBytes({
    declaredContentType: JPEG,
    bytes: fixture("jpeg-truncated.jpg"),
  });

  assert.equal(result.ok, false);
  // Quarantined specifically, not merely "not accepted": malformed bytes go to
  // a reviewable holding state, and the decoder's own reason travels with them
  // so the refusal can be explained rather than just asserted.
  assert.equal(result.processingStatus, "quarantined");
  assert.match(result.reasonCode, /^decode_failed:/);
  assert.ok(result.reasons[0] !== undefined && result.reasons[0].length > 0);
  assert.equal("derivative" in result, false, "a refused item must produce no derivative");
});

test("V021: an unsupported declared type is rejected", () => {
  const result = processPhotoBytes({
    declaredContentType: "image/tiff",
    bytes: fixture("png-rgb-8x8.png"),
  });

  assert.equal(result.ok, false);
  assert.match(result.reasonCode, /unsupported/);
});

test("V021: a valid photo with no detector is usable for review but not for the AI path", () => {
  const result = processPhotoBytes({
    declaredContentType: PNG,
    bytes: fixture("png-scene-32x32.png"),
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.redactionStatus, "needs_review");
  assert.equal(result.mayEnterPublicView, false);
  assert.equal(result.mayEnterAiPath, false);
  assert.equal(
    result.derivative,
    undefined,
    "no derivative may exist without a redaction decision",
  );
});

test("V021: the cryptographic fingerprint is the SHA-256 of the original bytes", () => {
  const bytes = fixture("png-scene-32x32.png");
  const expected = createHash("sha256").update(bytes).digest("hex");

  const result = processPhotoBytes({ declaredContentType: PNG, bytes });

  assert.equal(result.fingerprintHash, expected);
  assert.equal(result.fingerprintHash.length, 64);
});

test("V021: a perceptual hash is recorded alongside the cryptographic one", () => {
  const result = processPhotoBytes({
    declaredContentType: PNG,
    bytes: fixture("png-scene-32x32.png"),
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.perceptualHash.length, PHASH_HEX_LENGTH);
  assert.notEqual(result.perceptualHash, result.fingerprintHash);
});

test("V021: processing the same bytes twice gives identical fingerprints", () => {
  const bytes = fixture("png-scene-32x32.png");

  const a = processPhotoBytes({ declaredContentType: PNG, bytes });
  const b = processPhotoBytes({ declaredContentType: PNG, bytes });

  assert.equal(a.fingerprintHash, b.fingerprintHash);
  assert.equal(a.ok && b.ok && a.perceptualHash === b.perceptualHash, true);
});

test("V021: capture metadata is extracted when EXIF records it", () => {
  const result = processPhotoBytes({
    declaredContentType: JPEG,
    bytes: fixture("jpeg-exif-16x16.jpg"),
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.ok(
    result.captureMetadata.capturedAtLocal !== undefined ||
      result.captureMetadata.capturedAt !== undefined,
    "the EXIF fixture records a capture time",
  );
});

test("V021: absent capture metadata is a warning, never a fraud signal", () => {
  const result = processPhotoBytes({
    declaredContentType: PNG,
    bytes: fixture("png-scene-32x32.png"),
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.captureMetadata.gpsPresent, false);
  assert.equal(result.processingStatus, "needs_review");
  // Missing metadata must not push the item to rejected or quarantined.
  assert.notEqual(result.processingStatus, "quarantined");
  assert.notEqual(result.processingStatus, "rejected");
});

test("V021: a resolved redaction decision produces a derivative with the regions covered", () => {
  const result = processPhotoBytes({
    declaredContentType: PNG,
    bytes: fixture("png-scene-32x32.png"),
    detector: evidenceGradeDetector([{ x: 0, y: 0, width: 8, height: 8 }]),
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.redactionStatus, "approved");
  assert.notEqual(result.derivative, undefined);

  const derivative: RasterImage = decodePng(Buffer.from(result.derivative?.bytes ?? []));
  const flat = new Set<string>();
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      const offset = (y * derivative.width + x) * 3;
      flat.add(
        `${derivative.pixels[offset]},${derivative.pixels[offset + 1]},${derivative.pixels[offset + 2]}`,
      );
    }
  }
  assert.equal(flat.size, 1, "the detected region must be covered in the derivative");
});

test("V021: a derivative carries no metadata from the original", () => {
  const result = processPhotoBytes({
    declaredContentType: JPEG,
    bytes: fixture("jpeg-exif-16x16.jpg"),
    detector: evidenceGradeDetector([]),
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  const bytes = Buffer.from(result.derivative?.bytes ?? []);
  // A PNG derivative must contain only the critical chunks; no EXIF, no text.
  for (const chunk of ["eXIf", "tEXt", "iTXt", "zTXt", "tIME"]) {
    assert.equal(
      bytes.includes(Buffer.from(chunk, "latin1")),
      false,
      `${chunk} leaked into the derivative`,
    );
  }
});

test("V021: a thumbnail is bounded and keeps the aspect ratio", () => {
  const result = processPhotoBytes({
    declaredContentType: PNG,
    bytes: fixture("png-rgb-17x9.png"),
    detector: evidenceGradeDetector([]),
    thumbnailMaxEdge: 8,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  const thumb = result.thumbnail;
  assert.notEqual(thumb, undefined);
  assert.ok((thumb?.width ?? 99) <= 8 && (thumb?.height ?? 99) <= 8);
  // 17x9 scaled into 8 gives 8x4 (ratio preserved, never collapsed to zero).
  assert.equal(thumb?.width, 8);
  assert.equal(thumb?.height, 4);
});

test("V021: every result records the pipeline version that produced it", () => {
  const ok = processPhotoBytes({ declaredContentType: PNG, bytes: fixture("png-rgb-8x8.png") });
  const bad = processPhotoBytes({ declaredContentType: JPEG, bytes: fixture("png-rgb-8x8.png") });

  assert.equal(ok.pipelineVersion, MEDIA_PIPELINE_VERSION);
  assert.equal(bad.pipelineVersion, MEDIA_PIPELINE_VERSION, "a refusal is provenance too");
});
