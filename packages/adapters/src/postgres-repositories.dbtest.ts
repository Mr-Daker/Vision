/**
 * The V009 identity and session ports against real PostgreSQL (roadmap V018).
 *
 * The in-memory implementations were written to enforce the same invariants the
 * database would. These tests check that claim rather than assuming it, and
 * they matter because the API now runs on these implementations: a participant
 * that exists only in memory cannot own a submission row.
 *
 * Run with: npm run db:up && npm run db:migrate && npm run test:db
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

import {
  newCorrelationId,
  newUuid,
  unsafeTimestamp,
  type AdapterCallContext,
  type Uuid,
} from "@vision/contracts";
import type { Session } from "@vision/domain";

import { DEMO_PRINCIPALS, IdentityService, SimulatedIdentityAdapter } from "./identity.ts";
import { OptimisticConcurrencyError, UniqueConstraintViolation } from "./ports.ts";
import {
  PostgresIdentityMappingRepository,
  PostgresParticipantRepository,
  PostgresSessionRepository,
} from "./postgres-repositories.ts";
import { SessionService } from "./sessions.ts";

const DATABASE_URL =
  process.env["DATABASE_URL"] ??
  "postgresql://vision:vision_local_dev_only@127.0.0.1:5432/vision_dev";

/**
 * A key of its own, deliberately. `node --test` runs test files in parallel,
 * and the mapping hash is keyed — so a shared key would make this file and
 * apps/api's dbtest resolve the same participant row, and this file's cleanup
 * would delete rows the other one is still using.
 */
const HMAC_KEY = "test-only-identity-key-postgres-repositories";
const ctx = (): AdapterCallContext => ({ correlation_id: newCorrelationId() });
const hash = (seed: string): string => seed.repeat(64).slice(0, 64);

let client: pg.Client;
let participants: PostgresParticipantRepository;
let mappings: PostgresIdentityMappingRepository;
let sessions: PostgresSessionRepository;
let identityService: IdentityService;
let sessionService: SessionService;

/** Participants created by these tests, removed at the end. */
const created: string[] = [];

before(async () => {
  client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  participants = new PostgresParticipantRepository(client);
  mappings = new PostgresIdentityMappingRepository(client);
  sessions = new PostgresSessionRepository(client);
  identityService = new IdentityService(participants, mappings, HMAC_KEY);
  sessionService = new SessionService(sessions, participants, {
    tokenHmacKey: "test-only-session-key",
    ttlSeconds: 3600,
  });
});

after(async () => {
  if (created.length > 0) {
    await client.query("delete from app_session where participant_id = any($1::uuid[])", [created]);
    await client.query("delete from identity_mapping where participant_id = any($1::uuid[])", [
      created,
    ]);
    await client.query("delete from participant where participant_id = any($1::uuid[])", [created]);
  }
  await client.end();
});

/** Creates a persisted participant and registers it for cleanup. */
const newParticipant = async (): Promise<Uuid> => {
  const participantId = newUuid();
  await participants.create({
    participant_id: participantId,
    created_at: unsafeTimestamp(new Date().toISOString()),
  });
  created.push(participantId);
  return participantId;
};

const activeSession = (participantId: Uuid, tokenSeed: string): Session => {
  const issuedAt = new Date();
  return {
    session_id: newUuid(),
    participant_id: participantId,
    token_hash: hash(tokenSeed),
    issued_at: unsafeTimestamp(issuedAt.toISOString()),
    expires_at: unsafeTimestamp(new Date(issuedAt.getTime() + 3_600_000).toISOString()),
    current_version: 1,
  };
};

test("V009/pg: a demo login persists a participant row that a submission can reference", async () => {
  const adapter = new SimulatedIdentityAdapter();
  const principal = DEMO_PRINCIPALS[0]!;

  const outcome = await adapter.authenticate(
    { credential: principal.credential, interface_locale: "en-IN" as never },
    ctx(),
  );
  assert.equal(outcome.kind, "success");
  if (outcome.kind !== "success") return;

  const resolved = await identityService.resolveParticipant(outcome.value);
  created.push(resolved.participant.participant_id);

  // The point of the test: the row is in the database, not in a Map.
  const { rows } = await client.query(
    "select participant_id from participant where participant_id = $1",
    [resolved.participant.participant_id],
  );
  assert.equal(rows.length, 1, "the participant must exist in PostgreSQL after login");

  const again = await identityService.resolveParticipant(outcome.value);
  assert.equal(again.created, false, "a repeated login must reuse the persisted participant");
  assert.equal(again.participant.participant_id, resolved.participant.participant_id);

  const { rows: mappingRows } = await client.query(
    "select provider_subject_hash, provider_mode from identity_mapping where participant_id = $1",
    [resolved.participant.participant_id],
  );
  assert.equal(mappingRows.length, 1, "one mapping per provider subject");
  assert.equal(
    mappingRows[0]!["provider_mode"],
    "simulated",
    "the persisted mapping must record that this identity was never really verified",
  );
  assert.match(
    String(mappingRows[0]!["provider_subject_hash"]),
    /^[0-9a-f]{64}$/,
    "only a keyed hash of the provider subject is stored (V005 L3a)",
  );
});

test("V009/pg: a duplicate provider subject is rejected by the database index", async () => {
  const participantId = await newParticipant();
  const otherParticipantId = await newParticipant();
  const subjectHash = hash("a");

  await mappings.create({
    identity_mapping_id: newUuid(),
    participant_id: participantId,
    provider: "postgres-repo-test",
    provider_subject_hash: subjectHash,
    provider_mode: "simulated",
    created_at: unsafeTimestamp(new Date().toISOString()),
  });

  await assert.rejects(
    () =>
      mappings.create({
        identity_mapping_id: newUuid(),
        participant_id: otherParticipantId,
        provider: "postgres-repo-test",
        provider_subject_hash: subjectHash,
        provider_mode: "simulated",
        created_at: unsafeTimestamp(new Date().toISOString()),
      }),
    (error: unknown) =>
      error instanceof UniqueConstraintViolation &&
      error.constraintName === "identity_mapping_provider_subject_uniq",
    "one provider subject must map to exactly one participant, enforced in the schema",
  );

  const found = await mappings.findByProviderSubject("postgres-repo-test", subjectHash);
  assert.equal(found?.participant_id, participantId);
});

test("V009/pg: a session round-trips through issue, validate, rotate and revoke", async () => {
  const participantId = await newParticipant();

  const issued = await sessionService.issue(participantId);
  const validated = await sessionService.validate(issued.cookieValue);
  assert.equal(validated.ok, true);
  if (!validated.ok) return;
  assert.equal(validated.session.session_id, issued.session.session_id);

  const rotated = await sessionService.rotate(issued.cookieValue);
  assert.notEqual(rotated, undefined);
  if (rotated === undefined) return;

  const oldCredential = await sessionService.validate(issued.cookieValue);
  assert.equal(oldCredential.ok, false, "the pre-rotation credential must stop working");

  const newCredential = await sessionService.validate(rotated.cookieValue);
  assert.equal(newCredential.ok, true);

  await sessionService.revoke(rotated.session.session_id, "logout");
  const afterRevocation = await sessionService.validate(rotated.cookieValue);
  assert.equal(afterRevocation.ok, false, "a revoked session must not validate");

  const { rows } = await client.query(
    "select revoked_at, revocation_reason from app_session where session_id = $1",
    [rotated.session.session_id],
  );
  assert.notEqual(rows[0]!["revoked_at"], null);
  assert.equal(rows[0]!["revocation_reason"], "logout");
});

test("V009/pg: a stale compare-and-swap loses instead of overwriting", async () => {
  const participantId = await newParticipant();
  const session = activeSession(participantId, "b");
  await sessions.create(session);

  const winner: Session = { ...session, token_hash: hash("c"), current_version: 2 };
  await sessions.update(winner, 1);

  const loser: Session = { ...session, token_hash: hash("d"), current_version: 2 };
  await assert.rejects(
    () => sessions.update(loser, 1),
    OptimisticConcurrencyError,
    "a writer holding version 1 must not overwrite version 2",
  );

  const current = await sessions.findById(session.session_id);
  assert.equal(current?.token_hash, hash("c"), "the winning write must survive");
  assert.equal(current?.current_version, 2);
});

test("V009/pg: only unrevoked sessions are returned as active", async () => {
  const participantId = await newParticipant();
  const kept = activeSession(participantId, "e");
  const dropped = activeSession(participantId, "f");
  await sessions.create(kept);
  await sessions.create(dropped);

  await sessions.update(
    {
      ...dropped,
      revoked_at: unsafeTimestamp(new Date().toISOString()),
      revocation_reason: "logout",
      current_version: 2,
    },
    1,
  );

  const active = await sessions.findActiveByParticipant(participantId);
  assert.deepEqual(
    active.map((session) => session.session_id),
    [kept.session_id],
  );
});

test("V009/pg: the database refuses a session that expires before it was issued", async () => {
  const participantId = await newParticipant();
  const issuedAt = new Date();

  await assert.rejects(
    () =>
      sessions.create({
        session_id: newUuid(),
        participant_id: participantId,
        token_hash: hash("9"),
        issued_at: unsafeTimestamp(issuedAt.toISOString()),
        expires_at: unsafeTimestamp(new Date(issuedAt.getTime() - 1000).toISOString()),
        current_version: 1,
      }),
    /app_session_expiry_after_issue_ck/,
    "the expiry invariant must hold in the schema, not only in the service",
  );
});
