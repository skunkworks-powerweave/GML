-- Spec 017 prerequisite: rename Auth.js `sessions` table to `auth_sessions` to free
-- the bare `sessions` name for the classroom-sessions module (curriculum-side, spec 017).
-- The Auth.js DrizzleAdapter has been updated (apps/web/src/auth.ts) to point at
-- `authSessions` instead of `sessions`. Since we use JWT session strategy, this table
-- is never read/written at runtime — the rename is metadata-only.

ALTER TABLE "sessions" RENAME TO "auth_sessions";
--> statement-breakpoint
ALTER TABLE "auth_sessions" RENAME CONSTRAINT "sessions_user_id_users_id_fk" TO "auth_sessions_user_id_users_id_fk";
