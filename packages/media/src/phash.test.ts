/**
 * Perceptual-hash tests (roadmap V021).
 *
 * A perceptual hash is only useful if it moves in both directions, so these
 * assert BOTH that the same scene at a different resolution stays close and
 * that a different scene lands far away. A constant function would satisfy the
 * first assertion alone.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { decodePng } from "./png.ts";
import {
  hammingDistanceHex,
  looksLikeNearDuplicate,
  perceptualHash,
  PERCEPTUAL_NEAR_DUPLICATE_MAX_DISTANCE,
  PHASH_HEX_LENGTH,
} from "./phash.ts";
import { MediaDecodeError } from "./raster.ts";

const TESTDATA = join(import.meta.dirname, "testdata");
const image = (name: string) =>
  decodePng(new Uint8Array(readFileSync(join(TESTDATA, `${name}.png`))));

test("V021: a perceptual hash is 16 lowercase hex characters", () => {
  const hash = perceptualHash(image("png-scene-32x32"));
  assert.equal(hash.length, PHASH_HEX_LENGTH);
  assert.match(hash, /^[0-9a-f]{16}$/);
});

test("V021: the same bytes always hash identically", () => {
  const first = perceptualHash(image("png-scene-32x32"));
  const second = perceptualHash(image("png-scene-32x32"));
  assert.equal(first, second);
  assert.equal(hammingDistanceHex(first, second), 0);
});

test("V021: the same scene at a different resolution stays close", () => {
  const large = perceptualHash(image("png-scene-64x64"));
  const small = perceptualHash(image("png-scene-32x32"));
  const distance = hammingDistanceHex(large, small);
  assert.ok(
    distance <= PERCEPTUAL_NEAR_DUPLICATE_MAX_DISTANCE,
    `64x64 and 32x32 of one scene differ by ${distance} bits, above the ${PERCEPTUAL_NEAR_DUPLICATE_MAX_DISTANCE}-bit threshold`,
  );
  assert.equal(looksLikeNearDuplicate(large, small), true);
});

test("V021: a visually different scene lands far away", () => {
  const scene = perceptualHash(image("png-scene-32x32"));
  const inverted = perceptualHash(image("png-scene-inverted-32x32"));
  const distance = hammingDistanceHex(scene, inverted);
  assert.ok(
    distance > PERCEPTUAL_NEAR_DUPLICATE_MAX_DISTANCE,
    `an inverted scene differed by only ${distance} bits`,
  );
  assert.equal(looksLikeNearDuplicate(scene, inverted), false);
});

test("V021: overall brightness does not change the hash", () => {
  // The DC term is dropped precisely so a brighter copy of one scene is still
  // recognised as that scene. The fixtures derive from a darkened base so the
  // shift cannot clip — clipping would alter the AC coefficients too and make
  // this a test of something else.
  const base = perceptualHash(image("png-tone-base-32x32"));
  const brighter = perceptualHash(image("png-tone-brighter-32x32"));
  assert.equal(
    hammingDistanceHex(base, brighter),
    0,
    "a uniform brightness shift must leave the hash untouched",
  );
});

test("V021: reduced contrast does not change the hash", () => {
  // Median thresholding is what buys this: halving contrast halves every
  // coefficient and the median together, so every comparison is unchanged.
  //
  // Built in memory rather than from a PNG fixture on purpose. Going through an
  // image file forces 8-bit quantisation, and halving a range leaves so few
  // distinct levels that rounding alone moved the hash by 4 bits — an artefact
  // of the fixture, not of the hash. These values are all chosen so that
  // `100 + (v - 100) / 2` is an exact integer, so the transform is lossless and
  // the assertion can be exact.
  // The pattern is a diagonal ramp, which carries real low-frequency content.
  // That matters more than it looks: a high-frequency pattern leaves almost
  // every retained coefficient sitting at ~0, clustered right at the median, so
  // each bit becomes a floating-point coin-flip and the hash is unstable under
  // any transform at all. Every value is even, so halving is exact.
  const pixels = new Uint8Array(32 * 32 * 3);
  const scaled = new Uint8Array(32 * 32 * 3);
  for (let y = 0; y < 32; y += 1) {
    for (let x = 0; x < 32; x += 1) {
      const value = 60 + 2 * ((3 * x + 5 * y) % 64);
      const contrasted = 100 + (value - 100) / 2;
      const index = y * 32 + x;
      for (let channel = 0; channel < 3; channel += 1) {
        pixels[index * 3 + channel] = value;
        scaled[index * 3 + channel] = contrasted;
      }
    }
  }

  const base = perceptualHash({ width: 32, height: 32, pixels });
  const flatter = perceptualHash({ width: 32, height: 32, pixels: scaled });
  assert.equal(
    hammingDistanceHex(base, flatter),
    0,
    "an exact contrast scaling must leave the hash untouched",
  );
});

test("V021: a small image is still hashable rather than declared unhashable", () => {
  // The hash grid is fixed at 32x32 so hashes are comparable; an 8x8 upload is
  // stretched onto it rather than refused.
  const hash = perceptualHash(image("png-rgb-8x8"));
  assert.match(hash, /^[0-9a-f]{16}$/);
});

test("V021: comparing malformed hashes is refused, not silently zero", () => {
  assert.throws(
    () => hammingDistanceHex("abc", "def"),
    (error: unknown) => {
      assert.ok(error instanceof MediaDecodeError);
      assert.equal(error.reasonCode, "phash_length_mismatch");
      return true;
    },
  );
  assert.throws(
    () => hammingDistanceHex("zzzzzzzzzzzzzzzz", "0000000000000000"),
    (error: unknown) => {
      assert.ok(error instanceof MediaDecodeError);
      assert.equal(error.reasonCode, "phash_not_hex");
      return true;
    },
  );
});
