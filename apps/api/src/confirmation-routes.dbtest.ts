/**
 * Citizen confirmation endpoints (roadmap V031).
 *
 * Run with: npm run db:up && npm run db:migrate && npm run test:db
 *
 * These are the first citizen *writes* since submission, so they carry the
 * same protections: a session, a CSRF token, and ownership of the report being
 * decided. A confirmation that anyone could post for anyone else would let a
 * stranger attach someone's evidence to an issue of their choosing.
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

import { DEMO_PRINCIPALS, FilesystemObjectStoreAdapter } from "@vision/adapters";

import { buildAppWithDatabase } from "./server.ts";

const DATABASE_URL =
  process.env["DATABASE_URL"] ??
  "postgresql://vision:vision_local_dev_only@127.0.0.1:5432/vision_dev";

const TEST_ENV = {
  IDENTITY_PROVIDER_MODE: "simulated",
  RECIPIENT_PROVIDER_MODE: "simulated",
  IDENTITY_MAPPING_HMAC_KEY: "test-only-identity-key",
  SESSION_TOKEN_HMAC_KEY: "test-only-session-key",
  SESSION_TTL_SECONDS: "3600",
  SESSION_COOKIE_SECURE: "false",
  SUPPORTED_LOCALES: "en-IN,mr-IN",
} as const;

let client: pg.Client;
let server: Server;
let baseUrl: string;
let storeRoot: string;
const issues: string[] = [];
const submissions: string[] = [];

const ORIGIN = { lon: 75.11, lat: 17.31 };

before(async () => {
  client = new pg.Client({ connectionString: DATABASE_URL, statement_timeout: 15_000 });
  await client.connect();
  storeRoot = await mkdtemp(join(tmpdir(), "vision-cf-"));
  const store = new FilesystemObjectStoreAdapter({
    root: storeRoot,
    grantHmacKey: "test-only-key",
  });
  const { handler } = buildAppWithDatabase(client, store, TEST_ENV);
  server = createServer((request, response) => void handler(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await client.end().catch(() => undefined);
  const cleaner = new pg.Client({ connectionString: DATABASE_URL, statement_timeout: 10_000 });
  await cleaner.connect();
  try {
    if (submissions.length > 0) {
      await cleaner.query("delete from correction_request where submission_id = any($1::uuid[])", [
        submissions,
      ]);
      await cleaner.query(
        "delete from issue_evidence_link where evidence_id in (select evidence_id from evidence_item where submission_id = any($1::uuid[]))",
        [submissions],
      );
      await cleaner.query("delete from issue_match where submission_id = any($1::uuid[])", [
        submissions,
      ]);
      await cleaner.query("delete from evidence_item where submission_id = any($1::uuid[])", [
        submissions,
      ]);
    }
    if (issues.length > 0) {
      await cleaner.query(
        "delete from issue_participation where canonical_issue_id = any($1::uuid[])",
        [issues],
      );
    }
    if (submissions.length > 0) {
      await cleaner.query("delete from submission where submission_id = any($1::uuid[])", [
        submissions,
      ]);
    }
    if (issues.length > 0) {
      await cleaner.query("delete from canonical_issue where issue_id = any($1::uuid[])", [issues]);
    }
  } finally {
    await cleaner.end();
  }
  await rm(storeRoot, { recursive: true, force: true });
});

const login = async (credential: string) => {
  const response = await fetch(`${baseUrl}/v1/auth/demo-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential }),
  });
  const raw = response.headers.getSetCookie();
  const cookies = raw.map((header) => header.split(";")[0]).join("; ");
  const csrf = raw
    .map((header) => header.split(";")[0] ?? "")
    .find((pair) => pair.startsWith("vision_csrf="));
  // The login response deliberately withholds `participant_id`: it is L2 data
  // and is not returned to the client (V005 §2). The test resolves it from the
  // session row it just created, which is why logins here are sequential.
  const session = await client.query(
    "select participant_id from app_session order by issued_at desc, session_id desc limit 1",
  );
  return {
    cookies,
    csrf: decodeURIComponent((csrf ?? "").split("=")[1] ?? ""),
    participantId: String(session.rows[0]?.["participant_id"] ?? ""),
  };
};

const newIssue = async (): Promise<string> => {
  const issueId = randomUUID();
  await client.query(
    `insert into canonical_issue
       (issue_id, public_reference, category, current_status, opened_at,
        representative_location, last_evidence_at)
     values ($1,$2,'sanitation','created', now(),
             ST_SetSRID(ST_MakePoint($3,$4),4326)::geography, now())`,
    [issueId, `VIS-${issueId.slice(0, 8).toUpperCase()}`, ORIGIN.lon, ORIGIN.lat],
  );
  issues.push(issueId);
  return issueId;
};

const newSubmissionFor = async (participantId: string): Promise<string> => {
  const submissionId = randomUUID();
  await client.query(
    `insert into submission
       (submission_id, participant_id, observed_location, observed_accuracy_m,
        observed_location_source, observed_at, interface_locale, locale_pack_version,
        taxonomy_version, idempotency_key)
     values ($1,$2, ST_SetSRID(ST_MakePoint($3,$4),4326)::geography, 12,
             'device_geolocation', now(), 'en-IN','demo-locales.v1','demo-taxonomy.v1',$5)`,
    [submissionId, participantId, ORIGIN.lon, ORIGIN.lat, `r31-${submissionId}`],
  );
  submissions.push(submissionId);
  await client.query(
    `insert into evidence_item (evidence_id, submission_id, media_type, content_text)
     values ($1,$2,'text','The drain outside the school gate is blocked.')`,
    [randomUUID(), submissionId],
  );
  return submissionId;
};

test("V031: the candidate question requires a session", async () => {
  const issueId = await newIssue();

  const response = await fetch(`${baseUrl}/v1/me/submissions/${randomUUID()}/candidate/${issueId}`);

  assert.equal(response.status, 401);
});

test("V031: a citizen sees the candidate for their own report", async () => {
  const session = await login(DEMO_PRINCIPALS[0]?.credential ?? "");
  const issueId = await newIssue();
  const submissionId = await newSubmissionFor(session.participantId ?? "");

  const response = await fetch(
    `${baseUrl}/v1/me/submissions/${submissionId}/candidate/${issueId}`,
    { headers: { cookie: session.cookies } },
  );

  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    candidate: { public_reference: string; entry_count: number; preview_derivatives: string[] };
  };
  assert.ok(body.candidate.public_reference.startsWith("VIS-"));
  assert.equal(body.candidate.preview_derivatives.length, 0);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("V031: confirming requires a CSRF token", async () => {
  const session = await login(DEMO_PRINCIPALS[0]?.credential ?? "");
  const issueId = await newIssue();
  const submissionId = await newSubmissionFor(session.participantId ?? "");

  const response = await fetch(`${baseUrl}/v1/me/submissions/${submissionId}/confirm-match`, {
    method: "POST",
    headers: { cookie: session.cookies, "content-type": "application/json" },
    body: JSON.stringify({ candidate_issue_id: issueId }),
  });

  assert.equal(response.status, 403);
});

test("V031: confirming attaches the evidence and reports the issue", async () => {
  const session = await login(DEMO_PRINCIPALS[0]?.credential ?? "");
  const issueId = await newIssue();
  const submissionId = await newSubmissionFor(session.participantId ?? "");

  const response = await fetch(`${baseUrl}/v1/me/submissions/${submissionId}/confirm-match`, {
    method: "POST",
    headers: {
      cookie: session.cookies,
      "content-type": "application/json",
      "x-csrf-token": session.csrf,
    },
    body: JSON.stringify({ candidate_issue_id: issueId }),
  });

  assert.equal(response.status, 200);
  const body = (await response.json()) as { status: string; issue_id: string };
  assert.equal(body.status, "attached");
  assert.equal(body.issue_id, issueId);
});

test("V031: confirming someone else's report is refused", async () => {
  const owner = await login(DEMO_PRINCIPALS[0]?.credential ?? "");
  const stranger = await login(DEMO_PRINCIPALS[1]?.credential ?? "");
  const issueId = await newIssue();
  const submissionId = await newSubmissionFor(owner.participantId ?? "");

  const response = await fetch(`${baseUrl}/v1/me/submissions/${submissionId}/confirm-match`, {
    method: "POST",
    headers: {
      cookie: stranger.cookies,
      "content-type": "application/json",
      "x-csrf-token": stranger.csrf,
    },
    body: JSON.stringify({ candidate_issue_id: issueId }),
  });

  // Indistinguishable from "no such report", so a stranger cannot probe which
  // submission ids exist.
  assert.equal(response.status, 404);
});

test("V031: rejecting opens a new issue and asks for no category", async () => {
  const session = await login(DEMO_PRINCIPALS[0]?.credential ?? "");
  const issueId = await newIssue();
  const submissionId = await newSubmissionFor(session.participantId ?? "");

  const response = await fetch(`${baseUrl}/v1/me/submissions/${submissionId}/reject-match`, {
    method: "POST",
    headers: {
      cookie: session.cookies,
      "content-type": "application/json",
      "x-csrf-token": session.csrf,
    },
    body: JSON.stringify({
      candidate_issue_id: issueId,
      citizen_note: "It is the tap by the gate, not the drain.",
    }),
  });

  assert.equal(response.status, 200);
  const body = (await response.json()) as { status: string; issue_id: string };
  assert.equal(body.status, "new_issue");
  issues.push(body.issue_id);
});

test("V031: a reject body carrying a category is refused", async () => {
  // The citizen is answering "is this the same problem?", not choosing a
  // department. Accepting a category here would quietly reintroduce the
  // requirement V031 exists to remove.
  const session = await login(DEMO_PRINCIPALS[0]?.credential ?? "");
  const issueId = await newIssue();
  const submissionId = await newSubmissionFor(session.participantId ?? "");

  const response = await fetch(`${baseUrl}/v1/me/submissions/${submissionId}/reject-match`, {
    method: "POST",
    headers: {
      cookie: session.cookies,
      "content-type": "application/json",
      "x-csrf-token": session.csrf,
    },
    body: JSON.stringify({ candidate_issue_id: issueId, category: "structural" }),
  });

  assert.equal(response.status, 400);
});

test("V031: a candidate view for someone else's report is refused", async () => {
  // Presenting it would disclose where another person's report was made,
  // which is the location V030 deliberately coarsens even in public views.
  const owner = await login(DEMO_PRINCIPALS[0]?.credential ?? "");
  const submissionId = await newSubmissionFor(owner.participantId ?? "");
  const issueId = await newIssue();
  const stranger = await login(DEMO_PRINCIPALS[1]?.credential ?? "");

  const response = await fetch(
    `${baseUrl}/v1/me/submissions/${submissionId}/candidate/${issueId}`,
    { headers: { cookie: stranger.cookies } },
  );

  assert.equal(response.status, 404);
  assert.doesNotMatch(await response.text(), /VIS-/, "no reference may leak in the refusal");
});

test("V031: a decision with no candidate is refused rather than guessed", async () => {
  const session = await login(DEMO_PRINCIPALS[0]?.credential ?? "");
  const submissionId = await newSubmissionFor(session.participantId ?? "");

  for (const body of [{}, { candidate_issue_id: "" }, { candidate_issue_id: 42 }]) {
    const response = await fetch(`${baseUrl}/v1/me/submissions/${submissionId}/confirm-match`, {
      method: "POST",
      headers: {
        cookie: session.cookies,
        "content-type": "application/json",
        "x-csrf-token": session.csrf,
      },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 400, `${JSON.stringify(body)} must be refused`);
  }
});
