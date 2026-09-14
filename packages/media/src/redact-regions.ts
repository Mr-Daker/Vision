/**
 * Irreversible region redaction for derivatives (roadmap V021).
 *
 * Covering a face or a number plate must not be undoable. A blur or a mosaic
 * often is — enough structure survives to re-identify a person — so a region
 * is filled with one flat colour and the original pixels are simply absent
 * from the derivative. The private original is never touched; it stays under
 * the V005 retention policy and this returns a new raster.
 *
 * Geometry is plain numbers on purpose: this package is a leaf and must not
 * acquire the domain's vocabulary (V006 import matrix).
 */

import { assertRasterConsistent, type RasterImage } from "./raster.ts";

/** Flat mid-grey. Distinct from pure black, so a covered area is visibly a redaction rather than an underexposed photograph. */
export const REDACTION_FILL: readonly [number, number, number] = [128, 128, 128];

export type PixelRegion = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

/**
 * Returns a copy of `image` with every region filled.
 *
 * Regions are clipped to the image rather than rejected: a detector reporting
 * a box that runs a pixel past the edge is ordinary, and quarantining a
 * photograph over a rounding difference would be its own failure.
 */
export const applyRegionRedaction = (
  image: RasterImage,
  regions: readonly PixelRegion[],
): RasterImage => {
  assertRasterConsistent(image);

  const pixels = Uint8Array.from(image.pixels);
  const [fillR, fillG, fillB] = REDACTION_FILL;

  for (const region of regions) {
    // Clip to the image. `Math.floor`/`ceil` widen rather than narrow: a box
    // that half-covers a pixel must cover it fully, because leaving a sliver
    // of a face visible defeats the purpose.
    //
    // The two clamps are not equally load-bearing. Clamping `x` is: a negative
    // x with a positive y indexes into the end of the *previous* row and would
    // fill pixels the region never covered. Clamping `y` is defensive only —
    // any negative y yields a negative offset, which a typed array ignores —
    // and mutation testing confirms no test can distinguish it.
    const left = Math.max(0, Math.floor(region.x));
    const top = Math.max(0, Math.floor(region.y));
    const right = Math.min(image.width, Math.ceil(region.x + region.width));
    const bottom = Math.min(image.height, Math.ceil(region.y + region.height));

    for (let y = top; y < bottom; y += 1) {
      for (let x = left; x < right; x += 1) {
        const offset = (y * image.width + x) * 3;
        pixels[offset] = fillR;
        pixels[offset + 1] = fillG;
        pixels[offset + 2] = fillB;
      }
    }
  }

  return { width: image.width, height: image.height, pixels };
};
