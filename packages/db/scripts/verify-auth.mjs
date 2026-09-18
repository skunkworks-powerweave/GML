// Post-deploy auth verification.
//
// Run this after applying migrations to a new Supabase project. It checks the
// things that are silently broken rather than loudly broken -- the failures
// that leave the dashboard looking correct while nobody can sign in.
//
//   docker compose run --rm migrate node scripts/verify-auth.mjs
//
// Every check is read-only except the last, which creates a throwaway account,
// exercises it, and deletes it. It touches no existing data.
//
// THE CHECK THIS EXISTS FOR is "access-token hook is ENABLED". Registering the
// hook is a dashboard action with no SQL equivalent, so the function can be
// present, correct and owned by the right role while still never being called.
// When that happens no token carries a user_role claim, auth() returns null for
// everyone, and the application is a login page that rejects correct passwords.
// It is the single most commonly missed step in this migration.

import { createClient } from "@supabase/supabase-js";
import pg from "pg";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const SECRET = process.env.SUPABASE_SECRET_KEY;
const DB = process.env.DATABASE_URL;

const missing = Object.entries({
  NEXT_PUBLIC_SUPABASE_URL: URL,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: ANON,
  SUPABASE_SECRET_KEY: SECRET,
  DATABASE_URL: DB,
})
  .filter(([, v]) => !v)
  .map(([k]) => k);

if (missing.length) {
  console.error(`[verify-auth] missing environment variables: ${missing.join(", ")}`);
  process.exit(2);
}

let failures = 0;
const ok = (label, detail = "") => console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`);
const bad = (label, detail, fix) => {
  failures += 1;
  console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  if (fix) console.log(`        fix: ${fix}`);
};

const admin = createClient(URL, SECRET, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const c = new pg.Client({ connectionString: DB });
await c.connect();
const q = async (sql, params = []) => (await c.query(sql, params)).rows;

console.log("\nSchema\n");

// ── 1. The identity migration landed ─────────────────────────────────────────
const cols = await q(
  `SELECT column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name='users'`,
);
const colNames = cols.map((r) => r.column_name);
const stale = ["password_hash", "failed_login_count", "locked_until", "email_verified"].filter(
  (x) => colNames.includes(x),
);
stale.length
  ? bad("public.users is a profile table", `still has ${stale.join(", ")}`, "apply _post/003")
  : ok("public.users is a profile table");

const fk = await q(
  `SELECT confdeltype FROM pg_constraint WHERE conname='users_id_auth_fkey'`,
);
if (!fk.length) {
  bad("users.id references auth.users", "constraint missing", "apply _post/003");
} else if (fk[0].confdeltype !== "r") {
  // CASCADE here would run through public.users into quiz_submissions,
  // form_drafts, notifications, user_prefs and section_gate_grants -- deleting
  // a user from the dashboard would destroy programme data, silently.
  bad("users.id -> auth.users is ON DELETE RESTRICT", `is '${fk[0].confdeltype}'`, "apply _post/003");
} else {
  ok("users.id -> auth.users is ON DELETE RESTRICT");
}

const trigs = (
  await q(
    `SELECT tgname FROM pg_trigger WHERE tgrelid='auth.users'::regclass AND NOT tgisinternal`,
  )
).map((r) => r.tgname);
for (const t of ["on_auth_user_created", "on_auth_user_email_changed"]) {
  trigs.includes(t) ? ok(`trigger ${t}`) : bad(`trigger ${t}`, "missing", "apply _post/003");
}

// ── 2. The Data API is shut ──────────────────────────────────────────────────
const open = await q(
  `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind='r' AND NOT c.relrowsecurity`,
);
open.length
  ? bad("RLS enabled on every public table", `${open.length} without: ${open.slice(0, 5).map((r) => r.relname).join(", ")}`, "apply _post/002")
  : ok("RLS enabled on every public table");

const anonRead = await fetch(`${URL}/rest/v1/users?select=id&limit=1`, {
  headers: { apikey: ANON },
});
anonRead.status === 200
  ? bad("Data API refuses anonymous reads", "GET /rest/v1/users returned 200", "Dashboard -> Settings -> API -> Exposed schemas: remove 'public'")
  : ok("Data API refuses anonymous reads", `HTTP ${anonRead.status}`);

// ── 3. The hook function is correct ──────────────────────────────────────────
console.log("\nAccess-token hook\n");

const fn = await q(
  `SELECT p.prosecdef, r.rolname AS owner
     FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
    WHERE p.oid = to_regprocedure('public.custom_access_token_hook(jsonb)')`,
);
if (!fn.length) {
  bad("hook function exists", "not found", "apply _post/004");
} else {
  fn[0].prosecdef ? ok("hook is SECURITY DEFINER") : bad("hook is SECURITY DEFINER", "it is INVOKER");
  // Must be owned by a role that bypasses RLS, or it reads zero rows and
  // refuses every login.
  const owner = await q(`SELECT rolbypassrls FROM pg_roles WHERE rolname=$1`, [fn[0].owner]);
  owner[0]?.rolbypassrls
    ? ok("hook owner bypasses RLS", fn[0].owner)
    : bad("hook owner bypasses RLS", `${fn[0].owner} does not`, "ALTER FUNCTION ... OWNER TO postgres");
}

const grant = await q(
  `SELECT has_function_privilege('supabase_auth_admin',
     'public.custom_access_token_hook(jsonb)', 'EXECUTE') AS can`,
);
grant[0]?.can
  ? ok("supabase_auth_admin can execute the hook")
  : bad("supabase_auth_admin can execute the hook", "no EXECUTE", "apply _post/004");

const leak = await q(
  `SELECT has_table_privilege('supabase_auth_admin','public.users','SELECT') AS can`,
);
leak[0]?.can
  ? bad("supabase_auth_admin has no direct table access", "it can SELECT public.users", "revoke it — the hook reads as its owner")
  : ok("supabase_auth_admin has no direct table access");

// ── 4. The hook is actually ENABLED ──────────────────────────────────────────
console.log("\nEnd to end\n");

const email = `verify.auth.${Date.now()}@example.invalid`;
const password = `Verify-${Math.random().toString(36).slice(2, 14)}`;
let id = null;

try {
  const created = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { name: "Verification Probe" },
  });
  if (created.error) throw created.error;
  id = created.data.user.id;

  const profile = await q(`SELECT role, active FROM public.users WHERE id=$1`, [id]);
  profile[0]?.active === false && profile[0]?.role === "teacher"
    ? ok("a new account is created INERT", "role=teacher active=false")
    : bad(
        "a new account is created INERT",
        profile.length ? `role=${profile[0].role} active=${profile[0].active}` : "no profile row",
        "apply _post/003 — this is what makes self-registration harmless",
      );

  const signIn = async () => {
    const r = await fetch(`${URL}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: ANON, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    return { status: r.status, body: await r.json() };
  };

  // Inactive: the hook must refuse to mint.
  let r = await signIn();
  r.status === 403 || (r.status >= 400 && !r.body.access_token)
    ? ok("an inactive account is refused a token", `HTTP ${r.status}`)
    : bad(
        "an inactive account is refused a token",
        `HTTP ${r.status}, token issued`,
        "THE HOOK IS NOT ENABLED. Dashboard -> Authentication -> Hooks -> " +
          "Customize Access Token (JWT) Claims -> Postgres -> " +
          "public.custom_access_token_hook -> Enable",
      );

  // Active: the hook must mint, with the role claim.
  await q(`UPDATE public.users SET role='mentor', active=true WHERE id=$1`, [id]);
  r = await signIn();
  if (!r.body.access_token) {
    bad("an active account receives a token", `HTTP ${r.status} ${r.body.error_code ?? ""}`);
  } else {
    const claims = JSON.parse(
      Buffer.from(r.body.access_token.split(".")[1], "base64url").toString(),
    );
    claims.user_role === "mentor"
      ? ok("the token carries user_role", `user_role=${claims.user_role}`)
      : bad(
          "the token carries user_role",
          "claim absent",
          "THE HOOK IS NOT ENABLED. Dashboard -> Authentication -> Hooks -> " +
            "Customize Access Token (JWT) Claims -> Postgres -> " +
            "public.custom_access_token_hook -> Enable. Until this is done, " +
            "auth() returns null for everyone and nobody can sign in.",
        );
    const ttl = claims.exp - claims.iat;
    ttl <= 1800
      ? ok("access-token lifetime", `${ttl}s`)
      : console.log(
          `  NOTE  access-token lifetime is ${ttl}s. A deactivated user keeps their ` +
            `current token for up to this long.\n        Dashboard -> Authentication ` +
            `-> Sessions -> Access token (JWT) expiry.`,
        );
  }
} catch (err) {
  bad("end-to-end probe", String(err).slice(0, 200));
} finally {
  if (id) {
    // Profile first: the FK is RESTRICT, which is the point.
    await c.query(`DELETE FROM public.users WHERE id=$1`, [id]).catch(() => {});
    await admin.auth.admin.deleteUser(id).catch(() => {});
  }
  await c.end();
}

console.log(
  failures === 0
    ? "\nAll checks passed.\n"
    : `\n${failures} check${failures === 1 ? "" : "s"} failed. The application will not work correctly until these are resolved.\n`,
);
process.exit(failures === 0 ? 0 : 1);
