import { test } from "node:test";
import assert from "node:assert/strict";

import { unsafeTimestamp, unsafeUuid } from "@vision/contracts";

import {
  DEFAULT_QUOTAS,
  UnauthenticatedError,
  authorize,
  checkQuota,
  derivePrincipal,
  findPublicLeaks,
  toPublicIssueView,
  type IssueRecord,
  type Principal,
  type Role,
} from "./authorization.ts";

const PARTICIPANT = unsafeUuid("6ba7b810-9dad-41d1-80b4-00c04fd430c8");
const OTHER_PARTICIPANT = unsafeUuid("6ba7b811-9dad-41d1-80b4-00c04fd430c8");
const STAFF = unsafeUuid("6ba7b812-9dad-41d1-80b4-00c04fd430c8");
const SESSION = unsafeUuid("6ba7b813-9dad-41d1-80b4-00c04fd430c8");

const participant = {
  participant_id: PARTICIPANT,
  created_at: unsafeTimestamp("2026-09-01T00:00:00Z"),
};

const citizen = derivePrincipal({
  ok: true,
  sessionId: SESSION,
  participant,
  grant: { role: "citizen" },
});

const staffIn = (jurisdictions: string[], role: Role = "department_staff"): Principal =>
  derivePrincipal({
    ok: true,
    sessionId: SESSION,
    participant,
    grant: {
      role,
      staffId: STAFF,
      jurisdictionScope: jurisdictions,
      ...(role === "department_staff"
        ? {
            responsibilityScope: jurisdictions.map((jurisdictionId) => ({
              jurisdictionId,
              departmentId: "demo-department",
            })),
          }
        : {}),
    },
  });

// ---------------------------------------------------------------------------
// Forged principals
// ---------------------------------------------------------------------------

test("V015: a principal cannot be built without a valid session", () => {
  assert.throws(() => derivePrincipal({ ok: false }), UnauthenticatedError);
});

test("V015: a forged participant id in a request cannot become a principal", () => {
  // derivePrincipal takes no client-controlled identifier at all: the only
  // participant it can produce is the one the validated session resolved to.
  assert.equal(citizen.participantId, PARTICIPANT);

  // A request claiming to be someone else fails the own-resource check.
  const decision = authorize(citizen, "submission.read_own", {
    ownerParticipantId: OTHER_PARTICIPANT,
  });
  assert.equal(decision.allowed, false);
  if (!decision.allowed) assert.match(decision.reason, /only read their own/);
});

test("V015: a staff role requires a staff account and a jurisdiction scope", () => {
  assert.throws(
    () =>
      derivePrincipal({
        ok: true,
        sessionId: SESSION,
        participant,
        grant: { role: "department_staff", jurisdictionScope: ["DDA-B1"] },
      }),
    /requires a staff account/,
  );
  assert.throws(
    () =>
      derivePrincipal({
        ok: true,
        sessionId: SESSION,
        participant,
        grant: { role: "reviewer", staffId: STAFF, jurisdictionScope: [] },
      }),
    /requires a jurisdiction scope/,
  );
  assert.throws(
    () =>
      derivePrincipal({
        ok: true,
        sessionId: SESSION,
        participant,
        grant: {
          role: "department_staff",
          staffId: STAFF,
          jurisdictionScope: ["DDA-B1"],
        },
      }),
    /department responsibility scope/,
  );
});

test("V015: simulated identity still exercises real authorization", () => {
  // The citizen principal above came from a simulated identity adapter, and it
  // is still refused actions outside its role.
  for (const action of [
    "issue.transition",
    "assignment.write",
    "evidence.read_original",
  ] as const) {
    const decision = authorize(citizen, action, { jurisdictionId: "DDA-B1" });
    assert.equal(decision.allowed, false, `a citizen must not be able to ${action}`);
  }
});

// ---------------------------------------------------------------------------
// Jurisdiction scoping
// ---------------------------------------------------------------------------

test("V015: cross-jurisdiction writes are rejected", () => {
  const staff = staffIn(["DDA-B1"]);

  const inScope = authorize(staff, "assignment.write", { jurisdictionId: "DDA-B1" });
  assert.equal(inScope.allowed, true);

  const crossJurisdiction = authorize(staff, "assignment.write", { jurisdictionId: "DDA-B2" });
  assert.equal(crossJurisdiction.allowed, false);
  if (!crossJurisdiction.allowed) assert.match(crossJurisdiction.reason, /outside this principal/);

  const transition = authorize(staff, "issue.transition", { jurisdictionId: "DDA-B2" });
  assert.equal(transition.allowed, false);
});

test("V015: a jurisdiction-scoped action needs a scoped resource", () => {
  const staff = staffIn(["DDA-B1"]);
  const unscoped = authorize(staff, "issue.read_private", {});
  assert.equal(unscoped.allowed, false);
  if (!unscoped.allowed) assert.match(unscoped.reason, /requires a jurisdiction-scoped resource/);
});

test("V015: unauthorized status transitions are rejected by role", () => {
  const supervisor = staffIn(["DDA-B1"], "supervisor");
  // A supervisor monitors; they do not transition issues or claim resolution.
  assert.equal(
    authorize(supervisor, "issue.transition", { jurisdictionId: "DDA-B1" }).allowed,
    false,
  );
  assert.equal(
    authorize(supervisor, "resolution.claim", { jurisdictionId: "DDA-B1" }).allowed,
    false,
  );

  const staff = staffIn(["DDA-B1"]);
  assert.equal(authorize(staff, "resolution.claim", { jurisdictionId: "DDA-B1" }).allowed, true);
  // Staff cannot decide redaction; that is a reviewer judgement.
  assert.equal(
    authorize(staff, "evidence.redaction_decide", { jurisdictionId: "DDA-B1" }).allowed,
    false,
  );
});

// ---------------------------------------------------------------------------
// Private-data boundaries
// ---------------------------------------------------------------------------

test("V015: no application role can read an identity mapping", () => {
  for (const role of [
    "citizen",
    "reviewer",
    "department_staff",
    "supervisor",
    "administrator",
  ] as Role[]) {
    const principal =
      role === "citizen"
        ? citizen
        : derivePrincipal({
            ok: true,
            sessionId: SESSION,
            participant,
            grant: {
              role,
              staffId: STAFF,
              jurisdictionScope: ["DDA-B1"],
              ...(role === "department_staff"
                ? {
                    responsibilityScope: [
                      { jurisdictionId: "DDA-B1", departmentId: "demo-department" },
                    ],
                  }
                : {}),
            },
          });

    const decision = authorize(principal, "identity_mapping.read", { jurisdictionId: "DDA-B1" });
    assert.equal(decision.allowed, false, `${role} must not read identity mappings`);
  }
});

test("V015: reading a private original is exceptional and audited", () => {
  const reviewer = staffIn(["DDA-B1"], "reviewer");

  // No purpose: refused.
  const noPurpose = authorize(reviewer, "evidence.read_original", { jurisdictionId: "DDA-B1" });
  assert.equal(noPurpose.allowed, false);
  if (!noPurpose.allowed) assert.match(noPurpose.reason, /requires a recorded purpose/);

  // With a purpose: allowed, but flagged for the audit trail.
  const withPurpose = authorize(reviewer, "evidence.read_original", {
    jurisdictionId: "DDA-B1",
    exceptionalAccessPurpose: "citizen disputes the redaction accuracy",
  });
  assert.equal(withPurpose.allowed, true);
  if (withPurpose.allowed) assert.equal(withPurpose.auditRequired, true);

  // Routine redacted access is not audited as exceptional.
  const redacted = authorize(reviewer, "evidence.read_redacted", { jurisdictionId: "DDA-B1" });
  assert.equal(redacted.allowed, true);
  if (redacted.allowed) assert.equal(redacted.auditRequired, false);
});

test("V015: a citizen never reaches a private original", () => {
  const decision = authorize(citizen, "evidence.read_original", {
    jurisdictionId: "DDA-B1",
    exceptionalAccessPurpose: "I would like to see it",
  });
  assert.equal(decision.allowed, false);
});

// ---------------------------------------------------------------------------
// Public representation
// ---------------------------------------------------------------------------

test("V015: the public view excludes every restricted field", () => {
  const record: IssueRecord = {
    issue_id: "11111111-1111-4111-8111-111111111111",
    public_reference: "VIS-ABCDEF",
    category: "structure.roof",
    current_status: "routed_internal",
    jurisdiction_id: "DDA-B1",
    precise_location: { lon: 74.56, lat: 16.85 },
    coarse_location: { lon: 74.56, lat: 16.85 },
    counted_participants: 2,
    reporter_participant_id: PARTICIPANT,
    original_object_references: ["obj/private-original.jpg"],
    approved_derivative_references: ["public/derivative.jpg"],
    raw_model_output: { certainty: 0.91 },
  };

  const view = toPublicIssueView(record);
  const leaks = findPublicLeaks(view as unknown as Record<string, unknown>);
  assert.deepEqual(leaks, [], `public view leaked: ${leaks.join(", ")}`);

  // Serialising the view must not carry the originals or the raw model output.
  const serialised = JSON.stringify(view);
  assert.ok(!serialised.includes("obj/private-original.jpg"));
  assert.ok(!serialised.includes(PARTICIPANT));
  assert.ok(!serialised.includes("certainty"));
  assert.ok(serialised.includes("public/derivative.jpg"), "approved derivatives stay public");
});

test("V015: the leak detector catches a hand-built payload", () => {
  const leaks = findPublicLeaks({
    public_reference: "VIS-1",
    precise_location: { lon: 1, lat: 2 },
    reporter_participant_id: "x",
  });
  assert.ok(leaks.includes("precise_location"));
  assert.ok(leaks.includes("reporter_participant_id"));
});

// ---------------------------------------------------------------------------
// Quotas and request limits
// ---------------------------------------------------------------------------

test("V015: requests beyond the configured quota are rejected with a retry delay", () => {
  const nowMs = Date.parse("2026-09-09T12:00:00Z");
  const limit = DEFAULT_QUOTAS["submission.create"]!.limit;

  // One slot left.
  const nearLimit = checkQuota(
    "submission.create",
    { recentAtMs: Array.from({ length: limit - 1 }, (_, i) => nowMs - i * 1000) },
    nowMs,
  );
  assert.equal(nearLimit.allowed, true);
  if (nearLimit.allowed) assert.equal(nearLimit.remaining, 1);

  // At the limit: refused, with an actionable delay.
  const atLimit = checkQuota(
    "submission.create",
    { recentAtMs: Array.from({ length: limit }, (_, i) => nowMs - i * 1000) },
    nowMs,
  );
  assert.equal(atLimit.allowed, false);
  if (!atLimit.allowed) {
    assert.equal(atLimit.reason, "quota_exceeded");
    assert.ok(atLimit.retryAfterMs > 0, "a rejection must say when to retry");
    assert.equal(atLimit.limit, limit);
    assert.equal(atLimit.windowSeconds, 3600);
  }
});

test("V015: the quota window slides, so old requests stop counting", () => {
  const nowMs = Date.parse("2026-09-09T12:00:00Z");
  const window = DEFAULT_QUOTAS["submission.create"]!;
  const limit = window.limit;

  // All prior requests are older than the window.
  const expired = Array.from(
    { length: limit + 5 },
    (_, i) => nowMs - window.windowSeconds * 1000 - (i + 1) * 1000,
  );
  const decision = checkQuota("submission.create", { recentAtMs: expired }, nowMs);
  assert.equal(decision.allowed, true);
  if (decision.allowed) assert.equal(decision.remaining, limit);
});

test("V015: the retry delay points at when the oldest request expires", () => {
  const nowMs = Date.parse("2026-09-09T12:00:00Z");
  const window = DEFAULT_QUOTAS["submission.create"]!;
  const oldest = nowMs - (window.windowSeconds - 60) * 1000; // expires in 60s

  const decision = checkQuota(
    "submission.create",
    {
      recentAtMs: [oldest, ...Array.from({ length: window.limit - 1 }, () => nowMs - 1000)],
    },
    nowMs,
  );
  assert.equal(decision.allowed, false);
  if (!decision.allowed) {
    assert.equal(Math.round(decision.retryAfterMs / 1000), 60);
  }
});

test("V015: an unlimited action is not accidentally throttled", () => {
  const decision = checkQuota("issue.read_public", { recentAtMs: [] }, Date.now());
  assert.equal(decision.allowed, true);
});
