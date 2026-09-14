# V009 — Application Sessions and Clearly Simulated Demo Identity

**Status:** Ready for owner approval
**Roadmap task:** V009 (Foundation) · **Prerequisites:** V005, V008 · **Owner:** Backend + Frontend
**Code:** `packages/adapters/src/{identity,sessions,ports}.ts`, `packages/domain/src/{entities,session-policy}.ts`, `apps/api/src/`

**Revision note (dependency pass after V011–V015):** the demo principal set grew to five (adding a revoked and an expired credential), concurrency hardening was added to identity resolution and session rotation, and the PostgreSQL port implementations are now unblocked because V012/V013 landed. See §6a and §9.

> The identity provider is simulated. Nothing in this task performs, or claims to perform, a real identity verification, and no live provider onboarding is required to run or demonstrate it ([V004](V004-source-and-reuse-register.md) §3).

## 1. What is implemented

| Concern             | Implementation                                                                                                                                                  |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity provider   | `SimulatedIdentityAdapter` — six fixed fixtures (two active citizens, one reviewer, one department staff account, one revoked and one expired), no network call |
| Identity resolution | `IdentityService` — provider assertion → keyed hash → `IdentityMapping` → stable `Participant`                                                                  |
| Session lifecycle   | `SessionService` — issue, validate, rotate, revoke, revoke-all                                                                                                  |
| Session policy      | `packages/domain/src/session-policy.ts` — pure, clock-injected                                                                                                  |
| Persistence         | Repository **ports** with in-memory implementations                                                                                                             |
| HTTP surface        | `apps/api` — `/v1/capabilities`, `/v1/auth/demo-login`, `/v1/auth/session`, `/v1/auth/logout`, `/v1/auth/rotate`                                                |
| Capability metadata | Built from the wired adapters; refuses to start if a simulation is unlabelled                                                                                   |

### Why in-memory storage is correct here, not a shortcut

V009's prerequisites are V005 and V008. The database schema is **V012** and the local persistence stack is **V013** — both later in the dependency order. Implementing against ports (`ParticipantRepository`, `IdentityMappingRepository`, `SessionRepository`) satisfies V009 without pulling V012 forward, and a PostgreSQL implementation can be supplied later without touching identity or session logic (done in V018) ([V006](V006-architecture-and-deployment-decisions.md) D8). The in-memory repositories enforce the same uniqueness invariants the database will, so a violation fails now rather than at V012.

## 2. Identity model and uniqueness

Three records, deliberately separate ([V003](V003-domain-and-lifecycle-contracts.md) §2):

- **`IdentityMapping`** (L3a) — `(provider, provider_subject_hash) → participant_id`. The raw provider subject reference crosses the adapter boundary exactly once and is immediately HMAC-SHA256 hashed with a required `IDENTITY_MAPPING_HMAC_KEY`. It is never stored in clear form, never returned to the application domain, never logged, and never sent to an AI provider.
- **`Participant`** (L2) — a stable, permanent pseudonymous anchor with no credential and no session state.
- **`Session`** (L3a) — one revocable login, storing only a token _hash_.

**Uniqueness:** repeated authentication with the same demo credential resolves to the same `participant_id`, because the mapping is keyed on the subject hash rather than on the session. Logging out, letting a session expire, or switching interface locale cannot mint a second participant — which is what stops anti-double-count history from being reset by logging out.

The keyed hash also means two environments with different keys produce non-correlatable values for the same subject; this is asserted by a test.

## 3. Session lifecycle and cookie policy

| Cookie           | Attributes                                                                         | Rationale                                            |
| ---------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `vision_session` | `HttpOnly`, `SameSite=Strict`, `Path=/`, `Max-Age=<ttl>`, `Secure` when configured | Bearer credential; script must not read it           |
| `vision_csrf`    | `SameSite=Strict`, `Path=/`, **not** `HttpOnly`                                    | The client must read it to echo it in `X-CSRF-Token` |

The cookie value is `<session_id>.<token>`. Validation looks the row up by id, then compares the HMAC of the presented token in constant time. The token comparison happens **before** expiry/revocation is reported, so someone holding only a session id cannot probe session state.

`revoked_at` wins over expiry when reporting state, because the reason matters for audit. Revocation is idempotent: a second logout does not move `revoked_at` or overwrite the original reason.

**Rotation** issues a new session and revokes the old one rather than mutating a token in place, so the previous credential stops working immediately and its revocation stays in history.

**`SESSION_COOKIE_SECURE` defaults to `false`** so local HTTP development works. It must be `true` in any deployed environment; that is a V051 deployment gate, not a code default that can be forgotten silently — the template documents it.

## 4. CSRF

Double-submit: `POST /v1/auth/logout` and `POST /v1/auth/rotate` require `X-CSRF-Token` to match the `vision_csrf` cookie, compared with a length-checked timing-safe comparison (empty tokens never match).

**Known limitation:** `POST /v1/auth/demo-login` is exempt, because no CSRF token exists before a session does. A login-CSRF attack against a fixed, non-secret demo credential achieves nothing of value, but this exemption must be revisited when real identity arrives (V057) or when the first state-changing citizen endpoint lands (V018).

## 5. Documented demo recovery path

There is no password and no account recovery flow, because there is no real credential. Recovery is therefore:

1. **Lost or expired session** — return to the demo login screen and select the same demo principal. The same `participant_id` is resolved, so previously counted participation and prior reports remain attributed to the same participant.
2. **Session revoked on another device** — sessions are independent; revoking one does not affect the others. Logging in again issues a fresh session.
3. **Cleared browser storage** — the session cookie and any device draft are lost. Drafts are device-only by policy ([V005 §2](V005-data-privacy-and-retention.md)) and are not recoverable from the server; a _submitted_ report remains retrievable by its receipt once receipt lookup exists (V018/V030).
4. **Operator-side revocation** — `revokeAllForParticipant` revokes every active session for a participant without touching the participant record.

The recovery path deliberately does **not** include "prove who you are to regain access", because the demo has no identity to prove.

## 6. Capability metadata

`GET /v1/capabilities` returns the [V002](V002-capability-evidence-matrix.md) rows for the wired providers, including `provider_mode` and a `display_label` that states the provider is simulated, plus the `may_claim` / `must_not_claim` lists. The UI is expected to source its labels here rather than hard-coding them (`apps/web` exports the endpoint constant for exactly this reason).

`buildCapabilityMetadata()` **throws at startup** if any non-real capability lacks a simulation word in its label. A misleading label fails the process instead of reaching a citizen.

Requesting `IDENTITY_PROVIDER_MODE=real` or `RECIPIENT_PROVIDER_MODE=real` also **fails at startup**, naming V057/V058. A silent fallback to simulation is exactly how a demonstration ends up claiming a verification it never performed.

## 6a. Hardening added after the original draft

Three properties were added once the surrounding code existed, and each is covered by a test:

- **Credential state fails closed.** The demo principal set now includes a revoked and an expired credential; `authenticate` rejects both with a distinct `reason_code` rather than treating "found" as "usable". `IdentityAssertion` carries an explicit `issuer` and `credential_state` observation (V008 §5).
- **Concurrent login cannot fork a participant.** `IdentityService` holds a per-subject single-flight guard, so two simultaneous resolutions of one credential produce one participant and one mapping instead of a uniqueness error.
- **Session writes are race-safe.** `issue` refuses a missing or ineligible participant (`SessionIssuanceError`); `revoke` treats a lost compare-and-swap as an idempotent replay and preserves the winner's revocation facts; `rotate` consumes the old session with a compare-and-swap first, so two concurrent rotations mint exactly one replacement and never leave an inaccessible session behind.

`apps/web/src/identity-ui.ts` now renders the demo login surface from the capability metadata, so the simulated-identity label comes from the API rather than being duplicated in the client. The citizen capture flow remains V019.

The active staff fixture is reserved for the future staff surface and is not returned by `demoPrincipalLabels` or accepted by the current application login endpoint. Every session this endpoint derives has citizen permissions; presenting a staff-labelled choice here would therefore be a false role claim. A V009/V034 test pins both boundaries, and the running citizen and standalone sign-in pages show only the two active citizen fixtures.

## 7. Test evidence

All assertions below are executed by `npm test`.

**Identity** — repeated login yields the same participant; locale switching creates no second participant; distinct principals resolve distinctly; the stored value is a 64-hex keyed hash and is not the raw reference; different keys produce different hashes; a missing key prevents construction; an unknown credential is rejected; the capability forbids a DigiLocker-verified claim.

**Sessions** — an issued session validates; the raw token appears in no stored field; a session expires exactly at its TTL boundary; a revoked session fails with `session_revoked`; logout is idempotent and preserves the original reason; **logout leaves the participant intact and eligible, and a second session for the same participant keeps working**; a tampered token fails with `token_mismatch`; malformed cookies are rejected; rotation invalidates the old credential and preserves the participant; rotating an invalid session mints nothing; revoke-all affects only sessions; a tombstoned participant's session is refused; unusable configuration is refused; CSRF comparison rejects mismatches and blanks.

**HTTP** — capability metadata labels every non-real provider; the citizen surface neither advertises nor accepts staff fixtures, while the reviewer and department-staff surfaces use separate cookies and derive privileged roles only from durable server-side grants; login sets an `HttpOnly` `SameSite=Strict` session cookie and a readable CSRF cookie; **no response exposes `participant_id`**; unknown and missing credentials are refused with a correlation id; session status works with and without a cookie; logout without or with a mismatched CSRF token is refused with 403; logout revokes and clears both cookies with `Max-Age=0`; rotation replaces the credential; logging out of one session does not affect another for the same participant; unknown routes return a structured 404; `real` provider modes and missing secrets both fail startup.

The `SimulatedIdentityAdapter` is additionally run through the shared `describeIdentityAdapterContract` suite that a real provider will have to pass (V008 §4).

## 8. What "logout clears protected local state" covers

Server-side, logout revokes the session row and clears both cookies with `Max-Age=0`, which is verified by test. **Device-side draft clearing is not implemented here** — device drafts do not exist until V019/V020, and their cleanup rule lives in [V005 §6](V005-data-privacy-and-retention.md) (delete after 7 days of inactivity; citizen can clear immediately). V020 must implement that clearing on logout under the agreed shared-device policy.

## 9. Deferred, with triggers

| Deferred                                                         | Trigger                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PostgreSQL-backed repositories                                   | **Done in V018** — `packages/adapters/src/postgres-repositories.ts` implements all three ports and `buildAppWithDatabase` uses them; identity and session logic was not touched. V018 forced this: `submission.participant_id` references `participant`, so an in-memory participant could not own a report ([V018 §5](V018-submission-acceptance-and-receipt.md)) |
| Staff/reviewer authentication, MFA, role and jurisdiction grants | V015 (authorization), V057 (production staff auth)                                                                                                                                                                                                                                                                                                                 |
| Real identity provider                                           | V057, gated on V056 policy approval and provider onboarding                                                                                                                                                                                                                                                                                                        |
| Login CSRF protection                                            | V018 or V057 (see §4)                                                                                                                                                                                                                                                                                                                                              |
| Consent capture (`ConsentRecord`)                                | V019/V044 — the record is contracted in V003 but no consent UI or endpoint exists yet                                                                                                                                                                                                                                                                              |
| Session storage of IP/user-agent for audit                       | V050, and only if [V005](V005-data-privacy-and-retention.md) approves retaining it                                                                                                                                                                                                                                                                                 |

## 10. Approval record

| Decision                                                           | Proposed | Approved by / date |
| ------------------------------------------------------------------ | -------- | ------------------ |
| Identity/session/mapping separation and keyed hashing              | §2       | Pending            |
| Cookie attributes and CSRF approach, including the login exemption | §3, §4   | Pending            |
| Documented demo recovery path                                      | §5       | Pending            |
| Startup refusal on unlabelled simulations and on `real` modes      | §6       | Pending            |
