# Migrations

**Roadmap:** mechanism established by V007; domain schema authored by V012; verified by V013.

## Conventions

- Filenames are `NNNN_snake_case_name.sql`, numbered contiguously from `0001`.
- **Forward-only.** Never edit an applied migration; add a new one. The
  `schema_migrations.checksum` column exists to detect an edited file.
- A `DROP TABLE` requires an explicit `-- allow-destructive: <reason>` comment,
  which `tools/migrate.mjs validate` enforces.
- Expand/contract for anything a running service reads: add the new shape,
  migrate, then remove the old shape in a later migration (V006 §11).

## Current state

`0001_migration_bookkeeping.sql` creates only the ledger table. **No domain
table exists yet**, deliberately:

- the V003 domain contract is still `ready-for-owner-approval`;
- the hard part is expressing V003's invariants as constraints — partial unique
  indexes for "exactly one active row" rules (`IssueEvidenceLink`, `IssueMatch`,
  `Assignment`, `IssueAlias`), effective-dating, and optimistic version columns —
  and that belongs to V012 with its own review;
- no PostgreSQL instance or extension set has been verified (V013).

## Commands

```bash
node tools/migrate.mjs status     # list migrations; applied state unknown until V013
node tools/migrate.mjs validate   # check naming, ordering, destructive statements
node tools/migrate.mjs apply      # refuses: no driver/instance until V012/V013
```
