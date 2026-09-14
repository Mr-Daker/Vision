/**
 * Perceptual image fingerprinting (roadmap V021).
 *
 * A cryptographic hash answers "are these the same bytes?". This answers "do
 * these look like the same picture?", which is the question duplicate reporting
 * actually raises: two citizens photographing one broken staircase produce
 * different bytes, and one re-encoded upload produces different bytes again.
 *
 * The construction is the standard DCT perceptual hash: reduce to 32x32 luma,
 * take the low-frequency 8x8 corner of a 2-D DCT-II, drop the DC term, and set
 * each bit by whether its coefficient exceeds the median. Dropping DC discards
 * overall brightness, and the median threshold makes the hash indifferent to
 * contrast — both are why the hash survives re-encoding.
 *
 * What this must never be read as: byte identity is a fact, visual similarity
 * is a signal for review. Neither shows a report is false
 * ([V002](../../../docs/foundation/V002-capability-evidence-matrix.md) row 6 —
 * "reuse proves fraud" is a prohibited claim).
 */

import { MediaDecodeError, type RasterImage } from "./raster.ts";

/** Side of the luma grid the DCT runs over. */
const GRID = 32;
/** Side of the retained low-frequency corner. */
const LOW_FREQUENCY = 8;

export const PHASH_HEX_LENGTH = 16;

/**
 * Hamming distance at or below which two images are reported as looking alike.
 *
 * Chosen conservatively: 10 of 64 bits. This is a review threshold, not a
 * calibrated accuracy claim, and V046's held-out evaluation is where any
 * numbers about its behaviour may come from.
 */
export const PERCEPTUAL_NEAR_DUPLICATE_MAX_DISTANCE = 10;

/**
 * Resamples luma to the fixed 32x32 grid, in either direction.
 *
 * This deliberately permits upscaling, unlike `resampleBox`, which refuses it.
 * The distinction is about what the output is for: a *derivative* is shown to
 * people, so inventing detail would be dishonest, whereas this grid is an
 * internal signal that must exist at one fixed size for hashes to be
 * comparable at all. A small image is stretched rather than declared unhashable.
 */
const lumaGrid = (image: RasterImage): Float64Array => {
  const grid = new Float64Array(GRID * GRID);
  for (let gridY = 0; gridY < GRID; gridY += 1) {
    const startY = Math.floor((gridY * image.height) / GRID);
    const endY = Math.max(startY + 1, Math.floor(((gridY + 1) * image.height) / GRID));
    for (let gridX = 0; gridX < GRID; gridX += 1) {
      const startX = Math.floor((gridX * image.width) / GRID);
      const endX = Math.max(startX + 1, Math.floor(((gridX + 1) * image.width) / GRID));

      let total = 0;
      let counted = 0;
      for (let sourceY = startY; sourceY < endY; sourceY += 1) {
        for (let sourceX = startX; sourceX < endX; sourceX += 1) {
          const offset = (sourceY * image.width + sourceX) * 3;
          total +=
            0.299 * (image.pixels[offset] ?? 0) +
            0.587 * (image.pixels[offset + 1] ?? 0) +
            0.114 * (image.pixels[offset + 2] ?? 0);
          counted += 1;
        }
      }
      grid[gridY * GRID + gridX] = total / counted;
    }
  }
  return grid;
};

/**
 * Cosine basis table.
 *
 * Precomputed because the naive transform evaluates `cos` GRID^4 times
 * otherwise — a million calls per image, which is measurable even here.
 */
const COSINES = ((): Float64Array => {
  const table = new Float64Array(GRID * GRID);
  for (let frequency = 0; frequency < GRID; frequency += 1) {
    for (let position = 0; position < GRID; position += 1) {
      table[frequency * GRID + position] = Math.cos(
        (Math.PI * (2 * position + 1) * frequency) / (2 * GRID),
      );
    }
  }
  return table;
})();

/**
 * Low-frequency corner of the 2-D DCT-II.
 *
 * Separable: rows first, then columns, so the cost is GRID^3 rather than
 * GRID^4. Orthonormal scaling is omitted on purpose — every coefficient is only
 * ever compared against the median of the same set, so a constant factor is
 * invisible to the result.
 */
const lowFrequencyDct = (grid: Float64Array): Float64Array => {
  const rows = new Float64Array(GRID * LOW_FREQUENCY);
  for (let y = 0; y < GRID; y += 1) {
    for (let u = 0; u < LOW_FREQUENCY; u += 1) {
      let sum = 0;
      for (let x = 0; x < GRID; x += 1) {
        sum += (grid[y * GRID + x] ?? 0) * (COSINES[u * GRID + x] ?? 0);
      }
      rows[y * LOW_FREQUENCY + u] = sum;
    }
  }

  const out = new Float64Array(LOW_FREQUENCY * LOW_FREQUENCY);
  for (let u = 0; u < LOW_FREQUENCY; u += 1) {
    for (let v = 0; v < LOW_FREQUENCY; v += 1) {
      let sum = 0;
      for (let y = 0; y < GRID; y += 1) {
        sum += (rows[y * LOW_FREQUENCY + u] ?? 0) * (COSINES[v * GRID + y] ?? 0);
      }
      out[v * LOW_FREQUENCY + u] = sum;
    }
  }
  return out;
};

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
};

/** 64-bit perceptual hash as 16 lowercase hex characters. */
export const perceptualHash = (image: RasterImage): string => {
  const coefficients = lowFrequencyDct(lumaGrid(image));

  // Index 0 is the DC term: overall brightness, which we deliberately ignore.
  const alternating: number[] = [];
  for (let index = 1; index < coefficients.length; index += 1) {
    alternating.push(coefficients[index] ?? 0);
  }
  const threshold = median(alternating);

  let hex = "";
  for (let nibble = 0; nibble < PHASH_HEX_LENGTH; nibble += 1) {
    let value = 0;
    for (let bit = 0; bit < 4; bit += 1) {
      const index = nibble * 4 + bit;
      // The DC slot becomes the hash's first bit position; it carries no
      // brightness information, only a fixed 0, keeping the output 64 bits.
      const coefficient = index === 0 ? threshold : (coefficients[index] ?? 0);
      value = (value << 1) | (coefficient > threshold ? 1 : 0);
    }
    hex += value.toString(16);
  }
  return hex;
};

const BITS_SET = ((): Uint8Array => {
  const table = new Uint8Array(16);
  for (let value = 0; value < 16; value += 1) {
    table[value] = (value & 1) + ((value >> 1) & 1) + ((value >> 2) & 1) + ((value >> 3) & 1);
  }
  return table;
})();

/**
 * Bits that differ between two perceptual hashes: 0 means "looks identical",
 * 64 means "looks inverted".
 */
export const hammingDistanceHex = (left: string, right: string): number => {
  if (left.length !== PHASH_HEX_LENGTH || right.length !== PHASH_HEX_LENGTH) {
    throw new MediaDecodeError(
      "phash_length_mismatch",
      `perceptual hashes must be ${PHASH_HEX_LENGTH} hex characters`,
    );
  }
  let distance = 0;
  for (let index = 0; index < PHASH_HEX_LENGTH; index += 1) {
    const leftNibble = Number.parseInt(left[index] ?? "", 16);
    const rightNibble = Number.parseInt(right[index] ?? "", 16);
    if (Number.isNaN(leftNibble) || Number.isNaN(rightNibble)) {
      throw new MediaDecodeError("phash_not_hex", "perceptual hashes must be hexadecimal");
    }
    distance += BITS_SET[leftNibble ^ rightNibble] ?? 0;
  }
  return distance;
};

export const looksLikeNearDuplicate = (left: string, right: string): boolean =>
  hammingDistanceHex(left, right) <= PERCEPTUAL_NEAR_DUPLICATE_MAX_DISTANCE;
