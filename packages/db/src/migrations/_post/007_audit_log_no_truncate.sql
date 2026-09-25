-- SM-1: audit_log refuses TRUNCATE, from every role, its owner included.
--
-- WHY. _post/001 revoked UPDATE, DELETE and TRUNCATE from PUBLIC and from a
-- role called `gml`, _post/002 from Supabase's API roles, and both lean on the
-- BEFORE UPDATE / BEFORE DELETE ... FOR EACH ROW triggers as the load-bearing
-- control. But the app, the worker and migrate all connect as the table OWNER
-- (`postgres` on Supabase), a REVOKE from PUBLIC never touches the owner's own
-- privileges, and row triggers do not fire on TRUNCATE. So one
-- `TRUNCATE audit_log` -- from an application bug, an injection primitive or a
-- mistaken psql session -- emptied the whole trail. On a clone of the live
-- database a DELETE raised the SM-1 error and a TRUNCATE took the table from
-- 230 rows to 0.
--
-- A BEFORE TRUNCATE ... FOR EACH STATEMENT trigger is the TRUNCATE counterpart
-- of the row triggers, and fires whichever role issues it.
--
-- WHAT THIS DOES NOT CHANGE. The owner can still ALTER TABLE ... DISABLE
-- TRIGGER; README-IT's signed-off archiving procedure depends on exactly that.
-- Taking it away means running the app as a non-owner role, which is the
-- separate, larger piece of work _post/002's header describes.

-- Same function the row triggers use, now naming the operation it refused:
-- "UPDATE/DELETE blocked" would be a misleading answer to a TRUNCATE.
CREATE OR REPLACE FUNCTION audit_log_block_mutations() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only (SM-1). % blocked.', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_no_truncate ON audit_log;
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_block_mutations();
