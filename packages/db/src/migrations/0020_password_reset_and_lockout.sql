-- Spec 161 — password-reset-and-account-lockout (Workflow Run 15 audit-closure
-- MISS). The 7-agent post-Run-14 audit flagged two adjacent feature gaps that
-- together let an attacker who knows a teacher's email burn an unbounded
-- number of password guesses without ever triggering a lockout, AND that
-- left a teacher who genuinely forgot their password locked out of the
-- programme until a super_admin manually reset the password row by hand.
--
-- This migration ships the two schema additions both flows need:
--
--   1. password_reset_tokens — append-only ledger of every reset request.
--      Tokens are 32 random bytes hex-encoded (64 chars) handed to the user
--      via email; the row stores a bcrypt(cost=10) hash of the plaintext, an
--      expiresAt (now()+30 min — spec contract), an optional consumedAt
--      that the reset-completion path stamps, and the MASKED requesting IP
--      (last octet stripped, same shape as audit.ip — see auth.ts maskIp).
--
--      Lookup paths:
--        — uniqueIndex(token_hash) so the reset-completion handler can find
--          the row in O(log n) given the plaintext (the handler bcrypt-
--          compares against the unconsumed-non-expired rows for the user
--          whose email matched the link's recipient — the unique constraint
--          also blocks a hash-collision attack from poisoning a second
--          user's reset path).
--        — (user_id, created_at) for the rate-limit / audit query that asks
--          "how many reset requests has this user made in the last hour".
--
--      onDelete CASCADE — when an account is hard-deleted (rare; we
--      normally soft-delete via deleted_at) the reset rows go with it.
--
--   2. users.failed_login_count + users.locked_until — the lockout state
--      machine. failed_login_count accumulates consecutive bad-credential
--      hits; on the 5th miss in a rolling 1-hour window the authorize
--      callback (apps/web/src/auth.ts) sets locked_until = now()+1 hour
--      AND emits an `auth.account.locked` audit row. Successful credentials
--      auth resets the counter to 0 and clears locked_until in the same
--      UPDATE that bumps last_seen_at. While locked_until > now() the
--      authorize callback short-circuits with `auth.account.locked_attempt`
--      — the attacker can't burn through the bcrypt verify path while the
--      account is locked, removing the per-IP rate-limit dependency for the
--      bcrypt CPU budget. A super_admin can clear the lockout early via
--      /admin/users/[id]/unlock (POST) which sets both columns to their
--      cleared values in a single transaction.
--
--      Defaults: failed_login_count NOT NULL default 0 (every existing user
--      row backfills cleanly — no failed logins recorded pre-spec); locked
--      _until NULL (no existing account is locked). No data migration is
--      necessary; the columns are pure additions.
--
-- Why we don't ship a trigger or partial index for the lockout counter:
-- the read path is a single user_id lookup that already uses the PK; the
-- write path is "single-row UPDATE on the user that just attempted login"
-- which doesn't benefit from an index. Keeping the columns plain saves a
-- migration breakpoint and the trigger maintenance burden.
CREATE TABLE "password_reset_tokens" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "user_id" uuid NOT NULL,
        "token_hash" text NOT NULL,
        "expires_at" timestamp with time zone NOT NULL,
        "consumed_at" timestamp with time zone,
        "requested_from_ip" varchar(64),
        "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "password_reset_tokens_hash_unique" ON "password_reset_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "password_reset_tokens_user_created_idx" ON "password_reset_tokens" USING btree ("user_id","created_at");--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "failed_login_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "locked_until" timestamp with time zone;
