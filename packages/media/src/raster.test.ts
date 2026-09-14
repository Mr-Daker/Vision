/**
 * Raster helper tests (roadmap V021).
 *
 * These exist because a mutation run found `resampleBox` and `fitWithin`
 * completely unexercised: removing the upscale guard broke nothing. Both feed
 * derivative generation, where inventing detail that was never captured is a
 * correctness problem and not merely a cosmetic one.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  assertRasterConsistent,
  fitWithin,
  MediaDecodeError,
  resampleBox,
  toLuma,
  type RasterImage,
} from "./raster.ts";

/** Builds a raster from per-pixel RGB triples, row-major. */
const raster = (width: number, height: number, triples: readonly number[][]): RasterImage => ({
  width,
  height,
  pixels: Uint8Array.from(triples.flat()),
});

const expectRefusal = (run: () => unknown, reasonCode: string): void => {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof MediaDecodeError, `expected MediaDecodeError, got ${error}`);
    assert.equal(error.reasonCode, reasonCode);
    return true;
  });
};

test("V021: downsampling averages every contributing pixel", () => {
  // Four pixels collapsing to one: the result must be the mean, not a sample of
  // one corner. Point-sampling here would alias thumbnails and would make the
  // perceptual hash change whenever an image is re-encoded.
  const image = raster(2, 2, [
    [0, 0, 0],
    [10, 20, 30],
    [20, 40, 60],
    [30, 60, 90],
  ]);
  const reduced = resampleBox(image, 1, 1);
  assert.deepEqual([...reduced.pixels], [15, 30, 45]);
});

test("V021: a non-integer ratio partitions source rows without double-counting", () => {
  // 3 rows into 2. This is an integer partition, not exact area weighting: row
  // 0 belongs to target 0, and rows 1-2 average into target 1. The guarantee
  // being pinned is that every source row contributes to exactly one target
  // row — a half-open range bug shows up here as a skipped or double-counted
  // row. True fractional weighting would give [50, 150] instead, and is more
  // precision than a thumbnail or a hash grid needs.
  const image = raster(1, 3, [
    [0, 0, 0],
    [100, 100, 100],
    [200, 200, 200],
  ]);
  const reduced = resampleBox(image, 1, 2);
  assert.deepEqual([...reduced.pixels], [0, 0, 0, 150, 150, 150]);
});

test("V021: upscaling a derivative is refused rather than invented", () => {
  const image = raster(1, 1, [[5, 5, 5]]);
  expectRefusal(() => resampleBox(image, 2, 2), "upscale_refused");
  expectRefusal(() => resampleBox(image, 1, 2), "upscale_refused");
});

test("V021: resampling to the same size returns the image unchanged", () => {
  const image = raster(1, 1, [[7, 8, 9]]);
  assert.equal(resampleBox(image, 1, 1), image);
});

test("V021: a nonsensical target size is refused", () => {
  const image = raster(2, 2, [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ]);
  expectRefusal(() => resampleBox(image, 0, 1), "bad_resample_target");
  expectRefusal(() => resampleBox(image, 1, -1), "bad_resample_target");
  expectRefusal(() => resampleBox(image, 1.5, 1), "bad_resample_target");
});

test("V021: a raster whose buffer disagrees with its dimensions is refused", () => {
  expectRefusal(
    () => assertRasterConsistent({ width: 2, height: 2, pixels: new Uint8Array(11) }),
    "raster_length_mismatch",
  );
  expectRefusal(
    () => assertRasterConsistent({ width: 0, height: 4, pixels: new Uint8Array(0) }),
    "empty_raster",
  );
});

test("V021: luma uses the BT.601 coefficients", () => {
  const image = raster(3, 1, [
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
  ]);
  const luma = toLuma(image);
  assert.ok(Math.abs((luma[0] ?? 0) - 76.245) < 0.001, `red luma ${luma[0]}`);
  assert.ok(Math.abs((luma[1] ?? 0) - 149.685) < 0.001, `green luma ${luma[1]}`);
  assert.ok(Math.abs((luma[2] ?? 0) - 29.07) < 0.001, `blue luma ${luma[2]}`);
});

test("V021: fitWithin preserves aspect ratio and never collapses a dimension", () => {
  assert.deepEqual(fitWithin(1600, 900, 320), { width: 320, height: 180 });
  assert.deepEqual(fitWithin(900, 1600, 320), { width: 180, height: 320 });
  // Already inside the bound: left alone rather than upscaled.
  assert.deepEqual(fitWithin(100, 50, 320), { width: 100, height: 50 });
  // Extreme aspect ratios must still produce a usable raster.
  assert.deepEqual(fitWithin(4000, 3, 320), { width: 320, height: 1 });
});
