# Quickstart 104

`DATABASE_URL=postgres://… SUPER_ADMIN_EMAIL=… SUPER_ADMIN_INITIAL_PASSWORD=… pnpm --filter @gml/db run seed:all` → runs all 5 phases in order; re-running is a no-op. Confirm with `SELECT COUNT(*) FROM feedback_forms;` (expect ≥ 10 = 4 mentor + 4 mentee + 2 misc) and `SELECT COUNT(*) FROM observation_forms;` (expect 3 on `OBS-2026-001`).
