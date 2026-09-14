/**
 * Resolution claims, citizen confirmation, dispute and reopening over HTTP
 * (roadmap V035).
 *
 * Run with: npm run db:up && npm run db:migrate && npm run test:db
 *
 * The services underneath are covered by `resolution.dbtest.ts`. What this
 * file exists to hold is everything that only becomes true once the workflow
 * is reachable from a browser:
 *
 *   * the responder is the **session**, not a field in the request body;
 *   * a private original never appears in a citizen payload;
 *   * completion evidence names bytes that were really uploaded and really
 *     decode as a photograph;
 *   * a staff member's jurisdiction *and* department are revalidated on the
 *     mutation, not only when the inbox was listed;
 *   * every write needs a CSRF token, and a stale view gets a conflict rather
 *     than an approximate answer.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

import { FilesystemObjectStoreAdapter } from "@vision/adapters";

import { buildAppWithDatabase } from "./server.ts";

const DATABASE_URL =
  process.env["DATABASE_URL"] ??
  "postgresql://vision:vision_local_dev_only@127.0.0.1:5432/vision_dev";

const PROFILE = "demo-district-a";
const JURISDICTION = randomUUID();
const CODE = `RES-${JURISDICTION.slice(0, 8)}`;
const DEPARTMENT = `res-dept-${randomUUID().slice(0, 8)}`;
const OTHER_DEPARTMENT = `res-other-${randomUUID().slice(0, 8)}`;
const DIRECTORY = "resolution-http-directory.v1";

/**
 * Categories chosen to exercise both halves of the shipped policy pack.
 * `water_supply` needs one confirmation and permits a reviewer override;
 * `electrical` needs two and forbids one.
 */
const ROUTINE = "water_supply";
const SAFETY = "electrical";

const TEST_ENV = {
  IDENTITY_PROVIDER_MODE: "simulated",
  RECIPIENT_PROVIDER_MODE: "simulated",
  IDENTITY_MAPPING_HMAC_KEY: `resolution-identity-${randomUUID()}`,
  SESSION_TOKEN_HMAC_KEY: `resolution-session-${randomUUID()}`,
  SESSION_TTL_SECONDS: "3600",
  SESSION_COOKIE_SECURE: "false",
  SUPPORTED_LOCALES: "en-IN,mr-IN",
  JURISDICTION_PROFILE_ID: PROFILE,
  STAFF_RESPONSIBILITIES: `${CODE}:${DEPARTMENT}`,
  REVIEWER_JURISDICTION_CODES: CODE,
} as const;

/** A real photograph. A header-only stub would not survive the decoder. */
const PHOTO = await readFile(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../packages/media/src/testdata/png-scene-32x32.png",
  ),
);

let client: pg.Client;
let server: Server;
let baseUrl: string;
let storeRoot: string;
let objectStore: FilesystemObjectStoreAdapter;

const issues: string[] = [];
const responsibilities: string[] = [];
const participants: string[] = [];
const staffAccounts: string[] = [];

before(async () => {
  client = new pg.Client({ connectionString: DATABASE_URL, statement_timeout: 20_000 });
  await client.connect();
  await client.query(
    `insert into jurisdiction
       (jurisdiction_id, jurisdiction_profile_id, internal_code, directory_version,
        level_scheme, level_code, effective_from, synthetic_provenance)
     values ($1,$2,$3,$4,'resolution-scheme','block', now() - interval '1 day', true)`,
    [JURISDICTION, PROFILE, CODE, DIRECTORY],
  );
  for (const [category, departmentId] of [
    [ROUTINE, DEPARTMENT],
    [SAFETY, DEPARTMENT],
    ["res-login-seed", DEPARTMENT],
    [`${ROUTINE}-other`, OTHER_DEPARTMENT],
  ] as const) {
    const responsibilityId = randomUUID();
    responsibilities.push(responsibilityId);
    await client.query(
      `insert into responsibility_directory
         (responsibility_id, directory_version, jurisdiction_id, category,
          department_id, department_label, provider_mode, effective_from)
       values ($1,$2,$3,$4,$5,$6,'simulated', now() - interval '1 day')`,
      [
        responsibilityId,
        DIRECTORY,
        JURISDICTION,
        category,
        departmentId,
        `${departmentId} (simulated)`,
      ],
    );
  }

  storeRoot = await mkdtemp(join(tmpdir(), "vision-resolution-http-"));
  objectStore = new FilesystemObjectStoreAdapter({
    root: storeRoot,
    grantHmacKey: "resolution-http-object-key",
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
      await cleaner.query(`delete from reopening where issue_id = any($1::uuid[])`, [issues]);
      await cleaner.query(
        `delete from resolution_confirmation where claim_id in
           (select claim_id from resolution_claim where issue_id = any($1::uuid[]))`,
        [issues],
      );
      await cleaner.query(
        `delete from resolution_evidence_item where claim_id in
           (select claim_id from resolution_claim where issue_id = any($1::uuid[]))`,
        [issues],
      );
      await cleaner.query("delete from resolution_claim where issue_id = any($1::uuid[])", [
        issues,
      ]);
      await cleaner.query(
        "delete from review_decision where canonical_issue_id = any($1::uuid[])",
        [issues],
      );
      await cleaner.query("delete from acknowledgment where issue_id = any($1::uuid[])", [issues]);
      await cleaner.query("delete from assignment where issue_id = any($1::uuid[])", [issues]);
      await cleaner.query("delete from routing_decision where issue_id = any($1::uuid[])", [
        issues,
      ]);
      await cleaner.query(
        "delete from issue_participation where canonical_issue_id = any($1::uuid[])",
        [issues],
      );
      await cleaner.query(
        `delete from issue_evidence_link where canonical_issue_id = any($1::uuid[])`,
        [issues],
      );
      await cleaner.query("delete from status_event where aggregate_id = any($1::text[])", [
        issues,
      ]);
      await cleaner.query("delete from canonical_issue where issue_id = any($1::uuid[])", [issues]);
    }
    if (staffAccounts.length > 0) {
      // The private-original access log references the staff account and is
      // append-only by design, so it goes first in the teardown rather than
      // being made deletable in the schema.
      await cleaner.query(
        "delete from private_evidence_access_log where staff_id = any($1::uuid[])",
        [staffAccounts],
      );
      await cleaner.query("delete from staff_department_grant where staff_id = any($1::uuid[])", [
        staffAccounts,
      ]);
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
      await cleaner.query(
        "delete from evidence_item where submission_id in (select submission_id from submission where participant_id = any($1::uuid[]))",
        [participants],
      );
      await cleaner.query("delete from submission where participant_id = any($1::uuid[])", [
        participants,
      ]);
      await cleaner.query("delete from participant where participant_id = any($1::uuid[])", [
        participants,
      ]);
    }
    await cleaner.query(
      "delete from responsibility_directory where responsibility_id = any($1::uuid[])",
      [responsibilities],
    );
    await cleaner.query("delete from jurisdiction where jurisdiction_id = $1", [JURISDICTION]);
  } finally {
    await cleaner.end();
    await rm(storeRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type Actor = {
  readonly cookies: string;
  readonly csrf: string;
  /**
   * The participant behind the session, captured at sign-in.
   *
   * Read straight after the login that created it, because a session token is
   * stored as a keyed hash and cannot be resolved back to its row afterwards.
   * An earlier version looked up "the newest session" at use time, which
   * returned whoever signed in last and made every citizen assertion below
   * silently test the same account.
   */
  readonly participantId: string;
};

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

const login = async (path: string, credential: string, csrfCookie: string): Promise<Actor> => {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential }),
  });
  assert.equal(response.status, 200, `${credential} could not sign in`);
  const { rows } = await client.query(
    "select participant_id from app_session order by issued_at desc, session_id desc limit 1",
  );
  const participantId = String(rows[0]?.["participant_id"] ?? "");
  assert.notEqual(participantId, "", `no session was issued for ${credential}`);
  participants.push(participantId);
  return {
    cookies: cookieJar(response),
    csrf: cookieValue(response, csrfCookie),
    participantId,
  };
};

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

const get = (actor: Actor, path: string) =>
  fetch(`${baseUrl}${path}`, { headers: { cookie: actor.cookies } });

/** Signs in the demo accounts, recording their rows so cleanup can remove them. */
const signInAll = async () => {
  const staff = await login("/v1/staff/auth/demo-login", "demo-staff-one", "vision_staff_csrf");
  const reviewer = await login(
    "/v1/reviewer/auth/demo-login",
    "demo-reviewer-one",
    "vision_reviewer_csrf",
  );
  const citizenOne = await login("/v1/auth/demo-login", "demo-citizen-one", "vision_csrf");
  const citizenTwo = await login("/v1/auth/demo-login", "demo-citizen-two", "vision_csrf");

  // Only the accounts behind *this run's* participants. The suite uses its own
  // identity HMAC key, so those participants are unique to it — sweeping every
  // simulated staff account would delete rows another suite is still using.
  const { rows } = await client.query(
    "select staff_id from staff_account where participant_id = any($1::uuid[])",
    [[staff.participantId, reviewer.participantId]],
  );
  for (const row of rows) staffAccounts.push(String(row["staff_id"]));

  return { staff, reviewer, citizenOne, citizenTwo };
};

/** A routed issue with two counted participants, ready for the V034 actions. */
const seedIssue = async (
  category: string,
  countedParticipantIds: readonly string[],
  departmentId = DEPARTMENT,
): Promise<{ readonly issueId: string; readonly reference: string }> => {
  const issueId = randomUUID();
  const reference = `VIS-${issueId.slice(0, 8).toUpperCase()}`;
  await client.query(
    `insert into canonical_issue
       (issue_id, public_reference, category, current_status, opened_at,
        representative_location, last_evidence_at, jurisdiction_id)
     values ($1,$2,$3,'routed_internal', now() - interval '6 days',
             ST_SetSRID(ST_MakePoint(74.55,16.85),4326)::geography, now(), $4)`,
    [issueId, reference, category, JURISDICTION],
  );
  issues.push(issueId);

  const { rows } = await client.query(
    `select responsibility_id from responsibility_directory
      where jurisdiction_id = $1 and department_id = $2 limit 1`,
    [JURISDICTION, departmentId],
  );
  await client.query(
    `insert into routing_decision
       (routing_id, issue_id, directory_version, category, jurisdiction_id,
        responsibility_id, department_id, department_label, recipient_mode, outcome, reason)
     values ($1,$2,$3,$4,$5,$6,$7,$8,'simulated','routed','resolution HTTP test route')`,
    [
      randomUUID(),
      issueId,
      DIRECTORY,
      category,
      JURISDICTION,
      String(rows[0]?.["responsibility_id"]),
      departmentId,
      `${departmentId} (simulated)`,
    ],
  );
  for (const participantId of countedParticipantIds) {
    await client.query(
      `insert into issue_participation
         (participation_id, participant_id, canonical_issue_id, counted,
          first_evidence_at, last_evidence_at)
       values ($1,$2,$3,true, now() - interval '6 days', now() - interval '6 days')
       on conflict do nothing`,
      [randomUUID(), participantId, issueId],
    );
  }
  return { issueId, reference };
};

const staffAct = (staff: Actor, issueId: string, body: Record<string, unknown>) =>
  post(staff, `/v1/staff/issues/${issueId}/actions`, {
    jurisdiction_id: JURISDICTION,
    department_id: DEPARTMENT,
    ...body,
  });

/** Walks V034's acknowledgment and assignment so work is planned. */
const planWork = async (staff: Actor, issueId: string): Promise<void> => {
  const acknowledged = await staffAct(staff, issueId, {
    action: "simulate_recipient_acknowledgment",
    note: "Simulated recipient reply recorded for this test.",
  });
  assert.equal(acknowledged.status, 200);
  const assigned = await staffAct(staff, issueId, {
    action: "assign_to_self",
    note: "Taking this on so work can be planned.",
  });
  assert.equal(assigned.status, 200);
  const { rows } = await client.query(
    "select current_status from canonical_issue where issue_id = $1",
    [issueId],
  );
  assert.equal(String(rows[0]?.["current_status"]), "work_planned");
};

/** Uploads a real photograph through the staff grant path. */
const uploadPhoto = async (staff: Actor, bytes: Buffer = PHOTO): Promise<string> => {
  const grantResponse = await post(staff, "/v1/staff/uploads", {
    content_type: "image/png",
    max_bytes: bytes.byteLength,
  });
  assert.equal(grantResponse.status, 201);
  const grant = (await grantResponse.json()) as {
    object_reference: string;
    upload_url: string;
  };
  const put = await fetch(
    `${baseUrl}${grant.upload_url.replace("/v1/uploads/", "/v1/staff/uploads/")}`,
    {
      method: "PUT",
      headers: { "content-type": "image/png", cookie: staff.cookies },
      body: new Uint8Array(bytes),
    },
  );
  assert.equal(put.status, 200);
  const finalized = await post(
    staff,
    `/v1/staff/uploads/${encodeURIComponent(grant.object_reference)}/finalize`,
    undefined,
  );
  assert.equal(finalized.status, 200);
  return grant.object_reference;
};

const claim = (
  staff: Actor,
  issueId: string,
  reference: string,
  overrides: Record<string, unknown> = {},
) =>
  staffAct(staff, issueId, {
    action: "claim_resolution",
    note: "Cut out the failed section and fitted a new compression joint.",
    idempotency_key: `claim-${issueId}`,
    completion_evidence: [{ object_reference: reference }],
    ...overrides,
  });

// ---------------------------------------------------------------------------
// A. Staff resolution claim
// ---------------------------------------------------------------------------

test("V035 HTTP: a claim needs completion evidence, a description and a key", async () => {
  const { staff, citizenOne } = await signInAll();
  const participantId = citizenOne.participantId;
  const { issueId } = await seedIssue(ROUTINE, [participantId]);
  await planWork(staff, issueId);

  const noEvidence = await staffAct(staff, issueId, {
    action: "claim_resolution",
    note: "Fitted a new compression joint on the failed section.",
    idempotency_key: `k-${randomUUID()}`,
    completion_evidence: [],
  });
  assert.equal(noEvidence.status, 400);
  assert.match(
    JSON.stringify(await noEvidence.json()),
    /completion photograph/i,
    "a claim with nothing to look at gives a citizen nothing to confirm",
  );

  const reference = await uploadPhoto(staff);
  const vagueDescription = await claim(staff, issueId, reference, { note: "Fixed." });
  assert.equal(vagueDescription.status, 400);

  const noKey = await staffAct(staff, issueId, {
    action: "claim_resolution",
    note: "Fitted a new compression joint on the failed section.",
    completion_evidence: [{ object_reference: reference }],
  });
  assert.equal(noKey.status, 400);
});

test("V035 HTTP: completion evidence must name bytes that were really uploaded", async () => {
  const { staff, citizenOne } = await signInAll();
  const participantId = citizenOne.participantId;
  const { issueId } = await seedIssue(ROUTINE, [participantId]);
  await planWork(staff, issueId);

  const invented = await claim(staff, issueId, `2026-09/${randomUUID()}`);
  assert.equal(invented.status, 400);
  assert.match(JSON.stringify(await invented.json()), /upload that finished/i);
});

test("V035 HTTP: staff cannot finalize or claim another account's upload", async () => {
  const { staff, citizenOne } = await signInAll();
  const foreignOwner = randomUUID() as never;
  const context = {
    correlation_id: randomUUID() as never,
    idempotency_key: `foreign-upload-${randomUUID()}` as never,
    idempotency_scope: `staff:${foreignOwner}:uploads.create` as never,
    request_fingerprint: `sha256:${"f".repeat(64)}` as never,
  };
  const granted = await objectStore.createUploadGrant(
    {
      intended_content_type: "image/png",
      max_bytes: PHOTO.byteLength,
      owner_pseudonym: foreignOwner,
    },
    context,
  );
  assert.equal(granted.kind, "success");
  if (granted.kind !== "success") return;
  const token = new URL(`http://local${granted.value.upload_url}`).searchParams.get("token");
  assert.ok(token);
  assert.deepEqual(
    await objectStore.putStagedObject(granted.value.object_reference, token, PHOTO, "image/png"),
    { ok: true },
  );

  const crossFinalize = await post(
    staff,
    `/v1/staff/uploads/${encodeURIComponent(granted.value.object_reference)}/finalize`,
    undefined,
  );
  assert.equal(crossFinalize.status, 403);

  const finalized = await objectStore.finalizeUpload(granted.value.object_reference, {
    ...context,
    idempotency_key: `foreign-finalize-${randomUUID()}` as never,
  });
  assert.equal(finalized.kind, "success");

  const { issueId } = await seedIssue(ROUTINE, [citizenOne.participantId]);
  await planWork(staff, issueId);
  const crossClaim = await claim(staff, issueId, granted.value.object_reference);
  assert.equal(crossClaim.status, 400);
  assert.match(JSON.stringify(await crossClaim.json()), /this staff account/i);
});

test("V035 HTTP: a truncated pseudo-image is refused, not stored as a photograph", async () => {
  const { staff, citizenOne } = await signInAll();
  const participantId = citizenOne.participantId;
  const { issueId } = await seedIssue(ROUTINE, [participantId]);
  await planWork(staff, issueId);

  const truncated = await readFile(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "../../../packages/media/src/testdata/png-truncated.png",
    ),
  );
  // The object store refuses it at completion, so no claim can ever name it —
  // which is the outcome that matters. The decoder in the claim path is the
  // second layer, for bytes that pass the signature check and still fail.
  const grantResponse = await post(staff, "/v1/staff/uploads", {
    content_type: "image/png",
    max_bytes: truncated.byteLength,
  });
  const grant = (await grantResponse.json()) as { object_reference: string; upload_url: string };
  await fetch(`${baseUrl}${grant.upload_url.replace("/v1/uploads/", "/v1/staff/uploads/")}`, {
    method: "PUT",
    headers: { "content-type": "image/png", cookie: staff.cookies },
    body: new Uint8Array(truncated),
  });
  await post(
    staff,
    `/v1/staff/uploads/${encodeURIComponent(grant.object_reference)}/finalize`,
    undefined,
  );

  const refused = await claim(staff, issueId, grant.object_reference);
  assert.equal(refused.status, 400);
});

test("V035 HTTP: a claim without a session, or without CSRF, is refused", async () => {
  const { staff, citizenOne } = await signInAll();
  const participantId = citizenOne.participantId;
  const { issueId } = await seedIssue(ROUTINE, [participantId]);
  await planWork(staff, issueId);
  const reference = await uploadPhoto(staff);

  const anonymous = await fetch(`${baseUrl}/v1/staff/issues/${issueId}/actions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "claim_resolution" }),
  });
  assert.equal(anonymous.status, 403, "no session and no CSRF token is refused");

  const noCsrf = await post(
    staff,
    `/v1/staff/issues/${issueId}/actions`,
    {
      action: "claim_resolution",
      jurisdiction_id: JURISDICTION,
      department_id: DEPARTMENT,
      note: "Cut out the failed section and fitted a new joint.",
      idempotency_key: `k-${randomUUID()}`,
      completion_evidence: [{ object_reference: reference }],
    },
    { csrf: false },
  );
  assert.equal(noCsrf.status, 403);
  assert.match(JSON.stringify(await noCsrf.json()), /CSRF/i);
});

test("V035 HTTP: a claim into another department is refused", async () => {
  const { staff, citizenOne } = await signInAll();
  const participantId = citizenOne.participantId;
  const { issueId } = await seedIssue(ROUTINE, [participantId], OTHER_DEPARTMENT);
  const reference = await uploadPhoto(staff);

  // Routed to a department this staff member has no responsibility for, so
  // even the inbox lookup refuses before any claim logic runs.
  const refused = await post(staff, `/v1/staff/issues/${issueId}/actions`, {
    action: "claim_resolution",
    jurisdiction_id: JURISDICTION,
    department_id: OTHER_DEPARTMENT,
    note: "Claiming work in a department I do not hold.",
    idempotency_key: `k-${randomUUID()}`,
    completion_evidence: [{ object_reference: reference }],
  });
  assert.ok(refused.status === 403 || refused.status === 409, `got ${String(refused.status)}`);
});

test("V035 HTTP: a claim on an issue with no work planned is refused", async () => {
  const { staff, citizenOne } = await signInAll();
  const participantId = citizenOne.participantId;
  const { issueId } = await seedIssue(ROUTINE, [participantId]);
  const reference = await uploadPhoto(staff);

  const refused = await claim(staff, issueId, reference);
  assert.equal(refused.status, 409);
  assert.match(JSON.stringify(await refused.json()), /routed_internal -> resolution_claimed/);
});

test("V035 HTTP: a successful claim is unverified, and says so in the payload", async () => {
  const { staff, citizenOne } = await signInAll();
  const participantId = citizenOne.participantId;
  const { issueId } = await seedIssue(ROUTINE, [participantId]);
  await planWork(staff, issueId);
  const reference = await uploadPhoto(staff);

  const response = await claim(staff, issueId, reference);
  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body["issue_status"], "resolution_claimed");
  assert.equal(body["is_verified_resolution"], false);
  assert.equal(body["awaiting_confirmation"], true);
  assert.ok(
    (body["disclosures"] as string[]).some((line) => /not a professional inspection/i.test(line)),
    "every claim payload carries the non-certification sentence",
  );
});

test("V035 HTTP: replaying a claim key returns the first claim, not a second", async () => {
  const { staff, citizenOne } = await signInAll();
  const participantId = citizenOne.participantId;
  const { issueId } = await seedIssue(ROUTINE, [participantId]);
  await planWork(staff, issueId);
  const reference = await uploadPhoto(staff);

  const first = (await (await claim(staff, issueId, reference)).json()) as Record<string, unknown>;
  const replay = (await (await claim(staff, issueId, reference)).json()) as Record<string, unknown>;
  assert.equal(replay["claim_id"], first["claim_id"]);
  assert.equal(replay["replayed"], true);

  const { rows } = await client.query(
    "select count(*)::int as n from resolution_claim where issue_id = $1",
    [issueId],
  );
  assert.equal(Number(rows[0]?.["n"]), 1);
});

test("V035 HTTP: a claim key reused for another issue returns a conflict", async () => {
  const { staff, citizenOne } = await signInAll();
  const first = await seedIssue(ROUTINE, [citizenOne.participantId]);
  const second = await seedIssue(ROUTINE, [citizenOne.participantId]);
  await planWork(staff, first.issueId);
  await planWork(staff, second.issueId);
  const reference = await uploadPhoto(staff);
  const idempotencyKey = `shared-${randomUUID()}`;

  const accepted = await claim(staff, first.issueId, reference, {
    idempotency_key: idempotencyKey,
  });
  assert.equal(accepted.status, 200);
  const refused = await claim(staff, second.issueId, reference, {
    idempotency_key: idempotencyKey,
  });
  assert.equal(refused.status, 409);
  assert.match(JSON.stringify(await refused.json()), /different resolution claim request/i);

  const { rows } = await client.query(
    "select current_status from canonical_issue where issue_id = $1",
    [second.issueId],
  );
  assert.equal(rows[0]?.["current_status"], "work_planned");
});

// ---------------------------------------------------------------------------
// B. Citizen confirmation and dispute
// ---------------------------------------------------------------------------

test("V035 HTTP: the citizen payload carries no private original", async () => {
  const { staff, citizenOne } = await signInAll();
  const participantId = citizenOne.participantId;
  const { issueId, reference } = await seedIssue(ROUTINE, [participantId]);
  await planWork(staff, issueId);
  const objectReference = await uploadPhoto(staff);
  await claim(staff, issueId, objectReference);

  const view = await get(citizenOne, `/v1/me/issues/${reference}/resolution`);
  assert.equal(view.status, 200);
  const raw = await view.text();

  // The strongest form of the check: the object reference the claim really
  // used does not appear anywhere in the bytes sent to the citizen.
  assert.ok(
    !raw.includes(objectReference),
    "a private original object reference reached a citizen payload",
  );
  assert.ok(!raw.includes("originals/"), "an originals path reached a citizen payload");
  assert.doesNotMatch(raw, /"object_reference"/);
  // Never cacheable: this payload says what *this* participant may do.
  assert.match(view.headers.get("cache-control") ?? "", /no-store/);
});

test("V035 HTTP: someone with no counted participation may not answer", async () => {
  const { staff, citizenOne, citizenTwo } = await signInAll();
  const participantId = citizenOne.participantId;
  const { issueId, reference } = await seedIssue(ROUTINE, [participantId]);
  await planWork(staff, issueId);
  await claim(staff, issueId, await uploadPhoto(staff));

  const stranger = await get(citizenTwo, `/v1/me/issues/${reference}/resolution`);
  const body = (await stranger.json()) as Record<string, unknown>;
  assert.equal(body["may_respond"], false);
  assert.equal(body["may_respond_blocked_by"], "not_a_counted_participant");

  const refused = await post(citizenTwo, `/v1/me/issues/${reference}/resolution/respond`, {
    decision: "confirmed",
  });
  assert.equal(refused.status, 403);
});

test("V035 HTTP: the responder is the session, and a named participant is refused", async () => {
  const { staff, citizenOne, citizenTwo } = await signInAll();
  const one = citizenOne.participantId;
  const { issueId, reference } = await seedIssue(ROUTINE, [one]);
  await planWork(staff, issueId);
  await claim(staff, issueId, await uploadPhoto(staff));

  // citizenTwo is not counted; naming citizenOne must not let them answer.
  const impersonation = await post(citizenTwo, `/v1/me/issues/${reference}/resolution/respond`, {
    decision: "confirmed",
    participant_id: one,
  });
  assert.equal(impersonation.status, 400);
  assert.match(
    JSON.stringify(await impersonation.json()),
    /the responder is the signed-in session/,
  );
});

test("V035 HTTP: a dispute must say what is still wrong", async () => {
  const { staff, citizenOne } = await signInAll();
  const participantId = citizenOne.participantId;
  const { issueId, reference } = await seedIssue(ROUTINE, [participantId]);
  await planWork(staff, issueId);
  await claim(staff, issueId, await uploadPhoto(staff));

  const noReason = await post(citizenOne, `/v1/me/issues/${reference}/resolution/respond`, {
    decision: "disputed",
  });
  assert.equal(noReason.status, 400);

  const malformed = await post(citizenOne, `/v1/me/issues/${reference}/resolution/respond`, {
    decision: "maybe",
  });
  assert.equal(malformed.status, 400);

  const noCsrf = await post(
    citizenOne,
    `/v1/me/issues/${reference}/resolution/respond`,
    { decision: "confirmed" },
    { csrf: false },
  );
  assert.equal(noCsrf.status, 403);
});

test("V035 HTTP: a routine category closes on one confirmation", async () => {
  const { staff, citizenOne } = await signInAll();
  const participantId = citizenOne.participantId;
  const { issueId, reference } = await seedIssue(ROUTINE, [participantId]);
  await planWork(staff, issueId);
  await claim(staff, issueId, await uploadPhoto(staff));

  const answered = await post(citizenOne, `/v1/me/issues/${reference}/resolution/respond`, {
    decision: "confirmed",
  });
  assert.equal(answered.status, 200);
  const body = (await answered.json()) as Record<string, unknown>;
  assert.equal(body["resulting_status"], "resolution_confirmed");
  assert.equal(body["is_verified_resolution"], true);
  assert.equal(body["counts_as_closed"], true);
  assert.equal(body["may_reopen"], true);
});

test("V035 HTTP: one person cannot answer twice, and a stale view gets a conflict", async () => {
  const { staff, citizenOne } = await signInAll();
  const participantId = citizenOne.participantId;
  const { issueId, reference } = await seedIssue(ROUTINE, [participantId]);
  await planWork(staff, issueId);
  await claim(staff, issueId, await uploadPhoto(staff));

  assert.equal(
    (
      await post(citizenOne, `/v1/me/issues/${reference}/resolution/respond`, {
        decision: "confirmed",
      })
    ).status,
    200,
  );
  const again = await post(citizenOne, `/v1/me/issues/${reference}/resolution/respond`, {
    decision: "disputed",
    comment: "Actually it is still leaking after all.",
  });
  // 409, not 403: the answer was about a world that has moved on, so the page
  // must be re-read rather than the account told it lacks permission.
  assert.equal(again.status, 409);
});

test("V035 HTTP: a safety category needs two different people", async () => {
  const { staff, citizenOne, citizenTwo } = await signInAll();
  const one = citizenOne.participantId;
  const two = citizenTwo.participantId;
  assert.notEqual(one, two, "the two demo citizens must be different participants");
  const { issueId, reference } = await seedIssue(SAFETY, [one, two]);
  await planWork(staff, issueId);
  await claim(staff, issueId, await uploadPhoto(staff));

  const first = (await (
    await post(citizenOne, `/v1/me/issues/${reference}/resolution/respond`, {
      decision: "confirmed",
    })
  ).json()) as Record<string, unknown>;
  assert.equal(first["resulting_status"], "resolution_claimed", "one confirmation is not enough");
  assert.equal(first["is_verified_resolution"], false);
  assert.equal(first["required_confirmations"], 2);
  assert.ok(
    (first["disclosures"] as string[]).some((line) =>
      /qualified person should inspect/i.test(line),
    ),
    "a category needing inspection carries the second disclosure",
  );

  const second = (await (
    await post(citizenTwo, `/v1/me/issues/${reference}/resolution/respond`, {
      decision: "confirmed",
    })
  ).json()) as Record<string, unknown>;
  assert.equal(second["resulting_status"], "resolution_confirmed");
});

test("V035 HTTP: one dispute outweighs a confirmation", async () => {
  const { staff, citizenOne, citizenTwo } = await signInAll();
  const one = citizenOne.participantId;
  const two = citizenTwo.participantId;
  const { issueId, reference } = await seedIssue(SAFETY, [one, two]);
  await planWork(staff, issueId);
  await claim(staff, issueId, await uploadPhoto(staff));

  await post(citizenOne, `/v1/me/issues/${reference}/resolution/respond`, {
    decision: "confirmed",
  });
  const disputed = (await (
    await post(citizenTwo, `/v1/me/issues/${reference}/resolution/respond`, {
      decision: "disputed",
      comment: "The pole is still live after rain; nothing looks different.",
    })
  ).json()) as Record<string, unknown>;

  assert.equal(disputed["resulting_status"], "resolution_disputed");
  assert.equal(disputed["is_verified_resolution"], false);
  assert.equal(disputed["counts_as_closed"], false);
});

// ---------------------------------------------------------------------------
// C. Reviewer disagreement handling
// ---------------------------------------------------------------------------

const disputedIssue = async (
  category: string,
): Promise<{ readonly issueId: string; readonly reference: string; readonly reviewer: Actor }> => {
  const { staff, reviewer, citizenOne } = await signInAll();
  const participantId = citizenOne.participantId;
  const seeded = await seedIssue(category, [participantId]);
  await planWork(staff, seeded.issueId);
  await claim(staff, seeded.issueId, await uploadPhoto(staff));
  const response = await post(citizenOne, `/v1/me/issues/${seeded.reference}/resolution/respond`, {
    decision: "disputed",
    comment: "This is not fixed; the same fault is still there.",
  });
  assert.equal(response.status, 200);
  return { ...seeded, reviewer };
};

const queueItem = async (reviewer: Actor, issueId: string) => {
  const response = await get(reviewer, `/v1/reviewer/queue?jurisdiction_id=${JURISDICTION}`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { items: Record<string, unknown>[] };
  return body.items.find(
    (item) => item["kind"] === "disputed_resolution" && item["target_id"] === issueId,
  );
};

test("V035 HTTP: a dispute appears in the existing review queue with the citizen's words", async () => {
  const { issueId, reviewer } = await disputedIssue(ROUTINE);
  const item = await queueItem(reviewer, issueId);
  assert.notEqual(item, undefined, "a disputed claim must reach the reviewer queue");
  assert.match(String(item?.["citizen_note"]), /still there/);
  assert.match(String(item?.["reason"]), /disputes the repair claim/);
});

test("V035 HTTP: the override is offered only where the policy grants it", async () => {
  const routine = await disputedIssue(ROUTINE);
  const routineItem = await queueItem(routine.reviewer, routine.issueId);
  assert.deepEqual(routineItem?.["permitted_actions"], [
    "return_disputed_work",
    "confirm_disputed_resolution",
  ]);

  const safety = await disputedIssue(SAFETY);
  const safetyItem = await queueItem(safety.reviewer, safety.issueId);
  assert.deepEqual(
    safetyItem?.["permitted_actions"],
    ["return_disputed_work"],
    "a safety category withholds the reviewer override",
  );

  // And forcing it is refused rather than merely hidden.
  const forced = await post(
    safety.reviewer,
    `/v1/reviewer/queue/disputed_resolution/${safety.issueId}/decisions`,
    {
      action: "confirm_disputed_resolution",
      reason: "I believe the crew did this properly.",
      jurisdiction_id: JURISDICTION,
    },
  );
  assert.equal(forced.status, 403);
});

test("V035 HTTP: every dispute decision needs a recorded reason", async () => {
  const { issueId, reviewer } = await disputedIssue(ROUTINE);
  const noReason = await post(
    reviewer,
    `/v1/reviewer/queue/disputed_resolution/${issueId}/decisions`,
    { action: "return_disputed_work", reason: "", jurisdiction_id: JURISDICTION },
  );
  assert.equal(noReason.status, 400);

  const noCsrf = await post(
    reviewer,
    `/v1/reviewer/queue/disputed_resolution/${issueId}/decisions`,
    {
      action: "return_disputed_work",
      reason: "Sending this back to the crew.",
      jurisdiction_id: JURISDICTION,
    },
    { csrf: false },
  );
  assert.equal(noCsrf.status, 403);
});

test("V035 HTTP: returning the work keeps the dispute on the record", async () => {
  const { issueId, reviewer } = await disputedIssue(SAFETY);
  const decided = await post(
    reviewer,
    `/v1/reviewer/queue/disputed_resolution/${issueId}/decisions`,
    {
      action: "return_disputed_work",
      reason: "The resident reports the same fault; send an electrician back.",
      jurisdiction_id: JURISDICTION,
    },
  );
  assert.equal(decided.status, 200);
  const body = (await decided.json()) as Record<string, unknown>;
  assert.deepEqual(body["resulting_state"], { issue_status: "work_planned" });

  const { rows } = await client.query(
    `select c.decision from resolution_confirmation c
       join resolution_claim k on k.claim_id = c.claim_id
      where k.issue_id = $1`,
    [issueId],
  );
  assert.deepEqual(
    rows.map((row) => String(row["decision"])),
    ["disputed"],
    "the citizen's dispute is preserved, not rewritten",
  );
  const { rows: audit } = await client.query(
    "select action, reason from review_decision where canonical_issue_id = $1",
    [issueId],
  );
  assert.equal(String(audit[0]?.["action"]), "return_disputed_work");
  assert.match(String(audit[0]?.["reason"]), /electrician/);
});

test("V035 HTTP: a permitted override is recorded with its reason and keeps the dispute", async () => {
  const { issueId, reviewer } = await disputedIssue(ROUTINE);
  const decided = await post(
    reviewer,
    `/v1/reviewer/queue/disputed_resolution/${issueId}/decisions`,
    {
      action: "confirm_disputed_resolution",
      reason: "Attended with the crew; the remaining drip is condensation on the new joint.",
      jurisdiction_id: JURISDICTION,
    },
  );
  assert.equal(decided.status, 200);
  const outcome = (await decided.json()) as Record<string, unknown>;
  assert.deepEqual(outcome["resulting_state"], { issue_status: "resolution_confirmed" });

  const { rows } = await client.query(
    `select c.decision, c.reviewer_id is not null as by_reviewer
       from resolution_confirmation c join resolution_claim k on k.claim_id = c.claim_id
      where k.issue_id = $1 order by c.decided_at`,
    [issueId],
  );
  assert.deepEqual(
    rows.map(
      (row) =>
        `${String(row["decision"])}:${row["by_reviewer"] === true ? "reviewer" : "participant"}`,
    ),
    ["disputed:participant", "confirmed:reviewer"],
    "the override is an additional row; the participant's dispute is untouched",
  );

  // The state change and its audit row commit together.
  const { rows: audit } = await client.query(
    "select action from review_decision where canonical_issue_id = $1",
    [issueId],
  );
  assert.equal(String(audit[0]?.["action"]), "confirm_disputed_resolution");
});

// ---------------------------------------------------------------------------
// D. Reopening
// ---------------------------------------------------------------------------

const confirmedIssue = async () => {
  const { staff, citizenOne, citizenTwo } = await signInAll();
  const participantId = citizenOne.participantId;
  const seeded = await seedIssue(ROUTINE, [participantId]);
  await planWork(staff, seeded.issueId);
  await claim(staff, seeded.issueId, await uploadPhoto(staff));
  await post(citizenOne, `/v1/me/issues/${seeded.reference}/resolution/respond`, {
    decision: "confirmed",
  });
  return { ...seeded, citizenOne, citizenTwo, staff };
};

test("V035 HTTP: reopening needs a reason and reverses the closure", async () => {
  const { reference, issueId, citizenOne } = await confirmedIssue();

  assert.equal(
    (await post(citizenOne, `/v1/me/issues/${reference}/reopen`, { reason: "no" })).status,
    400,
  );

  const reopened = await post(citizenOne, `/v1/me/issues/${reference}/reopen`, {
    reason: "The leak came back two days later at the same joint.",
  });
  assert.equal(reopened.status, 200);
  const body = (await reopened.json()) as Record<string, unknown>;
  assert.equal(body["issue_status"], "reopened");
  assert.equal(body["is_verified_resolution"], false);
  assert.equal(body["counts_as_closed"], false);

  // The reopening is linked to the confirmation it reverses.
  const { rows } = await client.query(
    "select prior_confirmation_id, reason from reopening where issue_id = $1",
    [issueId],
  );
  assert.notEqual(rows[0]?.["prior_confirmation_id"], undefined);
  assert.match(String(rows[0]?.["reason"]), /came back/);
});

test("V035 HTTP: only a counted participant may reopen, and only once", async () => {
  const { reference, citizenOne, citizenTwo } = await confirmedIssue();

  const stranger = await post(citizenTwo, `/v1/me/issues/${reference}/reopen`, {
    reason: "I would like this reopened even though I never reported it.",
  });
  assert.equal(stranger.status, 409);

  assert.equal(
    (
      await post(citizenOne, `/v1/me/issues/${reference}/reopen`, {
        reason: "The leak came back two days later at the same joint.",
      })
    ).status,
    200,
  );
  const twice = await post(citizenOne, `/v1/me/issues/${reference}/reopen`, {
    reason: "Trying to reopen an issue that is already reopened.",
  });
  assert.equal(twice.status, 409);
});

test("V035 HTTP: the reopening shows in the citizen's own history", async () => {
  const { reference, citizenOne } = await confirmedIssue();
  await post(citizenOne, `/v1/me/issues/${reference}/reopen`, {
    reason: "The leak came back two days later at the same joint.",
  });

  const view = (await (await get(citizenOne, `/v1/me/issues/${reference}/resolution`)).json()) as {
    history: Record<string, unknown>[];
  };

  assert.deepEqual(
    view.history.map((entry) => String(entry["kind"])),
    ["resolution_claimed", "confirmed", "reopened"],
    "the whole sequence stays visible to the person who reported it",
  );
  assert.match(String(view.history.at(-1)?.["comment"]), /came back/);
});

test("V035 HTTP: the issue event history stays contiguous through the whole workflow", async () => {
  const { reference, issueId, citizenOne } = await confirmedIssue();
  await post(citizenOne, `/v1/me/issues/${reference}/reopen`, {
    reason: "The leak came back two days later at the same joint.",
  });

  const { rows } = await client.query(
    `select aggregate_version, event_type from status_event
      where aggregate_type = 'canonical_issue' and aggregate_id = $1
      order by aggregate_version`,
    [issueId],
  );
  const versions = rows.map((row) => Number(row["aggregate_version"]));
  assert.deepEqual(
    versions,
    versions.map((_, index) => index + 1),
    "a gap in the version sequence is indistinguishable from a dropped event",
  );
  const types = rows.map((row) => String(row["event_type"]));
  assert.deepEqual(types, [
    "agency_ack_received",
    "work_planned",
    "resolution_claimed",
    "resolution_confirmed",
    "issue_reopened",
  ]);
});
