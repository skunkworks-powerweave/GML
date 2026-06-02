# Quickstart 164 — Migration Ledger Repair

## Verify the repair on a fresh checkout

```bash
cd packages/db
pnpm install
pnpm generate
# Expected:
# ...
# No schema changes, nothing to migrate 😴
```

If drizzle-kit emits a new migration file, the repair has drifted and
the spec 164 governance test will catch it.

## Re-deriving the snapshot chain by hand

If you ever need to rebuild the snapshots from scratch:

1. Note the existing journal entries — count them, capture their `tag`
   field, and check the snapshot prevId chain in
   `packages/db/src/migrations/meta/*.snapshot.json`.

2. Find the LAST snapshot whose `prevId → id` chain is continuous from
   `0000_snapshot.json`. That's your anchor.

3. Run `pnpm --filter @gml/db generate` from the repo root. Drizzle-kit
   will emit a new migration file capturing every schema change since
   the anchor snapshot AND the matching post-everything snapshot.

4. If the resulting SQL file duplicates work already done by an
   in-journal manual SQL file — delete the generated SQL, then patch
   the new snapshot's `prevId` to chain it cleanly into the post-anchor
   slot. Add the journal entry for the manual SQL file by hand.

5. Re-run `pnpm --filter @gml/db generate` to confirm "No schema
   changes". If it still emits something, the manual SQL drifted from
   the TS schema — investigate that delta before continuing.

## Why this can't be a `db migrate` operation

The `migrate.ts` runner reads `_journal.json` and applies SQL files in
idx order. It NEVER touches the `*_snapshot.json` files — those are
generator-only artefacts. So a missing snapshot doesn't break runtime,
it only breaks the dev-time schema-drift check.

## What changed under `meta/`

```
meta/
  _journal.json                  EDITED — append idx 21 entry
  0020_snapshot.json             CREATED — captures post-spec-161 schema
  0021_snapshot.json             CREATED — captures post-spec-162 schema
  (all 0000_*.json … 0019_*.json untouched)
```

## What did NOT change

  * Any `.sql` file under `packages/db/src/migrations/`.
  * Any `.ts` schema file under `packages/db/src/schema/`.
  * Any production migration that has already shipped.

## Sanity checks

After the repair:

```bash
node -e "
  const j = require('./packages/db/src/migrations/meta/_journal.json');
  console.log('journal entries:', j.entries.length);
  const last = j.entries[j.entries.length - 1];
  console.log('last entry:', last.tag, last.idx);
"
# journal entries: 22
# last entry: 0021_transcode_jobs_dropped_status 21
```
