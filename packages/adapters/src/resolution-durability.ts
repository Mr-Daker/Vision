/**
 * Reading resolution durability out of the record (roadmap V050a).
 *
 * One query builds a row per completion claim carrying everything the five
 * signals need, and the signals are decided from that row rather than by five
 * separate scans — so every signal describes the same set of claims, and a
 * claim cannot appear in one denominator and be missing from another.
 *
 * What is deliberately not selected: `resolution_claim.staff_id`. It is on the
 * table and it would be one more column, and that is exactly why the omission
 * is written down here. The unit of this measurement is the department within
 * a ward. Attaching a pattern to a named worker is a supervisor's deliberate
 * act, not something a report does because the column was available.
 */

import type { DurabilitySignal, UnitObservation } from "@vision/domain";

import type { Queryable } from "./outbox.ts";

export type DurabilityWindow = {
  readonly asOf: Date;
  /** How far back to read. A durability figure is always about a period. */
  readonly days?: number;
  /** Claims filed within this fraction of the ageing threshold count as "near". */
  readonly nearDeadlineFraction?: number;
  /** Below this many minutes from work planned to claim is "implausibly fast". */
  readonly fastClaimMinutes?: number;
  readonly jurisdictionIds?: readonly string[];
};

/**
 * One row per completion claim, with the facts each signal is decided from.
 *
 * The joins are all to things V035 already writes: the claim, its evidence, the
 * reporter's answer, and the issue's own transition history.
 */
const CLAIM_FACTS_SQL = `
  with params as (
    select $1::timestamptz as as_of,
           $2::int         as window_days,
           $3::numeric     as near_fraction,
           $4::int         as fast_minutes,
           $5::uuid[]      as jurisdictions
  ),
  claim_row as (
    select c.claim_id,
           c.issue_id,
           c.claimed_at,
           i.jurisdiction_id,
           coalesce(j.internal_code, 'UNKNOWN') as ward_code,
           coalesce(a.department_id, 'unassigned') as department_id,
           -- The answer the reporter gave, if they gave one.
           (select rc.decision from resolution_confirmation rc
             where rc.claim_id = c.claim_id
             order by rc.decided_at desc limit 1) as decision,
           -- Did the issue come back after that answer?
           -- Came back: a reopening was recorded, or the same issue took
           -- another completion claim afterwards. Either is the work not
           -- having held; a deployment that records one but not the other
           -- still gets the signal.
           (
             exists (
               select 1 from status_event e
                where e.aggregate_type = 'canonical_issue'
                  and e.aggregate_id = c.issue_id::text
                  and e.event_type in ('reopened', 'issue_reopened')
                  and e.occurred_at > c.claimed_at
             )
             or exists (
               select 1 from resolution_claim later
                where later.issue_id = c.issue_id and later.claimed_at > c.claimed_at
             )
           ) as reopened_after,
           -- When the work was planned, for the speed signal.
           --
           -- The event when there is one; otherwise when the crew was given
           -- the issue. A deployment that never records a planning event still
           -- gets the signal, and a claim filed minutes after the assignment is
           -- the same observation.
           coalesce(
             (select max(e.occurred_at) from status_event e
               where e.aggregate_type = 'canonical_issue'
                 and e.aggregate_id = c.issue_id::text
                 and e.event_type = 'work_planned'
                 and e.occurred_at <= c.claimed_at),
             a.valid_from
           ) as work_planned_at,
           -- The ageing threshold this issue was running against.
           (select max(al.threshold_days) from issue_alert al
             where al.issue_id = c.issue_id) as threshold_days,
           (select count(*) from resolution_evidence_item re
             where re.claim_id = c.claim_id) as evidence_count,
           i.opened_at
      from resolution_claim c
      join canonical_issue i on i.issue_id = c.issue_id
      left join jurisdiction j on j.jurisdiction_id = i.jurisdiction_id
      left join assignment a
             on a.issue_id = c.issue_id and a.valid_to is null
     cross join params p
     where c.claimed_at > p.as_of - (p.window_days * interval '1 day')
       and (p.jurisdictions is null or i.jurisdiction_id = any(p.jurisdictions))
  )
  select department_id,
         coalesce(jurisdiction_id::text, 'UNKNOWN') as jurisdiction_key,
         max(ward_code) as ward_code,
         count(*)::int as claims,
         count(*) filter (where decision is not null)::int as answered_claims,
         count(*) filter (where decision = 'confirmed')::int as confirmed_closures,
         count(*) filter (where decision = 'confirmed' and reopened_after)::int as did_not_hold,
         count(*) filter (where decision = 'disputed')::int as disputed_by_reporter,
         count(*) filter (
           where threshold_days is not null
             and extract(epoch from (claimed_at - opened_at)) / 86400.0
                 >= threshold_days * (select near_fraction from params)
         )::int as claimed_near_deadline,
         count(*) filter (
           where work_planned_at is not null
             and extract(epoch from (claimed_at - work_planned_at)) / 60.0
                 < (select fast_minutes from params)
         )::int as claimed_implausibly_fast,
         count(*) filter (where evidence_count <= 1)::int as minimum_evidence
    from claim_row
   group by department_id, jurisdiction_key
   order by department_id, jurisdiction_key
`;

export type DurabilityReading = {
  readonly observations: readonly UnitObservation[];
  readonly window: { readonly days: number; readonly asOf: string };
  readonly settings: {
    readonly nearDeadlineFraction: number;
    readonly fastClaimMinutes: number;
  };
  readonly totalClaims: number;
};

export const readDurability = async (
  tx: Queryable,
  window: DurabilityWindow,
): Promise<DurabilityReading> => {
  const days = window.days ?? 90;
  const nearDeadlineFraction = window.nearDeadlineFraction ?? 0.9;
  const fastClaimMinutes = window.fastClaimMinutes ?? 15;

  const { rows } = await tx.query(CLAIM_FACTS_SQL, [
    window.asOf.toISOString(),
    days,
    nearDeadlineFraction,
    fastClaimMinutes,
    window.jurisdictionIds === undefined ? null : [...window.jurisdictionIds],
  ]);

  const observations: UnitObservation[] = rows.map((row) => {
    const counts: Record<DurabilitySignal, number> = {
      did_not_hold: Number(row["did_not_hold"] ?? 0),
      disputed_by_reporter: Number(row["disputed_by_reporter"] ?? 0),
      claimed_near_deadline: Number(row["claimed_near_deadline"] ?? 0),
      claimed_implausibly_fast: Number(row["claimed_implausibly_fast"] ?? 0),
      minimum_evidence: Number(row["minimum_evidence"] ?? 0),
    };
    const department = String(row["department_id"]);
    const jurisdiction = String(row["jurisdiction_key"]);
    const ward = String(row["ward_code"] ?? "UNKNOWN");
    return {
      unit: {
        departmentId: department,
        jurisdictionId: jurisdiction,
        // The ward's own code rather than its identifier: a supervisor reads
        // this to decide where to walk, and a UUID is not a place.
        label: `${department} · ${ward}`,
      },
      confirmedClosures: Number(row["confirmed_closures"] ?? 0),
      answeredClaims: Number(row["answered_claims"] ?? 0),
      claims: Number(row["claims"] ?? 0),
      counts,
    };
  });

  return {
    observations,
    window: { days, asOf: window.asOf.toISOString() },
    settings: { nearDeadlineFraction, fastClaimMinutes },
    totalClaims: observations.reduce((total, observation) => total + observation.claims, 0),
  };
};
