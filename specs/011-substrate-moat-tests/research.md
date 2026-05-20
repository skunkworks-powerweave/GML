# Research 011

## D-001: grep gates are dumb but reliable
Static text search is the simplest "lock the door" mechanism. Any future spec that calls `db.update(auditLog)` fails CI immediately. False-positive risk: someone names a *different* variable `auditLog` — acceptable for now.

## D-002: `_post` SQL migrations run after drizzle-kit-generated ones
Drizzle-kit only generates the table DDL; GRANT REVOKE / RLS / triggers must come from raw SQL. The migrator looks for `_post/*.sql` in lexical order and applies each in a transaction.

## D-003: Restore-drill check is informational at this stage
The check is wired up; the deploy script (spec 067) will refuse to start when the drill file is > 30 days old. Until 067 ships, the check just exits 0 with a warning.
