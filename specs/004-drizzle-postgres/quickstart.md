# Quickstart 004 — Drizzle DB

```powershell
pnpm install
# Generate the initial migration files from the schema:
pnpm --filter @gml/db generate
# Apply against the running compose stack (when docker compose is up):
pnpm --filter @gml/db migrate
```

The first migration will create the role enum and the 4 Auth.js identity tables.
