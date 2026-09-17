/**
 * District dashboard over HTTP (roadmap V039).
 *
 * Run with: npm run db:up && npm run db:migrate && npm run test:db
 *
 * The read model is covered by `dashboard.dbtest.ts`. What only becomes true
 * over HTTP is held here: the surface is read-only, the jurisdiction scope
 * comes from a durable grant rather than from the request, a cell key edited
 * in the browser cannot reach a ward the session has no grant for, and no
 * response on this surface carries a private original's reference.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";

import { FilesystemObjectStoreAdapter, rebuildSummaries } from "@vision/adapters";

import { buildAppWithDatabase } from "./server.ts";

const DATABASE_URL =
  process.env["DATABASE_URL"] ??
  "postgresql://vision:vision_local_dev_only@127.0.0.1:5432/vision_dev";

const PROFILE = "demo-district-a";
/** Configured in the shipped taxonomy pack, so the dashboard tracks it. */
const TRACKED_CATEGORY = "water_supply";

const TEST_ENV = {
  IDENTITY_PROVIDER_MODE: "simulated",
  RECIPIENT_PROVIDER_MODE: "simulated",
  IDENTITY_MAPPING_HMAC_KEY: `dashboard-identity-${randomUUID()}`,
  SESSION_TOKEN_HMAC_KEY: `dashboard-session-${randomUUID()}`,
  SESSION_TTL_SECONDS: "3600",
  SESSION_COOKIE_SECURE: "false",
  SUPPORTED_LOCALES: "en-IN,mr-IN",
  JURISDICTION_PROFILE_ID: PROFILE,
} as const;

let client: pg.Client;
let server: Server;
let baseUrl: string;
let storeRoot: string;
let jurisdictionId: string;
let outsideJurisdictionId: string;
let issueReference: string;
const issues: string[] = [];
const participants: string[] = [];
const staffAccounts: string[] = [];
const submissions: string[] = [];
const evidence: string[] = [];

before(async () => {
  client = new pg.Client({ connectionString: DATABASE_URL, statement_timeout: 60_000 });
  await client.connect();

  const { rows } = await client.query(
    `select jurisdiction_id from jurisdiction
      where jurisdiction_profile_id = $1 and internal_code = 'DDA-B1' limit 1`,
    [PROFILE],
  );
  assert.notEqual(rows[0], undefined, "run `npm run db:seed` before the dashboard HTTP tests");
  jurisdictionId = String(rows[0]?.["jurisdiction_id"]);

  // A ward outside the profile, so no supervisor grant from this profile
  // covers it. This is what a cell key edited in the browser would name.
  outsideJurisdictionId = randomUUID();
  await client.query(
    `insert into jurisdiction
       (jurisdiction_id, jurisdiction_profile_id, internal_code, directory_version,
        level_scheme, level_code, effective_from, synthetic_provenance)
     values ($1,'v039-http-profile',$2,'v039-http.v1','v039-scheme','block',
             now() - interval '1 year', true)`,
    [outsideJurisdictionId, `V39H-${outsideJurisdictionId.slice(0, 8)}`],
  );

  // One report inside the authorized ward, with one approved redacted copy
  // and one original that must never leave the server.
  const issueId = randomUUID();
  issueReference = `VIS-V039H-${issueId.slice(0, 8)}`;
  await client.query(
    `insert into canonical_issue
       (issue_id, public_reference, category, current_status, opened_at, jurisdiction_id)
     values ($1,$2,$3,'work_planned', now() - interval '12 days', $4)`,
    [issueId, issueReference, TRACKED_CATEGORY, jurisdictionId],
  );
  issues.push(issueId);

  const participantId = randomUUID();
  await client.query("insert into participant (participant_id) values ($1)", [participantId]);
  participants.push(participantId);
  const submissionId = randomUUID();
  await client.query(
    `insert into submission
       (submission_id, participant_id, observed_at, interface_locale, locale_pack_version,
        idempotency_key, taxonomy_version, processing_status)
     values ($1,$2, now() - interval '12 days','en-IN','v039-locale.v1',$3,'v039-taxonomy.v1','accepted')`,
    [submissionId, participantId, `v039h-${submissionId.slice(0, 8)}`],
  );
  submissions.push(submissionId);
  const evidenceId = randomUUID();
  await client.query(
    `insert into evidence_item
       (evidence_id, submission_id, media_type, object_reference, fingerprint_hash,
        redaction_status, derivative_reference, processing_status)
     values ($1,$2,'photo',$3,$4,'approved',$5,'usable')`,
    [
      evidenceId,
      submissionId,
      "originals/v039-http/private-original.bin",
      `sha256:${evidenceId.replace(/-/g, "")}`,
      "derivatives/v039-http/redacted.png",
    ],
  );
  evidence.push(evidenceId);
  await client.query(
    `insert into issue_evidence_link
       (issue_evidence_link_id, evidence_id, canonical_issue_id, effective_from)
     values ($1,$2,$3, now() - interval '12 days')`,
    [randomUUID(), evidenceId, issueId],
  );

  await rebuildSummaries(client, { asOf: new Date() });

  storeRoot = await mkdtemp(join(tmpdir(), "vision-dashboard-http-"));
  const objectStore = new FilesystemObjectStoreAdapter({
    root: storeRoot,
    grantHmacKey: "dashboard-http-object-key",
  });
  const { handler } = buildAppWithDatabase(client, objectStore, TEST_ENV);
  server = createServer((request, response) => void handler(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await client.end().catch(() => undefined);
  const cleaner = new pg.Client({ connectionString: DATABASE_URL, statement_timeout: 30_000 });
  await cleaner.connect();
  try {
    if (issues.length > 0) {
      await cleaner.query(
        "delete from summary_issue_fact where issue_id = any($1::uuid[]) or root_issue_id = any($1::uuid[])",
        [issues],
      );
      await cleaner.query(
        "delete from issue_evidence_link where canonical_issue_id = any($1::uuid[])",
        [issues],
      );
      await cleaner.query("delete from canonical_issue where issue_id = any($1::uuid[])", [issues]);
    }
    if (evidence.length > 0) {
      await cleaner.query("delete from evidence_item where evidence_id = any($1::uuid[])", [
        evidence,
      ]);
    }
    if (submissions.length > 0) {
      await cleaner.query("delete from submission where submission_id = any($1::uuid[])", [
        submissions,
      ]);
    }
    if (staffAccounts.length > 0) {
      await cleaner.query("delete from staff_jurisdiction_grant where staff_id = any($1::uuid[])", [
        staffAccounts,
      ]);
      await cleaner.query("delete from staff_account where staff_id = any($1::uuid[])", [
        staffAccounts,
      ]);
    }
    if (participants.length > 0) {
      await cleaner.query("delete from app_session where participant_id = any($1::uuid[])", [
        participants,
      ]);
      await cleaner.query("delete from identity_mapping where participant_id = any($1::uuid[])", [
        participants,
      ]);
      await cleaner.query("delete from participant where participant_id = any($1::uuid[])", [
        participants,
      ]);
    }
    await cleaner.query("delete from jurisdiction where jurisdiction_id = $1", [
      outsideJurisdictionId,
    ]);
  } finally {
    await cleaner.end();
    await rm(storeRoot, { recursive: true, force: true });
  }
});

const cookieJar = (response: Response): string =>
  response.headers
    .getSetCookie()
    .map((header) => header.split(";")[0])
    .join("; ");

let supervisorCookies = "";
let supervisorStaffId = "";

const loginSupervisor = async (): Promise<string> => {
  const response = await fetch(`${baseUrl}/v1/supervisor/auth/demo-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential: "demo-supervisor-one" }),
  });
  assert.equal(response.status, 200, await response.text());
  const { rows } = await client.query(
    `select staff_id, participant_id from staff_account
      where role = 'supervisor' and provider_mode = 'simulated'
      order by created_at desc limit 1`,
  );
  if (rows[0] !== undefined) {
    supervisorStaffId = String(rows[0]["staff_id"]);
    staffAccounts.push(supervisorStaffId);
    participants.push(String(rows[0]["participant_id"]));
  }
  return cookieJar(response);
};

const get = (path: string, cookies = supervisorCookies): Promise<Response> =>
  fetch(`${baseUrl}${path}`, { headers: cookies.length === 0 ? {} : { cookie: cookies } });

// ---------------------------------------------------------------------------
// The surface
// ---------------------------------------------------------------------------

test("the dashboard refuses a request with no session", async () => {
  const response = await get("/v1/dashboard/overview", "");
  assert.equal(response.status, 401);
  const body = (await response.json()) as { error: { code: string } };
  assert.equal(body.error.code, "unauthenticated");
});

test("every method except GET is refused before a session is even looked up", async () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const response = await fetch(`${baseUrl}/v1/dashboard/overview`, { method });
    assert.equal(response.status, 400, `${method} must not be accepted`);
    const body = (await response.json()) as { error: { message: string } };
    assert.match(body.error.message, /read-only/);
  }
});

test("an unknown dashboard endpoint answers with JSON rather than a page", async () => {
  supervisorCookies = await loginSupervisor();
  const response = await get("/v1/dashboard/nothing-here");
  assert.equal(response.status, 404);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/);
});

test("the overview carries its totals, its population, and what it does not mean", async () => {
  const response = await get("/v1/dashboard/overview");
  // Read once: consuming the body for an assertion message and then parsing it
  // again is an error the runtime reports as a test failure of its own.
  const text = await response.text();
  assert.equal(response.status, 200, text);
  const body = JSON.parse(text) as {
    reconciliation: { reconciles: boolean; definition: string; sourcePopulation: number };
    cells: readonly { jurisdictionKey: string; coverage: string; issueCount: number }[];
    metrics: readonly { id: string; definition: { disclosures: readonly string[] } }[];
    summary: { freshness: { state: string } };
    note: string;
    notAdditive: readonly string[];
  };

  assert.match(body.reconciliation.definition, /Active canonical roots/);
  assert.ok(body.cells.length > 0);
  assert.ok(body.metrics.length >= 3, "backlog age, fixed-window closure and reopening");
  assert.ok(
    body.metrics.every((metric) => metric.definition.disclosures !== undefined),
    "every measure travels with its definition",
  );
  assert.match(body.note, /does not measure how many problems exist/);
  assert.ok(body.notAdditive.length >= 2);
  assert.ok(["fresh", "lagging", "never_built"].includes(body.summary.freshness.state));

  const mine = body.cells.find(
    (cell) => cell.jurisdictionKey === jurisdictionId && cell.issueCount > 0,
  );
  assert.notEqual(mine, undefined, "the authorized ward is present with its reports");
});

test("every context figure in the payload arrives with its lineage attached", async () => {
  const response = await get("/v1/dashboard/overview");
  const text = await response.text();
  assert.equal(response.status, 200, text);
  const body = JSON.parse(text) as {
    context: readonly {
      readonly lineage: string;
      readonly sourceName: string;
      readonly synthetic: boolean;
      readonly value: number | null;
      readonly missingIndicator: string | null;
    }[];
    contextImports: readonly { readonly rowsRejected: number }[];
  };

  assert.ok(
    body.context.length > 0,
    "run `npm run context:import` before the dashboard HTTP tests",
  );
  for (const value of body.context) {
    // The V040 clause, asserted on the bytes that went over the wire: a figure
    // without a source or a lineage sentence cannot reach a screen, because it
    // never reaches the payload.
    assert.ok(value.sourceName.trim().length > 0, "a context value with no source");
    assert.ok(value.lineage.trim().length > 20, "a context value with no lineage");
    if (value.synthetic) {
      assert.match(
        value.lineage,
        /Invented for this demonstration/,
        "synthetic data must say so beside the number, not in a page footer",
      );
    }
    if (value.value === null) {
      assert.notEqual(value.missingIndicator, null, "an absence must carry the source's own words");
    }
  }
  assert.ok(body.contextImports.length > 0, "what the last import refused is part of the payload");
});

test("the comparison carries its policy version, its assumptions and its caveats", async () => {
  const response = await get("/v1/dashboard/comparison?detail=4");
  const text = await response.text();
  assert.equal(response.status, 200, text);
  const body = JSON.parse(text) as {
    policyVersion: string;
    weightingIds: readonly string[];
    candidates: readonly {
      label: string;
      placement: { bestRank: number | null; worstRank: number | null; stability: string };
      projects: readonly { attributionNote: string }[];
      projectRegisterUnsearched: boolean;
    }[];
    assumptions: readonly { support: string; statement: string; detail: string }[];
    disclosures: readonly string[];
  };

  assert.ok(
    body.policyVersion.length > 0,
    "a comparison that does not name its policy is unreadable",
  );
  assert.ok(body.weightingIds.length >= 2, "positions are intervals, so there must be several");
  assert.ok(body.candidates.length > 0);

  for (const candidate of body.candidates) {
    // Every position is an interval; a single number would be one weighting's
    // answer presented as the answer.
    assert.notEqual(candidate.placement.bestRank, undefined);
    assert.notEqual(candidate.placement.worstRank, undefined);
    for (const project of candidate.projects) {
      assert.match(
        project.attributionNote,
        /coincidence in time|not evidence either way/,
        "recorded outcomes must arrive with what they do not prove",
      );
    }
  }

  // The V043 clause about identifying unsupported assumptions: some of these
  // have to be labelled as choices, or the list is not an assumptions list.
  assert.ok(body.assumptions.some((assumption) => assumption.support === "asserted"));
  assert.ok(body.assumptions.some((assumption) => assumption.support === "absent"));
  assert.match(body.assumptions.map((a) => a.statement).join(" "), /how serious or dangerous/);
  assert.match(
    body.disclosures.join(" "),
    /not a statement about how public money should be spent/,
  );
});

test("the scope comes from the grant: a ward outside it is refused, not returned empty", async () => {
  const response = await get(
    `/v1/dashboard/cells/${encodeURIComponent(outsideJurisdictionId)}/${TRACKED_CATEGORY}/issues`,
  );
  assert.equal(response.status, 403);
  const body = (await response.json()) as { error: { message: string } };
  assert.match(body.error.message, /no grant/);
});

test("the unplaced bucket is counted but its records cannot be opened", async () => {
  const response = await get(`/v1/dashboard/cells/UNKNOWN/${TRACKED_CATEGORY}/issues`);
  assert.equal(response.status, 403);
  const body = (await response.json()) as { error: { message: string } };
  assert.match(body.error.message, /not been placed in a ward/);
});

test("a figure leads to its records, and a record leads to its redacted evidence", async () => {
  const cellResponse = await get(
    `/v1/dashboard/cells/${encodeURIComponent(jurisdictionId)}/${TRACKED_CATEGORY}/issues`,
  );
  const cellText = await cellResponse.text();
  assert.equal(cellResponse.status, 200, cellText);
  const cellBody = JSON.parse(cellText) as {
    issues: readonly { publicReference: string }[];
  };
  assert.ok(
    cellBody.issues.some((row) => row.publicReference === issueReference),
    "the report behind the figure is reachable from it",
  );

  const issueResponse = await get(`/v1/dashboard/issues/${encodeURIComponent(issueReference)}`);
  const raw = await issueResponse.text();
  assert.equal(issueResponse.status, 200, raw);
  const detail = JSON.parse(raw) as {
    evidence: readonly { availability: string; derivativeReference: string | null }[];
    evidenceNote: string;
  };

  assert.equal(detail.evidence.length, 1);
  assert.equal(detail.evidence[0]?.availability, "approved_derivative");
  assert.equal(detail.evidence[0]?.derivativeReference, "derivatives/v039-http/redacted.png");
  assert.match(detail.evidenceNote, /Redacted copies only/);

  // The boundary, asserted on the bytes that actually went over the wire.
  assert.doesNotMatch(raw, /originals\//, "a private original reference left the server");
  assert.doesNotMatch(raw, /object_reference/i);
  assert.doesNotMatch(raw, /private-original/);
});

test("a report in a ward outside the grant cannot be opened by reference", async () => {
  const strayId = randomUUID();
  const strayReference = `VIS-V039S-${strayId.slice(0, 8)}`;
  await client.query(
    `insert into canonical_issue
       (issue_id, public_reference, category, current_status, opened_at, jurisdiction_id)
     values ($1,$2,$3,'created', now() - interval '3 days', $4)`,
    [strayId, strayReference, TRACKED_CATEGORY, outsideJurisdictionId],
  );
  issues.push(strayId);

  const response = await get(`/v1/dashboard/issues/${encodeURIComponent(strayReference)}`);
  assert.equal(response.status, 403);
  const body = (await response.json()) as { error: { message: string } };
  assert.match(body.error.message, /no grant/);
});

test("a session whose grant is no longer supervisor loses the dashboard", async () => {
  assert.notEqual(supervisorStaffId, "", "the supervisor account was resolved");
  await client.query("update staff_account set role = 'department_staff' where staff_id = $1", [
    supervisorStaffId,
  ]);
  try {
    const response = await get("/v1/dashboard/overview");
    assert.equal(response.status, 403);
    const body = (await response.json()) as { error: { message: string } };
    assert.match(body.error.message, /supervisor grant/);
  } finally {
    await client.query("update staff_account set role = 'supervisor' where staff_id = $1", [
      supervisorStaffId,
    ]);
  }
});
