# Research 010

## D-001: jsonb metadata, not separate columns
Audit shape varies per action (login has no entity, upload has filename+size, etc.). jsonb keeps the table narrow.

## D-002: Partitioning DEFERRED
At launch volume (~500 teachers × ~20 events/day ≈ 10k/day ≈ 3.6M/year) a single table indexed on (user_id, created_at desc) handles the load. Partitioning by month is a future optimisation; add when row count > 50M. Recorded as deferred in PROGRESS.md.

## D-003: RLS / REVOKE statements as a raw SQL hook
Drizzle can declare the table but not the GRANT REVOKE. Add a `0001_revoke_audit_writes.sql` migration after the auto-generated initial migration; this lands in spec 011 along with the moat tests.
