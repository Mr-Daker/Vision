/**
 * The two scoring decisions that are easy to get wrong (roadmap V046).
 *
 * Both were found by running the harness rather than by reasoning about it,
 * which is why they have tests: a fallback category that coincides with a
 * label, and a provider outage that looks exactly like an abstention. Each one
 * would have made the system look better than it is, quietly.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { EvaluationRow, RowObservation } from "@vision/adapters";

import { scoreRow } from "./score.ts";

const row = (overrides: Partial<EvaluationRow> = {}): EvaluationRow => ({
  report_id: "row-1",
  source_language: "en-IN",
  interface_locale: "en-IN",
  asset_id: "asset-1",
  observed: { lon: 75.6, lat: 17.8, accuracy_m: 12, observed_at: "2026-09-01T00:00:00Z" },
  text: "the drain outside the school gate is blocked",
  expected: { category_id: "sanitation", defect_id: "blocked_drain" },
  reviewer: {
    decision: "accepted",
    reviewed_by: "team-reviewer-1",
    reviewed_at: "2026-09-01T00:00:00Z",
    notes: "team review",
  },
  unresolved_labels: [],
  ...overrides,
});

const observation = (overrides: Partial<RowObservation> = {}): RowObservation => ({
  reportId: "row-1",
  submissionId: "sub-1",
  sourceLanguage: "en-IN",
  stageStatus: "completed",
  failureReason: undefined,
  assignment: "created",
  issueId: "issue-1",
  candidateCount: 0,
  proposal: undefined,
  classificationUnavailableReason: undefined,
  appliedCategory: undefined,
  routing: undefined,
  notes: [],
  ...overrides,
});

const proposal = (band: "low" | "medium" | "high", category: string) => ({
  taxonomy_version: "demo-taxonomy.v1",
  proposed_category_id: category,
  certainty_band: band,
  requires_review: band !== "high",
  model_name: "test-model",
  prompt_version: "classify.v1",
  input_hash: "hash",
});

test("a fallback category that happens to equal the label is not scored as an answer", () => {
  // The pipeline applies a proposal only at the high band; below it the issue
  // keeps the deployment fallback, which on this deployment is a real category
  // id. Here the fallback is exactly the reviewed label.
  const score = scoreRow(
    row(),
    observation({
      proposal: proposal("medium", "structural") as never,
      appliedCategory: "sanitation",
    }),
    { endToEnd: undefined, fromReviewedLabel: undefined },
  );
  assert.equal(score.systemAbstained, true);
  assert.equal(score.appliedCategory?.kind, "abstained_where_labelled");
  assert.notEqual(score.appliedCategory?.kind, "match");
});

test("a high-band proposal is the system's answer and is scored as one", () => {
  const score = scoreRow(
    row(),
    observation({
      proposal: proposal("high", "sanitation") as never,
      appliedCategory: "sanitation",
    }),
    { endToEnd: undefined, fromReviewedLabel: undefined },
  );
  assert.equal(score.systemAbstained, false);
  assert.equal(score.appliedCategory?.kind, "match");
  assert.equal(score.proposedCategory?.kind, "match");
});

test("a provider outage is unscorable, never an abstention", () => {
  const score = scoreRow(
    row(),
    observation({ classificationUnavailableReason: "provider_http_503" }),
    { endToEnd: undefined, fromReviewedLabel: undefined },
  );
  assert.equal(score.proposedCategory?.kind, "unscorable");
  assert.equal(score.appliedCategory?.kind, "unscorable");
  assert.match(
    score.proposedCategory?.kind === "unscorable" ? score.proposedCategory.reason : "",
    /provider_http_503/,
  );
});

test("a row awaiting native review is withheld before anything is scored", () => {
  const score = scoreRow(
    row({
      source_language: "mr-IN",
      reviewer: {
        decision: "accepted",
        reviewed_by: "pending_native_review",
        reviewed_at: null,
        notes: "",
      } as never,
    }),
    observation({
      proposal: proposal("high", "sanitation") as never,
      appliedCategory: "sanitation",
    }),
    { endToEnd: undefined, fromReviewedLabel: undefined },
  );
  assert.equal(score.authority.usable, false);
  assert.equal(score.proposedCategory, undefined);
  assert.equal(score.routingEndToEnd, "unscorable");
});

test("the deliberate directory gap is scored correct only when nothing was routed", () => {
  const gapRow = row({
    expected: { category_id: "sanitation", defect_id: null, routing_review_expected: true },
  });
  const left = scoreRow(gapRow, observation(), {
    endToEnd: {
      outcome: "no_directory_entry",
      recipientMode: "none",
    } as never,
    fromReviewedLabel: undefined,
  });
  assert.equal(left.routingEndToEnd, "correct");

  const routed = scoreRow(gapRow, observation(), {
    endToEnd: {
      outcome: "routed",
      departmentId: "demo-dept-water-sanitation",
      recipientMode: "simulated",
    } as never,
    fromReviewedLabel: undefined,
  });
  assert.equal(routed.routingEndToEnd, "incorrect");
});
