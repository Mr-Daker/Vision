/**
 * Structural validation of recorded voice containers (roadmap V021).
 *
 * This does NOT decode audio. It answers three questions the pipeline needs
 * before a recording is allowed to cost anything: is this really the container
 * it claims to be, which codec is inside, and how long is it? Duration bounds
 * the transcription spend at V023/V024 and lets an absurd upload be refused
 * before it reaches a provider.
 *
 * The honest part is duration. A browser `MediaRecorder` WebM very often has no
 * Duration element at all, because the file is written while the recording is
 * still open. When that happens this reports `undefined` with a warning rather
 * than estimating from the byte length — a guessed duration would silently
 * become a cost projection and a "long recording" review flag.
 */

import { MediaDecodeError } from "./raster.ts";

export type AudioProbe = {
  readonly container: "ogg" | "webm";
  /** Codec identified from the container's own headers, when it states one. */
  readonly codec?: string;
  readonly channels?: number;
  readonly durationSeconds?: number;
  readonly warnings: readonly string[];
};

/** Longest recording the demonstration accepts (V005 §6 voice retention). */
export const MAX_AUDIO_SECONDS = 300;

// ---------------------------------------------------------------------------
// Ogg
// ---------------------------------------------------------------------------

/**
 * Ogg's CRC is not zlib's.
 *
 * It uses the same polynomial but no input/output reflection and no final XOR,
 * so `zlib.crc32` produces a different value and cannot be substituted. Getting
 * this wrong would reject every valid Ogg file.
 */
const OGG_CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index << 24;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 0x80000000) !== 0 ? ((value << 1) ^ 0x04c11db7) >>> 0 : (value << 1) >>> 0;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

const oggCrc = (page: Uint8Array): number => {
  let crc = 0;
  for (let index = 0; index < page.length; index += 1) {
    // Bytes 22-25 hold the checksum itself and are treated as zero.
    const byte = index >= 22 && index <= 25 ? 0 : (page[index] ?? 0);
    crc = ((crc << 8) >>> 0) ^ (OGG_CRC_TABLE[((crc >>> 24) ^ byte) & 0xff] ?? 0);
    crc = crc >>> 0;
  }
  return crc >>> 0;
};

const readU32Le = (bytes: Uint8Array, offset: number): number =>
  ((bytes[offset] ?? 0) |
    ((bytes[offset + 1] ?? 0) << 8) |
    ((bytes[offset + 2] ?? 0) << 16) |
    ((bytes[offset + 3] ?? 0) << 24)) >>>
  0;

/** Granule positions are 64-bit; a Number is exact well past any real duration. */
const readU64Le = (bytes: Uint8Array, offset: number): number => {
  let value = 0;
  for (let index = 7; index >= 0; index -= 1) {
    value = value * 256 + (bytes[offset + index] ?? 0);
  }
  return value;
};

type OggPage = {
  readonly headerType: number;
  readonly granulePosition: number;
  readonly payload: Uint8Array;
  readonly totalLength: number;
};

const readOggPage = (bytes: Uint8Array, offset: number): OggPage => {
  if (offset + 27 > bytes.length) {
    throw new MediaDecodeError("ogg_truncated", "page header runs past the end of the file");
  }
  if (
    bytes[offset] !== 0x4f ||
    bytes[offset + 1] !== 0x67 ||
    bytes[offset + 2] !== 0x67 ||
    bytes[offset + 3] !== 0x53
  ) {
    throw new MediaDecodeError("ogg_no_capture_pattern", "expected an OggS page here");
  }
  if (bytes[offset + 4] !== 0) {
    throw new MediaDecodeError("ogg_version", `unsupported Ogg version ${bytes[offset + 4]}`);
  }

  const headerType = bytes[offset + 5] ?? 0;
  const granulePosition = readU64Le(bytes, offset + 6);
  const segmentCount = bytes[offset + 26] ?? 0;
  const tableEnd = offset + 27 + segmentCount;
  if (tableEnd > bytes.length) {
    throw new MediaDecodeError("ogg_truncated", "segment table runs past the end of the file");
  }

  let payloadLength = 0;
  for (let index = 0; index < segmentCount; index += 1) {
    payloadLength += bytes[offset + 27 + index] ?? 0;
  }
  const payloadEnd = tableEnd + payloadLength;
  if (payloadEnd > bytes.length) {
    throw new MediaDecodeError("ogg_truncated", "page payload runs past the end of the file");
  }

  const totalLength = payloadEnd - offset;
  const declaredCrc = readU32Le(bytes, offset + 22);
  const computedCrc = oggCrc(bytes.subarray(offset, payloadEnd));
  if (declaredCrc !== computedCrc) {
    throw new MediaDecodeError("ogg_bad_crc", "Ogg page failed its checksum");
  }

  return {
    headerType,
    granulePosition,
    payload: bytes.subarray(tableEnd, payloadEnd),
    totalLength,
  };
};

const probeOgg = (bytes: Uint8Array): AudioProbe => {
  const warnings: string[] = [];
  const first = readOggPage(bytes, 0);
  // 0x02 is the beginning-of-stream flag; without it this is a fragment.
  if ((first.headerType & 0x02) === 0) {
    throw new MediaDecodeError("ogg_not_bos", "first page is not marked beginning-of-stream");
  }

  const header = first.payload;
  const magic = String.fromCharCode(...header.subarray(0, 8));
  let codec: string | undefined;
  let channels: number | undefined;
  let granuleRate: number | undefined;

  if (magic === "OpusHead") {
    codec = "opus";
    channels = header[9];
    // Opus granule positions are always at 48 kHz regardless of input rate.
    granuleRate = 48000;
  } else if (magic.startsWith("vorb")) {
    codec = "vorbis";
    channels = header[11];
    granuleRate = readU32Le(header, 12);
  } else {
    throw new MediaDecodeError(
      "ogg_unsupported_codec",
      "first packet is neither OpusHead nor a Vorbis identification header",
    );
  }

  // The final page's granule position is the stream length in codec samples.
  let offset = 0;
  let lastGranule = 0;
  let sawEos = false;
  while (offset < bytes.length) {
    const page = readOggPage(bytes, offset);
    lastGranule = page.granulePosition;
    if ((page.headerType & 0x04) !== 0) sawEos = true;
    offset += page.totalLength;
  }
  if (!sawEos) warnings.push("stream has no end-of-stream page, so its duration may be incomplete");

  const durationSeconds =
    granuleRate !== undefined && granuleRate > 0 && lastGranule > 0
      ? lastGranule / granuleRate
      : undefined;
  if (durationSeconds === undefined) {
    warnings.push("container recorded no usable granule position, so duration is unknown");
  }

  return {
    container: "ogg",
    ...(codec === undefined ? {} : { codec }),
    ...(channels === undefined || channels === 0 ? {} : { channels }),
    ...(durationSeconds === undefined ? {} : { durationSeconds }),
    warnings,
  };
};

// ---------------------------------------------------------------------------
// WebM / Matroska (EBML)
// ---------------------------------------------------------------------------

const EBML_HEADER = 0x1a45dfa3;
const ID_DOC_TYPE = 0x4282;
const ID_SEGMENT = 0x18538067;
const ID_INFO = 0x1549a966;
const ID_TIMECODE_SCALE = 0x2ad7b1;
const ID_DURATION = 0x4489;

type EbmlElement = {
  readonly id: number;
  readonly contentStart: number;
  readonly contentLength: number;
  readonly end: number;
};

/**
 * Reads an EBML variable-length integer.
 *
 * The leading zero bits give the width; the marker bit is then cleared. For a
 * size field, an all-ones value means "unknown length", which live-recorded
 * WebM uses for its Segment — so that case is reported rather than treated as
 * a corrupt file.
 */
const readVint = (
  bytes: Uint8Array,
  offset: number,
  keepMarker: boolean,
): { readonly value: number; readonly width: number; readonly unknown: boolean } => {
  const first = bytes[offset];
  if (first === undefined || first === 0) {
    throw new MediaDecodeError("ebml_bad_vint", `invalid variable-length integer at ${offset}`);
  }
  let width = 1;
  while (width <= 8 && (first & (0x80 >> (width - 1))) === 0) width += 1;
  if (width > 8 || offset + width > bytes.length) {
    throw new MediaDecodeError("ebml_bad_vint", `variable-length integer at ${offset} is too wide`);
  }

  let value = keepMarker ? first : first & (0xff >> width);
  let allOnes = (first & (0xff >> width)) === 0xff >> width;
  for (let index = 1; index < width; index += 1) {
    const byte = bytes[offset + index] ?? 0;
    value = value * 256 + byte;
    if (byte !== 0xff) allOnes = false;
  }
  return { value, width, unknown: !keepMarker && allOnes };
};

const readElement = (bytes: Uint8Array, offset: number): EbmlElement => {
  const id = readVint(bytes, offset, true);
  const size = readVint(bytes, offset + id.width, false);
  const contentStart = offset + id.width + size.width;
  // An unknown-length element runs to the end of what we have.
  const contentLength = size.unknown ? bytes.length - contentStart : size.value;
  if (contentStart + contentLength > bytes.length) {
    throw new MediaDecodeError("ebml_truncated", `element ${id.value.toString(16)} is truncated`);
  }
  return { id: id.value, contentStart, contentLength, end: contentStart + contentLength };
};

const findChild = (
  bytes: Uint8Array,
  parent: EbmlElement,
  wanted: number,
): EbmlElement | undefined => {
  let offset = parent.contentStart;
  while (offset < parent.end) {
    const child = readElement(bytes, offset);
    if (child.id === wanted) return child;
    if (child.end <= offset) break;
    offset = child.end;
  }
  return undefined;
};

const readFloat = (bytes: Uint8Array, element: EbmlElement): number | undefined => {
  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset + element.contentStart,
    element.contentLength,
  );
  if (element.contentLength === 4) return view.getFloat32(0, false);
  if (element.contentLength === 8) return view.getFloat64(0, false);
  return undefined;
};

const readUnsigned = (bytes: Uint8Array, element: EbmlElement): number => {
  let value = 0;
  for (let index = 0; index < element.contentLength; index += 1) {
    value = value * 256 + (bytes[element.contentStart + index] ?? 0);
  }
  return value;
};

const probeWebm = (bytes: Uint8Array): AudioProbe => {
  const warnings: string[] = [];
  // The magic bytes are checked before any element parsing: arbitrary bytes can
  // parse as a plausible-looking vint and fail as "truncated", which would
  // report a corrupt WebM when the real problem is that this is not one.
  if (bytes[0] !== 0x1a || bytes[1] !== 0x45 || bytes[2] !== 0xdf || bytes[3] !== 0xa3) {
    throw new MediaDecodeError("webm_no_ebml", "file does not begin with an EBML header");
  }
  const header = readElement(bytes, 0);
  if (header.id !== EBML_HEADER) {
    throw new MediaDecodeError("webm_no_ebml", "file does not begin with an EBML header");
  }

  const docTypeElement = findChild(bytes, header, ID_DOC_TYPE);
  const docType =
    docTypeElement === undefined
      ? undefined
      : String.fromCharCode(
          ...bytes.subarray(docTypeElement.contentStart, docTypeElement.end),
        ).replace(/\0+$/, "");
  if (docType !== "webm" && docType !== "matroska") {
    throw new MediaDecodeError("webm_doctype", `unsupported EBML DocType ${docType ?? "(absent)"}`);
  }

  let durationSeconds: number | undefined;
  if (header.end < bytes.length) {
    const segment = readElement(bytes, header.end);
    if (segment.id === ID_SEGMENT) {
      const info = findChild(bytes, segment, ID_INFO);
      if (info !== undefined) {
        const scaleElement = findChild(bytes, info, ID_TIMECODE_SCALE);
        const durationElement = findChild(bytes, info, ID_DURATION);
        // TimecodeScale is nanoseconds per tick; its default is 1 ms.
        const scale = scaleElement === undefined ? 1_000_000 : readUnsigned(bytes, scaleElement);
        const ticks = durationElement === undefined ? undefined : readFloat(bytes, durationElement);
        if (ticks !== undefined && scale > 0) durationSeconds = (ticks * scale) / 1_000_000_000;
      }
    }
  }

  if (durationSeconds === undefined) {
    // Routine for MediaRecorder output, so this is a note and not a rejection.
    warnings.push("container states no duration, which is normal for a browser recording");
  }

  return {
    container: "webm",
    codec: docType === "webm" ? "webm-audio" : "matroska-audio",
    ...(durationSeconds === undefined ? {} : { durationSeconds }),
    warnings,
  };
};

/**
 * Confirms the bytes really are the declared container and reports what the
 * container itself states. Throws rather than guessing on anything malformed.
 */
export const probeAudio = (bytes: Uint8Array, declaredContentType: string): AudioProbe => {
  const probe =
    declaredContentType === "audio/ogg"
      ? probeOgg(bytes)
      : declaredContentType === "audio/webm"
        ? probeWebm(bytes)
        : undefined;
  if (probe === undefined) {
    throw new MediaDecodeError(
      "audio_unsupported_type",
      `${declaredContentType} is not an accepted audio type`,
    );
  }
  if (probe.durationSeconds !== undefined && probe.durationSeconds > MAX_AUDIO_SECONDS) {
    throw new MediaDecodeError(
      "audio_too_long",
      `recording is ${Math.round(probe.durationSeconds)}s; the ceiling is ${MAX_AUDIO_SECONDS}s`,
    );
  }
  return probe;
};
