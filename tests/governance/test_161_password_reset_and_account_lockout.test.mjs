// Governance test for spec 161 — password reset and account lockout.
//
// THIS FILE WAS INVERTED WHEN IDENTITY MOVED TO SUPABASE AUTH.
//
// Spec 161 built two things, and both were removed on review:
//
//   1. A HAND-ROLLED PASSWORD RESET. /api/auth/forgot-password minted a
//      32-byte token, bcrypt-hashed it into password_reset_tokens and mailed
//      the plaintext. /api/auth/reset-password then bcrypt-COMPARED the
//      submitted value against every unconsumed, unexpired row -- an O(N)
//      bcrypt scan, on an endpoint with NO RATE LIMIT AT ALL. That is a CPU
//      exhaustion primitive any anonymous caller could pull. The reset URLs
//      also fell back to http://localhost:3000, because neither APP_URL nor
//      NEXTAUTH_URL was ever set, so every link it generated pointed at the
//      recipient's own machine.
//
//   2. AN ACCOUNT LOCKOUT (users.failed_login_count / users.locked_until).
//      It was a denial-of-service tool in both directions: anyone who knew an
//      address could lock it at will by submitting five wrong passwords; the
//      counter never decayed, so one further guess after expiry re-locked it
//      for another hour, indefinitely, at a cost of one request per hour; and
//      the distinct AccountLockedError was an account-existence oracle. The
//      update was also a fire-and-forget read-modify-write, so it raced.
//
// Supabase Auth replaces both: recovery is its own rate-limited flow, and
// sign-in attempts are throttled centrally with no per-account flag a stranger
// can set on someone else's behalf.
//
// The tests below now pin the REMOVAL. They exist so that a future change
// cannot quietly reintroduce a second credential store or a lockout column --
// which is exactly the kind of thing that gets re-added by someone reading the
// spec folder and assuming it still describes the system.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");
const exists = (p) => existsSync(resolve(root, p));

// Strip comments before asserting a symbol is ABSENT. Several files below
// explain at length what was removed and why, naming the very identifiers these
// tests forbid -- a bare substring search would fail on the documentation of
// the fix. Block comments first, then line comments, so a // inside a /* */ is
// not mistaken for a comment start.
const code = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const SCHEMA_PATH = "packages/db/src/schema/identity.ts";
const MIGRATION_PATH = "packages/db/src/migrations/0020_password_reset_and_lockout.sql";
const JOURNAL_PATH = "packages/db/src/migrations/meta/_journal.json";
const POST_IDENTITY_PATH = "packages/db/src/migrations/_post/003_supabase_identity.sql";
const FORGOT_PAGE_PATH = "apps/web/src/app/login/forgot/page.tsx";
const RESET_PAGE_PATH = "apps/web/src/app/login/reset/page.tsx";
const RESET_ACTIONS_PATH = "apps/web/src/app/login/reset/actions.ts";
const EMAIL_ACTIONS_PATH = "apps/web/src/app/login/email-actions.ts";
const AUTH_PATH = "apps/web/src/auth.ts";
const DESKTOP_LOGIN_PATH = "apps/web/src/app/login/DesktopLogin.tsx";
const MOBILE_LOGIN_PATH = "apps/web/src/app/login/MobileLogin.tsx";
const SPEC_DIR = "specs/161-password-reset-and-account-lockout";

// ---------- Spec-kit contract (unchanged: the spec folder is history) ----------

test("spec 161 — all five spec-kit files are present", () => {
  for (const name of ["spec.md", "plan.md", "research.md", "quickstart.md", "tasks.md"]) {
    assert.ok(
      exists(`${SPEC_DIR}/${name}`),
      `${SPEC_DIR}/${name} must exist for the password-reset-and-account-lockout spec`,
    );
  }
});

// ---------- Migration history is append-only ----------
//
// 0020 still exists and is still journalled. Migrations are a record of what
// happened, not a description of the current schema -- _post/003 later drops
// what 0020 added, and BOTH must remain, in order, for a fresh database to
// reach the same state as a live one.

test("spec 161 — migration 0020 is still registered in the journal", () => {
  const src = read(JOURNAL_PATH);
  assert.match(
    src,
    /"tag"\s*:\s*"0020_password_reset_and_lockout"/,
    "_journal.json must still register 0020 — migration history is append-only, " +
      "and removing it would desynchronise every database that already applied it",
  );
});

test("spec 161 — _post/003 drops everything 0020 added", () => {
  const src = read(POST_IDENTITY_PATH);
  assert.match(
    src,
    /DROP\s+TABLE\s+IF\s+EXISTS\s+public\.password_reset_tokens/i,
    "_post/003 must drop password_reset_tokens",
  );
  for (const col of ["failed_login_count", "locked_until"]) {
    assert.match(
      src,
      new RegExp(`DROP\\s+COLUMN\\s+IF\\s+EXISTS\\s+${col}`, "i"),
      `_post/003 must drop users.${col}`,
    );
  }
  // 0020 itself is untouched -- proving the drop is a forward migration and not
  // a rewrite of history.
  assert.match(
    read(MIGRATION_PATH),
    /CREATE\s+TABLE\s+"password_reset_tokens"/i,
    "0020 must NOT be edited to hide what it created; the drop belongs in _post/003",
  );
});

// ---------- The lockout is gone, and must stay gone ----------

test("spec 161 — identity.ts no longer declares the lockout columns", () => {
  const src = code(read(SCHEMA_PATH));
  for (const col of ["failedLoginCount", "lockedUntil", "failed_login_count", "locked_until"]) {
    assert.ok(
      !src.includes(`"${col}"`) && !new RegExp(`\\b${col}\\s*:`).test(src),
      `identity.ts must not declare ${col} — the lockout it backed was a DoS ` +
        `vector (anyone who knew an address could lock it at will) and Supabase ` +
        `Auth rate-limits sign-in centrally instead`,
    );
  }
});

test("spec 161 — identity.ts no longer declares passwordResetTokens", () => {
  const src = code(read(SCHEMA_PATH));
  assert.ok(
    !/passwordResetTokens/.test(src),
    "identity.ts must not declare passwordResetTokens — Supabase owns recovery",
  );
});

test("spec 161 — identity.ts declares no credential column of any kind", () => {
  const src = code(read(SCHEMA_PATH));
  for (const col of ["passwordHash", "password_hash", "encryptedPassword"]) {
    assert.ok(
      !new RegExp(`\\b${col}\\b\\s*[:(]`).test(src),
      `public.users must hold no credential (${col} found). Credentials live in ` +
        `auth.users; a second store would drift and could be verified against ` +
        `without Supabase's rate limiting`,
    );
  }
});

test("spec 161 — auth.ts contains no lockout state machine", () => {
  const src = code(read(AUTH_PATH));
  for (const marker of [
    "AccountLockedError",
    "failedLoginCount",
    "lockedUntil",
    "verifyPassword",
  ]) {
    assert.ok(
      !new RegExp(`\\b${marker}\\b`).test(src),
      `auth.ts must not reference ${marker} outside comments — the lockout is deleted`,
    );
  }
});

// ---------- The hand-rolled endpoints are gone ----------

test("spec 161 — the unthrottled reset endpoints no longer exist", () => {
  for (const p of [
    "apps/web/src/app/api/auth/forgot-password/route.ts",
    "apps/web/src/app/api/auth/reset-password/route.ts",
  ]) {
    assert.ok(
      !exists(p),
      `${p} must not exist. It bcrypt-compared a submitted token against every ` +
        `live row with no rate limit — an anonymous CPU-exhaustion primitive`,
    );
  }
});

test("spec 161 — the super-admin unlock endpoint no longer exists", () => {
  assert.ok(
    !exists("apps/web/src/app/api/admin/users/[id]/unlock/route.ts"),
    "the unlock endpoint must not exist — there is no lockout left to clear",
  );
});

// ---------- Recovery now goes through Supabase ----------

test("spec 161 — password recovery is a server action calling Supabase", () => {
  const src = read(EMAIL_ACTIONS_PATH);
  assert.match(src, /^"use server";/m, "email-actions.ts must be a server-action module");
  assert.match(
    src,
    /resetPasswordForEmail\(/,
    "recovery must call supabase.auth.resetPasswordForEmail",
  );
  assert.match(
    src,
    /shouldCreateUser:\s*false/,
    "magic-link sign-in must pass shouldCreateUser: false — without it, requesting " +
      "a link for an unknown address CREATES that account, which is exactly how " +
      "the old Auth.js Nodemailer provider allowed uncontrolled self-registration",
  );
  assert.match(
    src,
    /rateLimit\(/,
    "the send paths must be throttled locally as well — Supabase's own limit is " +
      "per-project, so one caller looping addresses would deny email to everyone",
  );
});

test("spec 161 — the reset action does not accept a token from the request", () => {
  const src = code(read(RESET_ACTIONS_PATH));
  assert.ok(
    !/formData\.get\(\s*["']token["']\s*\)/.test(src),
    "the new password must be set from the caller's recovery SESSION, not from a " +
      "token echoed back through a form field",
  );
  assert.match(
    src,
    /updateUser\(\s*\{\s*password/,
    "the reset action must call supabase.auth.updateUser({ password })",
  );
  assert.match(
    src,
    /getUser\(\)/,
    "the reset action must confirm the session with getUser() — a credential " +
      "change must be checked against the auth server, not a locally-verified token",
  );
  assert.match(
    src,
    /signOut\(\s*\{\s*scope:\s*["']others["']/,
    "setting a new password must end the user's other sessions — recovery is what " +
      "someone does after losing control of an account",
  );
});

test("spec 161 — /login/forgot states plainly when email is unavailable", () => {
  const src = read(FORGOT_PAGE_PATH);
  assert.match(
    src,
    /authEmailEnabled\(\)/,
    "the page must branch on authEmailEnabled(), not on SMTP_HOST — under Supabase " +
      "the relay is configured in the dashboard, so the app's own SMTP_HOST says nothing",
  );
  assert.ok(
    !/NEXT_PUBLIC_[A-Z_]*EMAIL/.test(code(src)),
    "the flag must not be exposed to the client, or the presence of a mail relay " +
      "becomes enumerable from bundled JS",
  );
});

test("spec 161 — /login/reset requires a live session and says so when there is none", () => {
  const src = code(read(RESET_PAGE_PATH));
  assert.ok(
    !/useSearchParams|\?token=|params\.get\(/.test(src),
    "/login/reset must not read a token from the URL — the recovery code is " +
      "exchanged for a session at /auth/callback before this page renders",
  );
  assert.match(src, /await auth\(\)/, "the page must establish who is calling");
  assert.match(
    src,
    /reset-link-invalid/,
    "the page must render an explicit invalid-link state rather than an empty form",
  );
});

// ---------- Login surfaces still link to recovery ----------

test("spec 161 — DesktopLogin's Forgot password link points at /login/forgot", () => {
  assert.match(read(DESKTOP_LOGIN_PATH), /href="\/login\/forgot"/);
});

test("spec 161 — MobileLogin keeps its Forgot password Link", () => {
  const src = read(MOBILE_LOGIN_PATH);
  assert.match(src, /import\s+Link\s+from\s+"next\/link"/);
  assert.match(src, /href="\/login\/forgot"/);
});

// ---------- Hygiene ----------

test("spec 161 — no TODO / FIXME markers leaked into the replacement surfaces", () => {
  for (const path of [
    FORGOT_PAGE_PATH,
    RESET_PAGE_PATH,
    RESET_ACTIONS_PATH,
    EMAIL_ACTIONS_PATH,
    AUTH_PATH,
    SCHEMA_PATH,
  ]) {
    const src = read(path);
    assert.ok(!/\bTODO\b/i.test(src), `${path} must not contain TODO markers`);
    assert.ok(!/\bFIXME\b/i.test(src), `${path} must not contain FIXME markers`);
  }
});

test("spec 161 — nodemailer is gone from apps/web", () => {
  const pkg = read("apps/web/package.json");
  assert.ok(
    !/"nodemailer"/.test(pkg),
    "nodemailer must not be a dependency — Supabase sends the mail now, and a " +
      "local transport would be a second unmonitored send path",
  );
  assert.ok(
    !/"next-auth"|"@auth\/drizzle-adapter"/.test(pkg),
    "Auth.js must not be a dependency — two session implementations in one app " +
      "is how a deactivated user keeps a valid cookie",
  );
});
