/**
 * The hierarchy constellation.
 *
 * One persistent SVG. Nodes are `<g>` elements keyed by hierarchy id and reused
 * across levels, which is the whole point: when a state is opened it keeps its
 * element and travels to the centre, so the drill-down reads as movement
 * through the data rather than as one picture being swapped for another.
 *
 * ## Why the shapes are scaled rather than resized
 *
 * A node's disc is always drawn at `BASE_RADIUS` and scaled by transform. The
 * obvious alternative — transitioning the circle's `r` — is not
 * compositor-accelerated: the browser recomputes the geometry every frame, and
 * with a dozen circles, their severity arcs and their labels all resizing at
 * once, the drill-down visibly stuttered. `transform` and `opacity` are the
 * only two properties a browser can animate without touching layout, so those
 * are the only two this file animates.
 *
 * Text sits outside the scaled group and keeps its own size. Scaling type along
 * with the disc would make a small node's label unreadable and a large one's
 * gigantic, and the whole point of the label is that it stays legible.
 *
 * ## The choreography
 *
 * Three overlapping phases, because a drill-down is one movement, not three:
 *
 *   0ms    siblings push outward and fade; links fade out
 *   90ms   the opened node travels to the centre and grows
 *   300ms+ its children emerge from beneath it, staggered; links draw in
 *
 * Transitions run through CSSOM. The API's Content-Security-Policy forbids
 * parsed `style` attributes but not CSSOM writes.
 */

import { compactNumber } from "./issue-aggregation.ts";
import { labelSide, layoutRing, type PlacedNode } from "./hierarchy-layout.ts";
import type { HierarchyNode } from "./intelligence.types.ts";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Viewport units. The SVG scales to its container; this is the design frame. */
const VIEW = 760;
const CENTRE = VIEW / 2;

/** Every disc is drawn at this radius and scaled. See the note above. */
const BASE_RADIUS = 64;

/** How far outside the disc the severity arc sits, in base units. */
const ARC_OFFSET = 7;

const FOCUS_RADIUS: Record<HierarchyNode["level"], number> = {
  country: 74,
  state: 66,
  city: 60,
  category: 54,
  issue: 46,
};

/**
 * Timings, in milliseconds. The phases overlap deliberately.
 *
 * A first version ran them in sequence — exits finished at 300ms and arrivals
 * began at 300ms — which left a beat where the frame held nothing but the
 * travelling node. It read as the graph emptying and refilling rather than as
 * one level giving way to the next. Arrivals now begin while the old level is
 * still clearing.
 */
const EXIT_MS = 280;
const ENTER_DELAY = 170;
const ENTER_STAGGER = 38;
const TRAVEL_DELAY = 60;

export type ViewCallbacks = {
  readonly onActivate: (node: HierarchyNode) => void;
  readonly onHover: (node: HierarchyNode | undefined) => void;
};

const el = <K extends keyof SVGElementTagNameMap>(
  name: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] => {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
};

/**
 * Describes a node for a screen reader. Deliberately a sentence rather than a
 * label: "Chennai" alone tells a non-sighted reader nothing the sighted view
 * conveys through size and ring.
 */
const describe = (node: HierarchyNode): string => {
  const noun = node.issueCount === 1 ? "issue" : "issues";
  const parts = [`${node.label}, ${String(node.issueCount)} infrastructure ${noun}`];
  if (node.criticalCount > 0) parts.push(`${String(node.criticalCount)} critical`);
  if (node.level !== "issue" && node.children.length > 0) {
    parts.push(`${String(node.children.length)} below`);
  }
  return `${parts.join(", ")}.`;
};

/**
 * Node labels sit beside the circle, not inside it, and are clipped to the room
 * the node actually has.
 *
 * A fixed 26-character limit was the first attempt and it held up until the
 * issue level: eleven titles around one ring collided into an unreadable mat,
 * because the budget took no account of how many nodes were sharing the
 * circumference. The limit is now derived from the arc each node owns, so a
 * level with six children gets long labels and a level with twelve gets short
 * ones. The full text stays available as the node's accessible name and as its
 * tooltip, so nothing is lost — only shortened.
 */
const LABEL_MAX = 26;
const LABEL_MIN = 9;

/** Below this budget, labels are shown on hover rather than all at once. */
const LABEL_CROWDED = 18;

/** Rough advance width of the label face, in user units per character. */
const CHAR_WIDTH = 6.4;

const labelBudget = (ringRadius: number, count: number): number => {
  if (count <= 1) return LABEL_MAX;
  const arcPerNode = (Math.PI * 2 * ringRadius) / count;
  return Math.max(LABEL_MIN, Math.min(LABEL_MAX, Math.floor(arcPerNode / CHAR_WIDTH)));
};

const clip = (text: string, limit: number): string =>
  text.length <= limit ? text : `${text.slice(0, Math.max(1, limit - 1)).trimEnd()}…`;

/** Arc path for the severity ring, in base units, starting at twelve o'clock. */
const severityArc = (fraction: number): string => {
  if (fraction <= 0) return "";
  // A full circle cannot be drawn as a single arc: sweep 360° and the start and
  // end points coincide, so the browser draws nothing at all.
  const clamped = Math.min(fraction, 0.9999);
  const radius = BASE_RADIUS + ARC_OFFSET;
  const end = clamped * Math.PI * 2 - Math.PI / 2;
  const large = clamped > 0.5 ? 1 : 0;
  return [
    `M 0 ${-radius}`,
    `A ${radius} ${radius} 0 ${String(large)} 1 ${(Math.cos(end) * radius).toFixed(2)} ${(Math.sin(end) * radius).toFixed(2)}`,
  ].join(" ");
};

type NodeParts = {
  readonly group: SVGGElement;
  /** Inner group carrying the scale, so text outside it stays unscaled. */
  readonly shape: SVGGElement;
  readonly circle: SVGCircleElement;
  readonly arc: SVGPathElement;
  readonly label: SVGTextElement;
  readonly value: SVGTextElement;
  /** Native SVG tooltip: appears after the browser's own hover delay. */
  readonly tooltip: SVGTitleElement;
  /** Where this node last sat, so an exit can push it further out. */
  angle: number;
};

export class HierarchyView {
  readonly #svg: SVGSVGElement;
  readonly #links: SVGGElement;
  readonly #nodes: SVGGElement;
  readonly #callbacks: ViewCallbacks;
  readonly #parts = new Map<string, NodeParts>();
  #focusId = "";

  constructor(host: HTMLElement, callbacks: ViewCallbacks) {
    this.#callbacks = callbacks;

    this.#svg = el("svg", {
      class: "hv-svg",
      viewBox: `0 0 ${VIEW} ${VIEW}`,
      role: "group",
      "aria-label": "Infrastructure issue hierarchy",
    });
    this.#links = el("g", { class: "hv-links", "aria-hidden": "true" });
    this.#nodes = el("g", { class: "hv-nodes" });
    this.#svg.append(this.#links, this.#nodes);
    host.replaceChildren(this.#svg);
  }

  /**
   * Draws `focus` at the centre with its children around it.
   *
   * Elements for ids still present are moved, not recreated, so the browser
   * animates them. Anything absent is pushed outward and faded before removal.
   */
  render(focus: HierarchyNode): void {
    const previousFocus = this.#focusId;
    this.#focusId = focus.id;
    const isFirstPaint = previousFocus === "";

    const focusRadius = FOCUS_RADIUS[focus.level];
    const children = focus.children;

    const placed = layoutRing(
      children.map((child) => ({ id: child.id, value: Math.max(child.issueCount, 1) })),
      { extent: CENTRE - 44, focusRadius },
    );

    const live = new Set<string>([focus.id, ...placed.map((p) => p.id)]);

    // Every child shares one ring, so the budget is the same for all of them.
    const first = placed[0];
    const ringRadius = first === undefined ? 0 : Math.hypot(first.x, first.y);
    const limit = labelBudget(ringRadius, placed.length);

    // When the budget collapses this far the labels have stopped being useful:
    // eleven issue titles around one ring clipped to a dozen characters each
    // collided into a mat and said nothing. They are hidden until a node is
    // hovered or focused, which shows one at full length instead of eleven
    // truncated. Nothing is lost — the rail lists every title at this level,
    // and each node keeps its accessible name and tooltip.
    this.#nodes.classList.toggle("is-crowded", limit < LABEL_CROWDED);

    // Exits first: siblings must start moving aside before the opened node
    // arrives, or it lands on top of them.
    this.#retire(live);

    // The node being opened is already on screen, so it travels; on the very
    // first paint there is nothing to travel from.
    this.#place(
      focus,
      { id: focus.id, x: 0, y: 0, r: focusRadius, angle: 0 },
      true,
      isFirstPaint ? 0 : TRAVEL_DELAY,
      LABEL_MAX,
    );

    for (const [index, position] of placed.entries()) {
      const child = children.find((c) => c.id === position.id);
      if (child === undefined) continue;
      // A node returning from below is already placed; it should glide back to
      // its ring position rather than wait behind a stagger meant for arrivals.
      const returning = previousFocus.startsWith(`${child.id}/`) || previousFocus === child.id;
      const delay = returning
        ? TRAVEL_DELAY
        : isFirstPaint
          ? index * ENTER_STAGGER
          : ENTER_DELAY + index * ENTER_STAGGER;
      this.#place(child, position, false, delay, limit);
    }

    this.#drawLinks(placed, focusRadius, isFirstPaint ? 0 : ENTER_DELAY);
  }

  /**
   * Pushes departing nodes outward along their own bearing, then removes them.
   *
   * Fading in place was the first version and it read as the data dissolving.
   * Moving them out along the spoke they arrived on says something truer: they
   * are still there, just no longer the level being looked at.
   */
  #retire(live: ReadonlySet<string>): void {
    for (const [id, parts] of this.#parts) {
      if (live.has(id)) continue;

      const { group } = parts;
      group.classList.add("is-leaving");
      // The node being left behind is usually the previous focus. Keeping the
      // focus class on it means it departs still wearing centre-stage styling.
      group.classList.remove("is-focus", "is-dimmed");
      group.setAttribute("aria-hidden", "true");
      group.tabIndex = -1;
      group.style.transitionDelay = "0ms";
      // Out along its bearing, well past the frame edge.
      const distance = CENTRE * 1.5;
      group.style.transform =
        `translate(${(CENTRE + Math.cos(parts.angle) * distance).toFixed(2)}px, ` +
        `${(CENTRE + Math.sin(parts.angle) * distance).toFixed(2)}px)`;
      group.style.opacity = "0";

      const drop = (): void => {
        group.remove();
        this.#parts.delete(id);
      };
      // `transitionend` can be missed if the element is never painted — a
      // background tab, for instance — and an orphan would still take clicks.
      group.addEventListener("transitionend", drop, { once: true });
      window.setTimeout(drop, EXIT_MS + 250);
    }
  }

  #place(
    node: HierarchyNode,
    at: PlacedNode,
    isFocus: boolean,
    delayMs: number,
    labelLimit: number,
  ): void {
    const existing = this.#parts.get(node.id);
    const parts = existing ?? this.#create(node);
    const isNew = existing === undefined;

    const { group, shape, arc, label, value, tooltip } = parts;
    parts.angle = at.angle;

    // A new child is seeded part of the way out along its own bearing rather
    // than at dead centre. Starting them all stacked under the focus node meant
    // that for the first third of their travel they were invisible beneath it,
    // and the frame looked empty at the exact moment the new level should have
    // been arriving. From here the move reads as an expansion outward.
    if (isNew && !isFocus) {
      const seed = 0.34;
      group.style.transition = "none";
      shape.style.transition = "none";
      group.style.transform =
        `translate(${(CENTRE + at.x * seed).toFixed(2)}px, ` +
        `${(CENTRE + at.y * seed).toFixed(2)}px)`;
      shape.style.transform = `scale(${((at.r / BASE_RADIUS) * 0.5).toFixed(4)})`;
      // Flush the seeded state so the browser has something to transition from.
      void group.getBoundingClientRect();
      group.style.transition = "";
      shape.style.transition = "";
    }

    group.classList.toggle("is-focus", isFocus);
    group.classList.remove("is-leaving");
    group.dataset["level"] = node.level;
    group.setAttribute("aria-label", describe(node));
    group.removeAttribute("aria-hidden");
    // Only the children are actionable; the focus is where you already are.
    group.tabIndex = isFocus ? -1 : 0;
    group.setAttribute("role", isFocus ? "img" : "button");

    // Always written, never left to persist: a stale stagger from a previous
    // level otherwise delays this node's next move, including its exit.
    group.style.transitionDelay = `${String(delayMs)}ms`;
    group.style.transform = `translate(${(CENTRE + at.x).toFixed(2)}px, ${(CENTRE + at.y).toFixed(2)}px)`;
    group.style.opacity = "1";

    // Scale rather than a new radius: composited, so it stays smooth.
    const scale = at.r / BASE_RADIUS;
    shape.style.transitionDelay = `${String(delayMs)}ms`;
    shape.style.transform = `scale(${scale.toFixed(4)})`;

    // Severity as one restrained encoding: the share of this node's issues that
    // are critical or high, drawn as an arc on its ring. A colour ramp across
    // four levels would turn the country view into confetti.
    const serious = node.criticalCount + node.highCount;
    const fraction = node.issueCount === 0 ? 0 : serious / node.issueCount;
    arc.setAttribute("d", severityArc(fraction));
    arc.setAttribute("data-weight", node.criticalCount > 0 ? "critical" : "high");

    label.textContent = isFocus ? node.label : clip(node.label, labelLimit);
    label.style.transitionDelay = `${String(delayMs)}ms`;

    // The label goes on whichever side of the node faces *away* from the
    // centre. Hanging every label below its node meant a node at twelve
    // o'clock pointed its label straight down into the focus node, which is
    // exactly where "Chennai" landed on top of Tamil Nadu's ring. Outward, it
    // has the whole frame to sit in.
    const above = !isFocus && labelSide(at.angle) === "above";
    label.style.transform = `translateY(${(above ? -(at.r + 12) : at.r + 22).toFixed(1)}px)`;

    // An issue node counts the citizen reports behind it; anything higher up
    // counts the issues beneath it.
    value.textContent =
      node.level === "issue"
        ? String(node.issue?.citizenReportsCount ?? 0)
        : compactNumber(node.issueCount);
    // Below about 26px a number inside the disc is unreadable, so it is simply
    // not drawn rather than shrunk into illegibility.
    value.style.opacity = isFocus || at.r > 26 ? "1" : "0";
    value.setAttribute("font-size", isFocus ? "26" : "17");

    tooltip.textContent = describe(node);
    this.#parts.set(node.id, parts);
  }

  #create(node: HierarchyNode): NodeParts {
    const group = el("g", { class: "hv-node" });
    const shape = el("g", { class: "hv-shape" });
    // `vector-effect` keeps strokes one pixel wide however far the shape is
    // scaled; without it a small node's outline all but disappears.
    const circle = el("circle", {
      class: "hv-disc",
      r: BASE_RADIUS,
      "vector-effect": "non-scaling-stroke",
    });
    const arc = el("path", { class: "hv-arc", d: "", "vector-effect": "non-scaling-stroke" });
    const value = el("text", { class: "hv-value", "text-anchor": "middle", y: 6 });
    const label = el("text", { class: "hv-label", "text-anchor": "middle" });
    const tooltip = el("title");

    shape.append(circle, arc);
    group.append(tooltip, shape, value, label);

    // Starts collapsed under the centre so it grows outward into place.
    group.style.transform = `translate(${String(CENTRE)}px, ${String(CENTRE)}px)`;
    group.style.opacity = "0";
    shape.style.transform = "scale(0.12)";

    const activate = (): void => this.#callbacks.onActivate(node);
    group.addEventListener("click", activate);
    group.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      // Space scrolls the page by default, which would drag the graph away
      // under the very node being activated.
      event.preventDefault();
      activate();
    });
    group.addEventListener("pointerenter", () => this.#callbacks.onHover(node));
    group.addEventListener("pointerleave", () => this.#callbacks.onHover(undefined));
    group.addEventListener("focus", () => this.#callbacks.onHover(node));
    group.addEventListener("blur", () => this.#callbacks.onHover(undefined));

    this.#nodes.append(group);
    // Forces the browser to register the collapsed start state before the new
    // transform lands; without it the first paint jumps straight into place.
    void group.getBoundingClientRect();
    return { group, shape, circle, arc, label, value, tooltip, angle: 0 };
  }

  /**
   * Spokes from the focus to each child, faded in behind the arriving nodes.
   *
   * Rebuilt each level rather than tweened — a spoke has no identity to
   * preserve — but the group fades so they do not snap into a frame where the
   * nodes are still travelling.
   */
  #drawLinks(placed: readonly PlacedNode[], focusRadius: number, delayMs: number): void {
    const lines = placed.map((position) => {
      const distance = Math.hypot(position.x, position.y) || 1;
      const unitX = position.x / distance;
      const unitY = position.y / distance;
      return el("line", {
        class: "hv-link",
        x1: (CENTRE + unitX * focusRadius).toFixed(2),
        y1: (CENTRE + unitY * focusRadius).toFixed(2),
        x2: (CENTRE + position.x - unitX * position.r).toFixed(2),
        y2: (CENTRE + position.y - unitY * position.r).toFixed(2),
      });
    });

    this.#links.style.transitionDelay = "0ms";
    this.#links.style.opacity = "0";
    // One frame later, so the browser has a zero-opacity state to start from.
    requestAnimationFrame(() => {
      this.#links.replaceChildren(...lines);
      this.#links.style.transitionDelay = `${String(delayMs)}ms`;
      this.#links.style.opacity = "1";
    });
  }

  /** Dims everything except a node and its immediate relations. */
  emphasise(id: string | undefined): void {
    for (const [nodeId, parts] of this.#parts) {
      const related = id === undefined || nodeId === id || nodeId === this.#focusId;
      parts.group.classList.toggle("is-dimmed", !related);
    }
    this.#links.classList.toggle("is-dimmed", id !== undefined);
  }

  /** Moves keyboard focus onto a node, used after a drill-down. */
  focusNode(id: string): void {
    this.#parts.get(id)?.group.focus();
  }
}
