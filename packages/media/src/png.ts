/**
 * PNG decoding and encoding on Node built-ins alone (roadmap V021).
 *
 * PNG needs no image library: the format is a chunk container around a zlib
 * stream, and `node:zlib` supplies both the inflate and the CRC-32. That is why
 * every derivative this pipeline emits is a re-encoded PNG — the encoder is
 * small enough to be obviously correct, and re-encoding drops every metadata
 * block by construction rather than by a removal pass whose completeness we
 * would have to prove.
 *
 * Deliberately refused: interlaced (Adam7) images, since nothing in the
 * pipeline produces them and a partial pass reconstruction is exactly the kind
 * of "nearly right" decode V021 requires us not to accept.
 */

import { crc32, deflateSync, inflateSync } from "node:zlib";

import { assertRasterConsistent, MediaDecodeError, type RasterImage } from "./raster.ts";

const SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Channels carried per pixel by each PNG colour type. */
const CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const readU32 = (bytes: Uint8Array, offset: number): number => {
  const a = bytes[offset] ?? 0;
  const b = bytes[offset + 1] ?? 0;
  const c = bytes[offset + 2] ?? 0;
  const d = bytes[offset + 3] ?? 0;
  return a * 0x1000000 + b * 0x10000 + c * 0x100 + d;
};

const writeU32 = (value: number): Uint8Array =>
  Uint8Array.from([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);

export type PngHeader = {
  readonly width: number;
  readonly height: number;
  readonly bitDepth: number;
  readonly colorType: number;
  readonly interlaced: boolean;
};

type PngChunk = { readonly type: string; readonly data: Uint8Array };

/**
 * Walks the chunk stream, verifying every CRC.
 *
 * A CRC is checked even though the payload is about to be inflated anyway:
 * corruption in a non-critical chunk would otherwise pass silently, and V021
 * treats "the bytes are not what the uploader thinks they are" as a reason to
 * quarantine rather than to guess.
 */
const readChunks = (bytes: Uint8Array): readonly PngChunk[] => {
  for (let index = 0; index < SIGNATURE.length; index += 1) {
    if (bytes[index] !== SIGNATURE[index]) {
      throw new MediaDecodeError("not_png", "bytes do not begin with the PNG signature");
    }
  }

  const chunks: PngChunk[] = [];
  let offset = SIGNATURE.length;
  let sawEnd = false;

  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) {
      throw new MediaDecodeError("png_truncated", "chunk header runs past the end of the file");
    }
    const length = readU32(bytes, offset);
    const typeBytes = bytes.subarray(offset + 4, offset + 8);
    const type = String.fromCharCode(...typeBytes);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) {
      throw new MediaDecodeError("png_truncated", `chunk ${type} runs past the end of the file`);
    }

    const data = bytes.subarray(dataStart, dataEnd);
    const declared = readU32(bytes, dataEnd);
    const computed = crc32(data, crc32(typeBytes)) >>> 0;
    if (declared !== computed) {
      throw new MediaDecodeError("png_bad_crc", `chunk ${type} failed its CRC-32 check`);
    }

    chunks.push({ type, data });
    offset = dataEnd + 4;
    if (type === "IEND") {
      sawEnd = true;
      break;
    }
  }

  if (!sawEnd) throw new MediaDecodeError("png_truncated", "no IEND chunk");
  return chunks;
};

const parseHeader = (chunks: readonly PngChunk[]): PngHeader => {
  const ihdr = chunks[0];
  if (ihdr === undefined || ihdr.type !== "IHDR" || ihdr.data.length !== 13) {
    throw new MediaDecodeError("png_no_ihdr", "first chunk is not a 13-byte IHDR");
  }
  const width = readU32(ihdr.data, 0);
  const height = readU32(ihdr.data, 4);
  const bitDepth = ihdr.data[8] ?? 0;
  const colorType = ihdr.data[9] ?? 0;
  const compression = ihdr.data[10] ?? 0;
  const filterMethod = ihdr.data[11] ?? 0;
  const interlace = ihdr.data[12] ?? 0;

  if (width === 0 || height === 0) {
    throw new MediaDecodeError("png_empty", `IHDR declares ${width}x${height}`);
  }
  if (compression !== 0) {
    throw new MediaDecodeError("png_unsupported", `compression method ${compression}`);
  }
  if (filterMethod !== 0) {
    throw new MediaDecodeError("png_unsupported", `filter method ${filterMethod}`);
  }
  if (!Object.hasOwn(CHANNELS, colorType)) {
    throw new MediaDecodeError("png_unsupported", `colour type ${colorType}`);
  }
  const permittedDepths =
    colorType === 3 ? [1, 2, 4, 8] : colorType === 0 ? [1, 2, 4, 8, 16] : [8, 16];
  if (!permittedDepths.includes(bitDepth)) {
    throw new MediaDecodeError(
      "png_unsupported",
      `bit depth ${bitDepth} is not valid for colour type ${colorType}`,
    );
  }

  return { width, height, bitDepth, colorType, interlaced: interlace !== 0 };
};

export const readPngHeader = (bytes: Uint8Array): PngHeader => parseHeader(readChunks(bytes));

/** Paeth predictor from the PNG specification, byte-for-byte. */
const paeth = (left: number, up: number, upLeft: number): number => {
  const estimate = left + up - upLeft;
  const distanceLeft = Math.abs(estimate - left);
  const distanceUp = Math.abs(estimate - up);
  const distanceUpLeft = Math.abs(estimate - upLeft);
  if (distanceLeft <= distanceUp && distanceLeft <= distanceUpLeft) return left;
  return distanceUp <= distanceUpLeft ? up : upLeft;
};

/**
 * Reverses the per-scanline filters in place.
 *
 * `filterUnit` is the byte distance to the pixel to the left, which is one byte
 * for sub-byte depths — filtering works on bytes, not samples, and getting this
 * wrong produces an image that looks almost right at depth 8 and badly wrong
 * below it.
 */
const unfilter = (
  raw: Uint8Array,
  height: number,
  stride: number,
  filterUnit: number,
): Uint8Array => {
  const out = new Uint8Array(height * stride);
  let previousRow = new Uint8Array(stride);

  for (let row = 0; row < height; row += 1) {
    const filterOffset = row * (stride + 1);
    const filter = raw[filterOffset];
    if (filter === undefined || filter > 4) {
      throw new MediaDecodeError("png_bad_filter", `scanline ${row} uses filter ${filter}`);
    }
    const line = out.subarray(row * stride, row * stride + stride);
    for (let index = 0; index < stride; index += 1) {
      const value = raw[filterOffset + 1 + index] ?? 0;
      const left = index >= filterUnit ? (line[index - filterUnit] ?? 0) : 0;
      const up = previousRow[index] ?? 0;
      const upLeft = index >= filterUnit ? (previousRow[index - filterUnit] ?? 0) : 0;
      switch (filter) {
        case 0:
          line[index] = value;
          break;
        case 1:
          line[index] = (value + left) & 0xff;
          break;
        case 2:
          line[index] = (value + up) & 0xff;
          break;
        case 3:
          line[index] = (value + ((left + up) >> 1)) & 0xff;
          break;
        default:
          line[index] = (value + paeth(left, up, upLeft)) & 0xff;
          break;
      }
    }
    previousRow = line;
  }
  return out;
};

/** Reads sample `index` of a scanline at any supported bit depth, scaled to 8 bits. */
const sampleAt = (line: Uint8Array, index: number, bitDepth: number, scale: boolean): number => {
  if (bitDepth === 8) return line[index] ?? 0;
  if (bitDepth === 16) return line[index * 2] ?? 0; // high byte; low byte is precision we drop
  const perByte = 8 / bitDepth;
  const byte = line[Math.floor(index / perByte)] ?? 0;
  const shift = 8 - bitDepth * ((index % perByte) + 1);
  const value = (byte >> shift) & ((1 << bitDepth) - 1);
  // Palette indices must stay raw; grey levels are scaled to full range.
  return scale ? Math.round((value * 255) / ((1 << bitDepth) - 1)) : value;
};

export const decodePng = (bytes: Uint8Array): RasterImage => {
  const chunks = readChunks(bytes);
  const header = parseHeader(chunks);
  if (header.interlaced) {
    throw new MediaDecodeError("png_interlaced", "interlaced PNG is not supported");
  }

  const { width, height, bitDepth, colorType } = header;
  const channels = CHANNELS[colorType] ?? 0;

  let palette: Uint8Array | undefined;
  const idatParts: Uint8Array[] = [];
  for (const chunk of chunks) {
    if (chunk.type === "PLTE") palette = chunk.data;
    else if (chunk.type === "IDAT") idatParts.push(chunk.data);
  }
  if (idatParts.length === 0) throw new MediaDecodeError("png_no_idat", "no IDAT chunk");
  if (colorType === 3 && palette === undefined) {
    throw new MediaDecodeError("png_no_plte", "colour type 3 requires a PLTE chunk");
  }

  let raw: Uint8Array;
  try {
    raw = new Uint8Array(inflateSync(Buffer.concat(idatParts)));
  } catch (cause) {
    throw new MediaDecodeError("png_inflate_failed", `IDAT is not a valid zlib stream: ${cause}`);
  }

  const stride = Math.ceil((width * channels * bitDepth) / 8);
  if (raw.length < height * (stride + 1)) {
    throw new MediaDecodeError(
      "png_short_idat",
      `inflated to ${raw.length} bytes; ${height} scanlines of ${stride} need ${height * (stride + 1)}`,
    );
  }

  const filterUnit = Math.max(1, Math.ceil((channels * bitDepth) / 8));
  const unfiltered = unfilter(raw, height, stride, filterUnit);
  const pixels = new Uint8Array(width * height * 3);

  for (let row = 0; row < height; row += 1) {
    const line = unfiltered.subarray(row * stride, row * stride + stride);
    for (let column = 0; column < width; column += 1) {
      const target = (row * width + column) * 3;
      if (colorType === 3) {
        const index = sampleAt(line, column, bitDepth, false);
        const entry = index * 3;
        if (palette === undefined || entry + 2 >= palette.length) {
          throw new MediaDecodeError("png_palette_range", `palette index ${index} is out of range`);
        }
        pixels[target] = palette[entry] ?? 0;
        pixels[target + 1] = palette[entry + 1] ?? 0;
        pixels[target + 2] = palette[entry + 2] ?? 0;
      } else if (colorType === 0 || colorType === 4) {
        const grey = sampleAt(line, column * channels, bitDepth, true);
        pixels[target] = grey;
        pixels[target + 1] = grey;
        pixels[target + 2] = grey;
      } else {
        const base = column * channels;
        pixels[target] = sampleAt(line, base, bitDepth, true);
        pixels[target + 1] = sampleAt(line, base + 1, bitDepth, true);
        pixels[target + 2] = sampleAt(line, base + 2, bitDepth, true);
      }
    }
  }

  return assertRasterConsistent({ width, height, pixels });
};

const chunk = (type: string, data: Uint8Array): Uint8Array => {
  const typeBytes = Uint8Array.from([...type].map((character) => character.charCodeAt(0)));
  const crc = crc32(data, crc32(typeBytes)) >>> 0;
  return Buffer.concat([writeU32(data.length), typeBytes, data, writeU32(crc)]);
};

/**
 * Writes an 8-bit RGB PNG.
 *
 * Filter type 0 (None) on every scanline: zlib still compresses these small
 * derivatives well, and an unfiltered writer has no predictor to get wrong. A
 * per-row filter heuristic is a file-size optimisation available later if
 * derivative storage ever shows up in the V049 budget.
 */
export const encodeRgbPng = (image: RasterImage): Uint8Array => {
  assertRasterConsistent(image);
  const { width, height, pixels } = image;

  const rawLength = height * (width * 3 + 1);
  const raw = new Uint8Array(rawLength);
  for (let row = 0; row < height; row += 1) {
    const target = row * (width * 3 + 1);
    raw[target] = 0;
    raw.set(pixels.subarray(row * width * 3, (row + 1) * width * 3), target + 1);
  }

  const ihdr = new Uint8Array(13);
  ihdr.set(writeU32(width), 0);
  ihdr.set(writeU32(height), 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return new Uint8Array(
    Buffer.concat([
      SIGNATURE,
      chunk("IHDR", ihdr),
      chunk("IDAT", new Uint8Array(deflateSync(raw, { level: 9 }))),
      chunk("IEND", new Uint8Array(0)),
    ]),
  );
};
