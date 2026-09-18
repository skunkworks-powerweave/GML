-- Remove the foreign key from audit_log.user_id.
--
-- THE BUG. audit_log.user_id was declared REFERENCES users(id) ON DELETE SET
-- NULL. "SET NULL" is implemented as an UPDATE on audit_log — and audit_log
-- carries a BEFORE UPDATE trigger that unconditionally raises, because the
-- table is append-only by design (SM-1). The two features cancel each other out:
--
--     DELETE user -> BLOCKED: audit_log is append-only (SM-1). UPDATE/DELETE blocked.
--
-- (reproduced against the live database). So ANY user who has ever done
-- anything — i.e. anyone who has ever logged in — became permanently
-- undeletable. Offboarding a member of staff, or honouring an erasure request,
-- fails with an error about an append-only table, which is not an obvious place
-- to go looking.
--
-- WHY DROPPING THE FK IS THE RIGHT FIX, rather than changing the action.
-- Every alternative referential action is wrong here:
--
--   ON DELETE SET NULL  - mutates an immutable table (the current bug), and
--                         destroys attribution: "someone did this" is not an
--                         audit trail.
--   ON DELETE CASCADE   - deletes audit rows. An append-only log that can be
--                         emptied by deleting a user is not append-only; it
--                         hands you a way to erase your own tracks.
--   ON DELETE RESTRICT  - keeps the data but makes every acting user
--                         undeletable forever, which is the present behaviour
--                         with a clearer error message.
--
-- A forensic log should not have referential actions pointed at it at all. The
-- whole point is that it records what was true at the time and is never revised
-- afterwards. Keeping user_id as a plain uuid preserves attribution across the
-- deletion of the user — which is exactly what you want when investigating —
-- and lets users be deleted without touching the log.
--
-- The trade-off, stated plainly: audit_log.user_id may now reference a user that
-- no longer exists. That is intentional. Readers must LEFT JOIN, never INNER
-- JOIN, and must tolerate a null user row. The admin audit viewer already does
-- (apps/web/src/app/(authenticated)/admin/audit/page.tsx), because the column
-- was already nullable.
--
-- SM-1 is unaffected: the REVOKEs and the two BEFORE triggers that actually
-- enforce append-only are untouched. This removes a constraint that FOUGHT them.

ALTER TABLE "audit_log" DROP CONSTRAINT IF EXISTS "audit_log_user_id_users_id_fk";--> statement-breakpoint

-- The index on (user_id, created_at) stays: the audit viewer filters by actor,
-- and that does not depend on the constraint.
COMMENT ON COLUMN "audit_log"."user_id" IS
  'Actor at the time of the event. Deliberately NOT a foreign key: ON DELETE SET NULL would UPDATE this append-only table (SM-1) and CASCADE would let deleting a user erase their own trail. May reference a deleted user; always LEFT JOIN.';
