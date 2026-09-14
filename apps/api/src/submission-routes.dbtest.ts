/**
 * Upload and submission endpoints end to end over HTTP (V016 surface, V018).
 *
 * Drives the real server with `fetch`, against the real database and a real
 * filesystem object store — so what is verified is the whole path a browser
 * takes, not a unit in isolation.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
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
  // Required by buildAppWithDatabase: the supported languages are
  // configuration, never a default in code (V001 Appendix G rule 7).
  SUPPORTED_LOCALES: "en-IN,mr-IN",
} as const;

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 3),
]);

let client: pg.Client;
let server: Server;
let baseUrl: string;
let storeRoot: string;
const createdSubmissions: string[] = [];

before(async () => {
  client = new pg.Client({ connectionString: DATABASE_URL, statement_timeout: 15_000 });
  await client.connect();
  storeRoot = await mkdtemp(join(tmpdir(), "vision-api-uploads-"));
  const objectStore = new FilesystemObjectStoreAdapter({
    root: storeRoot,
    grantHmacKey: "test-only-grant-key",
  });
  const { handler } = buildAppWithDatabase(client, objectStore, TEST_ENV);
  server = createServer((request, response) => {
    void handler(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

after(async () => {
  // Demo login uses stable provider-subject mappings, so repeated test files and
  // interrupted runs may legitimately share the same pseudonymous participant.
  // The participant ids have to come from the submission rows: the API never
  // returns one, because participant_id is L2 (V005 §2). Clean this file's
  // sessions, but retain the stable participant and mapping; deleting either
  // would make teardown order-dependent when another surviving submission still
  // references the same demo principal. `npm run db:reset` clears local identity
  // fixtures when a completely empty development database is required.
  const owners =
    createdSubmissions.length === 0
      ? []
      : (
          await client.query(
            "select distinct participant_id from submission where submission_id = any($1::uuid[])",
            [createdSubmissions],
          )
        ).rows.map((row) => String(row["participant_id"]));

  for (const id of createdSubmissions) {
    await client.query(
      "delete from outbox where event_id in (select event_id from status_event where aggregate_id = $1)",
      [id],
    );
    await client.query("delete from status_event where aggregate_id = $1", [id]);
    await client.query("delete from evidence_item where submission_id = $1", [id]);
    await client.query("delete from submission where submission_id = $1", [id]);
  }
  // Sessions are disposable per run. Identity mappings and participants are
  // stable simulated fixtures and are intentionally retained (see above).
  if (owners.length > 0) {
    await client.query("delete from app_session where participant_id = any($1::uuid[])", [owners]);
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await client.end();
  await rm(storeRoot, { recursive: true, force: true });
});

type Session = { readonly cookie: string; readonly csrf: string };

const login = async (credential: string): Promise<Session> => {
  const response = await fetch(`${baseUrl}/v1/auth/demo-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential }),
  });
  assert.equal(response.status, 200);
  let sessionCookie = "";
  let csrf = "";
  for (const header of response.headers.getSetCookie()) {
    const [pair] = header.split(";");
    if (pair === undefined) continue;
    const eq = pair.indexOf("=");
    const name = pair.slice(0, eq).trim();
    const value = decodeURIComponent(pair.slice(eq + 1));
    if (name === "vision_session") sessionCookie = value;
    if (name === "vision_csrf") csrf = value;
  }
  assert.ok(sessionCookie && csrf);
  return {
    cookie: `vision_session=${encodeURIComponent(sessionCookie)}; vision_csrf=${encodeURIComponent(csrf)}`,
    csrf,
  };
};

const authed = (session: Session, extra: Record<string, string> = {}) => ({
  cookie: session.cookie,
  "x-csrf-token": session.csrf,
  ...extra,
});

/** Full upload dance: grant, PUT bytes, finalize. */
const uploadPhoto = async (session: Session, bytes = JPEG, declared = "image/jpeg") => {
  const grantResponse = await fetch(`${baseUrl}/v1/uploads`, {
    method: "POST",
    headers: authed(session, { "content-type": "application/json" }),
    body: JSON.stringify({ content_type: "image/jpeg", max_bytes: 4096 }),
  });
  assert.equal(grantResponse.status, 201);
  const grant = (await grantResponse.json()) as {
    object_reference: string;
    upload_url: string;
  };

  const putResponse = await fetch(`${baseUrl}${grant.upload_url}`, {
    method: "PUT",
    headers: { cookie: session.cookie, "content-type": declared },
    body: new Uint8Array(bytes),
  });

  return { grant, putResponse };
};

const finalize = (session: Session, reference: string) =>
  fetch(`${baseUrl}/v1/uploads/${encodeURIComponent(reference)}/finalize`, {
    method: "POST",
    headers: authed(session),
  });

const submissionBody = (objectReference?: string) => ({
  observed: {
    lon: 74.56,
    lat: 16.85,
    accuracy_m: 12,
    source: "device_geolocation",
    observed_at: new Date().toISOString(),
  },
  interface_locale: "en-IN",
  language_hint: "en-IN",
  text: "The classroom roof leaks whenever it rains.",
  evidence:
    objectReference === undefined
      ? []
      : [{ object_reference: objectReference, media_type: "photo" }],
});

// ---------------------------------------------------------------------------
// The whole citizen path
// ---------------------------------------------------------------------------

test("V018 API: upload then submit returns a durable receipt", async () => {
  const session = await login(DEMO_PRINCIPALS[0]!.credential);

  const { grant, putResponse } = await uploadPhoto(session);
  assert.equal(putResponse.status, 200);

  const finalized = await finalize(session, grant.object_reference);
  assert.equal(finalized.status, 200);
  assert.equal(((await finalized.json()) as { accepted: boolean }).accepted, true);

  const created = await fetch(`${baseUrl}/v1/submissions`, {
    method: "POST",
    headers: authed(session, {
      "content-type": "application/json",
      "idempotency-key": `api-v018-${Date.now()}`,
    }),
    body: JSON.stringify(submissionBody(grant.object_reference)),
  });

  assert.equal(created.status, 202, "202 accepted for processing, not 200 'done'");
  const receipt = (await created.json()) as {
    submission_id: string;
    status_url: string;
    processing_status: string;
    replayed: boolean;
  };
  createdSubmissions.push(receipt.submission_id);

  assert.equal(receipt.processing_status, "received");
  assert.equal(receipt.replayed, false);

  // The receipt is retrievable at its own status URL.
  const lookup = await fetch(`${baseUrl}${receipt.status_url}`, {
    headers: { cookie: session.cookie },
  });
  assert.equal(lookup.status, 200);
  assert.equal(
    ((await lookup.json()) as { submission_id: string }).submission_id,
    receipt.submission_id,
  );
});

test("V018 API: a retried submit with one Idempotency-Key returns the same receipt", async () => {
  const session = await login(DEMO_PRINCIPALS[1]!.credential);
  const key = `api-v018-retry-${Date.now()}`;
  const body = JSON.stringify(submissionBody());
  const headers = authed(session, {
    "content-type": "application/json",
    "idempotency-key": key,
  });

  const first = await fetch(`${baseUrl}/v1/submissions`, { method: "POST", headers, body });
  const second = await fetch(`${baseUrl}/v1/submissions`, { method: "POST", headers, body });

  assert.equal(first.status, 202);
  assert.equal(second.status, 200, "a replay is not a fresh acceptance");

  const a = (await first.json()) as { submission_id: string; replayed: boolean };
  const b = (await second.json()) as { submission_id: string; replayed: boolean };
  createdSubmissions.push(a.submission_id);

  assert.equal(b.submission_id, a.submission_id);
  assert.equal(b.replayed, true);
});

test("V018 API: a submit without an Idempotency-Key is refused", async () => {
  const session = await login(DEMO_PRINCIPALS[0]!.credential);
  const response = await fetch(`${baseUrl}/v1/submissions`, {
    method: "POST",
    headers: authed(session, { "content-type": "application/json" }),
    body: JSON.stringify(submissionBody()),
  });
  assert.equal(response.status, 400);
  const body = (await response.json()) as { error: { message: string } };
  assert.match(body.error.message, /Idempotency-Key/);
});

test("V018 API: validation issues are returned per field", async () => {
  const session = await login(DEMO_PRINCIPALS[0]!.credential);
  const response = await fetch(`${baseUrl}/v1/submissions`, {
    method: "POST",
    headers: authed(session, {
      "content-type": "application/json",
      "idempotency-key": `api-v018-invalid-${Date.now()}`,
    }),
    body: JSON.stringify({
      ...submissionBody(),
      observed: { lon: 361, lat: -95, accuracy_m: -1, observed_at: new Date().toISOString() },
    }),
  });

  assert.equal(response.status, 400);
  const body = (await response.json()) as { error: { issues: { field: string }[] } };
  const fields = body.error.issues.map((issue) => issue.field);
  assert.ok(fields.includes("observed.lon"));
  assert.ok(fields.includes("observed.lat"));
  assert.ok(fields.includes("observed.accuracy_m"));
});

// ---------------------------------------------------------------------------
// Authorization and CSRF on the new routes
// ---------------------------------------------------------------------------

test("V018 API: every write route requires a session", async () => {
  for (const [method, path] of [
    ["POST", "/v1/uploads"],
    ["POST", "/v1/submissions"],
  ] as const) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(response.status, 403, `${method} ${path} must not proceed without CSRF/session`);
  }
});

test("V018 API: a write route requires the CSRF token even with a session", async () => {
  const session = await login(DEMO_PRINCIPALS[0]!.credential);
  const response = await fetch(`${baseUrl}/v1/uploads`, {
    method: "POST",
    headers: { cookie: session.cookie, "content-type": "application/json" },
    body: JSON.stringify({ content_type: "image/jpeg", max_bytes: 1024 }),
  });
  assert.equal(response.status, 403);
});

test("V018 API: a receipt belonging to another participant is not readable", async () => {
  const owner = await login(DEMO_PRINCIPALS[0]!.credential);
  const created = await fetch(`${baseUrl}/v1/submissions`, {
    method: "POST",
    headers: authed(owner, {
      "content-type": "application/json",
      "idempotency-key": `api-v018-owner-${Date.now()}`,
    }),
    body: JSON.stringify(submissionBody()),
  });
  const receipt = (await created.json()) as { submission_id: string; status_url: string };
  createdSubmissions.push(receipt.submission_id);

  const stranger = await login(DEMO_PRINCIPALS[1]!.credential);
  const response = await fetch(`${baseUrl}${receipt.status_url}`, {
    headers: { cookie: stranger.cookie },
  });
  assert.equal(response.status, 404, "existence must not be confirmed to a stranger");
});

// ---------------------------------------------------------------------------
// Upload validation over HTTP
// ---------------------------------------------------------------------------

test("V016 API: bytes disagreeing with the declared type are refused at finalize", async () => {
  const session = await login(DEMO_PRINCIPALS[0]!.credential);
  const { grant, putResponse } = await uploadPhoto(session, PNG, "image/jpeg");
  assert.equal(putResponse.status, 200);

  const finalized = await finalize(session, grant.object_reference);
  assert.equal(finalized.status, 400);
  const body = (await finalized.json()) as { error: { message: string } };
  assert.match(body.error.message, /declared 'image\/jpeg' but the bytes are image\/png/);
});

test("V016 API: a bad upload token is refused", async () => {
  const session = await login(DEMO_PRINCIPALS[0]!.credential);
  const grantResponse = await fetch(`${baseUrl}/v1/uploads`, {
    method: "POST",
    headers: authed(session, { "content-type": "application/json" }),
    body: JSON.stringify({ content_type: "image/jpeg", max_bytes: 4096 }),
  });
  const grant = (await grantResponse.json()) as { object_reference: string };

  const response = await fetch(
    `${baseUrl}/v1/uploads/${encodeURIComponent(grant.object_reference)}?token=forged`,
    {
      method: "PUT",
      headers: { cookie: session.cookie, "content-type": "image/jpeg" },
      body: new Uint8Array(JPEG),
    },
  );
  assert.equal(response.status, 403);
});

test("V018 API: submitting an unfinalized upload reference is refused", async () => {
  const session = await login(DEMO_PRINCIPALS[0]!.credential);
  const { grant } = await uploadPhoto(session);
  // Bytes are staged but completion was never validated.

  const response = await fetch(`${baseUrl}/v1/submissions`, {
    method: "POST",
    headers: authed(session, {
      "content-type": "application/json",
      "idempotency-key": `api-v018-unfinalized-${Date.now()}`,
    }),
    body: JSON.stringify(submissionBody(grant.object_reference)),
  });

  assert.equal(response.status, 400);
  const body = (await response.json()) as { error: { issues: { code: string }[] } };
  assert.ok(body.error.issues.some((issue) => issue.code === "upload_not_finalized"));
});

test("V016 API: a retried finalize replays rather than creating a second object", async () => {
  const session = await login(DEMO_PRINCIPALS[0]!.credential);
  const { grant } = await uploadPhoto(session);

  const first = await finalize(session, grant.object_reference);
  const second = await finalize(session, grant.object_reference);

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(((await second.json()) as { replayed?: boolean }).replayed, true);
});
