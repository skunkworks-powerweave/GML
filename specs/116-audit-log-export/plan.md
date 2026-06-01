# Plan — 116 audit-log-export

1. Create `apps/web/src/app/api/admin/audit/export/route.ts` — GET handler, auth + role gate, filter assembly, drizzle SELECT with `LIMIT 10001` overflow probe, papaparse stringify, `text/csv` response, `audit.bulk_export` recordAudit, POST 405 stub.
2. Edit `apps/web/src/app/(authenticated)/admin/audit/page.tsx` — import `Link`, compute `exportHref` from current `searchParams`, render `<Link href download>Export CSV</Link>` inside the filter form.
3. Ship spec-kit + governance test asserting role gate, audit call, papaparse use, CSV attachment header, 10k row cap, and Link wiring on the page.
