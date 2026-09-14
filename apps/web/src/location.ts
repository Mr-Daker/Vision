/**
 * Location semantics for the capture flow (roadmap V019).
 *
 * The rule this file exists to enforce: **a position the citizen typed and a
 * position the device reported are different kinds of thing, and the interface
 * must say which one it has.** The server stores that distinction
 * (`observed.source`, [V018](../../../docs/foundation/V018-submission-acceptance-and-receipt.md) §3);
 * this is the client half of the same honesty.
 *
 * Neither kind is proof of presence. Nothing here calls a location verified,
 * per the [V002](../../../docs/foundation/V002-capability-evidence-matrix.md)
 * prohibition.
 *
 * Pure: no DOM, no geolocation call. The browser layer supplies readings.
 */

import type { StringKey } from "./locales/strings.ts";

export type LocationSource = "device_geolocation" | "manual_pin";

export type LocationReading = {
  readonly lat: number;
  readonly lon: number;
  /** Metres, as reported by the device. Absent when the device did not say. */
  readonly accuracyMetres?: number;
  readonly source: LocationSource;
  /** When the position was observed, not when the form was filled in. */
  readonly observedAt: string;
};

export type CoordinateIssue = { readonly field: "lat" | "lon"; readonly key: StringKey };

/** Rejects out-of-range and non-finite coordinates before anything is sent. */
export const validateCoordinates = (lat: number, lon: number): readonly CoordinateIssue[] => {
  const issues: CoordinateIssue[] = [];
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    issues.push({ field: "lat", key: "location.latitude" });
  }
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
    issues.push({ field: "lon", key: "location.longitude" });
  }
  return issues;
};

/**
 * How a reading must be presented.
 *
 * `isDeviceEvidence` is deliberately not called "verified": it means the
 * device reported the position, which is a different claim from the position
 * being correct or the reporter having been there.
 */
export type LocationDisclosure = {
  readonly headingKey: StringKey;
  readonly noteKey: StringKey;
  readonly accuracyKey: StringKey;
  readonly accuracyParams: Readonly<Record<string, string | number>>;
  readonly isDeviceEvidence: boolean;
};

export const describeLocation = (reading: LocationReading): LocationDisclosure => {
  const isDeviceEvidence = reading.source === "device_geolocation";
  const hasAccuracy =
    reading.accuracyMetres !== undefined && Number.isFinite(reading.accuracyMetres);

  return {
    headingKey: isDeviceEvidence ? "location.captured_heading" : "location.manual_heading",
    noteKey: isDeviceEvidence ? "location.captured_note" : "location.manual_note",
    // A manually entered position has no device accuracy to report, and
    // inventing one would be a fabricated measurement.
    accuracyKey:
      isDeviceEvidence && hasAccuracy ? "location.accuracy" : "location.accuracy_unknown",
    accuracyParams:
      isDeviceEvidence && hasAccuracy ? { metres: Math.round(reading.accuracyMetres ?? 0) } : {},
    isDeviceEvidence,
  };
};

/** Age in whole minutes, floored. Negative clock skew reads as 0. */
export const readingAgeMinutes = (reading: LocationReading, nowMs: number): number => {
  const observedMs = Date.parse(reading.observedAt);
  if (Number.isNaN(observedMs)) return 0;
  return Math.max(0, Math.floor((nowMs - observedMs) / 60_000));
};

/** Minutes after which a captured position is re-offered rather than assumed. */
export const STALE_LOCATION_MINUTES = 10;

/**
 * Whether to prompt for a fresh capture (V020).
 *
 * Only device readings go stale. A typed position is a claim about a place,
 * not a measurement of where the phone is now, so re-prompting for it would
 * be nagging about nothing.
 */
export const isLocationStale = (reading: LocationReading, nowMs: number): boolean =>
  reading.source === "device_geolocation" &&
  readingAgeMinutes(reading, nowMs) >= STALE_LOCATION_MINUTES;

/** How the browser's geolocation failure maps to an explanation. */
export const geolocationErrorKey = (code: number | undefined): StringKey => {
  // 1 = PERMISSION_DENIED, 2 = POSITION_UNAVAILABLE, 3 = TIMEOUT
  if (code === 1) return "location.permission_denied";
  if (code === 2 || code === 3) return "location.unavailable";
  return "location.unavailable";
};
