# Tasks 164 — Migration Ledger Repair

## Implementation

  * [x] Read `packages/db/src/migrations/meta/_journal.json` and record
        the current last idx (20) and tag (`0020_password_reset_and_lockout`).
  * [x] Glob `packages/db/src/migrations/*.sql` and confirm
        `0021_transcode_jobs_dropped_status.sql` exists on disk but
        isn't represented in the journal.
  * [x] Glob `packages/db/src/migrations/meta/*.snapshot.json` and
        confirm `0020_snapshot.json` AND `0021_snapshot.json` are both
        absent (chain ends at `0019_snapshot.json`).
  * [x] Run `pnpm --filter @gml/db generate` to capture the live schema
        state into a fresh snapshot. The generator emits a
        `0021_<random>.sql` covering all schema changes since 0019 plus
        a matching `0021_snapshot.json`.
  * [x] Delete the auto-generated `0021_<random>.sql` (the manual
        `0021_transcode_jobs_dropped_status.sql` already captures the
        delta correctly; preserving the manual file's comments is the
        whole point of the repair).
  * [x] Copy the generated `0021_snapshot.json` to `0020_snapshot.json`.
  * [x] Edit `0020_snapshot.json`:
        - Replace the top-level `id` with a fresh uuid
          (`9b3c5e1f-4a2d-7369-b6c7-de5f9e8f7654`).
        - Keep `prevId` pointing at 0019's id.
        - Revert the `transcode_jobs_status_check` constraint value to
          its pre-0021 form: drop `'dropped'` from the IN clause.
  * [x] Edit `0021_snapshot.json`:
        - Patch its `prevId` to point at the new 0020 id.
  * [x] Append the journal entry for `0021_transcode_jobs_dropped_status`
        with `when: 1780716000000`.
  * [x] Run `pnpm --filter @gml/db generate` again — confirm "No schema
        changes, nothing to migrate".

## Governance test

  * [x] Author `tests/governance/test_164_migration_ledger_repair.test.mjs`
        with the six required assertions:
        1. `_journal.json` has an entry at idx 21 with a tag matching
           the `^0021_` prefix.
        2. `_journal.json` has exactly 22 entries.
        3. `meta/0020_snapshot.json` exists and is valid JSON.
        4. `meta/0021_snapshot.json` exists and is valid JSON.
        5. The number of `.sql` files in migrations equals the number
           of journal entries.
        6. `0021_*.sql` contains CREATE/ALTER referencing transcode_jobs.

## Spec-kit

  * [x] `specs/164-migration-ledger-repair/spec.md`
  * [x] `specs/164-migration-ledger-repair/plan.md`
  * [x] `specs/164-migration-ledger-repair/research.md`
  * [x] `specs/164-migration-ledger-repair/quickstart.md`
  * [x] `specs/164-migration-ledger-repair/tasks.md`

## Out of scope

  * Reverting the manual SQL files or regenerating them. The manual
    files carry rich comments; the repair is purely in the meta/ ledger.
  * Re-running migrations against a live database. The runtime migrator
    has been applying the correct SQL files all along — the drift was
    dev-time-only.
  * Schema changes. This spec ships ZERO schema delta.
