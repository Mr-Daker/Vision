/**
 * Executable analytics metrics (roadmap V037).
 *
 * `metric-semantics.ts` in the domain package declares what each metric means.
 * This file is the other half: the SQL that produces it. The two are held
 * together by `analytics-doc-sync.test.ts`, which fails if the catalogue and
 * these queries stop covering exactly the same fifteen metrics, and if the SQL
 * published in the V037 document is not character-for-character the SQL that
 * runs here. A formula nobody can re-run is not reproducible, and a formula
 * that has quietly drifted from its documentation is worse than none.
 *
 * Three things every query in this file shares.
 *
 * **Two time bounds, not one.** `occurred_at <= :as_of` asks what had happened
 * by a moment. `recorded_at <= :knowledge_cutoff` asks what this system knew by
 * a moment. They are different questions and a backdated event answers them
 * differently: it belongs in the first from the day it describes, and in the
 * second only from the day it arrived. Every event predicate carries both, so
 * a late correction can never leak backwards into a snapshot that was
 * published before it existed.
 *
 * **Alias resolution that fails safely.** A merge cycle or a chain longer than
 * `MAX_ALIAS_HOPS` resolves to nothing and drops out of every count, rather
 * than resolving to whichever issue the walk happened to stop on. An
 * undercount that can be found is recoverable; a confident wrong root is not.
 *
 * **Status from the ledger at a past horizon.** At a live horizon the stored
 * `current_status` is the answer. At a past one it is not — it is today's
 * value, and reading it would let a state reached last week appear in a
 * snapshot of the week before. Past horizons reconstruct from `status_event`,
 * and where the ledger cannot establish a status, the answer is UNKNOWN rather
 * than a borrowed one.
 *
 * That last sentence was, for a while, the whole report. Nothing appended an
 * event when an issue was opened or routed, so every past horizon over real
 * data answered UNKNOWN for every issue — a correct refusal that was also a
 * complete one, which is the failure mode of a safe default nobody can
 * satisfy. `issue_created` is in the walk below for that reason: an issue's
 * opening is a fact about its state, and an issue in scope by `opened_at`
 * whose ledger says nothing about it is a gap, not a mystery.
 */

import {
  METRIC_IDS,
  METRIC_CATALOGUE,
  known,
  median,
  ratio,
  unknown,
  type MetricId,
  type MetricValue,
  type ResolutionSpeed,
} from "@vision/domain";

import type { Queryable } from "./outbox.ts";

export class AnalyticsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnalyticsError";
  }
}

/** The default fixed window for M05. Configured per report, never assumed downstream. */
export const DEFAULT_FIXED_WINDOW_DAYS = 30;

export type MetricParams = {
  /** Event-time bound. What had happened in the world by this instant. */
  readonly asOf: string;
  /** Ingestion-time bound. What this system had been told by this instant. */
  readonly knowledgeCutoff: string;
  /** Cohort window, half-open `[start, end)`. Required by M03-M06. */
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly fixedWindowDays: number;
};

/**
 * Whether the horizon is the present.
 *
 * At a live horizon the stored status column is authoritative and complete. At
 * a past one only the ledger is admissible. This is the seam between the two,
 * stated as one function so both sides of it are visible in the result.
 */
export type HorizonMode = "live" | "historical";

export const horizonMode = (params: MetricParams, nowMs: number): HorizonMode =>
  Date.parse(params.asOf) >= nowMs && Date.parse(params.knowledgeCutoff) >= nowMs
    ? "live"
    : "historical";

export const defaultParams = (nowMs: number, windowDays = 90): MetricParams => {
  const asOf = new Date(nowMs).toISOString();
  return {
    asOf,
    knowledgeCutoff: asOf,
    windowStart: new Date(nowMs - windowDays * 86_400_000).toISOString(),
    windowEnd: asOf,
    fixedWindowDays: DEFAULT_FIXED_WINDOW_DAYS,
  };
};

// ---------------------------------------------------------------------------
// The shared prelude
// ---------------------------------------------------------------------------

/**
 * Bindings shared by every metric body: `$1` as-of, `$2` knowledge cutoff,
 * `$3` live-horizon flag, `$4` window start, `$5` window end.
 *
 * The recursive walk carries its own path so a cycle is detected rather than
 * looped over, and stops at `MAX_ALIAS_HOPS`; a chain that is still running
 * when it stops keeps an active outgoing edge and is therefore excluded by the
 * `not exists` clause below, which is how depth exhaustion fails safely.
 */
export const METRIC_PRELUDE_SQL = `with recursive
  params as (
    -- Every metric body is appended to this same prelude and is executed with
    -- the same five bindings plus this one, so the parameter has to be named
    -- here even where the body does not read it.
    select $6::int as fixed_window_days
  ),
  bounded_event as (
    select (aggregate_id)::uuid as issue_id, event_type, occurred_at, aggregate_version
      from status_event
     where aggregate_type = 'canonical_issue'
       and occurred_at <= $1::timestamptz
       and recorded_at <= $2::timestamptz
  ),
  active_alias as (
    select source_issue_id, target_issue_id
      from issue_alias
     where valid_from <= $1::timestamptz
       and (valid_to is null or valid_to > $1::timestamptz)
  ),
  walk as (
    select c.issue_id as original_id, c.issue_id as current_id, 0 as hops,
           array[c.issue_id] as path, false as cycle
      from canonical_issue c
     where c.opened_at <= $1::timestamptz
    union all
    select w.original_id, a.target_issue_id, w.hops + 1,
           w.path || a.target_issue_id, a.target_issue_id = any(w.path)
      from walk w
      join active_alias a on a.source_issue_id = w.current_id
     where w.cycle = false and w.hops < 16
  ),
  walked as (
    select distinct on (original_id) original_id, current_id as root_id, hops, cycle
      from walk
     order by original_id, hops desc
  ),
  active_roots as (
    select w.original_id, w.root_id
      from walked w
     where w.cycle = false
       and not exists (select 1 from active_alias a where a.source_issue_id = w.root_id)
  ),
  roots as (
    select distinct ar.root_id
      from active_roots ar
      join canonical_issue c on c.issue_id = ar.root_id
     where c.opened_at <= $1::timestamptz
  ),
  ledger_status as (
    select distinct on (issue_id) issue_id,
           case event_type
             when 'issue_created' then 'created'
             when 'routing_review' then 'routing_review'
             when 'routed_internal' then 'routed_internal'
             when 'agency_ack_received' then 'agency_ack_received'
             when 'work_planned' then 'work_planned'
             when 'disputed_work_returned' then 'work_planned'
             when 'resolution_claimed' then 'resolution_claimed'
             when 'resolution_confirmed' then 'resolution_confirmed'
             when 'resolution_disputed' then 'resolution_disputed'
             when 'issue_reopened' then 'reopened'
           end as status
      from bounded_event
     where event_type in ('issue_created','routing_review','routed_internal',
                          'agency_ack_received','work_planned','disputed_work_returned',
                          'resolution_claimed','resolution_confirmed','resolution_disputed',
                          'issue_reopened')
     order by issue_id, occurred_at desc, aggregate_version desc
  ),
  issue_status as (
    select r.root_id as issue_id,
           case when $3::boolean then c.current_status else l.status end as status,
           case when $3::boolean then c.category else null end as category,
           case when $3::boolean then c.jurisdiction_id else null end as jurisdiction_id,
           c.opened_at
      from roots r
      join canonical_issue c on c.issue_id = r.root_id
      left join ledger_status l on l.issue_id = r.root_id
  ),
  lifecycle as (
    select issue_id,
           min(occurred_at) filter (where event_type = 'resolution_confirmed') as first_confirmed_at,
           max(occurred_at) filter (where event_type = 'resolution_confirmed') as last_confirmed_at,
           min(occurred_at) filter (where event_type = 'issue_reopened') as first_reopened_at,
           count(*) filter (where event_type = 'issue_reopened') as reopened_count
      from bounded_event
     group by issue_id
  ),
  cohort as (
    select s.issue_id, s.status, s.opened_at
      from issue_status s
     where s.opened_at >= $4::timestamptz and s.opened_at < $5::timestamptz
  )`;

// ---------------------------------------------------------------------------
// Metric bodies
// ---------------------------------------------------------------------------

/**
 * One complete statement per metric, appended to the prelude.
 *
 * Every one of them reports its own unknowns in the same row as its value, so
 * a caller never sees a count without also seeing how many records could not
 * be classified into it.
 */
export const METRIC_SQL: Readonly<Record<MetricId, string>> = {
  M01: `select
  count(*) filter (where s.status is not null and s.status <> 'resolution_confirmed')::int as value,
  count(*) filter (where s.status is null)::int as unknown_rows
from issue_status s`,

  M02: `select s.category, s.jurisdiction_id, j.directory_version as boundary_version,
       count(*) filter (where s.status is not null and s.status <> 'resolution_confirmed')::int as value,
       count(*) filter (where s.status is null)::int as unknown_rows
  from issue_status s
  left join jurisdiction j on j.jurisdiction_id = s.jurisdiction_id
 group by s.category, s.jurisdiction_id, j.directory_version
 order by s.category nulls last, s.jurisdiction_id nulls last`,

  M03: `select count(*)::int as value, 0 as unknown_rows from cohort`,

  M04: `select
  count(*) filter (where c.status = 'resolution_confirmed')::int as numerator,
  count(*)::int as denominator,
  count(*) filter (where c.status is null)::int as unknown_rows
from cohort c`,

  M05: `select
  count(*) filter (
    where l.first_confirmed_at is not null
      and l.first_confirmed_at
            <= c.opened_at + make_interval(days => (select fixed_window_days from params))
      and (l.first_reopened_at is null
           or l.first_reopened_at
                > c.opened_at + make_interval(days => (select fixed_window_days from params)))
  )::int as numerator,
  count(*)::int as denominator,
  0 as unknown_rows
from cohort c
left join lifecycle l on l.issue_id = c.issue_id
where c.opened_at + make_interval(days => (select fixed_window_days from params))
        <= $1::timestamptz`,

  M06: `, reopen_gap as (
    select e.issue_id,
           sum(extract(epoch from (
             coalesce((select min(n.occurred_at) from bounded_event n
                        where n.issue_id = e.issue_id
                          and n.event_type = 'resolution_confirmed'
                          and n.occurred_at > e.occurred_at), $1::timestamptz)
             - e.occurred_at))) / 3600.0 as gap_hours
      from bounded_event e
     where e.event_type = 'issue_reopened'
     group by e.issue_id
  ),
  reopen_cycle as (
    select e.issue_id,
           extract(epoch from (e.occurred_at - (
             select max(p.occurred_at) from bounded_event p
              where p.issue_id = e.issue_id
                and p.event_type = 'resolution_confirmed'
                and p.occurred_at <= e.occurred_at))) / 3600.0 as cycle_hours
      from bounded_event e
     where e.event_type = 'issue_reopened'
  )
select c.issue_id,
       c.status,
       round((extract(epoch from (l.first_confirmed_at - c.opened_at)) / 3600.0)::numeric, 1)
         as first_confirmation_hours,
       round(((extract(epoch from (l.last_confirmed_at - c.opened_at)) / 3600.0)
              - coalesce(g.gap_hours, 0))::numeric, 1) as standing_resolution_hours,
       round((select avg(rc.cycle_hours) from reopen_cycle rc where rc.issue_id = c.issue_id)::numeric, 1)
         as reopening_cycle_hours
  from cohort c
  left join lifecycle l on l.issue_id = c.issue_id
  left join reopen_gap g on g.issue_id = c.issue_id`,

  M07: `select
  round(percentile_cont(0.5) within group (
    order by extract(epoch from ($1::timestamptz - s.opened_at)) / 3600.0)::numeric, 1) as median_hours,
  round(max(extract(epoch from ($1::timestamptz - s.opened_at)) / 3600.0)::numeric, 1) as max_hours,
  count(*)::int as denominator,
  count(*) filter (where s.status is null)::int as unknown_rows
from issue_status s
where s.status is not null and s.status <> 'resolution_confirmed'`,

  M08: `select count(*) filter (where s.status = 'resolution_claimed')::int as value,
       count(*) filter (where s.status is null)::int as unknown_rows
  from issue_status s`,

  M09: `select count(*) filter (where s.status = 'resolution_disputed')::int as value,
       count(*) filter (where s.status is null)::int as unknown_rows
  from issue_status s`,

  M10: `select
  count(*) filter (where l.reopened_count > 0)::int as numerator,
  count(*)::int as denominator,
  0 as unknown_rows
from issue_status s
join lifecycle l on l.issue_id = s.issue_id
where l.first_confirmed_at is not null`,

  M11: `select count(*) filter (where s.status = 'resolution_confirmed')::int as value,
       count(*) filter (where s.status is null)::int as unknown_rows
  from issue_status s`,

  M12: `select
  (select count(distinct p.participant_id)
     from active_roots ar
     join roots r on r.root_id = ar.root_id
     join issue_participation p on p.canonical_issue_id = ar.original_id
    where p.counted = true and p.first_evidence_at <= $1::timestamptz)::int as distinct_in_scope,
  (select coalesce(sum(n), 0) from (
     select count(distinct p.participant_id) as n
       from active_roots ar
       join roots r on r.root_id = ar.root_id
       join issue_participation p on p.canonical_issue_id = ar.original_id
      where p.counted = true and p.first_evidence_at <= $1::timestamptz
      group by ar.root_id) per_root)::int as sum_of_per_root,
  (select count(*) from issue_participation p2
     join active_roots ar2 on ar2.original_id = p2.canonical_issue_id
    where p2.counted = false and p2.first_evidence_at <= $1::timestamptz)::int as not_counted_rows`,

  M13: `select
  (select count(distinct e.submission_id)
     from active_roots ar
     join roots r on r.root_id = ar.root_id
     join issue_evidence_link l on l.canonical_issue_id = ar.original_id
     join evidence_item e on e.evidence_id = l.evidence_id
    where l.effective_from <= $1::timestamptz)::int as submissions,
  (select count(*)
     from active_roots ar
     join roots r on r.root_id = ar.root_id
     join issue_evidence_link l on l.canonical_issue_id = ar.original_id
    where l.effective_from <= $1::timestamptz
      and (l.effective_to is null or l.effective_to > $1::timestamptz))::int as active_links,
  (select count(*)
     from active_roots ar
     join roots r on r.root_id = ar.root_id
     join issue_evidence_link l on l.canonical_issue_id = ar.original_id
    where l.effective_from <= $1::timestamptz)::int as historical_links,
  (select count(*)
     from roots r
     join resolution_claim rc on rc.issue_id = r.root_id
     join resolution_evidence_item ri on ri.claim_id = rc.claim_id
    where rc.claimed_at <= $1::timestamptz and ri.privacy_state = 'active')::int as completion_evidence`,

  M14: `select j.jurisdiction_id, j.directory_version as boundary_version,
       o.value as population, o.missing_indicator, o.unit, o.vintage,
       s.source_name as population_source, s.licence_or_permission_status as licence,
       d.synthetic_provenance
  from jurisdiction j
  left join context_dataset d
    on d.kind = 'population' and d.jurisdiction_profile_id = j.jurisdiction_profile_id
  left join context_observation o
    on o.dataset_id = d.dataset_id and o.jurisdiction_id = j.jurisdiction_id
   and o.vintage <= $1::timestamptz
  left join source_record s on s.source_record_id = d.source_record_id
 where j.effective_from <= $1::timestamptz
   and (j.effective_to is null or j.effective_to > $1::timestamptz)
 order by j.internal_code`,

  M15: `select
  count(*)::int as denominator,
  count(*) filter (where s.status is null
                      or s.category is null
                      or s.jurisdiction_id is null)::int as any_dimension_unknown,
  count(*) filter (where s.status is null)::int as status_unknown,
  count(*) filter (where s.category is null)::int as category_unknown,
  count(*) filter (where s.jurisdiction_id is null)::int as jurisdiction_unknown
from issue_status s`,
};

const sqlFor = (id: MetricId): string => `${METRIC_PRELUDE_SQL}\n${METRIC_SQL[id]}`;

/** The exact statement executed for a metric, for documentation and for replay. */
export const metricStatement = (id: MetricId): string => sqlFor(id);

const bind = (params: MetricParams, mode: HorizonMode): readonly unknown[] => [
  params.asOf,
  params.knowledgeCutoff,
  mode === "live",
  params.windowStart,
  params.windowEnd,
  params.fixedWindowDays,
];

const num = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);

const requiredNum = (value: unknown): number => Number(value ?? 0);

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export type MetricReading = {
  readonly id: MetricId;
  readonly title: string;
  readonly unit: string;
  readonly mode: HorizonMode;
  readonly measure: MetricValue;
  /** Records the metric could not classify. Reported next to the value, never folded into it. */
  readonly unknownRows: number;
  readonly disclosures: readonly string[];
};

export type BacklogGroup = {
  readonly category: string | null;
  readonly jurisdictionId: string | null;
  readonly boundaryVersion: string | null;
  readonly value: number;
  readonly unknownRows: number;
};

export type EvidenceVolumes = {
  readonly submissions: number;
  readonly activeLinks: number;
  readonly historicalLinks: number;
  readonly completionEvidence: number;
};

export type ContributorCounts = {
  /** Distinct people across the whole scope. The only figure that may be quoted. */
  readonly distinctInScope: number;
  /** What adding the per-issue counts would have produced. Kept to show the gap. */
  readonly sumOfPerRoot: number;
  readonly notCountedRows: number;
};

export type PopulationRow = {
  readonly jurisdictionId: string;
  readonly boundaryVersion: string;
  readonly population: MetricValue;
  readonly source: string | null;
  readonly unit: string | null;
  readonly vintage: string | null;
  readonly licence: string | null;
  /** True when the loaded figure is team-created synthetic data (V040). */
  readonly synthetic: boolean;
  /** The source's own words when it recorded no figure. */
  readonly missingIndicator: string | null;
};

export type CoverageCounts = {
  readonly rows: number;
  /** Roots missing at least one dimension. The headline, because one missing
   * dimension is enough to make a row unplaceable on a chart. */
  readonly anyDimensionUnknown: number;
  readonly statusUnknown: number;
  readonly categoryUnknown: number;
  readonly jurisdictionUnknown: number;
};

const reading = (
  id: MetricId,
  mode: HorizonMode,
  measure: MetricValue,
  unknownRows: number,
): MetricReading => {
  const contract = METRIC_CATALOGUE[id];
  return {
    id,
    title: contract.title,
    unit: contract.unit,
    mode,
    measure,
    unknownRows,
    disclosures: contract.disclosures,
  };
};

// ---------------------------------------------------------------------------
// Individual metrics
// ---------------------------------------------------------------------------

const scalar = async (
  tx: Queryable,
  id: MetricId,
  params: MetricParams,
  mode: HorizonMode,
): Promise<MetricReading> => {
  const { rows } = await tx.query(sqlFor(id), [...bind(params, mode)]);
  const row = rows[0];
  return reading(id, mode, known(requiredNum(row?.["value"])), requiredNum(row?.["unknown_rows"]));
};

const rate = async (
  tx: Queryable,
  id: MetricId,
  params: MetricParams,
  mode: HorizonMode,
): Promise<MetricReading> => {
  const { rows } = await tx.query(sqlFor(id), [...bind(params, mode)]);
  const row = rows[0];
  return reading(
    id,
    mode,
    ratio(num(row?.["numerator"]), num(row?.["denominator"])),
    requiredNum(row?.["unknown_rows"]),
  );
};

export const currentBacklog = (
  tx: Queryable,
  params: MetricParams,
  mode: HorizonMode,
): Promise<MetricReading> => scalar(tx, "M01", params, mode);

export const backlogByDimension = async (
  tx: Queryable,
  params: MetricParams,
  mode: HorizonMode,
): Promise<readonly BacklogGroup[]> => {
  const { rows } = await tx.query(sqlFor("M02"), [...bind(params, mode)]);
  return rows.map((row) => ({
    category:
      row["category"] === null || row["category"] === undefined ? null : String(row["category"]),
    jurisdictionId:
      row["jurisdiction_id"] === null || row["jurisdiction_id"] === undefined
        ? null
        : String(row["jurisdiction_id"]),
    boundaryVersion:
      row["boundary_version"] === null || row["boundary_version"] === undefined
        ? null
        : String(row["boundary_version"]),
    value: requiredNum(row["value"]),
    unknownRows: requiredNum(row["unknown_rows"]),
  }));
};

export const acceptedCohort = (
  tx: Queryable,
  params: MetricParams,
  mode: HorizonMode,
): Promise<MetricReading> => scalar(tx, "M03", params, mode);

export const standingResolutionRate = (
  tx: Queryable,
  params: MetricParams,
  mode: HorizonMode,
): Promise<MetricReading> => rate(tx, "M04", params, mode);

export const fixedWindowResolutionRate = (
  tx: Queryable,
  params: MetricParams,
  mode: HorizonMode,
): Promise<MetricReading> => rate(tx, "M05", params, mode);

/**
 * Time to resolution, with the unresolved remainder attached.
 *
 * The return type has no field a caller could read as "how fast is this
 * department" on its own — every duration arrives inside `ResolutionSpeed`,
 * which carries `stillWaitingCount`, and `speedStatement` is the only
 * supported way to render one.
 */
export const timeToResolution = async (
  tx: Queryable,
  params: MetricParams,
  mode: HorizonMode,
): Promise<ResolutionSpeed> => {
  const { rows } = await tx.query(sqlFor("M06"), [...bind(params, mode)]);
  const first: number[] = [];
  const standing: number[] = [];
  const cycles: number[] = [];
  let resolved = 0;
  let waiting = 0;

  for (const row of rows) {
    const firstHours = num(row["first_confirmation_hours"]);
    const standingHours = num(row["standing_resolution_hours"]);
    const cycleHours = num(row["reopening_cycle_hours"]);
    if (firstHours === null) {
      waiting += 1;
    } else {
      resolved += 1;
      first.push(firstHours);
      if (standingHours !== null) standing.push(standingHours);
    }
    if (cycleHours !== null) cycles.push(cycleHours);
  }

  return {
    resolvedCount: resolved,
    stillWaitingCount: waiting,
    firstConfirmationHoursMedian: median(first),
    standingResolutionHoursMedian: median(standing),
    reopeningCycleHoursMedian: median(cycles),
  };
};

export const unresolvedAge = async (
  tx: Queryable,
  params: MetricParams,
  mode: HorizonMode,
): Promise<{
  readonly reading: MetricReading;
  readonly maxHours: MetricValue;
  readonly backlogSize: number;
}> => {
  const { rows } = await tx.query(sqlFor("M07"), [...bind(params, mode)]);
  const row = rows[0];
  const denominator = requiredNum(row?.["denominator"]);
  const medianHours = num(row?.["median_hours"]);
  const maxHours = num(row?.["max_hours"]);
  return {
    reading: reading(
      "M07",
      mode,
      denominator === 0 || medianHours === null ? unknown("empty_denominator") : known(medianHours),
      requiredNum(row?.["unknown_rows"]),
    ),
    maxHours:
      denominator === 0 || maxHours === null ? unknown("empty_denominator") : known(maxHours),
    backlogSize: denominator,
  };
};

export const claimsAwaitingResponse = (
  tx: Queryable,
  params: MetricParams,
  mode: HorizonMode,
): Promise<MetricReading> => scalar(tx, "M08", params, mode);

export const disputedResolutions = (
  tx: Queryable,
  params: MetricParams,
  mode: HorizonMode,
): Promise<MetricReading> => scalar(tx, "M09", params, mode);

export const reopeningRate = (
  tx: Queryable,
  params: MetricParams,
  mode: HorizonMode,
): Promise<MetricReading> => rate(tx, "M10", params, mode);

export const standingConfirmed = (
  tx: Queryable,
  params: MetricParams,
  mode: HorizonMode,
): Promise<MetricReading> => scalar(tx, "M11", params, mode);

/**
 * Distinct counted demo participants.
 *
 * `sumOfPerRoot` is returned deliberately, and is never the headline. It is
 * what a dashboard would print if it added up the per-issue counts, and having
 * both numbers side by side is what makes the double-counting visible instead
 * of merely asserted.
 */
export const uniqueContributors = async (
  tx: Queryable,
  params: MetricParams,
  mode: HorizonMode,
): Promise<ContributorCounts> => {
  const { rows } = await tx.query(sqlFor("M12"), [...bind(params, mode)]);
  const row = rows[0];
  return {
    distinctInScope: requiredNum(row?.["distinct_in_scope"]),
    sumOfPerRoot: requiredNum(row?.["sum_of_per_root"]),
    notCountedRows: requiredNum(row?.["not_counted_rows"]),
  };
};

export const evidenceVolumes = async (
  tx: Queryable,
  params: MetricParams,
  mode: HorizonMode,
): Promise<EvidenceVolumes> => {
  const { rows } = await tx.query(sqlFor("M13"), [...bind(params, mode)]);
  const row = rows[0];
  return {
    submissions: requiredNum(row?.["submissions"]),
    activeLinks: requiredNum(row?.["active_links"]),
    historicalLinks: requiredNum(row?.["historical_links"]),
    completionEvidence: requiredNum(row?.["completion_evidence"]),
  };
};

/**
 * Estimated population, from the V040 context import.
 *
 * Three outcomes, and the distinction between the last two matters. A boundary
 * with no loaded observation is unknown because nothing was imported for it. A
 * boundary whose source recorded `NA` or `not surveyed` is unknown because the
 * source itself said so — a fact about the survey, not about this system — and
 * it is reported with the source's own words. Neither ever becomes `0`, and
 * report volume is never substituted for either.
 *
 * Every row carries its unit, vintage, licence and whether it is synthetic, so
 * a caller cannot render the number without the things that qualify it.
 */
export const estimatedPopulation = async (
  tx: Queryable,
  params: MetricParams,
  mode: HorizonMode,
): Promise<readonly PopulationRow[]> => {
  const { rows } = await tx.query(sqlFor("M14"), [...bind(params, mode)]);
  const text = (value: unknown): string | null =>
    value === null || value === undefined ? null : String(value);
  return rows.map((row) => {
    const missingIndicator = text(row["missing_indicator"]);
    const source = text(row["population_source"]);
    return {
      jurisdictionId: String(row["jurisdiction_id"]),
      boundaryVersion: String(row["boundary_version"]),
      population:
        row["population"] === null || row["population"] === undefined
          ? unknown(missingIndicator === null ? "no_population_source" : "source_reported_unknown")
          : known(Number(row["population"])),
      source,
      unit: text(row["unit"]),
      vintage:
        row["vintage"] === null || row["vintage"] === undefined
          ? null
          : new Date(String(row["vintage"])).toISOString(),
      licence: text(row["licence"]),
      synthetic: row["synthetic_provenance"] === true,
      missingIndicator,
    };
  });
};

export const dataCoverage = async (
  tx: Queryable,
  params: MetricParams,
  mode: HorizonMode,
): Promise<{
  readonly counts: CoverageCounts;
  readonly incomplete: MetricValue;
  readonly statusCoverage: MetricValue;
}> => {
  const { rows } = await tx.query(sqlFor("M15"), [...bind(params, mode)]);
  const row = rows[0];
  const counts: CoverageCounts = {
    rows: requiredNum(row?.["denominator"]),
    anyDimensionUnknown: requiredNum(row?.["any_dimension_unknown"]),
    statusUnknown: requiredNum(row?.["status_unknown"]),
    categoryUnknown: requiredNum(row?.["category_unknown"]),
    jurisdictionUnknown: requiredNum(row?.["jurisdiction_unknown"]),
  };
  return {
    counts,
    incomplete: ratio(counts.anyDimensionUnknown, counts.rows),
    statusCoverage: ratio(counts.statusUnknown, counts.rows),
  };
};

// ---------------------------------------------------------------------------
// The whole report
// ---------------------------------------------------------------------------

export type MetricReport = {
  readonly params: MetricParams;
  readonly mode: HorizonMode;
  readonly readings: readonly MetricReading[];
  readonly backlogByDimension: readonly BacklogGroup[];
  readonly speed: ResolutionSpeed;
  readonly maxUnresolvedAgeHours: MetricValue;
  readonly contributors: ContributorCounts;
  readonly evidence: EvidenceVolumes;
  readonly population: readonly PopulationRow[];
  readonly coverage: CoverageCounts;
};

export const computeMetricReport = async (
  tx: Queryable,
  params: MetricParams,
  nowMs: number,
): Promise<MetricReport> => {
  if (Date.parse(params.windowEnd) <= Date.parse(params.windowStart)) {
    throw new AnalyticsError("window end must be after window start; [start, end) is half-open");
  }
  if (params.fixedWindowDays <= 0) {
    throw new AnalyticsError("fixed window must be a positive number of days");
  }
  const mode = horizonMode(params, nowMs);

  const backlog = await currentBacklog(tx, params, mode);
  const groups = await backlogByDimension(tx, params, mode);
  const cohort = await acceptedCohort(tx, params, mode);
  const standingRate = await standingResolutionRate(tx, params, mode);
  const fixedRate = await fixedWindowResolutionRate(tx, params, mode);
  const speed = await timeToResolution(tx, params, mode);
  const age = await unresolvedAge(tx, params, mode);
  const claims = await claimsAwaitingResponse(tx, params, mode);
  const disputed = await disputedResolutions(tx, params, mode);
  const reopening = await reopeningRate(tx, params, mode);
  const confirmed = await standingConfirmed(tx, params, mode);
  const contributors = await uniqueContributors(tx, params, mode);
  const evidence = await evidenceVolumes(tx, params, mode);
  const population = await estimatedPopulation(tx, params, mode);
  const coverage = await dataCoverage(tx, params, mode);

  const readings: readonly MetricReading[] = [
    backlog,
    reading("M02", mode, known(groups.reduce((total, group) => total + group.value, 0)), 0),
    cohort,
    standingRate,
    fixedRate,
    reading(
      "M06",
      mode,
      speed.firstConfirmationHoursMedian === null
        ? unknown("empty_denominator")
        : known(speed.firstConfirmationHoursMedian),
      speed.stillWaitingCount,
    ),
    age.reading,
    claims,
    disputed,
    reopening,
    confirmed,
    reading("M12", mode, known(contributors.distinctInScope), contributors.notCountedRows),
    reading("M13", mode, known(evidence.activeLinks), 0),
    // A district-wide population total is deliberately absent: the boundaries
    // in scope nest inside one another, and V037 M14 may only be combined
    // across boundaries proven not to overlap. The per-boundary rows are in
    // `population`; the headline is the count of boundaries with no figure.
    reading(
      "M14",
      mode,
      unknown(
        population.some((row) => row.missingIndicator !== null)
          ? "source_reported_unknown"
          : "no_population_source",
      ),
      population.filter((row) => row.population.value === null).length,
    ),
    reading("M15", mode, coverage.incomplete, coverage.counts.statusUnknown),
  ];

  const missing = METRIC_IDS.filter((id) => !readings.some((item) => item.id === id));
  if (missing.length > 0) {
    throw new AnalyticsError(`report is missing metrics: ${missing.join(", ")}`);
  }

  return {
    params,
    mode,
    readings,
    backlogByDimension: groups,
    speed,
    maxUnresolvedAgeHours: age.maxHours,
    contributors,
    evidence,
    population,
    coverage: coverage.counts,
  };
};
