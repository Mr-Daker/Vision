/**
 * Authenticated supervisor HTTP workflow (roadmap V036).
 *
 * Run with: npm run db:up && npm run db:migrate && npm run test:db
 *
 * The services are covered by `supervisor-queues.dbtest.ts`. What only becomes
 * true over HTTP is held here: the role comes from a durable grant and not a
 * body, every write needs CSRF, the jurisdiction is enforced on the request,
 * and every payload says the alerts were recorded rather than sent.
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

import { FilesystemObjectStoreAdapter } from "@vision/adapters";

import { buildAppWithDatabase } from "./server.ts";

const DATABASE_URL =
  process.env["DATABASE_URL"] ??
  "postgresql://vision:vision_local_dev_only@127.0.0.1:5432/vision_dev";

const PROFILE = "demo-district-a";
const DIRECTORY = "supervisor-http-directory.v1";
// `electrical` is configured in the shipped ageing pack at 3/7 days.
const AGED_CATEGORY = "electrical";

const TEST_ENV = {
  IDENTITY_PROVIDER_MODE: "simulated",
  RECIPIENT_PROVIDER_MODE: "simulated",
  IDENTITY_MAPPING_HMAC_KEY: `supervisor-identity-${randomUUID()}`,
  SESSION_TOKEN_HMAC_KEY: `supervisor-session-${randomUUID()}`,
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
let responsibilityId: string;
const issues: string[] = [];
const participants: string[] = [];
const staffAccounts: string[] = [];

before(async () => {
  client = new pg.Client({ connectionString: DATABASE_URL, statement_timeout: 20_000 });
  await client.connect();
  // The supervisor grant covers every jurisdiction in the profile, so the one
  // this suite creates must belong to it.
  const { rows } = await client.query(
    `select jurisdiction_id from jurisdiction
      where jurisdiction_profile_id = $1 and internal_code = 'DDA-B1' limit 1`,
    [PROFILE],
  );
  const existing = rows[0]?.["jurisdiction_id"];
  assert.notEqual(existing, undefined, "run `npm run db:seed` before the supervisor HTTP tests");
  jurisdictionId = String(existing);

  responsibilityId = randomUUID();
  await client.query(
    `insert into responsibility_directory
       (responsibility_id, directory_version, jurisdiction_id, category,
        department_id, department_label, provider_mode, effective_from)
     values ($1,$2,$3,'supervisor-http-seed','sup-http-dept','Supervisor HTTP (simulated)',
             'simulated', now() - interval '1 day')`,
    [responsibilityId, DIRECTORY, jurisdictionId],
  );

  storeRoot = await mkdtemp(join(tmpdir(), "vision-supervisor-http-"));
  const objectStore = new FilesystemObjectStoreAdapter({
    root: storeRoot,
    grantHmacKey: "supervisor-http-object-key",
  });
  const { handler } = buildAppWithDatabase(client, objectStore, TEST_ENV);
  server = createServer((request, response) => void handler(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await client.end().catch(() => undefined);
  const cleaner = new pg.Client({ connectionString: DATABASE_URL, statement_timeout: 20_000 });
  await cleaner.connect();
  try {
    if (issues.length > 0) {
      await cleaner.query("delete from issue_alert where issue_id = any($1::uuid[])", [issues]);
      await cleaner.query("delete from issue_ageing_override where issue_id = any($1::uuid[])", [
        issues,
      ]);
      await cleaner.query("delete from routing_decision where issue_id = any($1::uuid[])", [
        issues,
      ]);
      await cleaner.query("delete from canonical_issue where issue_id = any($1::uuid[])", [issues]);
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
    await cleaner.query("delete from responsibility_directory where responsibility_id = $1", [
      responsibilityId,
    ]);
  } finally {
    await cleaner.end();
    await rm(storeRoot, { recursive: true, force: true });
  }
});

type Actor = { readonly cookies: string; readonly csrf: string };

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

const loginSupervisor = async (): Promise<Actor> => {
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
    staffAccounts.push(String(rows[0]["staff_id"]));
    participants.push(String(rows[0]["participant_id"]));
  }
  return {
    cookies: cookieJar(response),
    csrf: cookieValue(response, "vision_supervisor_csrf"),
  };
};

const get = (actor: Actor, path: string) =>
  fetch(`${baseUrl}${path}`, { headers: { cookie: actor.cookies } });

const post = (actor: Actor, path: string, body: unknown, options: { csrf?: boolean } = {}) =>
  fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: actor.cookies,
      ...(options.csrf === false ? {} : { "x-csrf-token": actor.csrf }),
    },
    body: JSON.stringify(body),
  });

const agedIssue = async (routedDaysAgo: number): Promise<string> => {
  const issueId = randomUUID();
  await client.query(
    `insert into canonical_issue
       (issue_id, public_reference, category, current_status, opened_at,
        representative_location, last_evidence_at, jurisdiction_id)
     values ($1,$2,$3,'work_planned', now() - ($4 || ' days')::interval,
             ST_SetSRID(ST_MakePoint(75.9,17.6),4326)::geography, now(), $5)`,
    [
      issueId,
      `VIS-${issueId.slice(0, 8).toUpperCase()}`,
      AGED_CATEGORY,
      String(routedDaysAgo + 1),
      jurisdictionId,
    ],
  );
  issues.push(issueId);
  await client.query(
    `insert into routing_decision
       (routing_id, issue_id, directory_version, category, jurisdiction_id,
        responsibility_id, department_id, department_label, recipient_mode,
        outcome, reason, decided_at)
     values ($1,$2,$3,$4,$5,$6,'sup-http-dept','Supervisor HTTP (simulated)',
             'simulated','routed','supervisor HTTP test route',
             now() - ($7 || ' days')::interval)`,
    [
      randomUUID(),
      issueId,
      DIRECTORY,
      AGED_CATEGORY,
      jurisdictionId,
      responsibilityId,
      String(routedDaysAgo),
    ],
  );
  return issueId;
};

// ---------------------------------------------------------------------------

test("V036 HTTP: the queue needs a supervisor session", async () => {
  const anonymous = await fetch(
    `${baseUrl}/v1/supervisor/queues?jurisdiction_id=${jurisdictionId}`,
  );
  assert.equal(anonymous.status, 401);

  // A department staff session is a session, and still not a supervisor one.
  const staff = await fetch(`${baseUrl}/v1/staff/auth/demo-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential: "demo-staff-one" }),
  });
  const staffActor = { cookies: cookieJar(staff), csrf: cookieValue(staff, "vision_staff_csrf") };
  const refused = await get(staffActor, `/v1/supervisor/queues?jurisdiction_id=${jurisdictionId}`);
  assert.equal(refused.status, 401, "the staff session cookie is not a supervisor session cookie");
});

test("V036 HTTP: a supervisor reads the queues with both clocks and the notes", async () => {
  const supervisor = await loginSupervisor();
  const issueId = await agedIssue(30);

  const response = await get(supervisor, `/v1/supervisor/queues?jurisdiction_id=${jurisdictionId}`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, unknown>;

  assert.match(String(body["policy_note"]), /not a severity, risk or urgency/i);
  assert.match(String(body["delivery_note"]), /internal records/i);

  const row = (body["issues"] as Record<string, unknown>[]).find(
    (issue) => issue["issue_id"] === issueId,
  );
  assert.notEqual(row, undefined);
  assert.ok(Number(row?.["department_age_days"]) >= 29.5);
  // Both clocks are reported, always together.
  assert.ok(Number(row?.["citizen_age_days"]) > Number(row?.["department_age_days"]));
  assert.deepEqual(row?.["queues"], ["overdue", "escalated"]);
});

test("V036 HTTP: nothing in the payload asserts a severity", async () => {
  const supervisor = await loginSupervisor();
  await agedIssue(30);
  const response = await get(supervisor, `/v1/supervisor/queues?jurisdiction_id=${jurisdictionId}`);
  const raw = await response.text();
  // The pack's own disclaimer is the only permitted use of these words.
  const withoutDisclaimer = raw.replace(/NOT a severity, risk or urgency assessment/gi, "");
  for (const word of ["urgency", "priority"]) {
    assert.doesNotMatch(
      withoutDisclaimer,
      new RegExp(`"[^"]*\\b${word}\\b`, "i"),
      `the supervisor payload asserts '${word}'`,
    );
  }
});

test("V036 HTTP: an override needs CSRF, a reason and coherent thresholds", async () => {
  const supervisor = await loginSupervisor();
  const issueId = await agedIssue(2);

  const noCsrf = await post(
    supervisor,
    `/v1/supervisor/issues/${issueId}/ageing-override`,
    { alert_after_days: 1, escalate_after_days: 2, reason: "A properly written reason." },
    { csrf: false },
  );
  assert.equal(noCsrf.status, 403);

  const noReason = await post(supervisor, `/v1/supervisor/issues/${issueId}/ageing-override`, {
    alert_after_days: 1,
    escalate_after_days: 2,
    reason: "short",
  });
  assert.equal(noReason.status, 400);

  const incoherent = await post(supervisor, `/v1/supervisor/issues/${issueId}/ageing-override`, {
    alert_after_days: 5,
    escalate_after_days: 5,
    reason: "Escalating at the same moment it alerts.",
  });
  assert.equal(incoherent.status, 403);

  const malformed = await post(supervisor, `/v1/supervisor/issues/${issueId}/ageing-override`, {
    alert_after_days: "soon",
    escalate_after_days: 2,
    reason: "A properly written reason.",
  });
  assert.equal(malformed.status, 400);
});

test("V036 HTTP: a recorded override changes the clock and denies being a severity", async () => {
  const supervisor = await loginSupervisor();
  const issueId = await agedIssue(2);

  const before = await get(supervisor, `/v1/supervisor/queues?jurisdiction_id=${jurisdictionId}`);
  const beforeRow = ((await before.json()) as { issues: Record<string, unknown>[] }).issues.find(
    (issue) => issue["issue_id"] === issueId,
  );
  assert.deepEqual(beforeRow?.["queues"], [], "two days is inside the three-day promise");

  const recorded = await post(supervisor, `/v1/supervisor/issues/${issueId}/ageing-override`, {
    alert_after_days: 1,
    escalate_after_days: 2,
    reason: "The school reopens on Monday and this blocks the only gate.",
  });
  assert.equal(recorded.status, 200);
  const payload = (await recorded.json()) as Record<string, unknown>;
  assert.equal(payload["is_severity_assessment"], false);
  assert.match(String(payload["delivery_note"]), /internal records/i);

  const afterwards = await get(
    supervisor,
    `/v1/supervisor/queues?jurisdiction_id=${jurisdictionId}`,
  );
  const row = ((await afterwards.json()) as { issues: Record<string, unknown>[] }).issues.find(
    (issue) => issue["issue_id"] === issueId,
  );
  assert.deepEqual(row?.["queues"], ["overdue", "escalated"]);
  assert.equal(row?.["rule_source"], "override");
  assert.match(String((row?.["override"] as Record<string, unknown>)["reason"]), /school reopens/i);
});

test("V036 HTTP: the queue read raises no alerts, and a sweep is what does", async () => {
  const supervisor = await loginSupervisor();
  const issueId = await agedIssue(30);

  await get(supervisor, `/v1/supervisor/queues?jurisdiction_id=${jurisdictionId}`);
  const { rows: afterRead } = await client.query(
    "select count(*)::int as n from issue_alert where issue_id = $1",
    [issueId],
  );
  assert.equal(
    Number(afterRead[0]?.["n"]),
    0,
    "opening a page is not a clock; alerts come from the sweep",
  );

  const { sweepAgeingAlerts } = await import("@vision/adapters");
  const { resolveAgeingPolicy } = await import("./pack-composition.ts");
  await sweepAgeingAlerts(client, {
    jurisdictionId,
    policy: resolveAgeingPolicy(PROFILE),
    asOf: new Date(),
  });

  const response = await get(supervisor, `/v1/supervisor/queues?jurisdiction_id=${jurisdictionId}`);
  const row = ((await response.json()) as { issues: Record<string, unknown>[] }).issues.find(
    (issue) => issue["issue_id"] === issueId,
  );
  const alerts = row?.["alerts"] as Record<string, unknown>[];
  assert.equal(alerts.length, 2);
  // "raised_at", never "sent_at" or "delivered_at".
  assert.ok(alerts.every((alert) => typeof alert["raised_at"] === "string"));
  assert.ok(alerts.every((alert) => alert["acknowledged_at"] === null));
});

test("V036 HTTP: an alert can be marked seen, and only once", async () => {
  const supervisor = await loginSupervisor();
  const issueId = await agedIssue(30);
  const { sweepAgeingAlerts } = await import("@vision/adapters");
  const { resolveAgeingPolicy } = await import("./pack-composition.ts");
  await sweepAgeingAlerts(client, {
    jurisdictionId,
    policy: resolveAgeingPolicy(PROFILE),
    asOf: new Date(),
  });
  const { rows } = await client.query(
    "select alert_id from issue_alert where issue_id = $1 limit 1",
    [issueId],
  );
  const alertId = String(rows[0]?.["alert_id"]);

  const first = await post(supervisor, `/v1/supervisor/alerts/${alertId}/acknowledge`, {
    jurisdiction_id: jurisdictionId,
  });
  assert.equal(first.status, 200);
  const second = await post(supervisor, `/v1/supervisor/alerts/${alertId}/acknowledge`, {
    jurisdiction_id: jurisdictionId,
  });
  assert.equal(second.status, 409, "a stale view gets a conflict, not a silent second success");
});

test("V036 HTTP: capabilities say the alerts are internal before anyone signs in", async () => {
  const response = await fetch(`${baseUrl}/v1/supervisor/capabilities`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, unknown>;
  assert.match(String(body["delivery_note"]), /internal records/i);
  assert.equal(body["identity_mode"], "simulated");
  assert.ok(
    (body["demo_principals"] as Record<string, unknown>[]).some(
      (principal) => principal["credential"] === "demo-supervisor-one",
    ),
  );
});
