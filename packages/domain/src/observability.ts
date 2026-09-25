/**
 * What an alert has to carry to be worth waking someone for (roadmap V050).
 *
 * V050's "done when" is unusually specific: a deliberate processing failure must
 * produce an alert that can be **diagnosed using IDs and state**. That rules out
 * both of the usual failure modes at once.
 *
 *  * An alert that says "processing is failing" is not diagnosable. So
 *    `alert()` refuses to build one without the identifiers that lead to the
 *    thing — a correlation id, an aggregate id, a task id — and without the
 *    state it was in when it stopped.
 *
 *  * An alert that quotes the report is diagnosable and unacceptable. V005 §7
 *    and V044 both say a citizen's words do not travel into operational
 *    surfaces, and an alert is the most widely forwarded surface there is: it
 *    goes to a pager, an email, a group chat and a screenshot. So a reading
 *    carries identifiers, counts and codes, and `alert()` refuses free text in
 *    the fields that would otherwise accumulate it.
 *
 * The third rule is V048's, kept because it is the same mistake: an alert names
 * the runbook section an operator should open. A detection nobody can act on is
 * an alarm with no exit.
 *
 * Pure: no clock, no storage, no transport.
 */

/** The seven signals V050 names, in its own words. */
export type SignalName =
  | "correlated_requests"
  | "outbox_lag"
  | "queue_age"
  | "stage_failures"
  | "model_cost"
  | "database_saturation"
  | "summary_freshness";

export const SIGNAL_NAMES: readonly SignalName[] = [
  "correlated_requests",
  "outbox_lag",
  "queue_age",
  "stage_failures",
  "model_cost",
  "database_saturation",
  "summary_freshness",
];

export type SignalReading = {
  readonly signal: SignalName;
  /** What was counted or measured. Undefined when the signal could not be read. */
  readonly value: number | undefined;
  readonly unit: string;
  /** Why this signal could not be read, when it could not. */
  readonly unavailable?: string;
  /**
   * Identifiers that lead an operator to the thing.
   *
   * Bounded, and identifiers only. The rule is not "keep it short"; it is that
   * an alert is forwarded, screenshotted and pasted, so nothing may be in it
   * that would not be acceptable in a group chat.
   */
  readonly examples: readonly string[];
};

export const EXAMPLE_LIMIT = 10;

export type Severity = "info" | "warning" | "page";

export type Alert = {
  readonly signal: SignalName;
  readonly severity: Severity;
  /** One sentence, no identifiers and no content — those travel in their own fields. */
  readonly summary: string;
  readonly observed: number;
  readonly threshold: number;
  readonly unit: string;
  /** The ids that make this diagnosable. Required: an alert with none is a mood. */
  readonly identifiers: readonly string[];
  /** The state the thing was in. Required: an id with no state is a search, not a diagnosis. */
  readonly state: Readonly<Record<string, string | number>>;
  /** The runbook section to open. Required. */
  readonly runbook: string;
};

export class AlertError extends Error {}

/** Anything that looks like prose a person wrote rather than a code or an id. */
const looksLikeContent = (value: string): boolean =>
  // Four or more words in a row, which no identifier, code or version has.
  /(?:\b[\p{L}]+\b[ ,]+){3}\b[\p{L}]+\b/u.test(value);

export const alert = (input: Alert): Alert => {
  if (input.identifiers.length === 0) {
    throw new AlertError(
      `alert on '${input.signal}' carries no identifier; V050 requires a failure to be diagnosable by id and state, and an alert with neither is only a feeling`,
    );
  }
  if (Object.keys(input.state).length === 0) {
    throw new AlertError(
      `alert on '${input.signal}' carries no state; an identifier with no state tells an operator where to start looking rather than what happened`,
    );
  }
  if (input.runbook.trim().length === 0) {
    throw new AlertError(`alert on '${input.signal}' names no runbook section`);
  }
  for (const identifier of input.identifiers) {
    if (looksLikeContent(identifier)) {
      throw new AlertError(
        `alert on '${input.signal}' has prose where an identifier should be; an alert is forwarded, screenshotted and pasted, so a citizen's words must never be in one`,
      );
    }
  }
  for (const [key, value] of Object.entries(input.state)) {
    if (typeof value === "string" && looksLikeContent(value)) {
      throw new AlertError(
        `alert on '${input.signal}' has prose in state field '${key}'; state is codes, counts and timestamps`,
      );
    }
  }
  return {
    ...input,
    identifiers: input.identifiers.slice(0, EXAMPLE_LIMIT),
  };
};

export const alertStatement = (entry: Alert): string =>
  [
    `[${entry.severity}] ${entry.signal}: ${entry.summary}`,
    `  observed ${String(entry.observed)} ${entry.unit} against a threshold of ${String(entry.threshold)}`,
    `  state: ${Object.entries(entry.state)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(" ")}`,
    `  ids: ${entry.identifiers.join(", ")}`,
    `  runbook: ${entry.runbook}`,
  ].join("\n");

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

export type MonitoringVerdict = {
  /** Deliberately not `healthy`: it says only that no signal this build watches has crossed its threshold. */
  readonly noWatchedSignalIsFiring: boolean;
  readonly reasons: readonly string[];
  readonly alerts: readonly Alert[];
  readonly pages: number;
  readonly warnings: number;
};

export const monitoringVerdict = (input: {
  readonly readings: readonly SignalReading[];
  readonly alerts: readonly Alert[];
}): MonitoringVerdict => {
  const reasons: string[] = [];

  for (const reading of input.readings) {
    if (reading.value === undefined) {
      reasons.push(
        `'${reading.signal}' could not be read (${reading.unavailable ?? "no reason recorded"}), so nothing here says whether it is healthy — a signal that is silent because it is broken looks exactly like one that is silent because nothing is wrong`,
      );
    }
  }
  const covered = new Set(input.readings.map((reading) => reading.signal));
  for (const signal of SIGNAL_NAMES) {
    if (!covered.has(signal)) {
      reasons.push(`no reading for '${signal}', which V050 names explicitly`);
    }
  }
  for (const entry of input.alerts) {
    reasons.push(`${entry.signal} is firing at ${entry.severity}: ${entry.summary}`);
  }

  return {
    noWatchedSignalIsFiring: reasons.length === 0,
    reasons,
    alerts: input.alerts,
    pages: input.alerts.filter((entry) => entry.severity === "page").length,
    warnings: input.alerts.filter((entry) => entry.severity === "warning").length,
  };
};

export const MONITORING_LIMITS: readonly string[] = [
  "these are the seven signals V050 names; a failure that moves none of them produces no alert",
  "every reading is a point in time taken when the command ran, not a series — nothing here notices a slow drift between runs",
  "an alert carries identifiers, counts and codes and never a report's content, so diagnosing one always means opening the record it points at",
  "nothing here delivers an alert anywhere: this is the signal and its threshold, not a pager",
];

export const BANNED_MONITORING_PHRASES: readonly string[] = [
  "fully monitored",
  "all errors are caught",
  "complete observability",
  "nothing can go unnoticed",
  "guaranteed uptime",
  "self-healing",
];

export const monitoringOverclaims = (text: string): readonly string[] => {
  const haystack = text.toLowerCase();
  return BANNED_MONITORING_PHRASES.filter((phrase) => haystack.includes(phrase));
};
