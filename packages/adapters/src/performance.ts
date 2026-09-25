/**
 * Taking the measurements V049 asks for (roadmap V049).
 *
 * Every function here times the **real** function the deployment calls. Nothing
 * is reimplemented for speed, nothing is warmed differently from how it runs,
 * and a failed iteration is counted rather than retried — a latency figure that
 * silently excludes the requests that failed describes a system that was not
 * the one under test.
 *
 * The conditions are read from the machine and the database rather than
 * assumed, because the conditions are what make the numbers mean anything, and
 * a hand-written note about the hardware is a note that goes stale.
 */

import { cpus, hostname, totalmem } from "node:os";

import type { Measurement, PerformanceConditions } from "@vision/domain";

import type { Queryable } from "./outbox.ts";
import { retrieveCandidates } from "./candidates.ts";
import { readDistrictDashboard } from "./dashboard.ts";

/** Settings that change what every figure below means. Read, never assumed. */
const RECORDED_SETTINGS = [
  "max_connections",
  "superuser_reserved_connections",
  "shared_buffers",
  "work_mem",
  "effective_cache_size",
  "statement_timeout",
  "idle_in_transaction_session_timeout",
  "server_version",
] as const;

/** Tables whose size changes what a query costs. */
const COUNTED_TABLES = [
  "canonical_issue",
  "submission",
  "evidence_item",
  "issue_evidence_link",
  "issue_participation",
  "status_event",
  "outbox",
  "summary_issue_fact",
] as const;

export const measureConditions = async (
  tx: Queryable,
  options: { readonly concurrency: number },
): Promise<PerformanceConditions> => {
  const settings: Record<string, string> = {};
  for (const name of RECORDED_SETTINGS) {
    const { rows } = await tx.query("select current_setting($1, true) as value", [name]);
    settings[name] = String(rows[0]?.["value"] ?? "(not set)");
  }

  const rowsPresent: Record<string, number> = {};
  for (const table of COUNTED_TABLES) {
    const { rows } = await tx.query(`select count(*)::int as n from ${table}`);
    rowsPresent[table] = Number(rows[0]?.["n"] ?? 0);
  }

  return {
    host: hostname(),
    cpuCount: cpus().length,
    totalMemoryBytes: totalmem(),
    databaseSettings: settings,
    rowsPresent,
    startedAt: new Date().toISOString(),
    concurrency: options.concurrency,
  };
};

/**
 * Times an operation, counting failures rather than hiding them.
 *
 * `discard` iterations run first and are thrown away: the first call of
 * anything pays for a connection, a plan and a cold cache, and including it
 * would make every measurement a measurement of the first call.
 */
export const timed = async (
  name: string,
  operation: string,
  run: (iteration: number) => Promise<unknown>,
  options: { readonly iterations: number; readonly discard?: number },
): Promise<Measurement> => {
  const discard = options.discard ?? 3;
  for (let index = 0; index < discard; index += 1) {
    await run(-1 - index).catch(() => undefined);
  }

  const samples: number[] = [];
  let failures = 0;
  for (let index = 0; index < options.iterations; index += 1) {
    const startedAt = process.hrtime.bigint();
    try {
      await run(index);
      samples.push(Number(process.hrtime.bigint() - startedAt) / 1_000_000);
    } catch {
      failures += 1;
    }
  }
  return { name, operation, samples, unit: "ms", failures };
};

// ---------------------------------------------------------------------------
// The measurements V049 names
// ---------------------------------------------------------------------------

/**
 * How many candidates the timed queries actually returned.
 *
 * Recorded beside the latency because a query that matches nothing is fast, and
 * a fast retrieval figure that never retrieved anything is not a measurement of
 * retrieval.
 */
export let lastCandidateCounts: readonly number[] = [];

export const measureCandidateQuery = async (
  tx: Queryable,
  options: { readonly iterations: number },
): Promise<Measurement> => {
  const { rows } = await tx.query(
    `select ST_X(representative_location::geometry) as lon,
            ST_Y(representative_location::geometry) as lat
       from canonical_issue
      where representative_location is not null
      order by opened_at desc limit 50`,
  );
  if (rows.length === 0) {
    return {
      name: "candidate_query",
      operation: "retrieveCandidates over the issues present",
      samples: [],
      unit: "ms",
      failures: 0,
    };
  }
  const counts: number[] = [];
  const measurement = await timed(
    "candidate_query",
    "retrieveCandidates: the spatial and temporal search a new report runs against every open issue nearby (V026)",
    async (iteration) => {
      const row = rows[Math.abs(iteration) % rows.length];
      const result = await retrieveCandidates(tx, {
        lon: Number(row?.["lon"] ?? 75.61),
        lat: Number(row?.["lat"] ?? 17.81),
        accuracyMetres: 12,
        observedAt: new Date().toISOString(),
      } as never);
      if (iteration >= 0) counts.push(result.candidates.length);
      return result;
    },
    { iterations: options.iterations },
  );
  lastCandidateCounts = counts;
  return measurement;
};

export const measureDashboard = async (
  tx: Queryable,
  options: {
    readonly iterations: number;
    readonly jurisdictionIds: readonly string[];
    readonly trackedCategories: readonly string[];
    readonly jurisdictionProfileId: string;
  },
): Promise<Measurement> => {
  if (options.jurisdictionIds.length === 0) {
    return {
      name: "dashboard_read",
      operation: "readDistrictDashboard",
      samples: [],
      unit: "ms",
      failures: 0,
    };
  }
  return timed(
    "dashboard_read",
    "readDistrictDashboard: the whole district view, including its freshness and reconciliation state (V039)",
    async () =>
      readDistrictDashboard(tx, {
        jurisdictionScope: options.jurisdictionIds,
        trackedCategories: options.trackedCategories,
        jurisdictionProfileId: options.jurisdictionProfileId,
        asOf: new Date(),
      }),
    { iterations: options.iterations },
  );
};

/**
 * How much storage one issue costs, end to end.
 *
 * Measured as a delta rather than divided out of a total: the total includes
 * fixtures, seeds and several tasks' leftovers, and dividing it by the issue
 * count would attribute all of that to issues.
 */
export const measureStorageGrowth = async (
  tx: Queryable,
  makeOneIssue: () => Promise<void>,
  options: { readonly iterations: number },
): Promise<{
  readonly bytesPerIssue: number | undefined;
  readonly beforeBytes: number;
  readonly afterBytes: number;
  readonly iterations: number;
}> => {
  const total = async (): Promise<number> => {
    const { rows } = await tx.query(
      `select coalesce(sum(pg_total_relation_size(c.oid)), 0)::bigint as bytes
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'`,
    );
    return Number(rows[0]?.["bytes"] ?? 0);
  };

  const beforeBytes = await total();
  for (let index = 0; index < options.iterations; index += 1) await makeOneIssue();
  // Statistics and free space make a small delta noisy, so the figure is
  // reported with the raw totals beside it rather than on its own.
  await tx.query("analyze").catch(() => undefined);
  const afterBytes = await total();

  return {
    bytesPerIssue:
      options.iterations === 0 ? undefined : (afterBytes - beforeBytes) / options.iterations,
    beforeBytes,
    afterBytes,
    iterations: options.iterations,
  };
};

/**
 * How many connections this database will actually give the workload.
 *
 * V006 §5 sets a gate — `max_connections` minus the superuser reservation minus
 * six for administration must leave at least 36 — and records that it is
 * unverified against a managed instance. This measures the local one by opening
 * connections until it refuses, which is the only way to learn the number the
 * setting produces rather than the number it claims.
 */
export const measureConnectionCapacity = async (
  connect: () => Promise<{ readonly close: () => Promise<void> }>,
  options: { readonly ceiling: number },
): Promise<{
  readonly opened: number;
  readonly refusedAt: number | undefined;
  readonly reachedCeiling: boolean;
}> => {
  const open: { readonly close: () => Promise<void> }[] = [];
  let refusedAt: number | undefined;
  try {
    while (open.length < options.ceiling) {
      try {
        open.push(await connect());
      } catch {
        refusedAt = open.length + 1;
        break;
      }
    }
    return {
      opened: open.length,
      refusedAt,
      reachedCeiling: refusedAt === undefined,
    };
  } finally {
    for (const connection of open) await connection.close().catch(() => undefined);
  }
};
