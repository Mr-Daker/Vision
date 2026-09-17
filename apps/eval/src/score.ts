/**
 * Turning a run into figures (roadmap V046).
 *
 * All of the refusals live in `@vision/domain`'s evaluation module; this file
 * only decides what goes into which denominator. Two of those decisions matter
 * more than the arithmetic:
 *
 *  * **A fallback category is never scored as an answer.** `runMatchingStage`
 *    applies a proposed category only at the `high` band and otherwise keeps
 *    the deployment's fallback. On this corpus the fallback is a real category
 *    id, so a report whose reviewed label happens to equal the fallback would
 *    score as correct while nothing classified it. Below the high band the
 *    system is recorded as having abstained, whatever the fallback says.
 *
 *  * **The model's answer and the system's answer are scored separately.** The
 *    model proposes; the high-band gate decides. Those diverge by design, and
 *    collapsing them would make the gate invisible.
 */

import {
  abstentionCoverageOf,
  figureOf,
  labelAuthorityOf,
  matchingFigures,
  scoreField,
  type AbstentionCoverage,
  type FieldOutcome,
  type Figure,
  type LabelAuthority,
  type MatchingFigures,
  type PairObservation,
} from "@vision/domain";
import type { EvaluationRow, RowObservation } from "@vision/adapters";
import type { RoutingResult } from "@vision/adapters";

export type RoutingProbe = {
  readonly endToEnd: RoutingResult | undefined;
  readonly fromReviewedLabel: RoutingResult | { readonly probeFailed: string } | undefined;
};

export type RowScore = {
  readonly reportId: string;
  readonly language: string;
  readonly authority: LabelAuthority;
  /** What the model said, at whatever certainty band it said it. */
  readonly proposedCategory: FieldOutcome | undefined;
  readonly proposedDefect: FieldOutcome | undefined;
  /** What the system committed. An abstention below the high band. */
  readonly appliedCategory: FieldOutcome | undefined;
  readonly certaintyBand: string | undefined;
  readonly systemAbstained: boolean;
  readonly routingEndToEnd: "correct" | "incorrect" | "unscorable";
  readonly routingFromReviewedLabel: "correct" | "incorrect" | "unscorable";
  readonly routingDetail: string;
};

const routingVerdict = (
  expected: EvaluationRow["expected"],
  routing: RoutingResult | { readonly probeFailed: string } | undefined,
): { readonly verdict: "correct" | "incorrect" | "unscorable"; readonly detail: string } => {
  if (routing === undefined) {
    return { verdict: "unscorable", detail: "no routing was produced for this report" };
  }
  if ("probeFailed" in routing) {
    return { verdict: "unscorable", detail: `the probe did not run: ${routing.probeFailed}` };
  }
  const reviewOutcomes = new Set([
    "unknown_owner_review",
    "ambiguous_owner_review",
    "no_directory_entry",
  ]);
  if (expected.routing_review_expected === true) {
    return reviewOutcomes.has(routing.outcome)
      ? { verdict: "correct", detail: `left for operational review (${routing.outcome})` }
      : {
          verdict: "incorrect",
          detail: `the corpus records a deliberate directory gap here, and this was routed to '${routing.outcome === "routed" ? routing.departmentId : routing.outcome}' instead of being left for review`,
        };
  }
  if (expected.department_id === undefined) {
    return {
      verdict: "unscorable",
      detail: "the corpus names no expected custodian for this report",
    };
  }
  if (routing.outcome !== "routed") {
    return {
      verdict: "incorrect",
      detail: `expected '${expected.department_id}' and nothing was routed (${routing.outcome})`,
    };
  }
  return routing.departmentId === expected.department_id
    ? { verdict: "correct", detail: `routed to '${routing.departmentId}'` }
    : {
        verdict: "incorrect",
        detail: `expected '${expected.department_id}', routed to '${routing.departmentId}'`,
      };
};

export const scoreRow = (
  row: EvaluationRow,
  observation: RowObservation | undefined,
  probe: RoutingProbe,
): RowScore => {
  const authority = labelAuthorityOf(row);
  const proposal = observation?.proposal;
  const band = proposal?.certainty_band;
  /**
   * The classifier never answered.
   *
   * Kept apart from an abstention, which is the model declining and is the
   * behaviour V002 row 10 asks for. A 503 is a property of an afternoon. The
   * first real run had three of eight calls fail, and counting those as
   * abstentions would have reported a provider outage as the system behaving
   * carefully.
   */
  const noAnswer =
    proposal === undefined && observation?.classificationUnavailableReason !== undefined;
  // Below the high band the pipeline keeps its fallback, so the system has
  // declined — whatever the fallback string happens to be.
  const systemAbstained = proposal === undefined || band !== "high";

  const endToEnd = routingVerdict(row.expected, probe.endToEnd);
  const fromLabel = routingVerdict(row.expected, probe.fromReviewedLabel);

  if (!authority.usable) {
    return {
      reportId: row.report_id,
      language: row.source_language,
      authority,
      proposedCategory: undefined,
      proposedDefect: undefined,
      appliedCategory: undefined,
      certaintyBand: band,
      systemAbstained,
      routingEndToEnd: "unscorable",
      routingFromReviewedLabel: "unscorable",
      routingDetail: `withheld — ${authority.reason}`,
    };
  }

  if (noAnswer) {
    const reason = `the classifier returned no proposal for this report (${observation?.classificationUnavailableReason ?? "unknown"}), so there is no answer to compare against`;
    const unscorable = { kind: "unscorable", reason } as const;
    return {
      reportId: row.report_id,
      language: row.source_language,
      authority,
      proposedCategory: unscorable,
      proposedDefect: unscorable,
      appliedCategory: unscorable,
      certaintyBand: band,
      systemAbstained,
      routingEndToEnd: endToEnd.verdict,
      routingFromReviewedLabel: fromLabel.verdict,
      routingDetail: `end to end: ${endToEnd.detail}. From the reviewed label: ${fromLabel.detail}`,
    };
  }

  return {
    reportId: row.report_id,
    language: row.source_language,
    authority,
    proposedCategory: scoreField({
      expected: row.expected.category_id,
      produced: proposal?.proposed_category_id,
      abstained: proposal === undefined,
      unresolvedLabels: row.unresolved_labels,
      fieldName: "category_id",
    }),
    proposedDefect: scoreField({
      expected: row.expected.defect_id,
      produced: proposal?.proposed_defect_id,
      abstained: proposal === undefined,
      unresolvedLabels: row.unresolved_labels,
      fieldName: "defect_id",
    }),
    appliedCategory: scoreField({
      expected: row.expected.category_id,
      produced: systemAbstained ? undefined : observation?.appliedCategory,
      abstained: systemAbstained,
      unresolvedLabels: row.unresolved_labels,
      fieldName: "category_id",
    }),
    certaintyBand: band,
    systemAbstained,
    routingEndToEnd: endToEnd.verdict,
    routingFromReviewedLabel: fromLabel.verdict,
    routingDetail: `end to end: ${endToEnd.detail}. From the reviewed label: ${fromLabel.detail}`,
  };
};

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

const matchesOf = (outcomes: readonly (FieldOutcome | undefined)[]): Figure => {
  const scorable = outcomes.filter(
    (outcome): outcome is FieldOutcome => outcome !== undefined && outcome.kind !== "unscorable",
  );
  return figureOf(scorable.filter((outcome) => outcome.kind === "match").length, scorable.length);
};

export type CellKey = { readonly language: string; readonly category: string };

export type EvaluationSummary = {
  readonly scoredRows: readonly RowScore[];
  readonly withheldRows: readonly RowScore[];
  readonly proposedCategory: Figure;
  readonly proposedDefect: Figure;
  readonly appliedCategory: Figure;
  readonly byLanguage: ReadonlyMap<string, Figure>;
  readonly byCategory: ReadonlyMap<string, Figure>;
  readonly abstention: AbstentionCoverage;
  readonly routingEndToEnd: Figure;
  readonly routingFromReviewedLabel: Figure;
  readonly matching: MatchingFigures;
};

export const summarise = (input: {
  readonly rows: readonly EvaluationRow[];
  readonly scores: readonly RowScore[];
  readonly duplicatePairs: readonly PairObservation[];
  readonly distinctPairs: readonly PairObservation[];
}): EvaluationSummary => {
  const scored = input.scores.filter((score) => score.authority.usable);
  const withheld = input.scores.filter((score) => !score.authority.usable);
  const labelOf = new Map(input.rows.map((row) => [row.report_id, row.expected.category_id]));

  const byLanguage = new Map<string, Figure>();
  for (const language of new Set(scored.map((score) => score.language))) {
    byLanguage.set(
      language,
      matchesOf(
        scored
          .filter((score) => score.language === language)
          .map((score) => score.proposedCategory),
      ),
    );
  }

  const byCategory = new Map<string, Figure>();
  const categories = new Set(
    scored.map((score) => labelOf.get(score.reportId) ?? "(abstention expected)"),
  );
  for (const category of categories) {
    byCategory.set(
      category,
      matchesOf(
        scored
          .filter((score) => (labelOf.get(score.reportId) ?? "(abstention expected)") === category)
          .map((score) => score.proposedCategory),
      ),
    );
  }

  const routingFigure = (key: "routingEndToEnd" | "routingFromReviewedLabel"): Figure => {
    const scorable = scored.filter((score) => score[key] !== "unscorable");
    return figureOf(scorable.filter((score) => score[key] === "correct").length, scorable.length);
  };

  return {
    scoredRows: scored,
    withheldRows: withheld,
    proposedCategory: matchesOf(scored.map((score) => score.proposedCategory)),
    proposedDefect: matchesOf(scored.map((score) => score.proposedDefect)),
    appliedCategory: matchesOf(scored.map((score) => score.appliedCategory)),
    byLanguage,
    byCategory,
    abstention: abstentionCoverageOf(
      scored
        .map((score) => score.appliedCategory)
        .filter((outcome): outcome is FieldOutcome => outcome !== undefined),
    ),
    routingEndToEnd: routingFigure("routingEndToEnd"),
    routingFromReviewedLabel: routingFigure("routingFromReviewedLabel"),
    matching: matchingFigures({
      duplicatePairs: input.duplicatePairs,
      distinctPairs: input.distinctPairs,
    }),
  };
};
