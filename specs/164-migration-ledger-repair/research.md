# Research 164 — Migration Ledger Repair

## How the drift happened

Spec 161 (Run-15 audit-closure, password reset + account lockout) and
spec 162 (transcode DLQ admin view) were both authored with manual SQL
files — `0020_password_reset_and_lockout.sql` and
`0021_transcode_jobs_dropped_status.sql` respectively. The TS schema
under `packages/db/src/schema/` was updated in lockstep with those SQL
files (password_reset_tokens table added, users columns added,
transcode_jobs CHECK widened to include `'dropped'`), so the runtime
contract was correct end-to-end.

What was missed: drizzle-kit's bookkeeping ledger lives in
`packages/db/src/migrations/meta/`, NOT inside the SQL files. Two
sibling artefacts must accompany every migration:

  1. An entry in `_journal.json` (the runtime migrator reads this — it's
     how `migrate()` knows which SQL files to apply, in what order).
  2. A `<idx>_snapshot.json` (drizzle-kit's diff base — `generate`
     compares the current schema TS against the latest snapshot to
     decide what new SQL to emit).

A migration authored by hand-rolling the `.sql` (as spec 161 and 162 did)
must ALSO append the journal entry AND author the snapshot. Otherwise
the next `pnpm generate` invocation:

  * Reads the latest snapshot it finds → `0019_snapshot.json`.
  * Diffs the live schema against the 0019 snapshot.
  * Emits a fresh migration covering EVERYTHING the manual 0020 and 0021
    SQL files did, named `0021_<random>.sql`.

The runtime migrator wouldn't break — the journal still pointed at the
correct files — but every contributor running `generate` (the standard
"did I miss a schema edit?" pre-PR check) would see a false-positive
fresh migration AND get a stale journal entry pointing at the wrong tag.

## How drizzle-kit's snapshot chain works

The snapshots form a singly-linked list via `id` and `prevId`:

  * Each snapshot has a top-level `id` (uuid) and `prevId` (uuid of the
    previous snapshot, or empty for `0000_snapshot.json`).
  * The chain encodes the schema's history — drizzle-kit walks it to
    confirm a snapshot wasn't dropped or reordered.

Repairing the chain after the drift means inserting `0020_snapshot.json`
between `0019_snapshot.json` and the post-everything `0021_snapshot.json`:

```
0019_snapshot.json  id=8a2b3c4d…  prevId=6f1a2e7d…
0020_snapshot.json  id=9b3c5e1f…  prevId=8a2b3c4d…  ← NEW link
0021_snapshot.json  id=c8d50621…  prevId=9b3c5e1f…  ← patched from 8a2b3c4d…
```

The new `id` values are arbitrary uuids — drizzle-kit only checks that
the chain is continuous, not the actual byte content of the uuids.

## Why two snapshots, not one

A naive repair would be "regenerate just the post-0021 snapshot — the
0019 → 0021 jump still validates because both ends are accurate". That
works for `migrate` at runtime but breaks `generate`: drizzle-kit's
internal sanity check counts journal entries vs snapshots and refuses
to operate if the chain length is wrong. Both snapshots must exist.

## How the timestamps are chosen

The `when` field is the epoch-ms when the migration was authored.
Drizzle-kit doesn't strictly require monotonicity — the journal is
applied in `idx` order, not `when` order — but mismatched ordering is a
readability footgun. The 0020 entry has `when: 1780672800000` (the
authored timestamp from spec 161). The 0021 entry needs a slightly
larger value; 1780716000000 (about 12 hours later) is well past 0020
and well before any conceivable future migration, so the audit trail
reads cleanly.

## The transcode_jobs check-constraint delta

The ONLY schema delta between `0020_snapshot.json` and
`0021_snapshot.json` lives at:

```
tables['public.transcode_jobs'].checkConstraints['transcode_jobs_status_check'].value
```

Pre-0021: `"transcode_jobs"."status" IN ('queued','running','succeeded','failed','cancelled')`
Post-0021: `"transcode_jobs"."status" IN ('queued','running','succeeded','failed','cancelled','dropped')`

Every other field in the two snapshots is byte-identical (the spec 161
columns / table / indexes already exist in both — they were added in
0020, the snapshot just needs to reflect that).

## Why no SQL files change

The runtime migrator's contract is "for each in-journal idx, run the
matching `<tag>.sql` file once and record it in `__drizzle_migrations`".
The two SQL files for 0020 and 0021 were authored correctly. The
bookkeeping repair is purely in the meta/ subdirectory.

## Trade-off considered: deleting the manual 0020 + 0021 SQL and
## regenerating both via drizzle-kit

Rejected. The manual SQL files for 0020 carry rich comments describing
the lockout state machine (40+ lines of context for the next contributor),
and 0021 carries the audit-closure-MISS rationale for adding `'dropped'`
as a status. A regenerated SQL file from drizzle-kit would lose that
context. Repairing the meta/ ledger preserves the documentation.
