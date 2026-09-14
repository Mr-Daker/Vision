# V012 — Database Schemas and Core Invariants

**Status:** Ready for owner approval
**Roadmap task:** V012 · **Prerequisites:** V003, V005, V008 · **Owner:** Backend
**Code:** `migrations/0002`–`0009` · **Tests:** `packages/adapters/src/persistence.dbtest.ts`

> 9 migrations, 22 tables. Verified on PostgreSQL 17.11 + PostGIS 3.6.4 + pgvector 0.8.6 (see [V013](V013-local-persistence-stack.md)).

## 1. Migrations

| File                              | Contents                                                                                                                                   |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `0002_extensions`                 | postgis, vector. **No embedding column** — dimensions/model are V023 decisions                                                             |
| `0003_events_and_outbox`          | `status_event` (append-only), `outbox`                                                                                                     |
| `0004_identity_and_consent`       | `participant`, `identity_mapping`, `app_session`, `consent_record`                                                                         |
| `0005_reference_data`             | `source_record`, `jurisdiction`, `infrastructure_asset`, `responsibility_directory`                                                        |
| `0006_submission_and_evidence`    | `submission`, `evidence_item`, `processing_stage`                                                                                          |
| `0007_issue_and_matching`         | `canonical_issue`, `issue_match`, `issue_evidence_link`, `issue_participation`, `assignment`, `issue_merge`, `issue_alias`, `project_link` |
| `0008_resolution`                 | `resolution_claim`, `resolution_evidence_item`, `resolution_confirmation`, `reopening`                                                     |
| `0009_fix_consent_purposes_check` | **Corrective** — see §4                                                                                                                    |

## 2. The three invariants V012 exists to enforce

| Requirement                         | Constraint                                   | Proven by                                                       |
| ----------------------------------- | -------------------------------------------- | --------------------------------------------------------------- |
| No repeated request acceptance      | `submission_participant_idempotency_uniq`    | _"a replayed submission cannot be accepted twice"_              |
| No duplicate stage identities       | `processing_stage_identity_uniq`             | _"at-least-once delivery cannot create two rows for one stage"_ |
| No repeated participation per issue | `issue_participation_participant_issue_uniq` | _"one participant counts once per canonical issue"_             |

## 3. Effective-dating via partial unique indexes

The hard part. Each "exactly one active row" rule from V003 is a partial unique index, and each is tested both for rejection **and** for allowing a successor once the prior row is closed:

`issue_evidence_link` (per evidence) · `issue_match` (per submission) · `assignment` (per issue) · `issue_alias` (per source issue).

## 4. A real bug the tests found

`array_length(granted_purposes, 1) >= 1` did **not** reject an empty array: `array_length` returns NULL for `'{}'`, and a CHECK passes when its expression is NULL. Consent with zero purposes was being accepted, contradicting V003's `minimum_items: 1`.

Fixed in `0009` with `coalesce(array_length(...), 0) >= 1`, as a **new** migration rather than an edit to `0004` — the forward-only rule working as intended.

## 5. Event time versus ingestion time

`occurred_at` and `recorded_at` are separate columns on `status_event`; the same split appears on `submission` (`observed_at` / `server_received_at`) and `source_record` (`source_effective_at` / `retrieved_at`). A test inserts a reconciliation event two hours in the past and asserts the columns diverge.

## 6. Privacy constraints enforced in SQL

Reference-only/unavailable sources cannot carry a `raw_snapshot` or be labelled permitted · a jurisdiction needs real or explicitly synthetic provenance · an external code needs a source record · `identity_mapping.provider_subject_hash` must match `^[0-9a-f]{64}$` so a raw provider reference cannot be stored · a public derivative requires an approved redaction decision · only voice evidence may carry a transcript · erasure nulls every restricted column while keeping the tombstone.
