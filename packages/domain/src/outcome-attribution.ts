/**
 * Recorded outcomes and what they do not prove (roadmap V043).
 *
 * A comparison view puts two things next to each other that a reader will join
 * up on their own: money that was sanctioned for an asset, and something good
 * that happened to a report about that asset afterwards. The join is the
 * error. This system records that a repair was claimed and confirmed; it has
 * no counterfactual, no control, no measurement of the work, and no way to
 * know what would have happened without the spending.
 *
 * So the rule here: **an outcome recorded during a project is a coincidence in
 * time, and that is the strongest thing that may be said about it.**
 * `outcomeStatement` is the only supported way to render one, it always
 * contains the sentence saying so, and `attributionOverclaims` checks every
 * string this module can produce against the phrasings that would quietly
 * upgrade the coincidence into a cause.
 *
 * Three states are kept apart rather than collapsed into "related":
 *
 *  - **during** — the event fell inside the project's own dates. Worth
 *    showing, and evidence of nothing.
 *  - **outside** — the event fell before the sanction or after completion.
 *    Also worth showing: it is the part a reader would otherwise never see,
 *    and its absence is what makes an overlap look meaningful.
 *  - **unknown** — the project has no end date, or the event has no time. Not
 *    guessed in either direction.
 *
 * Pure: no clock, no storage. Every instant is supplied.
 */

export type OutcomeRelation = "during" | "before" | "after" | "unknown";

export type ProjectWindow = {
  readonly projectId: string;
  readonly projectName: string;
  readonly sanctionedAtMs: number;
  /** Null when the project is still open. Never treated as "until now". */
  readonly completedAtMs: number | null;
};

export type RecordedOutcome = {
  readonly eventType: string;
  readonly occurredAtMs: number | null;
  /** What was recorded, in the words the record uses. */
  readonly description: string;
};

export type PlacedOutcome = {
  readonly eventType: string;
  readonly description: string;
  readonly relation: OutcomeRelation;
  readonly explanation: string;
};

/**
 * Where one recorded event sits relative to a project's own dates.
 *
 * An open-ended project yields `unknown` for anything after its sanction
 * rather than `during`. "Still running, so everything since counts" is the
 * assumption that turns an indefinite project into credit for every
 * improvement in its area.
 */
export const placeOutcome = (outcome: RecordedOutcome, window: ProjectWindow): OutcomeRelation => {
  if (outcome.occurredAtMs === null) return "unknown";
  if (outcome.occurredAtMs < window.sanctionedAtMs) return "before";
  if (window.completedAtMs === null) return "unknown";
  return outcome.occurredAtMs <= window.completedAtMs ? "during" : "after";
};

export const RELATION_EXPLANATIONS: Readonly<Record<OutcomeRelation, string>> = {
  during:
    "Recorded while this project was running. That is a coincidence in time. Nothing here measures the work, compares it with what would have happened otherwise, or shows that the spending caused it.",
  before:
    "Recorded before this project was sanctioned, so the project cannot be part of the explanation.",
  after:
    "Recorded after this project was completed. Whether the project is part of the explanation is not something this system can say.",
  unknown:
    "This cannot be placed against the project's dates — either the project has no recorded end, or the event has no recorded time. It is not assumed to fall inside.",
};

export const placeOutcomes = (
  outcomes: readonly RecordedOutcome[],
  window: ProjectWindow,
): readonly PlacedOutcome[] =>
  outcomes.map((outcome) => {
    const relation = placeOutcome(outcome, window);
    return {
      eventType: outcome.eventType,
      description: outcome.description,
      relation,
      explanation: RELATION_EXPLANATIONS[relation],
    };
  });

/**
 * The sentence that must accompany any set of recorded outcomes.
 *
 * The V043 acceptance clause — a reviewer can distinguish recorded outcomes
 * during a project from proof that spending caused those outcomes — expressed
 * as the single code path that renders the finding. It states the counts for
 * every relation, including the ones outside the window, because showing only
 * the overlap is how an overlap starts to look like a mechanism.
 */
export const outcomeStatement = (
  placed: readonly PlacedOutcome[],
  window: ProjectWindow,
): string => {
  const count = (relation: OutcomeRelation): number =>
    placed.filter((outcome) => outcome.relation === relation).length;
  const during = count("during");
  const outside = count("before") + count("after");
  const unknown = count("unknown");

  if (placed.length === 0) {
    return `Nothing has been recorded against this report that can be placed beside ${window.projectName}. That is not evidence either way about the project.`;
  }
  return (
    `${String(during)} recorded event(s) fall inside ${window.projectName}'s own dates, ` +
    `${String(outside)} fall outside them, and ${String(unknown)} cannot be placed. ` +
    "Events inside a project's dates are a coincidence in time. This system has no comparison with what would have happened without the spending, no measurement of the work itself, and therefore nothing that could show the money caused any of this."
  );
};

/**
 * Phrasing that would turn an overlap in time into a cause.
 *
 * Each is a specific upgrade rather than a style preference: every one of them
 * asserts a mechanism this system has no way to observe.
 */
export const BANNED_ATTRIBUTION_PHRASES: readonly RegExp[] = [
  /\bbecause of (?:the|this) project\b/i,
  /\bthanks to\b/i,
  /\bresulted in\b/i,
  /\bcaused by\b/i,
  /\bled to\b/i,
  /\bimpact of (?:the|this) (?:project|spending|investment)\b/i,
  /\bthe project (?:fixed|resolved|delivered)\b/i,
  /\bmoney well spent\b/i,
  /\bdemonstrates the value\b/i,
];

export const attributionOverclaims = (text: string): readonly string[] =>
  BANNED_ATTRIBUTION_PHRASES.filter((pattern) => pattern.test(text)).map(
    (pattern) => `"${text.match(pattern)?.[0] ?? ""}" asserts a cause this system cannot observe`,
  );

// ---------------------------------------------------------------------------
// Assumptions
// ---------------------------------------------------------------------------

/**
 * One thing an ordering rests on, and whether anything supports it.
 *
 * `asserted` is not a criticism — a policy has to choose somewhere. It is the
 * label that lets a reviewer answer "which of these would I argue with?",
 * which is the V043 clause about identifying unsupported assumptions.
 */
export type AssumptionSupport = "evidenced" | "asserted" | "absent";

export type Assumption = {
  readonly id: string;
  readonly statement: string;
  readonly support: AssumptionSupport;
  readonly detail: string;
};

export const ASSUMPTION_SUPPORT_LABELS: Readonly<Record<AssumptionSupport, string>> = {
  evidenced: "Backed by a loaded source",
  asserted: "Chosen by this deployment, with no evidence behind the choice",
  absent: "No source exists for this at all",
};

/**
 * Whether a set of assumptions is honest about itself.
 *
 * An ordering whose every assumption claims to be evidenced is the one to
 * distrust: some of these are configuration choices and saying otherwise is
 * the overclaim.
 */
export const assumptionsAreCandid = (assumptions: readonly Assumption[]): boolean =>
  assumptions.some((assumption) => assumption.support !== "evidenced");
