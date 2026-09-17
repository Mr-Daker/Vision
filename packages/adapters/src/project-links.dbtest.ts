/**
 * V041 sanctioned-project links against a real database.
 *
 * Run with: npm run db:up && npm run db:migrate && npm run test:db
 *
 * The acceptance clauses this file holds:
 *
 *   * **one defensible link and one ambiguous or absent match** — all three
 *     outcomes are produced from real rows, not from stubbed signals;
 *   * **no match is never translated into a claim about funding** — the
 *     no-match is a *stored row* carrying the register it searched and the
 *     note saying what the finding does not mean, because an absent row is
 *     indistinguishable from "nobody has looked yet";
 *   * confirmed, rejected, ambiguous and unmatched are stored separately, with
 *     the matching method and — for the two that are decisions — a reviewer.
 */

import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

import { absenceOverclaims } from "@vision/domain";
import type { IsoTimestamp, SourceRecordSnapshot, Uuid } from "@vision/contracts";

import {
  ProjectLinkError,
  loadProjectRegister,
  proposeLinksForIssue,
  readIssueProjectView,
  readProjectLinks,
  recordProjectLinkDecision,
  type ProjectToLoad,
} from "./project-links.ts";

const DATABASE_URL =
  process.env["DATABASE_URL"] ??
  "postgresql://vision:vision_local_dev_only@127.0.0.1:5432/vision_dev";

const PROFILE = `v041-profile-${randomUUID().slice(0, 8)}`;
const REGISTER = "v041 synthetic project register";

let client: pg.Client;
let jurisdictionId: string;
let otherJurisdictionId: string;
let assetId: string;
const createdIssues: string[] = [];
const createdProjects: string[] = [];
const createdAssets: string[] = [];
const createdJurisdictions: string[] = [];
const createdSources: string[] = [];

const source = (): SourceRecordSnapshot => {
  const id = randomUUID() as Uuid;
  createdSources.push(String(id));
  return {
    source_record_id: id,
    source_name: REGISTER,
    source_url_or_location: "packages/adapters/src/project-links.dbtest.ts",
    retrieved_at: new Date().toISOString() as IsoTimestamp,
    licence_or_permission_status: "synthetic",
    demo_status: "team_created_synthetic",
  };
};

let registerSource: SourceRecordSnapshot;

const makeJurisdiction = async (code: string): Promise<string> => {
  const id = randomUUID();
  await client.query(
    `insert into jurisdiction
       (jurisdiction_id, jurisdiction_profile_id, internal_code, directory_version,
        level_scheme, level_code, effective_from, synthetic_provenance)
     values ($1,$2,$3,'v041-directory.v1','v041-scheme','block',
             now() - interval '2 years', true)`,
    [id, PROFILE, code],
  );
  createdJurisdictions.push(id);
  return id;
};

const makeAsset = async (lon: number, lat: number): Promise<string> => {
  const id = `v041-asset-${randomUUID().slice(0, 8)}`;
  await client.query(
    `insert into infrastructure_asset
       (asset_id, asset_type, synthetic_provenance, name, location, jurisdiction_id, effective_from)
     values ($1,'school_building',true,'V041 asset (synthetic)',
             st_setsrid(st_makepoint($2,$3),4326)::geography,$4, now() - interval '1 year')`,
    [id, lon, lat, jurisdictionId],
  );
  createdAssets.push(id);
  return id;
};

const makeIssue = async (options: {
  readonly category: string;
  readonly lon?: number;
  readonly lat?: number;
  readonly assetId?: string | null;
  readonly jurisdictionId?: string;
}): Promise<string> => {
  const id = randomUUID();
  await client.query(
    `insert into canonical_issue
       (issue_id, public_reference, category, current_status, opened_at, jurisdiction_id,
        asset_id, representative_location)
     values ($1,$2,$3,'work_planned', now() - interval '30 days', $4, $5,
             case when $6::double precision is null then null
                  else st_setsrid(st_makepoint($6,$7),4326)::geography end)`,
    [
      id,
      `VIS-V041-${id.slice(0, 8)}`,
      options.category,
      options.jurisdictionId ?? jurisdictionId,
      options.assetId ?? null,
      options.lon ?? null,
      options.lat ?? null,
    ],
  );
  createdIssues.push(id);
  return id;
};

const project = (over: Partial<ProjectToLoad> = {}): ProjectToLoad => {
  const projectId = over.projectId ?? `V041-PRJ-${randomUUID().slice(0, 8)}`;
  if (!createdProjects.includes(projectId)) createdProjects.push(projectId);
  return {
    projectName: "V041 works (synthetic)",
    scopeDescription: "Synthetic scope for the V041 tests.",
    scopeTerms: ["water_supply"],
    assetId: null,
    jurisdictionInternalCode: "V041-A",
    longitude: 74.5,
    latitude: 16.8,
    sanctionedAt: "2025-04-01T00:00:00Z",
    completedAt: "2025-11-01T00:00:00Z",
    amount: 500000,
    amountUnit: "inr",
    ...over,
    projectId,
  };
};

const load = (projects: readonly ProjectToLoad[]) =>
  loadProjectRegister(client, {
    projects,
    source: registerSource,
    jurisdictionProfileId: PROFILE,
  });

const propose = (issueId: string) =>
  proposeLinksForIssue(client, {
    issueId,
    registerName: REGISTER,
    registerIsSynthetic: true,
    sourceRecordId: String(registerSource.source_record_id),
    asOf: new Date(),
  });

before(async () => {
  client = new pg.Client({ connectionString: DATABASE_URL, statement_timeout: 60_000 });
  await client.connect();
  jurisdictionId = await makeJurisdiction("V041-A");
  otherJurisdictionId = await makeJurisdiction("V041-B");
  assetId = await makeAsset(74.5, 16.8);
});

const cleanupRun = async (): Promise<void> => {
  if (createdIssues.length > 0) {
    await client.query("delete from project_link where issue_id = any($1::uuid[])", [
      createdIssues,
    ]);
    await client.query("delete from canonical_issue where issue_id = any($1::uuid[])", [
      createdIssues,
    ]);
    createdIssues.length = 0;
  }
  if (createdProjects.length > 0) {
    await client.query("delete from project_link where project_id = any($1::text[])", [
      createdProjects,
    ]);
    await client.query("delete from sanctioned_project where project_id = any($1::text[])", [
      createdProjects,
    ]);
    createdProjects.length = 0;
  }
  registerSource = source();
};

beforeEach(cleanupRun);

after(async () => {
  await cleanupRun();
  if (createdAssets.length > 0) {
    await client.query("delete from sanctioned_project where asset_id = any($1::text[])", [
      createdAssets,
    ]);
    await client.query("delete from infrastructure_asset where asset_id = any($1::text[])", [
      createdAssets,
    ]);
  }
  if (createdJurisdictions.length > 0) {
    await client.query("delete from jurisdiction where jurisdiction_id = any($1::uuid[])", [
      createdJurisdictions,
    ]);
  }
  if (createdSources.length > 0) {
    await client.query("delete from source_record where source_record_id = any($1::uuid[])", [
      createdSources,
    ]);
  }
  await client.end();
});

// ---------------------------------------------------------------------------
// The three outcomes
// ---------------------------------------------------------------------------

test("a project naming the asset produces one defensible proposal, awaiting a person", async () => {
  await load([project({ projectId: "V041-NAMED", assetId, scopeTerms: ["water_supply"] })]);
  const issue = await makeIssue({ category: "water_supply", lon: 74.5, lat: 16.8, assetId });

  const result = await propose(issue);
  assert.equal(result.proposal.outcome, "single_candidate");
  assert.equal(result.written.length, 1);
  assert.equal(result.written[0]?.status, "proposed", "the matcher proposes; it never confirms");

  const links = await readProjectLinks(client, { issueIds: [issue] });
  assert.equal(links.length, 1);
  assert.equal(links[0]?.projectId, "V041-NAMED");
  assert.match(links[0]?.matchMethod ?? "", /asset_identifier/);
  assert.equal(links[0]?.reviewerId, null, "nobody has decided yet");
  assert.equal(links[0]?.decidedAt, null);
  assert.match(links[0]?.reasons.join(" ") ?? "", /identifies the thing itself/);
});

test("two projects naming the same asset are stored as ambiguous, with neither picked", async () => {
  await load([
    project({ projectId: "V041-AMB-A", assetId }),
    project({ projectId: "V041-AMB-B", assetId }),
  ]);
  const issue = await makeIssue({ category: "water_supply", lon: 74.5, lat: 16.8, assetId });

  const result = await propose(issue);
  assert.equal(result.proposal.outcome, "ambiguous");

  const links = await readProjectLinks(client, { issueIds: [issue] });
  assert.equal(links.length, 2);
  for (const link of links) {
    assert.equal(link.status, "ambiguous");
    assert.equal(link.reviewerId, null, "ambiguity is matcher output, not a person's decision");
    assert.equal(link.decidedAt, null);
  }
});

test("no match is a stored finding, not an absent row", async () => {
  await load([
    project({ projectId: "V041-FAR", longitude: 80, latitude: 20, scopeTerms: ["roads"] }),
  ]);
  const issue = await makeIssue({ category: "electrical", lon: 74.5, lat: 16.8 });

  const result = await propose(issue);
  assert.equal(result.proposal.outcome, "no_candidate");

  const links = await readProjectLinks(client, { issueIds: [issue] });
  assert.equal(links.length, 1, "the search was recorded");
  assert.equal(links[0]?.status, "unmatched");
  assert.equal(links[0]?.projectId, null);
  assert.equal(links[0]?.sourceName, REGISTER, "the row names the register that was searched");
  assert.match(links[0]?.absenceNote ?? "", /does not mean no project exists/);
  assert.match(
    links[0]?.absenceNote ?? "",
    /not evidence about whether this asset has been paid for/,
  );

  const view = await readIssueProjectView(client, { issueId: issue });
  assert.equal(view.searched, true, "an absent row would mean nobody has looked yet");
  assert.equal(view.hasConfirmedLink, false);
});

test("a report nobody has searched for is distinguishable from one with no match", async () => {
  const unsearched = await makeIssue({ category: "electrical", lon: 74.5, lat: 16.8 });
  const view = await readIssueProjectView(client, { issueId: unsearched });
  assert.equal(view.searched, false);
  assert.equal(view.links.length, 0);
  assert.match(
    view.absenceNote,
    /not evidence about whether this asset has been paid for/,
    "even the never-searched case renders the caveat rather than a bare blank",
  );
});

test("nothing stored about a link can be read as a claim about funding", async () => {
  await load([
    project({
      projectId: "V041-NEAR",
      longitude: 74.5,
      latitude: 16.8,
      scopeTerms: ["water_supply"],
    }),
  ]);
  const matched = await makeIssue({ category: "water_supply", lon: 74.5, lat: 16.8 });
  const unmatched = await makeIssue({ category: "electrical", lon: 74.5, lat: 16.8 });
  await propose(matched);
  await propose(unmatched);

  const links = await readProjectLinks(client, { issueIds: [matched, unmatched] });
  const everything = links
    .flatMap((link) => [link.absenceNote, ...link.reasons, link.projectName ?? ""])
    .join(" \n ");
  assert.deepEqual(absenceOverclaims(everything), []);
});

// ---------------------------------------------------------------------------
// Weighting, against real rows
// ---------------------------------------------------------------------------

test("a project that is merely nearby produces no proposal", async () => {
  await load([project({ projectId: "V041-NEARBY", scopeTerms: ["roads"] })]);
  const issue = await makeIssue({ category: "water_supply", lon: 74.5, lat: 16.8 });
  const result = await propose(issue);
  assert.equal(
    result.proposal.outcome,
    "no_candidate",
    "a sanctioned road at the same point is not this water report's funding",
  );
});

test("a project in another jurisdiction is not a candidate unless it names the asset", async () => {
  await load([project({ projectId: "V041-ELSEWHERE", jurisdictionInternalCode: "V041-B" })]);
  const issue = await makeIssue({ category: "water_supply", lon: 74.5, lat: 16.8 });
  assert.equal((await propose(issue)).proposal.outcome, "no_candidate");
  assert.ok(otherJurisdictionId.length > 0);
});

test("re-running the matcher replaces its own output and leaves decisions alone", async () => {
  await load([project({ projectId: "V041-STANDS", assetId })]);
  const issue = await makeIssue({ category: "water_supply", lon: 74.5, lat: 16.8, assetId });
  await propose(issue);

  const [proposed] = await readProjectLinks(client, { issueIds: [issue] });
  assert.notEqual(proposed, undefined);
  await recordProjectLinkDecision(client, {
    projectLinkId: proposed?.projectLinkId ?? "",
    decision: "confirmed",
    reviewerId: randomUUID(),
    reason: "the school building is the one named in the project",
    asOf: new Date(),
  });

  await propose(issue);
  const links = await readProjectLinks(client, { issueIds: [issue] });
  assert.equal(links.length, 1, "the matcher did not re-propose what a person already settled");
  assert.equal(links[0]?.status, "confirmed");
});

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

test("a decision requires a reason somebody can read later", async () => {
  await load([project({ projectId: "V041-REASON", assetId })]);
  const issue = await makeIssue({ category: "water_supply", lon: 74.5, lat: 16.8, assetId });
  await propose(issue);
  const [link] = await readProjectLinks(client, { issueIds: [issue] });

  await assert.rejects(
    () =>
      recordProjectLinkDecision(client, {
        projectLinkId: link?.projectLinkId ?? "",
        decision: "confirmed",
        reviewerId: randomUUID(),
        reason: "yes",
        asOf: new Date(),
      }),
    (error: unknown) => error instanceof ProjectLinkError,
  );
});

test("a rejection is kept on the record rather than deleted", async () => {
  await load([project({ projectId: "V041-REJECT", assetId })]);
  const issue = await makeIssue({ category: "water_supply", lon: 74.5, lat: 16.8, assetId });
  await propose(issue);
  const [link] = await readProjectLinks(client, { issueIds: [issue] });
  const reviewerId = randomUUID();

  await recordProjectLinkDecision(client, {
    projectLinkId: link?.projectLinkId ?? "",
    decision: "rejected",
    reviewerId,
    reason: "the project covers the other building on the same compound",
    asOf: new Date(),
  });

  const after = await readProjectLinks(client, { issueIds: [issue] });
  assert.equal(after.length, 1, "somebody looked and said no; that is a finding, not a deletion");
  assert.equal(after[0]?.status, "rejected");
  assert.equal(after[0]?.reviewerId, reviewerId);
  assert.notEqual(after[0]?.decidedAt, null);
});

test("a link already decided cannot be decided again", async () => {
  await load([project({ projectId: "V041-TWICE", assetId })]);
  const issue = await makeIssue({ category: "water_supply", lon: 74.5, lat: 16.8, assetId });
  await propose(issue);
  const [link] = await readProjectLinks(client, { issueIds: [issue] });
  const decision = {
    projectLinkId: link?.projectLinkId ?? "",
    reviewerId: randomUUID(),
    reason: "this is the project that covers this building",
    asOf: new Date(),
  };
  await recordProjectLinkDecision(client, { ...decision, decision: "confirmed" });
  await assert.rejects(
    () => recordProjectLinkDecision(client, { ...decision, decision: "rejected" }),
    (error: unknown) =>
      error instanceof ProjectLinkError && /not awaiting a decision/.test(error.message),
  );
});

test("the database refuses a confirmed link with no reviewer against it", async () => {
  await load([project({ projectId: "V041-ANON", assetId })]);
  const issue = await makeIssue({ category: "water_supply", lon: 74.5, lat: 16.8, assetId });
  await propose(issue);
  const [link] = await readProjectLinks(client, { issueIds: [issue] });

  await assert.rejects(
    () =>
      client.query(
        "update project_link set match_status = 'confirmed', decided_at = now() where project_link_id = $1",
        [link?.projectLinkId ?? ""],
      ),
    /project_link_reviewer_required_ck/,
    "an anonymous assertion about public money is what this constraint prevents",
  );
});

test("the database refuses an unmatched row that names a project", async () => {
  await load([project({ projectId: "V041-SHAPE", assetId })]);
  const issue = await makeIssue({ category: "water_supply", lon: 74.5, lat: 16.8, assetId });
  await propose(issue);
  const [link] = await readProjectLinks(client, { issueIds: [issue] });

  await assert.rejects(
    () =>
      client.query(
        "update project_link set match_status = 'unmatched' where project_link_id = $1",
        [link?.projectLinkId ?? ""],
      ),
    /project_link_project_presence_ck/,
  );
});

// ---------------------------------------------------------------------------
// Loading the register
// ---------------------------------------------------------------------------

test("a project naming an asset that does not exist is skipped and reported", async () => {
  const result = await load([
    project({ projectId: "V041-GHOST", assetId: "v041-no-such-asset" }),
    project({ projectId: "V041-FINE", assetId }),
  ]);
  assert.equal(result.loaded, 1);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0]?.projectId, "V041-GHOST");
  assert.match(result.skipped[0]?.reason ?? "", /pinned to the wrong asset is worse/);
});

test("a project in an unknown jurisdiction is skipped rather than placed in the nearest one", async () => {
  const result = await load([
    project({ projectId: "V041-NOWHERE", jurisdictionInternalCode: "V041-ZZZ" }),
  ]);
  assert.equal(result.loaded, 0);
  assert.equal(result.skipped[0]?.reason.includes("rather than placed in the nearest one"), true);
});

test("a register that may not be ingested is refused before any project is written", async () => {
  const forbidden: SourceRecordSnapshot = {
    ...source(),
    licence_or_permission_status: "reference_only",
    demo_status: "unavailable_not_approved",
  };
  await assert.rejects(
    () =>
      loadProjectRegister(client, {
        projects: [project({ projectId: "V041-FORBIDDEN" })],
        source: forbidden,
        jurisdictionProfileId: PROFILE,
      }),
    /V004/,
  );
  const { rows } = await client.query(
    "select count(*)::int as n from sanctioned_project where project_id = 'V041-FORBIDDEN'",
  );
  assert.equal(rows[0]?.["n"], 0);
});
