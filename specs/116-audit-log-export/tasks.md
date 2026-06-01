# Tasks — 116 audit-log-export

- [x] Create `apps/web/src/app/api/admin/audit/export/route.ts` (GET + POST 405, auth, role gate, filters, 10k cap, papaparse, audit hook).
- [x] Edit `apps/web/src/app/(authenticated)/admin/audit/page.tsx` to render the `<Link href={exportHref} download>Export CSV</Link>`.
- [x] Ship `tests/governance/test_116_audit_log_export.test.mjs` and confirm green.
