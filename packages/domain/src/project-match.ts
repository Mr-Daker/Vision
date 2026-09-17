/**
 * Sanctioned-project link proposals (roadmap V041).
 *
 * Whether a piece of public infrastructure has been funded is the single most
 * politically loaded thing this system could appear to say, and it is the one
 * it is least equipped to. The register it searches is a synthetic fixture
 * (V004 approves no real funding dataset), and even a complete register would
 * only ever record the projects somebody entered into it.
 *
 * So the rule this file exists to enforce: **not finding a project is a fact
 * about the register, never a fact about the world.** `absenceStatement` is
 * the only supported way to render a no-match, and it says so in the same
 * breath as the finding. A test asserts that no string produced anywhere here
 * can be read as "government has not funded this".
 *
 * How the signals are weighted, and why — the same discipline V027 applies to
 * duplicate matching:
 *
 * - **Asset identifier** is the only signal that can carry a proposal on its
 *   own. It names the physical thing the project was for, rather than a place
 *   near it.
 * - **Geography alone is never sufficient.** A sanctioned drain two hundred
 *   metres from a broken street light says only that both are in this street.
 * - **Scope terms alone are never sufficient.** "Water supply" matches half
 *   the projects in a district.
 * - **Geography and scope together** are enough to *propose* to a reviewer,
 *   and never enough to conclude.
 * - **Dates are reported, never disqualifying.** A project completed years
 *   before a report is exactly the funding history somebody asking "has this
 *   been paid for before?" wants to see.
 *
 * Nothing here confirms anything. `REQUIRES_REVIEWER_DECISION` is a literal
 * `true`, because a link between a citizen's report and a public spending
 * record is a claim with a name against it, and the name has to be a person's.
 *
 * Pure: no clock, no storage, no distance calculation — metres are supplied.
 */

/** Bumped whenever a rule or threshold below changes; recorded on every proposal. */
export const PROJECT_MATCHER_VERSION = "project-matcher.v1";

/**
 * No project link is ever confirmed without a reviewer.
 *
 * A literal rather than a configurable value, for the same reason V027's
 * `mayMerge` is a literal `false` on an ambiguous proposal: this is not a
 * threshold somebody should be able to tune past.
 */
export const REQUIRES_REVIEWER_DECISION = true;

export type ProjectMatchMethod = "asset_identifier" | "geography" | "scope_terms" | "date_window";

export type ProjectMatchThresholds = {
  /** Metres within which a project and a report are "in the same place". */
  readonly maxDistanceMetres: number;
  /** Shared scope terms below which scope says nothing useful. */
  readonly minScopeTermOverlap: number;
};

export const DEFAULT_PROJECT_THRESHOLDS: ProjectMatchThresholds = {
  maxDistanceMetres: 250,
  minScopeTermOverlap: 1,
};

export type ProjectSignals = {
  readonly projectId: string;
  readonly projectName: string;
  /** The source record the project came from. Never absent (V040). */
  readonly sourceRecordId: string;
  readonly sourceName: string;
  readonly synthetic: boolean;
  /** The project names the same asset identifier the report was attached to. */
  readonly assetIdMatches: boolean;
  /** Undefined when either side has no position. Never guessed. */
  readonly distanceMetres: number | undefined;
  /** Scope terms shared with the report's category and defect vocabulary. */
  readonly sharedScopeTerms: readonly string[];
  readonly sanctionedAt: string;
  readonly completedAt: string | undefined;
  /** Whether the report was opened inside the project's own dates. */
  readonly openedInsideProjectWindow: boolean;
};

export type ProjectMatchInput = {
  readonly candidates: readonly ProjectSignals[];
  readonly thresholds?: ProjectMatchThresholds;
  /** The register searched, named in every outcome including the empty one. */
  readonly registerName: string;
  /** True when that register is team-created synthetic data (V004, V040). */
  readonly registerIsSynthetic: boolean;
};

export type ProjectCandidateSummary = {
  readonly projectId: string;
  readonly projectName: string;
  readonly methods: readonly ProjectMatchMethod[];
  readonly reasons: readonly string[];
};

export type ProjectMatchProposal = {
  /**
   * `single_candidate` means one defensible thing to put in front of a
   * reviewer. It does not mean a link.
   */
  readonly outcome: "single_candidate" | "ambiguous" | "no_candidate";
  readonly matcherVersion: string;
  readonly candidates: readonly ProjectCandidateSummary[];
  readonly reasons: readonly string[];
  /** Always present, always the same shape: what a no-match does and does not mean. */
  readonly absenceNote: string;
  /** Always `true`. Nothing here may be applied without a person. */
  readonly requiresReviewerDecision: boolean;
};

const methodsFor = (
  candidate: ProjectSignals,
  thresholds: ProjectMatchThresholds,
): readonly ProjectMatchMethod[] => {
  const methods: ProjectMatchMethod[] = [];
  if (candidate.assetIdMatches) methods.push("asset_identifier");
  if (
    candidate.distanceMetres !== undefined &&
    candidate.distanceMetres <= thresholds.maxDistanceMetres
  ) {
    methods.push("geography");
  }
  if (candidate.sharedScopeTerms.length >= thresholds.minScopeTermOverlap) {
    methods.push("scope_terms");
  }
  if (candidate.openedInsideProjectWindow) methods.push("date_window");
  return methods;
};

const reasonsFor = (
  candidate: ProjectSignals,
  methods: readonly ProjectMatchMethod[],
): readonly string[] => {
  const reasons: string[] = [];
  if (methods.includes("asset_identifier")) {
    reasons.push(
      `the project names the same asset this report was attached to, which identifies the thing itself rather than a place near it`,
    );
  }
  if (methods.includes("geography")) {
    reasons.push(
      `the project is recorded ${String(Math.round(candidate.distanceMetres ?? 0))} m from where this was reported, which on its own says only that both are in this street`,
    );
  }
  if (methods.includes("scope_terms")) {
    reasons.push(
      `the project's scope shares ${candidate.sharedScopeTerms.join(", ")} with this report, which on its own matches many projects in a district`,
    );
  }
  if (methods.includes("date_window")) {
    reasons.push(
      `the report was opened between the project's sanction on ${candidate.sanctionedAt.slice(0, 10)} and ${candidate.completedAt === undefined ? "its still-open completion" : `its completion on ${candidate.completedAt.slice(0, 10)}`}`,
    );
  }
  if (candidate.distanceMetres === undefined) {
    reasons.push(
      "no distance could be computed, because one of the two has no recorded position; this is reported rather than assumed either way",
    );
  }
  return reasons;
};

/**
 * What a no-match does and does not mean.
 *
 * The V041 acceptance clause — "no match is never translated into a claim that
 * government has not funded the asset" — expressed as the single code path
 * that renders the finding. It is attached to **every** proposal, not only the
 * empty one, because a reader looking at one weak candidate is at the same
 * risk of reading the gaps around it as absence of funding.
 */
export const absenceStatement = (input: {
  readonly registerName: string;
  readonly registerIsSynthetic: boolean;
}): string =>
  `Searched: ${input.registerName}. A report with no linked project means this register holds no matching record. It does not mean no project exists, and it is not evidence about whether this asset has been paid for. ${
    input.registerIsSynthetic
      ? "This register is team-created synthetic data invented for the demonstration; it describes no real spending anywhere."
      : "The register may be incomplete, and records may be entered late."
  }`;

/**
 * Turns candidate signals into advice with its reasons attached.
 *
 * Returns advice, never a decision. `single_candidate` is the strongest thing
 * it can say and it means only that there is one defensible row to show a
 * reviewer.
 */
export const proposeProjectMatch = (input: ProjectMatchInput): ProjectMatchProposal => {
  const thresholds = input.thresholds ?? DEFAULT_PROJECT_THRESHOLDS;
  const absenceNote = absenceStatement(input);

  const scored = input.candidates.map((candidate) => {
    const methods = methodsFor(candidate, thresholds);
    return {
      candidate,
      methods,
      summary: {
        projectId: candidate.projectId,
        projectName: candidate.projectName,
        methods,
        reasons: reasonsFor(candidate, methods),
      },
    };
  });

  // Tier one: the asset identifier names the physical thing, so it is the only
  // signal that can carry a proposal by itself.
  const byAsset = scored.filter((entry) => entry.methods.includes("asset_identifier"));
  if (byAsset.length === 1) {
    return {
      outcome: "single_candidate",
      matcherVersion: PROJECT_MATCHER_VERSION,
      candidates: byAsset.map((entry) => entry.summary),
      reasons: [
        "one project in the register names this asset, and no other does",
        ...(byAsset[0]?.summary.reasons ?? []),
      ],
      absenceNote,
      requiresReviewerDecision: REQUIRES_REVIEWER_DECISION,
    };
  }
  if (byAsset.length > 1) {
    return {
      outcome: "ambiguous",
      matcherVersion: PROJECT_MATCHER_VERSION,
      candidates: byAsset.map((entry) => entry.summary),
      reasons: [
        `${String(byAsset.length)} projects name this same asset, and nothing here can say which one this report concerns; a ranking between them would be arbitrary`,
      ],
      absenceNote,
      requiresReviewerDecision: REQUIRES_REVIEWER_DECISION,
    };
  }

  // Tier two: two weak signals corroborating. Enough to put in front of a
  // reviewer, never enough to conclude.
  const corroborated = scored.filter(
    (entry) => entry.methods.includes("geography") && entry.methods.includes("scope_terms"),
  );
  if (corroborated.length === 1) {
    return {
      outcome: "single_candidate",
      matcherVersion: PROJECT_MATCHER_VERSION,
      candidates: corroborated.map((entry) => entry.summary),
      reasons: [
        "no project names this asset; one project matches on both place and scope, which is enough to show a reviewer and not enough to conclude",
        ...(corroborated[0]?.summary.reasons ?? []),
      ],
      absenceNote,
      requiresReviewerDecision: REQUIRES_REVIEWER_DECISION,
    };
  }
  if (corroborated.length > 1) {
    return {
      outcome: "ambiguous",
      matcherVersion: PROJECT_MATCHER_VERSION,
      candidates: corroborated.map((entry) => entry.summary),
      reasons: [
        `${String(corroborated.length)} projects match this report on both place and scope, and neither signal separates them; a coin toss presented as a decision is worse than saying it is unclear`,
      ],
      absenceNote,
      requiresReviewerDecision: REQUIRES_REVIEWER_DECISION,
    };
  }

  // Anything weaker is reported as no candidate, with whatever was near enough
  // to be worth naming — but never as a proposal.
  const nearMisses = scored.filter((entry) => entry.methods.length > 0);
  return {
    outcome: "no_candidate",
    matcherVersion: PROJECT_MATCHER_VERSION,
    candidates: [],
    reasons:
      nearMisses.length === 0
        ? ["nothing in the register matched this report on identifier, place or scope"]
        : [
            `${String(nearMisses.length)} project(s) matched on a single weak signal only, which is not enough to propose a link`,
            ...nearMisses.flatMap((entry) => entry.summary.reasons),
          ],
    absenceNote,
    requiresReviewerDecision: REQUIRES_REVIEWER_DECISION,
  };
};

/**
 * Phrasing that would turn a gap in a register into a claim about spending.
 *
 * Checked by test against everything this module can produce. Each of these is
 * a specific overclaim rather than a style preference: the register is a
 * synthetic fixture, and no absence in it is evidence of anything.
 */
export const BANNED_ABSENCE_PHRASES: readonly RegExp[] = [
  /\bnot funded\b/i,
  /\bunfunded\b/i,
  /\bno funding\b/i,
  /\bnever funded\b/i,
  /\bgovernment has not\b/i,
  /\bno money\b/i,
  /\bnot been paid for\b/i,
  /\bno investment\b/i,
];

export const absenceOverclaims = (text: string): readonly string[] =>
  BANNED_ABSENCE_PHRASES.filter((pattern) => pattern.test(text)).map(
    (pattern) => `"${text.match(pattern)?.[0] ?? ""}" claims something the register cannot support`,
  );

/** Every string a proposal can put on a screen, for the vocabulary check. */
export const proposalText = (proposal: ProjectMatchProposal): string =>
  [
    ...proposal.reasons,
    proposal.absenceNote,
    ...proposal.candidates.flatMap((candidate) => [candidate.projectName, ...candidate.reasons]),
  ].join(" \n ");
