# Research 112

## D-001 — `.rows[0]` access beats two alternative fixes

Three viable shapes for the fix:

(a) `const [districtsCount] = (await db.execute(...)).rows;` — array
    destructure on `.rows`. Concise, but loses the explicit "this is a
    QueryResult, dig out the row" signal and pairs an array-destructure
    against a property access in one expression.

(b) `const districtsCountResult = await db.execute(...); const districtsCount = districtsCountResult.rows[0] as { c: number } | undefined;` — two-step.
    Verbose but each step is named (Result vs. Row) and the optional
    `undefined` is acknowledged in the type cast rather than papered over.

(c) `const rows = await db.select({ c: sql<number>\`COUNT(*)::int\` }).from(schema.districts);` — drop `execute()` entirely and use Drizzle's typed builder.
    Cleanest at the call site but requires importing the districts
    table into seed.ts twice (it's already imported via `schema.*`) and
    departs more from the original code than necessary for a TS-cleanup
    spec.

Chose (b). It matches the surrounding style (the file uses `await db.X(...).returning(...)` everywhere else with two-step `name = await ...; use(name)`), keeps the diff localised to the one block, and the optional-chain on `.c` makes the empty-result case total. Future readers see "QueryResult → row[0] → field" laid out in three named steps.

## D-002 — Retention guardrail rather than re-fix

The spec brief flagged `retention.ts` (module path) as one of two hints,
but the spec-107 retention work already landed the
`../src/schema/notifications` → `../schema/notifications` fix as part of
its own scope (audited in `tests/governance/test_107_sm8_retention_cron.test.mjs:124-135`).
A re-fix would either no-op or, worse, re-introduce the bug. The
research-backed call is to leave the file alone and add a governance
assertion in this spec's test to prevent regression. The assertion in
`test_107` already does this; we duplicate it here under spec-112's
name so a future contributor reading the workflow-run-8 closure docs
finds the guarantee where they expect it.

## D-003 — Why TS2488 was not caught earlier

`pnpm --filter @gml/db typecheck` was added in spec 108 (deploy-preflight
expansion) but only run in CI under `pnpm -r --if-present typecheck`,
not as a blocking step. The hint surfaced locally in session 6's
exploratory typecheck and was deferred. The lesson — captured for the
Run 8 retro — is that "warnings" from `tsc` are real errors; under
strict mode there are no warnings. This spec demonstrates the fix is
trivial when caught; the cost was the deferral, not the diff.
