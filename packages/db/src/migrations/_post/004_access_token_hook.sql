-- Custom Access Token Hook: put the LMS role into the JWT, and refuse tokens to
-- accounts that have no business holding one.
--
-- This is the control the whole identity design rests on. GoTrue calls it every
-- time an access token is minted -- at sign-in AND on every refresh -- so it is
-- both the place the role claim comes from and the revocation point.
--
-- WHY A SECURITY DEFINER FUNCTION RATHER THAN A TABLE GRANT.
-- The obvious approach is `GRANT SELECT ON public.users TO supabase_auth_admin`
-- and read the table directly from the hook. That silently does not work here:
-- _post/002 enabled RLS on every public table with no policies, and on this
-- project supabase_auth_admin has rolbypassrls=false, rolinherit=false and does
-- not own public.users (postgres does, and postgres has rolbypassrls=true).
-- The hook would have read ZERO ROWS -- not an error, just an empty result --
-- and every login would have been refused, or worse, silently treated as
-- "no profile". Verified against pg_roles on the live project.
--
-- Owning the function as postgres and granting only EXECUTE gets the read done
-- under a role that legitimately bypasses RLS, without granting
-- supabase_auth_admin any standing access to application data, and without
-- adding the first RLS policy to a schema deliberately left with none.
--
-- CLAIM NAME. `user_role`, NOT `role`. `role` is reserved: it carries the
-- Postgres role (`authenticated`) that PostgREST and RLS switch into, and
-- overwriting it breaks those subsystems.

CREATE OR REPLACE FUNCTION public.custom_access_token_hook(event jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_claims  jsonb;
  v_role    public.role;
  v_active  boolean;
  v_deleted timestamptz;
  v_name    text;
  v_image   text;
BEGIN
  SELECT u.role, u.active, u.deleted_at, u.name, u.image
    INTO v_role, v_active, v_deleted, v_name, v_image
    FROM public.users u
   WHERE u.id = (event ->> 'user_id')::uuid;

  -- No profile row => never invited into the LMS. This is what makes
  -- self-registration inert: an auth.users row on its own gets no token.
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'error', jsonb_build_object(
        'http_code', 403,
        'message', 'No LMS profile for this account. Ask an administrator to invite you.'
      )
    );
  END IF;

  -- Deactivated or soft-deleted. Because this runs on REFRESH as well as
  -- sign-in, it is the revocation mechanism: the window between deactivating
  -- someone and their access ending is one access-token lifetime, not the eight
  -- hours the old Auth.js JWT gave them.
  IF v_active IS NOT TRUE OR v_deleted IS NOT NULL THEN
    RETURN jsonb_build_object(
      'error', jsonb_build_object(
        'http_code', 403,
        'message', 'This account is not active. Contact your administrator.'
      )
    );
  END IF;

  -- user_role is the authorization claim. user_name and user_image are
  -- DISPLAY claims, and they are here for a specific reason: the video player
  -- burns the viewer's name into an on-screen watermark (SM-9 leak
  -- attribution), and the app shell renders it on every page. Reading them
  -- from public.users per request would put a database round-trip to Mumbai on
  -- the render path of every authenticated page -- exactly the cost this hook
  -- exists to avoid. Carrying them in the token keeps public.users the single
  -- source of truth for display with no dual-write to raw_user_meta_data.
  --
  -- The trade-off: a renamed user shows the old name until their token
  -- refreshes (<= one access-token lifetime). That is acceptable for a display
  -- string and is NOT acceptable for role/active -- which is why those are
  -- re-read and re-checked on every mint above rather than trusted from the
  -- previous token.
  v_claims := event -> 'claims';
  v_claims := jsonb_set(v_claims, '{user_role}',  to_jsonb(v_role::text));
  v_claims := jsonb_set(v_claims, '{user_name}',  to_jsonb(coalesce(v_name, '')));
  v_claims := jsonb_set(v_claims, '{user_image}', to_jsonb(coalesce(v_image, '')));
  RETURN jsonb_set(event, '{claims}', v_claims);
END;
$$;--> statement-breakpoint

-- Lock the function down: only GoTrue may call it, and nobody gets it by default.
-- The PUBLIC revoke is portable and does the real work; naming anon and
-- authenticated as well is belt-and-braces, because an explicit grant to a role
-- is NOT removed by revoking from PUBLIC.
REVOKE EXECUTE ON FUNCTION public.custom_access_token_hook(jsonb) FROM PUBLIC;--> statement-breakpoint

DO $$
BEGIN
  IF (SELECT count(*) = 2 FROM pg_roles WHERE rolname IN ('anon', 'authenticated')) THEN
    REVOKE EXECUTE ON FUNCTION public.custom_access_token_hook(jsonb) FROM anon, authenticated;
  END IF;
END
$$;--> statement-breakpoint
-- PORTABILITY: supabase_auth_admin is a Supabase role. On a plain Postgres the
-- GRANT would abort the whole migration run; the hook function itself is
-- portable and still gets created, it simply has no GoTrue to call it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
    RAISE NOTICE '[_post/004] supabase_auth_admin absent (not a Supabase database) -- grants skipped';
    RETURN;
  END IF;
  GRANT EXECUTE ON FUNCTION public.custom_access_token_hook(jsonb) TO supabase_auth_admin;
  -- supabase_auth_admin needs to reach the function, but NOT the tables.
  GRANT USAGE ON SCHEMA public TO supabase_auth_admin;
END
$$;--> statement-breakpoint

-- The USAGE grant above is belt-and-braces against a future tightening -- _post/002
-- revoked schema USAGE from anon/authenticated only. It grants the ability to
-- resolve the function name, nothing more. No table privileges are granted
-- anywhere in this file.

-- MANUAL STEP, and it has no SQL equivalent:
--   Dashboard -> Authentication -> Hooks -> "Customize Access Token (JWT) Claims"
--   -> Postgres -> public.custom_access_token_hook -> Enable.
-- Until that is done this function is inert and tokens carry no user_role claim,
-- which the application treats as "not signed in" (fail-closed). This is the
-- single most commonly missed step in this migration.
