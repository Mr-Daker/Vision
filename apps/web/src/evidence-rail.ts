/**
 * Evidence rail (roadmap V019 presentation).
 *
 * A second view of state the form already holds. The rule this module exists to
 * keep: nothing lives only here. Every value it writes is also rendered in the
 * form flow, which is what lets the rail collapse on a phone, and what lets the
 * instrument's SVG be `aria-hidden` without a screen reader losing anything.
 *
 * Cards move `neutral → processing → resolved`. `processing` is driven by real
 * pending work — a geolocation fix, a nearby query, an upload in flight — never
 * by a timer imitating computation. A card whose data is already present goes
 * straight to `resolved`.
 */

import { buildSpatialPanel, formatCoordinate, type NearbyMarker } from "./spatial-panel.ts";
import type { LocationReading } from "./location.ts";
import type { UploadState } from "./upload.ts";
import type { StringKey } from "./locales/strings.ts";

/**
 * The four stages, each named for a state that exists in
 * `packages/domain/src/transitions.ts`:
 *
 *   captured → SubmissionStatus "received"
 *   checked  → SubmissionStatus "accepted"
 *   matched  → IssueMatchState  "match_confirmed"
 *   routed   → IssueStatus      "routed_internal"
 *
 * There is deliberately no "verified" stage. No such state exists, and the
 * product says elsewhere that a repair claim is not a verified resolution.
 */
export type PipelineStage = "captured" | "checked" | "matched" | "routed";

const STAGE_ORDER: readonly PipelineStage[] = ["captured", "checked", "matched", "routed"];

export type RailState = {
  readonly location: LocationReading | undefined;
  /** True while a geolocation fix is actually outstanding. */
  readonly locating: boolean;
  readonly photo: UploadState;
  /** The selected file, when one is still held by the input. */
  readonly photoFile: File | undefined;
  readonly nearbyCount: number | undefined;
  readonly nearbyLoading: boolean;
  readonly nearbyMarkers: readonly NearbyMarker[];
  readonly stage: PipelineStage;
};

export type RailText = (
  key: StringKey,
  params?: Readonly<Record<string, string | number>>,
) => string;

type CardState = "neutral" | "processing" | "resolved";

const byId = <T extends HTMLElement>(id: string): T | undefined =>
  (document.getElementById(id) as T | null) ?? undefined;

const setCardState = (id: string, value: CardState): void => {
  const card = byId(id);
  if (card !== undefined) card.dataset["state"] = value;
};

const show = (id: string, visible: boolean): void => {
  const node = byId(id);
  if (node !== undefined) node.hidden = !visible;
};

const setText = (id: string, value: string): void => {
  const node = byId(id);
  if (node !== undefined) node.textContent = value;
};

/**
 * The object URL backing the photo preview, and the file it was made from.
 *
 * Both are held at module scope because the URL must outlive a render. The
 * first version of this created a fresh URL on every pass and revoked the
 * previous one, which looked tidy and was broken: `renderAll` runs repeatedly
 * while an upload reports progress, so the URL was revoked while the browser
 * was still decoding the image and the preview came out blank. A URL is now
 * made once per distinct file and revoked only when the file actually changes.
 *
 * Identity is a name/size/modified key rather than the `File` object, so a
 * fresh reference to the same underlying file does not cause a needless
 * revoke-and-recreate.
 */
let previewUrl: string | undefined;
let previewKey: string | undefined;

const fileKey = (file: File): string =>
  `${file.name}:${String(file.size)}:${String(file.lastModified)}`;

const releasePreview = (): void => {
  if (previewUrl !== undefined) {
    URL.revokeObjectURL(previewUrl);
    previewUrl = undefined;
  }
  previewKey = undefined;
};

/** Bytes as KB or MB. Units are left unlocalised; the number is not. */
const formatBytes = (bytes: number, locale: string): string => {
  const megabyte = 1024 * 1024;
  if (bytes >= megabyte) {
    return `${(bytes / megabyte).toLocaleString(locale, { maximumFractionDigits: 1 })} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024)).toLocaleString(locale)} KB`;
};

const renderLocationCard = (state: RailState, text: RailText, locale: string): void => {
  const reading = state.location;

  if (reading === undefined) {
    setCardState("rail-location", state.locating ? "processing" : "neutral");
    show("rail-location-figure", false);
    show("rail-location-readout", false);
    show("rail-location-empty", true);
    return;
  }

  const panel = buildSpatialPanel(reading, state.nearbyMarkers);
  const figure = byId("rail-location-figure");
  if (figure !== undefined) figure.innerHTML = panel.svg;

  setText(
    "rail-location-coords",
    `${formatCoordinate(reading.lat, "lat")}  ${formatCoordinate(reading.lon, "lon")}`,
  );

  // An accuracy the device never stated is reported as unstated rather than
  // rounded to something that looks like a measurement.
  const accuracy = reading.accuracyMetres;
  setText(
    "rail-location-accuracy",
    panel.accuracyDrawn && accuracy !== undefined
      ? `± ${String(Math.round(accuracy))} m`
      : text("rail.accuracy_unstated"),
  );

  // A typed position is not a measurement, and must never be worded as one.
  setText(
    "rail-location-source",
    reading.source === "device_geolocation"
      ? text("rail.source_device")
      : text("rail.source_manual"),
  );

  setText(
    "rail-location-time",
    new Date(reading.observedAt).toLocaleTimeString(locale, {
      hour: "2-digit",
      minute: "2-digit",
    }),
  );

  show("rail-location-empty", false);
  show("rail-location-figure", true);
  show("rail-location-readout", true);
  // A re-capture is still outstanding work, so the card reports it even though
  // it already has a previous fix to show. Without this, asking for a fresh
  // position looks like nothing happened until it lands.
  setCardState("rail-location", state.locating ? "processing" : "resolved");
};

const renderEvidenceCard = (state: RailState, locale: string): void => {
  const photo = state.photo;
  const hasSelection = photo.fileName !== undefined;

  if (!hasSelection) {
    releasePreview();
    setCardState("rail-evidence", "neutral");
    show("rail-evidence-figure", false);
    show("rail-evidence-readout", false);
    show("rail-evidence-empty", true);
    return;
  }

  // A preview is only possible while the input still holds the file. A draft
  // restored from storage has the name and size but no bytes, so the readout
  // stands alone rather than showing a broken image.
  const image = byId<HTMLImageElement>("rail-evidence-image");
  const file = state.photoFile;
  if (file !== undefined && image !== undefined) {
    const key = fileKey(file);
    if (key !== previewKey) {
      releasePreview();
      previewKey = key;
      previewUrl = URL.createObjectURL(file);
      image.src = previewUrl;
    }
    show("rail-evidence-figure", true);
  } else {
    show("rail-evidence-figure", false);
  }

  setText("rail-evidence-name", photo.fileName ?? "");
  setText(
    "rail-evidence-size",
    photo.byteSize === undefined ? "" : formatBytes(photo.byteSize, locale),
  );

  show("rail-evidence-empty", false);
  show("rail-evidence-readout", true);

  const inFlight =
    photo.phase === "granting" || photo.phase === "sending" || photo.phase === "finalizing";
  setCardState("rail-evidence", inFlight ? "processing" : "resolved");
};

const renderNearbyCard = (state: RailState, text: RailText, locale: string): void => {
  if (state.nearbyLoading) {
    setCardState("rail-nearby", "processing");
    return;
  }

  if (state.nearbyCount === undefined) {
    setCardState("rail-nearby", "neutral");
    show("rail-nearby-count", false);
    show("rail-nearby-empty", true);
    return;
  }

  setText("rail-nearby-count", text("rail.nearby_count", { count: state.nearbyCount }));
  show("rail-nearby-empty", false);
  show("rail-nearby-count", true);
  setCardState("rail-nearby", "resolved");
  void locale;
};

const renderPipelineCard = (state: RailState): void => {
  const reached = STAGE_ORDER.indexOf(state.stage);
  for (const [index, stage] of STAGE_ORDER.entries()) {
    const node = document.querySelector<HTMLElement>(`.rail-stage[data-stage="${stage}"]`);
    if (node === null) continue;
    // Stages not yet reached stay visible but dimmed: seeing the whole path is
    // the point of the card.
    node.classList.toggle("is-current", index === reached);
    node.classList.toggle("is-done", index < reached);
  }
};

/** Renders every card. Safe to call on each render pass. */
export const renderEvidenceRail = (state: RailState, text: RailText, locale: string): void => {
  const rail = byId("evidence-rail");
  if (rail === undefined) return;
  rail.setAttribute("aria-label", text("rail.aria_label"));

  renderLocationCard(state, text, locale);
  renderEvidenceCard(state, locale);
  renderNearbyCard(state, text, locale);
  renderPipelineCard(state);
};
