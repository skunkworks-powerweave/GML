# Research 025
- Retention is a delete-by-cutoff (lt(created_at, cutoff)). Postgres handles efficiently with the `(created_at)` index.
- 90 days chosen because audit_log is the long-term record; notifications are read-and-forget.
- Until BullMQ ships (spec 039), retention can run on host cron (`0 3 * * *` daily 03:00) using `pnpm --filter @gml/db retention`.
