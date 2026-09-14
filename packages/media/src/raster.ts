/**
 * The one in-memory image representation every decoder produces (roadmap V021).
 *
 * Deliberately three channels. Alpha is dropped at decode rather than carried
 * through the pipeline: evidence photographs have no meaningful transparency,
 * a flattened image cannot smuggle content in an unviewed alpha channel, and
 * every derivative this package emits is opaque anyway. `hadAlpha` preserves
 * the fact for provenance without keeping the bytes.
 */

export type RasterImage = {
  readonly width: number;
  readonly height: number;
  /** Interleaved 8-bit RGB. Length is exactly `width * height * 3`. */
  readonly pixels: Uint8Array;
};

/**
 * Refusal to decode. Every failure in this package raises one of these rather
 * than returning a partial image: V021 requires malformed media to fail closed,
 * and a half-decoded raster is indistinguishable from a valid one downstream.
 */
export class MediaDecodeError extends Error {
  readonly reasonCode: string;

  constructor(reasonCode: string, message: string) {
    super(message);
    this.name = "MediaDecodeError";
    this.reasonCode = reasonCode;
  }
}

/** Guards against a decoder that produced a buffer inconsistent with its header. */
export const assertRasterConsistent = (image: RasterImage): RasterImage => {
  const expected = image.width * image.height * 3;
  if (image.width <= 0 || image.height <= 0) {
    throw new MediaDecodeError(
      "empty_raster",
      `raster has no area: ${image.width}x${image.height}`,
    );
  }
  if (image.pixels.length !== expected) {
    throw new MediaDecodeError(
      "raster_length_mismatch",
      `raster is ${image.pixels.length} bytes; ${image.width}x${image.height} RGB needs ${expected}`,
    );
  }
  return image;
};

/** ITU-R BT.601 luma, the same coefficients the JPEG colour transform uses. */
export const toLuma = (image: RasterImage): Float64Array => {
  const luma = new Float64Array(image.width * image.height);
  for (let index = 0; index < luma.length; index += 1) {
    const offset = index * 3;
    luma[index] =
      0.299 * (image.pixels[offset] ?? 0) +
      0.587 * (image.pixels[offset + 1] ?? 0) +
      0.114 * (image.pixels[offset + 2] ?? 0);
  }
  return luma;
};

/**
 * Area-average ("box") downsample.
 *
 * Averaging every contributing source pixel rather than point-sampling matters
 * for both jobs this serves: a thumbnail that drops pixels aliases badly, and a
 * perceptual hash built on point samples changes when an image is re-encoded,
 * which would defeat the near-duplicate detection V021 exists to provide.
 *
 * Upscaling is refused — nothing in the pipeline needs it, and silently
 * inventing detail in an evidence derivative would be the wrong default.
 */
export const resampleBox = (image: RasterImage, width: number, height: number): RasterImage => {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new MediaDecodeError("bad_resample_target", `invalid target size ${width}x${height}`);
  }
  if (width > image.width || height > image.height) {
    throw new MediaDecodeError(
      "upscale_refused",
      `refusing to upscale ${image.width}x${image.height} to ${width}x${height}`,
    );
  }
  if (width === image.width && height === image.height) return image;

  const out = new Uint8Array(width * height * 3);
  for (let targetY = 0; targetY < height; targetY += 1) {
    // Half-open source ranges computed from the target grid, so every source
    // row belongs to exactly one target row and none is counted twice.
    const startY = Math.floor((targetY * image.height) / height);
    const endY = Math.max(startY + 1, Math.floor(((targetY + 1) * image.height) / height));
    for (let targetX = 0; targetX < width; targetX += 1) {
      const startX = Math.floor((targetX * image.width) / width);
      const endX = Math.max(startX + 1, Math.floor(((targetX + 1) * image.width) / width));

      let red = 0;
      let green = 0;
      let blue = 0;
      let counted = 0;
      for (let sourceY = startY; sourceY < endY; sourceY += 1) {
        for (let sourceX = startX; sourceX < endX; sourceX += 1) {
          const offset = (sourceY * image.width + sourceX) * 3;
          red += image.pixels[offset] ?? 0;
          green += image.pixels[offset + 1] ?? 0;
          blue += image.pixels[offset + 2] ?? 0;
          counted += 1;
        }
      }

      const target = (targetY * width + targetX) * 3;
      out[target] = Math.round(red / counted);
      out[target + 1] = Math.round(green / counted);
      out[target + 2] = Math.round(blue / counted);
    }
  }
  return { width, height, pixels: out };
};

/**
 * Largest size fitting inside a square bound, preserving aspect ratio and never
 * collapsing a dimension to zero.
 */
export const fitWithin = (
  width: number,
  height: number,
  bound: number,
): { readonly width: number; readonly height: number } => {
  if (width <= bound && height <= bound) return { width, height };
  const scale = bound / Math.max(width, height);
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  };
};
