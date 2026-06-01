# Quickstart — 116 audit-log-export

1. `pnpm dev`, sign in as a programme_admin or super_admin seeded user.
2. Visit `/admin/audit`, optionally filter by action (e.g. `login`).
3. Click "Export CSV" — browser downloads `audit-log-YYYYMMDD.csv` with the filtered rows; reload the page and observe a fresh `audit.bulk_export` row at the top of the table.
