/** Reviewer authentication and HTTP workflow (roadmap V032). */

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

const profileId = "demo-district-a";
const outsideProfileId = "demo-district-b";
const jurisdictionId = randomUUID();
const outsideJurisdictionId = randomUUID();
const jurisdictionCode = `IN-${jurisdictionId.slice(0, 8)}`;
const TEST_ENV = {
  IDENTITY_PROVIDER_MODE: "simulated",
  RECIPIENT_PROVIDER_MODE: "simulated",
  IDENTITY_MAPPING_HMAC_KEY: `review-identity-${randomUUID()}`,
  SESSION_TOKEN_HMAC_KEY: `review-session-${randomUUID()}`,
  SESSION_TTL_SECONDS: "3600",
  SESSION_COOKIE_SECURE: "false",
  SUPPORTED_LOCALES: "en-IN,mr-IN",
  JURISDICTION_PROFILE_ID: profileId,
  REVIEWER_JURISDICTION_CODES: jurisdictionCode,
} as const;

let client: pg.Client;
let server: Server;
let baseUrl: string;
let storeRoot: string;
let objectStore: FilesystemObjectStoreAdapter;
let reviewerParticipantId: string | undefined;
let reviewerStaffId: string | undefined;
const reporterParticipants: string[] = [];
const submissions: string[] = [];
const issues: string[] = [];

before(async () => {
  client = new pg.Client({ connectionString: DATABASE_URL, statement_timeout: 15_000 });
  await client.connect();
  await client.query(
    `insert into jurisdiction
       (jurisdiction_id, jurisdiction_profile_id, internal_code, directory_version,
        level_scheme, level_code, effective_from, synthetic_provenance)
     values ($1,$2,$3,'review-http-directory.v1','review-http-scheme','district',
             now() - interval '1 day',true),
            ($4,$5,$6,'review-http-directory.v1','review-http-scheme','district',
             now() - interval '1 day',true)`,
    [
      jurisdictionId,
      profileId,
      jurisdictionCode,
      outsideJurisdictionId,
      outsideProfileId,
      `OUT-${outsideJurisdictionId.slice(0, 8)}`,
    ],
  );
  storeRoot = await mkdtemp(join(tmpdir(), "vision-review-http-"));
  objectStore = new FilesystemObjectStoreAdapter({
    root: storeRoot,
    grantHmacKey: "review-http-object-key",
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
    if (submissions.length > 0) {
      await cleaner.query(
        `delete from private_evidence_access_log
          where evidence_id in
                (select evidence_id from evidence_item where submission_id = any($1::uuid[]))`,
        [submissions],
      );
      await cleaner.query(
        `delete from review_decision
          where evidence_id in
                (select evidence_id from evidence_item where submission_id = any($1::uuid[]))`,
        [submissions],
      );
      await cleaner.query(
        `delete from issue_evidence_link
          where evidence_id in
                (select evidence_id from evidence_item where submission_id = any($1::uuid[]))`,
        [submissions],
      );
      await cleaner.query("delete from evidence_item where submission_id = any($1::uuid[])", [
        submissions,
      ]);
      await cleaner.query("delete from submission where submission_id = any($1::uuid[])", [
        submissions,
      ]);
    }
    if (issues.length > 0) {
      await cleaner.query("delete from canonical_issue where issue_id = any($1::uuid[])", [issues]);
    }
    if (reviewerStaffId !== undefined) {
      await cleaner.query("delete from staff_jurisdiction_grant where staff_id = $1", [
        reviewerStaffId,
      ]);
      await cleaner.query("delete from staff_account where staff_id = $1", [reviewerStaffId]);
    }
    if (reviewerParticipantId !== undefined) {
      await cleaner.query("delete from app_session where participant_id = $1", [
        reviewerParticipantId,
      ]);
      await cleaner.query("delete from identity_mapping where participant_id = $1", [
        reviewerParticipantId,
      ]);
    }
    const participants = [
      ...reporterParticipants,
      ...(reviewerParticipantId === undefined ? [] : [reviewerParticipantId]),
    ];
    if (participants.length > 0) {
      await cleaner.query("delete from participant where participant_id = any($1::uuid[])", [
        participants,
      ]);
    }
    await cleaner.query("delete from jurisdiction where jurisdiction_id = any($1::uuid[])", [
      [jurisdictionId, outsideJurisdictionId],
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

const loginReviewer = async () => {
  const response = await fetch(`${baseUrl}/v1/reviewer/auth/demo-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential: "demo-reviewer-one" }),
  });
  const grant = await client.query(
    `select a.staff_id, a.participant_id
       from staff_account a
       join staff_jurisdiction_grant g on g.staff_id = a.staff_id
      where g.jurisdiction_id = $1 and a.role = 'reviewer'`,
    [jurisdictionId],
  );
  reviewerStaffId = String(grant.rows[0]?.["staff_id"] ?? "");
  reviewerParticipantId = String(grant.rows[0]?.["participant_id"] ?? "");
  return {
    response,
    cookies: cookieJar(response),
    csrf: cookieValue(response, "vision_reviewer_csrf"),
  };
};

const pendingRedaction = async (): Promise<{ evidenceId: string; targetId: string }> => {
  const participantId = randomUUID();
  reporterParticipants.push(participantId);
  await client.query("insert into participant (participant_id) values ($1)", [participantId]);
  const submissionId = randomUUID();
  submissions.push(submissionId);
  await client.query(
    `insert into submission
       (submission_id, participant_id, observed_location, observed_accuracy_m,
        observed_location_source, observed_at, interface_locale, locale_pack_version,
        taxonomy_version, idempotency_key)
     values ($1,$2,ST_SetSRID(ST_MakePoint(74.55,16.85),4326)::geography,10,
             'device_geolocation',now(),'en-IN','demo-locales.v1','demo-taxonomy.v1',$3)`,
    [submissionId, participantId, `review-http-${submissionId}`],
  );
  const issueId = randomUUID();
  issues.push(issueId);
  await client.query(
    `insert into canonical_issue
       (issue_id, public_reference, category, current_status, opened_at,
        representative_location, last_evidence_at, jurisdiction_id)
     values ($1,$2,'sanitation','created',now(),
             ST_SetSRID(ST_MakePoint(74.55,16.85),4326)::geography,now(),$3)`,
    [issueId, `VIS-${issueId.slice(0, 8).toUpperCase()}`, jurisdictionId],
  );
  const evidenceId = randomUUID();
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  const context = {
    correlation_id: randomUUID() as never,
    idempotency_key: `review-http-${randomUUID()}` as never,
    idempotency_scope: `review-http:${participantId}` as never,
    request_fingerprint: `sha256:${"a".repeat(64)}` as never,
  };
  const grant = await objectStore.createUploadGrant(
    {
      intended_content_type: "image/png",
      max_bytes: png.byteLength,
      owner_pseudonym: participantId as never,
    },
    context,
  );
  assert.equal(grant.kind, "success");
  if (grant.kind !== "success") assert.fail("expected an upload grant");
  const token = new URL(grant.value.upload_url, "http://localhost").searchParams.get("token") ?? "";
  assert.deepEqual(
    await objectStore.putStagedObject(grant.value.object_reference, token, png, "image/png"),
    { ok: true },
  );
  const finalized = await objectStore.finalizeUpload(grant.value.object_reference, context);
  assert.equal(finalized.kind, "success");
  await client.query(
    `insert into evidence_item
       (evidence_id, submission_id, media_type, object_reference, fingerprint_hash,
        redaction_status, processing_status)
     values ($1,$2,'photo',$3,$4,'needs_review','needs_review')`,
    [
      evidenceId,
      submissionId,
      grant.value.object_reference,
      objectStore.fingerprintOf(grant.value.object_reference),
    ],
  );
  await client.query(
    `insert into issue_evidence_link
       (issue_evidence_link_id, evidence_id, canonical_issue_id, effective_from)
     values ($1,$2,$3,now())`,
    [randomUUID(), evidenceId, issueId],
  );
  return { evidenceId, targetId: evidenceId };
};

test("V032: the reviewer capability exposes only a simulated reviewer fixture", async () => {
  const response = await fetch(`${baseUrl}/v1/reviewer/capabilities`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    identity_label: string;
    demo_principals: { credential: string }[];
  };
  assert.match(body.identity_label, /simulated/i);
  assert.deepEqual(
    body.demo_principals.map((row) => row.credential),
    ["demo-reviewer-one"],
  );
});

test("V032: the citizen fixture cannot enter the reviewer surface", async () => {
  const response = await fetch(`${baseUrl}/v1/reviewer/auth/demo-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential: "demo-citizen-one" }),
  });
  assert.equal(response.status, 401);
});

test("V032: login issues a separate session backed by a durable reviewer grant", async () => {
  const login = await loginReviewer();
  assert.equal(login.response.status, 200);
  assert.ok(login.cookies.includes("vision_reviewer_session="));
  assert.ok(login.csrf.length > 0);
  const body = (await login.response.json()) as Record<string, unknown>;
  assert.equal(body["role"], "reviewer");
  assert.equal(body["staff_id"], undefined);
  assert.equal(body["participant_id"], undefined);

  const scopes = await client.query(
    "select jurisdiction_id from staff_jurisdiction_grant where staff_id = $1 and revoked_at is null",
    [reviewerStaffId],
  );
  assert.ok(scopes.rows.some((row) => String(row["jurisdiction_id"]) === jurisdictionId));
  assert.equal(
    scopes.rows.some((row) => String(row["jurisdiction_id"]) === outsideJurisdictionId),
    false,
  );
});

test("V032: a queue requires a reviewer session and enforces its stored scope", async () => {
  const missing = await fetch(
    `${baseUrl}/v1/reviewer/queue?jurisdiction_id=${encodeURIComponent(jurisdictionId)}`,
  );
  assert.equal(missing.status, 401);

  const login = await loginReviewer();
  const outside = await fetch(
    `${baseUrl}/v1/reviewer/queue?jurisdiction_id=${encodeURIComponent(outsideJurisdictionId)}`,
    { headers: { cookie: login.cookies } },
  );
  assert.equal(outside.status, 403);
});

test("V032: an HTTP decision requires CSRF, a queue item and a reasoned audit row", async () => {
  const { evidenceId, targetId } = await pendingRedaction();
  const login = await loginReviewer();
  const queueResponse = await fetch(
    `${baseUrl}/v1/reviewer/queue?jurisdiction_id=${encodeURIComponent(jurisdictionId)}`,
    { headers: { cookie: login.cookies } },
  );
  assert.equal(queueResponse.status, 200);
  const queueText = await queueResponse.text();
  assert.doesNotMatch(queueText, /originals\/review-http/);
  assert.doesNotMatch(queueText, /decisionTarget|evidenceId/);
  const queue = JSON.parse(queueText) as {
    items: { kind: string; target_id: string; permitted_actions: string[] }[];
  };
  const item = queue.items.find((candidate) => candidate.target_id === targetId);
  assert.equal(item?.kind, "redaction_decision");
  assert.ok(item?.permitted_actions.includes("approve_redaction"));

  const path = `${baseUrl}/v1/reviewer/queue/redaction_decision/${targetId}/decisions`;
  const body = JSON.stringify({
    action: "approve_redaction",
    reason: "No face or number plate is visible in the submitted photograph.",
    jurisdiction_id: jurisdictionId,
  });
  const withoutCsrf = await fetch(path, {
    method: "POST",
    headers: { cookie: login.cookies, "content-type": "application/json" },
    body,
  });
  assert.equal(withoutCsrf.status, 403);

  const decided = await fetch(path, {
    method: "POST",
    headers: {
      cookie: login.cookies,
      "content-type": "application/json",
      "x-csrf-token": login.csrf,
    },
    body,
  });
  assert.equal(decided.status, 200);
  const result = (await decided.json()) as { decision_id: string; prior_state: unknown };
  assert.ok(result.decision_id.length > 0);

  const evidence = await client.query(
    "select redaction_status from evidence_item where evidence_id = $1",
    [evidenceId],
  );
  assert.equal(evidence.rows[0]?.["redaction_status"], "approved");
  const audit = await client.query(
    "select reason, reviewer_id, prior_state from review_decision where decision_id = $1",
    [result.decision_id],
  );
  assert.equal(String(audit.rows[0]?.["reviewer_id"]), reviewerStaffId);
  assert.match(String(audit.rows[0]?.["reason"]), /number plate/);
  assert.equal(
    (audit.rows[0]?.["prior_state"] as Record<string, unknown>)["redaction_status"],
    "needs_review",
  );

  const replay = await fetch(path, {
    method: "POST",
    headers: {
      cookie: login.cookies,
      "content-type": "application/json",
      "x-csrf-token": login.csrf,
    },
    body,
  });
  assert.equal(replay.status, 409, "a row that left the queue cannot be decided again");
});

test("V032: private-original access requires a purpose and appends an access audit", async () => {
  const { targetId } = await pendingRedaction();
  const login = await loginReviewer();
  const path = `${baseUrl}/v1/reviewer/queue/redaction_decision/${targetId}/original?jurisdiction_id=${encodeURIComponent(jurisdictionId)}`;

  const withoutPurpose = await fetch(path, { headers: { cookie: login.cookies } });
  assert.equal(withoutPurpose.status, 400);

  const opened = await fetch(path, {
    headers: {
      cookie: login.cookies,
      "x-access-purpose": "Reviewing a pending redaction decision",
    },
  });
  assert.equal(opened.status, 200);
  assert.equal(opened.headers.get("content-type"), "image/png");
  assert.match(opened.headers.get("cache-control") ?? "", /no-store/);
  assert.deepEqual(
    Buffer.from(await opened.arrayBuffer()).subarray(0, 8),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );

  const audit = await client.query(
    `select staff_id, session_id, jurisdiction_id, purpose
       from private_evidence_access_log where evidence_id = $1`,
    [targetId],
  );
  assert.equal(audit.rows.length, 1);
  assert.equal(String(audit.rows[0]?.["staff_id"]), reviewerStaffId);
  assert.equal(String(audit.rows[0]?.["jurisdiction_id"]), jurisdictionId);
  assert.match(String(audit.rows[0]?.["purpose"]), /redaction/);
  assert.notEqual(audit.rows[0]?.["session_id"], null);
});

test("V032: a valid reviewer cannot act on an arbitrary target outside the queue", async () => {
  const login = await loginReviewer();
  const response = await fetch(
    `${baseUrl}/v1/reviewer/queue/redaction_decision/${randomUUID()}/decisions`,
    {
      method: "POST",
      headers: {
        cookie: login.cookies,
        "content-type": "application/json",
        "x-csrf-token": login.csrf,
      },
      body: JSON.stringify({
        action: "approve_redaction",
        reason: "This target was never present in the current review queue.",
        jurisdiction_id: jurisdictionId,
      }),
    },
  );
  assert.equal(response.status, 409);
});
