/**
 * Reading the seven signals V050 names (roadmap V050).
 *
 * Each reading is a query against the operational tables and nothing else: no
 * counter is kept in a process, because a counter in a process is lost on
 * restart and disagrees between instances, and the question these answer —
 * *is work moving?* — is answered by the work itself.
 *
 * Every reading carries identifiers, counts and codes. None carries a report's
 * words. An alert is the most widely forwarded surface this system has: it goes
 * to a pager, an email, a group chat and a screenshot, so the rule from V005 §7
 * is at its strictest here rather than its loosest.
 */

import {
  EXAMPLE_LIMIT,
  alert,
  type Alert,
  type SignalName,
  type SignalReading,
} from "@vision/domain";

import type { Queryable } from "./outbox.ts";
import { summaryStatus } from "./summaries.ts";

export type ObservabilityOptions = {
  readonly asOf: Date;
  /** The window the rate signals are counted over. */
  readonly windowMinutes?: number;
  readonly summaryName?: string;
};

type Row = Record<string, unknown>;

const reading = (
  signal: SignalName,
  value: number | undefined,
  unit: string,
  examples: readonly string[],
  unavailable?: string,
): SignalReading => ({
  signal,
  value,
  unit,
  examples: examples.slice(0, EXAMPLE_LIMIT),
  ...(unavailable === undefined ? {} : { unavailable }),
});

const read = async (
  tx: Queryable,
  signal: SignalName,
  unit: string,
  sql: string,
  params: readonly unknown[],
  shape: (rows: readonly Row[]) => { value: number | undefined; examples: readonly string[] },
): Promise<SignalReading> => {
  try {
    const { rows } = await tx.query(sql, [...params]);
    const shaped = shape(rows as readonly Row[]);
    return reading(signal, shaped.value, unit, shaped.examples);
  } catch (error) {
    // Recorded as unreadable rather than as zero. A signal that is silent
    // because it is broken looks exactly like one that is silent because
    // nothing is wrong, and only one of those is good news.
    return reading(
      signal,
      undefined,
      unit,
      [],
      error instanceof Error ? error.message : String(error),
    );
  }
};

export const readSignals = async (
  tx: Queryable,
  options: ObservabilityOptions,
): Promise<readonly SignalReading[]> => {
  const windowMinutes = options.windowMinutes ?? 60;

  const untraceable = await read(
    tx,
    "correlated_requests",
    "events without a correlation id",
    `select event_id::text as id from status_event
      where recorded_at > now() - ($1::int * interval '1 minute')
        and (correlation_id is null or correlation_id::text = '')
      limit 20`,
    [windowMinutes],
    (rows) => ({ value: rows.length, examples: rows.map((row) => String(row["id"])) }),
  );

  const outboxLag = await read(
    tx,
    "outbox_lag",
    "seconds",
    `select coalesce(max(extract(epoch from (now() - created_at))), 0)::int as seconds,
            (array_agg(outbox_id::text order by created_at asc))[1:10] as ids
       from outbox where delivered_at is null and terminal_failure_reason is null`,
    [],
    (rows) => ({
      value: Number(rows[0]?.["seconds"] ?? 0),
      examples: ((rows[0]?.["ids"] as string[] | null) ?? []).map(String),
    }),
  );

  const queueAge = await read(
    tx,
    "queue_age",
    "seconds",
    `select coalesce(max(extract(epoch from (now() - created_at))), 0)::int as seconds,
            (array_agg(outbox_id::text order by created_at asc))[1:10] as ids
       from outbox
      where delivered_at is null and terminal_failure_reason is null
        and not_before <= now() and claimed_at is null`,
    [],
    (rows) => ({
      value: Number(rows[0]?.["seconds"] ?? 0),
      examples: ((rows[0]?.["ids"] as string[] | null) ?? []).map(String),
    }),
  );

  const stageFailures = await read(
    tx,
    "stage_failures",
    "terminal failures",
    `select outbox_id::text as id from outbox
      where terminal_failure_reason is not null and delivered_at is null
      order by created_at desc limit 20`,
    [],
    (rows) => ({ value: rows.length, examples: rows.map((row) => String(row["id"])) }),
  );

  const modelCost = await read(
    tx,
    "model_cost",
    "provider calls",
    `select count(*)::int as calls,
            (array_agg(model_name order by created_at desc))[1:5] as models
       from ai_result_cache
      where created_at > now() - ($1::int * interval '1 minute')`,
    [windowMinutes],
    (rows) => ({
      value: Number(rows[0]?.["calls"] ?? 0),
      examples: ((rows[0]?.["models"] as string[] | null) ?? []).map(String),
    }),
  );

  const saturation = await read(
    tx,
    "database_saturation",
    "percent of max_connections",
    `select (count(*)::numeric * 100
             / greatest(current_setting('max_connections')::numeric, 1))::int as percent,
            count(*)::int as in_use
       from pg_stat_activity where datname = current_database()`,
    [],
    (rows) => ({
      value: Number(rows[0]?.["percent"] ?? 0),
      examples: [`connections_in_use=${String(rows[0]?.["in_use"] ?? 0)}`],
    }),
  );

  let freshness: SignalReading;
  try {
    const status = await summaryStatus(tx, {
      asOf: options.asOf,
      ...(options.summaryName === undefined ? {} : { summaryName: options.summaryName }),
    });
    freshness = reading(
      "summary_freshness",
      status.freshness.pendingEvents + status.freshness.unprojectedIssues,
      "unapplied events and unprojected issues",
      [
        `state=${status.freshness.state}`,
        `pending=${String(status.freshness.pendingEvents)}`,
        `unprojected=${String(status.freshness.unprojectedIssues)}`,
      ],
    );
  } catch (error) {
    freshness = reading(
      "summary_freshness",
      undefined,
      "unapplied events and unprojected issues",
      [],
      error instanceof Error ? error.message : String(error),
    );
  }

  return [untraceable, outboxLag, queueAge, stageFailures, modelCost, saturation, freshness];
};

// ---------------------------------------------------------------------------
// Turning a reading into an alert
// ---------------------------------------------------------------------------

/** Which budget each signal is compared against, and how loudly it fires. */
const SIGNAL_BUDGETS: Readonly<
  Record<
    SignalName,
    { readonly budget: string; readonly severity: "warning" | "page"; readonly runbook: string }
  >
> = {
  correlated_requests: {
    budget: "untraceable_events",
    severity: "page",
    runbook: "V050 runbook §5 — an event nobody can follow",
  },
  outbox_lag: {
    budget: "outbox_lag_seconds",
    severity: "page",
    runbook: "V050 runbook §2 — the queue has stopped moving",
  },
  queue_age: {
    budget: "queue_age_seconds",
    severity: "warning",
    runbook: "V050 runbook §2 — the queue has stopped moving",
  },
  stage_failures: {
    budget: "stage_failures",
    severity: "page",
    runbook: "V050 runbook §3 — safe replay",
  },
  model_cost: {
    budget: "model_calls_per_hour",
    severity: "warning",
    runbook: "V050 runbook §6 — a provider bill that is climbing",
  },
  database_saturation: {
    budget: "database_saturation_percent",
    severity: "page",
    runbook: "V050 runbook §7 — the database is running out of connections",
  },
  summary_freshness: {
    budget: "summary_lag_events",
    severity: "warning",
    runbook: "V050 runbook §4 — the dashboard is behind the records",
  },
};

export type BudgetLike = {
  readonly name: string;
  readonly limit: number;
  readonly unit: string;
  readonly direction: "at_most" | "at_least";
};

export const alertsFrom = (
  readings: readonly SignalReading[],
  budgets: readonly BudgetLike[],
): readonly Alert[] => {
  const byName = new Map(budgets.map((entry) => [entry.name, entry]));
  const alerts: Alert[] = [];

  for (const signalReading of readings) {
    if (signalReading.value === undefined) continue;
    const mapping = SIGNAL_BUDGETS[signalReading.signal];
    const budget = byName.get(mapping.budget);
    if (budget === undefined) continue;

    const breached =
      budget.direction === "at_most"
        ? signalReading.value > budget.limit
        : signalReading.value < budget.limit;
    if (!breached) continue;

    alerts.push(
      alert({
        signal: signalReading.signal,
        severity: mapping.severity,
        summary: `${signalReading.signal} is past its budget`,
        observed: signalReading.value,
        threshold: budget.limit,
        unit: budget.unit,
        // An alert with no identifier cannot be diagnosed, so a signal with no
        // example of its own says which budget it broke rather than nothing.
        identifiers:
          signalReading.examples.length > 0 ? signalReading.examples : [`budget:${budget.name}`],
        state: {
          signal: signalReading.signal,
          observed: signalReading.value,
          threshold: budget.limit,
          direction: budget.direction,
        },
        runbook: mapping.runbook,
      }),
    );
  }

  return alerts;
};
