# V007 — Development Workspace and Automated Checks

**Status:** Ready for owner approval
**Roadmap task:** V007 (Foundation) · **Prerequisites:** V006 · **Owner:** Platform
**Companions:** [V006 architecture](V006-architecture-and-deployment-decisions.md) · [V005 privacy](V005-data-privacy-and-retention.md) · [V001 Appendix G](V001-scope-and-release-boundaries.md)

> A clean checkout can run every documented check with **no database, no provider API key, and no `.env` file**. That is the V007 acceptance condition and it is verified by `npm run check`.

**Revision note (after V016–V020):** the command list, the check table and §3 now include the browser build (`build:web`), the dev server (`dev`), `check:browser-safe`, and the current test counts. `test:db` runs serially, and the scope check's locale pattern was tightened after V019 found a default it had missed.

**Revision note (dependency pass after V011–V015):** the database and extension pins in §2 were provisional when this document was written; V013 has since measured them, so §2 now records verified versions. §6 no longer says the schema does not exist — V012 authored it and V013 applied it. Layout, commands, checks and limitations are updated to match what is actually in the tree.

## 1. Layout

```
package.json            npm workspaces root; all scripts live here
tsconfig.base.json      strict compiler options
tsconfig.json           single project covering every package
.nvmrc                  pinned Node version
.env.example            tracked template; .env itself is git-ignored
.prettierrc.json        formatting rules
migrations/             9 versioned SQL migrations (V012), applied by tools/db.mjs
docker-compose.yml      local persistence stack (V013)
docker/postgres/        Postgres + PostGIS + pgvector image (V013)
tools/                  repository checks, migration runner, fixture seeder
.github/workflows/ci.yml

packages/contracts      V008 contracts. Leaf: imports no workspace package.
packages/domain         pure policy (sessions, transitions, alias, authorization)
packages/config-packs   versioned scope configuration; imports contracts only
packages/fixtures       V011 corpus and sealed evaluation holdout
packages/adapters       provider adapters (V009, V010) + real-database tests
apps/api                public API service
apps/worker             private worker (placeholder until V017)
apps/web                demo identity UI only; citizen flow is V019
```

Import direction is the rule from [V006 §9](V006-architecture-and-deployment-decisions.md) and is enforced by `tools/check-import-direction.mjs`, not by convention.

## 2. Pinned versions

Every pin below has now been verified by running it. The database and extension
rows were provisional in the original draft; [V013](V013-local-persistence-stack.md)
measured them.

| Component     | Pin                  | Verification status                                                                                     |
| ------------- | -------------------- | ------------------------------------------------------------------------------------------------------- |
| Node.js       | `.nvmrc` → `v26.4.0` | **Verified**: the whole check suite runs on it, including native TypeScript execution and `node --test` |
| npm           | 11.17.0              | **Verified** (workspace install and `npm ci` script path)                                               |
| TypeScript    | `5.9.3` (exact)      | **Verified**: `tsc --noEmit` passes with the strict option set below                                    |
| Prettier      | `3.9.6` (exact)      | **Verified**: `--check` passes across the repository                                                    |
| `@types/node` | `24.10.1` (exact)    | **Verified** against the code in this workspace                                                         |
| `pg`          | `8.16.3` (exact)     | **Verified**: drives the migration runner and the 30 real-database tests                                |
| `@types/pg`   | `8.15.6` (exact)     | **Verified**                                                                                            |
| PostgreSQL    | **17.11**            | **Verified** (V013): `select version()` on the running container                                        |
| PostGIS       | **3.6.4**            | **Verified** (V013): `ST_DWithin` on `geography` measured real metres, not degrees                      |
| pgvector      | **0.8.6**            | **Verified** (V013): L2 distance of orthogonal unit vectors returned √2                                 |

The measured extension versions satisfy the originally proposed floors (PostGIS 3.4+, pgvector 0.8.x). `pg` is the only runtime dependency in the workspace; everything else is a dev dependency.

TypeScript 7.0.2 was available and deliberately **not** adopted: no compatibility check was performed against it, and V007 requires pinning _after_ a check, not before.

### Why native TypeScript execution

Node runs the `.ts` sources directly by stripping types, so there is no build step, no emitted `dist/`, and no source-map indirection during development. The cost is a real constraint, enforced by `erasableSyntaxOnly`: **no enums, no namespaces, no constructor parameter properties, no decorators.** Constructor parameter properties were used in the first draft of the adapters and had to be rewritten as explicit fields — the compiler catches this, so it cannot regress silently.

## 3. Commands

```bash
npm install                 # install pinned dev dependencies
npm run check               # everything CI runs, in CI order
npm test                    # node:test across packages and apps
npm run typecheck           # tsc --noEmit
npm run format              # prettier --write
node apps/api/src/index.ts  # run the API alone (needs the .env values exported)

# Citizen interface (V019) — needs the database
npm run build:web           # tsc -> browser ESM, then rewrite workspace specifiers
npm run dev                 # API + interface on one origin at http://127.0.0.1:8787

# Local persistence stack (V013) — not needed for `npm run check`
npm run db:up               # build + start Postgres/PostGIS/pgvector
npm run db:migrate          # apply pending migrations, forward-only
npm run db:verify           # prove spatial + vector capability by query
npm run db:seed             # load the V011 development split
npm run test:db             # real-database tests, run serially (shared database)
npm run db:down             # stop the stack
```

`npm run check` runs: `format:check` → `typecheck` → `check:imports` → `check:scope` → `check:secrets` → `check:holdout` → `check:browser-safe` → `check:migrations` → `test`.

`typecheck` is two passes: the root project, then `apps/web` on its own, because the web app needs the DOM library and a single `tsconfig` cannot give one directory a different `lib`.

`test:db` runs with `--test-concurrency=1`. The dbtest files share one mutable database, so running them in parallel was never sound — one file's committed rows are visible to another's queries.

The `db:*` commands and `test:db` are deliberately **outside** `npm run check`, so the acceptance condition above still holds on a machine with no Docker.

## 4. Automated checks

Each check was **negative-tested** — deliberately broken to confirm it fails — because a check that has only ever passed proves nothing.

| Check                | Enforces                                                                                                                                                 | Negative test performed                                                                                                                                                                                                             |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `format:check`       | Prettier style across all tracked text                                                                                                                   | — (formatter is self-evident)                                                                                                                                                                                                       |
| `typecheck`          | `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature`, `verbatimModuleSyntax`, `erasableSyntaxOnly`   | Yes — caught parameter properties and unchecked index access during development                                                                                                                                                     |
| `check:imports`      | [V006 §9](V006-architecture-and-deployment-decisions.md) layering                                                                                        | Yes — planted `domain → adapters` import; failed with the expected message                                                                                                                                                          |
| `check:scope`        | [V001 Appendix G rule 7](V001-scope-and-release-boundaries.md): no production branch on `Sangli`, `mr-IN`, `school-infrastructure`                       | Yes — planted `l === "mr-IN"` in domain; failed and named file/line                                                                                                                                                                 |
| `check:secrets`      | [V005 §7](V005-data-privacy-and-retention.md): no secret or private evidence in version control                                                          | Yes — planted a Google-format key, a high-entropy `SECRET_TOKEN` assignment, and a force-added `.env`; all three failed. Two false positives were found and fixed: kebab-case demo identifiers, and `${...}` template interpolation |
| `check:holdout`      | [V011](V011-fixtures-and-sealed-holdout.md): the evaluation holdout is referenced only from evaluation paths, and `VISION_EVAL_RUN=1` is never committed | Yes — planted a holdout import in `domain`; failed. Also fixed a false positive where the checker flagged its own regex source                                                                                                      |
| `check:migrations`   | Migration naming, contiguous ordering, unjustified `DROP TABLE`                                                                                          | Yes — validated across all 9 migrations                                                                                                                                                                                             |
| `check:browser-safe` | V019: nothing shipped to the browser imports a Node built-in, `@vision/adapters`, or a server-only global                                                | Yes — planted a `node:fs/promises` import and a `process.env` read in `domain`; both failed with file and line                                                                                                                      |

`check:secrets` scans **git-tracked files only**. Note that in a repository with no commits it reports "0 files scanned" and passes vacuously; the negative tests above were run with `git add -N` so the tree was actually visible to it.

Configuration packs, locale resources and test files are exempt from `check:scope` by design: scope belongs in data, and a test may legitimately assert that a specific pack value is handled. Two gaps in that check were found and closed during V019: `.dbtest.ts` files were not being treated as tests, and the locale pattern only matched a tag that was the _whole_ string literal, so a `"en-IN,mr-IN"` default inside `apps/api/src/server.ts` had slipped through. `SUPPORTED_LOCALES` is now required configuration with no default in code.

## 5. Secrets and environment handling

- `.env.example` is tracked and contains **only** local placeholders; `.gitignore` excludes `.env` and every `.env.*` variant except the example.
- Values marked `[L3c]` in the template are secrets under [V005 §1](V005-data-privacy-and-retention.md) and must be injected from a secret manager in any deployed environment.
- The API refuses to start without `SESSION_TOKEN_HMAC_KEY` and `IDENTITY_MAPPING_HMAC_KEY`. There is no default, because a default key would make every environment's hashes identical and silently correlatable.
- `.gitignore` also excludes `private-media/`, `evidence-originals/`, `quarantine/` and `local-object-store/` so private evidence cannot reach version control or a build artifact.

## 6. Migrations

V007 established the mechanism; [V012](V012-database-schema-and-invariants.md) authored the schema and [V013](V013-local-persistence-stack.md) applied it. There are now **9 migrations covering 22 tables**, including the partial unique indexes that express the [V003](V003-domain-and-lifecycle-contracts.md) "exactly one active row" rules.

Two tools, deliberately split:

- `tools/migrate.mjs validate` — offline naming/ordering/destructive-statement check. Needs no database, so it runs in `npm run check`.
- `tools/db.mjs migrate` — applies pending migrations with checksums, one transaction each, and **refuses if an already-applied migration was edited**. This replaced V007's original `migrate.mjs apply`, which refused to run at all while no driver or instance existed.

The forward-only rule has already been exercised in anger: migration `0009` corrects a faulty CHECK constraint in `0004` rather than editing it (see [V012 §4](V012-database-schema-and-invariants.md)).

## 7. CI

`.github/workflows/ci.yml` runs the checks in the same order as `npm run check`, on the `.nvmrc` Node version, with `npm ci` from the lockfile, `permissions: contents: read`, and no secret available to any step. A final step asserts that no `.env` file is present, so a check that silently depended on local configuration would fail the build.

## 8. Known limitations

- **No lockfile-based reproducibility guarantee across platforms yet.** `package-lock.json` is committed and CI uses `npm ci`, but only macOS/arm64 and the CI image are exercised.
- **`check:secrets` is a heuristic**, not a scanner. It catches known provider formats, high-entropy credential assignments, and forbidden paths. It is not a substitute for provider-side secret scanning or key rotation.
- **`apps/worker` is a placeholder** exporting a status constant, so it cannot be mistaken for working software. `apps/web` now contains only the demo identity UI; the citizen capture flow is V019.
- **The local stack is not a deployed environment.** It validates PostGIS/pgvector capability and a bounded local connection ceiling, but no managed backup, HA, failover, or restore drill exists (V062), and no cloud resource is provisioned (V051).
- **`test:db` requires Docker**, so it is not part of the clean-checkout acceptance condition.

## 9. Approval record

| Decision                                          | Proposed | Approved by / date |
| ------------------------------------------------- | -------- | ------------------ |
| Workspace layout and import-direction enforcement | §1, §4   | Pending            |
| Verified runtime/tooling pins                     | §2       | Pending            |
| Database/extension pins, now measured at V013     | §2       | Pending            |
| Check set and CI gate                             | §4, §7   | Pending            |
