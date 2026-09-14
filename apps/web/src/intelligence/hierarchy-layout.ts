/**
 * Deterministic radial layout for the hierarchy constellation.
 *
 * Pure geometry: given a focus node and its children, it returns where each
 * circle sits. No DOM, no randomness, no animation — the view interpolates
 * between two of these, which is what makes a drill-down read as travel rather
 * than as a redraw.
 *
 * Why a ring rather than `d3.pack()`: a pack fills a disc, so the focus node
 * would have to sit outside its own children or be one of them. A ring keeps
 * the parent at the centre of its children, which is the relationship the page
 * is trying to show, and it costs no dependency.
 *
 * **Area encodes count, not radius.** Doubling a radius quadruples the ink, so
 * radius-encoded counts overstate large values by their square — the single
 * most common way a bubble chart misleads.
 */

export type LayoutInput = {
  readonly id: string;
  readonly value: number;
};

export type PlacedNode = {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly r: number;
  /** Angle from the focus, radians, 0 = east. Used to aim connector lines. */
  readonly angle: number;
};

export type LayoutOptions = {
  /** Half the viewport's smaller dimension: the space available around focus. */
  readonly extent: number;
  /** Radius of the focus node at the centre. */
  readonly focusRadius: number;
  /** Smallest a child may be drawn, so a 1-issue node stays clickable. */
  readonly minRadius?: number;
  /** Largest a child may be drawn, so one hotspot cannot swallow the frame. */
  readonly maxRadius?: number;
  /** Clear space between neighbouring children. */
  readonly gap?: number;
};

const TAU = Math.PI * 2;

/**
 * How much further out than the bare minimum the ring sits when there is room.
 * Purely a spacing judgement: at 1.0 the children touch, which reads as
 * clutter rather than as a hierarchy.
 */
const COMFORT = 1.32;

/**
 * Child radii from values, by area.
 *
 * `sqrt` because a circle's area grows with the square of its radius: a state
 * with four times the issues should occupy four times the ink, which means
 * twice the radius.
 */
export const radiiFor = (
  values: readonly number[],
  minRadius: number,
  maxRadius: number,
): readonly number[] => {
  const largest = Math.max(1, ...values);
  return values.map((value) => {
    const scaled = Math.sqrt(Math.max(0, value) / largest);
    return minRadius + (maxRadius - minRadius) * scaled;
  });
};

/**
 * The angle one circle of radius `r` subtends on a ring of radius `R`.
 * Undefined when the circle cannot fit on the ring at all, which the caller
 * resolves by growing `R`.
 */
const subtended = (r: number, ringRadius: number): number => {
  const ratio = r / ringRadius;
  return ratio >= 1 ? Number.POSITIVE_INFINITY : 2 * Math.asin(ratio);
};

/**
 * The smallest ring on which every child fits without overlapping.
 *
 * Binary search rather than a closed form: the total angle is a monotonic
 * function of the ring radius but not an invertible one, and a search converges
 * in a handful of iterations at this size.
 */
export const ringRadiusFor = (
  radii: readonly number[],
  gap: number,
  lowerBound: number,
): number => {
  const needed = (ringRadius: number): number =>
    radii.reduce((total, r) => total + subtended(r + gap / 2, ringRadius), 0);

  let low = Math.max(lowerBound, 1);
  let high = Math.max(low * 2, 8);
  // Grow until it certainly fits, then bisect down to the tightest that does.
  while (needed(high) > TAU) high *= 2;
  for (let i = 0; i < 40; i += 1) {
    const mid = (low + high) / 2;
    if (needed(mid) > TAU) low = mid;
    else high = mid;
  }
  return high;
};

/**
 * Places children on a ring around the origin.
 *
 * Each child is given angular room proportional to its own size, then centred
 * in it, so a large node is not crowded by a small neighbour. Any slack left
 * over is spread evenly rather than pooling after the last child, which would
 * leave a visible gap at one o'clock.
 *
 * Largest first, starting at the top: the biggest number is where the eye lands
 * first, and the order is stable across renders so a node keeps its place
 * when a sibling is filtered away.
 */
export const layoutRing = (
  children: readonly LayoutInput[],
  options: LayoutOptions,
): readonly PlacedNode[] => {
  if (children.length === 0) return [];

  const minRadius = options.minRadius ?? 9;
  const gap = options.gap ?? 14;
  // Never let a child out-measure the focus, or the hierarchy reads upside down.
  const maxRadius = options.maxRadius ?? Math.max(minRadius + 1, options.focusRadius * 0.82);

  const radii = radiiFor(
    children.map((child) => child.value),
    minRadius,
    maxRadius,
  );

  const biggest = Math.max(...radii);
  // The ring must clear the focus node and leave the largest child room to sit
  // outside it, and must stay inside the space available.
  const floor = options.focusRadius + biggest + gap;

  // `ringRadiusFor` returns the *tightest* ring the children fit on, which by
  // definition is minimum spacing. With two or three children that put the ring
  // barely outside the focus node and the level looked cramped, so the ring is
  // pushed out where there is room for it. Circles are not the only thing on
  // the ring — each node carries a label outside it — and this is the slack
  // that keeps those apart too.
  const comfortable = Math.max(ringRadiusFor(radii, gap, floor), floor * COMFORT);
  const ceiling = Math.max(floor, options.extent - biggest - gap);
  const ringRadius = Math.min(comfortable, ceiling);

  const widths = radii.map((r) => subtended(r + gap / 2, ringRadius));
  const used = widths.reduce((total, w) => total + w, 0);
  // Slack is shared between every child rather than left in one lump.
  const slack = Math.max(0, TAU - used) / children.length;

  const placed: PlacedNode[] = [];
  // Start at twelve o'clock. SVG y grows downward, so that is -π/2.
  let cursor = -Math.PI / 2 - (widths[0] ?? 0) / 2 - slack / 2;

  for (const [index, child] of children.entries()) {
    const width = (widths[index] ?? 0) + slack;
    const angle = cursor + width / 2;
    placed.push({
      id: child.id,
      x: Math.cos(angle) * ringRadius,
      y: Math.sin(angle) * ringRadius,
      r: radii[index] ?? minRadius,
      angle,
    });
    cursor += width;
  }

  return placed;
};

/**
 * Which side of a node its label belongs on.
 *
 * Always-below was the first version, and it put a node at twelve o'clock in
 * the position of pointing its label straight down into the focus node — which
 * is precisely where "Chennai" ended up sitting on top of Tamil Nadu. The label
 * goes on whichever side faces away from the centre, so it always has the open
 * frame to occupy rather than its own parent.
 *
 * The threshold is -0.3 rather than 0 so nodes near the horizontal keep their
 * labels below, where reading is more natural; only nodes clearly in the upper
 * arc flip.
 */
export const labelSide = (angle: number): "above" | "below" =>
  Math.sin(angle) < -0.3 ? "above" : "below";

/** Distance between two placed nodes' edges. Negative means they overlap. */
export const clearance = (a: PlacedNode, b: PlacedNode): number =>
  Math.hypot(a.x - b.x, a.y - b.y) - a.r - b.r;
