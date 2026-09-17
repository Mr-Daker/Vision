/**
 * Deterministic issue ageing and escalation (roadmap V036).
 *
 * The rule this exists to enforce: **an alert is a statement about a clock, not
 * about a problem.** Saying "this report has waited longer than this deployment
 * said it would tolerate" is a fact about a configured promise. Saying "this
 * problem is critical" is a claim about the world, and nothing here can support
 * one — no severity model exists and none has been calibrated (V046). V034
 * refused to invent urgency for the same reason, and this does not overturn it.
 *
 * So there is no score. There is an elapsed time, a threshold somebody
 * configured, and the fact of one having passed the other.
 *
 * Three properties the callers depend on:
 *
 * **Deterministic.** No clock is read in this file. `asOfMs` is supplied, so
 * the same inputs always produce the same assessment and a test can drive the
 * clock forward explicitly rather than sleeping.
 *
 * **Two clocks, one of which never alerts.** The department clock starts when
 * the department became responsible; it is what a department can fairly be held
 * to. The citizen clock starts when the issue was opened and is only ever
 * reported. Alerting on the citizen clock would punish a department for a
 * delay that happened before the report reached them; hiding it would let a
 * re-route erase somebody's six-week wait from the screen.
 *
 * **Pauses are explicit and subtractive.** A department waiting on citizens to
 * confirm a repair is not a department sitting on its hands, so that interval
 * does not count against it. The intervals are supplied by the caller, derived
 * from the issue's own recorded history, so the arithmetic is replayable.
 */

export type AgeingRule = {
  /** Days of effective department time before the first alert. */
  readonly alertAfterDays: number;
  /** Days before the second. Must exceed `alertAfterDays`. */
  readonly escalateAfterDays: number;
};

export type AgeingPolicyPack = {
  readonly version: string;
  /** What this is and is not. Travels with every assessment. */
  readonly note: string;
  readonly rules: Readonly<Record<string, AgeingRule>>;
  /**
   * Applied where the pack configures no rule for a category.
   *
   * Deliberately the *lenient* direction, which is the opposite of
   * `confirmation-policy.ts`. There, a configuration gap must not make closing
   * an issue easier, so the default is strict. Here, a gap must not manufacture
   * an alert against a department for a category nobody set a promise for —
   * that would be holding somebody to a deadline that was never agreed. The
   * asymmetry is deliberate: strictness always runs towards the citizen.
   */
  readonly fallback: AgeingRule;
};

/** A period during which the department clock did not run. `toMs` open = still paused. */
export type PausedInterval = {
  readonly fromMs: number;
  readonly toMs: number | undefined;
};

export type AgeingInput = {
  readonly category: string;
  readonly policy: AgeingPolicyPack;
  /** When the current department became responsible. Survives reassignment. */
  readonly departmentAnchorMs: number;
  /** When the issue was opened. Reported, never alerts. */
  readonly openedAtMs: number;
  readonly pausedIntervals: readonly PausedInterval[];
  /** A supervisor's reviewed override, when one stands. */
  readonly override?: AgeingRule | undefined;
  /** Supplied, never read from a clock in this file. */
  readonly asOfMs: number;
};

export type AgeingRuleId = "overdue" | "escalated";

export type AgeingAssessment = {
  /** Effective department time: elapsed since the anchor, less paused time. */
  readonly departmentAgeDays: number;
  /** Raw time since the issue was opened. Never pause-adjusted, never alerts. */
  readonly citizenAgeDays: number;
  readonly pausedDays: number;
  readonly appliedRule: AgeingRule;
  readonly ruleSource: "override" | "category" | "fallback";
  readonly policyVersion: string;
  readonly note: string;
  /** Rules whose threshold the department clock has passed. */
  readonly crossed: readonly AgeingRuleId[];
  /** Why, in words a supervisor can read. */
  readonly reasons: readonly string[];
};

export class AgeingPolicyError extends Error {}

const MS_PER_DAY = 86_400_000;

const validateRule = (rule: AgeingRule, label: string): void => {
  if (!Number.isFinite(rule.alertAfterDays) || rule.alertAfterDays <= 0) {
    throw new AgeingPolicyError(`${label} must set a positive alert_after_days`);
  }
  if (!Number.isFinite(rule.escalateAfterDays) || rule.escalateAfterDays <= 0) {
    throw new AgeingPolicyError(`${label} must set a positive escalate_after_days`);
  }
  if (rule.escalateAfterDays <= rule.alertAfterDays) {
    // An escalation that fires at or before the first alert is not a second
    // stage, it is the same stage twice — and it would make the two queues
    // identical, which tells a supervisor nothing.
    throw new AgeingPolicyError(
      `${label} must escalate later than it alerts (${String(rule.escalateAfterDays)} <= ${String(rule.alertAfterDays)})`,
    );
  }
};

/**
 * Paused milliseconds inside the window, with overlaps counted once.
 *
 * Intervals are clamped to `[anchorMs, asOfMs]`: a pause that began before the
 * department became responsible did not pause *their* clock, and one running
 * past the assessment moment has not yet happened. Overlapping intervals are
 * merged rather than summed, because two overlapping pauses are one period of
 * not-waiting, and adding them would credit a department twice.
 */
export const pausedMillisWithin = (
  intervals: readonly PausedInterval[],
  anchorMs: number,
  asOfMs: number,
): number => {
  const clamped = intervals
    .map((interval) => ({
      from: Math.max(interval.fromMs, anchorMs),
      to: Math.min(interval.toMs ?? asOfMs, asOfMs),
    }))
    .filter((interval) => interval.to > interval.from)
    .sort((left, right) => left.from - right.from);

  let total = 0;
  let cursorFrom = Number.NEGATIVE_INFINITY;
  let cursorTo = Number.NEGATIVE_INFINITY;
  for (const interval of clamped) {
    if (interval.from > cursorTo) {
      if (cursorTo > cursorFrom) total += cursorTo - cursorFrom;
      cursorFrom = interval.from;
      cursorTo = interval.to;
    } else if (interval.to > cursorTo) {
      cursorTo = interval.to;
    }
  }
  if (cursorTo > cursorFrom) total += cursorTo - cursorFrom;
  return total;
};

export const evaluateAgeing = (input: AgeingInput): AgeingAssessment => {
  if (input.policy.version.trim().length === 0) {
    throw new AgeingPolicyError("an ageing policy must declare a version");
  }
  if (input.policy.note.trim().length === 0) {
    // The note is the only place the policy states that an alert is about a
    // configured promise and not about how dangerous a problem is. A policy
    // without it is the severity claim this file exists to avoid.
    throw new AgeingPolicyError(
      "an ageing policy must carry a note saying what an alert does and does not mean",
    );
  }

  const configured = input.policy.rules[input.category];
  const appliedRule = input.override ?? configured ?? input.policy.fallback;
  const ruleSource =
    input.override !== undefined ? "override" : configured !== undefined ? "category" : "fallback";
  validateRule(appliedRule, `the ${ruleSource} ageing rule`);

  const pausedMs = pausedMillisWithin(
    input.pausedIntervals,
    input.departmentAnchorMs,
    input.asOfMs,
  );
  const elapsedMs = Math.max(0, input.asOfMs - input.departmentAnchorMs);
  const effectiveMs = Math.max(0, elapsedMs - pausedMs);

  const departmentAgeDays = effectiveMs / MS_PER_DAY;
  const citizenAgeDays = Math.max(0, input.asOfMs - input.openedAtMs) / MS_PER_DAY;
  const pausedDays = pausedMs / MS_PER_DAY;

  const crossed: AgeingRuleId[] = [];
  if (departmentAgeDays >= appliedRule.alertAfterDays) crossed.push("overdue");
  if (departmentAgeDays >= appliedRule.escalateAfterDays) crossed.push("escalated");

  const reasons: string[] = [];
  const rounded = (days: number): string => days.toFixed(1);
  reasons.push(
    ruleSource === "override"
      ? `a supervisor recorded an override for this issue, so it alerts after ${String(appliedRule.alertAfterDays)} days instead of the configured category rule`
      : ruleSource === "category"
        ? `policy '${input.policy.version}' gives category '${input.category}' ${String(appliedRule.alertAfterDays)} days before an alert and ${String(appliedRule.escalateAfterDays)} before escalation`
        : `policy '${input.policy.version}' configures no rule for category '${input.category}', so the lenient fallback of ${String(appliedRule.alertAfterDays)} days applies rather than a stricter guess`,
  );
  reasons.push(
    `this department has been responsible for ${rounded(departmentAgeDays)} days of running time` +
      (pausedMs > 0
        ? `, with ${rounded(pausedDays)} days paused while the department was not the party being waited on`
        : ""),
  );
  if (citizenAgeDays > departmentAgeDays + 0.05) {
    // Said out loud whenever the two differ: a re-route restarts the department
    // clock, and without this line the screen would quietly shorten somebody's
    // wait.
    reasons.push(
      `the person who reported it has been waiting ${rounded(citizenAgeDays)} days, longer than this department has been responsible`,
    );
  }

  return {
    departmentAgeDays,
    citizenAgeDays,
    pausedDays,
    appliedRule,
    ruleSource,
    policyVersion: input.policy.version,
    note: input.policy.note,
    crossed,
    reasons,
  };
};
