# Tasks 112

- [x] T1 → write governance test (red) → confirm spec-107 already landed the retention.ts module-path fix (verify with grep, no edit needed) → fix `seed.ts` TS2488 by replacing the array-destructure of `db.execute(...)` with explicit `.rows[0]` access plus optional chain → `pnpm --filter @gml/db typecheck` exits 0 → `pnpm -r typecheck` exits 0 → governance test green
