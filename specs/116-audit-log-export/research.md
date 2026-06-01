# Research — 116 audit-log-export

- D-001: Reuse spec 098 (`/api/admin/learners/export`) pattern verbatim — papaparse, force-dynamic, attachment Content-Disposition, dated filename, `void recordAudit` best-effort. Already-proven blueprint, no new deps.
- D-002: 10k row cap enforced via `LIMIT cap+1` overflow probe rather than a separate COUNT(*). One round trip vs two, identical detection guarantee, and silent truncation is itself an audit hazard so 413 is the safer failure mode.
- D-003: Page-side alias `?user` retained alongside canonical `?userId` because the existing `/admin/audit` filter form posts `?user`; aliasing keeps the JSX-prototype wiring trivial.
