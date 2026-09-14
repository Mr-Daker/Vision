/**
 * PNG codec tests (roadmap V021).
 *
 * PNG is lossless, so these assert EXACT equality with Pillow's decode of the
 * same file. Any difference is a bug, not rounding — which is why the tolerance
 * used for JPEG has no place here.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { decodePng, encodeRgbPng, readPngHeader } from "./png.ts";
import { MediaDecodeError } from "./raster.ts";

const TESTDATA = join(import.meta.dirname, "testdata");

const bytes = (name: string): Uint8Array => new Uint8Array(readFileSync(join(TESTDATA, name)));

type Truth = {
  readonly width: number;
  readonly height: number;
  readonly channels: number;
  readonly pixels: readonly number[];
};

const truth = (name: string): Truth =>
  JSON.parse(readFileSync(join(TESTDATA, `${name}.json`), "utf8")) as Truth;

const assertMatchesTruth = (name: string): void => {
  const expected = truth(name);
  const actual = decodePng(bytes(`${name}.png`));
  assert.equal(actual.width, expected.width, "width");
  assert.equal(actual.height, expected.height, "height");
  assert.equal(actual.pixels.length, expected.pixels.length, "pixel count");
  for (let index = 0; index < expected.pixels.length; index += 1) {
    assert.equal(
      actual.pixels[index],
      expected.pixels[index],
      `sample ${index} of ${name} (pixel ${Math.floor(index / 3)}, channel ${index % 3})`,
    );
  }
};

test("V021: truecolour PNG decodes exactly as an independent decoder does", () => {
  assertMatchesTruth("png-rgb-8x8");
});

test("V021: odd dimensions decode exactly", () => {
  assertMatchesTruth("png-rgb-17x9");
});

test("V021: greyscale PNG expands to RGB exactly", () => {
  assertMatchesTruth("png-gray-8x8");
});

test("V021: palette PNG resolves indices exactly", () => {
  assertMatchesTruth("png-palette-8x8");
});

test("V021: Paeth-filtered scanlines decode exactly", () => {
  // Pillow does not choose the Paeth filter for small smooth images, so the
  // trickiest predictor was unexercised until this fixture forced it: a
  // mutation flipping Paeth's `<=` tie-breaking to `<` survived the whole
  // suite. The fixture applies filter type 4 to every scanline.
  assertMatchesTruth("png-paeth-32x32");
});

test("V021: 16-bit samples are reduced by taking the high byte", () => {
  // Truth for this one is computed in the generator rather than read from
  // Pillow, whose I;16 conversion clips to 0-255 instead of scaling.
  assertMatchesTruth("png-gray16-8x8");
});

test("V021: an alpha channel is dropped rather than composited", () => {
  // Pillow's RGBA->RGB conversion discards alpha too, so exact equality here
  // also pins down that we do not silently flatten onto a background colour.
  assertMatchesTruth("png-rgba-8x8");
});

test("V021: the header probe agrees with the full decode", () => {
  const header = readPngHeader(bytes("png-rgb-17x9.png"));
  const image = decodePng(bytes("png-rgb-17x9.png"));
  assert.equal(header.width, image.width);
  assert.equal(header.height, image.height);
  assert.equal(header.colorType, 2);
  assert.equal(header.bitDepth, 8);
  assert.equal(header.interlaced, false);
});

test("V021: interlaced PNG is refused rather than partially reconstructed", () => {
  assert.throws(
    () => decodePng(bytes("png-interlaced-8x8.png")),
    (error: unknown) => {
      assert.ok(error instanceof MediaDecodeError);
      assert.equal(error.reasonCode, "png_interlaced");
      return true;
    },
  );
});

test("V021: truncated PNG is refused", () => {
  assert.throws(
    () => decodePng(bytes("png-truncated.png")),
    (error: unknown) => {
      assert.ok(error instanceof MediaDecodeError);
      assert.equal(error.reasonCode, "png_truncated");
      return true;
    },
  );
});

test("V021: a corrupted chunk CRC is refused, not decoded anyway", () => {
  assert.throws(
    () => decodePng(bytes("png-bad-crc.png")),
    (error: unknown) => {
      assert.ok(error instanceof MediaDecodeError);
      assert.equal(error.reasonCode, "png_bad_crc");
      return true;
    },
  );
});

test("V021: bytes that are not a PNG are refused", () => {
  assert.throws(
    () => decodePng(bytes("jpeg-420-16x16.jpg")),
    (error: unknown) => {
      assert.ok(error instanceof MediaDecodeError);
      assert.equal(error.reasonCode, "not_png");
      return true;
    },
  );
});

test("V021: encoding round-trips losslessly", () => {
  const original = decodePng(bytes("png-rgb-17x9.png"));
  const reencoded = decodePng(encodeRgbPng(original));
  assert.equal(reencoded.width, original.width);
  assert.equal(reencoded.height, original.height);
  assert.deepEqual([...reencoded.pixels], [...original.pixels]);
});

test("V021: an encoded derivative carries no metadata chunks at all", () => {
  // This is the property that lets V021 claim a derivative is metadata-free
  // by construction rather than by a removal pass we would have to prove.
  const encoded = encodeRgbPng(decodePng(bytes("png-rgb-8x8.png")));
  const types: string[] = [];
  let offset = 8;
  while (offset + 8 <= encoded.length) {
    const length =
      (encoded[offset] ?? 0) * 0x1000000 +
      (encoded[offset + 1] ?? 0) * 0x10000 +
      (encoded[offset + 2] ?? 0) * 0x100 +
      (encoded[offset + 3] ?? 0);
    types.push(String.fromCharCode(...encoded.subarray(offset + 4, offset + 8)));
    offset += 12 + length;
  }
  assert.deepEqual(types, ["IHDR", "IDAT", "IEND"]);
});

test("V021: a raster whose buffer disagrees with its header cannot be encoded", () => {
  assert.throws(
    () => encodeRgbPng({ width: 4, height: 4, pixels: new Uint8Array(10) }),
    (error: unknown) => {
      assert.ok(error instanceof MediaDecodeError);
      assert.equal(error.reasonCode, "raster_length_mismatch");
      return true;
    },
  );
});
