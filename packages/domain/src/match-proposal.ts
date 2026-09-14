/**
 * Duplicate-match proposals (roadmap V027).
 *
 * This produces **advice with its reasons attached**, never a decision that
 * takes effect on its own. V028 is what commits anything, and it must refuse
 * to act on an `ambiguous` proposal — which is why `mayMerge` is a literal
 * `false` on that branch rather than a value someone could set.
 *
 * How the signals are weighted, and why:
 *
 * - **Category** is a gate, not a score. A different defect at the same place
 *   is a *different problem*; no amount of proximity or similarity may collapse
 *   the two. This is the hard negative the task exists to get right.
 * - **Asset identity** is the strongest positive signal: it names the physical
 *   thing rather than a place near it, so it can carry a match on its own.
 * - **Semantics** is the main discriminator among nearby candidates.
 * - **Proximity** is the weakest signal and is never sufficient alone. Two
 *   unrelated problems metres apart are ordinary; a shared location says
 *   little more than "both are in this street".
 * - **Media reuse** is reported as a reason but decides nothing: identical
 *   bytes mean one photograph submitted twice, which is not evidence that two
 *   reports describe one problem (V021 §4, V025).
 * - **Recurrence** always defers to a person, per the domain contract.
 *
 * No score is published. Where two candidates are close enough that a ranking
 * would be arbitrary, the answer is `ambiguous`, because a coin toss presented
 * as a decision is worse than saying it is unclear.
 */

import type { RecurrenceClassification } from "./participation.ts";

/** Bumped whenever a rule or threshold below changes; recorded on every proposal. */
export const MATCHER_VERSION = "matcher.v1";

export type MatchThresholds = {
  /** Cosine distance at or below which two texts are "about the same thing". */
  readonly maxSemanticDistance: number;
  /** Base metres within which two reports may concern one issue, before accuracy is added. */
  readonly maxDistanceMetres: number;
  /** Semantic gap below which two candidates are too close to separate. */
  readonly minSemanticSeparation: number;
  /** Cosine distance above which the meanings are clearly different. */
  readonly clearlyDifferentSemanticDistance: number;
};

export const DEFAULT_THRESHOLDS: MatchThresholds = {
  maxSemanticDistance: 0.25,
  maxDistanceMetres: 200,
  minSemanticSeparation: 0.05,
  clearlyDifferentSemanticDistance: 0.5,
};

export type MatchSignals = {
  readonly issueId: string;
  readonly publicReference: string;
  readonly distanceMetres: number;
  readonly positionAccuracyMetres: number | undefined;
  readonly assetMatches: boolean;
  readonly categoryMatches: boolean;
  /** Cosine distance, or `undefined` when no comparable vector exists. */
  readonly semanticDistance: number | undefined;
  /** Whether this candidate's media is the same or near-identical bytes. */
  readonly mediaNearDuplicate: boolean | undefined;
  readonly issueOpenedAt: string;
  readonly lastEvidenceAt: string | undefined;
  readonly recurrence: RecurrenceClassification | undefined;
};

export type MatchProposalInput = {
  readonly candidates: readonly MatchSignals[];
  readonly observedAt: string;
  readonly taxonomyVersion: string;
  readonly evidenceIds: readonly string[];
  readonly thresholds?: MatchThresholds;
};

type ProposalBase = {
  readonly reasons: readonly string[];
  readonly matcherVersion: string;
  readonly taxonomyVersion: string;
  readonly evidenceIds: readonly string[];
  readonly thresholds: MatchThresholds;
};

export type MatchProposal =
  | (ProposalBase & {
      readonly decision: "existing_issue";
      readonly issueId: string;
      readonly publicReference: string;
    })
  | (ProposalBase & { readonly decision: "new_issue" })
  | (ProposalBase & {
      readonly decision: "ambiguous";
      readonly candidates: readonly {
        readonly issueId: string;
        readonly publicReference: string;
      }[];
      readonly requiresReview: true;
      /** Literal false: an ambiguous proposal must be unable to authorise a merge. */
      readonly mayMerge: false;
      readonly permittedTreatments: readonly string[];
    });

/** What counts as "the same place", widened by the reported position error. */
const samePlaceRadius = (signals: MatchSignals, thresholds: MatchThresholds): number =>
  thresholds.maxDistanceMetres + (signals.positionAccuracyMetres ?? 0);

type Assessment = {
  readonly signals: MatchSignals;
  readonly eligible: boolean;
  readonly strength: number;
  readonly reasons: readonly string[];
};

const assess = (signals: MatchSignals, thresholds: MatchThresholds): Assessment => {
  const reasons: string[] = [];

  // Recorded before the category gate. The same photograph appearing under
  // two different categories is something a reviewer needs to see — it may be
  // a mis-categorisation or reuse worth questioning — so the gate must not
  // swallow the observation along with the decision.
  if (signals.mediaNearDuplicate === true) {
    reasons.push(
      "the media is the same or near-identical bytes, which is reuse of one photograph and is not itself evidence of one shared problem",
    );
  }

  // Gate. A different category is a different problem, full stop.
  if (!signals.categoryMatches) {
    return {
      signals,
      eligible: false,
      strength: 0,
      reasons: [
        ...reasons,
        `${signals.publicReference} is in a different category, so it is a different problem however close it is`,
      ],
    };
  }

  const radius = samePlaceRadius(signals, thresholds);
  const nearEnough = signals.distanceMetres <= radius;
  if (nearEnough) {
    reasons.push(
      `about ${String(Math.round(signals.distanceMetres))} m away, within the ${String(Math.round(radius))} m this check allows for the reported accuracy`,
    );
  }
  if (signals.assetMatches) reasons.push("the same asset identifier");

  if (!nearEnough && !signals.assetMatches) {
    return {
      signals,
      eligible: false,
      strength: 0,
      reasons: [
        `${signals.publicReference} is about ${String(Math.round(signals.distanceMetres))} m away with no shared asset identifier`,
      ],
    };
  }

  // An asset match names the physical thing, so it carries a match by itself.
  if (signals.assetMatches) {
    return { signals, eligible: true, strength: 1, reasons };
  }

  if (signals.semanticDistance === undefined) {
    // Only "it is near" is left, and proximity alone must not decide.
    return {
      signals,
      eligible: false,
      strength: 0,
      reasons: [
        ...reasons,
        "no semantic comparison was available, and proximity on its own is not enough to call two reports the same problem",
      ],
    };
  }

  if (signals.semanticDistance > thresholds.maxSemanticDistance) {
    reasons.push(
      `the descriptions differ (semantic distance ${signals.semanticDistance.toFixed(2)}, above the ${String(thresholds.maxSemanticDistance)} this check allows)`,
    );
    return { signals, eligible: false, strength: 0, reasons };
  }

  reasons.push(
    `the descriptions are close (semantic distance ${signals.semanticDistance.toFixed(2)})`,
  );
  return { signals, eligible: true, strength: 1 - signals.semanticDistance, reasons };
};

export const proposeMatch = (input: MatchProposalInput): MatchProposal => {
  const thresholds = input.thresholds ?? DEFAULT_THRESHOLDS;
  const base = {
    matcherVersion: MATCHER_VERSION,
    taxonomyVersion: input.taxonomyVersion,
    evidenceIds: input.evidenceIds,
    thresholds,
  };

  if (input.candidates.length === 0) {
    return {
      ...base,
      decision: "new_issue",
      reasons: ["no candidate issue was retrieved within the searched bounds"],
    };
  }

  const assessments = input.candidates.map((candidate) => assess(candidate, thresholds));

  // Recurrence defers to a person before anything else is considered: the
  // domain contract does not allow the system to decide reopening alone.
  const recurrence = input.candidates.find(
    (candidate) => candidate.recurrence?.isRecurrenceCandidate === true,
  );
  if (recurrence?.recurrence !== undefined) {
    return {
      ...base,
      decision: "ambiguous",
      candidates: input.candidates.map((candidate) => ({
        issueId: candidate.issueId,
        publicReference: candidate.publicReference,
      })),
      requiresReview: true,
      mayMerge: false,
      permittedTreatments: recurrence.recurrence.permittedTreatments,
      reasons: [
        `this may be a recurrence: ${recurrence.recurrence.rationale}`,
        "a recurrence is reopened or opened afresh only by a person, never by this matcher",
      ],
    };
  }

  const eligible = assessments
    .filter((assessment) => assessment.eligible)
    .sort((a, b) => b.strength - a.strength);

  if (eligible.length === 0) {
    return {
      ...base,
      decision: "new_issue",
      reasons: assessments.flatMap((assessment) => assessment.reasons),
    };
  }

  const leader = eligible[0];
  const runnerUp = eligible[1];
  if (leader === undefined) {
    return { ...base, decision: "new_issue", reasons: ["no eligible candidate"] };
  }

  // Two candidates too close to separate: ranking them would be arbitrary, and
  // an arbitrary ranking presented as a decision is worse than saying so.
  if (
    runnerUp !== undefined &&
    leader.strength - runnerUp.strength < thresholds.minSemanticSeparation
  ) {
    return {
      ...base,
      decision: "ambiguous",
      candidates: eligible.map((assessment) => ({
        issueId: assessment.signals.issueId,
        publicReference: assessment.signals.publicReference,
      })),
      requiresReview: true,
      mayMerge: false,
      permittedTreatments: [],
      reasons: [
        `${String(eligible.length)} candidates score too closely to choose between them`,
        ...leader.reasons,
        ...runnerUp.reasons,
      ],
    };
  }

  // A single eligible candidate whose meaning is only weakly similar is also
  // ambiguous rather than a match.
  const semantic = leader.signals.semanticDistance;
  if (
    !leader.signals.assetMatches &&
    semantic !== undefined &&
    semantic > thresholds.maxSemanticDistance / 2 &&
    semantic <= thresholds.maxSemanticDistance
  ) {
    return {
      ...base,
      decision: "ambiguous",
      candidates: [
        { issueId: leader.signals.issueId, publicReference: leader.signals.publicReference },
      ],
      requiresReview: true,
      mayMerge: false,
      permittedTreatments: [],
      reasons: [
        ...leader.reasons,
        "the descriptions are similar but not clearly the same, so a person should decide",
      ],
    };
  }

  return {
    ...base,
    decision: "existing_issue",
    issueId: leader.signals.issueId,
    publicReference: leader.signals.publicReference,
    reasons: leader.reasons,
  };
};
