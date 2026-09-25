/**
 * Issue intelligence drawer.
 *
 * Opens over the graph with the selected node still visible, so the record and
 * the point it came from stay connected.
 *
 * Location is one map, not two pictures of the same point. This drawer used
 * to carry the citizen app's graticule instrument as well, on the principle
 * that drawing no geography claims none — but once a real street map sits
 * beside it that principle is already spent, and the graticule was restating
 * the coordinates printed under it while taking more height than the map.
 * What it alone did carry is kept: the accuracy the device stated is drawn
 * on the map as a circle at true scale, so the marker cannot be read as a
 * precision nobody claimed. `spatial-panel.ts` still serves the citizen
 * app's own rail, where there is no map competing with it.
 *
 * Language discipline: the pipeline reads Captured → Checked → Matched →
 * Routed, each a state in `packages/domain/src/transitions.ts`. There is no
 * "verified" stage because the system has no such state, and classification
 * confidence is shown as a band rather than a percentage — nothing here is
 * calibrated to support "94% likely to be real".
 */

import { DARK_MAP_STYLE, loadMaps } from "../maps-loader.ts";
import { CATEGORY_LABELS } from "./issue-aggregation.ts";
import type { InfrastructureIssue } from "./intelligence.types.ts";

/** The four stages the product actually has. */
const STAGES = [
  { key: "captured", label: "Captured" },
  { key: "checked", label: "Checked" },
  { key: "matched", label: "Matched" },
  { key: "routed", label: "Routed" },
] as const;

/**
 * How far a record has travelled, from its real lifecycle state. A record that
 * is only `created` has not been matched, and the card must not imply it has.
 */
const stageReached = (issue: InfrastructureIssue): number => {
  if (issue.status === "created") return issue.matchState === "match_confirmed" ? 2 : 1;
  return 3;
};

/**
 * Confidence as a band. The classifier reports a number; presenting it as a
 * percentage invites reading it as "how likely this is real", which it is not.
 */
const confidenceBand = (value: number): string =>
  value >= 0.85 ? "High" : value >= 0.7 ? "Medium" : "Low";

const element = (tag: string, className?: string, text?: string): HTMLElement => {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const field = (label: string, value: string): HTMLElement => {
  const row = element("div", "detail-row");
  row.append(element("dt", "detail-key", label), element("dd", "detail-value", value));
  return row;
};

const block = (title: string, body: HTMLElement): HTMLElement => {
  const wrap = element("section", "detail-block");
  wrap.append(element("h3", "detail-block-title", title), body);
  return wrap;
};

const formatDate = (iso: string): string =>
  new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

/** Close enough to read a street name at; past this the map is a grey field. */
const MAX_CONTEXT_ZOOM = 17;

/**
 * An accuracy the device actually stated. Absent, non-finite or zero metres
 * is "not stated" rather than a ring of no size, which would read as a
 * measurement this good.
 */
const statedAccuracyMetres = (issue: InfrastructureIssue): number | undefined => {
  const accuracy = issue.locationAccuracyMetres;
  if (accuracy === undefined || !Number.isFinite(accuracy) || accuracy <= 0) return undefined;
  return accuracy;
};

/**
 * The map, the reported point, and — when the device stated one — the
 * accuracy circle at true scale.
 *
 * The circle is the part that matters: a bare marker is a claim of
 * point-precision, and no reading here is that. A deployment with no Maps
 * key renders nothing at all, leaving the coordinates readout below as the
 * complete location view.
 */
const attachDetailMap = async (
  container: HTMLElement,
  caveat: HTMLElement,
  issue: InfrastructureIssue,
  related: readonly InfrastructureIssue[],
): Promise<void> => {
  const result = await loadMaps();
  if (!result.enabled) return;

  const position = { lat: issue.latitude, lng: issue.longitude };
  const map = new result.maps.Map(container, {
    center: position,
    zoom: 15,
    streetViewControl: false,
    fullscreenControl: false,
    mapTypeControl: false,
    // intelligence.html is a fixed dark surface with no light variant, so
    // this map is always styled dark rather than checking the system theme.
    styles: [...DARK_MAP_STYLE],
  });
  new result.maps.Marker({ map, position });

  // Same white-at-low-opacity ring `.sp-accuracy` draws in the citizen rail,
  // so the two surfaces say uncertainty the same way.
  const accuracy = statedAccuracyMetres(issue);
  if (accuracy !== undefined) {
    const ring = new result.maps.Circle({
      map,
      center: position,
      radius: accuracy,
      fillColor: "#ffffff",
      fillOpacity: 0.08,
      strokeColor: "#ffffff",
      strokeOpacity: 0.5,
      strokeWeight: 1,
      clickable: false,
    });
    // Framed around the ring so it is never cropped — then clamped, because
    // a ring of a few metres fits at a zoom with no street left on screen,
    // and the streets are the context this map exists to give. Clamped once,
    // after the fit, so a reader can still zoom further by hand.
    const bounds = ring.getBounds();
    if (bounds !== null) {
      map.fitBounds(bounds, 24);
      result.maps.event.addListenerOnce(map, "idle", () => {
        const zoom = map.getZoom();
        if (zoom !== undefined && zoom > MAX_CONTEXT_ZOOM) map.setZoom(MAX_CONTEXT_ZOOM);
      });
    }
  }

  for (const other of related) {
    new result.maps.Marker({
      map,
      position: { lat: other.latitude, lng: other.longitude },
      opacity: 0.6,
    });
  }
  container.hidden = false;
  caveat.hidden = false;
};

export const renderIssueDetail = (
  host: HTMLElement,
  issue: InfrastructureIssue,
  related: readonly InfrastructureIssue[],
): void => {
  const frame = document.createDocumentFragment();

  const head = element("header", "detail-head");
  const severity = element("span", "detail-severity", issue.severity.toUpperCase());
  severity.dataset["severity"] = issue.severity;
  head.append(
    severity,
    element("h2", "detail-title", issue.title),
    element(
      "p",
      "detail-place",
      `${issue.locality ?? issue.city} · ${issue.city} · ${issue.state}`,
    ),
    element("p", "detail-id", issue.id),
  );
  frame.append(head);

  frame.append(element("p", "detail-description", issue.description));

  // ── Location evidence ──
  const accuracy = statedAccuracyMetres(issue);
  const mapContainer = element("div", "detail-map");
  mapContainer.hidden = true;
  const mapCaveat = element(
    "p",
    "detail-caveat",
    accuracy === undefined
      ? "The marker is the position as reported. This device stated no accuracy, so how close it is cannot be shown."
      : `The circle is the accuracy the device stated, drawn to scale. The problem is somewhere inside it, not exactly at the marker.`,
  );
  mapCaveat.hidden = true;
  const spatial = element("div", "detail-spatial");
  const readout = element("dl", "detail-fields");
  readout.append(
    field("Coordinates", `${issue.latitude.toFixed(4)}° N  ${issue.longitude.toFixed(4)}° E`),
    field("Accuracy", accuracy === undefined ? "Not stated" : `± ${String(accuracy)} m`),
    field(
      "Captured",
      issue.locationCaptureMethod === "device" ? "Measured by device" : "Placed by hand",
    ),
  );
  spatial.append(mapContainer, mapCaveat, readout);
  frame.append(block("Location evidence", spatial));

  // ── Signal ──
  const signal = element("dl", "detail-fields");
  signal.append(
    field(
      "Citizen reports",
      `${String(issue.citizenReportsCount)} ${issue.citizenReportsCount === 1 ? "report" : "reports"}`,
    ),
    field(
      "People potentially affected",
      `~${issue.estimatedPeopleAffected.toLocaleString("en-IN")}`,
    ),
    field("First reported", formatDate(issue.reportedAt)),
    field("Last updated", formatDate(issue.updatedAt)),
  );
  frame.append(block("Signal", signal));

  // ── Classification and match ──
  const classification = element("dl", "detail-fields");
  classification.append(
    field("Proposed category", CATEGORY_LABELS[issue.category]),
    field("Classifier confidence", confidenceBand(issue.classificationConfidence)),
    field(
      "Match state",
      issue.matchState.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()),
    ),
    field(
      "Related reports merged",
      related.length === 0 ? "None" : `${String(related.length)} in this cluster`,
    ),
  );
  const note = element(
    "p",
    "detail-caveat",
    "A proposed category is a suggestion for a person to confirm, not a finding.",
  );
  const classBlock = element("div");
  classBlock.append(classification, note);
  frame.append(block("Classification", classBlock));

  // ── Pipeline ──
  const reached = stageReached(issue);
  const pipeline = element("ol", "detail-pipeline");
  for (const [index, stage] of STAGES.entries()) {
    const item = element("li", "detail-stage", stage.label);
    if (index === reached) item.classList.add("is-current");
    if (index < reached) item.classList.add("is-done");
    pipeline.append(item);
  }
  const routing = element("div");
  routing.append(
    pipeline,
    element("p", "detail-department", issue.department),
    element(
      "p",
      "detail-caveat",
      "Departments in this demonstration are simulated. No government system is contacted.",
    ),
  );
  frame.append(block("Routing", routing));

  host.replaceChildren(frame);
  void attachDetailMap(mapContainer, mapCaveat, issue, related);
};
