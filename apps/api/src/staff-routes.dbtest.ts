/** Authenticated department staff HTTP workflow (roadmap V034). */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";

import { FilesystemObjectStoreAdapter } from "@vision/adapters";

import { buildAppWithDatabase } from "./server.ts";

const DATABASE_URL =
  process.env["DATABASE_URL"] ??
  "postgresql://vision:vision_local_dev_only@127.0.0.1:5432/vision_dev";
const PROFILE = "demo-district-a";
const JURISDICTION = randomUUID();
const OUTSIDE_JURISDICTION = randomUUID();
const CODE = `STAFF-${JURISDICTION.slice(0, 8)}`;
const OUTSIDE_CODE = `OUT-${OUTSIDE_JURISDICTION.slice(0, 8)}`;
const DEPARTMENT = `staff-dept-${randomUUID().slice(0, 8)}`;
const OTHER_DEPARTMENT = `other-dept-${randomUUID().slice(0, 8)}`;
const DIRECTORY = "staff-http-directory.v1";
const TEST_ENV = {
  IDENTITY_PROVIDER_MODE: "simulated",
  RECIPIENT_PROVIDER_MODE: "simulated",
  IDENTITY_MAPPING_HMAC_KEY: `staff-identity-${randomUUID()}`,
  SESSION_TOKEN_HMAC_KEY: `staff-session-${randomUUID()}`,
  SESSION_TTL_SECONDS: "3600",
  SESSION_COOKIE_SECURE: "false",
  SUPPORTED_LOCALES: "en-IN,mr-IN",
  JURISDICTION_PROFILE_ID: PROFILE,
  STAFF_RESPONSIBILITIES: `${CODE}:${DEPARTMENT}`,
} as const;

let client: pg.Client;
let server: Server;
let baseUrl: string;
let storeRoot: string;
let staffId: string | undefined;
let staffParticipantId: string | undefined;
const issues: string[] = [];
const responsibilities: string[] = [];

before(async () => {
  client = new pg.Client({ connectionString: DATABASE_URL, statement_timeout: 15_000 });
  await client.connect();
  await client.query(
    `insert into jurisdiction
       (jurisdiction_id, jurisdiction_profile_id, internal_code, directory_version,
        level_scheme, level_code, effective_from, synthetic_provenance)
     values ($1,$2,$3,$4,'staff-http-scheme','block',now() - interval '1 day',true),
            ($5,$2,$6,$4,'staff-http-scheme','block',now() - interval '1 day',true)`,
    [JURISDICTION, PROFILE, CODE, DIRECTORY, OUTSIDE_JURISDICTION, OUTSIDE_CODE],
  );
  const responsibilityId = randomUUID();
  responsibilities.push(responsibilityId);
  await client.query(
    `insert into responsibility_directory
       (responsibility_id, directory_version, jurisdiction_id, category,
        department_id, department_label, provider_mode, effective_from)
     values ($1,$2,$3,'staff-login-seed',$4,'Demo Operations (simulated)',
             'simulated',now() - interval '1 day')`,
    [responsibilityId, DIRECTORY, JURISDICTION, DEPARTMENT],
  );
  storeRoot = await mkdtemp(join(tmpdir(), "vision-staff-http-"));
  const objectStore = new FilesystemObjectStoreAdapter({
    root: storeRoot,
    grantHmacKey: "staff-http-object-key",
  });
  const { handler } = buildAppWithDatabase(client, objectStore, TEST_ENV);
  server = createServer((request, response) => void handler(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await client.end().catch(() => undefined);
  const cleaner = new pg.Client({ connectionString: DATABASE_URL, statement_timeout: 15_000 });
  await cleaner.connect();
  try {
    if (issues.length > 0) {
      await cleaner.query("delete from acknowledgment where issue_id = any($1::uuid[])", [issues]);
      await cleaner.query("delete from assignment where issue_id = any($1::uuid[])", [issues]);
      await cleaner.query("delete from routing_decision where issue_id = any($1::uuid[])", [
        issues,
      ]);
      await cleaner.query("delete from canonical_issue where issue_id = any($1::uuid[])", [issues]);
    }
    if (staffId !== undefined) {
      await cleaner.query("delete from staff_department_grant where staff_id = $1", [staffId]);
      await cleaner.query("delete from staff_jurisdiction_grant where staff_id = $1", [staffId]);
      await cleaner.query("delete from staff_account where staff_id = $1", [staffId]);
    }
    if (staffParticipantId !== undefined) {
      await cleaner.query("delete from app_session where participant_id = $1", [
        staffParticipantId,
      ]);
      await cleaner.query("delete from identity_mapping where participant_id = $1", [
        staffParticipantId,
      ]);
      await cleaner.query("delete from participant where participant_id = $1", [
        staffParticipantId,
      ]);
    }
    await cleaner.query(
      "delete from responsibility_directory where responsibility_id = any($1::uuid[])",
      [responsibilities],
    );
    await cleaner.query("delete from jurisdiction where jurisdiction_id = any($1::uuid[])", [
      [JURISDICTION, OUTSIDE_JURISDICTION],
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

const cookieValue = (response: Response, name: string): string => {
  const pair = response.headers
    .getSetCookie()
    .map((header) => header.split(";")[0] ?? "")
    .find((candidate) => candidate.startsWith(`${name}=`));
  return decodeURIComponent((pair ?? "").slice(name.length + 1));
};

const loginStaff = async () => {
  const response = await fetch(`${baseUrl}/v1/staff/auth/demo-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential: "demo-staff-one" }),
  });
  const stored = await client.query(
    `select staff_id, participant_id from staff_account
      where role = 'department_staff' and provider_mode = 'simulated'
      order by created_at desc limit 1`,
  );
  staffId = String(stored.rows[0]?.["staff_id"] ?? "");
  staffParticipantId = String(stored.rows[0]?.["participant_id"] ?? "");
  return {
    response,
    cookies: cookieJar(response),
    csrf: cookieValue(response, "vision_staff_csrf"),
  };
};

const routedIssue = async (departmentId = DEPARTMENT): Promise<string> => {
  const issueId = randomUUID();
  const category = `staff-${randomUUID().slice(0, 8)}`;
  const responsibilityId = randomUUID();
  responsibilities.push(responsibilityId);
  await client.query(
    `insert into responsibility_directory
       (responsibility_id, directory_version, jurisdiction_id, category,
        department_id, department_label, provider_mode, effective_from)
     values ($1,$2,$3,$4,$5,$6,'simulated',now() - interval '1 day')`,
    [
      responsibilityId,
      DIRECTORY,
      JURISDICTION,
      category,
      departmentId,
      `${departmentId} (simulated)`,
    ],
  );
  await client.query(
    `insert into canonical_issue
       (issue_id, public_reference, category, current_status, opened_at,
        representative_location, last_evidence_at, jurisdiction_id)
     values ($1,$2,$3,'routed_internal',now() - interval '3 days',
             ST_SetSRID(ST_MakePoint(74.55,16.85),4326)::geography,now(),$4)`,
    [issueId, `VIS-${issueId.slice(0, 8).toUpperCase()}`, category, JURISDICTION],
  );
  issues.push(issueId);
  await client.query(
    `insert into routing_decision
       (routing_id, issue_id, directory_version, category, jurisdiction_id,
        responsibility_id, department_id, department_label, recipient_mode, outcome, reason)
     values ($1,$2,$3,$4,$5,$6,$7,$8,'simulated','routed','staff HTTP test route')`,
    [
      randomUUID(),
      issueId,
      DIRECTORY,
      category,
      JURISDICTION,
      responsibilityId,
      departmentId,
      `${departmentId} (simulated)`,
    ],
  );
  return issueId;
};

const actionRequest = async (
  issueId: string,
  login: Awaited<ReturnType<typeof loginStaff>>,
  action: "accept_internal" | "assign_to_self" | "simulate_recipient_acknowledgment",
  overrides: Record<string, unknown> = {},
) =>
  fetch(`${baseUrl}/v1/staff/issues/${issueId}/actions`, {
    method: "POST",
    headers: {
      cookie: login.cookies,
      "content-type": "application/json",
      "x-csrf-token": login.csrf,
    },
    body: JSON.stringify({
      action,
      jurisdiction_id: JURISDICTION,
      department_id: DEPARTMENT,
      note: "Recorded after checking the routed issue details.",
      ...overrides,
    }),
  });

test("V034: the staff capability exposes only the simulated staff fixture", async () => {
  const response = await fetch(`${baseUrl}/v1/staff/capabilities`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    identity_label: string;
    demo_principals: { credential: string }[];
  };
  assert.match(body.identity_label, /simulated/i);
  assert.deepEqual(
    body.demo_principals.map((principal) => principal.credential),
    ["demo-staff-one"],
  );

  const citizen = await fetch(`${baseUrl}/v1/staff/auth/demo-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential: "demo-citizen-one" }),
  });
  assert.equal(citizen.status, 401);
});

test("V034: login creates a separate session and exact responsibility grant", async () => {
  const login = await loginStaff();
  assert.equal(login.response.status, 200);
  assert.ok(login.cookies.includes("vision_staff_session="));
  assert.ok(login.csrf.length > 0);
  const body = (await login.response.json()) as Record<string, unknown>;
  assert.equal(body["role"], "department_staff");
  assert.equal(body["staff_id"], undefined);
  assert.equal(body["participant_id"], undefined);
  const workspaces = body["workspaces"] as Record<string, unknown>[];
  assert.ok(
    workspaces.some(
      (workspace) =>
        workspace["jurisdiction_id"] === JURISDICTION && workspace["department_id"] === DEPARTMENT,
    ),
  );

  const grants = await client.query(
    `select jurisdiction_id, department_id from staff_department_grant
      where staff_id = $1 and revoked_at is null`,
    [staffId],
  );
  assert.deepEqual(grants.rows, [{ jurisdiction_id: JURISDICTION, department_id: DEPARTMENT }]);
});

test("V034: staff sign-out requires CSRF and revokes the separate session", async () => {
  const login = await loginStaff();
  const missingCsrf = await fetch(`${baseUrl}/v1/staff/auth/logout`, {
    method: "POST",
    headers: { cookie: login.cookies },
  });
  assert.equal(missingCsrf.status, 403);

  const logout = await fetch(`${baseUrl}/v1/staff/auth/logout`, {
    method: "POST",
    headers: { cookie: login.cookies, "x-csrf-token": login.csrf },
  });
  assert.equal(logout.status, 200);
  assert.ok(logout.headers.getSetCookie().every((value) => /Max-Age=0/.test(value)));

  const staleSession = await fetch(`${baseUrl}/v1/staff/auth/session`, {
    headers: { cookie: login.cookies },
  });
  assert.equal(staleSession.status, 401);
});

test("V034: the inbox requires staff and enforces the department pair", async () => {
  const unauthenticated = await fetch(
    `${baseUrl}/v1/staff/inbox?jurisdiction_id=${JURISDICTION}&department_id=${DEPARTMENT}`,
  );
  assert.equal(unauthenticated.status, 401);

  const login = await loginStaff();
  const wrongDepartment = await fetch(
    `${baseUrl}/v1/staff/inbox?jurisdiction_id=${JURISDICTION}&department_id=${OTHER_DEPARTMENT}`,
    { headers: { cookie: login.cookies } },
  );
  assert.equal(wrongDepartment.status, 403);

  const outsideJurisdiction = await fetch(
    `${baseUrl}/v1/staff/inbox?jurisdiction_id=${OUTSIDE_JURISDICTION}&department_id=${DEPARTMENT}`,
    { headers: { cookie: login.cookies } },
  );
  assert.equal(outsideJurisdiction.status, 403);
});

test("V034: the inbox exposes evidence counts and configured ordering without urgency", async () => {
  const issueId = await routedIssue();
  const login = await loginStaff();
  const response = await fetch(
    `${baseUrl}/v1/staff/inbox?jurisdiction_id=${JURISDICTION}&department_id=${DEPARTMENT}`,
    { headers: { cookie: login.cookies } },
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    ordering_note: string;
    items: Record<string, unknown>[];
  };
  const item = body.items.find((candidate) => candidate["issue_id"] === issueId);
  assert.notEqual(item, undefined);
  assert.equal(item?.["evidence_count"], 0);
  assert.equal(item?.["internally_accepted"], false);
  assert.equal(item?.["recipient_acknowledged"], false);
  assert.ok(Array.isArray(item?.["ordering_basis"]));
  assert.match(body.ordering_note, /not a severity, risk or urgency/i);
  assert.equal("urgency" in (item ?? {}), false);
  assert.equal("severity" in (item ?? {}), false);
});

test("V034: internal acceptance and assignment require CSRF and retain actors", async () => {
  const issueId = await routedIssue();
  const login = await loginStaff();
  const withoutCsrf = await fetch(`${baseUrl}/v1/staff/issues/${issueId}/actions`, {
    method: "POST",
    headers: { cookie: login.cookies, "content-type": "application/json" },
    body: JSON.stringify({
      action: "accept_internal",
      jurisdiction_id: JURISDICTION,
      department_id: DEPARTMENT,
      note: "A sufficiently specific note.",
    }),
  });
  assert.equal(withoutCsrf.status, 403);

  assert.equal((await actionRequest(issueId, login, "accept_internal")).status, 200);
  assert.equal((await actionRequest(issueId, login, "assign_to_self")).status, 200);
  const acknowledgment = await client.query(
    `select actor_type, actor_id, occurred_at, provider_mode
       from acknowledgment where issue_id = $1 and kind = 'internal_acceptance'`,
    [issueId],
  );
  assert.equal(acknowledgment.rows[0]?.["actor_type"], "staff");
  assert.equal(String(acknowledgment.rows[0]?.["actor_id"]), staffId);
  assert.notEqual(acknowledgment.rows[0]?.["occurred_at"], null);
  assert.equal(acknowledgment.rows[0]?.["provider_mode"], null);
  const assignment = await client.query(
    `select department_id, assigned_staff_id, reason, valid_from
       from assignment where issue_id = $1 and valid_to is null`,
    [issueId],
  );
  assert.equal(assignment.rows[0]?.["department_id"], DEPARTMENT);
  assert.equal(String(assignment.rows[0]?.["assigned_staff_id"]), staffId);
  assert.match(String(assignment.rows[0]?.["reason"]), /checking/);
  assert.notEqual(assignment.rows[0]?.["valid_from"], null);
});

test("V034: a simulated recipient reply records three distinct facts with provenance", async () => {
  const issueId = await routedIssue();
  const login = await loginStaff();
  const response = await actionRequest(issueId, login, "simulate_recipient_acknowledgment");
  assert.equal(response.status, 200);

  const records = await client.query(
    `select kind, actor_id, provider_mode, authenticity, provider_reference, occurred_at
       from acknowledgment where issue_id = $1 order by occurred_at, kind`,
    [issueId],
  );
  assert.deepEqual(
    new Set(records.rows.map((row) => row["kind"])),
    new Set(["delivery_attempted", "delivery_accepted", "recipient_acknowledgment"]),
  );
  const recipient = records.rows.find((row) => row["kind"] === "recipient_acknowledgment");
  assert.equal(recipient?.["provider_mode"], "simulated");
  assert.equal(recipient?.["authenticity"], "simulated_fixture");
  assert.match(String(recipient?.["provider_reference"]), /^SIM-ACK-/);
  assert.equal(String(recipient?.["actor_id"]), staffId);
  assert.notEqual(recipient?.["occurred_at"], null);

  const replay = await actionRequest(issueId, login, "simulate_recipient_acknowledgment");
  assert.equal(replay.status, 200);
  const count = await client.query(
    "select count(*)::int as n from acknowledgment where issue_id = $1",
    [issueId],
  );
  assert.equal(count.rows[0]?.["n"], 3, "retrying must not duplicate any workflow fact");
});

test("V034: a staff action cannot target an issue routed to another department", async () => {
  const issueId = await routedIssue(OTHER_DEPARTMENT);
  const login = await loginStaff();
  const response = await actionRequest(issueId, login, "accept_internal");
  assert.equal(response.status, 409);
  const count = await client.query(
    "select count(*)::int as n from acknowledgment where issue_id = $1",
    [issueId],
  );
  assert.equal(count.rows[0]?.["n"], 0);
});
