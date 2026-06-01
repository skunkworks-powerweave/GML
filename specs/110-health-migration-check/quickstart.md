# Quickstart 110

`curl -s http://localhost:3000/api/health | jq` → expect `ok:true` only when `migrations.applied >= migrations.expected`. Tear-down test: drop the `drizzle` schema (`psql -c "DROP SCHEMA drizzle CASCADE;"`) and re-hit `/api/health` → `details.migrations.error` must equal `"drizzle migrations table not found"` and the top-level `ok` must flip to `false`. Repair by running `pnpm --filter @gml/db run migrate` and re-hitting the endpoint.
