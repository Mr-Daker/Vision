/**
 * Loads the Google Maps JavaScript API once per page (V0xx Google Maps
 * integration).
 *
 * The key is read from `GET /v1/maps-config` rather than baked into any
 * tracked file — see `apps/api/src/app.ts` for why that response needs no
 * protection. A deployment that has not set `GOOGLE_MAPS_API_KEY` is not an
 * error: `loadMaps()` resolves `{ enabled: false }` and every caller renders
 * its existing non-map fallback instead, the same "simulated when absent"
 * rule the rest of this app follows for every other optional provider.
 */

export type MapsLoadResult =
  { readonly enabled: true; readonly maps: typeof google.maps } | { readonly enabled: false };

type MapsConfigResponse = { readonly enabled: boolean; readonly api_key: string | null };

declare global {
  interface Window {
    [key: `__visionMapsReady_${string}`]: (() => void) | undefined;
  }
}

let cached: Promise<MapsLoadResult> | undefined;

const fetchConfig = async (): Promise<MapsConfigResponse | undefined> => {
  try {
    const response = await fetch("/v1/maps-config");
    if (!response.ok) return undefined;
    return (await response.json()) as MapsConfigResponse;
  } catch {
    return undefined;
  }
};

const injectScript = (apiKey: string): Promise<MapsLoadResult> =>
  new Promise((resolve) => {
    const callbackName = `__visionMapsReady_${Math.random().toString(36).slice(2)}` as const;
    window[callbackName] = () => {
      delete window[callbackName];
      resolve({ enabled: true, maps: window.google.maps });
    };

    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&loading=async&callback=${callbackName}`;
    script.async = true;
    script.onerror = () => {
      delete window[callbackName];
      resolve({ enabled: false });
    };
    document.head.appendChild(script);
  });

/** Idempotent: every caller on a page shares the same in-flight load. */
export const loadMaps = (): Promise<MapsLoadResult> => {
  cached ??= (async (): Promise<MapsLoadResult> => {
    const config = await fetchConfig();
    if (config === undefined || !config.enabled || config.api_key === null) {
      return { enabled: false };
    }
    return injectScript(config.api_key);
  })();
  return cached;
};

/**
 * A map styled to sit inside this app's own dark surface instead of Google's
 * default white basemap, using the exact dark-mode colours `app.css` and
 * `reviewer.css` already define (`--page`, `--surface`, `--line`,
 * `--ink-muted`). POI and transit icons are switched off — the same
 * restraint `spatial-panel.ts` applies deliberately elsewhere: a business
 * icon or a bus-stop glyph is decoration this product does not need.
 */
export const DARK_MAP_STYLE: readonly google.maps.MapTypeStyle[] = [
  { elementType: "geometry", stylers: [{ color: "#141416" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#000000" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#b4b4b4" }] },
  { featureType: "administrative", elementType: "geometry", stylers: [{ color: "#3a3a3d" }] },
  { featureType: "administrative.land_parcel", stylers: [{ visibility: "off" }] },
  {
    featureType: "administrative.locality",
    elementType: "labels.text.fill",
    stylers: [{ color: "#ffffff" }],
  },
  {
    featureType: "administrative.country",
    elementType: "labels.text.fill",
    stylers: [{ color: "#8a9099" }],
  },
  { featureType: "landscape", elementType: "geometry", stylers: [{ color: "#141416" }] },
  { featureType: "poi", stylers: [{ visibility: "off" }] },
  { featureType: "poi.park", elementType: "geometry", stylers: [{ color: "#1a1f18" }] },
  { featureType: "road", elementType: "geometry", stylers: [{ color: "#232326" }] },
  { featureType: "road", elementType: "geometry.stroke", stylers: [{ color: "#141416" }] },
  { featureType: "road", elementType: "labels.text.fill", stylers: [{ color: "#8a9099" }] },
  { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#3a3a3d" }] },
  {
    featureType: "road.highway",
    elementType: "labels.text.fill",
    stylers: [{ color: "#b4b4b4" }],
  },
  { featureType: "transit", stylers: [{ visibility: "off" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#000000" }] },
  { featureType: "water", elementType: "labels.text.fill", stylers: [{ color: "#4a5157" }] },
];

/**
 * Live, not cached: `app.css`/`reviewer.css` switch on this same media query,
 * so a map built from it stays in step with a system theme change instead of
 * freezing at whatever was true when the page loaded.
 */
export const systemPrefersDark = (): boolean =>
  window.matchMedia("(prefers-color-scheme: dark)").matches;
