import { test } from "node:test";
import assert from "node:assert/strict";

import { newUuid, type IsoTimestamp, type Uuid } from "@vision/contracts";
import { isParticipantEligible } from "@vision/domain";

import { InMemoryParticipantRepository, InMemorySessionRepository } from "./ports.ts";
import { SessionService, csrfTokenMatches, newCsrfToken } from "./sessions.ts";

/** Controllable clock so expiry is testable without waiting. */
const makeClock = (startIso: string) => {
  let current = Date.parse(startIso);
  return {
    now: (): IsoTimestamp => new Date(current).toISOString() as IsoTimestamp,
    advanceSeconds: (seconds: number): void => {
      current += seconds * 1000;
    },
  };
};

const setup = async (ttlSeconds = 3600, startIso = "2026-09-09T10:00:00.000Z") => {
  const clock = makeClock(startIso);
  const sessions = new InMemorySessionRepository();
  const participants = new InMemoryParticipantRepository();
  const participant = await participants.create({
    participant_id: newUuid(),
    created_at: clock.now(),
  });
  const service = new SessionService(
    sessions,
    participants,
    { tokenHmacKey: "test-only-session-key", ttlSeconds },
    clock.now,
  );
  return { clock, sessions, participants, participant, service };
};

test("V009: an issued session validates and resolves to its participant", async () => {
  const { service, participant } = await setup();
  const issued = await service.issue(participant.participant_id);

  const validation = await service.validate(issued.cookieValue);
  assert.equal(validation.ok, true);
  if (validation.ok) {
    assert.equal(validation.participant.participant_id, participant.participant_id);
  }
});

test("V009: the session token is never stored in clear form", async () => {
  const { service, participant, sessions } = await setup();
  const issued = await service.issue(participant.participant_id);
  const token = issued.cookieValue.split(".")[1]!;

  const stored = await sessions.findById(issued.session.session_id);
  assert.ok(stored);
  assert.notEqual(stored.token_hash, token, "the raw token must not be stored");
  assert.match(stored.token_hash, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(stored).includes(token), "no stored field may contain the raw token");
});

test("V009: an expired session fails validation", async () => {
  const { service, participant, clock } = await setup(60);
  const issued = await service.issue(participant.participant_id);

  clock.advanceSeconds(59);
  assert.equal((await service.validate(issued.cookieValue)).ok, true, "still valid before expiry");

  clock.advanceSeconds(2);
  const afterExpiry = await service.validate(issued.cookieValue);
  assert.equal(afterExpiry.ok, false);
  if (!afterExpiry.ok) {
    assert.equal(afterExpiry.reason, "session_expired");
  }
});

test("V009: a revoked session fails validation", async () => {
  const { service, participant } = await setup();
  const issued = await service.issue(participant.participant_id);

  await service.revoke(issued.session.session_id, "logout");

  const validation = await service.validate(issued.cookieValue);
  assert.equal(validation.ok, false);
  if (!validation.ok) {
    assert.equal(validation.reason, "session_revoked");
  }
});

test("V009: logout is idempotent and preserves the original revocation facts", async () => {
  const { service, participant } = await setup();
  const issued = await service.issue(participant.participant_id);

  const first = await service.revoke(issued.session.session_id, "logout");
  const second = await service.revoke(issued.session.session_id, "admin_revocation");

  assert.ok(first && second);
  assert.equal(second.revoked_at, first.revoked_at, "the revocation time must not move");
  assert.equal(second.revocation_reason, "logout", "the original reason must be preserved");
});

test("V009: logout does not revoke or delete the participant", async () => {
  const { service, participant, participants } = await setup();
  const issued = await service.issue(participant.participant_id);
  await service.revoke(issued.session.session_id, "logout");

  const stillThere = await participants.findById(participant.participant_id);
  assert.ok(stillThere, "the participant must survive logout");
  assert.equal(stillThere.participant_id, participant.participant_id);
  assert.equal(stillThere.tombstoned_at, undefined);
  assert.equal(isParticipantEligible(stillThere), true);

  // A fresh login for the same participant still resolves to the same identity,
  // so uniqueness counting cannot be reset by logging out (V003 policy).
  const reissued = await service.issue(participant.participant_id);
  const validation = await service.validate(reissued.cookieValue);
  assert.equal(validation.ok, true);
  if (validation.ok) {
    assert.equal(validation.participant.participant_id, participant.participant_id);
  }
});

test("V009: a tampered token is rejected even with a valid session id", async () => {
  const { service, participant } = await setup();
  const issued = await service.issue(participant.participant_id);
  const sessionId = issued.cookieValue.split(".")[0]!;

  const validation = await service.validate(`${sessionId}.forged-token-value`);
  assert.equal(validation.ok, false);
  if (!validation.ok) {
    assert.equal(validation.reason, "token_mismatch");
  }
});

test("V009: malformed cookies are rejected without touching storage", async () => {
  const { service } = await setup();
  for (const value of ["", "no-separator", "not-a-uuid.token", `${newUuid()}.`]) {
    const validation = await service.validate(value);
    assert.equal(validation.ok, false, `expected rejection for '${value}'`);
  }
  assert.equal((await service.validate(undefined)).ok, false);
});

test("V009: rotation issues a new credential and invalidates the old one", async () => {
  const { service, participant } = await setup();
  const original = await service.issue(participant.participant_id);

  const rotated = await service.rotate(original.cookieValue);
  assert.ok(rotated, "rotation should succeed for a valid session");
  assert.notEqual(rotated.cookieValue, original.cookieValue);

  const oldValidation = await service.validate(original.cookieValue);
  assert.equal(oldValidation.ok, false, "the previous credential must stop working");

  const newValidation = await service.validate(rotated.cookieValue);
  assert.equal(newValidation.ok, true);
  if (newValidation.ok) {
    assert.equal(
      newValidation.participant.participant_id,
      participant.participant_id,
      "rotation must not change the participant",
    );
  }
});

test("V009: concurrent rotation mints exactly one replacement session", async () => {
  const { service, participant, sessions } = await setup();
  const original = await service.issue(participant.participant_id);

  const attempts = await Promise.all([
    service.rotate(original.cookieValue),
    service.rotate(original.cookieValue),
  ]);
  const replacements = attempts.filter((attempt) => attempt !== undefined);

  assert.equal(replacements.length, 1, "only one compare-and-swap may consume the old session");
  assert.equal((await service.validate(original.cookieValue)).ok, false);
  assert.equal(
    (await sessions.findActiveByParticipant(participant.participant_id)).length,
    1,
    "a losing rotation must not leave an inaccessible replacement session",
  );
  assert.equal((await service.validate(replacements[0]!.cookieValue)).ok, true);
});

test("V009: rotation of an invalid session does not mint a credential", async () => {
  const { service } = await setup();
  assert.equal(await service.rotate("not-a-valid-cookie"), undefined);
});

test("V009: revoking all sessions for a participant affects only sessions", async () => {
  const { service, participant, participants } = await setup();
  const a = await service.issue(participant.participant_id);
  const b = await service.issue(participant.participant_id);

  const revoked = await service.revokeAllForParticipant(
    participant.participant_id,
    "security_incident",
  );
  assert.equal(revoked, 2);
  assert.equal((await service.validate(a.cookieValue)).ok, false);
  assert.equal((await service.validate(b.cookieValue)).ok, false);
  assert.ok(await participants.findById(participant.participant_id));
});

test("V009: a session for a tombstoned participant is refused", async () => {
  const clock = makeClock("2026-09-09T10:00:00.000Z");
  const sessions = new InMemorySessionRepository();
  const participants = new InMemoryParticipantRepository();
  const tombstoned: Uuid = newUuid();
  await participants.create({
    participant_id: tombstoned,
    created_at: clock.now(),
    tombstoned_at: clock.now(),
  });
  const service = new SessionService(
    sessions,
    participants,
    { tokenHmacKey: "test-only-session-key", ttlSeconds: 3600 },
    clock.now,
  );

  await assert.rejects(
    service.issue(tombstoned),
    /missing or ineligible participant/,
    "an unusable session must not be stored in the first place",
  );
  assert.deepEqual(await sessions.findActiveByParticipant(tombstoned), []);
});

test("V009: a session for a missing participant is refused", async () => {
  const { service, sessions } = await setup();
  const missing = newUuid();

  await assert.rejects(service.issue(missing), /missing or ineligible participant/);
  assert.deepEqual(await sessions.findActiveByParticipant(missing), []);
});

test("V009: session service refuses unusable configuration", async () => {
  const sessions = new InMemorySessionRepository();
  const participants = new InMemoryParticipantRepository();
  assert.throws(
    () => new SessionService(sessions, participants, { tokenHmacKey: "", ttlSeconds: 60 }),
    /SESSION_TOKEN_HMAC_KEY/,
  );
  assert.throws(
    () => new SessionService(sessions, participants, { tokenHmacKey: "k", ttlSeconds: 0 }),
    /SESSION_TTL_SECONDS/,
  );
});

test("V009: CSRF double-submit comparison rejects mismatches and blanks", () => {
  const token = newCsrfToken();
  assert.equal(csrfTokenMatches(token, token), true);
  assert.equal(csrfTokenMatches(token, newCsrfToken()), false);
  assert.equal(csrfTokenMatches(undefined, token), false);
  assert.equal(csrfTokenMatches(token, undefined), false);
  assert.equal(csrfTokenMatches("", ""), false, "empty tokens must never match");
});
