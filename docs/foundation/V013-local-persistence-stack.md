# V013 — Local Persistence Stack and Migration Verification

**Status:** Ready for owner approval
**Roadmap task:** V013 · **Prerequisites:** V007, V011, V012 · **Owner:** Platform + Backend
**Code:** `docker-compose.yml`, `docker/postgres/Dockerfile`, `tools/db.mjs`, `tools/seed-fixtures.mjs`

> Spatial and vector capability is **verified by query, not assumed from documentation** — the V013 acceptance condition. `npm run db:verify` runs those queries and checks their answers.

## 1. Verified versions

| Component  | Version                   | How it was verified                                                                                                                         |
| ---------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL | **17.11** (Debian, arm64) | `select version()` on the running container                                                                                                 |
| PostGIS    | **3.6.4**                 | `ST_DWithin` on `geography` returned 53.3 m for a known pair — within 60 m, outside 10 m, so it is measuring **metres** rather than degrees |
| pgvector   | **0.8.6**                 | `'[1,0,0]' <-> '[0,1,0]'` = 1.4142 (√2); cosine of identical vectors = 0; `vector_dims` = 3                                                 |

This confirms the provisional pins recorded in [V007 §2](V007-development-workspace.md) (PostGIS 3.4+, pgvector 0.8.x) and replaces them with measured values.

**Why a custom image:** `postgis/postgis` publishes no `linux/arm64` manifest, which would exclude Apple Silicon machines. The image is built from the official multi-arch `postgres:17` with the PGDG `postgresql-17-postgis-3` and `postgresql-17-pgvector` packages.

## 2. Commands

```bash
npm run db:up        # build + start, waits for healthcheck
npm run db:migrate   # forward-only, checksummed
npm run db:verify    # capability + invariant checks
npm run db:seed      # V011 development split only
npm run test:db      # 30 real-database invariant tests
npm run db:reset     # GUARDED — see §4
```

## 3. Fresh-install and forward-migration check

`db:reset` followed by `db:migrate` applied all 9 migrations from an empty schema, each in its own transaction. `db:migrate` refuses to run if an already-applied migration's checksum changed, and re-running when up to date is a no-op. Migration `0009` was applied incrementally on top of an existing schema, exercising the forward-only path rather than only the from-scratch path.

`db:verify` additionally asserts that 10 named constraints/indexes exist, so a migration that silently dropped an invariant fails the check.

## 4. Destructive-command guard

`db:reset` refuses unless **both** conditions hold: `DATABASE_URL` points at loopback (`localhost`/`127.0.0.1`/`::1`), and `VISION_ALLOW_DESTRUCTIVE=yes` is set. A development reset therefore cannot target a shared or production database. The container itself binds to `127.0.0.1:5432`, so it is unreachable from the network.

## 5. Bounded resources

The container runs with `max_connections=50`, `statement_timeout=15s`, `idle_in_transaction_session_timeout=30s`, and slow-query logging at 500 ms — a local approximation of the [V006 §5](V006-architecture-and-deployment-decisions.md) budget. `tools/db.mjs` uses a 30 s statement timeout for migrations specifically, because a migration can legitimately exceed the request-path limit.

## 6. Seeding

`db:seed` loads the V011 **development** split: 3 jurisdictions (with real polygons), 6 assets, 11 routing rules, 2 participants, 12 submissions, 12 evidence items. It is idempotent — a second run inserts 0 rows — because every id is derived deterministically from the fixture id.

Verified against the seeded data: `ST_DWithin` joins submissions to assets within their disclosed accuracy radius (3.9 m–17 m), and `ST_Covers` places 3 assets in each block and all 6 in the district.

The holdout is never seeded, and the seeder does not import the holdout loader.

## 7. Accepted divergence from a deployed environment

No managed backups, HA, failover, or restore drill (V062) · local delivery is more orderly than production, so V022 must inject duplicates deliberately · `SESSION_COOKIE_SECURE=false` locally.
