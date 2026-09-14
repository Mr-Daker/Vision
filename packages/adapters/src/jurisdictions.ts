/**
 * Versioned location-to-jurisdiction resolution (roadmap V033).
 *
 * The point decides which people may see a private report, so this is a
 * deterministic PostGIS lookup over a named boundary version. It never calls
 * a model and never picks the first overlap. The phone's accuracy is treated
 * as uncertainty: a reading close enough to an edge to cross it waits for
 * review instead of receiving a confidently wrong jurisdiction.
 */

import { randomUUID } from "node:crypto";

import type { Queryable } from "./outbox.ts";
import type { TransactionalClient } from "./submissions.ts";

export class JurisdictionResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JurisdictionResolutionError";
  }
}

type BoundaryCoordinates = readonly (readonly (readonly (readonly [number, number])[])[])[];

export type SeedableJurisdictionProfile = {
  readonly jurisdiction_profile_id: string;
  readonly directory_version: string;
  readonly level_scheme: string;
  readonly provenance:
    "team_created_synthetic" | "permitted_source_data" | "consented_evaluation_data";
  readonly nodes: readonly {
    readonly internal_code: string;
    readonly parent_internal_code: string | null;
    readonly level_code: string;
    readonly effective_from: string;
    readonly boundary_multipolygon: BoundaryCoordinates;
  }[];
};

export type SeededJurisdictionProfile = {
  readonly profileId: string;
  readonly boundaryVersion: string;
  readonly inserted: number;
  readonly updated: number;
  readonly jurisdictionIdsByCode: Readonly<Record<string, string>>;
};

const geoJson = (coordinates: BoundaryCoordinates): string =>
  JSON.stringify({ type: "MultiPolygon", coordinates });

/**
 * Installs a reviewed configuration pack without replacing stable row ids.
 * Existing synthetic rows are refreshed in place; a real/source-backed row is
 * never overwritten by demonstration geometry.
 */
export const seedJurisdictionProfile = async (
  client: TransactionalClient,
  profile: SeedableJurisdictionProfile,
): Promise<SeededJurisdictionProfile> => {
  const synthetic = profile.provenance === "team_created_synthetic";
  let inserted = 0;
  let updated = 0;
  const ids = new Map<string, string>();

  await client.query("begin");
  try {
    for (const node of profile.nodes) {
      const existing = await client.query(
        `select jurisdiction_id, synthetic_provenance, level_scheme, level_code,
                boundary is null as boundary_missing,
                coalesce(
                  ST_Equals(
                    boundary::geometry,
                    ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($4),4326))
                  ),
                  false
                ) as same_boundary
           from jurisdiction
          where jurisdiction_profile_id = $1 and internal_code = $2 and directory_version = $3
          for update`,
        [
          profile.jurisdiction_profile_id,
          node.internal_code,
          profile.directory_version,
          geoJson(node.boundary_multipolygon),
        ],
      );
      const current = existing.rows[0];
      if (current !== undefined && current["synthetic_provenance"] !== synthetic) {
        throw new JurisdictionResolutionError(
          `refusing to overwrite jurisdiction '${node.internal_code}' with different provenance`,
        );
      }
      if (
        current !== undefined &&
        (String(current["level_scheme"]) !== profile.level_scheme ||
          String(current["level_code"]) !== node.level_code ||
          (current["boundary_missing"] !== true && current["same_boundary"] !== true))
      ) {
        throw new JurisdictionResolutionError(
          `jurisdiction '${node.internal_code}' changed without a new boundary version`,
        );
      }

      const jurisdictionId =
        current === undefined ? randomUUID() : String(current["jurisdiction_id"]);
      if (current === undefined) {
        await client.query(
          `insert into jurisdiction
             (jurisdiction_id, jurisdiction_profile_id, internal_code,
              directory_version, level_scheme, level_code, boundary,
              effective_from, synthetic_provenance)
           values ($1,$2,$3,$4,$5,$6,
                   ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($7),4326))::geography,
                   $8,$9)`,
          [
            jurisdictionId,
            profile.jurisdiction_profile_id,
            node.internal_code,
            profile.directory_version,
            profile.level_scheme,
            node.level_code,
            geoJson(node.boundary_multipolygon),
            node.effective_from,
            synthetic,
          ],
        );
        inserted += 1;
      } else {
        await client.query(
          `update jurisdiction
              set level_scheme = $2,
                  level_code = $3,
                  boundary = ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($4),4326))::geography
            where jurisdiction_id = $1`,
          [
            jurisdictionId,
            profile.level_scheme,
            node.level_code,
            geoJson(node.boundary_multipolygon),
          ],
        );
        updated += 1;
      }
      ids.set(node.internal_code, jurisdictionId);
    }

    for (const node of profile.nodes) {
      const id = ids.get(node.internal_code);
      const parentId =
        node.parent_internal_code === null ? null : ids.get(node.parent_internal_code);
      if (id === undefined || (node.parent_internal_code !== null && parentId === undefined)) {
        throw new JurisdictionResolutionError(
          `profile '${profile.jurisdiction_profile_id}' has an unresolved parent for '${node.internal_code}'`,
        );
      }
      await client.query(
        "update jurisdiction set parent_jurisdiction_id = $2 where jurisdiction_id = $1",
        [id, parentId ?? null],
      );
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }

  return {
    profileId: profile.jurisdiction_profile_id,
    boundaryVersion: profile.directory_version,
    inserted,
    updated,
    jurisdictionIdsByCode: Object.fromEntries(ids),
  };
};

export type JurisdictionResolutionOutcome =
  "resolved" | "ambiguous" | "outside_profile" | "boundary_uncertain" | "no_active_boundaries";

export type JurisdictionCandidate = {
  readonly jurisdictionId: string;
  readonly internalCode: string;
  readonly levelCode: string;
  readonly depth: number;
};

export type JurisdictionResolution = {
  readonly outcome: JurisdictionResolutionOutcome;
  readonly profileId: string;
  readonly boundaryVersion: string;
  readonly method: "point_in_versioned_boundary";
  readonly selected: JurisdictionCandidate | undefined;
  readonly candidates: readonly JurisdictionCandidate[];
  readonly accuracyMetres: number | undefined;
  readonly reason: string;
  readonly syntheticProvenance: boolean;
};

export type ResolveJurisdiction = (input: {
  readonly lon: number;
  readonly lat: number;
  readonly accuracyMetres: number | undefined;
  readonly observedAt: string;
}) => Promise<JurisdictionResolution>;

const assertPosition = (lon: number, lat: number, accuracyMetres: number | undefined): void => {
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
    throw new JurisdictionResolutionError("longitude must be between -180 and 180");
  }
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw new JurisdictionResolutionError("latitude must be between -90 and 90");
  }
  if (accuracyMetres !== undefined && (!Number.isFinite(accuracyMetres) || accuracyMetres < 0)) {
    throw new JurisdictionResolutionError("location accuracy must be a non-negative number");
  }
};

const candidateFrom = (row: Record<string, unknown>): JurisdictionCandidate => ({
  jurisdictionId: String(row["jurisdiction_id"]),
  internalCode: String(row["internal_code"]),
  levelCode: String(row["level_code"]),
  depth: Number(row["depth"]),
});

const ACTIVE_TREE = `
  with recursive active as (
    select jurisdiction_id, parent_jurisdiction_id, internal_code, level_code,
           boundary, synthetic_provenance
      from jurisdiction
     where jurisdiction_profile_id = $1
       and directory_version = $2
       and effective_from <= $5::timestamptz
       and (effective_to is null or effective_to > $5::timestamptz)
       and boundary is not null
  ), tree as (
    select a.*, 0 as depth
      from active a
     where a.parent_jurisdiction_id is null
        or not exists (select 1 from active p where p.jurisdiction_id = a.parent_jurisdiction_id)
    union all
    select child.*, parent.depth + 1
      from active child
      join tree parent on parent.jurisdiction_id = child.parent_jurisdiction_id
  )`;

/** Resolve to the deepest active boundary. Parent/child containment is expected; sibling overlap is not. */
export const resolveJurisdictionAtLocation = async (
  tx: Queryable,
  options: {
    readonly profileId: string;
    readonly boundaryVersion: string;
    readonly lon: number;
    readonly lat: number;
    readonly accuracyMetres: number | undefined;
    readonly observedAt: string;
  },
): Promise<JurisdictionResolution> => {
  assertPosition(options.lon, options.lat, options.accuracyMetres);
  if (options.profileId.trim().length === 0 || options.boundaryVersion.trim().length === 0) {
    throw new JurisdictionResolutionError("profile and boundary versions are required");
  }

  const active = await tx.query(
    `select count(*)::int as n,
            coalesce(bool_and(synthetic_provenance), false) as all_synthetic
       from jurisdiction
      where jurisdiction_profile_id = $1 and directory_version = $2
        and effective_from <= $3::timestamptz
        and (effective_to is null or effective_to > $3::timestamptz)
        and boundary is not null`,
    [options.profileId, options.boundaryVersion, options.observedAt],
  );
  const activeCount = Number(active.rows[0]?.["n"] ?? 0);
  const syntheticProvenance = active.rows[0]?.["all_synthetic"] === true;
  const base = {
    profileId: options.profileId,
    boundaryVersion: options.boundaryVersion,
    method: "point_in_versioned_boundary" as const,
    accuracyMetres: options.accuracyMetres,
    syntheticProvenance,
  };
  if (activeCount === 0) {
    return {
      ...base,
      outcome: "no_active_boundaries",
      selected: undefined,
      candidates: [],
      reason: `boundary version '${options.boundaryVersion}' has no active geometry at the observation time`,
    };
  }

  const covering = await tx.query(
    `${ACTIVE_TREE}, covering as (
       select tree.*,
              ST_Distance(
                ST_SetSRID(ST_MakePoint($3,$4),4326)::geography,
                ST_Boundary(tree.boundary::geometry)::geography
              ) as edge_distance_m
         from tree
        where ST_Covers(tree.boundary::geometry, ST_SetSRID(ST_MakePoint($3,$4),4326))
     )
     select jurisdiction_id, internal_code, level_code, depth, edge_distance_m
       from covering
      where depth = (select max(depth) from covering)
      order by internal_code`,
    [options.profileId, options.boundaryVersion, options.lon, options.lat, options.observedAt],
  );

  if (covering.rows.length === 0) {
    if (options.accuracyMetres !== undefined && options.accuracyMetres > 0) {
      const nearby = await tx.query(
        `${ACTIVE_TREE}, near_boundary as (
           select tree.*
             from tree
            where ST_DWithin(
              ST_Boundary(tree.boundary::geometry)::geography,
              ST_SetSRID(ST_MakePoint($3,$4),4326)::geography,
              least($6::numeric, 5000)
            )
         )
         select jurisdiction_id, internal_code, level_code, depth
           from near_boundary
          where depth = (select max(depth) from near_boundary)
          order by internal_code`,
        [
          options.profileId,
          options.boundaryVersion,
          options.lon,
          options.lat,
          options.observedAt,
          options.accuracyMetres,
        ],
      );
      if (nearby.rows.length > 0) {
        return {
          ...base,
          outcome: "boundary_uncertain",
          selected: undefined,
          candidates: nearby.rows.map(candidateFrom),
          reason:
            "the reported point is outside the profile, but its accuracy range reaches a boundary; a person must resolve it",
        };
      }
    }
    return {
      ...base,
      outcome: "outside_profile",
      selected: undefined,
      candidates: [],
      reason: `the reported point is outside boundary version '${options.boundaryVersion}'`,
    };
  }

  const candidates = covering.rows.map(candidateFrom);
  if (candidates.length > 1) {
    return {
      ...base,
      outcome: "ambiguous",
      selected: undefined,
      candidates,
      reason: `the point is covered by ${String(candidates.length)} equally specific boundaries; no jurisdiction was guessed`,
    };
  }

  const selected = candidates[0];
  if (selected === undefined) {
    throw new JurisdictionResolutionError("the boundary query returned no selectable row");
  }
  const edgeDistance = Number(covering.rows[0]?.["edge_distance_m"] ?? 0);
  if (
    options.accuracyMetres !== undefined &&
    (options.accuracyMetres > 5_000 || options.accuracyMetres >= edgeDistance)
  ) {
    const nearby = await tx.query(
      `${ACTIVE_TREE}
       select jurisdiction_id, internal_code, level_code, depth
         from tree
        where depth = $6
          and ST_DWithin(
            ST_Boundary(tree.boundary::geometry)::geography,
            ST_SetSRID(ST_MakePoint($3,$4),4326)::geography,
            least($7::numeric, 5000)
          )
        order by internal_code`,
      [
        options.profileId,
        options.boundaryVersion,
        options.lon,
        options.lat,
        options.observedAt,
        selected.depth,
        options.accuracyMetres,
      ],
    );
    return {
      ...base,
      outcome: "boundary_uncertain",
      selected: undefined,
      candidates: nearby.rows.map(candidateFrom),
      reason: `the ±${String(Math.round(options.accuracyMetres))} m location range reaches the edge of '${selected.internalCode}'; no jurisdiction was guessed`,
    };
  }

  return {
    ...base,
    outcome: "resolved",
    selected,
    candidates: [selected],
    reason: `the point falls inside '${selected.internalCode}', the deepest active boundary in '${options.boundaryVersion}'`,
  };
};

export const recordJurisdictionResolution = async (
  tx: Queryable,
  options: {
    readonly submissionId: string;
    readonly issueId: string | undefined;
    readonly appliedToIssue: boolean;
    readonly resolution: JurisdictionResolution;
  },
): Promise<string> => {
  const resolutionId = randomUUID();
  await tx.query(
    `insert into jurisdiction_resolution
       (resolution_id, submission_id, issue_id, jurisdiction_profile_id,
        boundary_version, method, outcome, selected_jurisdiction_id,
        candidate_jurisdiction_ids, applied_to_issue, reason, synthetic_provenance)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9::uuid[],$10,$11,$12)`,
    [
      resolutionId,
      options.submissionId,
      options.issueId ?? null,
      options.resolution.profileId,
      options.resolution.boundaryVersion,
      options.resolution.method,
      options.resolution.outcome,
      options.resolution.selected?.jurisdictionId ?? null,
      options.resolution.candidates.map((candidate) => candidate.jurisdictionId),
      options.appliedToIssue,
      options.resolution.reason,
      options.resolution.syntheticProvenance,
    ],
  );
  return resolutionId;
};
