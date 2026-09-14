/**
 * Package entry-point test (roadmap V021).
 *
 * `package.json` pointed at `./src/index.ts` while no such file existed, so
 * every decoder in this package was unreachable by its package name and no
 * other package could consume V021 at all. This pins the entry point so the
 * same gap cannot reopen silently.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import * as media from "@vision/media";

test("V021: the media package is importable by its package name", () => {
  for (const name of [
    "decodeJpeg",
    "decodePng",
    "encodeRgbPng",
    "readJpegExif",
    "perceptualHash",
    "probeAudio",
    "resampleBox",
    "fitWithin",
    "toLuma",
  ] as const) {
    assert.equal(typeof media[name], "function", `${name} must be exported`);
  }
  assert.equal(typeof media.MediaDecodeError, "function");
  assert.equal(typeof media.PHASH_HEX_LENGTH, "number");
});
