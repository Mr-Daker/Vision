/**
 * Media decoding, normalisation and fingerprinting (roadmap V021).
 *
 * Leaf package: it imports no other workspace package and no runtime
 * dependency, so the decoders can be reasoned about on their own and reused by
 * the worker without dragging persistence or HTTP along.
 *
 * Everything here is deterministic and byte-exact. Nothing in this package
 * talks to a network, a database, or a clock.
 */

export {
  type RasterImage,
  MediaDecodeError,
  assertRasterConsistent,
  toLuma,
  resampleBox,
  fitWithin,
} from "./raster.ts";

export { type PngHeader, readPngHeader, decodePng, encodeRgbPng } from "./png.ts";

export { type JpegHeader, readJpegHeader, decodeJpeg } from "./jpeg.ts";

export {
  type CaptureMetadata,
  EMPTY_CAPTURE_METADATA,
  readJpegExif,
  orientationSwapsAxes,
  orientedDimensions,
} from "./exif.ts";

export {
  PHASH_HEX_LENGTH,
  PERCEPTUAL_NEAR_DUPLICATE_MAX_DISTANCE,
  perceptualHash,
  hammingDistanceHex,
  looksLikeNearDuplicate,
} from "./phash.ts";

export { type AudioProbe, MAX_AUDIO_SECONDS, probeAudio } from "./audio.ts";

export { type PixelRegion, REDACTION_FILL, applyRegionRedaction } from "./redact-regions.ts";
