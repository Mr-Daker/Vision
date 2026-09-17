/**
 * Gathering the inputs a V042 ordering is built from.
 *
 * The policy itself is pure and lives in `@vision/domain`. This is the part
 * that reads the database, and its only job is to hand the policy honest
 * inputs — which mostly means handing it `null` where a figure does not exist,
 * rather than a plausible substitute.
 *
 * Three substitutions this file deliberately does not make:
 *
 *  - **A ward with no population figure gets `null`, never zero.** Zero would
 *    make the service-population factor read as "nobody lives here" and would
 *    push an unmeasured ward to the bottom of every ordering.
 *  - **A ward with no population gets no reporting rate either**, because
 *    reports per head is undefined without a denominator and the point of the
 *    equity factor is precisely that low reporting is not low need.
 *  - **An unsearched project register is not an absence of projects.** V041
 *    distinguishes "searched and found nothing" from "nobody has looked", and
 *    that distinction survives into the factor.
 *
 * Nothing here ranks anything. `prioritise` does that, and it cannot be called
 * without a set of weightings.
 */

import {
  prioritise,
  type CandidateInput,
  type PriorityOrdering,
  type RecommendationPolicy,
} from "@vision/domain";

import type { Queryable } from "./outbox.ts";

export class PrioritizationInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrioritizationInputError";
  }
}

/**
 * One row per open report, with every factor input it has and nulls for the
 * ones it does not.
 *
 * `alternatives_nearby` counts assets of the same type within the configured
 * radius, excluding the report's own asset. It is null when the report has no
 * position, because "no comparable asset nearby" and "we do not know where
 * this is" are different statements.
 */
export const CANDIDATE_INPUT_SQL = `with population as (
    select o.jurisdiction_id, o.value as residents
      from context_observation o
      join context_dataset d on d.dataset_id = o.dataset_id
     where d.kind = 'population' and o.value is not null
  ),
  ward_reports as (
    select c.jurisdiction_id, count(*)::int as reports
      from canonical_issue c
     where c.jurisdiction_id is not null
     group by c.jurisdiction_id
  )
select
  c.issue_id, c.public_reference, c.category, c.jurisdiction_id,
  round(extract(epoch from ($2::timestamptz - c.opened_at)) / 86400.0) as open_days,
  (select count(*)::int from reopening r where r.issue_id = c.issue_id) as reopening_count,
  p.residents as service_population,
  w.reports as ward_report_count,
  case when c.representative_location is null then null else (
    select count(*)::int from infrastructure_asset a
     where a.asset_id is distinct from c.asset_id
       and st_dwithin(a.location, c.representative_location, $3::double precision)
  ) end as alternatives_nearby,
  exists (
    select 1 from project_link l
     where l.issue_id = c.issue_id and l.match_status = 'confirmed'
  ) as has_confirmed_project,
  exists (select 1 from project_link l where l.issue_id = c.issue_id) as register_searched
from canonical_issue c
left join population p on p.jurisdiction_id = c.jurisdiction_id
left join ward_reports w on w.jurisdiction_id = c.jurisdiction_id
where c.jurisdiction_id = any($1::uuid[])
  and c.current_status <> 'resolution_confirmed'
  and not exists (
    select 1 from issue_alias al
     where al.source_issue_id = c.issue_id and al.valid_to is null
  )
order by c.opened_at asc
limit $4`;

export type CandidateGatherOptions = {
  readonly jurisdictionIds: readonly string[];
  readonly asOf: Date;
  /** Metres within which another asset counts as an alternative. */
  readonly alternativeRadiusMetres?: number;
  readonly limit?: number;
};

export const gatherCandidates = async (
  tx: Queryable,
  options: CandidateGatherOptions,
): Promise<readonly CandidateInput[]> => {
  if (options.jurisdictionIds.length === 0) return [];
  const { rows } = await tx.query(CANDIDATE_INPUT_SQL, [
    [...options.jurisdictionIds],
    options.asOf.toISOString(),
    options.alternativeRadiusMetres ?? 2000,
    options.limit ?? 200,
  ]);

  return rows.map((row) => {
    const number = (value: unknown): number | null =>
      value === null || value === undefined ? null : Number(value);
    const servicePopulation = number(row["service_population"]);
    return {
      candidateId: String(row["issue_id"]),
      label: String(row["public_reference"]),
      jurisdictionKey: String(row["jurisdiction_id"]),
      category: String(row["category"]),
      openDays: Number(row["open_days"] ?? 0),
      reopeningCount: Number(row["reopening_count"] ?? 0),
      servicePopulation,
      // Withheld together with the population: a report count without a
      // denominator is a volume, and treating a volume as a rate is exactly
      // how a large ward looks like a troubled one.
      wardReportCount: servicePopulation === null ? null : number(row["ward_report_count"]),
      alternativesNearby: number(row["alternatives_nearby"]),
      hasConfirmedProject: row["has_confirmed_project"] === true,
      projectRegisterSearched: row["register_searched"] === true,
    };
  });
};

export type OrderingResult = {
  readonly ordering: PriorityOrdering;
  readonly candidateCount: number;
  /**
   * False when the candidate limit was reached.
   *
   * An ordering of the first two hundred reports read as an ordering of every
   * report would put a cut-off nobody chose at the bottom of the list.
   */
  readonly exhaustive: boolean;
  readonly asOf: string;
};

/**
 * Gathers the inputs and produces the ordering with its sensitivity.
 *
 * A thin composition on purpose: there is no place here where a caller could
 * pass one weighting, and no place where a missing input could be defaulted on
 * the way through.
 */
export const orderCandidates = async (
  tx: Queryable,
  options: CandidateGatherOptions & { readonly policy: RecommendationPolicy },
): Promise<OrderingResult> => {
  const candidates = await gatherCandidates(tx, options);
  if (candidates.length === 0) {
    throw new PrioritizationInputError(
      "no open reports in these jurisdictions; an ordering of nothing would be an empty list a reader could mistake for a finding",
    );
  }
  return {
    ordering: prioritise(candidates, options.policy),
    candidateCount: candidates.length,
    exhaustive: candidates.length < (options.limit ?? 200),
    asOf: options.asOf.toISOString(),
  };
};
