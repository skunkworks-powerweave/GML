-- Move identity to Supabase Auth: public.users becomes a PROFILE table keyed to
-- auth.users.
--
-- This is a REWRITE. A first version of this file was withdrawn after review
-- (see the revert commit); the notes below record what it got wrong, so the same
-- mistakes are not reintroduced by a later edit.
--
-- THE CONSTRAINT THAT DICTATES THE METHOD. 19 foreign keys referenced
-- public.users(id) and none were ON UPDATE CASCADE, so the uuid must be
-- preserved: ids originate in auth.users and public.users follows.
-- auth.admin.createUser() mints its own id, which is exactly why the bootstrap
-- must insert the profile with THAT id rather than generating one.
--
-- Verified against the live project before writing this:
--   postgres            rolsuper=false rolbypassrls=TRUE  (owner of public.*)
--   supabase_auth_admin rolsuper=false rolbypassrls=false rolinherit=false
--                       (owner of auth.users)
--   auth.users.email    IS NULLABLE
--   postgres CAN create and drop triggers on auth.users here (tested).

-- ── 1. Retire the Auth.js adapter tables ──────────────────────────────────────
-- accounts / auth_sessions / verification_tokens were already inert under
-- `session: { strategy: "jwt" }`. password_reset_tokens backed a hand-rolled
-- flow that bcrypt-scanned every live token on an endpoint with no rate limit.
DROP TABLE IF EXISTS public.verification_tokens;--> statement-breakpoint
DROP TABLE IF EXISTS public.auth_sessions;--> statement-breakpoint
DROP TABLE IF EXISTS public.accounts;--> statement-breakpoint
DROP TABLE IF EXISTS public.password_reset_tokens;--> statement-breakpoint

-- ── 2. public.users becomes a pure profile ────────────────────────────────────
-- password_hash  -> auth.users.encrypted_password
-- email_verified -> auth.users.email_confirmed_at
-- failed_login_count / locked_until -> Supabase Auth rate limiting. The
--   hand-rolled lockout was a DoS vector in both directions: anyone who knew an
--   address could lock it for an hour at will, the counter never decayed, and
--   the distinct error was an account-existence oracle.
ALTER TABLE public.users
  DROP COLUMN IF EXISTS password_hash,
  DROP COLUMN IF EXISTS failed_login_count,
  DROP COLUMN IF EXISTS locked_until,
  DROP COLUMN IF EXISTS email_verified;--> statement-breakpoint

ALTER TABLE public.users ALTER COLUMN id DROP DEFAULT;--> statement-breakpoint

-- ON DELETE RESTRICT, *NOT* CASCADE.
--
-- The withdrawn version used CASCADE. Deleting an auth user would have cascaded
-- into public.users and onward into quiz_submissions, form_drafts,
-- notifications, user_prefs and section_gate_grants (all themselves CASCADE),
-- destroying programme data and bypassing the deleted_at soft-delete this schema
-- already implements -- and doing it from a dashboard button, silently.
--
-- RESTRICT makes that button fail loudly instead. Offboarding is soft-delete
-- (users.deleted_at); erasure under DPDP is anonymisation -- overwrite the PII,
-- keep the row and the uuid so audit attribution and referential integrity
-- survive -- performed as a deliberate admin action, never as a side effect.
DO $$
BEGIN
  ALTER TABLE public.users
    ADD CONSTRAINT users_id_auth_fkey
    FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE RESTRICT;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;--> statement-breakpoint

-- ── 3. Profile creation trigger — inert by default ────────────────────────────
-- Structural fix for uncontrolled self-registration. EVERY path that creates an
-- auth.users row lands here as role='teacher', active=FALSE, and _post/004's
-- access-token hook refuses to mint a JWT for an inactive profile. A
-- self-registered account therefore cannot load a single page. The old Auth.js
-- magic-link provider did the opposite: auto-created users active=TRUE with no
-- signIn callback to stop it.
--
-- NULL EMAIL: auth.users.email is nullable (phone-only identities), while
-- public.users.email is NOT NULL. The withdrawn version would have aborted
-- creation of any email-less auth user. Email is the login identity for this
-- product and phone auth is disabled, so the right behaviour is to create NO
-- profile — which leaves the account inert via the hook, i.e. fail-closed.
--
-- NAME: raw_user_meta_data is attacker-controllable on any self-service path.
-- Truncated to the column width so it cannot be used to push a large payload
-- into a table an admin will later read.
--
-- SET search_path = '' is required for SECURITY DEFINER safety; every reference
-- below is schema-qualified accordingly.
CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.email IS NULL OR btrim(NEW.email) = '' THEN
    RETURN NEW;  -- no profile => no token => inert. Deliberate.
  END IF;

  -- No conflict target: this absorbs BOTH a repeat of the same id and a clash
  -- on users_email_unique. The withdrawn version named (id), which is the one
  -- that cannot realistically collide, and left the email case to abort the
  -- auth.users insert.
  INSERT INTO public.users (id, email, name, role, active, default_locale)
  VALUES (
    NEW.id,
    lower(NEW.email),
    left(nullif(btrim(coalesce(NEW.raw_user_meta_data ->> 'name', '')), ''), 255),
    'teacher'::public.role,
    false,
    'en'
  )
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$$;--> statement-breakpoint

REVOKE EXECUTE ON FUNCTION public.handle_new_auth_user() FROM PUBLIC;--> statement-breakpoint

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;--> statement-breakpoint
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_auth_user();--> statement-breakpoint

-- ── 4. Keep public.users.email in step with auth.users.email ──────────────────
-- auth.users.email is the source of truth. public.users.email is retained
-- because ~40 queries join or filter on it; dropping it would be a large,
-- unrelated refactor. This stops the copy going stale after an email change.
CREATE OR REPLACE FUNCTION public.sync_auth_user_email()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.email IS DISTINCT FROM OLD.email AND NEW.email IS NOT NULL THEN
    UPDATE public.users
       SET email = lower(NEW.email), updated_at = now()
     WHERE id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

REVOKE EXECUTE ON FUNCTION public.sync_auth_user_email() FROM PUBLIC;--> statement-breakpoint

DROP TRIGGER IF EXISTS on_auth_user_email_changed ON auth.users;--> statement-breakpoint
CREATE TRIGGER on_auth_user_email_changed
  AFTER UPDATE OF email ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.sync_auth_user_email();

-- NOTE: no grants to supabase_auth_admin here. The withdrawn version granted it
-- SELECT on public.users so the access-token hook could read role/active — but
-- _post/002 enabled RLS on every public table with no policies, and
-- supabase_auth_admin has rolbypassrls=false and does not own the table, so that
-- grant would have returned ZERO ROWS SILENTLY rather than erroring. _post/004
-- solves it the other way: a SECURITY DEFINER function owned by postgres (which
-- does have rolbypassrls), with only EXECUTE granted. That keeps 002's
-- nothing-readable-by-non-owners posture intact instead of punching a hole in it.
