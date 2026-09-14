/**
 * Issue intelligence drawer.
 *
 * Opens over the graph with the selected node still visible, so the record and
 * the point it came from stay connected.
 *
 * The spatial panel is the citizen app's instrument, reused rather than
 * reimplemented — a second spatial language would be a second thing to trust.
 * It draws only what the record states: a real graticule, the accuracy circle
 * at true scale, related reports at true bearing.
 *
 * Language discipline: the pipeline reads Captured → Checked → Matched →
 * Routed, each a state in `packages/domain/src/transitions.ts`. There is no
 * "verified" stage because the system has no such state, and classification
 * confidence is shown as a band rather than a percentage — nothing here is
 * calibrated to support "94% likely to be real".
 */

import { buildSpatialPanel, type NearbyMarker } from "../spatial-panel.ts";
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

  // ── Location evidence, drawn by the citizen app's own instrument ──
  const markers: readonly NearbyMarker[] = related.map((other) => ({
    lat: other.latitude,
    lon: other.longitude,
  }));
  const panel = buildSpatialPanel(
    {
      lat: issue.latitude,
      lon: issue.longitude,
      source: issue.locationCaptureMethod === "device" ? "device_geolocation" : "manual_pin",
      observedAt: issue.reportedAt,
      ...(issue.locationAccuracyMetres === undefined
        ? {}
        : { accuracyMetres: issue.locationAccuracyMetres }),
    },
    markers,
  );

  const figure = element("div", "detail-figure");
  figure.innerHTML = panel.svg;
  const spatial = element("div", "detail-spatial");
  const readout = element("dl", "detail-fields");
  readout.append(
    field("Coordinates", `${issue.latitude.toFixed(4)}° N  ${issue.longitude.toFixed(4)}° E`),
    field(
      "Accuracy",
      panel.accuracyDrawn && issue.locationAccuracyMetres !== undefined
        ? `± ${String(issue.locationAccuracyMetres)} m`
        : "Not stated",
    ),
    field(
      "Captured",
      issue.locationCaptureMethod === "device" ? "Measured by device" : "Placed by hand",
    ),
  );
  spatial.append(figure, readout);
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
};
