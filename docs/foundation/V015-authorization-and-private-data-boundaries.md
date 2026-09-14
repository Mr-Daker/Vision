# V015 — Authorization and Private-Data Boundaries

**Status:** Ready for owner approval
**Roadmap task:** V015 · **Prerequisites:** V005, V009, V012, V014 · **Owner:** Backend + Security
**Code:** `packages/domain/src/authorization.ts` · **Tests:** `authorization.test.ts` (16)

> Pure policy, testable without HTTP. Enforcement at the request boundary lands with the endpoints themselves (V018+), following the pattern already used for [V009](V009-sessions-and-simulated-identity.md).

## 1. Why a forged principal cannot work

`derivePrincipal` is the only way to build a `Principal`, and **it accepts no client-controlled identifier**. It takes a validated session result (V009) plus a server-side role/jurisdiction grant looked up by participant. There is no parameter a request body could influence, so a forged `participant_id` has no path into an authorization decision — a structural property, not a validation step that could be forgotten.

It also refuses to construct a staff principal without a staff account, or a non-administrator staff principal with an empty jurisdiction scope.

## 2. Roles and jurisdiction scoping

Five roles (`citizen`, `reviewer`, `department_staff`, `supervisor`, `administrator`) over 15 actions. Seven actions are jurisdiction-scoped and are denied both when the resource carries no jurisdiction and when it falls outside the principal's scope. Tests cover cross-jurisdiction writes and reads, and role-inappropriate transitions (a supervisor may not transition an issue or claim resolution; staff may not decide redaction).

**Simulated identity still exercises real authorization** — the citizen principal in the tests comes from the simulated adapter and is refused every staff action.

## 3. Private-data boundaries

- **`identity_mapping.read` is denied to every role**, including administrator — it is reachable only by the identity service, which is not an application principal ([V005 §3](V005-data-privacy-and-retention.md)).
- **Reading a private original is exceptional**: it requires a recorded purpose of ≥8 characters and returns `auditRequired: true`, so every such access emits an L3b audit event. Routine redacted access is not flagged. A citizen is refused regardless of the purpose they supply.
- **Public views are built by construction, not by deletion**: `toPublicIssueView` names the fields it emits, so a restricted field added upstream is excluded by default instead of leaking until someone remembers to filter it. `findPublicLeaks` is the paired assertion, and a test serialises the view to confirm originals, the participant id, and raw model output are all absent while approved derivatives remain.

## 4. Quotas with actionable errors

`checkQuota` is a sliding window with conservative demonstration defaults (10 submissions/hour, 30 upload grants/hour, 20 confirmations/hour — owner-tunable per V049). A rejection returns `retryAfterMs` computed from when the oldest in-window request expires, plus the limit and window, so a client can behave correctly instead of retrying blindly. Tests cover the boundary, window sliding, the retry-delay calculation (60 s), and an unthrottled action.

## 5. Not yet done

Middleware that applies these decisions to real requests (V018+) · staff sign-in, MFA and grant administration (V057) · persisted per-principal usage counters — the policy is pure and takes usage as input, so V018 supplies the store · audit-event writing (V050).
