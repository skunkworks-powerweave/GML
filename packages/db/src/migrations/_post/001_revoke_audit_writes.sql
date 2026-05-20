-- SM-1 DB-layer enforcement: audit_log is append-only.
-- Applied AFTER the drizzle-kit-generated migration that creates audit_log.
-- Both the application user (gml) and the broad PUBLIC role lose UPDATE/DELETE.
-- INSERT remains allowed for the app to record events. SELECT remains for the audit viewer.
--
-- A separate `audit_admin` role (DBA only) retains full access for emergency forensic edits;
-- creating it is outside the app's bootstrap, documented in docs/operations.md.

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE audit_log FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_setting('app.runtime_user', true)) THEN
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON TABLE audit_log FROM %I', current_setting('app.runtime_user'));
  END IF;
  -- Default app user from .env:
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gml') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON TABLE audit_log FROM gml;
  END IF;
END
$$;

-- Defence-in-depth trigger: even a superuser direct UPDATE/DELETE raises an explicit error,
-- so accidental psql sessions can't silently mutate.
CREATE OR REPLACE FUNCTION audit_log_block_mutations() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only (SM-1). UPDATE/DELETE blocked.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_no_update ON audit_log;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_block_mutations();

DROP TRIGGER IF EXISTS audit_log_no_delete ON audit_log;
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_block_mutations();
