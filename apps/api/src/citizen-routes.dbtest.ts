/**
 * Citizen read endpoints over real HTTP (roadmap V030).
 *
 * Run with: npm run db:up && npm run db:migrate && npm run test:db
 *
 * The read models are covered in `citizen-views.dbtest.ts`. What is asserted
 * here is the part only the HTTP layer decides: which endpoints need a
 * session, which are public, and that a private endpoint cannot be reached by
 * guessing an id.
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

const ORIGIN = { lon: 74.91, lat: 17.11 };

before(async () => {
  client = new pg.Client({ connectionString: DATABASE_URL, statement_timeout: 15_000 });
  await client.connect();
  storeRoot = await mkdtemp(join(tmpdir(), "vision-cr-"));
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
      await cleaner.query(
        "delete from issue_evidence_link where evidence_id in (select evidence_id from evidence_item where submission_id = any($1::uuid[]))",
        [submissions],
      );
      await cleaner.query("delete from evidence_item where submission_id = any($1::uuid[])", [
        submissions,
      ]);
      await cleaner
        .query(
          "delete from submission_participant_idempotency where submission_id = any($1::uuid[])",
          [submissions],
        )
        .catch(() => undefined);
      await cleaner.query("delete from submission where submission_id = any($1::uuid[])", [
        submissions,
      ]);
    }
    if (issues.length > 0) {
      await cleaner.query(
        "delete from issue_participation where canonical_issue_id = any($1::uuid[])",
        [issues],
      );
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
  const cookies = response.headers
    .getSetCookie()
    .map((header) => header.split(";")[0])
    .join("; ");
  return { cookies, status: response.status };
};

const newIssue = async (metresEast: number, category = "sanitation"): Promise<string> => {
  const issueId = randomUUID();
  const lon = ORIGIN.lon + metresEast / (111_320 * Math.cos((ORIGIN.lat * Math.PI) / 180));
  await client.query(
    `insert into canonical_issue
       (issue_id, public_reference, category, current_status, opened_at,
        representative_location, last_evidence_at)
     values ($1,$2,$3,'created', now(), ST_SetSRID(ST_MakePoint($4,$5),4326)::geography, now())`,
    [issueId, `VIS-${issueId.slice(0, 8).toUpperCase()}`, category, lon, ORIGIN.lat],
  );
  issues.push(issueId);
  return issueId;
};

// ---------------------------------------------------------------------------
// Private endpoints need a session
// ---------------------------------------------------------------------------

test("V030: my reports requires a session", async () => {
  const response = await fetch(`${baseUrl}/v1/me/reports`);

  assert.equal(response.status, 401);
});

test("V030: my reports returns an empty list for a fresh demo session", async () => {
  const { cookies } = await login(DEMO_PRINCIPALS[0]?.credential ?? "");

  const response = await fetch(`${baseUrl}/v1/me/reports`, { headers: { cookie: cookies } });

  assert.equal(response.status, 200);
  const body = (await response.json()) as { reports: unknown[]; next_cursor?: string };
  assert.ok(Array.isArray(body.reports));
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("V030: my reports never sets a cacheable header for private data", async () => {
  const { cookies } = await login(DEMO_PRINCIPALS[0]?.credential ?? "");

  const response = await fetch(`${baseUrl}/v1/me/reports`, { headers: { cookie: cookies } });

  // A shared cache holding one citizen's report list would serve it to the
  // next person through the same proxy.
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
});

// ---------------------------------------------------------------------------
// Public discovery
// ---------------------------------------------------------------------------

test("V030: nearby discovery is public and needs no session", async () => {
  await newIssue(20);

  const response = await fetch(
    `${baseUrl}/v1/issues/nearby?lon=${String(ORIGIN.lon)}&lat=${String(ORIGIN.lat)}&radius_m=500`,
  );

  assert.equal(response.status, 200);
  const body = (await response.json()) as { issues: { public_reference: string }[]; note: string };
  assert.ok(body.issues.length >= 1);
  assert.ok(body.note.length > 0, "the bounded-search note must reach the caller");
});

test("V030: discovery rejects a missing or unusable position rather than guessing one", async () => {
  for (const query of ["", "?lon=abc&lat=1", "?lon=200&lat=100", "?lat=17"]) {
    const response = await fetch(`${baseUrl}/v1/issues/nearby${query}`);
    assert.equal(response.status, 400, `${query} must be refused`);
  }
});

test("V030: discovery paginates with an opaque cursor", async () => {
  const category = `http-${randomUUID().slice(0, 6)}`;
  await newIssue(10, category);
  await newIssue(12, category);

  const first = await fetch(
    `${baseUrl}/v1/issues/nearby?lon=${String(ORIGIN.lon)}&lat=${String(ORIGIN.lat)}&radius_m=500&category=${category}&limit=1`,
  );
  const firstBody = (await first.json()) as { issues: unknown[]; next_cursor?: string };
  assert.equal(firstBody.issues.length, 1);
  assert.ok(firstBody.next_cursor !== undefined);

  const second = await fetch(
    `${baseUrl}/v1/issues/nearby?lon=${String(ORIGIN.lon)}&lat=${String(ORIGIN.lat)}&radius_m=500&category=${category}&limit=1&cursor=${encodeURIComponent(firstBody.next_cursor ?? "")}`,
  );
  const secondBody = (await second.json()) as { issues: unknown[] };
  assert.equal(secondBody.issues.length, 1);
});

test("V030: a corrupt cursor is refused rather than silently ignored", async () => {
  const response = await fetch(
    `${baseUrl}/v1/issues/nearby?lon=${String(ORIGIN.lon)}&lat=${String(ORIGIN.lat)}&cursor=%00%01not-base64`,
  );

  assert.equal(response.status, 400);
});

// ---------------------------------------------------------------------------
// Issue detail
// ---------------------------------------------------------------------------

test("V030: an issue detail is public and carries its disclosures", async () => {
  const issueId = await newIssue(15);
  const { rows } = await client.query(
    "select public_reference from canonical_issue where issue_id = $1",
    [issueId],
  );
  const reference = String(rows[0]?.["public_reference"]);

  const response = await fetch(`${baseUrl}/v1/issues/${encodeURIComponent(reference)}`);

  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    public_reference: string;
    disclosures: string[];
    assignment: { is_live: boolean };
  };
  assert.equal(body.public_reference, reference);
  assert.ok(body.disclosures.length > 0);
  assert.equal(body.assignment.is_live, false);
});

test("V030: an issue is addressed by its public reference, never by its internal id", async () => {
  const issueId = await newIssue(15);

  // The internal uuid must not be a working address: it appears in no public
  // payload, and accepting it would make the public reference decorative.
  const response = await fetch(`${baseUrl}/v1/issues/${issueId}`);

  assert.equal(response.status, 404);
});

test("V030: an unknown reference is a plain not-found", async () => {
  const response = await fetch(`${baseUrl}/v1/issues/VIS-DOESNOTEXIST`);

  assert.equal(response.status, 404);
});

test("V030: a write method is never answered by a read endpoint", async () => {
  // These paths are reads. Answering a POST on one would mean a caller could
  // believe it had changed something when nothing happened.
  const { cookies } = await login(DEMO_PRINCIPALS[0]?.credential ?? "");

  for (const [path, headers] of [
    ["/v1/me/reports", { cookie: cookies }],
    [`/v1/issues/nearby?lon=${String(ORIGIN.lon)}&lat=${String(ORIGIN.lat)}`, {}],
    ["/v1/issues/VIS-ANYTHING", {}],
  ] as const) {
    const response = await fetch(`${baseUrl}${path}`, { method: "POST", headers });
    assert.notEqual(response.status, 200, `POST ${path} must not be answered as a read`);
  }
});

// ---------------------------------------------------------------------------
// Media: approved derivatives only
// ---------------------------------------------------------------------------

test("V030: a private original is never served, whatever the path", async () => {
  for (const path of [
    "/v1/media/originals/2026-09/anything",
    "/v1/media/staging/2026-09/anything",
    "/v1/media/quarantine/2026-09/anything",
    "/v1/media/../originals/2026-09/anything",
    "/v1/media/derivatives/../originals/2026-09/anything",
  ]) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.notEqual(response.status, 200, `${path} must not serve bytes`);
  }
});

test("V030: an approved derivative is served to anyone", async () => {
  // Public by design: an approved derivative is the redacted, publishable
  // form, and requiring an account to see it would defeat the point.
  const reference = `2026-09/${randomUUID()}`;
  const store = new FilesystemObjectStoreAdapter({
    root: storeRoot,
    grantHmacKey: "test-only-key",
  });
  await store.writeApprovedDerivative(reference, Buffer.from([0x89, 0x50, 0x4e, 0x47]), "approved");

  const response = await fetch(`${baseUrl}/v1/media/derivatives/${reference}`);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.equal((await response.arrayBuffer()).byteLength, 4);
});

test("V030: a derivative that does not exist is a plain not-found", async () => {
  const response = await fetch(`${baseUrl}/v1/media/derivatives/2026-09/${randomUUID()}`);

  assert.equal(response.status, 404);
});

test("V030: a derivative whose bytes are not a recognised image is not served", async () => {
  // An unidentifiable file handed to a browser is how a stored object becomes
  // active content. The type comes from the bytes, never from the path.
  const reference = `2026-09/${randomUUID()}`;
  const store = new FilesystemObjectStoreAdapter({
    root: storeRoot,
    grantHmacKey: "test-only-key",
  });
  await store.writeApprovedDerivative(
    reference,
    Buffer.from("<svg onload=alert(1)></svg>", "utf8"),
    "approved",
  );

  const response = await fetch(`${baseUrl}/v1/media/derivatives/${reference}`);

  assert.equal(response.status, 404);
  assert.doesNotMatch(await response.text(), /svg|onload/i);
});

test("V030: a served derivative carries headers that keep it inert", async () => {
  const reference = `2026-09/${randomUUID()}`;
  const store = new FilesystemObjectStoreAdapter({
    root: storeRoot,
    grantHmacKey: "test-only-key",
  });
  await store.writeApprovedDerivative(
    reference,
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    "approved",
  );

  const response = await fetch(`${baseUrl}/v1/media/derivatives/${reference}`);

  assert.equal(response.status, 200);
  // Without nosniff a browser may re-interpret the bytes as something
  // executable regardless of the declared type.
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(response.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  assert.match(response.headers.get("referrer-policy") ?? "", /no-referrer/);
});

// ---------------------------------------------------------------------------
// The discovery filter's options come from the taxonomy pack (V030)
// ---------------------------------------------------------------------------

test("V030: the taxonomy endpoint serves the categories a citizen can filter by", async () => {
  // V030 recorded that "discovery's category filter is populated with no
  // options until a taxonomy pack is loaded, so it currently shows only 'All
  // categories'". The pack exists now (V023), so the browser can be told what
  // it holds.
  const response = await fetch(`${baseUrl}/v1/taxonomy`);
  const body = (await response.json()) as {
    taxonomy_version?: string;
    categories?: { id: string; label: string }[];
    note?: string;
  };

  assert.equal(response.status, 200);
  assert.equal(body.taxonomy_version, "demo-taxonomy.v1");
  assert.ok((body.categories ?? []).some((category) => category.id === "sanitation"));
});

test("V030: the taxonomy endpoint needs no session, because discovery is public", async () => {
  // Discovery is public (V030), so requiring a session to populate its filter
  // would make the filter unusable for exactly the people browsing without
  // signing in.
  const response = await fetch(`${baseUrl}/v1/taxonomy`);
  assert.equal(response.status, 200);
});

test("V030: the taxonomy endpoint carries the pack's caveat, not a bare list", async () => {
  // The note says these identifiers are generic and correspond to no
  // authority's own scheme. Serving the list without it would let the
  // interface imply a correspondence nobody has verified.
  const response = await fetch(`${baseUrl}/v1/taxonomy`);
  const body = (await response.json()) as { note?: string };

  assert.match(body.note ?? "", /not derived from any authority/i);
});

test("V030: the taxonomy endpoint exposes no defect identifiers to a citizen", async () => {
  // Defects are what a reviewer confirms, not what a citizen filters by — and
  // V018 §2 is explicit that a citizen is never asked to classify. Serving
  // them here would invite an interface that does.
  const response = await fetch(`${baseUrl}/v1/taxonomy`);
  const body = (await response.json()) as Record<string, unknown>;

  assert.equal(Object.hasOwn(body, "defect_ids"), false);
  assert.equal(Object.hasOwn(body, "defects"), false);
});
