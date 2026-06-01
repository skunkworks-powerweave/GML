# Quickstart 077
After `pnpm --filter @gml/db run seed`, run `pnpm --filter @gml/db exec tsx src/scripts/seed_forms_observation.ts` — three observation form templates (pre / post / observer) are inserted onto cycle `OBS-2026-001`; re-running prints `skipped: 3, inserted: 0`.
