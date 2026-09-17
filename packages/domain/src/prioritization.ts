/**
 * Transparent prioritization and sensitivity (roadmap V042).
 *
 * Every earlier task in this system refused to produce a score: V034 refused
 * urgency, V036 refused severity, V041 refused a confidence number. This one
 * is asked for a weighted ordering, and the refusals still hold — so what it
 * produces is not a score with a ranking attached, it is **an ordering
 * together with how much that ordering depends on assumptions nobody has
 * validated.**
 *
 * Four properties carry that, and each is structural rather than advisory.
 *
 * **You cannot get an ordering without its sensitivity.** `prioritise` takes a
 * *set* of plausible weightings and returns a rank interval per candidate.
 * There is no single-weighting entry point to call by mistake, and a policy
 * declaring fewer than two weightings is refused. A rank that swings from 2nd
 * to 27th across weightings somebody could equally have chosen is not a
 * finding about the world, and the only way to know is to be shown both.
 *
 * **Missing data redistributes weight; it never scores zero.** A ward with no
 * population figure would otherwise be pushed to the bottom of every list for
 * having been measured less, which is the exact failure the equity clause
 * exists to prevent. Where too few factors survive, the candidate is reported
 * as `insufficient_evidence` and is not ranked at all — an ordering built on
 * one factor is that factor wearing a ranking's clothes.
 *
 * **A candidate's factors do not depend on who else is in the list.** Every
 * transform uses absolute reference points from the policy pack rather than
 * cohort percentiles or z-scores. Otherwise adding an unrelated report could
 * move a ward's contribution, and nobody reading the explanation would see why.
 *
 * **Low reporting is not low need.** The equity factor treats *few reports per
 * head* as a reason to rank higher, not lower, because a quiet ward is at
 * least as likely to be one where reporting is hard as one where nothing is
 * wrong. This is the mechanism by which a lower-reporting high-need case can
 * rank appropriately, and it is a stated assumption rather than a discovery.
 *
 * Pure: no clock, no storage. Every input is supplied.
 */

/**
 * The factors V042 names.
 *
 * Two of them have no source in this deployment and are declared anyway.
 * Leaving `severity` out of the list entirely would hide that the ordering is
 * made without it; declaring it `unavailable` puts that absence in every
 * explanation the policy produces.
 */
export type PriorityFactor =
  | "severity"
  | "persistence"
  | "service_population"
  | "reporting_equity"
  | "alternatives"
  | "accessibility"
  | "existing_project";

export const PRIORITY_FACTORS: readonly PriorityFactor[] = [
  "severity",
  "persistence",
  "service_population",
  "reporting_equity",
  "alternatives",
  "accessibility",
  "existing_project",
];

/** Why a factor contributed nothing. Never silently absent. */
export type FactorStatus =
  | "available"
  /** No source of this kind exists in this deployment at all. */
  | "no_source_in_deployment"
  /** A source exists; this candidate has no value from it. */
  | "missing_for_this_candidate";

export type FactorOutcome = {
  readonly factor: PriorityFactor;
  readonly status: FactorStatus;
  /** In [0,1], or null when the factor did not contribute. Never 0 for absent. */
  readonly contribution: number | null;
  /** The weight actually applied, after redistribution. */
  readonly appliedWeight: number;
  readonly explanation: string;
};

export type PriorityReferencePoints = {
  /** Days open at which persistence is fully counted. */
  readonly persistenceReferenceDays: number;
  /** Additional persistence credited per recorded reopening. */
  readonly persistencePerReopening: number;
  /** Population at which service_population is fully counted. */
  readonly populationReferenceCount: number;
  /** Reports per 1000 residents at or above which reporting_equity contributes nothing. */
  readonly equityReferenceRatePer1000: number;
  /** Count of same-type alternatives at which the alternatives factor contributes nothing. */
  readonly alternativesReferenceCount: number;
};

export type Weighting = {
  readonly id: string;
  readonly label: string;
  /** Why somebody might plausibly choose this set. Mandatory. */
  readonly rationale: string;
  readonly weights: Readonly<Partial<Record<PriorityFactor, number>>>;
};

export type RecommendationPolicy = {
  readonly version: string;
  /**
   * At least two, always.
   *
   * One weighting produces a ranking that looks like a finding. Two or more
   * produce an interval, which is what the ordering actually supports.
   */
  readonly weightings: readonly Weighting[];
  readonly references: PriorityReferencePoints;
  /**
   * Whether an existing confirmed project raises or lowers a candidate.
   *
   * A policy choice with defensible arguments both ways — already funded may
   * mean already handled, or may mean the money did not fix it — so the pack
   * states which and why, and this file refuses to pick.
   */
  readonly existingProjectDirection: "prioritise" | "deprioritise";
  readonly existingProjectRationale: string;
  /** Factors below which a candidate is not ranked at all. */
  readonly minimumFactorsForRanking: number;
  /** What this ordering assumes about money. Mandatory, because it assumes a lot. */
  readonly budgetAssumption: string;
  readonly note: string;
};

export class PrioritizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrioritizationError";
  }
}

// ---------------------------------------------------------------------------
// Candidate inputs
// ---------------------------------------------------------------------------

export type CandidateInput = {
  readonly candidateId: string;
  readonly label: string;
  readonly jurisdictionKey: string;
  readonly category: string;
  /** Days the report has been open. */
  readonly openDays: number;
  readonly reopeningCount: number;
  /** Residents served, from the V040 context import. Null means not loaded. */
  readonly servicePopulation: number | null;
  /** Reports recorded in this ward. Used only with a population. */
  readonly wardReportCount: number | null;
  /** Same-type assets within the configured range. Null means not known. */
  readonly alternativesNearby: number | null;
  /** Whether a reviewer confirmed a sanctioned project for this report (V041). */
  readonly hasConfirmedProject: boolean;
  /** Whether the register was searched at all. False means nobody has looked. */
  readonly projectRegisterSearched: boolean;
};

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

/**
 * One factor's contribution for one candidate.
 *
 * Deliberately a function of that candidate and the policy alone. No argument
 * describes the rest of the cohort, so adding an unrelated report cannot move
 * this number — and an explanation that was true yesterday is still true.
 */
export const contributionOf = (
  factor: PriorityFactor,
  candidate: CandidateInput,
  policy: RecommendationPolicy,
): {
  readonly status: FactorStatus;
  readonly value: number | null;
  readonly explanation: string;
} => {
  const references = policy.references;
  switch (factor) {
    case "severity":
      return {
        status: "no_source_in_deployment",
        value: null,
        explanation:
          "No severity source exists here. This system has never had a calibrated severity model and V046 is the task that would evaluate one, so nothing in this ordering reflects how dangerous anything is.",
      };

    case "accessibility":
      return {
        status: "no_source_in_deployment",
        value: null,
        explanation:
          "No accessibility dataset has been imported. V040 loads population, enrolment, access and investment only, so this factor is declared and empty rather than quietly dropped.",
      };

    case "persistence": {
      const fromAge = candidate.openDays / references.persistenceReferenceDays;
      const fromReopenings = candidate.reopeningCount * references.persistencePerReopening;
      return {
        status: "available",
        value: round3(clamp01(fromAge + fromReopenings)),
        explanation: `open ${String(Math.round(candidate.openDays))} days against a reference of ${String(references.persistenceReferenceDays)}, with ${String(candidate.reopeningCount)} recorded reopening(s)`,
      };
    }

    case "service_population": {
      if (candidate.servicePopulation === null) {
        return {
          status: "missing_for_this_candidate",
          value: null,
          explanation:
            "no population figure has been loaded for this ward, so this factor's weight is redistributed rather than counted as nobody living there",
        };
      }
      return {
        status: "available",
        value: round3(clamp01(candidate.servicePopulation / references.populationReferenceCount)),
        explanation: `${String(candidate.servicePopulation)} residents against a reference of ${String(references.populationReferenceCount)}`,
      };
    }

    case "reporting_equity": {
      if (candidate.servicePopulation === null || candidate.wardReportCount === null) {
        return {
          status: "missing_for_this_candidate",
          value: null,
          explanation:
            "reports per head cannot be computed without both a population and a report count for this ward",
        };
      }
      if (candidate.servicePopulation <= 0) {
        return {
          status: "missing_for_this_candidate",
          value: null,
          explanation: "a population of zero gives no rate to compare",
        };
      }
      const ratePer1000 = (candidate.wardReportCount / candidate.servicePopulation) * 1000;
      // Inverted on purpose. A quiet ward is at least as likely to be one where
      // reporting is hard as one where nothing is wrong, so few reports per
      // head raises a candidate rather than lowering it. This is the stated
      // assumption that lets a lower-reporting high-need case rank at all.
      const value = clamp01(1 - ratePer1000 / references.equityReferenceRatePer1000);
      return {
        status: "available",
        value: round3(value),
        explanation: `${String(Math.round(ratePer1000 * 10) / 10)} report(s) per 1000 residents against a reference of ${String(references.equityReferenceRatePer1000)}; fewer reports per head raises this factor, because low reporting is not evidence of low need`,
      };
    }

    case "alternatives": {
      if (candidate.alternativesNearby === null) {
        return {
          status: "missing_for_this_candidate",
          value: null,
          explanation:
            "no count of comparable nearby assets is available, so this factor's weight is redistributed rather than counted as no alternatives existing",
        };
      }
      const value = clamp01(
        1 - candidate.alternativesNearby / references.alternativesReferenceCount,
      );
      return {
        status: "available",
        value: round3(value),
        explanation: `${String(candidate.alternativesNearby)} comparable asset(s) nearby against a reference of ${String(references.alternativesReferenceCount)}; fewer alternatives raises this factor`,
      };
    }

    case "existing_project": {
      if (!candidate.projectRegisterSearched) {
        return {
          status: "missing_for_this_candidate",
          value: null,
          explanation:
            "the sanctioned-project register has not been searched for this report, which is a different state from having searched it and found nothing",
        };
      }
      const prioritise = policy.existingProjectDirection === "prioritise";
      const value = candidate.hasConfirmedProject === prioritise ? 1 : 0;
      return {
        status: "available",
        value,
        explanation: `${candidate.hasConfirmedProject ? "a reviewer confirmed a sanctioned project for this report" : "the register was searched and no project was confirmed, which is not evidence that nothing was funded"}; this deployment's policy is to ${policy.existingProjectDirection} in that case, because ${policy.existingProjectRationale}`,
      };
    }
  }
};

// ---------------------------------------------------------------------------
// One weighting
// ---------------------------------------------------------------------------

export type CandidateUnderWeighting = {
  readonly candidateId: string;
  readonly factors: readonly FactorOutcome[];
  readonly availableFactors: number;
  readonly declaredFactors: number;
  /**
   * The weighted mean over the factors that survived, or null when too few did.
   *
   * Deliberately not exported in the published view: it orders the list and is
   * not a quantity about the world. See `PriorityPlacement`.
   */
  readonly internalValue: number | null;
  readonly rankable: boolean;
};

const applyWeighting = (
  candidate: CandidateInput,
  policy: RecommendationPolicy,
  weighting: Weighting,
): CandidateUnderWeighting => {
  const raw = PRIORITY_FACTORS.map((factor) => ({
    factor,
    declaredWeight: weighting.weights[factor] ?? 0,
    ...contributionOf(factor, candidate, policy),
  }));

  const contributing = raw.filter((entry) => entry.value !== null && entry.declaredWeight > 0);
  const surviving = contributing.reduce((total, entry) => total + entry.declaredWeight, 0);

  const factors: readonly FactorOutcome[] = raw.map((entry) => ({
    factor: entry.factor,
    status: entry.status,
    contribution: entry.value,
    // Redistribution is proportional across the factors that survived. A
    // missing factor's weight goes to the others rather than to a zero, so a
    // ward that has been measured less is not pushed down for it.
    appliedWeight:
      entry.value === null || surviving === 0 ? 0 : round3(entry.declaredWeight / surviving),
    explanation: entry.explanation,
  }));

  const rankable = contributing.length >= policy.minimumFactorsForRanking && surviving > 0;
  const internalValue = rankable
    ? round3(
        factors.reduce(
          (total, factor) => total + (factor.contribution ?? 0) * factor.appliedWeight,
          0,
        ),
      )
    : null;

  return {
    candidateId: candidate.candidateId,
    factors,
    availableFactors: contributing.length,
    declaredFactors: Object.values(weighting.weights).filter((weight) => weight > 0).length,
    internalValue,
    rankable,
  };
};

// ---------------------------------------------------------------------------
// The ordering, with its sensitivity
// ---------------------------------------------------------------------------

export type RankStability = "robust" | "sensitive" | "unstable" | "not_ranked";

export type PriorityPlacement = {
  readonly candidateId: string;
  readonly label: string;
  /**
   * Best and worst position across every plausible weighting, or null when the
   * candidate could not be ranked.
   *
   * There is deliberately no single `rank` field and no published score. The
   * interval is what the evidence supports; a single number would be one
   * weighting's answer presented as the answer.
   */
  readonly bestRank: number | null;
  readonly worstRank: number | null;
  readonly stability: RankStability;
  /** Per-weighting detail, for an explanation screen (V043). */
  readonly underWeighting: readonly {
    readonly weightingId: string;
    readonly rank: number | null;
  }[];
  readonly factors: readonly FactorOutcome[];
  readonly explanation: string;
};

export type PriorityOrdering = {
  readonly policyVersion: string;
  readonly weightingIds: readonly string[];
  readonly placements: readonly PriorityPlacement[];
  /** Candidates with too little evidence to rank, reported rather than dropped. */
  readonly unranked: readonly { readonly candidateId: string; readonly reason: string }[];
  readonly disclosures: readonly string[];
};

/**
 * How far a candidate's position moves across plausible weightings.
 *
 * Measured against the candidate's own best position rather than the length of
 * the list. A swing of nine places matters enormously at position seven and
 * not at all at position ninety, and a proportion-of-the-list measure gets
 * that exactly backwards: in a long list every swing looks small, so the top
 * of the ordering — the only part anybody reads — would always report as
 * robust however much the weighting moved it.
 *
 * The floor of two keeps the first position from being hypersensitive: moving
 * between first and second is worth saying, and is not the same as moving from
 * first to fifth.
 */
export const stabilityOf = (bestRank: number, worstRank: number): RankStability => {
  const relative = (worstRank - bestRank) / Math.max(bestRank, 2);
  if (relative <= 0.15) return "robust";
  if (relative <= 0.5) return "sensitive";
  return "unstable";
};

export const STABILITY_EXPLANATIONS: Readonly<Record<RankStability, string>> = {
  robust: "This position barely moves when the weights are changed to other plausible values.",
  sensitive:
    "This position moves noticeably when the weights are changed to other plausible values, so the ordering around it reflects the weighting as much as the evidence.",
  unstable:
    "This position moves across most of the list when the weights are changed to other plausible values. The ordering says almost nothing about this candidate; it reports the weighting that was chosen.",
  not_ranked:
    "Too few factors had data for this candidate to be placed at all. It is listed here rather than dropped, because a candidate missing from a list reads as one nobody needed to consider.",
};

/**
 * The disclosures that travel with every ordering.
 *
 * Assembled from the policy rather than written at a call site, so a caller
 * cannot obtain an ordering without them.
 */
export const orderingDisclosures = (policy: RecommendationPolicy): readonly string[] => [
  policy.note,
  policy.budgetAssumption,
  `Produced by policy ${policy.version} under ${String(policy.weightings.length)} plausible weightings: ${policy.weightings.map((weighting) => `${weighting.label} (${weighting.rationale})`).join("; ")}.`,
  "Positions are shown as intervals across those weightings. A single position would be one weighting's answer presented as the answer.",
  "Factors with no data have their weight redistributed across the factors that remain. They are never counted as zero, because that would push a ward down the list for having been measured less.",
  "This is an ordering of reports by configured factors. It is not a finding about need, not a measure of how serious anything is, and not a statement about how public money should be spent.",
];

/**
 * Orders candidates and reports how much that ordering depends on its weights.
 *
 * There is no variant of this function that takes a single weighting. Getting
 * an ordering without its sensitivity is not something a caller can do by
 * omission.
 */
export const prioritise = (
  candidates: readonly CandidateInput[],
  policy: RecommendationPolicy,
): PriorityOrdering => {
  if (policy.weightings.length < 2) {
    throw new PrioritizationError(
      "a recommendation policy must declare at least two plausible weightings; one produces a ranking that looks like a finding, and the interval between several is what the evidence actually supports",
    );
  }

  const perWeighting = policy.weightings.map((weighting) => {
    const evaluated = candidates.map((candidate) => applyWeighting(candidate, policy, weighting));
    const rankable = evaluated
      .filter((entry) => entry.rankable)
      // Highest first, then by id so the order is total and reproducible.
      .sort((a, b) =>
        (b.internalValue ?? 0) === (a.internalValue ?? 0)
          ? a.candidateId.localeCompare(b.candidateId)
          : (b.internalValue ?? 0) - (a.internalValue ?? 0),
      );
    const ranks = new Map<string, number>(
      rankable.map((entry, index) => [entry.candidateId, index + 1]),
    );
    return { weighting, evaluated, ranks, rankedCount: rankable.length };
  });

  const first = perWeighting[0];
  if (first === undefined) throw new PrioritizationError("no weightings were applied");
  const rankedCount = Math.max(...perWeighting.map((entry) => entry.rankedCount));

  const placements: PriorityPlacement[] = [];
  const unranked: { candidateId: string; reason: string }[] = [];

  for (const candidate of candidates) {
    const underWeighting = perWeighting.map((entry) => ({
      weightingId: entry.weighting.id,
      rank: entry.ranks.get(candidate.candidateId) ?? null,
    }));
    const ranks = underWeighting
      .map((entry) => entry.rank)
      .filter((rank): rank is number => rank !== null);

    const factors =
      first.evaluated.find((entry) => entry.candidateId === candidate.candidateId)?.factors ?? [];

    if (ranks.length === 0) {
      const available =
        first.evaluated.find((entry) => entry.candidateId === candidate.candidateId)
          ?.availableFactors ?? 0;
      const reason = `only ${String(available)} factor(s) had data, below the ${String(policy.minimumFactorsForRanking)} this policy requires; an ordering built on fewer is that factor wearing a ranking's clothes`;
      unranked.push({ candidateId: candidate.candidateId, reason });
      placements.push({
        candidateId: candidate.candidateId,
        label: candidate.label,
        bestRank: null,
        worstRank: null,
        stability: "not_ranked",
        underWeighting,
        factors,
        explanation: `${reason}. ${STABILITY_EXPLANATIONS.not_ranked}`,
      });
      continue;
    }

    const bestRank = Math.min(...ranks);
    const worstRank = Math.max(...ranks);
    const stability = stabilityOf(bestRank, worstRank);
    placements.push({
      candidateId: candidate.candidateId,
      label: candidate.label,
      bestRank,
      worstRank,
      stability,
      underWeighting,
      factors,
      explanation: `Between ${String(bestRank)} and ${String(worstRank)} of ${String(rankedCount)} across ${String(policy.weightings.length)} plausible weightings. ${STABILITY_EXPLANATIONS[stability]}`,
    });
  }

  placements.sort((a, b) => {
    if (a.bestRank === null && b.bestRank === null) return a.label.localeCompare(b.label);
    if (a.bestRank === null) return 1;
    if (b.bestRank === null) return -1;
    return a.bestRank === b.bestRank ? a.worstRank! - b.worstRank! : a.bestRank - b.bestRank;
  });

  return {
    policyVersion: policy.version,
    weightingIds: policy.weightings.map((weighting) => weighting.id),
    placements,
    unranked,
    disclosures: orderingDisclosures(policy),
  };
};

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * Phrasing that would present this ordering as a spending recommendation.
 *
 * The V042 acceptance clause is that neither an arbitrary score nor model
 * prose is presented as optimal public spending, and these are the specific
 * ways that happens.
 */
export const BANNED_PRIORITY_PHRASES: readonly RegExp[] = [
  /\boptimal\b/i,
  /\bbest use of\b/i,
  /\bshould be funded\b/i,
  /\bpriority score\b/i,
  /\bmost urgent\b/i,
  /\bhighest need\b/i,
  /\brecommended spend/i,
  /\bwhere the money should go\b/i,
];

export const priorityOverclaims = (text: string): readonly string[] =>
  BANNED_PRIORITY_PHRASES.filter((pattern) => pattern.test(text)).map(
    (pattern) => `"${text.match(pattern)?.[0] ?? ""}" presents an ordering as a spending decision`,
  );

/** Every string an ordering can put on a screen, for the vocabulary check. */
export const orderingText = (ordering: PriorityOrdering): string =>
  [
    ...ordering.disclosures,
    ...ordering.unranked.map((entry) => entry.reason),
    ...ordering.placements.flatMap((placement) => [
      placement.label,
      placement.explanation,
      ...placement.factors.map((factor) => factor.explanation),
    ]),
  ].join(" \n ");
