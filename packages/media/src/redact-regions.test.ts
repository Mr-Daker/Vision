/**
 * Region redaction tests (roadmap V021).
 *
 * Covering a face or a number plate has to be irreversible. A blur can often
 * be undone well enough to re-identify someone, so a region is filled with a
 * single flat colour and the original pixels are gone from the derivative.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { applyRegionRedaction, REDACTION_FILL } from "./redact-regions.ts";
import { MediaDecodeError, type RasterImage } from "./raster.ts";

/** A 4x3 image whose every pixel is distinct, so a missed pixel is visible. */
const gradient = (): RasterImage => {
  const width = 4;
  const height = 3;
  const pixels = new Uint8Array(width * height * 3);
  for (let index = 0; index < width * height; index += 1) {
    pixels[index * 3] = index * 10 + 1;
    pixels[index * 3 + 1] = index * 10 + 2;
    pixels[index * 3 + 2] = index * 10 + 3;
  }
  return { width, height, pixels };
};

const pixelAt = (image: RasterImage, x: number, y: number): readonly number[] => {
  const offset = (y * image.width + x) * 3;
  // `?? -1` rather than a non-null assertion: an out-of-range read shows up as
  // an impossible channel value instead of being silently coerced to 0, which
  // a real pixel could legitimately be.
  return [
    image.pixels[offset] ?? -1,
    image.pixels[offset + 1] ?? -1,
    image.pixels[offset + 2] ?? -1,
  ];
};

test("V021: pixels inside a region are replaced with the flat fill", () => {
  const result = applyRegionRedaction(gradient(), [{ x: 1, y: 1, width: 2, height: 1 }]);

  assert.deepEqual(pixelAt(result, 1, 1), REDACTION_FILL);
  assert.deepEqual(pixelAt(result, 2, 1), REDACTION_FILL);
});

test("V021: pixels outside every region are untouched", () => {
  const original = gradient();

  const result = applyRegionRedaction(original, [{ x: 1, y: 1, width: 2, height: 1 }]);

  assert.deepEqual(pixelAt(result, 0, 0), pixelAt(original, 0, 0));
  assert.deepEqual(pixelAt(result, 3, 2), pixelAt(original, 3, 2));
});

test("V021: the source image is not modified in place", () => {
  const original = gradient();
  const before = Uint8Array.from(original.pixels);

  applyRegionRedaction(original, [{ x: 0, y: 0, width: 4, height: 3 }]);

  assert.deepEqual(original.pixels, before, "the private original must survive untouched");
});

test("V021: a region reaching past the edge is clipped rather than refused", () => {
  // A detector reporting a box that runs off the edge is ordinary; throwing
  // would quarantine a photograph for a harmless rounding difference.
  const result = applyRegionRedaction(gradient(), [{ x: 3, y: 2, width: 99, height: 99 }]);

  assert.deepEqual(pixelAt(result, 3, 2), REDACTION_FILL);
  assert.deepEqual(pixelAt(result, 0, 0), pixelAt(gradient(), 0, 0));
});

test("V021: a region starting outside the image is clipped to the visible part", () => {
  const original = gradient();

  const result = applyRegionRedaction(original, [{ x: -2, y: -2, width: 4, height: 4 }]);

  assert.deepEqual(pixelAt(result, 0, 0), REDACTION_FILL);
  assert.deepEqual(pixelAt(result, 1, 1), REDACTION_FILL);
  assert.deepEqual(pixelAt(result, 2, 2), pixelAt(original, 2, 2));
  // An unclamped negative x combined with a positive y wraps into the end of
  // the previous row and corrupts pixels the region never covered. These two
  // are exactly the pixels that wrap, so they pin the clamp.
  assert.deepEqual(pixelAt(result, 2, 0), pixelAt(original, 2, 0), "row wrap corrupted (2,0)");
  assert.deepEqual(pixelAt(result, 3, 0), pixelAt(original, 3, 0), "row wrap corrupted (3,0)");
});

test("V021: a region entirely outside the image changes nothing", () => {
  const original = gradient();

  const result = applyRegionRedaction(original, [{ x: 50, y: 50, width: 10, height: 10 }]);

  assert.deepEqual(result.pixels, original.pixels);
});

test("V021: a zero-area region changes nothing", () => {
  const original = gradient();

  const result = applyRegionRedaction(original, [{ x: 1, y: 1, width: 0, height: 5 }]);

  assert.deepEqual(result.pixels, original.pixels);
});

test("V021: every region in the list is applied, not just the first", () => {
  const result = applyRegionRedaction(gradient(), [
    { x: 0, y: 0, width: 1, height: 1 },
    { x: 3, y: 2, width: 1, height: 1 },
  ]);

  assert.deepEqual(pixelAt(result, 0, 0), REDACTION_FILL);
  assert.deepEqual(pixelAt(result, 3, 2), REDACTION_FILL);
});

test("V021: an inconsistent raster is refused rather than partly redacted", () => {
  const broken: RasterImage = { width: 4, height: 3, pixels: new Uint8Array(10) };

  assert.throws(() => applyRegionRedaction(broken, [{ x: 0, y: 0, width: 1, height: 1 }]), {
    name: "MediaDecodeError",
  });
});

test("V021: the fill is a single flat colour so the original cannot be recovered", () => {
  const result = applyRegionRedaction(gradient(), [{ x: 0, y: 0, width: 4, height: 3 }]);

  const distinct = new Set<string>();
  for (let y = 0; y < result.height; y += 1) {
    for (let x = 0; x < result.width; x += 1) distinct.add(pixelAt(result, x, y).join(","));
  }
  assert.equal(distinct.size, 1, "a fully covered image must retain no detail at all");
  assert.equal(MediaDecodeError.name, "MediaDecodeError");
});
