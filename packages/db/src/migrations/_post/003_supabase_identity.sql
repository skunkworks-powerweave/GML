-- Move identity to Supabase Auth: public.users becomes a PROFILE table hanging
-- off auth.users.
--
-- THE CONSTRAINT THAT DICTATES THE METHOD. 19 foreign keys point at
-- public.users(id) and NOT ONE of them is ON UPDATE CASCADE:
--
--   audit_log, feedback_responses, files, form_drafts, mentors, notifications,
--   observation_cycles, observation_forms, quiz_submissions, rtt_attendance,
--   section_gate_grants, section_gates, teachers, user_prefs,
--   video_submissions (x2), plus the four Auth.js tables dropped below.
--
-- So the uuid MUST be preserved. auth.admin.createUser() mints its own id and
-- would orphan every one of those references; ids therefore originate in
-- auth.users and public.users follows, never the reverse.
--
-- Safe to run destructively here because both tables are EMPTY (verified: 0
-- rows in public.users, 0 in auth.users). On a populated database this would
-- need a backfill inserting into auth.users WITH the existing id first — see
-- the plan for that path.
--
-- WHAT SUPABASE NOW OWNS: credentials, email confirmation, sessions, password
-- reset, MFA. WHAT THE APP STILL OWNS: role, active, and the profile fields.

-- ── 1. Retire the Auth.js adapter tables ──────────────────────────────────────
-- accounts / auth_sessions / verification_tokens were already inert: the app
-- ran `session: { strategy: "jwt" }`, so the DrizzleAdapter never wrote to them.
-- password_reset_tokens backed a hand-rolled flow that did an O(N) bcrypt scan
-- over every live token on an endpoint with no rate limit; Supabase recovery
-- replaces it outright.
DROP TABLE IF EXISTS public.verification_tokens;--> statement-breakpoint
DROP TABLE IF EXISTS public.auth_sessions;--> statement-breakpoint
DROP TABLE IF EXISTS public.accounts;--> statement-breakpoint
DROP TABLE IF EXISTS public.password_reset_tokens;--> statement-breakpoint

-- ── 2. public.users becomes a pure profile ────────────────────────────────────
-- password_hash  -> auth.users.encrypted_password
-- email_verified -> auth.users.email_confirmed_at
-- failed_login_count / locked_until -> Supabase Auth rate limiting.
--   The hand-rolled lockout was a DoS vector in both directions: anyone who
--   knew an email could lock that account out for an hour at will, the counter
--   never decayed (so one further miss after expiry re-locked it), and
--   AccountLockedError was an account-existence oracle.
ALTER TABLE public.users
  DROP COLUMN IF EXISTS password_hash,
  DROP COLUMN IF EXISTS failed_login_count,
  DROP COLUMN IF EXISTS locked_until,
  DROP COLUMN IF EXISTS email_verified;--> statement-breakpoint

-- ids come from auth.users now; nothing may mint one locally.
ALTER TABLE public.users ALTER COLUMN id DROP DEFAULT;--> statement-breakpoint

DO $$
BEGIN
  ALTER TABLE public.users
    ADD CONSTRAINT users_id_auth_fkey
    FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;--> statement-breakpoint

-- ── 3. Profile row is created by trigger, and is INERT by default ─────────────
-- This is the structural fix for uncontrolled self-registration. EVERY path
-- that can create an auth.users row -- invite, signup, OAuth, the dashboard, raw
-- SQL -- lands here, and lands as role='teacher', active=FALSE. Combined with
-- the access-token hook in _post/004, which refuses to mint a JWT for an
-- inactive profile, a self-registered account cannot load a single page.
--
-- The old behaviour was the opposite: the Auth.js magic-link provider
-- auto-created users with role='teacher', active=TRUE and no signIn callback to
-- stop it.
--
-- SET search_path = '' is required for SECURITY DEFINER safety, which is why
-- every reference below is schema-qualified.
CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.users (id, email, name, role, active, default_locale)
  VALUES (
    NEW.id,
    lower(NEW.email),
    nullif(NEW.raw_user_meta_data ->> 'name', ''),
    'teacher'::public.role,
    false,
    'en'
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;--> statement-breakpoint

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;--> statement-breakpoint
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_auth_user();--> statement-breakpoint

-- ── 4. Keep public.users.email in step with auth.users.email ──────────────────
-- auth.users.email is the source of truth. public.users.email is retained
-- because ~40 queries join or filter on it; removing it would be a large,
-- unrelated refactor. This trigger stops the copy going stale after an
-- email change.
CREATE OR REPLACE FUNCTION public.sync_auth_user_email()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.email IS DISTINCT FROM OLD.email THEN
    UPDATE public.users
       SET email = lower(NEW.email), updated_at = now()
     WHERE id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

DROP TRIGGER IF EXISTS on_auth_user_email_changed ON auth.users;--> statement-breakpoint
CREATE TRIGGER on_auth_user_email_changed
  AFTER UPDATE OF email ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.sync_auth_user_email();--> statement-breakpoint

-- ── 5. Grants for the GoTrue service role ─────────────────────────────────────
-- _post/002 revoked USAGE on schema public from the API roles. supabase_auth_admin
-- is NOT one of those, but it does need to reach public.users for the
-- access-token hook added in _post/004, so grant it narrowly and explicitly
-- rather than relying on a default that may change.
GRANT USAGE ON SCHEMA public TO supabase_auth_admin;--> statement-breakpoint
GRANT SELECT ON TABLE public.users TO supabase_auth_admin;
