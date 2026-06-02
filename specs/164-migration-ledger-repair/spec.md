# Spec 164 — Migration Ledger Repair

## Why

The Workflow Run 16 post-audit sweep flagged a real-but-quiet drizzle-kit
bookkeeping drift in `packages/db/src/migrations/`. The drift was invisible
at runtime — `pnpm --filter @gml/db migrate` walks the SQL files referenced
in `_journal.json` and APPLIES them in order, so the runtime path was fine —
but `pnpm --filter @gml/db generate` (the dev-time "did I miss a schema
edit?" check) was broken: the generator would always emit a NEW migration
file because the snapshot ledger didn't reflect the schema state captured
by the most recent two manual migrations.

Pre-fix snapshot of the drift, taken from the sweep audit:

  * `_journal.json` ended at `idx: 20 / tag: 0020_password_reset_and_lockout`
    (spec 161, Workflow Run 15 audit-closure).
  * On disk, `0021_transcode_jobs_dropped_status.sql` was authored by spec
    162 (the transcode DLQ admin view) and shipped with the rest of that
    spec — but the corresponding `_journal.json` entry was never added.
  * Snapshots for both `0020_snapshot.json` AND `0021_snapshot.json` were
    missing — drizzle-kit's snapshot chain ended at `0019_snapshot.json`
    (post spec-160 quiz-time-limit).
  * Net effect: `pnpm --filter @gml/db generate` would re-emit ALL of the
    schema changes from 0020 + 0021 as a single fresh "0021_<random>.sql"
    on every invocation, masking any actual new schema drift behind a
    perpetual false-positive.

This spec closes that drift with NO RUNTIME EFFECT — every SQL file the
production migrator actually runs is unchanged. The repair is purely in
the drizzle-kit bookkeeping ledger (`_journal.json` + the two missing
`*_snapshot.json` files), so the generator returns "No schema changes,
nothing to migrate 😴" on a clean checkout and the next contributor who
adds a schema edit sees their delta cleanly instead of being buried under
the false-positive backlog.

## What

Three artefact changes under `packages/db/src/migrations/meta/`:

  1. **`_journal.json` — append entry 21.** Add a fresh `{ idx: 21,
     version: "7", when: <epoch ms slightly past 0020's when>, tag:
     "0021_transcode_jobs_dropped_status", breakpoints: true }` entry so
     drizzle-kit's runtime migrator sees the manual `0021_*.sql` as an
     in-ledger migration rather than an orphan.

  2. **`0020_snapshot.json` — regenerated.** Captures schema state AFTER
     `0020_password_reset_and_lockout.sql` (password_reset_tokens table,
     users.failed_login_count, users.locked_until) but BEFORE the
     `transcode_jobs_status_check` widening — `'dropped'` is NOT in the
     status enum yet. `prevId` points to `0019_snapshot.json`'s id.

  3. **`0021_snapshot.json` — regenerated.** Captures the post-0021 schema
     state. The ONLY delta from `0020_snapshot.json` is the
     `transcode_jobs_status_check` constraint value, which gains
     `'dropped'` as a valid status. `prevId` points to `0020_snapshot.json`'s
     new id.

Plus the standard five spec-kit files under `specs/164-migration-ledger-repair/`
and a governance test at `tests/governance/test_164_migration_ledger_repair.test.mjs`
that pins the repair so a future drift can't sneak through unnoticed.

## Acceptance

  * `pnpm --filter @gml/db generate` reports "No schema changes, nothing
    to migrate" on a clean checkout (verified manually in the run that
    produced this spec).
  * `_journal.json` has exactly 22 entries (`idx: 0` through `idx: 21`).
  * The number of `.sql` files in `packages/db/src/migrations/` equals
    the number of `entries[]` in `_journal.json` (one journal entry per
    migration file).
  * Every entry's `tag` field starts with the four-digit zero-padded
    `idx` so the disk-file-to-journal mapping is bijective.
  * The governance test passes.
