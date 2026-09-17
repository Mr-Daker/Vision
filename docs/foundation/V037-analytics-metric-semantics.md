# V037 — Analytics populations, denominators, and time semantics

**Roadmap task:** V037 · **Prerequisites:** V003, V029, V035 · **Owner:** Data + Product

Fifteen metrics, each with a population, a denominator, a horizon, and a statement that can be replayed against the database by hand. The contracts live in `packages/domain/src/metric-semantics.ts`, the SQL in `packages/adapters/src/analytics-metrics.ts`, and the reference section at the foot of this document is generated from both — so a number cannot appear on a screen without a contract saying what it means, and a contract cannot sit here describing a number nothing computes.

This task defines and computes the metrics. It deliberately builds no summary tables and no dashboard: replayable projections are V038 and the district dashboard is V039, and both are specified against what is written here.

## 1. The four rules

**Missing stays missing.** An absent value is `null` and carries a reason from a closed list. Substituting `0` for "we do not know" is the most common way a civic dashboard invents good news: no reports from a ward reads as no problems there, when it far more often means nobody could file one. `M15` exists so a reader can tell those apart.

**A rate must name its population.** `MetricDenominator` is a discriminated field, so a percentage cannot be declared without saying what it is a percentage of, and a count has to say in words why it has none. A zero denominator yields `null` — never `0`, never a division error. Zero out of seven and zero out of zero are different facts and never render the same.

**Speed never travels alone.** An average computed only over resolved issues flatters any backlog, because the slowest cases are precisely the ones still open: excluding them makes a department look faster the more it neglects. `ResolutionSpeed` has no field a caller could read as an overall resolution time, it carries `stillWaitingCount`, and `speedStatement` is the only supported rendering — it states the unresolved count every time, including when that count is zero.

**Some numbers do not add up.** Distinct counts of people and externally sourced populations are not additive across areas. Two wards each reporting nine contributors are not eighteen contributors, and two overlapping boundaries cannot have their populations summed at all. `combineAcrossBoundaries` refuses, rather than returning a plausible wrong total. It also refuses to add values measured against two different boundary versions, because that total describes an area that never existed.

## 2. Two clocks

Every event predicate carries both bounds:

- **`occurred_at <= :as_of`** — what had happened in the world by that moment.
- **`recorded_at <= :knowledge_cutoff`** — what this system had been told by that moment.

They are different questions, and a backdated correction answers them differently: it belongs in the first from the day it describes, and in the second only from the day it arrived. Holding both means a figure published last month can be reproduced exactly as it was published, and separately re-asked with everything since taken into account. A late-recorded event can never leak backwards into a snapshot that predates its ingestion.

Two honest limits on this today. First, `appendIssueEvent` stamps `occurred_at` with `now()`, so no production path currently backdates an issue event — the machinery is built, bound and tested, but every event in the live database has the two clocks within milliseconds of each other. Offline capture (V020) is where they will diverge in practice. Second, `issue_alias` has no `recorded_at` column, so the knowledge cutoff does not bound merge topology; alias edges are bounded by `valid_from`/`valid_to` against `:as_of` only.

## 3. Status at a horizon, and what cannot be reconstructed

At a **live** horizon the stored `current_status` column is the answer, and it is complete. At a **past** horizon it is not — it is today's value, and reading it would let a state reached last week appear in a snapshot of the week before. Past horizons reconstruct status from `status_event`, mapping each status-bearing event type to the state it established. Where the ledger cannot establish a status, the answer is `UNKNOWN`: it is reported next to the value as `unknownRows` and it is never folded into a number.

`horizonMode` is that seam, stated as one function, and every reading records which side of it produced the figure.

**Reconstructible from the ledger:** resolution claims, confirmations, disputes, disputed work returned to the crew, reopenings, acknowledgments, planned work, merges and merge reversals.

**Not reconstructible:**

- **Category and jurisdiction.** Both are corrected in place on `canonical_issue` with no effective-dated history table, so at any past horizon both dimensions read `UNKNOWN` rather than borrowing today's value. `M02` at a past horizon therefore returns a single `UNKNOWN`/`UNKNOWN` group — visibly useless, which is the correct rendering of a dimension that was not recorded rather than a plausible one that was not true.
- **`routing_review` and `routed_internal`.** No production path writes either as a status event today; V033 records routing decisions in `routing_decision` without moving `current_status`, and only the demo seeds set those states directly. The mapping is in place for when that path appends events.
- **Estimated population.** There is no population source table. `M14` lists every boundary with an `UNKNOWN` population rather than returning an empty list, so uncovered areas are visible instead of looking like no areas at all. The import, with its source record, unit and vintage, is V040.

## 4. Alias resolution fails safely

Alias edges active at the horizon are followed to the canonical root. A cycle, or a chain longer than `MAX_ALIAS_HOPS` (16), resolves to nothing and drops out of every count rather than resolving to whichever issue the walk happened to stop on. An undercount that can be found is recoverable; a confident wrong root is not. Child participation and evidence fold into the resolved root, and a merge **unions** contributors — it never adds the two totals.

`uniqueContributors` returns both the distinct count and `sumOfPerRoot`, which is what a dashboard would print if it added the per-issue counts. Having both side by side is what makes the double-counting visible rather than merely asserted.

## 5. Fixed windows

`M04` is a status snapshot: the share of a cohort standing confirmed _right now_. It moves whenever anything in the cohort changes and is not comparable between cohorts of different ages.

`M05` is the comparable one. A cohort member enters the denominator only once its window has fully elapsed at the horizon — an issue opened yesterday cannot yet have failed a thirty-day window, and counting it as a failure is how a fixed-window rate drops every time reporting picks up. A reopening **inside** the window invalidates the resolution, because a repair that failed within the period it was measured against did not hold. A reopening **after** the window closes leaves the historical figure alone: that number was true of the period it describes, and silently restating closed history is its own kind of dishonesty.

## 6. Vocabulary

Checked by test against every metric title and measurement description, and deliberately not against the disclosures — a disclosure has to be free to say plainly that people agreed, because that is exactly what was recorded.

| Never                                | Instead                                      |
| ------------------------------------ | -------------------------------------------- |
| successfully closed                  | standing confirmed                           |
| verified repair, certified           | confirmed by participants                    |
| rejected                             | disputed                                     |
| number of people, residents affected | counted demo participants                    |
| affected population                  | estimated population from an external source |

<!-- BEGIN generated: metric reference. npm run docs:v037 -->

## Metric reference

Generated from `packages/domain/src/metric-semantics.ts` and
`packages/adapters/src/analytics-metrics.ts` by `npm run docs:v037`. Edit those files,
not this section: `analytics-doc-sync.test.ts` fails the build if the two disagree.

Every statement below is executed by appending it to the shared prelude and binding
`$1` as-of, `$2` knowledge cutoff, `$3` live-horizon flag, `$4` window start,
`$5` window end, `$6` fixed-window days. Nothing else is interpolated, so any of them
can be replayed against the database by hand.

### Shared prelude

```sql
with recursive
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
  )
```

### M01 — Current backlog

Canonical issues that are open at the horizon and have no standing confirmation.

| Field           | Contract                                                                                                                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit            | count                                                                                                                                                                                                                     |
| Numerator       | Distinct active canonical roots whose reconstructed status at the horizon is not resolution_confirmed.                                                                                                                    |
| Denominator     | None — A count of open work, not a share of anything.                                                                                                                                                                     |
| Cohort          | Every canonical root opened at or before the horizon.                                                                                                                                                                     |
| Horizon         | `:as_of`                                                                                                                                                                                                                  |
| Inclusions      | Open; claimed but unconfirmed; disputed; reopened                                                                                                                                                                         |
| Exclusions      | Standing confirmed issues; Issues retired by an active alias at the horizon                                                                                                                                               |
| Alias semantics | Alias edges active at the horizon are followed to the canonical root; a cycle or a chain longer than 16 hops resolves to nothing and is excluded from every count rather than guessed at. Child data folds into the root. |
| Corrections     | Status at a past horizon is reconstructed from status_event bounded by both occurred_at and the knowledge cutoff, so a later state never leaks backwards. Where the ledger cannot establish it, the dimension is UNKNOWN. |
| Missing data    | An issue whose status cannot be reconstructed is reported as UNKNOWN, not open.                                                                                                                                           |
| Aggregation     | Additive across disjoint areas of one boundary version.                                                                                                                                                                   |
| Disclosures     | None.                                                                                                                                                                                                                     |

```sql
select
  count(*) filter (where s.status is not null and s.status <> 'resolution_confirmed')::int as value,
  count(*) filter (where s.status is null)::int as unknown_rows
from issue_status s
```

### M02 — Backlog by category and jurisdiction

The current backlog split by category and jurisdiction.

| Field           | Contract                                                                                                                                                                                                                                     |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit            | count                                                                                                                                                                                                                                        |
| Numerator       | M01 grouped by the root's category and jurisdiction.                                                                                                                                                                                         |
| Denominator     | None — A count per group, not a share of anything.                                                                                                                                                                                           |
| Cohort          | Every canonical root opened at or before the horizon.                                                                                                                                                                                        |
| Horizon         | `:as_of`                                                                                                                                                                                                                                     |
| Inclusions      | Open; claimed but unconfirmed; disputed; reopened                                                                                                                                                                                            |
| Exclusions      | Standing confirmed issues; Issues retired by an active alias at the horizon                                                                                                                                                                  |
| Alias semantics | Alias edges active at the horizon are followed to the canonical root; a cycle or a chain longer than 16 hops resolves to nothing and is excluded from every count rather than guessed at. Child data folds into the root.                    |
| Corrections     | Category and jurisdiction are corrected in place on canonical_issue with no effective-dated history, so neither can be reconstructed for a past horizon. At a past horizon both dimensions read UNKNOWN rather than borrowing today's value. |
| Missing data    | A null jurisdiction is UNKNOWN and is never folded into another group.                                                                                                                                                                       |
| Aggregation     | Additive across disjoint areas of one boundary version.                                                                                                                                                                                      |
| Disclosures     | None.                                                                                                                                                                                                                                        |

```sql
select s.category, s.jurisdiction_id, j.directory_version as boundary_version,
       count(*) filter (where s.status is not null and s.status <> 'resolution_confirmed')::int as value,
       count(*) filter (where s.status is null)::int as unknown_rows
  from issue_status s
  left join jurisdiction j on j.jurisdiction_id = s.jurisdiction_id
 group by s.category, s.jurisdiction_id, j.directory_version
 order by s.category nulls last, s.jurisdiction_id nulls last
```

### M03 — Accepted issue cohort

Distinct canonical roots opened inside a window.

| Field           | Contract                                                                                                                                                                                                                                                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit            | count                                                                                                                                                                                                                                                                                                                                 |
| Numerator       | Distinct roots whose opened_at falls in [window_start, window_end).                                                                                                                                                                                                                                                                   |
| Denominator     | None — A cohort size, which is itself a denominator for M04.                                                                                                                                                                                                                                                                          |
| Cohort          | Roots opened in [window_start, window_end).                                                                                                                                                                                                                                                                                           |
| Horizon         | `[:window_start, :window_end)`, read at `:as_of`                                                                                                                                                                                                                                                                                      |
| Inclusions      | Every accepted issue in the window                                                                                                                                                                                                                                                                                                    |
| Exclusions      | Submissions that never became a canonical issue                                                                                                                                                                                                                                                                                       |
| Alias semantics | Alias edges active at the horizon are followed to the canonical root; a cycle or a chain longer than 16 hops resolves to nothing and is excluded from every count rather than guessed at. Child data folds into the root. Membership is fixed at the window end; a later merge does not retrospectively change who was in the cohort. |
| Corrections     | Status at a past horizon is reconstructed from status_event bounded by both occurred_at and the knowledge cutoff, so a later state never leaks backwards. Where the ledger cannot establish it, the dimension is UNKNOWN.                                                                                                             |
| Missing data    | Not applicable: opened_at is mandatory.                                                                                                                                                                                                                                                                                               |
| Aggregation     | Additive across disjoint areas of one boundary version.                                                                                                                                                                                                                                                                               |
| Disclosures     | None.                                                                                                                                                                                                                                                                                                                                 |

```sql
select count(*)::int as value, 0 as unknown_rows from cohort
```

### M04 — Standing resolution rate, status as of a date

The share of one opened cohort that is standing confirmed at the horizon. A status snapshot, not a speed.

| Field           | Contract                                                                                                                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit            | percent                                                                                                                                                                                                                   |
| Numerator       | Cohort roots whose reconstructed status at the horizon is resolution_confirmed.                                                                                                                                           |
| Denominator     | Every root in the opened cohort (M03).                                                                                                                                                                                    |
| Cohort          | Roots opened in [window_start, window_end).                                                                                                                                                                               |
| Horizon         | `[:window_start, :window_end)`, read at `:as_of`                                                                                                                                                                          |
| Inclusions      | Roots standing confirmed at the horizon                                                                                                                                                                                   |
| Exclusions      | Roots currently reopened, disputed, or claimed but unconfirmed                                                                                                                                                            |
| Alias semantics | Alias edges active at the horizon are followed to the canonical root; a cycle or a chain longer than 16 hops resolves to nothing and is excluded from every count rather than guessed at. Child data folds into the root. |
| Corrections     | A reopening at or before the horizon removes the root from the numerator, because the resolution no longer stands.                                                                                                        |
| Missing data    | An empty cohort yields UNKNOWN, never 0%.                                                                                                                                                                                 |
| Aggregation     | Additive across disjoint areas of one boundary version.                                                                                                                                                                   |
| Disclosures     | A confirmed repair means the people who reported it agreed the problem looks fixed. It is not an inspection and not an engineer's certification.                                                                          |

```sql
select
  count(*) filter (where c.status = 'resolution_confirmed')::int as numerator,
  count(*)::int as denominator,
  count(*) filter (where c.status is null)::int as unknown_rows
from cohort c
```

### M05 — Fixed-window resolution rate

The share of a cohort that reached a confirmation within the window and still stood at the window's end. Comparable between cohorts in a way M04 is not.

| Field           | Contract                                                                                                                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit            | percent                                                                                                                                                                                                                   |
| Numerator       | Cohort roots first confirmed at or before opened_at + window, with no reopening at or before that same instant.                                                                                                           |
| Denominator     | Cohort roots whose window has fully elapsed at the horizon. Younger roots are in neither the numerator nor the denominator.                                                                                               |
| Cohort          | Roots opened in [window_start, window_end) and observed for the full window.                                                                                                                                              |
| Horizon         | `[:window_start, :window_end)`, read at `:as_of`                                                                                                                                                                          |
| Inclusions      | Resolutions that still stood at the window's end                                                                                                                                                                          |
| Exclusions      | Roots not yet observed for the full window; Roots confirmed inside the window and reopened inside it                                                                                                                      |
| Alias semantics | Alias edges active at the horizon are followed to the canonical root; a cycle or a chain longer than 16 hops resolves to nothing and is excluded from every count rather than guessed at. Child data folds into the root. |
| Corrections     | A reopening after the window closes does not restate the historical figure; the resolution did stand for the period the number describes.                                                                                 |
| Missing data    | No sufficiently observed root yields UNKNOWN, never 0%.                                                                                                                                                                   |
| Aggregation     | Additive across disjoint areas of one boundary version.                                                                                                                                                                   |
| Disclosures     | A confirmed repair means the people who reported it agreed the problem looks fixed. It is not an inspection and not an engineer's certification.                                                                          |

```sql
select
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
        <= $1::timestamptz
```

### M06 — Time to resolution

Separated duration components, reported only alongside the count of issues that have no resolution time because they are still open.

| Field           | Contract                                                                                                                                            |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit            | hours                                                                                                                                               |
| Numerator       | Median elapsed hours for first confirmation, for the resolution that currently stands, and for the gap before a reopening.                          |
| Denominator     | The resolved part of the cohort, reported with the unresolved remainder so the coverage of every figure is visible.                                 |
| Cohort          | Roots opened in [window_start, window_end).                                                                                                         |
| Horizon         | `[:window_start, :window_end)`, read at `:as_of`                                                                                                    |
| Inclusions      | First-confirmation duration; Standing-resolution duration, less reopened gaps; Reopening-cycle duration; The count of roots with no resolution time |
| Exclusions      | Any single headline average that omits the unresolved remainder                                                                                     |
| Alias semantics | Durations are measured on the canonical root's own lifecycle events.                                                                                |
| Corrections     | Gaps are recomputed from status_event, so a late correction changes the figure.                                                                     |
| Missing data    | No resolved root yields UNKNOWN for every duration, never 0 hours.                                                                                  |
| Aggregation     | **Not additive.** Two areas cannot be added; recompute over the combined area.                                                                      |
| Disclosures     | A confirmed repair means the people who reported it agreed the problem looks fixed. It is not an inspection and not an engineer's certification.    |

```sql
, reopen_gap as (
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
  left join reopen_gap g on g.issue_id = c.issue_id
```

### M07 — Age of unresolved issues

Elapsed hours since opening for everything still in the backlog.

| Field           | Contract                                                                       |
| --------------- | ------------------------------------------------------------------------------ |
| Unit            | hours                                                                          |
| Numerator       | Median and maximum elapsed hours from opened_at to the horizon.                |
| Denominator     | The current backlog (M01).                                                     |
| Cohort          | Unresolved roots at the horizon.                                               |
| Horizon         | `:as_of`                                                                       |
| Inclusions      | Open; claimed but unconfirmed; disputed; reopened                              |
| Exclusions      | Standing confirmed issues                                                      |
| Alias semantics | Age is measured on the canonical root.                                         |
| Corrections     | None: opened_at is not corrected.                                              |
| Missing data    | An empty backlog yields UNKNOWN, never 0 hours.                                |
| Aggregation     | **Not additive.** Two areas cannot be added; recompute over the combined area. |
| Disclosures     | None.                                                                          |

```sql
select
  round(percentile_cont(0.5) within group (
    order by extract(epoch from ($1::timestamptz - s.opened_at)) / 3600.0)::numeric, 1) as median_hours,
  round(max(extract(epoch from ($1::timestamptz - s.opened_at)) / 3600.0)::numeric, 1) as max_hours,
  count(*)::int as denominator,
  count(*) filter (where s.status is null)::int as unknown_rows
from issue_status s
where s.status is not null and s.status <> 'resolution_confirmed'
```

### M08 — Claims awaiting a response

Repair claims recorded by staff that nobody has confirmed or disputed yet.

| Field           | Contract                                                                                                                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit            | count                                                                                                                                                                                                                     |
| Numerator       | Distinct roots whose reconstructed status at the horizon is resolution_claimed.                                                                                                                                           |
| Denominator     | None — A count of outstanding responses.                                                                                                                                                                                  |
| Cohort          | Backlog roots.                                                                                                                                                                                                            |
| Horizon         | `:as_of`                                                                                                                                                                                                                  |
| Inclusions      | Claims with no confirmation and no dispute                                                                                                                                                                                |
| Exclusions      | Claims already confirmed; Claims already disputed; Reopened issues                                                                                                                                                        |
| Alias semantics | Alias edges active at the horizon are followed to the canonical root; a cycle or a chain longer than 16 hops resolves to nothing and is excluded from every count rather than guessed at. Child data folds into the root. |
| Corrections     | Status at a past horizon is reconstructed from status_event bounded by both occurred_at and the knowledge cutoff, so a later state never leaks backwards. Where the ledger cannot establish it, the dimension is UNKNOWN. |
| Missing data    | Not applicable.                                                                                                                                                                                                           |
| Aggregation     | Additive across disjoint areas of one boundary version.                                                                                                                                                                   |
| Disclosures     | A claim is a department's account of its own work. It is not a resolution until somebody who reported the problem responds.                                                                                               |

```sql
select count(*) filter (where s.status = 'resolution_claimed')::int as value,
       count(*) filter (where s.status is null)::int as unknown_rows
  from issue_status s
```

### M09 — Disputed resolutions

Claims a participant has disputed and that nobody has since resolved.

| Field           | Contract                                                                                                                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit            | count                                                                                                                                                                                                                     |
| Numerator       | Distinct roots whose reconstructed status at the horizon is resolution_disputed.                                                                                                                                          |
| Denominator     | None — A count of open disagreements.                                                                                                                                                                                     |
| Cohort          | Backlog roots.                                                                                                                                                                                                            |
| Horizon         | `:as_of`                                                                                                                                                                                                                  |
| Inclusions      | Disputes still standing at the horizon                                                                                                                                                                                    |
| Exclusions      | Disputes a reviewer overruled, which become standing confirmed; Disputes returned to the crew, which become planned work                                                                                                  |
| Alias semantics | Alias edges active at the horizon are followed to the canonical root; a cycle or a chain longer than 16 hops resolves to nothing and is excluded from every count rather than guessed at. Child data folds into the root. |
| Corrections     | Status at a past horizon is reconstructed from status_event bounded by both occurred_at and the knowledge cutoff, so a later state never leaks backwards. Where the ledger cannot establish it, the dimension is UNKNOWN. |
| Missing data    | Not applicable.                                                                                                                                                                                                           |
| Aggregation     | Additive across disjoint areas of one boundary version.                                                                                                                                                                   |
| Disclosures     | None.                                                                                                                                                                                                                     |

```sql
select count(*) filter (where s.status = 'resolution_disputed')::int as value,
       count(*) filter (where s.status is null)::int as unknown_rows
  from issue_status s
```

### M10 — Reopening rate

The share of issues that reached a confirmation and were later reopened.

| Field           | Contract                                                                                                                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit            | percent                                                                                                                                                                                                                   |
| Numerator       | Roots with at least one issue_reopened event at or before the horizon, among those that had been confirmed.                                                                                                               |
| Denominator     | Roots that reached resolution_confirmed at least once at or before the horizon.                                                                                                                                           |
| Cohort          | Every root ever confirmed at or before the horizon.                                                                                                                                                                       |
| Horizon         | `:as_of`                                                                                                                                                                                                                  |
| Inclusions      | Roots reopened at least once                                                                                                                                                                                              |
| Exclusions      | Roots never confirmed, which could not be reopened                                                                                                                                                                        |
| Alias semantics | Alias edges active at the horizon are followed to the canonical root; a cycle or a chain longer than 16 hops resolves to nothing and is excluded from every count rather than guessed at. Child data folds into the root. |
| Corrections     | Reconstructed from the event ledger, so a late-recorded reopening changes it.                                                                                                                                             |
| Missing data    | No confirmed root yields UNKNOWN, never 0%.                                                                                                                                                                               |
| Aggregation     | Additive across disjoint areas of one boundary version.                                                                                                                                                                   |
| Disclosures     | A reopening is a sign the system worked, not that it failed: somebody was able to say a repair had not held.                                                                                                              |

```sql
select
  count(*) filter (where l.reopened_count > 0)::int as numerator,
  count(*)::int as denominator,
  0 as unknown_rows
from issue_status s
join lifecycle l on l.issue_id = s.issue_id
where l.first_confirmed_at is not null
```

### M11 — Standing confirmed resolutions

Issues whose confirmation stands at the horizon and that are not currently reopened.

| Field           | Contract                                                                                                                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit            | count                                                                                                                                                                                                                     |
| Numerator       | Distinct roots whose reconstructed status at the horizon is resolution_confirmed.                                                                                                                                         |
| Denominator     | None — A count; M04 is the rate built on it.                                                                                                                                                                              |
| Cohort          | Every canonical root opened at or before the horizon.                                                                                                                                                                     |
| Horizon         | `:as_of`                                                                                                                                                                                                                  |
| Inclusions      | Standing confirmations                                                                                                                                                                                                    |
| Exclusions      | Issues reopened at or before the horizon                                                                                                                                                                                  |
| Alias semantics | Alias edges active at the horizon are followed to the canonical root; a cycle or a chain longer than 16 hops resolves to nothing and is excluded from every count rather than guessed at. Child data folds into the root. |
| Corrections     | Status at a past horizon is reconstructed from status_event bounded by both occurred_at and the knowledge cutoff, so a later state never leaks backwards. Where the ledger cannot establish it, the dimension is UNKNOWN. |
| Missing data    | Not applicable.                                                                                                                                                                                                           |
| Aggregation     | Additive across disjoint areas of one boundary version.                                                                                                                                                                   |
| Disclosures     | A confirmed repair means the people who reported it agreed the problem looks fixed. It is not an inspection and not an engineer's certification.                                                                          |

```sql
select count(*) filter (where s.status = 'resolution_confirmed')::int as value,
       count(*) filter (where s.status is null)::int as unknown_rows
  from issue_status s
```

### M12 — Unique counted demo participants

Distinct participants whose participation counts, folded across merged issues.

| Field           | Contract                                                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Unit            | count                                                                                                                                 |
| Numerator       | Distinct participant_id with counted = true across the active alias closure of each root.                                             |
| Denominator     | None — A distinct count of subjects, not a share.                                                                                     |
| Cohort          | Participants attached to a canonical root at the horizon.                                                                             |
| Horizon         | `:as_of`                                                                                                                              |
| Inclusions      | Participation rows with counted = true and first evidence at or before the horizon                                                    |
| Exclusions      | Participation explicitly not counted, with its recorded reason                                                                        |
| Alias semantics | A merge unions contributors into the surviving root; it never adds the two totals.                                                    |
| Corrections     | Reconstructed from first_evidence_at.                                                                                                 |
| Missing data    | Not applicable.                                                                                                                       |
| Aggregation     | **Not additive.** Two areas cannot be added; recompute over the combined area.                                                        |
| Disclosures     | A count of counted demo participants. It does not mean nobody else is affected, and it is not evidence that the reports are accurate. |

```sql
select
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
    where p2.counted = false and p2.first_evidence_at <= $1::timestamptz)::int as not_counted_rows
```

### M13 — Evidence and submission volumes

How much evidence is attached, kept separate from how many people reported.

| Field           | Contract                                                                                                                                                                      |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit            | count                                                                                                                                                                         |
| Numerator       | Four separated counts: distinct submissions, links active at the horizon, links ever created before the horizon, and completion-evidence items attached to resolution claims. |
| Denominator     | None — Volumes, not shares. Never a proxy for concern.                                                                                                                        |
| Cohort          | Evidence belonging to a canonical root's alias closure.                                                                                                                       |
| Horizon         | `:as_of`                                                                                                                                                                      |
| Inclusions      | Active links for the active count; Every historical link for the historical count                                                                                             |
| Exclusions      | Superseded or corrected links, for the active count only                                                                                                                      |
| Alias semantics | Summed across the active alias closure.                                                                                                                                       |
| Corrections     | Reconstructed from effective_from and effective_to.                                                                                                                           |
| Missing data    | Not applicable.                                                                                                                                                               |
| Aggregation     | Additive across disjoint areas of one boundary version.                                                                                                                       |
| Disclosures     | Evidence volume measures how much was uploaded, not how many people are affected and not how serious anything is.                                                             |

```sql
select
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
    where rc.claimed_at <= $1::timestamptz and ri.privacy_state = 'active')::int as completion_evidence
```

### M14 — Estimated population served

Population for a jurisdiction, taken only from a named external source.

| Field           | Contract                                                                                                                                                                                                                                                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unit            | population                                                                                                                                                                                                                                                                                                                                       |
| Numerator       | The value the loaded context source published for that boundary, carried with its unit, its vintage and its licence. Nothing is converted between units.                                                                                                                                                                                         |
| Denominator     | None — An externally sourced size, not a computed share.                                                                                                                                                                                                                                                                                         |
| Cohort          | Jurisdiction boundaries.                                                                                                                                                                                                                                                                                                                         |
| Horizon         | `:as_of`                                                                                                                                                                                                                                                                                                                                         |
| Inclusions      | Values carrying a source, a unit, and a vintage                                                                                                                                                                                                                                                                                                  |
| Exclusions      | Anything derived from report volume or contributor counts                                                                                                                                                                                                                                                                                        |
| Alias semantics | Not applicable.                                                                                                                                                                                                                                                                                                                                  |
| Corrections     | Managed by the V040 context import, which replaces a dataset's observations wholesale and records every row it refused.                                                                                                                                                                                                                          |
| Missing data    | A boundary with no loaded observation is UNKNOWN; a boundary whose source recorded a missing-data indicator is UNKNOWN for a different, reported reason. Neither ever falls back to 0, and report volume is never substituted.                                                                                                                   |
| Aggregation     | **Only across boundaries proven not to overlap.** Unproven disjointness yields UNKNOWN.                                                                                                                                                                                                                                                          |
| Disclosures     | Population comes from a named source with its own unit, vintage and licence, and is shown with all three. Report volume is never used to estimate how many people a problem affects. The figures loaded in this demonstration are team-created synthetic data: they describe no real place and must not be quoted as a statistic about anywhere. |

```sql
select j.jurisdiction_id, j.directory_version as boundary_version,
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
 order by j.internal_code
```

### M15 — Data coverage

The share of records missing a dimension, so a reader can tell a real zero from an absence of data.

| Field           | Contract                                                                                                    |
| --------------- | ----------------------------------------------------------------------------------------------------------- |
| Unit            | percent                                                                                                     |
| Numerator       | Records whose dimension is null or UNKNOWN.                                                                 |
| Denominator     | Every record in scope at the horizon.                                                                       |
| Cohort          | Canonical roots at the horizon.                                                                             |
| Horizon         | `:as_of`                                                                                                    |
| Inclusions      | Genuinely unknown dimensions                                                                                |
| Exclusions      | None.                                                                                                       |
| Alias semantics | Evaluated against the active root.                                                                          |
| Corrections     | Recomputed at each horizon.                                                                                 |
| Missing data    | This metric measures missing data; an empty scope yields UNKNOWN.                                           |
| Aggregation     | Additive across disjoint areas of one boundary version.                                                     |
| Disclosures     | Missing coverage is not zero incidence. A jurisdiction with no data has not been shown to have no problems. |

```sql
select
  count(*)::int as denominator,
  count(*) filter (where s.status is null
                      or s.category is null
                      or s.jurisdiction_id is null)::int as any_dimension_unknown,
  count(*) filter (where s.status is null)::int as status_unknown,
  count(*) filter (where s.category is null)::int as category_unknown,
  count(*) filter (where s.jurisdiction_id is null)::int as jurisdiction_unknown
from issue_status s
```

<!-- END generated: metric reference -->
