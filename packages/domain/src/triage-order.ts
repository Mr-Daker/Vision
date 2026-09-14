/**
 * Deterministic triage ordering (roadmap V034).
 *
 * V034 declined to build urgency, on the grounds that "inventing one here
 * would be a policy decision disguised as a field". That reasoning is right,
 * and this does not overturn it. What this provides is the thing a staff inbox
 * actually needs and can honestly have: a **configured ordering**.
 *
 * The difference is not cosmetic.
 *
 *  * An urgency score makes a claim about the world — that this problem is
 *    more dangerous than that one. Nothing in this system can support such a
 *    claim: no severity model exists, none has been calibrated (V046), and a
 *    number attached to somebody's report would be read as a measurement.
 *  * An ordering policy makes a claim about the *deployment* — that whoever
 *    configured it chose to look at one kind of report before another. That is
 *    a decision a person made, it is recorded as data, and it is attributable.
 *
 * So the output has a position in a list and the reasons for it, and carries
 * the policy's version and its own caveat. It has no score.
 *
 * Two orderings are deliberately refused:
 *
 *  * **By number of reporters.** A count of reporters measures who owns a
 *    phone and who knows this service exists. Ordering by it would put the
 *    best-connected neighbourhoods first, which is the inequity this project
 *    exists to work against. The count is reported by the inbox; it does not
 *    move anything up the list.
 *  * **By anything non-deterministic.** The same input gives the same list, so
 *    a person working down the queue does not see items twice or miss them.
 */

export type TriagePolicy = {
  readonly version: string;
  /** What this ordering is and is not. Travels with every entry. */
  readonly note: string;
  /** Categories in the order this deployment wants to see them. Unlisted goes last. */
  readonly categoryOrder: readonly string[];
  /**
   * After this many days a report is placed by age instead of by category.
   *
   * Without it, a category near the bottom of the list is never reached at
   * all. The number is the policy's choice, not this file's.
   */
  readonly ageEscalationDays: number;
};

export type TriageCandidate = {
  readonly issueId: string;
  readonly publicReference: string;
  readonly category: string;
  readonly ageDays: number;
  /** Reported, never used for ordering. See the note above. */
  readonly countedParticipants: number;
};

export type TriageEntry = {
  readonly issueId: string;
  readonly publicReference: string;
  readonly category: string;
  readonly ageDays: number;
  readonly countedParticipants: number;
  /** 1-based place in this ordering. A position in a list, not a score. */
  readonly position: number;
  /** Why it is here, in plain language. */
  readonly basis: readonly string[];
  readonly policyVersion: string;
  readonly policyNote: string;
};

export class TriagePolicyError extends Error {}

export const orderTriageQueue = (
  candidates: readonly TriageCandidate[],
  policy: TriagePolicy,
): readonly TriageEntry[] => {
  if (policy.version.trim().length === 0) {
    throw new TriagePolicyError("a triage policy must declare a version");
  }
  if (policy.note.trim().length === 0) {
    // Refused rather than defaulted. The note is the only place the ordering
    // states that it is not a severity judgement, and an ordering without it
    // is the "policy decision disguised as a field" V034 declined to build.
    throw new TriagePolicyError(
      "a triage policy must carry a note saying what the ordering is and is not",
    );
  }

  // Unlisted categories sort after every listed one, which is why the fallback
  // is the length of the list rather than -1 or 0.
  const rank = (category: string): number => {
    const index = policy.categoryOrder.indexOf(category);
    return index === -1 ? policy.categoryOrder.length : index;
  };

  const escalated = (candidate: TriageCandidate): boolean =>
    candidate.ageDays > policy.ageEscalationDays;

  // A copy: the caller's array is not the place to record an ordering, and a
  // sort in place would change a list somebody else may still be reading.
  const sorted = [...candidates].sort((left, right) => {
    // An escalated report is placed by age, ahead of everything not escalated.
    if (escalated(left) !== escalated(right)) return escalated(left) ? -1 : 1;
    if (escalated(left) && escalated(right)) {
      if (left.ageDays !== right.ageDays) return right.ageDays - left.ageDays;
      return left.publicReference.localeCompare(right.publicReference);
    }
    const byCategory = rank(left.category) - rank(right.category);
    if (byCategory !== 0) return byCategory;
    // Oldest first within a category: a report that has waited longer has a
    // stronger claim than one that arrived this morning.
    if (left.ageDays !== right.ageDays) return right.ageDays - left.ageDays;
    // The final tiebreak is the public reference, which is stable and
    // arbitrary — arbitrary on purpose, because any *meaningful* tiebreak here
    // would be a judgement the policy did not make.
    return left.publicReference.localeCompare(right.publicReference);
  });

  return sorted.map((candidate, index) => {
    const basis: string[] = [];
    if (escalated(candidate)) {
      basis.push(
        `this report has been waiting ${String(Math.round(candidate.ageDays))} days, longer than the ${String(policy.ageEscalationDays)} days policy '${policy.version}' allows before age decides the order`,
      );
    } else if (policy.categoryOrder.includes(candidate.category)) {
      basis.push(
        `policy '${policy.version}' places category '${candidate.category}' at position ${String(rank(candidate.category) + 1)} of ${String(policy.categoryOrder.length)} in its configured order`,
      );
    } else {
      basis.push(
        `policy '${policy.version}' has no ordering rule for category '${candidate.category}', so it is not listed ahead of the categories it does cover`,
      );
    }
    basis.push(
      `waiting ${String(Math.round(candidate.ageDays))} days, which orders it within its group`,
    );
    return {
      issueId: candidate.issueId,
      publicReference: candidate.publicReference,
      category: candidate.category,
      ageDays: candidate.ageDays,
      countedParticipants: candidate.countedParticipants,
      position: index + 1,
      basis,
      policyVersion: policy.version,
      policyNote: policy.note,
    };
  });
};
