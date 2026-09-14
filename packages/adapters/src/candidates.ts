/**
 * Candidate retrieval for matching (roadmap V026).
 *
 * Two design points carry most of the weight.
 *
 * **The radius follows the reported accuracy.** A citizen's position comes
 * with an error estimate, and a fixed radius is wrong either way: too tight
 * and a boundary-adjacent issue is missed for someone whose phone could not
 * get a good fix, too wide and half the district becomes a candidate. So the
 * radius is `base + accuracy`, and an *unknown* accuracy uses a stated
 * allowance rather than assuming precision.
 *
 * **An empty result is not proof.** This is a bounded search: a radius, a time
 * window and a row cap. Finding nothing means this search found nothing, which
 * is not the same as there being nothing. Every result says so in `absenceIsNotProof`
 * and every query records its own bounds, so a later reader can tell an empty
 * answer from a query that was never run (V002 row 20's prohibition applied to
 * retrieval).
 *
 * Reranking is **exact**, not approximate: pgvector's index types cap at 2000
 * dimensions and the provider returns 3072, so rather than shrink the vector
 * to fit an index, the spatial index prunes and the vector comparison runs
 * exactly over what survives. More accurate, and honest about scale — V069 is
 * where growth is measured and an index strategy chosen from data.
 */

import { randomUUID } from "node:crypto";

import type { Queryable } from "./outbox.ts";

/** Radius before the reported accuracy is added. */
export const DEFAULT_BASE_RADIUS_METRES = 150;

/**
 * Added when no accuracy was reported — a typed pin, or a device that gave
 * none. Assuming precision would quietly miss the issue the citizen meant.
 */
export const UNKNOWN_ACCURACY_ALLOWANCE_METRES = 250;

export const DEFAULT_TIME_WINDOW_HOURS = 24 * 90;

/** Row cap. Hitting it makes the search non-exhaustive, which is reported. */
export const DEFAULT_CANDIDATE_LIMIT = 50;

/** Beyond this an accuracy figure is treated as unusable rather than as a radius. */
export const MAX_USABLE_ACCURACY_METRES = 5_000;

export type CandidateQueryInput = {
  readonly submissionId?: string | undefined;
  readonly lon: number;
  readonly lat: number;
  readonly accuracyMetres?: number | undefined;
  readonly category: string;
  /** Resolved from a versioned boundary. Cross-jurisdiction issues are excluded. */
  readonly jurisdictionId?: string | undefined;
  /** Used when a boundary lookup ran but could not safely select a jurisdiction. */
  readonly onlyUnscopedJurisdiction?: boolean;
  readonly assetId?: string | undefined;
  readonly baseRadiusMetres?: number;
  readonly timeWindowHours?: number;
  readonly limit?: number;
  /** Supplied to rerank exactly. Omitted when no vector exists for this text. */
  readonly embedding?: readonly number[] | undefined;
};

export type IssueCandidate = {
  readonly issueId: string;
  readonly publicReference: string;
  readonly category: string;
  readonly distanceMetres: number;
  readonly assetMatches: boolean;
  readonly categoryMatches: boolean;
  readonly openedAt: string;
  readonly lastEvidenceAt: string | undefined;
  /** Cosine distance, present only when both sides carry a comparable vector. */
  readonly semanticDistance: number | undefined;
  /** Why this row was retrieved, so a reviewer can see the reason. */
  readonly retrievedBecause: readonly string[];
};

export type CandidateDiagnostics = {
  readonly queryId: string;
  readonly radiusMetres: number;
  readonly accuracyMetres: number | undefined;
  readonly timeWindowHours: number;
  readonly assetId: string | undefined;
  readonly category: string;
  readonly jurisdictionId: string | undefined;
  readonly jurisdictionFilterMode: "all" | "resolved_or_unscoped" | "unscoped_only";
  readonly spatialCandidates: number;
  readonly rerankedCandidates: number;
  readonly exhaustive: boolean;
  readonly durationMs: number;
  readonly note: string;
};

export type CandidateQueryResult = {
  readonly candidates: readonly IssueCandidate[];
  readonly diagnostics: CandidateDiagnostics;
  /**
   * Always true. A bounded search that returned nothing has not looked
   * everywhere, and reading its silence as absence is the mistake V026 exists
   * to prevent.
   */
  readonly absenceIsNotProof: true;
};

const BOUNDED_NOTE =
  "this was a bounded search (radius, time window and row cap); an empty or short result means nothing was found within those bounds, not that no such issue exists";

/**
 * Effective search radius.
 *
 * An absurd accuracy figure is not used as a radius — a 50 km "accuracy" would
 * make every issue in the district a candidate, which is the same as having no
 * location at all. It is capped and the cap is visible in the diagnostics.
 */
export const effectiveRadiusMetres = (
  accuracyMetres: number | undefined,
  baseRadiusMetres: number = DEFAULT_BASE_RADIUS_METRES,
): number => {
  if (accuracyMetres === undefined || !Number.isFinite(accuracyMetres) || accuracyMetres < 0) {
    return baseRadiusMetres + UNKNOWN_ACCURACY_ALLOWANCE_METRES;
  }
  return baseRadiusMetres + Math.min(accuracyMetres, MAX_USABLE_ACCURACY_METRES);
};

export const retrieveCandidates = async (
  tx: Queryable,
  input: CandidateQueryInput,
): Promise<CandidateQueryResult> => {
  const startedAt = Date.now();
  const queryId = randomUUID();
  const radiusMetres = effectiveRadiusMetres(input.accuracyMetres, input.baseRadiusMetres);
  const timeWindowHours = input.timeWindowHours ?? DEFAULT_TIME_WINDOW_HOURS;
  const limit = input.limit ?? DEFAULT_CANDIDATE_LIMIT;
  const embedding = input.embedding;
  const vectorLiteral = embedding === undefined ? null : JSON.stringify([...embedding]);
  const jurisdictionFilterMode = input.onlyUnscopedJurisdiction
    ? "unscoped_only"
    : input.jurisdictionId === undefined
      ? "all"
      : "resolved_or_unscoped";

  // One row over the cap, so hitting the cap is detectable rather than
  // guessed at from a result that happens to be exactly `limit` long.
  const probeLimit = limit + 1;

  const { rows } = await tx.query(
    `select
        issue_id,
        public_reference,
        category,
        opened_at,
        last_evidence_at,
        asset_id,
        -- Metres, because the column is geography. A geometry column would
        -- return degrees here and the radius would be meaningless.
        ST_Distance(representative_location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography)
          as distance_m,
        case
          when $6::vector is null or representative_embedding is null then null
          -- Exact cosine distance over the bounded candidate set.
          else representative_embedding <=> $6::vector
        end as semantic_distance,
        (asset_id is not null and asset_id = $5) as asset_matches
      from canonical_issue
     where opened_at >= now() - ($4::numeric * interval '1 hour')
       and ($8::uuid is null or jurisdiction_id is null or jurisdiction_id = $8::uuid)
       and (not $9::boolean or jurisdiction_id is null)
       and (
         -- Either inside the accuracy-aware radius...
         (representative_location is not null
          and ST_DWithin(representative_location,
                         ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
                         $3))
         -- ...or the same physical asset, which is the same thing wherever
         -- the reporter happened to be standing.
         or (asset_id is not null and asset_id = $5)
       )
     order by
       -- Exact reranking: semantics first when a comparable vector exists on
       -- both sides, distance otherwise. Nulls last so a candidate without a
       -- vector is not treated as perfectly similar.
       semantic_distance asc nulls last,
       distance_m asc nulls last
     limit $7`,
    [
      input.lon,
      input.lat,
      radiusMetres,
      timeWindowHours,
      input.assetId ?? null,
      vectorLiteral,
      probeLimit,
      input.jurisdictionId ?? null,
      input.onlyUnscopedJurisdiction ?? false,
    ],
  );

  const exhaustive = rows.length <= limit;
  const kept = rows.slice(0, limit);

  const candidates: readonly IssueCandidate[] = kept.map((row) => {
    const assetMatches = row["asset_matches"] === true;
    const distanceMetres =
      row["distance_m"] === null ? Number.POSITIVE_INFINITY : Number(row["distance_m"]);
    const categoryMatches = String(row["category"]) === input.category;
    const semanticRaw = row["semantic_distance"];
    const reasons: string[] = [];
    if (distanceMetres <= radiusMetres) {
      reasons.push(`within ${String(Math.round(radiusMetres))} m of the reported position`);
    }
    if (assetMatches) reasons.push("the same asset identifier");
    if (semanticRaw !== null && semanticRaw !== undefined) {
      reasons.push("compared by semantic similarity");
    }
    return {
      issueId: String(row["issue_id"]),
      publicReference: String(row["public_reference"]),
      category: String(row["category"]),
      distanceMetres,
      assetMatches,
      categoryMatches,
      openedAt: new Date(String(row["opened_at"])).toISOString(),
      lastEvidenceAt:
        row["last_evidence_at"] === null
          ? undefined
          : new Date(String(row["last_evidence_at"])).toISOString(),
      semanticDistance:
        semanticRaw === null || semanticRaw === undefined ? undefined : Number(semanticRaw),
      retrievedBecause: reasons,
    };
  });

  const diagnostics: CandidateDiagnostics = {
    queryId,
    radiusMetres,
    accuracyMetres: input.accuracyMetres,
    timeWindowHours,
    assetId: input.assetId,
    category: input.category,
    jurisdictionId: input.jurisdictionId,
    jurisdictionFilterMode,
    spatialCandidates: rows.length,
    rerankedCandidates: candidates.filter((c) => c.semanticDistance !== undefined).length,
    exhaustive,
    durationMs: Date.now() - startedAt,
    note: BOUNDED_NOTE,
  };

  // Retained as V026 requires. Only recorded against a real submission —
  // a diagnostic row referencing nothing would fail its foreign key.
  if (input.submissionId !== undefined) {
    await tx.query(
      `insert into candidate_query_log
         (query_id, submission_id, radius_metres, accuracy_metres, time_window_hours,
          asset_id, category, spatial_candidates, reranked_candidates, exhaustive, duration_ms,
          jurisdiction_id, jurisdiction_filter_mode)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        queryId,
        input.submissionId,
        radiusMetres,
        input.accuracyMetres ?? null,
        timeWindowHours,
        input.assetId ?? null,
        input.category,
        Math.min(rows.length, limit),
        diagnostics.rerankedCandidates,
        exhaustive,
        diagnostics.durationMs,
        input.jurisdictionId ?? null,
        jurisdictionFilterMode,
      ],
    );
  }

  return { candidates, diagnostics, absenceIsNotProof: true };
};
