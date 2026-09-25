/**
 * Whether resolutions lasted (roadmap V050a).
 *
 * The documented failure this exists for: of a thousand grievances received by
 * one civic body, roughly eight hundred are closed as resolved without anyone
 * attending to the issue. V035 already prevents that one closure at a time —
 * only a counted reporter's confirmation closes an issue, and a completion
 * photograph is evidence rather than certification. What V035 cannot see is the
 * **pattern**: which parts of the organisation produce closures that do not
 * hold.
 *
 * The name matters. This measures **durability** — did the resolution last —
 * and not integrity, honesty or intent. A closure that did not hold is a fact:
 * the issue came back. Why it came back is something this cannot know, and
 * every figure it produces carries the explanations it cannot rule out.
 *
 * Four refusals, and they are the substance rather than the caveats:
 *
 *  * **No score.** Counts and intervals, reusing V046's `figureOf`. A number
 *    like "73% reliable" attached to a unit of work is an uncalibrated
 *    judgement wearing a decimal point.
 *  * **No league table.** Ranking wards against each other is what V042
 *    refused for issues, for the same reason: an ordering between things whose
 *    intervals overlap is an ordering of noise.
 *  * **No individual by default.** `resolution_claim.staff_id` names a person.
 *    A pattern attached to a named worker can end their employment, so the
 *    unit here is the department and the ward, and naming a person is a
 *    deliberate act by a supervisor rather than a dashboard's default.
 *  * **No word that implies intent.** The finding is "did not hold". Not
 *    false, not fake, not negligent.
 *
 * Pure: no clock, no storage.
 */

import { figureOf, type Figure } from "./evaluation.ts";

/** What can be observed about a closure, each of them a fact in the record. */
export type DurabilitySignal =
  /** A confirmed closure whose issue was later reopened. */
  | "did_not_hold"
  /** The reporter answered the claim with a dispute. */
  | "disputed_by_reporter"
  /** The claim was filed in the last hours before the ageing threshold. */
  | "claimed_near_deadline"
  /** The claim followed the work being planned implausibly quickly. */
  | "claimed_implausibly_fast"
  /** The claim carried the least evidence the policy accepts. */
  | "minimum_evidence";

export const DURABILITY_SIGNALS: readonly DurabilitySignal[] = [
  "did_not_hold",
  "disputed_by_reporter",
  "claimed_near_deadline",
  "claimed_implausibly_fast",
  "minimum_evidence",
];

/**
 * What each signal is, and what it is not.
 *
 * `alternatives` is not a disclaimer appended to a finding — it is part of the
 * finding. Every one of these patterns has an innocent explanation that this
 * system cannot distinguish from the other kind, and a report that presents the
 * number without them has made an accusation it cannot support.
 */
export const SIGNAL_MEANING: Readonly<
  Record<DurabilitySignal, { readonly observed: string; readonly alternatives: readonly string[] }>
> = {
  did_not_hold: {
    observed: "the reporter confirmed the work, and the same issue was later reopened",
    alternatives: [
      "the fault genuinely recurred — a repair that holds for a season is still a repair",
      "this ward's infrastructure is older, so the same work fails sooner here than elsewhere",
      "the reporter who reopened it is more exacting than the one who confirmed it",
      "a seasonal cause the record does not carry, such as the first heavy rain after a dry repair",
    ],
  },
  disputed_by_reporter: {
    observed: "the reporter answered the completion claim with a dispute",
    alternatives: [
      "the crew and the reporter disagree about what counts as fixed, and either may be right",
      "the work was done on an adjacent problem the reporter was not describing",
      "a dispute is a person's judgement and carries no more proof than the claim it answers",
    ],
  },
  claimed_near_deadline: {
    observed:
      "the completion claim was filed in the final hours before this issue's ageing threshold",
    alternatives: [
      "work is genuinely scheduled in batches, and a batch that lands near a deadline is a schedule rather than a rush",
      "the threshold is when the crew was dispatched, so finishing near it is the process working",
      "the configured threshold may simply be shorter than the work takes",
    ],
  },
  claimed_implausibly_fast: {
    observed: "the claim followed the work being planned faster than the work plausibly takes",
    alternatives: [
      "the work was genuinely small — some repairs are minutes",
      "the crew was already at the location for something else",
      "the claim was filed from the field after the fact, so the timestamp is when it was recorded rather than when it was done",
    ],
  },
  minimum_evidence: {
    observed: "the claim carried the least evidence the policy accepts",
    alternatives: [
      "one photograph is sometimes all a repair needs to show",
      "a crew working without signal uploads what it can",
      "the policy's minimum is a floor somebody chose, and meeting a floor is not a failing",
    ],
  },
};

/**
 * The unit a figure is attached to.
 *
 * A department within a ward. Deliberately not a person: see the module note.
 */
export type DurabilityUnit = {
  readonly departmentId: string;
  readonly jurisdictionId: string;
  readonly label: string;
};

export type UnitObservation = {
  readonly unit: DurabilityUnit;
  /** Confirmed closures — the denominator for `did_not_hold`. */
  readonly confirmedClosures: number;
  /** Claims that received any answer — the denominator for a dispute. */
  readonly answeredClaims: number;
  /** All claims — the denominator for the three claim-shape signals. */
  readonly claims: number;
  readonly counts: Readonly<Record<DurabilitySignal, number>>;
};

const denominatorFor = (observation: UnitObservation, signal: DurabilitySignal): number => {
  if (signal === "did_not_hold") return observation.confirmedClosures;
  if (signal === "disputed_by_reporter") return observation.answeredClaims;
  return observation.claims;
};

/**
 * One signal for one unit, as counts and an interval.
 *
 * `figureOf` is V046's, unchanged: it carries a numerator, a denominator and a
 * 95% Wilson interval, and it refuses to be written as a rate until that
 * interval is narrow enough to distinguish anything. Three closures of which
 * one came back is not "33%".
 */
export const durabilityFigure = (observation: UnitObservation, signal: DurabilitySignal): Figure =>
  figureOf(observation.counts[signal], denominatorFor(observation, signal));

// ---------------------------------------------------------------------------
// Separation, which is what replaces a ranking
// ---------------------------------------------------------------------------

/**
 * Whether two figures can be told apart at all.
 *
 * This is what a league table would have been. Two units whose intervals
 * overlap are not distinguishable on this evidence, however different their
 * point values look, and ordering them would be ordering noise — V042's
 * reasoning about rank intervals, applied to the same problem one layer up.
 */
export const separated = (a: Figure, b: Figure): boolean => {
  if (a.kind !== "counted" || b.kind !== "counted") return false;
  return a.interval.low > b.interval.high || b.interval.low > a.interval.high;
};

/**
 * Closures a unit needs before a concern may be raised about it.
 *
 * Not a statistical floor — separation already handles that, and two closures
 * of which two came back does separate from an eleven-percent baseline. It is
 * an ethical one. A concern sends a person to examine a team's work, and below
 * roughly ten closures a single unlucky repair moves the figure by ten points
 * or more. Whether somebody's work gets looked at should not turn on one event.
 */
export const MINIMUM_CLOSURES_FOR_A_CONCERN = 10;

export const RANKING_REFUSAL =
  "units are never ordered against one another. Two figures whose 95% intervals overlap cannot be told apart on this evidence, and a table sorted by a point value would present that overlap as a difference. A unit appears below only when its interval does not overlap the baseline drawn from every other unit together.";

/**
 * A unit worth a person looking at.
 *
 * Deliberately not a threshold somebody picked. A concern is raised when the
 * unit's interval does not overlap the baseline computed from every other unit
 * — a statement about whether this unit can be distinguished from the rest of
 * the organisation, rather than about whether it crossed a line invented here.
 */
export type DurabilityConcern = {
  readonly unit: DurabilityUnit;
  readonly signal: DurabilitySignal;
  readonly figure: Figure;
  readonly baseline: Figure;
  readonly observed: string;
  readonly alternatives: readonly string[];
  /** What a supervisor does next. Never "discipline somebody". */
  readonly nextStep: string;
};

export const concernsFrom = (input: {
  readonly observations: readonly UnitObservation[];
  readonly signal: DurabilitySignal;
}): readonly DurabilityConcern[] => {
  const { observations, signal } = input;
  const concerns: DurabilityConcern[] = [];

  for (const observation of observations) {
    const figure = durabilityFigure(observation, signal);
    if (figure.kind !== "counted") continue;
    if (figure.denominator < MINIMUM_CLOSURES_FOR_A_CONCERN) continue;

    // The baseline is every other unit pooled, so a unit is never compared
    // against a number it is itself inside.
    const others = observations.filter((other) => other.unit.label !== observation.unit.label);
    const baseline = figureOf(
      others.reduce((total, other) => total + other.counts[signal], 0),
      others.reduce((total, other) => total + denominatorFor(other, signal), 0),
    );
    if (baseline.kind !== "counted") continue;
    if (!separated(figure, baseline)) continue;
    if (figure.interval.low <= baseline.interval.high) continue; // only the worse side

    concerns.push({
      unit: observation.unit,
      signal,
      figure,
      baseline,
      observed: SIGNAL_MEANING[signal].observed,
      alternatives: SIGNAL_MEANING[signal].alternatives,
      nextStep:
        "read the issues themselves before drawing any conclusion about the people doing the work. The record holds what was claimed, what evidence came with it, and what the reporter said; this figure holds none of that.",
    });
  }

  return concerns;
};

// ---------------------------------------------------------------------------
// What this cannot do
// ---------------------------------------------------------------------------

export const DURABILITY_LIMITS: readonly string[] = [
  "a closure that did not hold is a fact about the work; it is not a finding about the people who did it, and this cannot tell the two apart",
  "the most intuitive signal is deliberately absent: completion photographs carry no location, because V021 strips EXIF before storage, and recovering it would mean retaining location data from staff phones",
  "every figure here rests on reporters choosing to reopen or dispute, so a ward whose residents stopped bothering will look durable",
  "no unit is ranked against another, and a unit not listed is not thereby cleared — it may simply have too few closures to distinguish from anything, or fewer than the ten a concern requires",
  "the signals about a claim's shape — its timing and its evidence — are the weakest here, and none of them is evidence of anything on its own",
];

/**
 * Words this must never use about a unit of work.
 *
 * The list is about intent. "Did not hold" is what happened; "falsified" is a
 * claim about a person's mind, and nothing in this data reaches it.
 */
export const BANNED_DURABILITY_PHRASES: readonly string[] = [
  "fake closure",
  // A stem, so "falsify", "falsified" and "falsification" are all caught.
  "falsif",
  "fraudulent",
  "dishonest",
  "negligent",
  "deliberately closed",
  "lying",
  "misconduct",
  "reliability score",
  "worst performing",
  "best performing",
];

export const durabilityOverclaims = (text: string): readonly string[] => {
  const haystack = text.toLowerCase();
  return BANNED_DURABILITY_PHRASES.filter((phrase) => haystack.includes(phrase));
};
