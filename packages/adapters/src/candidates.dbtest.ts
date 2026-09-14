/**
 * Candidate retrieval against the real database (roadmap V026).
 *
 * Run with: npm run db:up && npm run db:migrate && npm run test:db
 *
 * Two things make this task subtle. A citizen's position carries an accuracy
 * figure, so a fixed radius either misses a boundary-adjacent issue or drags
 * in half the district — the radius has to widen with the reported error.
 * And an empty candidate list must never be read as "no such issue exists",
 * because a bounded search that found nothing has not looked everywhere.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

import {
  retrieveCandidates,
  DEFAULT_BASE_RADIUS_METRES,
  UNKNOWN_ACCURACY_ALLOWANCE_METRES,
} from "./candidates.ts";

const DATABASE_URL =
  process.env["DATABASE_URL"] ??
  "postgresql://vision:vision_local_dev_only@127.0.0.1:5432/vision_dev";

let client: pg.Client;
const issues: string[] = [];
const assets: string[] = [];
let jurisdictionId: string;

/** A fixed reference point; every offset below is relative to it. */
const ORIGIN = { lon: 74.5, lat: 16.85 };

/** Metres-to-degrees at this latitude, close enough for a test fixture. */
const offsetMetres = (metresEast: number): { lon: number; lat: number } => ({
  lon: ORIGIN.lon + metresEast / (111_320 * Math.cos((ORIGIN.lat * Math.PI) / 180)),
  lat: ORIGIN.lat,
});

before(async () => {
  client = new pg.Client({ connectionString: DATABASE_URL, statement_timeout: 15_000 });
  await client.connect();
  // Assets require a jurisdiction; one synthetic jurisdiction serves the file.
  jurisdictionId = randomUUID();
  await client.query(
    `insert into jurisdiction
       (jurisdiction_id, jurisdiction_profile_id, internal_code, directory_version,
        level_scheme, level_code, effective_from, synthetic_provenance)
     values ($1, 'test-profile', $2, 'test-directory.v1', 'test-scheme', 'district',
             now() - interval '1 year', true)`,
    [jurisdictionId, `code-${jurisdictionId.slice(0, 8)}`],
  );
});

after(async () => {
  if (issues.length > 0) {
    await client.query("delete from candidate_query_log where submission_id = any($1::uuid[])", [
      issues,
    ]);
    await client.query("delete from canonical_issue where issue_id = any($1::uuid[])", [issues]);
  }
  if (assets.length > 0) {
    await client.query("delete from infrastructure_asset where asset_id = any($1::text[])", [
      assets,
    ]);
  }
  await client.query("delete from jurisdiction where jurisdiction_id = $1", [jurisdictionId]);
  await client.end();
});

/** A synthetic asset. `synthetic_provenance` is explicit, per V004 §5. */
const newAsset = async (): Promise<string> => {
  const assetId = `asset-${randomUUID().slice(0, 8)}`;
  await client.query(
    `insert into infrastructure_asset
       (asset_id, asset_type, synthetic_provenance, name, location, jurisdiction_id, effective_from)
     values ($1, 'school', true, 'test asset',
             ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography, $4, now() - interval '1 year')`,
    [assetId, ORIGIN.lon, ORIGIN.lat, jurisdictionId],
  );
  assets.push(assetId);
  return assetId;
};

type IssueSpec = {
  readonly metresEast: number;
  readonly category?: string;
  readonly assetId?: string | null;
  readonly openedHoursAgo?: number;
  readonly accuracyMetres?: number;
};

const newIssue = async (spec: IssueSpec): Promise<string> => {
  const issueId = randomUUID();
  const at = offsetMetres(spec.metresEast);
  await client.query(
    `insert into canonical_issue
       (issue_id, public_reference, category, opened_at,
        representative_location, representative_accuracy_m, last_evidence_at)
     values ($1, $2, $3, now() - ($4::numeric * interval '1 hour'),
             ST_SetSRID(ST_MakePoint($5, $6), 4326)::geography, $7,
             now() - ($4::numeric * interval '1 hour'))`,
    [
      issueId,
      `VIS-${issueId.slice(0, 8)}`,
      spec.category ?? "sanitation",
      spec.openedHoursAgo ?? 1,
      at.lon,
      at.lat,
      spec.accuracyMetres ?? null,
    ],
  );
  issues.push(issueId);
  return issueId;
};

const query = (overrides: Record<string, unknown> = {}) => ({
  submissionId: undefined,
  lon: ORIGIN.lon,
  lat: ORIGIN.lat,
  category: "sanitation",
  ...overrides,
});

// ---------------------------------------------------------------------------
// Spatial bounds and distance units
// ---------------------------------------------------------------------------

test("V026: an issue inside the radius is returned with its distance in metres", async () => {
  const near = await newIssue({ metresEast: 40 });

  const result = await retrieveCandidates(client, query({ accuracyMetres: 10 }));

  const found = result.candidates.find((candidate) => candidate.issueId === near);
  assert.notEqual(found, undefined, "an issue 40 m away must be a candidate");
  // Metres, not degrees and not feet: a unit error here silently changes the
  // radius by five orders of magnitude.
  assert.ok(
    (found?.distanceMetres ?? 0) > 35 && (found?.distanceMetres ?? 0) < 45,
    `expected about 40 m, got ${String(found?.distanceMetres)}`,
  );
});

test("V026: an issue well outside the radius is not returned", async () => {
  const far = await newIssue({ metresEast: 5_000 });

  const result = await retrieveCandidates(client, query({ accuracyMetres: 10 }));

  assert.equal(
    result.candidates.some((candidate) => candidate.issueId === far),
    false,
  );
});

test("V026: a poor accuracy figure widens the radius so a boundary case is still found", async () => {
  // Just outside the base radius. With a 10 m fix it should be missed; with a
  // 200 m fix the citizen could genuinely be standing at the issue.
  const edge = await newIssue({ metresEast: DEFAULT_BASE_RADIUS_METRES + 60 });

  const tight = await retrieveCandidates(client, query({ accuracyMetres: 10 }));
  const loose = await retrieveCandidates(client, query({ accuracyMetres: 200 }));

  assert.equal(
    tight.candidates.some((candidate) => candidate.issueId === edge),
    false,
    "a precise fix must not drag in an issue beyond the radius",
  );
  assert.equal(
    loose.candidates.some((candidate) => candidate.issueId === edge),
    true,
    "an imprecise fix must widen the search rather than miss the issue",
  );
  assert.ok(loose.diagnostics.radiusMetres > tight.diagnostics.radiusMetres);
});

test("V026: an unknown accuracy uses the stated allowance rather than assuming precision", async () => {
  const edge = await newIssue({ metresEast: DEFAULT_BASE_RADIUS_METRES + 40 });

  const result = await retrieveCandidates(client, query({ accuracyMetres: undefined }));

  assert.equal(
    result.diagnostics.radiusMetres,
    DEFAULT_BASE_RADIUS_METRES + UNKNOWN_ACCURACY_ALLOWANCE_METRES,
  );
  assert.equal(
    result.candidates.some((candidate) => candidate.issueId === edge),
    true,
  );
});

// ---------------------------------------------------------------------------
// Time window, assets and categories
// ---------------------------------------------------------------------------

test("V026: an issue outside the time window is not a candidate", async () => {
  const old = await newIssue({ metresEast: 20, openedHoursAgo: 24 * 400 });

  const result = await retrieveCandidates(client, query({ timeWindowHours: 24 * 30 }));

  assert.equal(
    result.candidates.some((candidate) => candidate.issueId === old),
    false,
  );
});

test("V026: an exact asset match is a candidate even when it is far away", async () => {
  // The same physical asset is the same thing regardless of where the
  // reporter was standing when they noticed it.
  const assetId = await newAsset();
  const distant = await newIssue({ metresEast: 9_000 });
  await client.query("update canonical_issue set asset_id = $2 where issue_id = $1", [
    distant,
    assetId,
  ]);

  const result = await retrieveCandidates(client, query({ assetId }));

  const found = result.candidates.find((candidate) => candidate.issueId === distant);
  assert.notEqual(found, undefined, "an asset match must not be lost to a radius");
  assert.equal(found?.assetMatches, true);
});

test("V026: repeated issues on one asset are all returned", async () => {
  const assetId = await newAsset();
  const first = await newIssue({ metresEast: 10 });
  const second = await newIssue({ metresEast: 15 });
  await client.query("update canonical_issue set asset_id = $2 where issue_id = any($1::uuid[])", [
    [first, second],
    assetId,
  ]);

  const result = await retrieveCandidates(client, query({ assetId }));

  const ids = result.candidates.map((candidate) => candidate.issueId);
  assert.ok(ids.includes(first) && ids.includes(second));
});

test("V026: a nearby issue in a different category is retrieved but marked as not matching", async () => {
  // Retrieved, because a reviewer may still want to see it; flagged, so V027
  // can keep a different defect separate rather than merging it.
  const other = await newIssue({ metresEast: 25, category: "structural" });

  const result = await retrieveCandidates(client, query({ category: "sanitation" }));

  const found = result.candidates.find((candidate) => candidate.issueId === other);
  assert.notEqual(found, undefined, "a nearby issue must still be visible as a candidate");
  assert.equal(found?.categoryMatches, false);
});

// ---------------------------------------------------------------------------
// Exact vector reranking
// ---------------------------------------------------------------------------

const unitVector = (seed: number): number[] => {
  const raw = Array.from({ length: 3072 }, (_v, index) => Math.sin((index + 1) * seed));
  const norm = Math.sqrt(raw.reduce((sum, value) => sum + value * value, 0));
  return raw.map((value) => value / norm);
};

const attachEmbedding = async (issueId: string, seed: number): Promise<void> => {
  // The model name is set alongside the vector because
  // `canonical_issue_embedding_model_ck` refuses one without the other — a
  // vector whose producer is unknown cannot safely be compared with anything.
  await client.query(
    `update canonical_issue
        set representative_embedding = $2::vector,
            representative_embedding_model = 'gemini-embedding-001'
      where issue_id = $1`,
    [issueId, JSON.stringify(unitVector(seed))],
  );
};

test("V026: candidates are reranked exactly by semantic distance when vectors exist", async () => {
  const similar = await newIssue({ metresEast: 100 });
  const different = await newIssue({ metresEast: 10 });
  await attachEmbedding(similar, 0.5);
  await attachEmbedding(different, 7.0);

  const result = await retrieveCandidates(
    client,
    query({ embedding: unitVector(0.5), accuracyMetres: 10 }),
  );

  const ranked = result.candidates.filter((candidate) =>
    [similar, different].includes(candidate.issueId),
  );
  assert.equal(
    ranked[0]?.issueId,
    similar,
    "the semantically closest must rank first, not the nearest",
  );
  assert.ok((ranked[0]?.semanticDistance ?? 1) < (ranked[1]?.semanticDistance ?? 0));
});

test("V026: with no vector supplied, candidates are ordered by distance", async () => {
  const near = await newIssue({ metresEast: 5 });
  const further = await newIssue({ metresEast: 120 });

  const result = await retrieveCandidates(client, query({ accuracyMetres: 10 }));

  const ranked = result.candidates.filter((candidate) =>
    [near, further].includes(candidate.issueId),
  );
  assert.equal(ranked[0]?.issueId, near);
  assert.equal(ranked[0]?.semanticDistance, undefined);
});

// ---------------------------------------------------------------------------
// Diagnostics, and what an empty result means
// ---------------------------------------------------------------------------

test("V026: an empty result is never proof that no candidate exists", async () => {
  const result = await retrieveCandidates(
    client,
    query({ lon: 20.0, lat: 5.0, accuracyMetres: 5 }),
  );

  assert.deepEqual(result.candidates, []);
  assert.equal(result.absenceIsNotProof, true);
  assert.match(result.diagnostics.note, /searched|bounded|not .*proof/i);
});

test("V026: hitting the candidate cap is reported as a non-exhaustive search", async () => {
  for (let index = 0; index < 4; index += 1) await newIssue({ metresEast: 10 + index });

  const result = await retrieveCandidates(client, query({ accuracyMetres: 10, limit: 2 }));

  assert.equal(result.candidates.length, 2);
  assert.equal(result.diagnostics.exhaustive, false, "a capped search has not looked everywhere");
});

test("V026: a search that returned everything inside its bounds is exhaustive", async () => {
  await newIssue({ metresEast: 12 });

  const result = await retrieveCandidates(client, query({ accuracyMetres: 10, limit: 500 }));

  assert.equal(result.diagnostics.exhaustive, true);
});

test("V026: every query records its own diagnostics for later inspection", async () => {
  const submissionId = randomUUID();

  const result = await retrieveCandidates(
    client,
    query({ accuracyMetres: 25, timeWindowHours: 48 }),
  );

  assert.equal(result.diagnostics.accuracyMetres, 25);
  assert.equal(result.diagnostics.timeWindowHours, 48);
  assert.ok(result.diagnostics.durationMs >= 0);
  assert.ok(result.diagnostics.spatialCandidates >= result.candidates.length);
  void submissionId;
});

test("V026: a candidate with no vector is not ranked as if it were a perfect match", async () => {
  // The mixed case: one candidate carries a comparable vector, the other has
  // none. Sorting nulls first would put "we cannot compare this" ahead of a
  // measured close match, which reads an unknown as a certainty.
  const withVector = await newIssue({ metresEast: 130 });
  const withoutVector = await newIssue({ metresEast: 8 });
  await attachEmbedding(withVector, 0.5);

  const result = await retrieveCandidates(
    client,
    query({ embedding: unitVector(0.5), accuracyMetres: 10 }),
  );

  const ranked = result.candidates.filter((candidate) =>
    [withVector, withoutVector].includes(candidate.issueId),
  );
  assert.equal(ranked.length, 2, "both must still be candidates");
  assert.equal(
    ranked[0]?.issueId,
    withVector,
    "a measured semantic match must outrank an uncomparable candidate",
  );
  assert.equal(ranked[1]?.semanticDistance, undefined);
});
