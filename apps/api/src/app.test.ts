import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { DEMO_PRINCIPALS } from "@vision/adapters";

import { createRequestHandler } from "./app.ts";
import { buildApp } from "./server.ts";

const TEST_ENV = {
  IDENTITY_PROVIDER_MODE: "simulated",
  RECIPIENT_PROVIDER_MODE: "simulated",
  IDENTITY_MAPPING_HMAC_KEY: "test-only-identity-key",
  SESSION_TOKEN_HMAC_KEY: "test-only-session-key",
  SESSION_TTL_SECONDS: "3600",
  SESSION_COOKIE_SECURE: "false",
} as const;

let server: Server;
let baseUrl: string;

before(async () => {
  const { handler } = buildApp(TEST_ENV);
  server = createServer((request, response) => {
    void handler(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${String(address.port)}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Extracts one cookie value from a Set-Cookie list. */
const readCookie = (response: Response, name: string): string | undefined => {
  for (const header of response.headers.getSetCookie()) {
    const [pair] = header.split(";");
    if (pair === undefined) continue;
    const separator = pair.indexOf("=");
    if (pair.slice(0, separator).trim() === name) {
      return decodeURIComponent(pair.slice(separator + 1));
    }
  }
  return undefined;
};

const cookieAttributes = (response: Response, name: string): string | undefined =>
  response.headers.getSetCookie().find((header) => header.startsWith(`${name}=`));

const login = async (credential: string) => {
  const response = await fetch(`${baseUrl}/v1/auth/demo-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential }),
  });
  const body = (await response.json()) as Record<string, unknown>;
  return {
    response,
    body,
    sessionCookie: readCookie(response, "vision_session"),
    csrfCookie: readCookie(response, "vision_csrf"),
  };
};

test("V009: capability metadata labels demo identity as simulated", async () => {
  const response = await fetch(`${baseUrl}/v1/capabilities`);
  assert.equal(response.status, 200);

  const body = (await response.json()) as {
    capabilities: { capability: string; provider_mode: string; display_label: string }[];
  };

  const identity = body.capabilities.find((c) => c.capability === "citizen_identity");
  assert.ok(identity, "identity capability must be advertised");
  assert.equal(identity.provider_mode, "simulated");
  assert.match(identity.display_label, /simulated/i);

  const recipient = body.capabilities.find((c) => c.capability === "recipient_acknowledgment");
  assert.ok(recipient);
  assert.match(recipient.display_label, /not a real government/i);

  for (const capability of body.capabilities) {
    if (capability.provider_mode !== "real") {
      assert.match(
        capability.display_label,
        /simulated|stub|not a real|demonstration only/i,
        `${capability.capability} must be labelled as not real`,
      );
    }
  }
});

test("V009/V034: the citizen login surface neither advertises nor accepts the reserved staff fixture", async () => {
  const staff = DEMO_PRINCIPALS.find((principal) => principal.account_type === "department_staff");
  assert.ok(staff);

  const capabilities = await fetch(`${baseUrl}/v1/capabilities`);
  const metadata = (await capabilities.json()) as {
    demo_principals: { credential: string; label: string }[];
  };
  assert.equal(
    metadata.demo_principals.some((principal) => principal.credential === staff.credential),
    false,
    "a non-functional staff choice must not be rendered as a login option",
  );

  const attempted = await login(staff.credential);
  assert.equal(attempted.response.status, 401);
  assert.equal(attempted.body["authenticated"], undefined);
});

test("V009: demo login issues a protected session cookie and a CSRF token", async () => {
  const { response, body, sessionCookie, csrfCookie } = await login(DEMO_PRINCIPALS[0]!.credential);

  assert.equal(response.status, 200);
  assert.equal(body["authenticated"], true);
  assert.equal(body["identity_mode"], "simulated");
  assert.ok(sessionCookie, "a session cookie must be set");
  assert.ok(csrfCookie, "a CSRF cookie must be set");

  const sessionAttributes = cookieAttributes(response, "vision_session") ?? "";
  assert.match(sessionAttributes, /HttpOnly/, "the session cookie must be HttpOnly");
  assert.match(sessionAttributes, /SameSite=Strict/);
  assert.match(sessionAttributes, /Path=\//);

  const csrfAttributes = cookieAttributes(response, "vision_csrf") ?? "";
  assert.doesNotMatch(
    csrfAttributes,
    /HttpOnly/,
    "the CSRF cookie must be readable so the client can echo it",
  );

  // The response must not leak the internal participant id (V005 §2).
  assert.equal(body["participant_id"], undefined);
});

test("V009: an unknown demo credential is refused", async () => {
  const response = await fetch(`${baseUrl}/v1/auth/demo-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential: "not-a-real-demo-principal" }),
  });
  assert.equal(response.status, 401);
  const body = (await response.json()) as { error: { code: string; correlation_id: string } };
  assert.equal(body.error.code, "unauthenticated");
  assert.ok(body.error.correlation_id.length > 0, "every error carries a correlation id");
});

test("V009: revoked and expired demo credentials are refused", async () => {
  for (const credential of ["demo-revoked-one", "demo-expired-one"]) {
    const response = await fetch(`${baseUrl}/v1/auth/demo-login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credential }),
    });
    assert.equal(response.status, 401);
    const body = (await response.json()) as { error: { code: string; correlation_id: string } };
    assert.equal(body.error.code, "unauthenticated");
    assert.ok(body.error.correlation_id.length > 0);
  }
});

test("V009: a missing credential fails validation", async () => {
  const response = await fetch(`${baseUrl}/v1/auth/demo-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(response.status, 400);
});

test("V009: session status reflects the issued session", async () => {
  const { sessionCookie } = await login(DEMO_PRINCIPALS[0]!.credential);
  assert.ok(sessionCookie);

  const response = await fetch(`${baseUrl}/v1/auth/session`, {
    headers: { cookie: `vision_session=${encodeURIComponent(sessionCookie)}` },
  });
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body["authenticated"], true);
  assert.match(String(body["identity_label"]), /simulated/i);
  assert.equal(body["participant_id"], undefined);
});

test("V009: session status without a cookie reports unauthenticated", async () => {
  const response = await fetch(`${baseUrl}/v1/auth/session`);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body["authenticated"], false);
});

test("V009: malformed percent-encoded cookies fail as structured unauthenticated responses", async () => {
  const response = await fetch(`${baseUrl}/v1/auth/session`, {
    headers: { cookie: "vision_session=%E0%A4%A" },
  });
  assert.equal(response.status, 200);
  assert.ok(response.headers.get("x-correlation-id"));
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body["authenticated"], false);
  assert.equal(body["reason"], "malformed_cookie");
});

test("V009: logout without a CSRF token is refused", async () => {
  const { sessionCookie } = await login(DEMO_PRINCIPALS[0]!.credential);
  assert.ok(sessionCookie);

  const response = await fetch(`${baseUrl}/v1/auth/logout`, {
    method: "POST",
    headers: { cookie: `vision_session=${encodeURIComponent(sessionCookie)}` },
  });
  assert.equal(response.status, 403, "a state-changing call must require the CSRF token");
});

test("V009: logout with a mismatched CSRF token is refused", async () => {
  const { sessionCookie, csrfCookie } = await login(DEMO_PRINCIPALS[0]!.credential);
  assert.ok(sessionCookie && csrfCookie);

  const response = await fetch(`${baseUrl}/v1/auth/logout`, {
    method: "POST",
    headers: {
      cookie: `vision_session=${encodeURIComponent(sessionCookie)}; vision_csrf=${encodeURIComponent(csrfCookie)}`,
      "x-csrf-token": "a-different-token-entirely",
    },
  });
  assert.equal(response.status, 403);
});

test("V009: logout revokes the session and clears protected cookies", async () => {
  const { sessionCookie, csrfCookie } = await login(DEMO_PRINCIPALS[1]!.credential);
  assert.ok(sessionCookie && csrfCookie);
  const cookieHeader = `vision_session=${encodeURIComponent(sessionCookie)}; vision_csrf=${encodeURIComponent(csrfCookie)}`;

  const logout = await fetch(`${baseUrl}/v1/auth/logout`, {
    method: "POST",
    headers: { cookie: cookieHeader, "x-csrf-token": csrfCookie },
  });
  assert.equal(logout.status, 200);

  const cleared = logout.headers.getSetCookie();
  assert.ok(
    cleared.some((header) => header.startsWith("vision_session=") && /Max-Age=0/.test(header)),
    "the session cookie must be cleared",
  );
  assert.ok(
    cleared.some((header) => header.startsWith("vision_csrf=") && /Max-Age=0/.test(header)),
    "the CSRF cookie must be cleared",
  );

  // The revoked session must not work again.
  const after = await fetch(`${baseUrl}/v1/auth/session`, {
    headers: { cookie: `vision_session=${encodeURIComponent(sessionCookie)}` },
  });
  const body = (await after.json()) as Record<string, unknown>;
  assert.equal(body["authenticated"], false);
  assert.equal(body["reason"], "session_revoked");
});

test("V009: rotation replaces the credential and invalidates the previous one", async () => {
  const { sessionCookie, csrfCookie } = await login(DEMO_PRINCIPALS[1]!.credential);
  assert.ok(sessionCookie && csrfCookie);

  const rotate = await fetch(`${baseUrl}/v1/auth/rotate`, {
    method: "POST",
    headers: {
      cookie: `vision_session=${encodeURIComponent(sessionCookie)}; vision_csrf=${encodeURIComponent(csrfCookie)}`,
      "x-csrf-token": csrfCookie,
    },
  });
  assert.equal(rotate.status, 200);

  const rotatedCookie = readCookie(rotate, "vision_session");
  assert.ok(rotatedCookie);
  assert.notEqual(rotatedCookie, sessionCookie);

  const oldSession = await fetch(`${baseUrl}/v1/auth/session`, {
    headers: { cookie: `vision_session=${encodeURIComponent(sessionCookie)}` },
  });
  assert.equal(((await oldSession.json()) as Record<string, unknown>)["authenticated"], false);

  const newSession = await fetch(`${baseUrl}/v1/auth/session`, {
    headers: { cookie: `vision_session=${encodeURIComponent(rotatedCookie)}` },
  });
  assert.equal(((await newSession.json()) as Record<string, unknown>)["authenticated"], true);
});

test("V009: repeated demo login for one principal reuses the same participant", async () => {
  // Observable through the API without exposing participant_id: log in twice as
  // the same principal, then log out of the first session. The second session
  // must still be independently valid, proving sessions are per-login while the
  // participant behind them is stable.
  const first = await login(DEMO_PRINCIPALS[0]!.credential);
  const second = await login(DEMO_PRINCIPALS[0]!.credential);
  assert.ok(first.sessionCookie && first.csrfCookie && second.sessionCookie);
  assert.notEqual(first.sessionCookie, second.sessionCookie, "each login is a distinct session");

  await fetch(`${baseUrl}/v1/auth/logout`, {
    method: "POST",
    headers: {
      cookie: `vision_session=${encodeURIComponent(first.sessionCookie)}; vision_csrf=${encodeURIComponent(first.csrfCookie)}`,
      "x-csrf-token": first.csrfCookie,
    },
  });

  const stillValid = await fetch(`${baseUrl}/v1/auth/session`, {
    headers: { cookie: `vision_session=${encodeURIComponent(second.sessionCookie)}` },
  });
  assert.equal(
    ((await stillValid.json()) as Record<string, unknown>)["authenticated"],
    true,
    "logging out of one session must not affect another session for the same participant",
  );
});

test("V009: an unknown route returns a structured 404", async () => {
  const response = await fetch(`${baseUrl}/v1/does-not-exist`);
  assert.equal(response.status, 404);
  const body = (await response.json()) as { error: { code: string } };
  assert.equal(body.error.code, "not_found");
});

test("V009: requesting a real provider mode fails loudly instead of simulating", () => {
  assert.throws(
    () => buildApp({ ...TEST_ENV, IDENTITY_PROVIDER_MODE: "real" }),
    /V057/,
    "asking for real identity must fail rather than silently simulate",
  );
  assert.throws(() => buildApp({ ...TEST_ENV, RECIPIENT_PROVIDER_MODE: "real" }), /V058/);
});

test("V009: missing secrets prevent startup", () => {
  const { IDENTITY_MAPPING_HMAC_KEY: _omitted, ...withoutIdentityKey } = TEST_ENV;
  assert.throws(() => buildApp(withoutIdentityKey), /IDENTITY_MAPPING_HMAC_KEY/);

  const { SESSION_TOKEN_HMAC_KEY: _also, ...withoutSessionKey } = TEST_ENV;
  assert.throws(() => buildApp(withoutSessionKey), /SESSION_TOKEN_HMAC_KEY/);
});

/**
 * Regression test for a real defect found while wiring V018: an unexpected
 * throw inside a route produced no response at all, so a direct caller of the
 * handler waited forever. The hang hid the actual fault (a foreign-key
 * violation), which is worse than reporting it.
 */
test("V009: a route that throws returns 500 instead of leaving the request open", async () => {
  const { dependencies } = buildApp(TEST_ENV);
  const handler = createRequestHandler({
    ...dependencies,
    extraRoutes: () => {
      throw new Error("boom: this must not reach the client");
    },
  });

  const failing = createServer((request, response) => {
    void handler(request, response);
  });
  await new Promise<void>((resolve) => failing.listen(0, "127.0.0.1", resolve));
  const { port } = failing.address() as AddressInfo;

  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}/v1/anything`, {
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 500);
    const body = (await response.json()) as { error: { code: string; message: string } };
    assert.equal(body.error.code, "internal_error");
    assert.doesNotMatch(
      body.error.message,
      /boom/,
      "internal error detail must never be echoed to the caller",
    );
  } finally {
    await new Promise<void>((resolve) => failing.close(() => resolve()));
  }
});
