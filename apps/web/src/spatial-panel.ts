/**
 * Location evidence instrument (roadmap V019 presentation of V018 data).
 *
 * Draws what the system actually knows about a reported position: the pin, the
 * device's stated accuracy as a circle at true scale, a real latitude and
 * longitude graticule, and any nearby issues at their true bearing and
 * distance. Pure — it takes a reading and returns SVG markup, so the geometry
 * below is testable without a browser.
 *
 * What this deliberately does not draw: streets, coastlines, buildings, or any
 * other geography. Lines that look like a street layout but are invented would
 * be read as the real one, and inventing the evidence is the failure this whole
 * product is built to avoid. A graticule is honest — every line on it is a real
 * parallel or meridian, and the accuracy ring next to it is the only claim
 * about precision being made.
 */

import type { LocationReading } from "./location.ts";

/** Metres per degree of latitude. Constant enough at the scale of one report. */
const METRES_PER_DEGREE_LAT = 111_320;

/** The instrument's drawing surface, in SVG user units. */
export const PANEL_SIZE = 320;

const CENTRE = PANEL_SIZE / 2;

/**
 * Smallest span the panel will show, in metres. A device that reports a
 * two-metre fix should not be zoomed in so far that the graticule becomes
 * meaningless; this keeps a sense of a street-sized area around the pin.
 */
const MINIMUM_SPAN_METRES = 120;

/** Largest span, so one distant nearby issue cannot shrink the pin to nothing. */
const MAXIMUM_SPAN_METRES = 4_000;

/** Degree intervals the graticule is allowed to use. */
const INTERVAL_LADDER: readonly number[] = [
  0.0001, 0.0002, 0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1,
];

/** An issue near the reported position. Real data only — never a placeholder. */
export type NearbyMarker = {
  readonly lat: number;
  readonly lon: number;
};

export type SpatialPanel = {
  /** Inline SVG markup, ready to assign as innerHTML. */
  readonly svg: string;
  /** How many metres the panel spans edge to edge. */
  readonly spanMetres: number;
  /** True when an accuracy ring was drawn, i.e. the device stated an accuracy. */
  readonly accuracyDrawn: boolean;
  /** How many of the supplied markers fell inside the drawn area. */
  readonly markersPlotted: number;
};

/**
 * Metres per degree of longitude at a given latitude. Meridians converge
 * towards the poles, so a degree of longitude in Sangli is about 4% shorter
 * than at the equator; ignoring this would stretch the panel east-west.
 */
export const metresPerDegreeLon = (lat: number): number =>
  METRES_PER_DEGREE_LAT * Math.cos((lat * Math.PI) / 180);

/**
 * Picks a graticule interval that puts a handful of lines across the panel.
 * Returns the smallest ladder step that yields at most `maxLines`, so the grid
 * stays readable instead of turning into hatching.
 */
export const chooseInterval = (spanDegrees: number, maxLines = 6): number => {
  for (const interval of INTERVAL_LADDER) {
    if (spanDegrees / interval <= maxLines) return interval;
  }
  return INTERVAL_LADDER[INTERVAL_LADDER.length - 1] ?? 0.1;
};

/** Great-circle-free local distance in metres. Fine over a few hundred metres. */
export const distanceMetres = (
  from: { readonly lat: number; readonly lon: number },
  to: { readonly lat: number; readonly lon: number },
): number => {
  const dy = (to.lat - from.lat) * METRES_PER_DEGREE_LAT;
  const dx = (to.lon - from.lon) * metresPerDegreeLon(from.lat);
  return Math.sqrt(dx * dx + dy * dy);
};

/** Formats a coordinate the way the readout shows it: degrees and hemisphere. */
export const formatCoordinate = (value: number, axis: "lat" | "lon"): string => {
  const hemisphere = axis === "lat" ? (value >= 0 ? "N" : "S") : value >= 0 ? "E" : "W";
  return `${Math.abs(value).toFixed(4)}° ${hemisphere}`;
};

/** Rounds to two decimals so the emitted SVG stays short and diff-friendly. */
const n = (value: number): string => String(Math.round(value * 100) / 100);

/**
 * Chooses the span. Wide enough to show the whole accuracy circle with room
 * around it, and to include nearby markers when they are close enough to be
 * worth showing, but never outside the fixed bounds.
 */
const resolveSpan = (reading: LocationReading, nearby: readonly NearbyMarker[]): number => {
  const accuracy = reading.accuracyMetres;
  const fromAccuracy =
    accuracy !== undefined && Number.isFinite(accuracy) && accuracy > 0 ? accuracy * 6 : 0;

  let farthest = 0;
  for (const marker of nearby) {
    farthest = Math.max(farthest, distanceMetres(reading, marker));
  }
  // *2.4 so the farthest marker sits inside the edge rather than on it.
  const fromMarkers = farthest > 0 ? farthest * 2.4 : 0;

  const wanted = Math.max(MINIMUM_SPAN_METRES, fromAccuracy, fromMarkers);
  return Math.min(MAXIMUM_SPAN_METRES, wanted);
};

/**
 * Builds the instrument.
 *
 * `nearby` may be empty — markers are drawn only when real ones are supplied,
 * because a panel that invents neighbours is worse than a panel with none.
 */
export const buildSpatialPanel = (
  reading: LocationReading,
  nearby: readonly NearbyMarker[] = [],
): SpatialPanel => {
  const spanMetres = resolveSpan(reading, nearby);
  const unitsPerMetre = PANEL_SIZE / spanMetres;

  const lonScale = metresPerDegreeLon(reading.lat);
  const spanLatDegrees = spanMetres / METRES_PER_DEGREE_LAT;
  const interval = chooseInterval(spanLatDegrees);

  // Project a coordinate onto the panel. North is up, so latitude is negated.
  const project = (lat: number, lon: number): { x: number; y: number } => ({
    x: CENTRE + (lon - reading.lon) * lonScale * unitsPerMetre,
    y: CENTRE - (lat - reading.lat) * METRES_PER_DEGREE_LAT * unitsPerMetre,
  });

  const parts: string[] = [];

  // ── Graticule. Real parallels and meridians at `interval` degrees. ──
  const halfLat = spanLatDegrees / 2;
  const halfLon = spanMetres / lonScale / 2;

  const firstParallel = Math.ceil((reading.lat - halfLat) / interval) * interval;
  for (let lat = firstParallel; lat <= reading.lat + halfLat; lat += interval) {
    const { y } = project(lat, reading.lon);
    parts.push(
      `<line class="sp-grid" x1="0" y1="${n(y)}" x2="${PANEL_SIZE}" y2="${n(y)}" />`,
      `<text class="sp-grid-label" x="4" y="${n(y - 4)}">${formatCoordinate(lat, "lat")}</text>`,
    );
  }

  const firstMeridian = Math.ceil((reading.lon - halfLon) / interval) * interval;
  for (let lon = firstMeridian; lon <= reading.lon + halfLon; lon += interval) {
    const { x } = project(reading.lat, lon);
    parts.push(
      `<line class="sp-grid" x1="${n(x)}" y1="0" x2="${n(x)}" y2="${PANEL_SIZE}" />`,
      `<text class="sp-grid-label sp-grid-label-v" x="${n(x + 4)}" y="${PANEL_SIZE - 6}">${formatCoordinate(lon, "lon")}</text>`,
    );
  }

  // ── Nearby issues, at their true bearing and distance. ──
  let markersPlotted = 0;
  for (const marker of nearby) {
    const { x, y } = project(marker.lat, marker.lon);
    if (x < 0 || x > PANEL_SIZE || y < 0 || y > PANEL_SIZE) continue;
    markersPlotted += 1;
    parts.push(`<circle class="sp-nearby" cx="${n(x)}" cy="${n(y)}" r="4" />`);
  }

  // ── Accuracy ring, at true scale. Only when the device stated one. ──
  const accuracy = reading.accuracyMetres;
  const accuracyDrawn = accuracy !== undefined && Number.isFinite(accuracy) && accuracy > 0;
  if (accuracyDrawn) {
    const radius = (accuracy ?? 0) * unitsPerMetre;
    parts.push(
      `<circle class="sp-accuracy" cx="${CENTRE}" cy="${CENTRE}" r="${n(radius)}" />`,
      `<circle class="sp-pulse" cx="${CENTRE}" cy="${CENTRE}" r="${n(radius)}" />`,
    );
  } else {
    // No stated accuracy means no circle to draw. The pulse still marks the
    // pin as live, at a fixed radius that claims nothing about precision.
    parts.push(`<circle class="sp-pulse sp-pulse-bare" cx="${CENTRE}" cy="${CENTRE}" r="14" />`);
  }

  // ── Crosshair and pin. ──
  parts.push(
    `<line class="sp-cross" x1="${CENTRE}" y1="${CENTRE - 16}" x2="${CENTRE}" y2="${CENTRE + 16}" />`,
    `<line class="sp-cross" x1="${CENTRE - 16}" y1="${CENTRE}" x2="${CENTRE + 16}" y2="${CENTRE}" />`,
    `<circle class="sp-pin" cx="${CENTRE}" cy="${CENTRE}" r="5" />`,
  );

  const svg =
    `<svg class="sp-svg" viewBox="0 0 ${PANEL_SIZE} ${PANEL_SIZE}" ` +
    `xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">` +
    parts.join("") +
    `</svg>`;

  return { svg, spanMetres, accuracyDrawn, markersPlotted };
};
