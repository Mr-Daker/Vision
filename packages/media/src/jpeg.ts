/**
 * Baseline sequential JPEG decoder (roadmap V021).
 *
 * Hand-written because this workspace carries exactly one runtime dependency
 * (`pg`) by design: no image library is available and none may be added. So
 * everything from canonical Huffman code construction to the inverse DCT is
 * here, on Node built-ins only.
 *
 * It decodes what citizen submissions actually contain: 8-bit Huffman-coded
 * sequential frames (SOF0, and SOF1 which is bit-identical to decode at 8-bit
 * precision), one or three components, any integer HxV sampling — 4:4:4, 4:2:2
 * and 4:2:0 included — restart intervals, and 0xFF00-stuffed entropy data.
 * Subsampled chroma is reconstructed with the same triangle filter libjpeg and
 * therefore every reference decoder uses; see `upsamplePlane` for why that
 * choice, rather than pixel replication, is what "correct" means here.
 *
 * Everything else is refused rather than approximated: progressive (SOF2),
 * arithmetic-coded, lossless, differential and hierarchical frames, sample
 * precision other than 8, CMYK/YCCK, deferred height (DNL), unknown markers,
 * and any stream whose entropy data runs out before the last MCU. V021 requires
 * malformed media to fail closed — downstream evidence handling cannot tell a
 * half-decoded raster from a valid one, so a partial decode is worse than a
 * refusal.
 *
 * EXIF is deliberately not read here. APPn and COM segments are skipped by
 * their length field; orientation and metadata are a separate file's job.
 */

import { MediaDecodeError, assertRasterConsistent, type RasterImage } from "./raster.ts";

/**
 * Header facts the pipeline wants before committing to a full entropy decode.
 *
 * `progressive` is reported rather than refused: the probe exists so a caller
 * can route a file, and it stops at the frame header, so it validates only
 * that much. It is not a substitute for `decodeJpeg` as a validity check —
 * damage past the frame header is the decoder's to find.
 */
export type JpegHeader = {
  readonly width: number;
  readonly height: number;
  readonly components: number;
  readonly progressive: boolean;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MARKER = {
  SOI: 0xd8,
  EOI: 0xd9,
  SOS: 0xda,
  DQT: 0xdb,
  DRI: 0xdd,
  DHT: 0xc4,
  COM: 0xfe,
  TEM: 0x01,
  APP0: 0xe0,
  APP15: 0xef,
  RST0: 0xd0,
  RST7: 0xd7,
} as const;

/** Frame markers whose coding process this decoder implements. */
const SEQUENTIAL_FRAME_MARKERS: ReadonlySet<number> = new Set([0xc0, 0xc1]);
const PROGRESSIVE_FRAME_MARKER = 0xc2;

/**
 * Coding processes that will never be implemented here, named individually so a
 * refusal reports what it actually saw instead of a blanket "unsupported".
 */
const REFUSED_FRAME_MARKERS = new Map<number, readonly [string, string]>([
  [0xc3, ["lossless_unsupported", "lossless (SOF3)"]],
  [0xc5, ["differential_unsupported", "differential sequential (SOF5)"]],
  [0xc6, ["differential_unsupported", "differential progressive (SOF6)"]],
  [0xc7, ["differential_unsupported", "differential lossless (SOF7)"]],
  [0xc8, ["reserved_frame_marker", "reserved JPEG extension (0xC8)"]],
  [0xc9, ["arithmetic_coding_unsupported", "arithmetic extended sequential (SOF9)"]],
  [0xca, ["arithmetic_coding_unsupported", "arithmetic progressive (SOF10)"]],
  [0xcb, ["arithmetic_coding_unsupported", "arithmetic lossless (SOF11)"]],
  [0xcd, ["arithmetic_coding_unsupported", "differential arithmetic sequential (SOF13)"]],
  [0xce, ["arithmetic_coding_unsupported", "differential arithmetic progressive (SOF14)"]],
  [0xcf, ["arithmetic_coding_unsupported", "differential arithmetic lossless (SOF15)"]],
]);

/** Natural (row-major) coefficient index for each step of the zig-zag sequence. */
const ZIGZAG_TO_NATURAL = new Uint8Array([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20,
  13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52,
  45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
]);

/**
 * Separable IDCT basis: BASIS[u * 8 + x] = C(u)/2 * cos((2x+1)u*pi/16) with
 * C(0) = 1/sqrt(2). Halving on each of the two passes reproduces the spec's
 * 1/4 * C(u) * C(v) scaling without a separate normalisation step.
 */
const IDCT_BASIS = ((): Float64Array => {
  const basis = new Float64Array(64);
  for (let u = 0; u < 8; u += 1) {
    const scale = (u === 0 ? Math.SQRT1_2 : 1) / 2;
    for (let x = 0; x < 8; x += 1) {
      basis[u * 8 + x] = scale * Math.cos(((2 * x + 1) * u * Math.PI) / 16);
    }
  }
  return basis;
})();

// ---------------------------------------------------------------------------
// Byte-level readers
// ---------------------------------------------------------------------------

const byteAt = (bytes: Uint8Array, offset: number): number => {
  const value = bytes[offset];
  if (value === undefined) {
    throw new MediaDecodeError("truncated_jpeg", `stream ends before byte ${offset}`);
  }
  return value;
};

const uint16At = (bytes: Uint8Array, offset: number): number =>
  (byteAt(bytes, offset) << 8) | byteAt(bytes, offset + 1);

const expectSoi = (bytes: Uint8Array): number => {
  if (bytes[0] !== 0xff || bytes[1] !== MARKER.SOI) {
    throw new MediaDecodeError("not_a_jpeg", "stream does not begin with a JPEG SOI marker");
  }
  if (bytes.length < 4) {
    throw new MediaDecodeError(
      "truncated_jpeg",
      `stream is ${bytes.length} bytes; SOI and no more`,
    );
  }
  return 2;
};

type MarkerAt = { readonly code: number; readonly next: number };

/**
 * Reads the marker at `cursor`. A marker may be preceded by any number of extra
 * 0xFF fill bytes, so the run is collapsed; `next` is the first byte after the
 * marker code (its length field, for markers that carry one).
 */
const readMarker = (bytes: Uint8Array, cursor: number): MarkerAt => {
  if (byteAt(bytes, cursor) !== 0xff) {
    throw new MediaDecodeError(
      "bad_marker_sequence",
      `expected a marker at byte ${cursor}, found 0x${byteAt(bytes, cursor).toString(16)}`,
    );
  }
  let at = cursor;
  while (bytes[at] === 0xff) at += 1;
  const code = bytes[at];
  if (code === undefined) {
    throw new MediaDecodeError("truncated_jpeg", `stream ends inside a marker at byte ${cursor}`);
  }
  if (code === 0x00) {
    throw new MediaDecodeError("bad_marker_sequence", `stuffed 0xFF00 outside entropy-coded data`);
  }
  return { code, next: at + 1 };
};

type Segment = { readonly start: number; readonly end: number };

/** Payload bounds of a length-carrying marker segment. */
const readSegment = (bytes: Uint8Array, marker: MarkerAt): Segment => {
  const length = uint16At(bytes, marker.next);
  if (length < 2) {
    throw new MediaDecodeError(
      "bad_segment_length",
      `segment length ${length} is below the header`,
    );
  }
  const end = marker.next + length;
  if (end > bytes.length) {
    throw new MediaDecodeError(
      "truncated_segment",
      `segment at byte ${marker.next} claims ${length} bytes but only ${bytes.length - marker.next} remain`,
    );
  }
  return { start: marker.next + 2, end };
};

/** True for markers that carry no length field and so cannot be skipped by size. */
const isStandalone = (code: number): boolean =>
  code === MARKER.SOI ||
  code === MARKER.EOI ||
  code === MARKER.TEM ||
  (code >= MARKER.RST0 && code <= MARKER.RST7);

/** APPn and COM are the only segments whose contents this decoder ignores. */
const isSkippable = (code: number): boolean =>
  code === MARKER.COM || (code >= MARKER.APP0 && code <= MARKER.APP15);

// ---------------------------------------------------------------------------
// Frame header
// ---------------------------------------------------------------------------

type FrameComponent = {
  readonly id: number;
  readonly h: number;
  readonly v: number;
  readonly quantTable: number;
};

type FrameHeader = {
  readonly width: number;
  readonly height: number;
  readonly progressive: boolean;
  readonly components: readonly FrameComponent[];
};

const parseFrameHeader = (bytes: Uint8Array, code: number, payload: Segment): FrameHeader => {
  const refused = REFUSED_FRAME_MARKERS.get(code);
  if (refused !== undefined) {
    const [reason, what] = refused;
    throw new MediaDecodeError(reason, `${what} JPEG is not decodable by this pipeline`);
  }
  if (!SEQUENTIAL_FRAME_MARKERS.has(code) && code !== PROGRESSIVE_FRAME_MARKER) {
    throw new MediaDecodeError(
      "unknown_frame_marker",
      `unrecognised start-of-frame marker 0x${code.toString(16)}`,
    );
  }

  const precision = byteAt(bytes, payload.start);
  if (precision !== 8) {
    throw new MediaDecodeError(
      "unsupported_precision",
      `sample precision ${precision} is not supported; only 8-bit frames decode here`,
    );
  }

  const height = uint16At(bytes, payload.start + 1);
  const width = uint16At(bytes, payload.start + 3);
  if (width === 0 || height === 0) {
    // A zero height means the real one arrives in a DNL marker after the first
    // scan. Nothing in this pipeline needs it, and guessing is not an option.
    throw new MediaDecodeError("empty_frame", `frame declares no area: ${width}x${height}`);
  }

  const count = byteAt(bytes, payload.start + 5);
  if (count === 4) {
    throw new MediaDecodeError(
      "cmyk_unsupported",
      "4-component (CMYK/YCCK) JPEG is out of scope for this pipeline",
    );
  }
  if (count !== 1 && count !== 3) {
    throw new MediaDecodeError(
      "unsupported_component_count",
      `frame has ${count} components; only 1 (grayscale) and 3 (YCbCr) decode here`,
    );
  }
  if (payload.start + 6 + count * 3 > payload.end) {
    throw new MediaDecodeError("truncated_segment", "start-of-frame segment is shorter than Nf");
  }

  const components: FrameComponent[] = [];
  for (let index = 0; index < count; index += 1) {
    const at = payload.start + 6 + index * 3;
    const sampling = byteAt(bytes, at + 1);
    const h = sampling >> 4;
    const v = sampling & 0x0f;
    if (h < 1 || h > 4 || v < 1 || v > 4) {
      throw new MediaDecodeError(
        "bad_sampling_factor",
        `component ${index} declares ${h}x${v} sampling, outside the legal 1..4`,
      );
    }
    const quantTable = byteAt(bytes, at + 2);
    if (quantTable > 3) {
      throw new MediaDecodeError(
        "bad_quant_destination",
        `component ${index} selects quantization table ${quantTable}`,
      );
    }
    components.push({ id: byteAt(bytes, at), h, v, quantTable });
  }

  return { width, height, progressive: code === PROGRESSIVE_FRAME_MARKER, components };
};

/**
 * Walks marker segments until the frame header, skipping everything that does
 * not describe the frame. Deliberately does no entropy decoding.
 */
const findFrameHeader = (bytes: Uint8Array): FrameHeader => {
  let cursor = expectSoi(bytes);
  while (cursor < bytes.length) {
    const marker = readMarker(bytes, cursor);
    if (marker.code === MARKER.TEM) {
      cursor = marker.next;
      continue;
    }
    if (isStandalone(marker.code)) {
      throw new MediaDecodeError(
        "unexpected_marker",
        `marker 0x${marker.code.toString(16)} appears before any frame header`,
      );
    }
    const payload = readSegment(bytes, marker);
    if (marker.code === MARKER.SOS) {
      throw new MediaDecodeError("missing_frame_header", "scan begins before any frame header");
    }
    if (marker.code >= 0xc0 && marker.code <= 0xcf && marker.code !== MARKER.DHT) {
      // 0xCC (DAC) lands here too: arithmetic conditioning implies a coding
      // process this decoder refuses, so let the frame parser name it.
      if (marker.code === 0xcc) {
        throw new MediaDecodeError(
          "arithmetic_coding_unsupported",
          "arithmetic conditioning table (DAC) implies arithmetic coding",
        );
      }
      return parseFrameHeader(bytes, marker.code, payload);
    }
    cursor = payload.end;
  }
  throw new MediaDecodeError("missing_frame_header", "stream contains no start-of-frame marker");
};

export const readJpegHeader = (bytes: Uint8Array): JpegHeader => {
  const frame = findFrameHeader(bytes);
  return {
    width: frame.width,
    height: frame.height,
    components: frame.components.length,
    progressive: frame.progressive,
  };
};

// ---------------------------------------------------------------------------
// Huffman tables
// ---------------------------------------------------------------------------

/**
 * A flat lookup indexed by the next `bits` bits of the stream, holding
 * `(codeLength << 8) | value` — so one indexed read replaces a per-bit walk.
 * An entry of 0 means no code claims that prefix, which is unambiguous because
 * every real code is at least one bit long.
 */
type HuffmanTable = { readonly lookup: Int32Array; readonly bits: number };

const buildHuffmanTable = (counts: readonly number[], values: Uint8Array): HuffmanTable => {
  let maxLength = 0;
  for (let length = 1; length <= 16; length += 1) {
    if ((counts[length] ?? 0) > 0) maxLength = length;
  }
  if (maxLength === 0) {
    throw new MediaDecodeError("empty_huffman_table", "Huffman table defines no codes");
  }

  const lookup = new Int32Array(1 << maxLength);
  let code = 0;
  let taken = 0;
  for (let length = 1; length <= maxLength; length += 1) {
    for (let index = 0; index < (counts[length] ?? 0); index += 1) {
      // Canonical ordering (spec Annex C): within a length, codes ascend in the
      // order the values appear in HUFFVAL; moving to the next length shifts
      // the running code left by one.
      if (code >= 1 << length) {
        throw new MediaDecodeError(
          "oversubscribed_huffman_table",
          `Huffman table assigns more ${length}-bit codes than exist`,
        );
      }
      const value = values[taken];
      if (value === undefined) {
        throw new MediaDecodeError(
          "bad_huffman_table",
          "Huffman table has fewer values than codes",
        );
      }
      taken += 1;
      const shift = maxLength - length;
      const base = code << shift;
      lookup.fill((length << 8) | value, base, base + (1 << shift));
      code += 1;
    }
    code <<= 1;
  }
  return { lookup, bits: maxLength };
};

// ---------------------------------------------------------------------------
// Scan decoding
// ---------------------------------------------------------------------------

type Plane = {
  readonly h: number;
  readonly v: number;
  readonly blocksPerLine: number;
  readonly blocksPerColumn: number;
  readonly stride: number;
  readonly samples: Uint8Array;
};

type Frame = {
  readonly header: FrameHeader;
  readonly hMax: number;
  readonly vMax: number;
  readonly mcusPerLine: number;
  readonly mcusPerColumn: number;
  readonly planes: readonly Plane[];
};

type Tables = {
  readonly quant: (Uint16Array | undefined)[];
  readonly dc: (HuffmanTable | undefined)[];
  readonly ac: (HuffmanTable | undefined)[];
};

type ScanTarget = {
  readonly component: number;
  readonly plane: Plane;
  readonly dcTable: HuffmanTable;
  readonly acTable: HuffmanTable;
  readonly quant: Uint16Array;
  /** DC is coded as a difference from the previous block of the same component. */
  predictor: number;
};

const buildFrame = (header: FrameHeader): Frame => {
  let hMax = 1;
  let vMax = 1;
  for (const component of header.components) {
    hMax = Math.max(hMax, component.h);
    vMax = Math.max(vMax, component.v);
  }
  const mcusPerLine = Math.ceil(header.width / (8 * hMax));
  const mcusPerColumn = Math.ceil(header.height / (8 * vMax));

  const planes = header.components.map((component): Plane => {
    // Sized to whole MCUs, not to the image: the encoder codes the padding
    // blocks that complete the final MCU, and they must land somewhere before
    // being cropped away.
    const blocksPerLine = mcusPerLine * component.h;
    const blocksPerColumn = mcusPerColumn * component.v;
    return {
      h: component.h,
      v: component.v,
      blocksPerLine,
      blocksPerColumn,
      stride: blocksPerLine * 8,
      samples: new Uint8Array(blocksPerLine * 8 * blocksPerColumn * 8),
    };
  });

  return { header, hMax, vMax, mcusPerLine, mcusPerColumn, planes };
};

const parseScanTargets = (
  bytes: Uint8Array,
  payload: Segment,
  frame: Frame,
  tables: Tables,
): { readonly targets: ScanTarget[]; readonly entropyStart: number } => {
  const count = byteAt(bytes, payload.start);
  if (count < 1 || count > frame.header.components.length) {
    throw new MediaDecodeError("bad_scan_component_count", `scan declares ${count} components`);
  }
  if (payload.start + 4 + count * 2 !== payload.end) {
    throw new MediaDecodeError(
      "bad_segment_length",
      "start-of-scan segment length disagrees with Ns",
    );
  }

  const spectralStart = byteAt(bytes, payload.start + 1 + count * 2);
  const spectralEnd = byteAt(bytes, payload.start + 2 + count * 2);
  const approximation = byteAt(bytes, payload.start + 3 + count * 2);
  if (spectralStart !== 0 || spectralEnd !== 63 || approximation !== 0) {
    throw new MediaDecodeError(
      "unsupported_scan_parameters",
      `sequential scans must cover coefficients 0..63 with no successive approximation, got ${spectralStart}..${spectralEnd}/0x${approximation.toString(16)}`,
    );
  }

  const targets: ScanTarget[] = [];
  for (let index = 0; index < count; index += 1) {
    const at = payload.start + 1 + index * 2;
    const selector = byteAt(bytes, at);
    const componentIndex = frame.header.components.findIndex((c) => c.id === selector);
    const component = frame.header.components[componentIndex];
    const plane = frame.planes[componentIndex];
    if (component === undefined || plane === undefined) {
      throw new MediaDecodeError(
        "unknown_scan_component",
        `scan selects component ${selector}, which the frame does not declare`,
      );
    }
    if (targets.some((target) => target.component === componentIndex)) {
      throw new MediaDecodeError(
        "duplicate_scan_component",
        `component ${selector} appears twice in one scan`,
      );
    }

    const spec = byteAt(bytes, at + 1);
    const dcTable = tables.dc[spec >> 4];
    const acTable = tables.ac[spec & 0x0f];
    if (dcTable === undefined || acTable === undefined) {
      throw new MediaDecodeError(
        "missing_huffman_table",
        `component ${selector} selects Huffman tables ${spec >> 4}/${spec & 0x0f}, which were never defined`,
      );
    }
    const quant = tables.quant[component.quantTable];
    if (quant === undefined) {
      throw new MediaDecodeError(
        "missing_quantization_table",
        `component ${selector} selects quantization table ${component.quantTable}, which was never defined`,
      );
    }
    targets.push({ component: componentIndex, plane, dcTable, acTable, quant, predictor: 0 });
  }

  return { targets, entropyStart: payload.end };
};

/**
 * Decodes one scan's entropy-coded data straight into the component sample
 * planes. Baseline blocks arrive complete, so each is dequantized and inverse
 * transformed immediately rather than buffering coefficients for the frame.
 *
 * Returns the byte offset of the marker that ends the scan.
 */
const decodeScan = (
  bytes: Uint8Array,
  payload: Segment,
  frame: Frame,
  tables: Tables,
  restartInterval: number,
): { readonly cursor: number; readonly decoded: readonly number[] } => {
  const { targets, entropyStart } = parseScanTargets(bytes, payload, frame, tables);

  let position = entropyStart;
  let bitBuffer = 0;
  let bitCount = 0;
  /**
   * How many buffered bits came from real file bytes. Bits are appended low and
   * consumed high, and padding is only ever appended once the data is spent, so
   * the real bits are always the leading ones.
   */
  let realBits = 0;
  let spent = false;

  /** One byte of entropy data, un-stuffing 0xFF00 and halting at any marker. */
  const nextByte = (): number | undefined => {
    while (position < bytes.length) {
      const byte = bytes[position] ?? 0;
      if (byte !== 0xff) {
        position += 1;
        return byte;
      }
      const following = bytes[position + 1];
      if (following === 0x00) {
        position += 2;
        return 0xff;
      }
      if (following === 0xff) {
        position += 1; // 0xFF fill padding ahead of a marker
        continue;
      }
      spent = true; // leave `position` on the marker's 0xFF for the caller
      return undefined;
    }
    spent = true;
    return undefined;
  };

  const ensureBits = (count: number): void => {
    while (bitCount < count) {
      const byte = spent ? undefined : nextByte();
      if (byte === undefined) {
        // Feed the conventional 1-bit padding so a final short code can still
        // be peeked, but never count it as real: consuming one of these bits
        // means the encoder stopped mid-symbol.
        bitBuffer = (bitBuffer << 8) | 0xff;
        bitCount += 8;
      } else {
        bitBuffer = (bitBuffer << 8) | byte;
        bitCount += 8;
        realBits += 8;
      }
    }
  };

  const peekBits = (count: number): number => {
    ensureBits(count);
    return (bitBuffer >>> (bitCount - count)) & ((1 << count) - 1);
  };

  const consumeBits = (count: number): void => {
    if (count > realBits) {
      throw new MediaDecodeError(
        "truncated_entropy_data",
        `entropy-coded data ended mid-symbol near byte ${position}`,
      );
    }
    bitCount -= count;
    realBits -= count;
    bitBuffer &= (1 << bitCount) - 1;
  };

  const decodeSymbol = (table: HuffmanTable): number => {
    const entry = table.lookup[peekBits(table.bits)] ?? 0;
    if (entry === 0) {
      throw new MediaDecodeError(
        "bad_huffman_code",
        `no Huffman code matches the bits at byte ${position}`,
      );
    }
    consumeBits(entry >>> 8);
    return entry & 0xff;
  };

  const receive = (length: number): number => {
    if (length === 0) return 0;
    const value = peekBits(length);
    consumeBits(length);
    return value;
  };

  /** Spec's EXTEND (Figure F.12): the magnitude's top bit carries the sign. */
  const extend = (value: number, length: number): number =>
    value < 1 << (length - 1) ? value - (1 << length) + 1 : value;

  let expectedRestart = 0;
  const restart = (): void => {
    const marker = readMarker(bytes, position);
    if (marker.code < MARKER.RST0 || marker.code > MARKER.RST7) {
      throw new MediaDecodeError(
        "missing_restart_marker",
        `expected RST${expectedRestart} at byte ${position}, found 0x${marker.code.toString(16)}`,
      );
    }
    if (marker.code - MARKER.RST0 !== expectedRestart) {
      throw new MediaDecodeError(
        "out_of_order_restart_marker",
        `expected RST${expectedRestart}, found RST${marker.code - MARKER.RST0}`,
      );
    }
    expectedRestart = (expectedRestart + 1) % 8;
    position = marker.next;
    bitBuffer = 0;
    bitCount = 0;
    realBits = 0;
    spent = false;
    for (const target of targets) target.predictor = 0;
  };

  const coefficients = new Float64Array(64);
  const partial = new Float64Array(64);

  const decodeBlock = (target: ScanTarget, blockRow: number, blockColumn: number): void => {
    const plane = target.plane;
    if (blockRow >= plane.blocksPerColumn || blockColumn >= plane.blocksPerLine) {
      throw new MediaDecodeError(
        "block_out_of_frame",
        `block ${blockColumn},${blockRow} falls outside the coded frame`,
      );
    }
    coefficients.fill(0);
    const quant = target.quant;

    const magnitude = decodeSymbol(target.dcTable);
    if (magnitude > 15) {
      throw new MediaDecodeError(
        "bad_dc_category",
        `DC magnitude category ${magnitude} is illegal`,
      );
    }
    target.predictor += magnitude === 0 ? 0 : extend(receive(magnitude), magnitude);
    coefficients[0] = target.predictor * (quant[0] ?? 0);

    let index = 1;
    while (index < 64) {
      const runSize = decodeSymbol(target.acTable);
      const size = runSize & 0x0f;
      const run = runSize >> 4;
      if (size === 0) {
        if (run !== 15) break; // EOB: every remaining coefficient is zero
        index += 16; // ZRL: sixteen zeroes
        continue;
      }
      index += run;
      if (index > 63) {
        throw new MediaDecodeError(
          "coefficient_overrun",
          `zero run reaches coefficient ${index}, past the end of the block`,
        );
      }
      coefficients[ZIGZAG_TO_NATURAL[index] ?? 0] =
        extend(receive(size), size) * (quant[index] ?? 0);
      index += 1;
    }

    // Separable inverse DCT: horizontal frequencies first, then vertical.
    for (let v = 0; v < 8; v += 1) {
      for (let x = 0; x < 8; x += 1) {
        let sum = 0;
        for (let u = 0; u < 8; u += 1) {
          sum += (IDCT_BASIS[u * 8 + x] ?? 0) * (coefficients[v * 8 + u] ?? 0);
        }
        partial[v * 8 + x] = sum;
      }
    }
    const originX = blockColumn * 8;
    const originY = blockRow * 8;
    for (let y = 0; y < 8; y += 1) {
      const row = (originY + y) * plane.stride + originX;
      for (let x = 0; x < 8; x += 1) {
        let sum = 0;
        for (let v = 0; v < 8; v += 1) {
          sum += (IDCT_BASIS[v * 8 + y] ?? 0) * (partial[v * 8 + x] ?? 0);
        }
        const level = Math.round(sum) + 128; // level shift back from the signed domain
        plane.samples[row + x] = level < 0 ? 0 : level > 255 ? 255 : level;
      }
    }
  };

  const first = targets[0];
  if (first === undefined) {
    throw new MediaDecodeError("bad_scan_component_count", "scan declares no components");
  }

  if (targets.length === 1) {
    // A single-component scan is non-interleaved: the MCU is one block and the
    // grid is the component's own, which is smaller than the MCU-padded plane.
    const plane = first.plane;
    const componentWidth = Math.ceil((frame.header.width * plane.h) / frame.hMax);
    const componentHeight = Math.ceil((frame.header.height * plane.v) / frame.vMax);
    const perLine = Math.ceil(componentWidth / 8);
    const perColumn = Math.ceil(componentHeight / 8);
    for (let block = 0; block < perLine * perColumn; block += 1) {
      if (restartInterval > 0 && block > 0 && block % restartInterval === 0) restart();
      decodeBlock(first, Math.floor(block / perLine), block % perLine);
    }
  } else {
    const total = frame.mcusPerLine * frame.mcusPerColumn;
    for (let mcu = 0; mcu < total; mcu += 1) {
      if (restartInterval > 0 && mcu > 0 && mcu % restartInterval === 0) restart();
      const mcuRow = Math.floor(mcu / frame.mcusPerLine);
      const mcuColumn = mcu % frame.mcusPerLine;
      for (const target of targets) {
        for (let v = 0; v < target.plane.v; v += 1) {
          for (let h = 0; h < target.plane.h; h += 1) {
            decodeBlock(target, mcuRow * target.plane.v + v, mcuColumn * target.plane.h + h);
          }
        }
      }
    }
  }

  // Skip any padding left between the last code and the terminating marker.
  while (position < bytes.length && bytes[position] !== 0xff) position += 1;
  if (position >= bytes.length) {
    throw new MediaDecodeError("truncated_entropy_data", "scan is not terminated by a marker");
  }
  return { cursor: position, decoded: targets.map((target) => target.component) };
};

// ---------------------------------------------------------------------------
// Table segments
// ---------------------------------------------------------------------------

const readQuantTables = (bytes: Uint8Array, payload: Segment, tables: Tables): void => {
  let offset = payload.start;
  while (offset < payload.end) {
    const spec = byteAt(bytes, offset);
    const precision = spec >> 4;
    const destination = spec & 0x0f;
    if (precision !== 0) {
      // 16-bit quantization values are only legal above 8-bit sample precision,
      // which this decoder already refuses.
      throw new MediaDecodeError(
        "unsupported_quant_precision",
        "16-bit quantization tables imply a precision this decoder refuses",
      );
    }
    if (destination > 3) {
      throw new MediaDecodeError(
        "bad_quant_destination",
        `quantization table destination ${destination} is outside 0..3`,
      );
    }
    if (offset + 65 > payload.end) {
      throw new MediaDecodeError("truncated_segment", "quantization table is cut short");
    }
    const table = new Uint16Array(64);
    for (let index = 0; index < 64; index += 1) {
      // Kept in zig-zag order: coefficients are dequantized as they are decoded,
      // and they arrive in that same order.
      table[index] = byteAt(bytes, offset + 1 + index);
    }
    tables.quant[destination] = table;
    offset += 65;
  }
};

const readHuffmanTables = (bytes: Uint8Array, payload: Segment, tables: Tables): void => {
  let offset = payload.start;
  while (offset < payload.end) {
    const spec = byteAt(bytes, offset);
    const tableClass = spec >> 4;
    const destination = spec & 0x0f;
    if (tableClass > 1) {
      throw new MediaDecodeError(
        "bad_huffman_class",
        `Huffman table class ${tableClass} is illegal`,
      );
    }
    if (destination > 3) {
      throw new MediaDecodeError(
        "bad_huffman_destination",
        `Huffman table destination ${destination} is outside 0..3`,
      );
    }
    if (offset + 17 > payload.end) {
      throw new MediaDecodeError("truncated_segment", "Huffman table code counts are cut short");
    }

    const counts: number[] = [0];
    let total = 0;
    for (let length = 1; length <= 16; length += 1) {
      const count = byteAt(bytes, offset + length);
      counts.push(count);
      total += count;
    }
    if (total > 256) {
      throw new MediaDecodeError("bad_huffman_table", `Huffman table declares ${total} values`);
    }
    if (offset + 17 + total > payload.end) {
      throw new MediaDecodeError("truncated_segment", "Huffman table values are cut short");
    }

    const values = bytes.subarray(offset + 17, offset + 17 + total);
    const table = buildHuffmanTable(counts, values);
    if (tableClass === 0) tables.dc[destination] = table;
    else tables.ac[destination] = table;
    offset += 17 + total;
  }
};

// ---------------------------------------------------------------------------
// Colour conversion and cropping
// ---------------------------------------------------------------------------

const clampByte = (value: number): number =>
  value < 0 ? 0 : value > 255 ? 255 : Math.round(value);

/**
 * Lifts one component plane to full frame resolution, cropping the MCU padding
 * away.
 *
 * Output pixel centres are mapped to source sample centres and interpolated
 * from the two neighbours on each axis — a triangle filter. That is what the
 * reference decoders (libjpeg's "fancy" upsampler, and therefore Pillow, GDK
 * and every browser) do, and at a factor of two it reduces exactly to their
 * 3/4-1/4 split; a decode that instead replicates pixels lands roughly 12 grey
 * levels of mean error away from them, which is a whole quantisation step of
 * disagreement to carry into a perceptual hash. Whole-number factors — the
 * luma plane, and every plane of a 4:4:4 frame — fall precisely on a source
 * sample, so they copy rather than blur.
 *
 * Edges clamp to the component's own coded extent, not to the padded plane:
 * the blocks beyond it exist only to complete an MCU and are not image data.
 */
const upsamplePlane = (plane: Plane, frame: Frame): Uint8Array => {
  const { width, height } = frame.header;
  const sourceWidth = Math.ceil((width * plane.h) / frame.hMax);
  const sourceHeight = Math.ceil((height * plane.v) / frame.vMax);
  const out = new Uint8Array(width * height);

  if (plane.h === frame.hMax && plane.v === frame.vMax) {
    for (let y = 0; y < height; y += 1) {
      out.set(plane.samples.subarray(y * plane.stride, y * plane.stride + width), y * width);
    }
    return out;
  }

  const scaleX = plane.h / frame.hMax;
  const scaleY = plane.v / frame.vMax;
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(Math.max((y + 0.5) * scaleY - 0.5, 0), sourceHeight - 1);
    const topRow = Math.floor(sourceY);
    const weightY = sourceY - topRow;
    const top = Math.min(topRow, sourceHeight - 1) * plane.stride;
    const bottom = Math.min(topRow + 1, sourceHeight - 1) * plane.stride;
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(Math.max((x + 0.5) * scaleX - 0.5, 0), sourceWidth - 1);
      const leftColumn = Math.floor(sourceX);
      const weightX = sourceX - leftColumn;
      const left = Math.min(leftColumn, sourceWidth - 1);
      const right = Math.min(leftColumn + 1, sourceWidth - 1);
      const topLeft = plane.samples[top + left] ?? 0;
      const topRight = plane.samples[top + right] ?? 0;
      const bottomLeft = plane.samples[bottom + left] ?? 0;
      const bottomRight = plane.samples[bottom + right] ?? 0;
      const upper = topLeft + (topRight - topLeft) * weightX;
      const lower = bottomLeft + (bottomRight - bottomLeft) * weightX;
      out[y * width + x] = Math.round(upper + (lower - upper) * weightY);
    }
  }
  return out;
};

/** Converts the upsampled planes to interleaved RGB. */
const toRgb = (frame: Frame): RasterImage => {
  const { width, height } = frame.header;
  const pixels = new Uint8Array(width * height * 3);

  const lumaPlane = frame.planes[0];
  if (lumaPlane === undefined) {
    throw new MediaDecodeError("missing_frame_header", "frame has no components");
  }
  const luma = upsamplePlane(lumaPlane, frame);

  if (frame.planes.length === 1) {
    for (let pixel = 0; pixel < width * height; pixel += 1) {
      const value = luma[pixel] ?? 0;
      const target = pixel * 3;
      pixels[target] = value;
      pixels[target + 1] = value;
      pixels[target + 2] = value;
    }
    return assertRasterConsistent({ width, height, pixels });
  }

  const bluePlane = frame.planes[1];
  const redPlane = frame.planes[2];
  if (bluePlane === undefined || redPlane === undefined) {
    throw new MediaDecodeError("missing_frame_header", "three-component frame is missing a plane");
  }
  const blue = upsamplePlane(bluePlane, frame);
  const red = upsamplePlane(redPlane, frame);

  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const sampleY = luma[pixel] ?? 0;
    const cb = (blue[pixel] ?? 0) - 128;
    const cr = (red[pixel] ?? 0) - 128;
    const target = pixel * 3;
    pixels[target] = clampByte(sampleY + 1.402 * cr);
    pixels[target + 1] = clampByte(sampleY - 0.344136 * cb - 0.714136 * cr);
    pixels[target + 2] = clampByte(sampleY + 1.772 * cb);
  }

  return assertRasterConsistent({ width, height, pixels });
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export const decodeJpeg = (bytes: Uint8Array): RasterImage => {
  let cursor = expectSoi(bytes);
  const tables: Tables = {
    quant: new Array<Uint16Array | undefined>(4).fill(undefined),
    dc: new Array<HuffmanTable | undefined>(4).fill(undefined),
    ac: new Array<HuffmanTable | undefined>(4).fill(undefined),
  };
  let restartInterval = 0;
  let frame: Frame | undefined;
  const decoded = new Set<number>();
  let scans = 0;
  let sawEoi = false;

  while (!sawEoi) {
    const marker = readMarker(bytes, cursor);

    if (marker.code === MARKER.EOI) {
      sawEoi = true;
      break;
    }
    if (marker.code === MARKER.TEM) {
      cursor = marker.next;
      continue;
    }
    if (isStandalone(marker.code)) {
      throw new MediaDecodeError(
        "unexpected_marker",
        `marker 0x${marker.code.toString(16)} appears outside entropy-coded data`,
      );
    }

    const payload = readSegment(bytes, marker);

    if (marker.code === MARKER.DQT) {
      readQuantTables(bytes, payload, tables);
      cursor = payload.end;
      continue;
    }
    if (marker.code === MARKER.DHT) {
      readHuffmanTables(bytes, payload, tables);
      cursor = payload.end;
      continue;
    }
    if (marker.code === MARKER.DRI) {
      if (payload.end - payload.start !== 2) {
        throw new MediaDecodeError("bad_segment_length", "DRI segment is not two bytes");
      }
      restartInterval = uint16At(bytes, payload.start);
      cursor = payload.end;
      continue;
    }
    if (marker.code === MARKER.SOS) {
      if (frame === undefined) {
        throw new MediaDecodeError("missing_frame_header", "scan begins before any frame header");
      }
      const scan = decodeScan(bytes, payload, frame, tables, restartInterval);
      for (const component of scan.decoded) decoded.add(component);
      scans += 1;
      cursor = scan.cursor;
      continue;
    }
    if (marker.code >= 0xc0 && marker.code <= 0xcf) {
      if (marker.code === 0xcc) {
        throw new MediaDecodeError(
          "arithmetic_coding_unsupported",
          "arithmetic conditioning table (DAC) implies arithmetic coding",
        );
      }
      const header = parseFrameHeader(bytes, marker.code, payload);
      if (header.progressive) {
        throw new MediaDecodeError(
          "progressive_unsupported",
          "progressive JPEG (SOF2) is not decodable by this pipeline",
        );
      }
      if (frame !== undefined) {
        throw new MediaDecodeError("duplicate_frame_header", "stream declares two frames");
      }
      frame = buildFrame(header);
      cursor = payload.end;
      continue;
    }
    if (isSkippable(marker.code)) {
      cursor = payload.end;
      continue;
    }

    throw new MediaDecodeError(
      "unexpected_marker",
      `marker 0x${marker.code.toString(16)} is not part of a baseline sequential JPEG`,
    );
  }

  if (frame === undefined) {
    throw new MediaDecodeError("missing_frame_header", "stream contains no start-of-frame marker");
  }
  if (scans === 0) {
    throw new MediaDecodeError("missing_scan", "stream contains no start-of-scan marker");
  }
  if (decoded.size !== frame.planes.length) {
    throw new MediaDecodeError(
      "incomplete_scan_coverage",
      `${decoded.size} of ${frame.planes.length} components were coded`,
    );
  }
  return toRgb(frame);
};
