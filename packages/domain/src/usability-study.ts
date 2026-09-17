/**
 * The comparative usability study design (roadmap V045).
 *
 * V045 asks for a comparison between this prototype and an existing flow, run
 * with consenting participants. **No participant session has been run.** This
 * file exists so that the design is code rather than prose, and so that the
 * absence of data cannot quietly become a claim.
 *
 * The rule it enforces: **a comparative effort claim requires a sample.**
 * `comparativeClaimVerdict` refuses at n = 0, refuses when only one arm was
 * run, and refuses when the order was not counterbalanced — because a study
 * where everybody met the prototype second measures practice as much as
 * design. There is no override, and the refusal carries what is missing so it
 * reads as a next step rather than a wall.
 *
 * The counterbalancing is here too, as a function rather than an instruction,
 * so a run that does not follow it produces a record that does not match the
 * design rather than a sentence somebody forgot.
 *
 * Pure: no clock, no storage.
 */

/** The three flows V045 names. Every participant does all three in each arm. */
export type StudyTask = "reporting" | "duplicate_confirmation" | "report_tracking";

export const STUDY_TASKS: readonly StudyTask[] = [
  "reporting",
  "duplicate_confirmation",
  "report_tracking",
];

/**
 * The conditions V045 requires to be tested explicitly.
 *
 * Kept separate from the tasks because every condition applies to every task,
 * and a study that tested keyboard-only reporting but not keyboard-only
 * tracking would have covered the word rather than the requirement.
 */
export type StudyCondition =
  | "keyboard_only"
  | "screen_reader"
  | "text_zoom_200"
  | "language_en_IN"
  | "language_mr_IN"
  | "constrained_mobile_network";

export const STUDY_CONDITIONS: readonly StudyCondition[] = [
  "keyboard_only",
  "screen_reader",
  "text_zoom_200",
  "language_en_IN",
  "language_mr_IN",
  "constrained_mobile_network",
];

export type StudyArm = "prototype" | "existing_flow";

/**
 * Which arm a participant meets first.
 *
 * Alternating by index. Whoever goes second has already solved the task once,
 * so without this the comparison measures practice as much as design — and the
 * direction of that bias is always in favour of whichever arm came second.
 */
export const firstArmFor = (participantIndex: number): StudyArm =>
  participantIndex % 2 === 0 ? "prototype" : "existing_flow";

export const counterbalanceOrder = (participantIndex: number): readonly StudyArm[] => {
  const first = firstArmFor(participantIndex);
  return first === "prototype" ? ["prototype", "existing_flow"] : ["existing_flow", "prototype"];
};

/** Whether the orders actually run are balanced enough to compare. */
export const isCounterbalanced = (orders: readonly (readonly StudyArm[])[]): boolean => {
  if (orders.length === 0) return false;
  const prototypeFirst = orders.filter((order) => order[0] === "prototype").length;
  return Math.abs(prototypeFirst - (orders.length - prototypeFirst)) <= 1;
};

// ---------------------------------------------------------------------------
// What a session must record
// ---------------------------------------------------------------------------

/**
 * One participant's run of one task in one arm.
 *
 * `assistanceEvents` and `errors` are counts of things that happened, not
 * judgements. `understanding` is the answer to a comprehension probe rather
 * than an observer's impression, because "they seemed to understand" is the
 * observation most likely to be wrong and least likely to be challenged.
 */
export type TaskRecord = {
  readonly participantIndex: number;
  readonly arm: StudyArm;
  readonly task: StudyTask;
  readonly conditions: readonly StudyCondition[];
  readonly completed: boolean;
  readonly completionSeconds: number | null;
  readonly assistanceEvents: number;
  readonly errors: number;
  /** The participant's own answer to a comprehension probe, verbatim. */
  readonly understandingProbe: string;
  /** Anything the observer noticed. Never a substitute for the fields above. */
  readonly observerNote: string;
};

export type StudyResults = {
  readonly protocolVersion: string;
  readonly sampleSize: number;
  readonly records: readonly TaskRecord[];
  readonly conditionsRun: readonly StudyCondition[];
  /** Consent recorded for every participant, or the study cannot be reported. */
  readonly consentRecorded: boolean;
  /** V045 forbids filing real complaints in the existing flow. */
  readonly noRealComplaintsFiled: boolean;
};

export type ClaimVerdict =
  { readonly permitted: true } | { readonly permitted: false; readonly reasons: readonly string[] };

/**
 * Whether the results support a comparative effort claim.
 *
 * Refuses by default and lists everything missing. The claims this gates are
 * the ones a demonstration most wants to make — "faster than", "easier than",
 * "fewer errors" — and each is a statement about people that only people can
 * support.
 */
export const comparativeClaimVerdict = (results: StudyResults): ClaimVerdict => {
  const reasons: string[] = [];

  if (results.sampleSize === 0) {
    reasons.push(
      "no participant session has been run, so there is nothing to compare; every comparative statement would be about people nobody observed",
    );
  } else if (results.sampleSize < 5) {
    reasons.push(
      `${String(results.sampleSize)} participant(s) is below the five this protocol treats as the floor for reporting a difference at all`,
    );
  }

  const arms = new Set(results.records.map((record) => record.arm));
  if (arms.size < 2) {
    reasons.push(
      "only one arm was run, and a comparison needs both; measuring one flow tells you about that flow",
    );
  }

  const orders = [...new Set(results.records.map((record) => record.participantIndex))]
    .sort((a, b) => a - b)
    .map((index) => counterbalanceOrder(index));
  if (!isCounterbalanced(orders)) {
    reasons.push(
      "the order was not counterbalanced, so any difference includes the practice the second attempt carries",
    );
  }

  const missing = STUDY_CONDITIONS.filter(
    (condition) => !results.conditionsRun.includes(condition),
  );
  if (missing.length > 0) {
    reasons.push(`these required conditions were not run: ${missing.join(", ")}`);
  }

  if (!results.consentRecorded) {
    reasons.push("consent was not recorded for every participant");
  }
  if (!results.noRealComplaintsFiled) {
    reasons.push(
      "the existing flow was exercised with real complaints, which V045 forbids: a test must not put invented reports in front of a real authority",
    );
  }

  return reasons.length === 0 ? { permitted: true } : { permitted: false, reasons };
};

/**
 * Phrasing that asserts a comparison.
 *
 * Checked against any published summary. Each of these is a claim about how
 * people fared, and none of them can be supported by anything short of people.
 */
export const BANNED_COMPARATIVE_PHRASES: readonly RegExp[] = [
  /\beasier than\b/i,
  /\bfaster than\b/i,
  /\bquicker than\b/i,
  /\bsimpler than\b/i,
  /\bfewer errors than\b/i,
  /\busers preferred\b/i,
  /\bparticipants preferred\b/i,
  /\b\d+ ?% (?:quicker|faster|easier)\b/i,
  /\bmore accessible than\b/i,
];

export const comparativeOverclaims = (text: string): readonly string[] =>
  BANNED_COMPARATIVE_PHRASES.filter((pattern) => pattern.test(text)).map(
    (pattern) =>
      `"${text.match(pattern)?.[0] ?? ""}" compares two flows using evidence about people`,
  );

/**
 * What an automated accessibility pass can and cannot establish.
 *
 * Stated because a green machine check is the easiest thing in this task to
 * mistake for the study itself.
 */
export const AUTOMATED_PASS_LIMITS: readonly string[] = [
  "An automated pass establishes that controls have names, that structure exists, and that nothing is unreachable by keyboard. It does not establish that anybody could complete the task.",
  "No automated check can tell whether a sentence was understood, whether a person knew what would happen when they pressed a button, or whether they gave up.",
  "Screen-reader verification here means the accessibility tree was inspected, not that somebody who uses a screen reader daily attempted the task.",
  "Nothing in this pass supports a comparison with any other flow.",
];
