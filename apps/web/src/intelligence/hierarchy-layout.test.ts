/**
 * Layout geometry (Public Intelligence).
 *
 * The layout makes two visual claims: that nodes do not overlap, and that a
 * node's *area* is proportional to its count. The second is the one that
 * matters for honesty — encoding a count as radius overstates large values by
 * their square, which is how a bubble chart lies without anyone editing a
 * number.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { clearance, labelSide, layoutRing, radiiFor, ringRadiusFor } from "./hierarchy-layout.ts";

const OPTIONS = { extent: 320, focusRadius: 62, minRadius: 10, maxRadius: 48, gap: 14 };

const input = (values: readonly number[]) =>
  values.map((value, index) => ({ id: `n${String(index)}`, value }));

test("PI layout: area is proportional to count, not radius", () => {
  // Four times the issues must mean four times the ink. A radius encoding
  // would make this node look sixteen times worse than it is.
  const [small, large] = radiiFor([25, 100], 0, 40);
  const areaRatio = ((large ?? 0) / (small ?? 1)) ** 2;
  assert.ok(
    Math.abs(areaRatio - 4) < 0.001,
    `expected 4x the area for 4x the count, got ${areaRatio.toFixed(3)}x`,
  );
});

test("PI layout: the minimum radius keeps a one-issue node clickable", () => {
  const radii = radiiFor([1, 92], 10, 48);
  assert.ok((radii[0] ?? 0) >= 10, "a single-issue node must not vanish");
  assert.ok((radii[1] ?? 0) <= 48);
});

test("PI layout: an all-zero set does not divide by zero", () => {
  const radii = radiiFor([0, 0, 0], 10, 48);
  assert.ok(
    radii.every((r) => Number.isFinite(r)),
    `got ${radii.join(", ")}`,
  );
});

test("PI layout: siblings never overlap", () => {
  // Ten states with a heavy tail is the real shape of the country view.
  const placed = layoutRing(input([92, 74, 68, 51, 30, 28, 26, 24, 18, 17]), OPTIONS);
  assert.equal(placed.length, 10);
  for (let i = 0; i < placed.length; i += 1) {
    for (let j = i + 1; j < placed.length; j += 1) {
      const gap = clearance(placed[i]!, placed[j]!);
      assert.ok(
        gap > -0.01,
        `${placed[i]!.id} and ${placed[j]!.id} overlap by ${(-gap).toFixed(2)}`,
      );
    }
  }
});

test("PI layout: children never overlap the focus node at the centre", () => {
  const placed = layoutRing(input([92, 74, 68, 51, 30]), OPTIONS);
  for (const node of placed) {
    const fromCentre = Math.hypot(node.x, node.y) - node.r;
    assert.ok(
      fromCentre >= OPTIONS.focusRadius - 0.01,
      `${node.id} reaches inside the focus node by ${(OPTIONS.focusRadius - fromCentre).toFixed(2)}`,
    );
  }
});

test("PI layout: a single child is still placed on the ring, not at the centre", () => {
  const placed = layoutRing(input([12]), OPTIONS);
  assert.equal(placed.length, 1);
  assert.ok(Math.hypot(placed[0]!.x, placed[0]!.y) > OPTIONS.focusRadius);
});

test("PI layout: no child out-measures its own parent", () => {
  // A child drawn larger than the node it belongs to inverts the hierarchy.
  const placed = layoutRing(input([500, 1, 1]), OPTIONS);
  for (const node of placed)
    assert.ok(node.r < OPTIONS.focusRadius, `${node.id} is r=${String(node.r)}`);
});

test("PI layout: many small siblings still fit without overlapping", () => {
  // Eleven issues under one category is a real case from the dataset.
  const placed = layoutRing(input(Array.from({ length: 11 }, () => 1)), OPTIONS);
  for (let i = 0; i < placed.length; i += 1) {
    for (let j = i + 1; j < placed.length; j += 1) {
      assert.ok(clearance(placed[i]!, placed[j]!) > -0.01, "small siblings overlap");
    }
  }
});

test("PI layout: the first child starts at the top of the ring", () => {
  // Largest first, at twelve o'clock: the biggest number should be where the
  // eye lands, and a stable start angle keeps nodes in place across renders.
  const placed = layoutRing(input([92, 74, 68]), OPTIONS);
  const first = placed[0]!;
  assert.ok(
    Math.abs(first.x) < 1,
    `expected the first node centred on x, got ${first.x.toFixed(2)}`,
  );
  assert.ok(first.y < 0, "expected the first node above centre");
});

test("PI layout: placement is deterministic", () => {
  const once = layoutRing(input([92, 74, 68, 51]), OPTIONS);
  const twice = layoutRing(input([92, 74, 68, 51]), OPTIONS);
  assert.deepEqual(once, twice, "the same input must always produce the same picture");
});

test("PI layout: an empty level produces no nodes rather than throwing", () => {
  assert.deepEqual(layoutRing([], OPTIONS), []);
});

test("PI layout: the ring tightens to fit rather than always using the extent", () => {
  // Three small nodes should sit closer in than ten large ones.
  const few = layoutRing(input([2, 2, 2]), OPTIONS);
  const many = layoutRing(input(Array.from({ length: 14 }, () => 60)), OPTIONS);
  const radiusOf = (nodes: readonly { x: number; y: number }[]) =>
    Math.hypot(nodes[0]?.x ?? 0, nodes[0]?.y ?? 0);
  assert.ok(radiusOf(few) < radiusOf(many), "a sparse level should not be flung to the edge");
});

test("PI layout: ringRadiusFor respects the lower bound it is given", () => {
  const radius = ringRadiusFor([10, 10, 10], 14, 200);
  assert.ok(radius >= 200, `expected at least the floor, got ${radius.toFixed(1)}`);
});

test("PI layout: a label never points back into the centre", () => {
  // A node at twelve o'clock hanging its label below itself puts that text on
  // the focus node. Every node in the upper arc must label upward instead.
  const placed = layoutRing(input([92, 74, 68, 51, 30, 28, 26, 24]), OPTIONS);
  for (const node of placed) {
    const side = labelSide(node.angle);
    // Above centre means a negative y in SVG coordinates.
    if (node.y < -node.r) {
      assert.equal(side, "above", `a node at the top labelled ${side}`);
    }
    if (node.y > node.r) {
      assert.equal(side, "below", `a node at the bottom labelled ${side}`);
    }
  }
});

test("PI layout: siblings are spaced, not merely non-overlapping", () => {
  // Touching circles read as clutter. The two-child case is the one that used
  // to collapse onto the focus node, so it is the one worth pinning.
  const placed = layoutRing(input([11, 5]), OPTIONS);
  for (const node of placed) {
    const fromFocusEdge = Math.hypot(node.x, node.y) - node.r - OPTIONS.focusRadius;
    assert.ok(
      fromFocusEdge > OPTIONS.gap,
      `only ${fromFocusEdge.toFixed(1)}px of clear space around ${node.id}`,
    );
  }
});
