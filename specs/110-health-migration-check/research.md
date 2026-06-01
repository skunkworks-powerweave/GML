# Research 110

## D-001 — Journal file beats Drizzle config introspection for expected count

Two viable sources of truth: (a) read the `_journal.json` Drizzle writes
alongside its generated migration files, or (b) `import` the migrations
folder dynamically and count SQL files. We picked (a) because the journal
is Drizzle's own manifest — it's the file `migrate()` consults at runtime
— so we're not duplicating logic, we're mirroring it. Counting SQL files
would mis-count if a `.sql` file gets added without `drizzle-kit
generate` updating the journal.

## D-002 — Sentinel error string for missing migrations table

When `drizzle.__drizzle_migrations` doesn't exist, Postgres returns error
42P01 ("relation does not exist"). We could surface the raw pg message
(`relation "drizzle.__drizzle_migrations" does not exist`), but that
leaks DB schema names into the operator's grep target. The sentinel
`drizzle migrations table not found` is stable across pg versions and
maps cleanly to the remediation in the runbook ("run pnpm --filter
@gml/db run migrate"). Operators read English; pg error codes belong in
the underlying `details.migrations.error` field, not in their dashboards.
