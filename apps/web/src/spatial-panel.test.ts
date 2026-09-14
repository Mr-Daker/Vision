/**
 * Location instrument geometry (roadmap V019).
 *
 * The panel makes claims about where things are, so the maths behind it is
 * asserted rather than eyeballed in a browser. The claims that matter: the
 * accuracy ring is at true scale, a position the device did not measure gets
 * no ring at all, and a nearby issue appears in the direction it actually lies.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSpatialPanel,
  chooseInterval,
  distanceMetres,
  formatCoordinate,
  metresPerDegreeLon,
  PANEL_SIZE,
} from "./spatial-panel.ts";
import type { LocationReading } from "./location.ts";

/** Sangli district, which is the locked scope for this build. */
const SANGLI = { lat: 16.8524, lon: 74.5815 };

const reading = (over: Partial<LocationReading> = {}): LocationReading => ({
  lat: SANGLI.lat,
  lon: SANGLI.lon,
  source: "device_geolocation",
  observedAt: "2026-09-12T08:31:00.000Z",
  ...over,
});

/** Pulls `cx`/`cy`/`r` off the first element carrying a class. */
const shape = (svg: string, className: string): { cx: number; cy: number; r: number } => {
  const match = new RegExp(
    `<circle class="${className}"[^>]*cx="([-\\d.]+)" cy="([-\\d.]+)" r="([-\\d.]+)"`,
  ).exec(svg);
  assert.notEqual(match, null, `no <circle class="${className}"> in the panel`);
  return {
    cx: Number(match?.[1]),
    cy: Number(match?.[2]),
    r: Number(match?.[3]),
  };
};

test("V019: a degree of longitude shortens away from the equator", () => {
  // Meridians converge. Ignoring this stretches the panel east-west, which
  // would put nearby issues in the wrong direction.
  assert.ok(metresPerDegreeLon(0) > metresPerDegreeLon(45));
  assert.ok(metresPerDegreeLon(45) > metresPerDegreeLon(80));
  assert.ok(Math.abs(metresPerDegreeLon(0) - 111_320) < 1);
  // At Sangli's latitude a degree of longitude is about 4% short.
  const ratio = metresPerDegreeLon(SANGLI.lat) / 111_320;
  assert.ok(ratio > 0.95 && ratio < 0.97, `ratio was ${String(ratio)}`);
});

test("V019: the accuracy ring is drawn to true scale", () => {
  // A 20 m fix must cover twice the radius of a 10 m fix on the same span.
  // Both are forced onto one span by a marker, so the comparison is fair.
  const far = [{ lat: SANGLI.lat + 0.005, lon: SANGLI.lon }];
  const tight = buildSpatialPanel(reading({ accuracyMetres: 10 }), far);
  const loose = buildSpatialPanel(reading({ accuracyMetres: 20 }), far);
  assert.equal(tight.spanMetres, loose.spanMetres, "span should be set by the marker here");

  const tightRing = shape(tight.svg, "sp-accuracy");
  const looseRing = shape(loose.svg, "sp-accuracy");
  assert.ok(
    Math.abs(looseRing.r / tightRing.r - 2) < 0.01,
    `expected twice the radius, got ${String(looseRing.r / tightRing.r)}`,
  );
});

test("V019: a position with no stated accuracy gets no ring", () => {
  // A manually placed pin is not a measurement. Drawing a default circle would
  // invent a precision the system was never told.
  const panel = buildSpatialPanel(reading({ source: "manual_pin" }));
  assert.equal(panel.accuracyDrawn, false);
  assert.doesNotMatch(panel.svg, /class="sp-accuracy"/);
});

test("V019: a zero or nonsense accuracy is treated as no accuracy", () => {
  assert.equal(buildSpatialPanel(reading({ accuracyMetres: 0 })).accuracyDrawn, false);
  assert.equal(buildSpatialPanel(reading({ accuracyMetres: Number.NaN })).accuracyDrawn, false);
  assert.equal(buildSpatialPanel(reading({ accuracyMetres: -5 })).accuracyDrawn, false);
});

test("V019: a nearby issue is plotted in the direction it actually lies", () => {
  const centre = PANEL_SIZE / 2;
  const north = buildSpatialPanel(reading({ accuracyMetres: 10 }), [
    { lat: SANGLI.lat + 0.0005, lon: SANGLI.lon },
  ]);
  const marker = shape(north.svg, "sp-nearby");
  // North is up: same longitude, smaller y.
  assert.ok(Math.abs(marker.cx - centre) < 0.5, `expected centred x, got ${String(marker.cx)}`);
  assert.ok(marker.cy < centre, `north should be above centre, got ${String(marker.cy)}`);

  const east = buildSpatialPanel(reading({ accuracyMetres: 10 }), [
    { lat: SANGLI.lat, lon: SANGLI.lon + 0.0005 },
  ]);
  const eastMarker = shape(east.svg, "sp-nearby");
  assert.ok(eastMarker.cx > centre, `east should be right of centre`);
  assert.ok(Math.abs(eastMarker.cy - centre) < 0.5, `expected centred y`);
});

test("V019: an issue beyond the drawn area is left off rather than clamped to the edge", () => {
  // Clamping would put it at a bearing it is not at, which is a false claim
  // about where a problem is.
  const panel = buildSpatialPanel(reading({ accuracyMetres: 8 }), [
    { lat: SANGLI.lat + 5, lon: SANGLI.lon + 5 },
  ]);
  assert.equal(panel.markersPlotted, 0);
  assert.doesNotMatch(panel.svg, /class="sp-nearby"/);
});

test("V019: the span never collapses below a street-sized area", () => {
  // A 1 m fix must not zoom in so far that the panel means nothing.
  const panel = buildSpatialPanel(reading({ accuracyMetres: 1 }));
  assert.ok(panel.spanMetres >= 120, `span was ${String(panel.spanMetres)}`);
});

test("V019: one distant issue cannot shrink the pin to nothing", () => {
  const panel = buildSpatialPanel(reading({ accuracyMetres: 10 }), [
    { lat: SANGLI.lat + 0.4, lon: SANGLI.lon },
  ]);
  assert.ok(panel.spanMetres <= 4000, `span was ${String(panel.spanMetres)}`);
});

test("V019: the graticule stays readable instead of turning into hatching", () => {
  // Whatever the span, the chosen interval must put at most six lines across.
  for (const spanDegrees of [0.0003, 0.001, 0.004, 0.02, 0.09]) {
    const interval = chooseInterval(spanDegrees);
    assert.ok(
      spanDegrees / interval <= 6,
      `span ${String(spanDegrees)} gave ${String(spanDegrees / interval)} lines`,
    );
  }
});

test("V019: graticule lines are real parallels, not arbitrary divisions", () => {
  // Every label must be a whole multiple of the interval, which is what makes
  // it a coordinate grid rather than decoration.
  const panel = buildSpatialPanel(reading({ accuracyMetres: 15 }));
  const labels = [...panel.svg.matchAll(/class="sp-grid-label"[^>]*>([\d.]+)° ([NS])</g)];
  assert.ok(labels.length > 0, "expected at least one latitude label");
  const interval = chooseInterval(panel.spanMetres / 111_320);
  for (const label of labels) {
    const value = Number(label[1]);
    const steps = value / interval;
    assert.ok(
      Math.abs(steps - Math.round(steps)) < 1e-6,
      `${String(value)}° is not a multiple of the ${String(interval)}° interval`,
    );
  }
});

test("V019: coordinates are formatted with a hemisphere rather than a sign", () => {
  assert.equal(formatCoordinate(16.8524, "lat"), "16.8524° N");
  assert.equal(formatCoordinate(-16.8524, "lat"), "16.8524° S");
  assert.equal(formatCoordinate(74.5815, "lon"), "74.5815° E");
  assert.equal(formatCoordinate(-74.5815, "lon"), "74.5815° W");
});

test("V019: distance is symmetric and zero at the same point", () => {
  const a = { lat: SANGLI.lat, lon: SANGLI.lon };
  const b = { lat: SANGLI.lat + 0.001, lon: SANGLI.lon + 0.001 };
  assert.equal(distanceMetres(a, a), 0);
  assert.ok(Math.abs(distanceMetres(a, b) - distanceMetres(b, a)) < 0.5);
  // 0.001 degrees of latitude is about 111 m; with longitude too, about 155 m.
  assert.ok(distanceMetres(a, b) > 140 && distanceMetres(a, b) < 170);
});

test("V019: the panel carries no text a screen reader would read twice", () => {
  // The readout beside the instrument is the accessible copy; the SVG is
  // decorative so the same coordinates are not announced twice.
  const panel = buildSpatialPanel(reading({ accuracyMetres: 12 }));
  assert.match(panel.svg, /aria-hidden="true"/);
  assert.match(panel.svg, /focusable="false"/);
});
