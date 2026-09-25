/**
 * Derived state, checked against what it is derived from (roadmap V048).
 *
 * V048 asks that unrecoverable states be **visible with an operator repair
 * procedure**. Two words in that sentence do the work:
 *
 *  * **Visible.** A corruption nobody looks for is a corruption nobody finds.
 *    So there is a command, it exits non-zero, and it can gate a release rather
 *    than be read.
 *
 *  * **Procedure.** A finding that says "the projection disagrees with the
 *    records" tells an operator at three in the morning nothing they can act
 *    on. Every check here carries the sentence somebody would follow, and
 *    `integrityFinding` refuses to build one without it. A detection with no
 *    procedure is an alarm with no exit.
 *
 * Three further rules, each learned from an earlier task:
 *
 *  * **A check that has never been seen to fire is not evidence** (V044). Every
 *    check declares a probe that makes it fire, and a test plants each one.
 *  * **A finding never reproduces content** (V044). Identifiers only, bounded.
 *  * **Repairing is not this tool's job** (V038). It reports; a person decides.
 *    The one exception is stated as such: a projection that a rebuild would fix
 *    is labelled `repairable_by_rebuild`, and even then nothing is rebuilt here.
 *
 * Pure: no clock, no storage, no SQL.
 */

/** The four properties V048's "done when" names, plus delivery, which carries them. */
export type Invariant =
  "issue_membership" | "uniqueness" | "permitted_transitions" | "metric_denominators" | "delivery";

export const INVARIANTS: readonly Invariant[] = [
  "issue_membership",
  "uniqueness",
  "permitted_transitions",
  "metric_denominators",
  "delivery",
];

/**
 * What can be done about a finding.
 *
 * The distinction that matters is the third one. `unrecoverable` does not mean
 * the system is stuck; it means **the information needed to decide correctly no
 * longer exists**, so whatever an operator does next is a choice rather than a
 * repair, and the record should say a person chose.
 */
export type Recoverability = "repairable_by_rebuild" | "repairable_by_operator" | "unrecoverable";

export type IntegrityFinding = {
  readonly check: string;
  readonly invariant: Invariant;
  readonly recoverability: Recoverability;
  /** What is wrong, in a sentence, with no identifiers in it. */
  readonly what: string;
  /** Identifiers only, bounded. Never a report's words, a location or a name. */
  readonly affected: readonly string[];
  /** How many rows matched, which may exceed what `affected` lists. */
  readonly matched: number;
  /** What an operator does. Required. */
  readonly procedure: string;
  /** What happens if nobody acts. Required, because "urgent" is not a severity. */
  readonly ifNobodyActs: string;
  /**
   * What cannot be recovered. Required for `unrecoverable`, refused otherwise —
   * a repairable finding claiming a loss would make every alert read the same.
   */
  readonly lost?: string;
};

export class IntegrityFindingError extends Error {}

/** At most this many identifiers travel into a finding. */
export const AFFECTED_LIMIT = 20;

/**
 * Builds a finding, refusing the ones that would be useless.
 *
 * Deliberately a function rather than an object literal: the fields that make a
 * finding actionable are exactly the ones that get left out when somebody is
 * adding a check quickly.
 */
export const integrityFinding = (input: {
  readonly check: string;
  readonly invariant: Invariant;
  readonly recoverability: Recoverability;
  readonly what: string;
  readonly affected: readonly string[];
  readonly matched: number;
  readonly procedure: string;
  readonly ifNobodyActs: string;
  readonly lost?: string;
}): IntegrityFinding => {
  if (input.procedure.trim().length < 20) {
    throw new IntegrityFindingError(
      `check '${input.check}' has no repair procedure; a detection an operator cannot act on is an alarm with no exit`,
    );
  }
  if (input.ifNobodyActs.trim().length < 20) {
    throw new IntegrityFindingError(
      `check '${input.check}' does not say what happens if nobody acts, so nobody can tell whether it is worth waking up for`,
    );
  }
  if (input.recoverability === "unrecoverable" && (input.lost ?? "").trim().length < 10) {
    throw new IntegrityFindingError(
      `check '${input.check}' is unrecoverable and does not say what was lost; "unrecoverable" without that is a mood, not a finding`,
    );
  }
  if (input.recoverability !== "unrecoverable" && input.lost !== undefined) {
    throw new IntegrityFindingError(
      `check '${input.check}' claims something was lost while reporting itself as repairable`,
    );
  }
  return {
    check: input.check,
    invariant: input.invariant,
    recoverability: input.recoverability,
    what: input.what,
    affected: input.affected.slice(0, AFFECTED_LIMIT),
    matched: input.matched,
    procedure: input.procedure,
    ifNobodyActs: input.ifNobodyActs,
    ...(input.lost === undefined ? {} : { lost: input.lost }),
  };
};

/** How a finding is written down. Identifiers are listed; content never appears. */
export const findingStatement = (finding: IntegrityFinding): string => {
  const listed =
    finding.affected.length === 0
      ? "no identifiers recorded"
      : finding.affected.length < finding.matched
        ? `${finding.affected.join(", ")} (and ${String(finding.matched - finding.affected.length)} more)`
        : finding.affected.join(", ");
  return [
    `${finding.check} — ${finding.what}`,
    `  rows: ${String(finding.matched)} (${listed})`,
    `  if nobody acts: ${finding.ifNobodyActs}`,
    ...(finding.lost === undefined ? [] : [`  lost: ${finding.lost}`]),
    `  do this: ${finding.procedure}`,
  ].join("\n");
};

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

export type CheckOutcome = {
  readonly check: string;
  readonly invariant: Invariant;
  /** False when the check could not run at all — a missing table, a timeout. */
  readonly ran: boolean;
  readonly reasonNotRun?: string;
  readonly findings: readonly IntegrityFinding[];
  /**
   * The database constraint that makes this condition unrepresentable, when
   * there is one.
   *
   * Four of these checks turned out to be looking for states the schema
   * already refuses — found by trying to plant them and being rejected. A
   * check that cannot fire is not a check; it is decoration that makes a report
   * look thorough. Rather than delete them, each names the constraint that is
   * doing the actual work, and `integrity.dbtest.ts` proves the constraint
   * refuses the planting instead of proving the query finds it. A guarantee the
   * database enforces on every write is stronger than one a script looks for
   * once a night, and saying which is which is the point.
   */
  readonly enforcedBy?: string;
};

export type IntegrityVerdict = {
  /** Checks whose condition the schema makes unrepresentable. */
  readonly enforcedByTheDatabase: number;
  /**
   * Deliberately not named `consistent`. It says only that every check that ran
   * found nothing, which is a smaller statement than the database being sound.
   */
  readonly everyCheckRanAndFoundNothing: boolean;
  readonly reasons: readonly string[];
  readonly findings: readonly IntegrityFinding[];
  readonly unrecoverable: number;
  readonly operatorRepairs: number;
  readonly rebuildRepairs: number;
};

export const integrityVerdict = (outcomes: readonly CheckOutcome[]): IntegrityVerdict => {
  const reasons: string[] = [];
  const findings = outcomes.flatMap((outcome) => outcome.findings);

  for (const outcome of outcomes) {
    if (!outcome.ran) {
      reasons.push(
        `'${outcome.check}' did not run (${outcome.reasonNotRun ?? "no reason recorded"}), so nothing here says whether ${outcome.invariant} holds`,
      );
    }
  }
  for (const finding of findings) {
    reasons.push(`'${finding.check}' found ${String(finding.matched)} row(s): ${finding.what}`);
  }

  const covered = new Set(outcomes.filter((outcome) => outcome.ran).map((o) => o.invariant));
  for (const invariant of INVARIANTS) {
    if (!covered.has(invariant)) {
      reasons.push(`no check ran for '${invariant}', which V048 names explicitly`);
    }
  }

  return {
    enforcedByTheDatabase: outcomes.filter((outcome) => outcome.enforcedBy !== undefined).length,
    everyCheckRanAndFoundNothing: reasons.length === 0,
    reasons,
    findings,
    unrecoverable: findings.filter((f) => f.recoverability === "unrecoverable").length,
    operatorRepairs: findings.filter((f) => f.recoverability === "repairable_by_operator").length,
    rebuildRepairs: findings.filter((f) => f.recoverability === "repairable_by_rebuild").length,
  };
};

/**
 * What a clean run still does not establish.
 *
 * Printed with every result, because "no findings" is read as "the data is
 * correct" unless the distance is stated in the same breath.
 */
export const INTEGRITY_LIMITS: readonly string[] = [
  "these are the invariants somebody wrote down; a corruption that breaks none of them produces no finding",
  "a check compares derived state against the records it was derived from, so a fault in the records themselves is invisible to it",
  "it reads identifiers and counts, never report content, so nothing here says whether a report says what its author meant",
  "a clean result describes the moment it ran; nothing prevents the next write from breaking an invariant a second later",
  "four of these conditions cannot occur at all, because a database constraint refuses them; those checks are a second opinion and have never been able to fire",
];

export const BANNED_INTEGRITY_PHRASES: readonly string[] = [
  "guaranteed consistent",
  "cannot be corrupted",
  "self-healing",
  "always correct",
  "provably correct",
  "no data loss is possible",
  "fully consistent",
];

export const integrityOverclaims = (text: string): readonly string[] => {
  const haystack = text.toLowerCase();
  return BANNED_INTEGRITY_PHRASES.filter((phrase) => haystack.includes(phrase));
};
