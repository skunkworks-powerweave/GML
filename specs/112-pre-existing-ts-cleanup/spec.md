# Spec 112 — Pre-existing TS Cleanup (Workflow Run 8 Tier E2)

## Why

Session 6 closed with two known TypeScript hints lurking in `packages/db`
that the `pnpm --filter @gml/db typecheck` script surfaced but no spec
had owned. Session 7's handoff documented them as the "pre-existing TS
hints" — non-fatal because `tsc --noEmit` exited cleanly under
`skipLibCheck` plus `isolatedModules`, but `tsc` on the workspace flagged
them and they sat as orange noise on every typecheck. Run 8 Tier E2
closes them out so the workspace typecheck is green-on-green and future
contributors don't have to learn which hints are "known" vs. real.

The first hint is a stale module-path import in
`packages/db/src/scripts/retention.ts` — the handoff text reads
"`retention.ts` (module path)". Spec 107 (SM-8 retention cron) corrected
the `../src/schema/notifications` → `../schema/notifications` typo as
part of its own work; this spec re-verifies that the fix has held and
guards it against regression.

The second hint is more substantive — `packages/db/src/scripts/seed.ts`
destructures the result of `db.execute(sql\`SELECT COUNT(*)…\`)` as
though it were an array, but Drizzle's node-postgres `execute()` returns
a pg `QueryResult` object (`{ rows, rowCount, command, … }`), which is
NOT iterable. TypeScript surfaces this as **TS2488: Type
'QueryResult<Record<string, unknown>>' must have a '[Symbol.iterator]()'
method that returns an iterator.** At runtime the destructure silently
yielded `undefined` for the first element and the subsequent count
check (`(districtsCount as { c: number }).c > 0`) would throw a
`TypeError: Cannot read properties of undefined (reading 'c')` the first
time anyone re-ran `pnpm --filter @gml/db seed` against a populated DB.
The bug was masked in CI because the test DB is empty so the COUNT
returned a row and the destructure happened to grab the QueryResult
object itself — which has no `.c` property, so the comparison resolved
to `false` and seeding proceeded. A wrong outcome by accident.

## What

Two surgical edits in `packages/db/src/scripts/`:

1. **`seed.ts`** — replace
   ```ts
   const [districtsCount] = await db.execute(sql`SELECT COUNT(*)::int AS c FROM districts`);
   if ((districtsCount as { c: number }).c > 0) { … }
   ```
   with
   ```ts
   const districtsCountResult = await db.execute(sql`SELECT COUNT(*)::int AS c FROM districts`);
   const districtsCount = districtsCountResult.rows[0] as { c: number } | undefined;
   if ((districtsCount?.c ?? 0) > 0) { … }
   ```
   The `.rows[0]` access matches the pg `QueryResult` shape Drizzle's
   `execute()` returns, the optional chain handles the empty-result edge
   (which a `SELECT COUNT(*)` will never hit but TypeScript can't prove),
   and the `??` keeps the comparison total.

2. **`retention.ts`** — re-verify that the import is
   `from "../schema/notifications"` (relative to `src/scripts/`) and NOT
   `from "../src/schema/notifications"` (which would resolve to
   `packages/db/src/src/...`, a non-existent path). Spec 107 already
   landed the fix; this spec adds a governance assertion so a future
   careless refactor doesn't reintroduce it.

## Edge cases

- **Empty result rows.** A `SELECT COUNT(*)` always returns one row, but
  the typed return is `Record<string, unknown>[]` and TypeScript can't
  narrow that. The `?.` + `?? 0` handles `undefined` cleanly.
- **`rowCount` vs. `rows.length`.** We deliberately use `.rows[0]`, not
  `.rowCount`, because we need the COUNT column value, not the number of
  rows returned. Easy to confuse — the comment in the diff calls this
  out so the next reader doesn't "simplify" it.
- **No behavioural change for retention.ts.** The module path was already
  correct as of spec 107; this spec only adds the guardrail.

## Non-goals

- No changes to schema files.
- No changes to runtime behaviour (the fix is type-only plus a
  null-safe access that matches the previously-intended semantics).
- No new dependencies.
- No reformat of unrelated lines — keep the diff minimal.

## Definition of done

- `pnpm --filter @gml/db typecheck` exits 0 with no errors or warnings.
- `packages/db/src/scripts/seed.ts` accesses `.rows[0]` on the
  `db.execute()` result.
- `packages/db/src/scripts/retention.ts` imports from
  `'../schema/notifications'` (not `'../src/schema/notifications'`).
- `packages/db/package.json` still exposes a `typecheck` script (it did
  per Tier-A audit; this spec asserts it stays).
- Governance test
  `tests/governance/test_112_pre_existing_ts_cleanup.test.mjs` asserts
  the absence of the old patterns and the presence of the new ones,
  plus the typecheck script and tsconfig.json existence.
