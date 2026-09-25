/**
 * A read-only overview map for an ops queue page (V0xx Google Maps
 * integration): one marker per issue currently listed, so a reader can see
 * where a queue is concentrated. It never replaces the ward/table view —
 * that stays the record this system asserts; the map is a spatial summary of
 * exactly the same rows, nothing more.
 */

import { DARK_MAP_STYLE, loadMaps, systemPrefersDark } from "./maps-loader.ts";

export type IssueMapPoint = {
  readonly key: string;
  readonly lat: number;
  readonly lon: number;
  readonly label: string;
};

/**
 * Renders markers for `points` into `container`, hidden until the loader
 * confirms a key is configured. A deployment with no key, or a list with no
 * geolocated rows, leaves `container` exactly as it started — hidden, taking
 * no space — so nothing here is missed when maps are simply switched off.
 */
export const renderIssueOverviewMap = async (
  container: HTMLElement,
  points: readonly IssueMapPoint[],
): Promise<void> => {
  if (points.length === 0) {
    container.hidden = true;
    return;
  }
  const result = await loadMaps();
  if (!result.enabled) {
    container.hidden = true;
    return;
  }

  container.hidden = false;
  const map = new result.maps.Map(container, {
    streetViewControl: false,
    fullscreenControl: false,
    mapTypeControl: false,
    styles: systemPrefersDark() ? [...DARK_MAP_STYLE] : null,
  });

  if (points.length === 1) {
    const only = points[0];
    if (only !== undefined) {
      const position = { lat: only.lat, lng: only.lon };
      map.setCenter(position);
      map.setZoom(15);
      new result.maps.Marker({ map, position, title: only.label });
    }
    return;
  }

  const bounds = new result.maps.LatLngBounds();
  for (const point of points) {
    const position = { lat: point.lat, lng: point.lon };
    new result.maps.Marker({ map, position, title: point.label });
    bounds.extend(position);
  }
  map.fitBounds(bounds, 32);
};
