/** Versioned PostGIS jurisdiction resolution (roadmap V033). */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

import {
  recordJurisdictionResolution,
  resolveJurisdictionAtLocation,
  seedJurisdictionProfile,
} from "./jurisdictions.ts";
import { resolveRouting, seedRoutingDirectoryForProfile } from "./routing.ts";

const DATABASE_URL =
  process.env["DATABASE_URL"] ??
  "postgresql://vision:vision_local_dev_only@127.0.0.1:5432/vision_dev";

const PROFILE = `resolution-test-${randomUUID()}`;
const BOUNDARY_VERSION = "test-boundaries.v1";
const ROUTING_VERSION = "test-routing.v1";
const OBSERVED_AT = "2026-09-13T08:00:00.000Z";

const profile = {
  jurisdiction_profile_id: PROFILE,
  directory_version: BOUNDARY_VERSION,
  level_scheme: "test-levels.v1",
  provenance: "team_created_synthetic" as const,
  nodes: [
    {
      internal_code: "ROOT",
      parent_internal_code: null,
      level_code: "district",
      effective_from: "2026-01-01T00:00:00Z",
      boundary_multipolygon: [
        [
          [
            [10, 10],
            [10.1, 10],
            [10.1, 10.1],
            [10, 10.1],
            [10, 10],
          ],
        ],
      ] as const,
    },
    {
      internal_code: "WEST",
      parent_internal_code: "ROOT",
      level_code: "block",
      effective_from: "2026-01-01T00:00:00Z",
      boundary_multipolygon: [
        [
          [
            [10, 10],
            [10.05, 10],
            [10.05, 10.1],
            [10, 10.1],
            [10, 10],
          ],
        ],
      ] as const,
    },
    {
      internal_code: "EAST",
      parent_internal_code: "ROOT",
      level_code: "block",
      effective_from: "2026-01-01T00:00:00Z",
      boundary_multipolygon: [
        [
          [
            [10.05, 10],
            [10.1, 10],
            [10.1, 10.1],
            [10.05, 10.1],
            [10.05, 10],
          ],
        ],
      ] as const,
    },
  ],
};

let client: pg.Client;
const participants: string[] = [];
const submissions: string[] = [];
const issues: string[] = [];

before(async () => {
  client = new pg.Client({ connectionString: DATABASE_URL, statement_timeout: 15_000 });
  await client.connect();
});

after(async () => {
  await client.end().catch(() => undefined);
  const cleaner = new pg.Client({ connectionString: DATABASE_URL, statement_timeout: 15_000 });
  await cleaner.connect();
  try {
    if (issues.length > 0) {
      await cleaner.query("delete from routing_decision where issue_id = any($1::uuid[])", [
        issues,
      ]);
      await cleaner.query("delete from jurisdiction_resolution where issue_id = any($1::uuid[])", [
        issues,
      ]);
      await cleaner.query("delete from canonical_issue where issue_id = any($1::uuid[])", [issues]);
    }
    if (submissions.length > 0) {
      await cleaner.query(
        "delete from jurisdiction_resolution where submission_id = any($1::uuid[])",
        [submissions],
      );
      await cleaner.query("delete from submission where submission_id = any($1::uuid[])", [
        submissions,
      ]);
    }
    if (participants.length > 0) {
      await cleaner.query("delete from participant where participant_id = any($1::uuid[])", [
        participants,
      ]);
    }
    await cleaner.query(
      `delete from responsibility_directory
        where jurisdiction_id in (select jurisdiction_id from jurisdiction where jurisdiction_profile_id = $1)`,
      [PROFILE],
    );
    await cleaner.query("delete from jurisdiction where jurisdiction_profile_id = $1", [PROFILE]);
  } finally {
    await cleaner.end();
  }
});

const resolve = (lon: number, lat: number, accuracyMetres: number | undefined = 5) =>
  resolveJurisdictionAtLocation(client, {
    profileId: PROFILE,
    boundaryVersion: BOUNDARY_VERSION,
    lon,
    lat,
    accuracyMetres,
    observedAt: OBSERVED_AT,
  });

test("V033: a profile seed installs polygons and preserves ids when rerun", async () => {
  const first = await seedJurisdictionProfile(client, profile);
  const second = await seedJurisdictionProfile(client, profile);

  assert.equal(first.inserted, 3);
  assert.equal(second.inserted, 0);
  assert.equal(second.updated, 3);
  assert.deepEqual(second.jurisdictionIdsByCode, first.jurisdictionIdsByCode);
  const { rows } = await client.query(
    `select count(*)::int as n from jurisdiction
      where jurisdiction_profile_id = $1 and boundary is not null and ST_IsValid(boundary::geometry)`,
    [PROFILE],
  );
  assert.equal(rows[0]?.["n"], 3);
});

test("V033: a changed boundary definition requires a new version", async () => {
  const changed = {
    ...profile,
    nodes: profile.nodes.map((node, index) =>
      index === 1 ? { ...node, level_code: "ward" } : node,
    ),
  };

  await assert.rejects(
    () => seedJurisdictionProfile(client, changed),
    /changed without a new boundary version/i,
  );
});

test("V033: a point resolves to the deepest active boundary", async () => {
  const result = await resolve(10.02, 10.04);

  assert.equal(result.outcome, "resolved");
  assert.equal(result.selected?.internalCode, "WEST");
  assert.equal(result.selected?.depth, 1);
  assert.equal(result.boundaryVersion, BOUNDARY_VERSION);
  assert.equal(result.syntheticProvenance, true);
});

test("V033: a shared edge is ambiguous instead of picking the first block", async () => {
  const result = await resolve(10.05, 10.04, 0);

  assert.equal(result.outcome, "ambiguous");
  assert.deepEqual(
    result.candidates.map((candidate) => candidate.internalCode),
    ["EAST", "WEST"],
  );
  assert.equal(result.selected, undefined);
});

test("V033: GPS uncertainty reaching an edge is left for review", async () => {
  const result = await resolve(10.04995, 10.04, 20);

  assert.equal(result.outcome, "boundary_uncertain");
  assert.equal(result.selected, undefined);
  assert.match(result.reason, /accuracy|range|edge/i);
});

test("V033: an outside point gets no invented jurisdiction", async () => {
  const result = await resolve(11, 11, 5);

  assert.equal(result.outcome, "outside_profile");
  assert.equal(result.selected, undefined);
  assert.deepEqual(result.candidates, []);
});

test("V033: a boundary version not active at observation time is not backdated", async () => {
  const result = await resolveJurisdictionAtLocation(client, {
    profileId: PROFILE,
    boundaryVersion: BOUNDARY_VERSION,
    lon: 10.02,
    lat: 10.04,
    accuracyMetres: 5,
    observedAt: "2025-12-31T23:59:59.000Z",
  });

  assert.equal(result.outcome, "no_active_boundaries");
  assert.equal(result.selected, undefined);
});

test("V033: the resolved boundary and directory rule produce one explainable route", async () => {
  const spatial = await resolve(10.02, 10.04);
  assert.equal(spatial.outcome, "resolved");
  const seeded = await seedRoutingDirectoryForProfile(client, {
    profileId: PROFILE,
    boundaryVersion: BOUNDARY_VERSION,
    directory: {
      directoryVersion: ROUTING_VERSION,
      entries: [
        {
          jurisdictionInternalCode: "WEST",
          category: "sanitation",
          departmentId: "demo-west-sanitation",
          departmentLabel: "West Sanitation (simulated)",
          providerMode: "simulated",
        },
      ],
    },
  });
  assert.equal(seeded.inserted, 1);

  const participantId = randomUUID();
  participants.push(participantId);
  await client.query("insert into participant (participant_id) values ($1)", [participantId]);
  const submissionId = randomUUID();
  submissions.push(submissionId);
  await client.query(
    `insert into submission
       (submission_id, participant_id, observed_location, observed_accuracy_m,
        observed_at, interface_locale, locale_pack_version, idempotency_key, taxonomy_version)
     values ($1,$2,ST_SetSRID(ST_MakePoint(10.02,10.04),4326)::geography,5,
             $3,'en-IN','test-locales.v1',$4,'test-taxonomy.v1')`,
    [submissionId, participantId, OBSERVED_AT, `jurisdiction-test-${submissionId}`],
  );
  const issueId = randomUUID();
  issues.push(issueId);
  await client.query(
    `insert into canonical_issue
       (issue_id, public_reference, jurisdiction_id, category, opened_at,
        representative_location, last_evidence_at)
     values ($1,$2,$3,'sanitation',now(),
             ST_SetSRID(ST_MakePoint(10.02,10.04),4326)::geography,now())`,
    [issueId, `VIS-${issueId.slice(0, 8).toUpperCase()}`, spatial.selected?.jurisdictionId],
  );
  const resolutionId = await recordJurisdictionResolution(client, {
    submissionId,
    issueId,
    appliedToIssue: true,
    resolution: spatial,
  });
  const routed = await resolveRouting(client, {
    issueId,
    directoryVersion: ROUTING_VERSION,
    jurisdictionResolutionId: resolutionId,
  });

  assert.equal(routed.outcome, "routed");
  assert.equal(routed.jurisdiction?.internalCode, "WEST");
  assert.equal(routed.jurisdiction?.boundaryVersion, BOUNDARY_VERSION);
  assert.equal(routed.jurisdictionResolutionId, resolutionId);
  assert.equal(routed.isGovernmentAcknowledgment, false);
  assert.match(routed.disclosure, /simulated/i);
});
