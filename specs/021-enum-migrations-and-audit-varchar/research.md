# Research 021
- `ALTER TYPE ... ADD VALUE` is a non-transactional Postgres operation — drizzle-kit emits these one per statement. Safe for forward migrations.
- `ALTER COLUMN ... TYPE varchar(64) USING action::text` preserves all existing rows; `DROP TYPE audit_action` succeeds after no columns reference it.
