# Tasks 098

- [x] T1 → write governance test (red) → author `apps/web/src/app/api/admin/learners/export/route.ts` with GET (auth + super_admin-only role gate + drizzle leftJoin SELECT + Papa.unparse + text/csv attachment response + audit-after-success hook) and POST 405 stub → green
