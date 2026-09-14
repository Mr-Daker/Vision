/**
 * Media pipeline: uploaded bytes to traceable evidence (roadmap V021).
 *
 * Pure on purpose. No database, no object store, no clock and no network, so
 * every decision below is a function of the bytes and the configured detector
 * and can be tested over real fixtures. The IO shell that reads a private
 * original and persists the result lives in `media-processing.ts`.
 *
 * The obligations are mostly negative, and that is the point:
 *  - bytes that disagree with their declared type are quarantined, not decoded;
 *  - malformed media never yields a derivative;
 *  - an unresolved redaction decision never yields a derivative either, so it
 *    cannot reach a public view or the normal AI path (V005 §§4-7);
 *  - a derivative is re-encoded from pixels, so no metadata from the original
 *    can travel with it.
 */

import { createHash } from "node:crypto";

import {
  EMPTY_CAPTURE_METADATA,
  MediaDecodeError,
  applyRegionRedaction,
  decodeJpeg,
  decodePng,
  encodeRgbPng,
  fitWithin,
  perceptualHash,
  readJpegExif,
  resampleBox,
  type CaptureMetadata,
  type RasterImage,
} from "@vision/media";

import { decidePhotoRedaction, type RedactionRegion } from "@vision/domain";

/** Bumped whenever a decision in this file changes, so a stored result says which rules produced it. */
export const MEDIA_PIPELINE_VERSION = "media.v1";

/** Longest edge of the generated thumbnail, unless a caller overrides it. */
export const DEFAULT_THUMBNAIL_MAX_EDGE = 320;

export type PhotoDetector = {
  /** Detector identity, recorded as provenance. A label naming a simulation is never treated as evidence-grade. */
  readonly label: string;
  detect(image: RasterImage): readonly RedactionRegion[];
};

export type ProcessPhotoInput = {
  readonly declaredContentType: string;
  readonly bytes: Uint8Array;
  readonly detector?: PhotoDetector;
  readonly thumbnailMaxEdge?: number;
};

export type DerivativeImage = {
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
};

export type ProcessPhotoRefusal = {
  readonly ok: false;
  readonly processingStatus: "quarantined" | "rejected";
  readonly reasonCode: string;
  readonly reasons: readonly string[];
  /** Recorded even for a refusal: the same bytes must be recognisable if they are re-uploaded. */
  readonly fingerprintHash: string;
  readonly pipelineVersion: string;
};

export type ProcessPhotoSuccess = {
  readonly ok: true;
  readonly processingStatus: "usable" | "needs_review";
  readonly redactionStatus: "approved" | "not_required" | "needs_review";
  readonly fingerprintHash: string;
  readonly perceptualHash: string;
  readonly captureMetadata: CaptureMetadata;
  readonly width: number;
  readonly height: number;
  readonly redactedRegions: readonly RedactionRegion[];
  readonly detectorLabel: string | undefined;
  /** Present only when the redaction decision is resolved. */
  readonly derivative: DerivativeImage | undefined;
  readonly thumbnail: DerivativeImage | undefined;
  readonly mayEnterPublicView: boolean;
  readonly mayEnterAiPath: boolean;
  readonly reasons: readonly string[];
  readonly pipelineVersion: string;
};

export type ProcessPhotoResult = ProcessPhotoRefusal | ProcessPhotoSuccess;

const sha256Hex = (bytes: Uint8Array): string =>
  createHash("sha256").update(Buffer.from(bytes)).digest("hex");

/** Magic bytes, so the *actual* format decides — never the client's claim. */
const sniff = (bytes: Uint8Array): "image/jpeg" | "image/png" | undefined => {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= 8 && PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) {
    return "image/png";
  }
  return undefined;
};

const SUPPORTED = new Set(["image/jpeg", "image/png"]);

export const processPhotoBytes = (input: ProcessPhotoInput): ProcessPhotoResult => {
  const fingerprintHash = sha256Hex(input.bytes);
  const refuse = (
    processingStatus: "quarantined" | "rejected",
    reasonCode: string,
    reason: string,
  ): ProcessPhotoRefusal => ({
    ok: false,
    processingStatus,
    reasonCode,
    reasons: [reason],
    fingerprintHash,
    pipelineVersion: MEDIA_PIPELINE_VERSION,
  });

  if (!SUPPORTED.has(input.declaredContentType)) {
    return refuse(
      "rejected",
      "unsupported_media_type",
      `declared content type '${input.declaredContentType}' is not an accepted photograph format`,
    );
  }

  const actual = sniff(input.bytes);
  if (actual === undefined) {
    return refuse(
      "quarantined",
      "unrecognised_format",
      "the bytes do not begin with a JPEG or PNG signature",
    );
  }
  if (actual !== input.declaredContentType) {
    // Not merely a mislabelled upload: bytes disagreeing with their declared
    // type is how a decoder gets fed something it did not expect.
    return refuse(
      "quarantined",
      "format_mismatch",
      `declared '${input.declaredContentType}' but the bytes are '${actual}'`,
    );
  }

  let image: RasterImage;
  let captureMetadata: CaptureMetadata;
  try {
    const buffer = Buffer.from(input.bytes);
    image = actual === "image/jpeg" ? decodeJpeg(buffer) : decodePng(buffer);
    captureMetadata = actual === "image/jpeg" ? readJpegExif(buffer) : EMPTY_CAPTURE_METADATA;
  } catch (error) {
    if (error instanceof MediaDecodeError) {
      return refuse("quarantined", `decode_failed:${error.reasonCode}`, error.message);
    }
    throw error;
  }

  const detector = input.detector;
  const regions = detector?.detect(image);
  const decision = decidePhotoRedaction({
    regions,
    detectorLabel: detector?.label,
  });

  // A derivative exists only when the redaction decision is resolved. This is
  // the same rule the database enforces with
  // `evidence_item_derivative_needs_approval_ck`; keeping it here too means an
  // unresolved item never even produces bytes that could be published.
  let derivative: DerivativeImage | undefined;
  let thumbnail: DerivativeImage | undefined;
  if (decision.mayEnterPublicView) {
    const covered = applyRegionRedaction(image, decision.regions);
    // Re-encoded from pixels, so EXIF, colour profiles and text chunks from
    // the original cannot survive into anything publishable.
    derivative = {
      bytes: encodeRgbPng(covered),
      width: covered.width,
      height: covered.height,
    };

    const maxEdge = input.thumbnailMaxEdge ?? DEFAULT_THUMBNAIL_MAX_EDGE;
    const target = fitWithin(covered.width, covered.height, maxEdge);
    const small = resampleBox(covered, target.width, target.height);
    thumbnail = { bytes: encodeRgbPng(small), width: small.width, height: small.height };
  }

  return {
    ok: true,
    // `needs_review` is about the redaction decision, not about the photograph
    // being suspicious. Missing metadata is never a fraud signal (V025).
    processingStatus: decision.status === "needs_review" ? "needs_review" : "usable",
    redactionStatus: decision.status,
    fingerprintHash,
    perceptualHash: perceptualHash(image),
    captureMetadata,
    width: image.width,
    height: image.height,
    redactedRegions: decision.regions,
    detectorLabel: detector?.label,
    derivative,
    thumbnail,
    mayEnterPublicView: decision.mayEnterPublicView,
    mayEnterAiPath: decision.mayEnterAiPath,
    reasons: decision.reasons,
    pipelineVersion: MEDIA_PIPELINE_VERSION,
  };
};
