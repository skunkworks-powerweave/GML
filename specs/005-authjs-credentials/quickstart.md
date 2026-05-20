# Quickstart 005

```powershell
# 1. Make sure DB is migrated (compose up + drizzle migrate) — or run typecheck:
pnpm --filter @gml/web build

# 2. Seed a user (manual psql for now; admin UI lands in spec 012):
docker compose exec postgres psql -U gml -d gml_lms -c \
  "INSERT INTO users (email, name, password_hash, role)
   VALUES ('admin@goldenmilelearning.org', 'Admin',
           '\$2a\$10\$$(openssl rand -base64 22)$', 'super_admin');"

# 3. pnpm --filter @gml/web dev; visit http://localhost:3000/login
```
