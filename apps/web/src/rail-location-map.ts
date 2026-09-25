/** Explorable map for the citizen form's location-evidence card. Panning does not change the report. */

import type { LocationReading } from "./location.ts";
import { DARK_MAP_STYLE, loadMaps, systemPrefersDark } from "./maps-loader.ts";

let map: google.maps.Map | undefined;
let marker: google.maps.Marker | undefined;
let accuracyCircle: google.maps.Circle | undefined;
let loadStarted = false;
let currentReading: LocationReading | undefined;
let lastPositionKey: string | undefined;

const container = (): HTMLElement | null => document.getElementById("rail-location-figure");

const updateMap = (): void => {
  const target = container();
  const reading = currentReading;
  if (target === null || map === undefined || reading === undefined) return;

  const position = { lat: reading.lat, lng: reading.lon };
  const radius = reading.source === "device_geolocation" ? reading.accuracyMetres : undefined;
  const positionKey = `${reading.lat}:${reading.lon}:${radius ?? "none"}`;
  target.hidden = false;
  if (positionKey === lastPositionKey) return;
  lastPositionKey = positionKey;

  map.setCenter(position);
  map.setZoom(16);
  if (marker === undefined) {
    marker = new google.maps.Marker({ map, position });
  } else {
    marker.setPosition(position);
  }

  if (radius !== undefined && Number.isFinite(radius) && radius > 0) {
    if (accuracyCircle === undefined) {
      accuracyCircle = new google.maps.Circle({
        map,
        center: position,
        radius,
        strokeColor: "#f59f42",
        strokeOpacity: 0.75,
        strokeWeight: 1,
        fillColor: "#f59f42",
        fillOpacity: 0.12,
        clickable: false,
      });
    } else {
      accuracyCircle.setCenter(position);
      accuracyCircle.setRadius(radius);
      accuracyCircle.setMap(map);
    }
  } else {
    accuracyCircle?.setMap(null);
  }
};

/** The coordinate readout remains the authoritative source of location evidence. */
export const renderRailLocationMap = (reading: LocationReading | undefined): void => {
  currentReading = reading;
  const target = container();
  if (target === null) return;
  if (reading === undefined) {
    target.hidden = true;
    lastPositionKey = undefined;
    return;
  }

  if (map !== undefined) {
    updateMap();
    return;
  }
  if (loadStarted) return;
  loadStarted = true;

  void loadMaps().then((result) => {
    if (!result.enabled) return;
    if (currentReading === undefined) {
      loadStarted = false;
      return;
    }
    const mapTarget = container();
    if (mapTarget === null) return;
    mapTarget.hidden = false;
    map = new result.maps.Map(mapTarget, {
      center: { lat: currentReading.lat, lng: currentReading.lon },
      zoom: 16,
      disableDefaultUI: true,
      // Dragging explores the surrounding area without changing the reported
      // pin. Cooperative wheel/touch gestures let the page itself still scroll.
      gestureHandling: "cooperative",
      draggable: true,
      zoomControl: true,
      keyboardShortcuts: true,
      clickableIcons: false,
      styles: systemPrefersDark() ? [...DARK_MAP_STYLE] : null,
    });
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (event) => {
      map?.setOptions({ styles: event.matches ? [...DARK_MAP_STYLE] : null });
    });
    updateMap();
  });
};
