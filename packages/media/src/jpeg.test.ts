import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { MediaDecodeError, type RasterImage } from "./raster.ts";
import { decodeJpeg, readJpegHeader } from "./jpeg.ts";

const TESTDATA = join(import.meta.dirname, "testdata");

const bytesOf = (name: string): Uint8Array => new Uint8Array(readFileSync(join(TESTDATA, name)));

/**
 * Offset of a marker's code byte, so refusal tests can corrupt one in place.
 * Searching for the 0xFF prefix rather than the bare code matters: marker codes
 * occur constantly inside quantization tables and coded data.
 */
const markerAt = (bytes: Uint8Array, code: number): number => {
  for (let index = 2; index < bytes.length - 1; index += 1) {
    if (bytes[index] === 0xff && bytes[index + 1] === code) return index + 1;
  }
  assert.fail(`fixture has no 0xFF${code.toString(16)} marker`);
};

/**
 * Ground truth is Pillow's own decode of the same encoded file. An independent
 * encoder and an independent decoder together mean these tests cannot pass by
 * agreeing with a bug in this file.
 */
type Truth = {
  readonly width: number;
  readonly height: number;
  readonly channels: number;
  readonly pixels: readonly number[];
};

const truthOf = (name: string): Truth =>
  JSON.parse(readFileSync(join(TESTDATA, `${name}.json`), "utf8")) as Truth;

/**
 * JPEG is lossy and the IDCT rounds differently in every implementation, so
 * agreement is measured, not asserted exactly. The thresholds are tight enough
 * that a real bug — a mis-ordered zig-zag, a dropped DC predictor, chroma
 * upsampled off by a pixel — blows straight through them.
 */
const MAX_MEAN_ABSOLUTE_ERROR = 2.0;
const MAX_CHANNEL_DIFFERENCE = 12;

const agreesWithPillow = (name: string): { readonly mae: number; readonly worst: number } => {
  const truth = truthOf(name);
  const image = decodeJpeg(bytesOf(`${name}.jpg`));

  assert.equal(image.width, truth.width, "decoded width");
  assert.equal(image.height, truth.height, "decoded height");
  assert.equal(image.pixels.length, truth.width * truth.height * 3);
  assert.equal(truth.pixels.length, image.pixels.length, "fixture truth length");

  let total = 0;
  let worst = 0;
  let worstAt = 0;
  for (let index = 0; index < truth.pixels.length; index += 1) {
    const difference = Math.abs((image.pixels[index] ?? 0) - (truth.pixels[index] ?? 0));
    total += difference;
    if (difference > worst) {
      worst = difference;
      worstAt = index;
    }
  }
  const mae = total / truth.pixels.length;

  assert.ok(
    mae < MAX_MEAN_ABSOLUTE_ERROR,
    `${name}: mean absolute error ${mae.toFixed(3)} is not below ${MAX_MEAN_ABSOLUTE_ERROR}`,
  );
  assert.ok(
    worst <= MAX_CHANNEL_DIFFERENCE,
    `${name}: channel ${worstAt % 3} of pixel ${Math.floor(worstAt / 3)} differs by ${worst}`,
  );
  return { mae, worst };
};

const headerAgreesWithDecode = (
  name: string,
  expected: RasterImage | undefined = undefined,
): void => {
  const bytes = bytesOf(`${name}.jpg`);
  const header = readJpegHeader(bytes);
  const image = expected ?? decodeJpeg(bytes);
  assert.equal(header.width, image.width);
  assert.equal(header.height, image.height);
  assert.equal(header.progressive, false);
};

// ---------------------------------------------------------------------------
// Decoding against an independent decoder
// ---------------------------------------------------------------------------

test("V021: 4:4:4 subsampling matches an independent decoder", () => {
  agreesWithPillow("jpeg-444-16x16");
  headerAgreesWithDecode("jpeg-444-16x16");
  assert.equal(readJpegHeader(bytesOf("jpeg-444-16x16.jpg")).components, 3);
});

test("V021: 4:2:2 subsampling matches an independent decoder", () => {
  agreesWithPillow("jpeg-422-16x16");
  headerAgreesWithDecode("jpeg-422-16x16");
});

test("V021: 4:2:0 subsampling matches an independent decoder", () => {
  agreesWithPillow("jpeg-420-16x16");
  headerAgreesWithDecode("jpeg-420-16x16");
});

test("V021: odd dimensions crop the MCU padding away", () => {
  // 17x9 at 4:2:0 is coded as 24x16, so a decoder that forgets to crop returns
  // the padding blocks the encoder invented.
  agreesWithPillow("jpeg-420-17x9");
  const image = decodeJpeg(bytesOf("jpeg-420-17x9.jpg"));
  assert.equal(image.width, 17);
  assert.equal(image.height, 9);
  assert.equal(image.pixels.length, 17 * 9 * 3);
  headerAgreesWithDecode("jpeg-420-17x9", image);
});

test("V021: grayscale decodes to RGB with luma on every channel", () => {
  agreesWithPillow("jpeg-gray-16x16");
  const bytes = bytesOf("jpeg-gray-16x16.jpg");
  assert.equal(readJpegHeader(bytes).components, 1);
  const image = decodeJpeg(bytes);
  for (let pixel = 0; pixel < image.width * image.height; pixel += 1) {
    const offset = pixel * 3;
    assert.equal(image.pixels[offset], image.pixels[offset + 1]);
    assert.equal(image.pixels[offset], image.pixels[offset + 2]);
  }
});

test("V021: restart intervals resynchronise the entropy decoder", () => {
  // Every RSTn resets the DC predictors and the bit buffer; missing either
  // shifts the brightness of whole MCU rows rather than failing outright.
  agreesWithPillow("jpeg-restart-32x32");
  headerAgreesWithDecode("jpeg-restart-32x32");
});

test("V021: an EXIF APP1 segment is skipped, not decoded", () => {
  agreesWithPillow("jpeg-exif-16x16");
  headerAgreesWithDecode("jpeg-exif-16x16");
});

// ---------------------------------------------------------------------------
// Refusals — V021 requires malformed media to fail closed
// ---------------------------------------------------------------------------

test("V021: progressive JPEG is refused rather than approximated", () => {
  const bytes = bytesOf("jpeg-progressive-16x16.jpg");
  assert.throws(
    () => decodeJpeg(bytes),
    (error: unknown) =>
      error instanceof MediaDecodeError && error.reasonCode === "progressive_unsupported",
  );
  // The probe still reports dimensions, flagged, so callers can route the file
  // elsewhere instead of guessing why it failed.
  const header = readJpegHeader(bytes);
  assert.deepEqual(header, { width: 16, height: 16, components: 3, progressive: true });
});

test("V021: truncated JPEG is refused", () => {
  const bytes = bytesOf("jpeg-truncated.jpg");
  assert.throws(
    () => decodeJpeg(bytes),
    (error: unknown) =>
      error instanceof MediaDecodeError && error.reasonCode === "truncated_segment",
  );
  // The probe stops at the frame header by design, so it still reports the
  // dimensions this file does carry. Truncation is the decoder's to refuse.
  assert.equal(readJpegHeader(bytes).width, 16);
});

test("V021: every truncation of a valid JPEG is refused, never padded out", () => {
  const whole = bytesOf("jpeg-420-16x16.jpg");
  for (let dropped = 1; dropped < whole.length - 4; dropped += 1) {
    const cut = whole.subarray(0, whole.length - dropped);
    assert.throws(
      () => decodeJpeg(cut),
      (error: unknown) => error instanceof MediaDecodeError && error.reasonCode.length > 0,
      `dropping the last ${dropped} bytes should be refused`,
    );
  }
});

test("V021: a corrupted byte never escapes as anything but a MediaDecodeError", () => {
  // Failing closed means more than throwing: a TypeError or a RangeError from
  // an unchecked index would reach the pipeline as an unhandled fault rather
  // than a refusal it can attribute to the file. Every single-byte corruption
  // must either decode to a self-consistent raster or raise a reason code.
  const whole = bytesOf("jpeg-420-16x16.jpg");
  for (let index = 0; index < whole.length; index += 1) {
    const corrupted = whole.slice();
    corrupted[index] = (corrupted[index] ?? 0) ^ 0x80;
    try {
      const image = decodeJpeg(corrupted);
      assert.equal(image.pixels.length, image.width * image.height * 3);
    } catch (error) {
      assert.ok(
        error instanceof MediaDecodeError && error.reasonCode.length > 0,
        `flipping bit 7 of byte ${index} raised ${String(error)}`,
      );
    }
  }
});

test("V021: a stream without SOI is refused", () => {
  const bytes = bytesOf("jpeg-444-16x16.jpg").slice(2);
  assert.throws(
    () => decodeJpeg(bytes),
    (error: unknown) => error instanceof MediaDecodeError && error.reasonCode === "not_a_jpeg",
  );
  assert.throws(() => readJpegHeader(new Uint8Array([0xff, 0xd8])), MediaDecodeError);
  assert.throws(() => decodeJpeg(new Uint8Array(0)), MediaDecodeError);
});

test("V021: a frame header with no scan is refused", () => {
  const whole = bytesOf("jpeg-444-16x16.jpg");
  const scanCode = markerAt(whole, 0xda);
  const headersOnly = whole.slice(0, scanCode + 1);
  headersOnly[scanCode] = 0xd9; // SOI, tables, SOF, then straight to EOI
  assert.throws(
    () => decodeJpeg(headersOnly),
    (error: unknown) => error instanceof MediaDecodeError && error.reasonCode === "missing_scan",
  );
});

test("V021: unsupported coding processes are named in the refusal", () => {
  const whole = bytesOf("jpeg-444-16x16.jpg");
  const sofAt = markerAt(whole, 0xc0);

  const withMarker = (code: number): Uint8Array => {
    const copy = whole.slice();
    copy[sofAt] = code;
    return copy;
  };

  const cases: readonly (readonly [number, string])[] = [
    [0xc3, "lossless_unsupported"],
    [0xc9, "arithmetic_coding_unsupported"],
    [0xcb, "arithmetic_coding_unsupported"],
    [0xcf, "arithmetic_coding_unsupported"],
  ];
  for (const [code, reasonCode] of cases) {
    assert.throws(
      () => decodeJpeg(withMarker(code)),
      (error: unknown) => error instanceof MediaDecodeError && error.reasonCode === reasonCode,
      `marker 0x${code.toString(16)} should be refused as ${reasonCode}`,
    );
  }
});

test("V021: 12-bit precision and out-of-scope component counts are refused", () => {
  const whole = bytesOf("jpeg-444-16x16.jpg");
  const sofAt = markerAt(whole, 0xc0);
  const precisionAt = sofAt + 3; // marker, two length bytes, then P
  const componentCountAt = precisionAt + 5; // P, Y (2), X (2), then Nf

  const twelveBit = whole.slice();
  twelveBit[precisionAt] = 12;
  assert.throws(
    () => decodeJpeg(twelveBit),
    (error: unknown) =>
      error instanceof MediaDecodeError && error.reasonCode === "unsupported_precision",
  );

  const cmyk = whole.slice();
  cmyk[componentCountAt] = 4;
  assert.throws(
    () => decodeJpeg(cmyk),
    (error: unknown) =>
      error instanceof MediaDecodeError && error.reasonCode === "cmyk_unsupported",
  );

  const twoComponent = whole.slice();
  twoComponent[componentCountAt] = 2;
  assert.throws(
    () => decodeJpeg(twoComponent),
    (error: unknown) =>
      error instanceof MediaDecodeError && error.reasonCode === "unsupported_component_count",
  );
});

test("V021: a missing quantization table is refused, not defaulted", () => {
  const whole = bytesOf("jpeg-444-16x16.jpg");
  // Retarget the first DQT to destination 3 so component 0 selects a table
  // that was never defined.
  const orphaned = whole.slice();
  orphaned[markerAt(whole, 0xdb) + 3] = 0x03;
  assert.throws(
    () => decodeJpeg(orphaned),
    (error: unknown) =>
      error instanceof MediaDecodeError && error.reasonCode === "missing_quantization_table",
  );
});

test("V021: an out-of-order restart marker is refused", () => {
  const whole = bytesOf("jpeg-restart-32x32.jpg");
  const shuffled = whole.slice();
  shuffled[markerAt(whole, 0xd0)] = 0xd3; // RST3 where RST0 belongs
  assert.throws(
    () => decodeJpeg(shuffled),
    (error: unknown) =>
      error instanceof MediaDecodeError && error.reasonCode === "out_of_order_restart_marker",
  );
});
