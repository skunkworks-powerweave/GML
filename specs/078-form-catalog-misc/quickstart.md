# Quickstart 078

`DATABASE_URL=postgres://... pnpm --filter @gml/db exec tsx src/scripts/seed_forms_misc.ts` → inserts 2 rows; re-run is a no-op. Confirm with `SELECT version, schema->>'purpose' FROM feedback_forms WHERE version IN ('schoolvisit-1','endline-1');`.
