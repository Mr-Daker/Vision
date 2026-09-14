/**
 * Capture-metadata extraction from JPEG EXIF (roadmap V021).
 *
 * Two deliberate design rules, both of them honesty rules rather than parsing
 * decisions:
 *
 * 1. **Malformed EXIF is advisory, never fatal.** A corrupt metadata block does
 *    not make the photograph unusable, so every failure here degrades to a
 *    warning and absent fields. Only malformed *image* data quarantines an
 *    upload. Treating unreadable metadata as evidence of tampering is exactly
 *    what [V002](../../../docs/foundation/V002-capability-evidence-matrix.md)
 *    prohibition 2 forbids.
 *
 * 2. **An EXIF timestamp has no UTC offset.** `DateTimeOriginal` is local wall
 *    time with no zone, so this parser never invents one. It reports the local
 *    string and, separately, whether an explicit offset was recorded — the
 *    workspace's `parseIsoTimestamp` requires a real offset, and manufacturing
 *    "Z" here would launder a guess into an authoritative-looking field.
 *
 * Nothing here claims a photograph is authentic. A capture timestamp being
 * present is a fact about the file; its absence is not a finding (V002 row 9).
 */

import type { RasterImage } from "./raster.ts";

export type CaptureMetadata = {
  /** EXIF `DateTimeOriginal` as recorded: local wall time, no zone. */
  readonly capturedAtLocal?: string;
  /** Full RFC 3339 value, present only when EXIF recorded an explicit offset. */
  readonly capturedAt?: string;
  readonly captureOffsetKnown: boolean;
  /** EXIF orientation 1-8, if recorded. */
  readonly orientation?: number;
  readonly make?: string;
  readonly model?: string;
  readonly gpsPresent: boolean;
  readonly gpsLatitude?: number;
  readonly gpsLongitude?: number;
  /** Why a field is missing or was ignored. Never a fraud signal. */
  readonly warnings: readonly string[];
};

export const EMPTY_CAPTURE_METADATA: CaptureMetadata = {
  captureOffsetKnown: false,
  gpsPresent: false,
  warnings: [],
};

const TAG_MAKE = 0x010f;
const TAG_MODEL = 0x0110;
const TAG_ORIENTATION = 0x0112;
const TAG_EXIF_IFD = 0x8769;
const TAG_GPS_IFD = 0x8825;
const TAG_DATE_TIME_ORIGINAL = 0x9003;
const TAG_OFFSET_TIME_ORIGINAL = 0x9011;
const TAG_GPS_LATITUDE_REF = 0x0001;
const TAG_GPS_LATITUDE = 0x0002;
const TAG_GPS_LONGITUDE_REF = 0x0003;
const TAG_GPS_LONGITUDE = 0x0004;

/** Byte width of each TIFF field type; 0 marks a type we do not read. */
const TYPE_SIZE: Readonly<Record<number, number>> = {
  1: 1, // BYTE
  2: 1, // ASCII
  3: 2, // SHORT
  4: 4, // LONG
  5: 8, // RATIONAL
  7: 1, // UNDEFINED
  9: 4, // SLONG
  10: 8, // SRATIONAL
};

/** A hostile or corrupt IFD must not be able to make us allocate or loop. */
const MAX_IFD_ENTRIES = 512;
const MAX_STRING_BYTES = 256;

type Reader = {
  readonly bytes: Uint8Array;
  /** Offset of the TIFF header; all IFD offsets are relative to it. */
  readonly base: number;
  readonly littleEndian: boolean;
};

const u16 = (reader: Reader, offset: number): number => {
  const a = reader.bytes[offset] ?? 0;
  const b = reader.bytes[offset + 1] ?? 0;
  return reader.littleEndian ? a | (b << 8) : (a << 8) | b;
};

const u32 = (reader: Reader, offset: number): number => {
  const a = reader.bytes[offset] ?? 0;
  const b = reader.bytes[offset + 1] ?? 0;
  const c = reader.bytes[offset + 2] ?? 0;
  const d = reader.bytes[offset + 3] ?? 0;
  return reader.littleEndian
    ? (a | (b << 8) | (c << 16) | (d << 24)) >>> 0
    : ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
};

type Entry = {
  readonly tag: number;
  readonly type: number;
  readonly count: number;
  /** Absolute offset of the value bytes. */
  readonly valueOffset: number;
};

const readEntries = (reader: Reader, ifdOffset: number): readonly Entry[] => {
  const start = reader.base + ifdOffset;
  if (start + 2 > reader.bytes.length) return [];
  const declared = u16(reader, start);
  const count = Math.min(declared, MAX_IFD_ENTRIES);
  const entries: Entry[] = [];

  for (let index = 0; index < count; index += 1) {
    const at = start + 2 + index * 12;
    if (at + 12 > reader.bytes.length) break;
    const tag = u16(reader, at);
    const type = u16(reader, at + 2);
    const valueCount = u32(reader, at + 4);
    const size = TYPE_SIZE[type] ?? 0;
    if (size === 0 || valueCount === 0) continue;

    const totalBytes = size * valueCount;
    // Values of four bytes or fewer sit inline in the entry itself.
    const valueOffset = totalBytes <= 4 ? at + 8 : reader.base + u32(reader, at + 8);
    if (valueOffset < 0 || valueOffset + totalBytes > reader.bytes.length) continue;

    entries.push({ tag, type, count: valueCount, valueOffset });
  }
  return entries;
};

const asAscii = (reader: Reader, entry: Entry): string | undefined => {
  if (entry.type !== 2 && entry.type !== 7) return undefined;
  const length = Math.min(entry.count, MAX_STRING_BYTES);
  let text = "";
  for (let index = 0; index < length; index += 1) {
    const code = reader.bytes[entry.valueOffset + index] ?? 0;
    if (code === 0) break;
    // EXIF ASCII should be printable; anything else is dropped rather than
    // carried into a record that may be displayed.
    if (code < 0x20 || code > 0x7e) return undefined;
    text += String.fromCharCode(code);
  }
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const asInteger = (reader: Reader, entry: Entry): number | undefined => {
  if (entry.type === 3) return u16(reader, entry.valueOffset);
  if (entry.type === 4 || entry.type === 9) return u32(reader, entry.valueOffset);
  if (entry.type === 1) return reader.bytes[entry.valueOffset] ?? undefined;
  return undefined;
};

/** Reads `count` RATIONALs, returning undefined if any denominator is zero. */
const asRationals = (
  reader: Reader,
  entry: Entry,
  count: number,
): readonly number[] | undefined => {
  if (entry.type !== 5 && entry.type !== 10) return undefined;
  if (entry.count < count) return undefined;
  const values: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const numerator = u32(reader, entry.valueOffset + index * 8);
    const denominator = u32(reader, entry.valueOffset + index * 8 + 4);
    if (denominator === 0) return undefined;
    values.push(numerator / denominator);
  }
  return values;
};

const byTag = (entries: readonly Entry[]): Map<number, Entry> => {
  const map = new Map<number, Entry>();
  for (const entry of entries) {
    // First occurrence wins: a duplicated tag is malformed, and preferring the
    // later one would let trailing bytes override a well-formed value.
    if (!map.has(entry.tag)) map.set(entry.tag, entry);
  }
  return map;
};

/** `2026:09:09 14:30:05` is EXIF's format; anything else is not trusted. */
const parseExifDateTime = (value: string): string | undefined => {
  const match = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (match === null) return undefined;
  const [, year, month, day, hour, minute, second] = match;
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  if (monthNumber < 1 || monthNumber > 12 || dayNumber < 1 || dayNumber > 31) return undefined;
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return undefined;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}`;
};

/** `+05:30`, `-08:00` or `Z`. EXIF writes the first two forms. */
const parseExifOffset = (value: string): string | undefined =>
  /^([+-]\d{2}:\d{2}|Z)$/.test(value) ? value : undefined;

const signedDegrees = (
  components: readonly number[],
  reference: string | undefined,
  negative: string,
): number | undefined => {
  const [degrees = 0, minutes = 0, seconds = 0] = components;
  const magnitude = degrees + minutes / 60 + seconds / 3600;
  if (!Number.isFinite(magnitude) || magnitude > 180) return undefined;
  if (reference === undefined) return undefined;
  return reference.toUpperCase() === negative ? -magnitude : magnitude;
};

/** Locates the `Exif\0\0` APP1 payload, or undefined when there is none. */
const findExifSegment = (bytes: Uint8Array): number | undefined => {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1] ?? 0;
    // Start of scan or end of image: no metadata beyond this point.
    if (marker === 0xda || marker === 0xd9) return undefined;
    // Standalone markers carry no length field.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0);
    if (length < 2 || offset + 2 + length > bytes.length) return undefined;
    if (marker === 0xe1 && length >= 8) {
      const header = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
      if (header === "Exif") return offset + 10;
    }
    offset += 2 + length;
  }
  return undefined;
};

export const readJpegExif = (bytes: Uint8Array): CaptureMetadata => {
  const base = findExifSegment(bytes);
  if (base === undefined) {
    return { ...EMPTY_CAPTURE_METADATA, warnings: ["no EXIF metadata present"] };
  }

  const byteOrder = String.fromCharCode(...bytes.subarray(base, base + 2));
  if (byteOrder !== "II" && byteOrder !== "MM") {
    return { ...EMPTY_CAPTURE_METADATA, warnings: ["EXIF byte order is not II or MM"] };
  }
  const reader: Reader = { bytes, base, littleEndian: byteOrder === "II" };
  if (u16(reader, base + 2) !== 0x2a) {
    return { ...EMPTY_CAPTURE_METADATA, warnings: ["EXIF TIFF magic number is wrong"] };
  }

  const warnings: string[] = [];
  const ifd0Offset = u32(reader, base + 4);
  const ifd0 = byTag(readEntries(reader, ifd0Offset));

  const orientationValue = ((): number | undefined => {
    const entry = ifd0.get(TAG_ORIENTATION);
    if (entry === undefined) return undefined;
    const value = asInteger(reader, entry);
    if (value === undefined || value < 1 || value > 8) {
      warnings.push("EXIF orientation is out of range and was ignored");
      return undefined;
    }
    return value;
  })();

  const exifPointer = ifd0.get(TAG_EXIF_IFD);
  const exifOffset = exifPointer === undefined ? undefined : asInteger(reader, exifPointer);
  // A sub-IFD pointing at itself or at IFD0 would otherwise loop.
  const exifIfd =
    exifOffset === undefined || exifOffset === ifd0Offset
      ? new Map<number, Entry>()
      : byTag(readEntries(reader, exifOffset));

  const localTime = ((): string | undefined => {
    const entry = exifIfd.get(TAG_DATE_TIME_ORIGINAL);
    if (entry === undefined) return undefined;
    const raw = asAscii(reader, entry);
    if (raw === undefined) return undefined;
    const parsed = parseExifDateTime(raw);
    if (parsed === undefined) {
      warnings.push("EXIF DateTimeOriginal is not a valid EXIF date-time and was ignored");
      return undefined;
    }
    return parsed;
  })();

  const offsetEntry = exifIfd.get(TAG_OFFSET_TIME_ORIGINAL);
  const offset =
    offsetEntry === undefined ? undefined : parseExifOffset(asAscii(reader, offsetEntry) ?? "");
  if (localTime !== undefined && offset === undefined) {
    warnings.push("EXIF recorded no UTC offset, so the capture time is local wall time only");
  }

  const gpsPointer = ifd0.get(TAG_GPS_IFD);
  const gpsOffset = gpsPointer === undefined ? undefined : asInteger(reader, gpsPointer);
  const gpsIfd =
    gpsOffset === undefined || gpsOffset === ifd0Offset
      ? new Map<number, Entry>()
      : byTag(readEntries(reader, gpsOffset));

  const latitudeEntry = gpsIfd.get(TAG_GPS_LATITUDE);
  const longitudeEntry = gpsIfd.get(TAG_GPS_LONGITUDE);
  const latitudeRefEntry = gpsIfd.get(TAG_GPS_LATITUDE_REF);
  const longitudeRefEntry = gpsIfd.get(TAG_GPS_LONGITUDE_REF);

  const latitude =
    latitudeEntry === undefined
      ? undefined
      : signedDegrees(
          asRationals(reader, latitudeEntry, 3) ?? [],
          latitudeRefEntry === undefined ? undefined : asAscii(reader, latitudeRefEntry),
          "S",
        );
  const longitude =
    longitudeEntry === undefined
      ? undefined
      : signedDegrees(
          asRationals(reader, longitudeEntry, 3) ?? [],
          longitudeRefEntry === undefined ? undefined : asAscii(reader, longitudeRefEntry),
          "W",
        );

  const makeEntry = ifd0.get(TAG_MAKE);
  const modelEntry = ifd0.get(TAG_MODEL);
  const make = makeEntry === undefined ? undefined : asAscii(reader, makeEntry);
  const model = modelEntry === undefined ? undefined : asAscii(reader, modelEntry);

  return {
    ...(localTime === undefined ? {} : { capturedAtLocal: localTime }),
    ...(localTime !== undefined && offset !== undefined
      ? { capturedAt: `${localTime}${offset}` }
      : {}),
    captureOffsetKnown: localTime !== undefined && offset !== undefined,
    ...(orientationValue === undefined ? {} : { orientation: orientationValue }),
    ...(make === undefined ? {} : { make }),
    ...(model === undefined ? {} : { model }),
    gpsPresent: latitude !== undefined && longitude !== undefined,
    ...(latitude === undefined ? {} : { gpsLatitude: latitude }),
    ...(longitude === undefined ? {} : { gpsLongitude: longitude }),
    warnings,
  };
};

/**
 * Whether EXIF orientation implies the stored raster is rotated relative to how
 * it should be displayed. Values 5-8 involve a 90° turn, so width and height
 * swap; 2-4 are flips only.
 *
 * The pipeline records this rather than acting on it: rotating an evidence
 * original would change the bytes a fingerprint is computed over.
 */
export const orientationSwapsAxes = (orientation: number | undefined): boolean =>
  orientation !== undefined && orientation >= 5 && orientation <= 8;

/** Display dimensions after applying EXIF orientation, without moving pixels. */
export const orientedDimensions = (
  image: RasterImage,
  orientation: number | undefined,
): { readonly width: number; readonly height: number } =>
  orientationSwapsAxes(orientation)
    ? { width: image.height, height: image.width }
    : { width: image.width, height: image.height };
