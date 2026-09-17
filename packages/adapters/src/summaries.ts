/**
 * Replayable regional and category summaries (roadmap V038).
 *
 * V037 defined what the numbers mean. This projects the authoritative records
 * into tables a dashboard can read without walking the whole ledger, in a way
 * that can be rebuilt from scratch and checked against itself.
 *
 * The design turns on one decision: **a projection stores state, not deltas.**
 * Projecting an issue recomputes its whole row from `canonical_issue`,
 * `issue_alias` and `issue_participation` and overwrites it. Nothing here ever
 * adds one to a counter. Three of V038's requirements fall out of that rather
 * than each being defended separately:
 *
 *  - **Retries cannot increase counts.** Replaying an event writes the same
 *    row. There is no path on which applying twice differs from applying once,
 *    so the guarantee does not rest on `summary_applied_event` being perfect —
 *    that table exists to avoid wasted work and to make `events_applied`
 *    meaningful, not to keep the totals correct.
 *  - **Separations need no compensating write.** A merge reversal closes the
 *    alias edge; the next recompute sees an issue that is its own root again
 *    and says so. Nothing has to remember to undo an increment applied weeks
 *    earlier.
 *  - **Corrected jurisdiction attribution moves rather than duplicates.** An
 *    issue's row names one cell. Change the attribution and the row moves, and
 *    both the old and the new cell are recomputed in the same pass.
 *
 * Two deliberate omissions. No clock is read here — `asOf` is supplied, so the
 * tests and the worker drive the same code path. And no historical horizon is
 * projected: a summary describes the present and records when it was built.
 * Asking what the district looked like in March is V037's question, and
 * answering it from a table that only ever holds current state would be an
 * invention.
 */

import { randomUUID } from "node:crypto";

import {
  assessFreshness,
  affectedIssueIds,
  cellKey,
  diffFacts,
  eventTouchesSummary,
  summaryStateOf,
  type FactDifference,
  type FactSnapshot,
  type FreshnessVerdict,
  type ProjectionEvent,
  type SummaryState,
} from "@vision/domain";

import type { Queryable } from "./outbox.ts";

export class SummaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SummaryError";
  }
}

/** The one projection this task builds: jurisdiction by category. */
export const DISTRICT_CATEGORY_SUMMARY = "district_category";

/**
 * How stale a summary may be before a reader is told it is behind.
 *
 * Deliberately short. An unnecessary "this is lagging" banner costs somebody a
 * moment; a missing one costs somebody quoting a number that is wrong with
 * nothing on the page disagreeing.
 */
export const DEFAULT_FRESHNESS_TOLERANCE_SECONDS = 120;

/** Separates the two halves of a cell key. Neither half can contain it. */
const CELL_KEY_SEPARATOR = "|";

const keyOf = (jurisdictionKey: string, category: string): string =>
  `${jurisdictionKey}${CELL_KEY_SEPARATOR}${category}`;

// ---------------------------------------------------------------------------
// Reading the authoritative state
// ---------------------------------------------------------------------------

/**
 * One projected row per canonical issue, computed but not yet stored.
 *
 * Bindings: `$1` issue ids or null for every issue, `$2` as-of.
 *
 * The alias walk covers **every** issue rather than only the scoped ones, even
 * when a single issue is being refreshed. Folding participation into a root
 * requires knowing every child of that root, and a child can easily be outside
 * the set an event named. Scoping the walk would make an incremental refresh
 * cheaper and occasionally wrong, which is the worse trade at any scale this
 * system will see.
 *
 * The walk carries its own path so a cycle is detected rather than looped
 * over, and stops at 16 hops. An issue whose root cannot be established keeps
 * itself as its root and is projected as `unknown` — which is where this
 * differs from V037 on purpose. A metric excludes what it cannot resolve,
 * because an excluded row cannot corrupt a rate. A projection holds a row for
 * every issue, so the honest representation is a visible `unknown` rather than
 * a gap in a table whose totals are read as complete.
 */
export const FACT_SELECT_SQL = `with recursive
  active_alias as (
    select source_issue_id, target_issue_id
      from issue_alias
     where valid_from <= $2::timestamptz
       and (valid_to is null or valid_to > $2::timestamptz)
  ),
  walk as (
    select c.issue_id as original_id, c.issue_id as current_id, 0 as hops,
           array[c.issue_id] as path, false as cycle
      from canonical_issue c
    union all
    select w.original_id, a.target_issue_id, w.hops + 1,
           w.path || a.target_issue_id, a.target_issue_id = any(w.path)
      from walk w
      join active_alias a on a.source_issue_id = w.current_id
     where w.cycle = false and w.hops < 16
  ),
  walked as (
    select distinct on (original_id) original_id, current_id as reached_id, cycle
      from walk
     order by original_id, hops desc
  ),
  resolved as (
    select w.original_id,
           case
             when w.cycle then null
             when exists (select 1 from active_alias a where a.source_issue_id = w.reached_id)
               then null
             else w.reached_id
           end as root_id
      from walked w
  ),
  folded_participants as (
    select r.root_id, count(distinct p.participant_id)::int as n
      from resolved r
      join issue_participation p
        on p.canonical_issue_id = r.original_id and p.counted
     where r.root_id is not null
     group by r.root_id
  ),
  folded_links as (
    select r.root_id, count(*)::int as n
      from resolved r
      join issue_evidence_link l on l.canonical_issue_id = r.original_id
     where r.root_id is not null
       and l.effective_from <= $2::timestamptz
       and (l.effective_to is null or l.effective_to > $2::timestamptz)
     group by r.root_id
  )
select
  c.issue_id,
  coalesce(rv.root_id, c.issue_id) as root_issue_id,
  (rv.root_id is null) as unresolvable,
  c.current_status,
  c.jurisdiction_id,
  j.directory_version as boundary_version,
  c.category,
  case when rv.root_id = c.issue_id then coalesce(fp.n, 0) else 0 end as counted_participants,
  case when rv.root_id = c.issue_id then coalesce(fl.n, 0) else 0 end as active_evidence_links,
  c.opened_at
from canonical_issue c
left join resolved rv on rv.original_id = c.issue_id
left join jurisdiction j on j.jurisdiction_id = c.jurisdiction_id
left join folded_participants fp on fp.root_id = c.issue_id
left join folded_links fl on fl.root_id = c.issue_id
where $1::uuid[] is null or c.issue_id = any($1::uuid[])
order by c.issue_id`;

export type ProjectedFact = {
  readonly issueId: string;
  readonly rootIssueId: string;
  readonly retiredByMerge: boolean;
  readonly jurisdictionKey: string;
  readonly boundaryVersion: string | null;
  readonly category: string;
  readonly state: SummaryState;
  readonly countedParticipants: number;
  readonly activeEvidenceLinks: number;
  readonly openedAt: string;
};

/** Computes facts from authoritative state. Writes nothing. */
export const readFacts = async (
  tx: Queryable,
  options: { readonly issueIds?: readonly string[] | undefined; readonly asOf: Date },
): Promise<readonly ProjectedFact[]> => {
  const ids = options.issueIds === undefined ? null : [...options.issueIds];
  const { rows } = await tx.query(FACT_SELECT_SQL, [ids, options.asOf.toISOString()]);
  return rows.map((row) => {
    const issueId = String(row["issue_id"]);
    const rootIssueId = String(row["root_issue_id"]);
    const unresolvable = row["unresolvable"] === true;
    return {
      issueId,
      rootIssueId,
      retiredByMerge: rootIssueId !== issueId,
      jurisdictionKey: cellKey(
        row["jurisdiction_id"] === null || row["jurisdiction_id"] === undefined
          ? null
          : String(row["jurisdiction_id"]),
      ),
      boundaryVersion:
        row["boundary_version"] === null || row["boundary_version"] === undefined
          ? null
          : String(row["boundary_version"]),
      category: String(row["category"]),
      // An unresolvable root is the one case the stored status cannot be
      // trusted to describe: this system does not know whether the issue is
      // its own report or a duplicate of one that is already counted.
      state: unresolvable ? "unknown" : summaryStateOf(String(row["current_status"])),
      countedParticipants: Number(row["counted_participants"] ?? 0),
      activeEvidenceLinks: Number(row["active_evidence_links"] ?? 0),
      openedAt: new Date(String(row["opened_at"])).toISOString(),
    };
  });
};

export const snapshotOf = (fact: ProjectedFact): FactSnapshot => ({
  issueId: fact.issueId,
  rootIssueId: fact.rootIssueId,
  retiredByMerge: fact.retiredByMerge,
  jurisdictionKey: fact.jurisdictionKey,
  category: fact.category,
  state: fact.state,
  countedParticipants: fact.countedParticipants,
});

const storedSnapshots = async (
  tx: Queryable,
  summaryName: string,
): Promise<readonly FactSnapshot[]> => {
  const { rows } = await tx.query(
    `select issue_id, root_issue_id, retired_by_merge, jurisdiction_key, category,
            state, counted_participants
       from summary_issue_fact where summary_name = $1 order by issue_id`,
    [summaryName],
  );
  return rows.map((row) => ({
    issueId: String(row["issue_id"]),
    rootIssueId: String(row["root_issue_id"]),
    retiredByMerge: row["retired_by_merge"] === true,
    jurisdictionKey: String(row["jurisdiction_key"]),
    category: String(row["category"]),
    state: String(row["state"]) as SummaryState,
    countedParticipants: Number(row["counted_participants"] ?? 0),
  }));
};

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Upserts projected facts.
 *
 * One statement for the whole batch, and an upsert rather than a delete and
 * insert: the row is the unit of truth, so writing it twice is writing it
 * once. This is the exact point at which "retries cannot increase counts"
 * stops being a claim about discipline and becomes a property of the write.
 */
const writeFacts = async (
  tx: Queryable,
  summaryName: string,
  facts: readonly ProjectedFact[],
  options: { readonly sourceEventId: string | null; readonly projectedAt: Date },
): Promise<number> => {
  if (facts.length === 0) return 0;
  const { rowCount } = await tx.query(
    `insert into summary_issue_fact
       (summary_name, issue_id, root_issue_id, retired_by_merge, jurisdiction_key,
        boundary_version, category, state, counted_participants, active_evidence_links,
        opened_at, source_event_id, projected_at)
     select $1, u.issue_id, u.root_issue_id, u.retired, u.jurisdiction_key,
            u.boundary_version, u.category, u.state, u.participants, u.links,
            u.opened_at, $12, $13::timestamptz
       from unnest($2::uuid[], $3::uuid[], $4::boolean[], $5::text[], $6::text[],
                   $7::text[], $8::text[], $9::int[], $10::int[], $11::timestamptz[])
            as u(issue_id, root_issue_id, retired, jurisdiction_key, boundary_version,
                 category, state, participants, links, opened_at)
     on conflict (summary_name, issue_id) do update set
       root_issue_id = excluded.root_issue_id,
       retired_by_merge = excluded.retired_by_merge,
       jurisdiction_key = excluded.jurisdiction_key,
       boundary_version = excluded.boundary_version,
       category = excluded.category,
       state = excluded.state,
       counted_participants = excluded.counted_participants,
       active_evidence_links = excluded.active_evidence_links,
       opened_at = excluded.opened_at,
       source_event_id = excluded.source_event_id,
       projected_at = excluded.projected_at`,
    [
      summaryName,
      facts.map((fact) => fact.issueId),
      facts.map((fact) => fact.rootIssueId),
      facts.map((fact) => fact.retiredByMerge),
      facts.map((fact) => fact.jurisdictionKey),
      facts.map((fact) => fact.boundaryVersion),
      facts.map((fact) => fact.category),
      facts.map((fact) => fact.state),
      facts.map((fact) => fact.countedParticipants),
      facts.map((fact) => fact.activeEvidenceLinks),
      facts.map((fact) => fact.openedAt),
      options.sourceEventId,
      options.projectedAt.toISOString(),
    ],
  );
  return rowCount ?? 0;
};

/**
 * Recomputes summary cells from the stored facts.
 *
 * `cellKeys` of `null` rebuilds every cell; a list rebuilds only those. Both
 * paths delete the targeted cells first and reinsert only the ones that still
 * hold a live issue, which is how a cell that emptied disappears instead of
 * lingering with the counts it had when somebody last reported there.
 *
 * `counted_participants` is recomputed as a distinct count across each cell's
 * whole alias closure rather than summed from the fact rows. Summing would
 * count anybody who reported two separate issues in the same ward twice.
 */
const refreshCells = async (
  tx: Queryable,
  summaryName: string,
  cellKeys: readonly string[] | null,
  refreshedAt: Date,
): Promise<number> => {
  const keys = cellKeys === null ? null : [...new Set(cellKeys)];
  await tx.query(
    `delete from summary_cell
      where summary_name = $1
        and ($2::text[] is null
             or jurisdiction_key || '${CELL_KEY_SEPARATOR}' || category = any($2::text[]))`,
    [summaryName, keys],
  );
  const { rowCount } = await tx.query(
    `with live as (
       select * from summary_issue_fact
        where summary_name = $1
          and retired_by_merge = false
          and ($2::text[] is null
               or jurisdiction_key || '${CELL_KEY_SEPARATOR}' || category = any($2::text[]))
     ),
     cell_participants as (
       select l.jurisdiction_key, l.category, count(distinct p.participant_id)::int as n
         from live l
         join summary_issue_fact child
           on child.summary_name = $1 and child.root_issue_id = l.issue_id
         join issue_participation p
           on p.canonical_issue_id = child.issue_id and p.counted
        group by l.jurisdiction_key, l.category
     )
     insert into summary_cell
       (summary_name, jurisdiction_key, category, boundary_version, issue_count,
        open_count, claimed_count, disputed_count, confirmed_count, reopened_count,
        unknown_state_count, counted_participants, active_evidence_links, refreshed_at)
     select $1, l.jurisdiction_key, l.category, max(l.boundary_version),
            count(*)::int,
            count(*) filter (where l.state = 'open')::int,
            count(*) filter (where l.state = 'claimed')::int,
            count(*) filter (where l.state = 'disputed')::int,
            count(*) filter (where l.state = 'confirmed')::int,
            count(*) filter (where l.state = 'reopened')::int,
            count(*) filter (where l.state = 'unknown')::int,
            coalesce(max(cp.n), 0),
            coalesce(sum(l.active_evidence_links), 0)::int,
            $3::timestamptz
       from live l
       left join cell_participants cp
         on cp.jurisdiction_key = l.jurisdiction_key and cp.category = l.category
      group by l.jurisdiction_key, l.category`,
    [summaryName, keys, refreshedAt.toISOString()],
  );
  return rowCount ?? 0;
};

// ---------------------------------------------------------------------------
// Rebuild
// ---------------------------------------------------------------------------

export type RebuildResult = {
  readonly issuesProjected: number;
  readonly cellsWritten: number;
  readonly eventsMarked: number;
};

/**
 * Rebuilds the whole projection from authoritative state.
 *
 * Driven by the records, not by the event stream, which is what makes it an
 * independent answer worth comparing the incremental path against. It also
 * marks every existing issue event as applied and advances the watermark to
 * the newest one, so an incremental pass afterwards has nothing to redo — a
 * rebuild that left the cursor behind would immediately reproject everything
 * and hide whether the incremental path can stand on its own.
 */
export const rebuildSummaries = async (
  tx: Queryable,
  options: { readonly summaryName?: string; readonly asOf: Date },
): Promise<RebuildResult> => {
  const summaryName = options.summaryName ?? DISTRICT_CATEGORY_SUMMARY;
  const facts = await readFacts(tx, { asOf: options.asOf });

  await tx.query("begin");
  try {
    await tx.query("delete from summary_issue_fact where summary_name = $1", [summaryName]);
    await writeFacts(tx, summaryName, facts, {
      sourceEventId: null,
      projectedAt: options.asOf,
    });
    const cellsWritten = await refreshCells(tx, summaryName, null, options.asOf);

    const marked = await tx.query(
      `insert into summary_applied_event (summary_name, event_id, applied_at)
       select $1, e.event_id, $2::timestamptz
         from status_event e
        where e.aggregate_type = 'canonical_issue'
       on conflict (summary_name, event_id) do nothing`,
      [summaryName, options.asOf.toISOString()],
    );

    await tx.query(
      `insert into summary_watermark
         (summary_name, last_recorded_at, last_event_id, last_refreshed_at,
          last_rebuild_at, events_applied, issues_projected)
       select $1, latest.recorded_at, latest.event_id, $2::timestamptz, $2::timestamptz,
              (select count(*) from summary_applied_event where summary_name = $1),
              $3::bigint
         from (select recorded_at, event_id from status_event
                where aggregate_type = 'canonical_issue'
                order by recorded_at desc, event_id desc limit 1) latest
        union all
       select $1, null, null, $2::timestamptz, $2::timestamptz,
              (select count(*) from summary_applied_event where summary_name = $1), $3::bigint
        where not exists (select 1 from status_event where aggregate_type = 'canonical_issue')
       on conflict (summary_name) do update set
         last_recorded_at = excluded.last_recorded_at,
         last_event_id = excluded.last_event_id,
         last_refreshed_at = excluded.last_refreshed_at,
         last_rebuild_at = excluded.last_rebuild_at,
         events_applied = excluded.events_applied,
         issues_projected = excluded.issues_projected`,
      [summaryName, options.asOf.toISOString(), facts.length],
    );

    await tx.query("commit");
    return {
      issuesProjected: facts.length,
      cellsWritten,
      eventsMarked: marked.rowCount ?? 0,
    };
  } catch (error) {
    await tx.query("rollback").catch(() => undefined);
    throw error;
  }
};

// ---------------------------------------------------------------------------
// Incremental
// ---------------------------------------------------------------------------

export type ApplyResult = {
  readonly eventsRead: number;
  readonly eventsApplied: number;
  /** Issues with no row yet, found by absence rather than by an event. */
  readonly issuesDiscovered: number;
  readonly issuesProjected: number;
  readonly cellsRefreshed: number;
};

/**
 * Applies newly recorded issue events to the projection.
 *
 * Ordered and bounded by **`recorded_at`, not `occurred_at`**. A backdated
 * correction describes an earlier moment but arrives later; a cursor that
 * advanced on event time would leave it permanently behind the watermark and
 * it would never be projected at all. Ingestion order is the only order in
 * which "everything since last time" is a complete answer.
 *
 * The affected set is widened three times before anything is recomputed: to
 * the issues a merge event names in its payload; to every issue whose stored
 * row currently points at one of them as its root, without which a separation
 * would leave the freed issue still claiming it had been merged away; and to
 * every issue that has no row at all.
 *
 * That last one is not a nicety. No production path appends a `created` event
 * when an issue is opened — matching finalisation writes the row and records
 * its decision elsewhere — so an event-driven projection would never learn
 * that a new report existed, and the first time a district summary heard about
 * it would be the next full rebuild. The worker's own reconciliation pass
 * found exactly that, two issues at a time, before this sweep existed. A
 * projection's job is to be complete, and making it depend on every upstream
 * writer remembering to emit an event is a dependency it does not need: an
 * anti-join against its own table is cheap and cannot be forgotten.
 */
export const applySummaryEvents = async (
  tx: Queryable,
  options: {
    readonly summaryName?: string;
    readonly asOf: Date;
    readonly limit?: number;
  },
): Promise<ApplyResult> => {
  const summaryName = options.summaryName ?? DISTRICT_CATEGORY_SUMMARY;
  const limit = options.limit ?? 500;
  if (limit <= 0) throw new SummaryError("limit must be positive");

  const { rows: eventRows } = await tx.query(
    `select e.event_id, e.aggregate_type, e.aggregate_id, e.event_type, e.payload,
            e.recorded_at
       from status_event e
       left join summary_applied_event a
         on a.summary_name = $1 and a.event_id = e.event_id
      where e.aggregate_type = 'canonical_issue'
        and a.event_id is null
      order by e.recorded_at asc, e.event_id asc
      limit $2`,
    [summaryName, limit],
  );

  const events: readonly ProjectionEvent[] = eventRows.map((row) => ({
    eventId: String(row["event_id"]),
    aggregateType: String(row["aggregate_type"]),
    aggregateId: String(row["aggregate_id"]),
    eventType: String(row["event_type"]),
    payload: (row["payload"] ?? {}) as Record<string, unknown>,
  }));

  const named = new Set<string>();
  for (const event of events) {
    if (!eventTouchesSummary(event)) continue;
    for (const issueId of affectedIssueIds(event)) named.add(issueId);
  }

  const { rows: unprojectedRows } = await tx.query(
    `select c.issue_id
       from canonical_issue c
       left join summary_issue_fact f
         on f.summary_name = $1 and f.issue_id = c.issue_id
      where f.issue_id is null
      order by c.opened_at asc
      limit $2`,
    [summaryName, limit],
  );
  const discovered = unprojectedRows.map((row) => String(row["issue_id"]));
  for (const issueId of discovered) named.add(issueId);

  if (named.size === 0) {
    await tx.query(
      `update summary_watermark set last_refreshed_at = $2::timestamptz where summary_name = $1`,
      [summaryName, options.asOf.toISOString()],
    );
    return {
      eventsRead: events.length,
      eventsApplied: 0,
      issuesDiscovered: 0,
      issuesProjected: 0,
      cellsRefreshed: 0,
    };
  }

  await tx.query("begin");
  try {
    // Widen to anything currently attached to one of these as its root, so a
    // separation frees the child rather than leaving it claimed.
    const { rows: relatedRows } = await tx.query(
      `select distinct issue_id from summary_issue_fact
        where summary_name = $1
          and (issue_id = any($2::uuid[]) or root_issue_id = any($2::uuid[]))`,
      [summaryName, [...named]],
    );
    const affected = new Set<string>(named);
    for (const row of relatedRows) affected.add(String(row["issue_id"]));

    const { rows: beforeRows } = await tx.query(
      `select distinct jurisdiction_key, category from summary_issue_fact
        where summary_name = $1 and issue_id = any($2::uuid[])`,
      [summaryName, [...affected]],
    );
    const touchedCells = new Set<string>(
      beforeRows.map((row) => keyOf(String(row["jurisdiction_key"]), String(row["category"]))),
    );

    const facts = await readFacts(tx, { issueIds: [...affected], asOf: options.asOf });
    const lastEvent = events[events.length - 1];
    await writeFacts(tx, summaryName, facts, {
      sourceEventId: lastEvent?.eventId ?? null,
      projectedAt: options.asOf,
    });
    for (const fact of facts) touchedCells.add(keyOf(fact.jurisdictionKey, fact.category));

    // Also refresh the cells of every root these facts fold into: a merge
    // moves participation into a root that may sit in a different cell and was
    // never named by the event.
    const { rows: rootRows } = await tx.query(
      `select distinct jurisdiction_key, category from summary_issue_fact
        where summary_name = $1 and issue_id = any($2::uuid[])`,
      [summaryName, facts.map((fact) => fact.rootIssueId)],
    );
    for (const row of rootRows) {
      touchedCells.add(keyOf(String(row["jurisdiction_key"]), String(row["category"])));
    }

    const cellsRefreshed = await refreshCells(tx, summaryName, [...touchedCells], options.asOf);

    const applied = await tx.query(
      `insert into summary_applied_event (summary_name, event_id, applied_at)
       select $1, unnest($2::uuid[]), $3::timestamptz
       on conflict (summary_name, event_id) do nothing`,
      [summaryName, events.map((event) => event.eventId), options.asOf.toISOString()],
    );

    const lastRow = eventRows[eventRows.length - 1];
    await tx.query(
      `insert into summary_watermark
         (summary_name, last_recorded_at, last_event_id, last_refreshed_at,
          events_applied, issues_projected)
       values ($1, $2, $3, $4::timestamptz, $5::bigint, $6::bigint)
       on conflict (summary_name) do update set
         -- Kept when this pass carried no events: a pass that only discovered
         -- unprojected issues has not read past anything, and nulling the
         -- cursor would erase which event the summary last saw.
         last_recorded_at =
           coalesce(excluded.last_recorded_at, summary_watermark.last_recorded_at),
         last_event_id = coalesce(excluded.last_event_id, summary_watermark.last_event_id),
         last_refreshed_at = excluded.last_refreshed_at,
         events_applied = summary_watermark.events_applied + excluded.events_applied,
         issues_projected = summary_watermark.issues_projected + excluded.issues_projected`,
      [
        summaryName,
        lastRow?.["recorded_at"] ?? null,
        lastRow?.["event_id"] ?? null,
        options.asOf.toISOString(),
        applied.rowCount ?? 0,
        facts.length,
      ],
    );

    await tx.query("commit");
    return {
      eventsRead: events.length,
      eventsApplied: applied.rowCount ?? 0,
      issuesDiscovered: discovered.length,
      issuesProjected: facts.length,
      cellsRefreshed,
    };
  } catch (error) {
    await tx.query("rollback").catch(() => undefined);
    throw error;
  }
};

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

export type CellDifference = {
  readonly cell: string;
  readonly field: string;
  readonly stored: string;
  readonly rebuilt: string;
};

export type ReconciliationResult = {
  readonly runId: string;
  readonly reconciled: boolean;
  readonly checkedFacts: number;
  readonly mismatchedFacts: number;
  readonly checkedCells: number;
  readonly mismatchedCells: number;
  readonly factDifferences: readonly FactDifference[];
  readonly cellDifferences: readonly CellDifference[];
};

type CellRow = {
  readonly key: string;
  readonly counts: Readonly<Record<string, number>>;
};

const storedCells = async (tx: Queryable, summaryName: string): Promise<readonly CellRow[]> => {
  const { rows } = await tx.query(
    `select jurisdiction_key, category, issue_count, open_count, claimed_count,
            disputed_count, confirmed_count, reopened_count, unknown_state_count,
            counted_participants, active_evidence_links
       from summary_cell where summary_name = $1
      order by jurisdiction_key, category`,
    [summaryName],
  );
  return rows.map((row) => ({
    key: keyOf(String(row["jurisdiction_key"]), String(row["category"])),
    counts: {
      issue_count: Number(row["issue_count"]),
      open_count: Number(row["open_count"]),
      claimed_count: Number(row["claimed_count"]),
      disputed_count: Number(row["disputed_count"]),
      confirmed_count: Number(row["confirmed_count"]),
      reopened_count: Number(row["reopened_count"]),
      unknown_state_count: Number(row["unknown_state_count"]),
      counted_participants: Number(row["counted_participants"]),
      active_evidence_links: Number(row["active_evidence_links"]),
    },
  }));
};

const cellsFromFacts = (facts: readonly ProjectedFact[]): readonly CellRow[] => {
  const cells = new Map<string, Record<string, number>>();
  for (const fact of facts) {
    if (fact.retiredByMerge) continue;
    const key = keyOf(fact.jurisdictionKey, fact.category);
    const counts = cells.get(key) ?? {
      issue_count: 0,
      open_count: 0,
      claimed_count: 0,
      disputed_count: 0,
      confirmed_count: 0,
      reopened_count: 0,
      unknown_state_count: 0,
      active_evidence_links: 0,
    };
    counts["issue_count"] = (counts["issue_count"] ?? 0) + 1;
    const stateColumn = fact.state === "unknown" ? "unknown_state_count" : `${fact.state}_count`;
    counts[stateColumn] = (counts[stateColumn] ?? 0) + 1;
    counts["active_evidence_links"] =
      (counts["active_evidence_links"] ?? 0) + fact.activeEvidenceLinks;
    cells.set(key, counts);
  }
  return [...cells.entries()]
    .map(([key, counts]) => ({ key, counts }))
    .sort((a, b) => a.key.localeCompare(b.key));
};

/**
 * Compares the stored projection against a clean rebuild and records the run.
 *
 * Nothing is written to `summary_issue_fact` or `summary_cell`: the rebuild is
 * computed in memory and thrown away. A reconciliation that repaired what it
 * found would destroy the evidence of the bug it detected, and the run after
 * it would always pass.
 *
 * `counted_participants` is excluded from the cell comparison because its
 * stored value is a distinct count across the cell, which cannot be derived
 * from per-issue rows without re-reading participation — it is checked at the
 * fact grain instead, where the two paths do compute the same quantity.
 */
export const reconcileSummaries = async (
  tx: Queryable,
  options: { readonly summaryName?: string; readonly asOf: Date },
): Promise<ReconciliationResult> => {
  const summaryName = options.summaryName ?? DISTRICT_CATEGORY_SUMMARY;
  const rebuilt = await readFacts(tx, { asOf: options.asOf });
  const stored = await storedSnapshots(tx, summaryName);

  const factDifferences = diffFacts(stored, rebuilt.map(snapshotOf));

  const expectedCells = cellsFromFacts(rebuilt);
  const actualCells = await storedCells(tx, summaryName);
  const expectedByKey = new Map(expectedCells.map((cell) => [cell.key, cell.counts]));
  const cellDifferences: CellDifference[] = [];

  for (const cell of actualCells) {
    const expected = expectedByKey.get(cell.key);
    if (expected === undefined) {
      cellDifferences.push({
        cell: cell.key,
        field: "presence",
        stored: "present",
        rebuilt: "absent",
      });
      continue;
    }
    expectedByKey.delete(cell.key);
    for (const [field, value] of Object.entries(expected)) {
      const actual = cell.counts[field];
      if (actual !== value) {
        cellDifferences.push({
          cell: cell.key,
          field,
          stored: String(actual),
          rebuilt: String(value),
        });
      }
    }
  }
  for (const key of expectedByKey.keys()) {
    cellDifferences.push({ cell: key, field: "presence", stored: "absent", rebuilt: "present" });
  }

  const mismatchedFacts = new Set(factDifferences.map((difference) => difference.issueId)).size;
  const mismatchedCells = new Set(cellDifferences.map((difference) => difference.cell)).size;
  const runId = randomUUID();
  const reconciled = factDifferences.length === 0 && cellDifferences.length === 0;

  await tx.query(
    `insert into summary_reconciliation
       (run_id, summary_name, ran_at, checked_facts, mismatched_facts,
        checked_cells, mismatched_cells, differences, reconciled)
     values ($1,$2,$3::timestamptz,$4,$5,$6,$7,$8::jsonb,$9)`,
    [
      runId,
      summaryName,
      options.asOf.toISOString(),
      rebuilt.length,
      mismatchedFacts,
      expectedCells.length,
      mismatchedCells,
      // Bounded: a projection that has gone badly wrong would otherwise write
      // a row the size of the table and make the failure harder to read.
      JSON.stringify({
        facts: factDifferences.slice(0, 50),
        cells: cellDifferences.slice(0, 50),
        truncated: factDifferences.length > 50 || cellDifferences.length > 50,
      }),
      reconciled,
    ],
  );

  return {
    runId,
    reconciled,
    checkedFacts: rebuilt.length,
    mismatchedFacts,
    checkedCells: expectedCells.length,
    mismatchedCells,
    factDifferences,
    cellDifferences,
  };
};

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export type SummaryCell = {
  readonly jurisdictionKey: string;
  readonly category: string;
  readonly boundaryVersion: string | null;
  readonly issueCount: number;
  readonly open: number;
  readonly claimed: number;
  readonly disputed: number;
  readonly confirmed: number;
  readonly reopened: number;
  readonly unknownState: number;
  /** Distinct within this cell. Never sum across cells — `rollUpCells` refuses. */
  readonly countedParticipants: number;
  readonly activeEvidenceLinks: number;
  readonly refreshedAt: string;
};

export const readSummaryCells = async (
  tx: Queryable,
  options: { readonly summaryName?: string } = {},
): Promise<readonly SummaryCell[]> => {
  const summaryName = options.summaryName ?? DISTRICT_CATEGORY_SUMMARY;
  const { rows } = await tx.query(
    `select * from summary_cell where summary_name = $1
      order by jurisdiction_key, category`,
    [summaryName],
  );
  return rows.map((row) => ({
    jurisdictionKey: String(row["jurisdiction_key"]),
    category: String(row["category"]),
    boundaryVersion:
      row["boundary_version"] === null || row["boundary_version"] === undefined
        ? null
        : String(row["boundary_version"]),
    issueCount: Number(row["issue_count"]),
    open: Number(row["open_count"]),
    claimed: Number(row["claimed_count"]),
    disputed: Number(row["disputed_count"]),
    confirmed: Number(row["confirmed_count"]),
    reopened: Number(row["reopened_count"]),
    unknownState: Number(row["unknown_state_count"]),
    countedParticipants: Number(row["counted_participants"]),
    activeEvidenceLinks: Number(row["active_evidence_links"]),
    refreshedAt: new Date(String(row["refreshed_at"])).toISOString(),
  }));
};

export type SummaryStatus = {
  readonly summaryName: string;
  readonly freshness: FreshnessVerdict;
  readonly lastRebuildAt: string | null;
  readonly eventsApplied: number;
  readonly lastReconciliation: {
    readonly ranAt: string;
    readonly reconciled: boolean;
    readonly mismatches: number;
  } | null;
};

/**
 * Freshness and the last reconciliation verdict, together.
 *
 * Both, always. A projection that ran a second ago having skipped four hundred
 * events is not fresh, and one that reconciled cleanly last week has said
 * nothing about today — reporting either alone lets a reader draw the
 * comfortable conclusion.
 */
export const summaryStatus = async (
  tx: Queryable,
  options: {
    readonly summaryName?: string;
    readonly asOf: Date;
    readonly toleranceSeconds?: number;
  },
): Promise<SummaryStatus> => {
  const summaryName = options.summaryName ?? DISTRICT_CATEGORY_SUMMARY;
  const { rows } = await tx.query(
    `select w.last_refreshed_at, w.last_rebuild_at, w.events_applied,
            (select count(*) from status_event e
              left join summary_applied_event a
                on a.summary_name = $1 and a.event_id = e.event_id
              where e.aggregate_type = 'canonical_issue' and a.event_id is null) as pending,
            (select count(*) from canonical_issue c
              left join summary_issue_fact f
                on f.summary_name = $1 and f.issue_id = c.issue_id
              where f.issue_id is null) as unprojected
       from summary_watermark w where w.summary_name = $1`,
    [summaryName],
  );
  const row = rows[0];

  const { rows: reconciliationRows } = await tx.query(
    `select ran_at, reconciled, mismatched_facts, mismatched_cells
       from summary_reconciliation where summary_name = $1
      order by run_seq desc limit 1`,
    [summaryName],
  );
  const latest = reconciliationRows[0];

  const unbuilt = await (async (): Promise<{ pending: number; unprojected: number }> => {
    if (row !== undefined) {
      return {
        pending: Number(row["pending"] ?? 0),
        unprojected: Number(row["unprojected"] ?? 0),
      };
    }
    // No watermark row at all: nothing has been applied and nothing projected,
    // so everything is outstanding.
    const { rows: countRows } = await tx.query(
      `select (select count(*) from status_event where aggregate_type = 'canonical_issue') as pending,
              (select count(*) from canonical_issue) as unprojected`,
    );
    return {
      pending: Number(countRows[0]?.["pending"] ?? 0),
      unprojected: Number(countRows[0]?.["unprojected"] ?? 0),
    };
  })();

  return {
    summaryName,
    freshness: assessFreshness(
      {
        lastRefreshedAtMs:
          row?.["last_refreshed_at"] === null || row?.["last_refreshed_at"] === undefined
            ? null
            : new Date(String(row["last_refreshed_at"])).getTime(),
        lastRebuildAtMs:
          row?.["last_rebuild_at"] === null || row?.["last_rebuild_at"] === undefined
            ? null
            : new Date(String(row["last_rebuild_at"])).getTime(),
        pendingEvents: unbuilt.pending,
        unprojectedIssues: unbuilt.unprojected,
        asOfMs: options.asOf.getTime(),
      },
      options.toleranceSeconds ?? DEFAULT_FRESHNESS_TOLERANCE_SECONDS,
    ),
    lastRebuildAt:
      row?.["last_rebuild_at"] === null || row?.["last_rebuild_at"] === undefined
        ? null
        : new Date(String(row["last_rebuild_at"])).toISOString(),
    eventsApplied: Number(row?.["events_applied"] ?? 0),
    lastReconciliation:
      latest === undefined
        ? null
        : {
            ranAt: new Date(String(latest["ran_at"])).toISOString(),
            reconciled: latest["reconciled"] === true,
            mismatches:
              Number(latest["mismatched_facts"] ?? 0) + Number(latest["mismatched_cells"] ?? 0),
          },
  };
};
