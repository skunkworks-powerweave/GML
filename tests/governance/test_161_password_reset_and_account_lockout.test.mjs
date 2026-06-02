// Governance test for spec 161 — Password reset and account lockout
// (Workflow Run 15 audit-closure MISS).
//
// The MISS findings:
//   1. No password reset flow — only operational recovery was a
//      manual super_admin SQL UPDATE, which left no audit trail.
//   2. No account lockout — the per-(ip,email) rate-limit alone left
//      a slow-grind attack viable, AND burned bcrypt CPU on each
//      attempt with no escalation.
//
// What this test pins:
//   — Schema additions (passwordResetTokens table + lockout columns).
//   — Migration 0020 ships the SQL with the right shape, registered
//     in the journal.
//   — Two new API routes (forgot-password, reset-password) exist
//     with POST handlers and the contract markers (no enumeration,
//     rate-limit + fail-closed, bcrypt cost 10, audit actions).
//   — Two new UI pages (/login/forgot, /login/reset) exist.
//   — Super-admin unlock endpoint exists.
//   — auth.ts emits the three new audit actions and honours the
//     lockout state machine.
//   — DesktopLogin's "Forgot password" link points at /login/forgot.
//   — All 5 spec-kit files exist.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const SCHEMA_PATH = "packages/db/src/schema/identity.ts";
const MIGRATION_PATH = "packages/db/src/migrations/0020_password_reset_and_lockout.sql";
const JOURNAL_PATH = "packages/db/src/migrations/meta/_journal.json";
const FORGOT_API_PATH = "apps/web/src/app/api/auth/forgot-password/route.ts";
const RESET_API_PATH = "apps/web/src/app/api/auth/reset-password/route.ts";
const UNLOCK_API_PATH = "apps/web/src/app/api/admin/users/[id]/unlock/route.ts";
const FORGOT_PAGE_PATH = "apps/web/src/app/login/forgot/page.tsx";
const RESET_PAGE_PATH = "apps/web/src/app/login/reset/page.tsx";
const AUTH_PATH = "apps/web/src/auth.ts";
const DESKTOP_LOGIN_PATH = "apps/web/src/app/login/DesktopLogin.tsx";
const MOBILE_LOGIN_PATH = "apps/web/src/app/login/MobileLogin.tsx";
const SPEC_DIR = "specs/161-password-reset-and-account-lockout";

// ---------- Spec-kit + plan.md contract ----------

test("spec 161 — all five spec-kit files are present", () => {
  for (const name of ["spec.md", "plan.md", "research.md", "quickstart.md", "tasks.md"]) {
    assert.ok(
      existsSync(resolve(root, SPEC_DIR, name)),
      `${SPEC_DIR}/${name} must exist for the password-reset-and-account-lockout spec`,
    );
  }
});

test("spec 161 — plan.md follows the CREATED/EDITED/MIGRATED contract and names every new surface", () => {
  const src = read(`${SPEC_DIR}/plan.md`);
  assert.match(src, /CREATED:/, "plan.md must declare a CREATED: line");
  assert.match(src, /EDITED:/, "plan.md must declare an EDITED: line");
  assert.match(src, /MIGRATED:/, "plan.md must declare a MIGRATED: line");
  for (const file of [
    "0020_password_reset_and_lockout",
    "forgot-password",
    "reset-password",
    "identity.ts",
    "auth.ts",
  ]) {
    assert.match(
      src,
      new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      `plan.md must call out ${file} so the surface is discoverable`,
    );
  }
});

// ---------- (1) Schema additions ----------

test("spec 161 — identity.ts adds failedLoginCount and lockedUntil columns to users", () => {
  const src = read(SCHEMA_PATH);
  // failedLoginCount MUST be NOT NULL DEFAULT 0 — without that the
  // existing users would backfill to NULL and the auth.ts increment
  // path would fail on the (NULL + 1) = NULL anti-pattern.
  assert.match(
    src,
    /failedLoginCount\s*:\s*integer\(\s*"failed_login_count"\s*\)\.notNull\(\)\.default\(\s*0\s*\)/,
    "users.failedLoginCount must be declared as NOT NULL DEFAULT 0 so the increment path doesn't trip over NULL",
  );
  // lockedUntil MUST be nullable (no notNull, no default) — the
  // common case is "no lockout", represented by NULL.
  assert.match(
    src,
    /lockedUntil\s*:\s*timestamp\(\s*"locked_until"\s*,\s*\{\s*withTimezone\s*:\s*true[\s\S]{0,200}\}\s*\)/,
    "users.lockedUntil must be a nullable withTimezone timestamp so 'no lockout' is representable as NULL",
  );
});

test("spec 161 — identity.ts declares the passwordResetTokens table with the right shape", () => {
  const src = read(SCHEMA_PATH);
  // The pgTable declaration itself
  assert.match(
    src,
    /export\s+const\s+passwordResetTokens\s*=\s*pgTable\(\s*"password_reset_tokens"/,
    "identity.ts must export passwordResetTokens as a pgTable named password_reset_tokens",
  );
  // The required columns
  assert.match(src, /tokenHash\s*:\s*text\(\s*"token_hash"\s*\)\.notNull\(\)/, "tokenHash must be NOT NULL text");
  assert.match(
    src,
    /expiresAt\s*:\s*timestamp\(\s*"expires_at"[\s\S]{0,200}\)\.notNull\(\)/,
    "expiresAt must be NOT NULL",
  );
  assert.match(src, /consumedAt\s*:\s*timestamp\(\s*"consumed_at"/, "consumedAt column must exist (nullable)");
  assert.match(src, /requestedFromIp\s*:\s*varchar\(\s*"requested_from_ip"/, "requestedFromIp column must exist");
  // The FK to users with cascade-on-delete
  assert.match(
    src,
    /references\(\s*\(\)\s*=>\s*users\.id\s*,\s*\{\s*onDelete\s*:\s*"cascade"\s*\}\s*\)/,
    "passwordResetTokens.userId must FK to users.id with onDelete cascade",
  );
  // The unique index on tokenHash
  assert.match(
    src,
    /uniqueIndex\(\s*"password_reset_tokens_hash_unique"\s*\)\.on\(\s*t\.tokenHash\s*\)/,
    "passwordResetTokens must have a UNIQUE INDEX on token_hash",
  );
  // The composite (userId, createdAt) index for the rate-limit query
  assert.match(
    src,
    /index\(\s*"password_reset_tokens_user_created_idx"\s*\)\.on\(\s*t\.userId\s*,\s*t\.createdAt\s*\)/,
    "passwordResetTokens must have a composite index on (userId, createdAt) so the rate-limit query is indexed",
  );
});

// ---------- (2) Migration 0020 ----------

test("spec 161 — migration 0020 is registered in the journal", () => {
  const src = read(JOURNAL_PATH);
  assert.match(
    src,
    /"tag"\s*:\s*"0020_password_reset_and_lockout"/,
    "_journal.json must register the 0020_password_reset_and_lockout migration",
  );
});

test("spec 161 — migration 0020 ships the CREATE TABLE + ALTER TABLE statements", () => {
  const src = read(MIGRATION_PATH);
  // The CREATE TABLE statement
  assert.match(
    src,
    /CREATE\s+TABLE\s+"password_reset_tokens"/i,
    "0020 migration must CREATE TABLE password_reset_tokens",
  );
  // The FK constraint
  assert.match(
    src,
    /ADD\s+CONSTRAINT\s+"password_reset_tokens_user_id_users_id_fk"[\s\S]{0,500}REFERENCES\s+"public"\."users"\("id"\)\s+ON\s+DELETE\s+cascade/i,
    "0020 migration must add the FK constraint with ON DELETE cascade",
  );
  // The unique index on token_hash
  assert.match(
    src,
    /CREATE\s+UNIQUE\s+INDEX\s+"password_reset_tokens_hash_unique"/i,
    "0020 migration must CREATE UNIQUE INDEX on token_hash",
  );
  // The users ALTER statements
  assert.match(
    src,
    /ALTER\s+TABLE\s+"users"\s+ADD\s+COLUMN\s+"failed_login_count"\s+integer\s+DEFAULT\s+0\s+NOT\s+NULL/i,
    "0020 migration must ALTER TABLE users ADD failed_login_count integer DEFAULT 0 NOT NULL",
  );
  assert.match(
    src,
    /ALTER\s+TABLE\s+"users"\s+ADD\s+COLUMN\s+"locked_until"\s+timestamp\s+with\s+time\s+zone/i,
    "0020 migration must ALTER TABLE users ADD locked_until timestamp with time zone",
  );
});

// ---------- (3) Forgot-password API ----------

test("spec 161 — forgot-password route is a POST handler with the contracted shape", () => {
  assert.ok(existsSync(resolve(root, FORGOT_API_PATH)), "forgot-password route.ts must exist");
  const src = read(FORGOT_API_PATH);
  // POST handler export
  assert.match(src, /export\s+async\s+function\s+POST\(/, "must export an async POST handler");
  // Rate limit bucket
  assert.match(
    src,
    /bucket:\s*"forgot-password"/,
    'rateLimit bucket must be "forgot-password" per the spec contract',
  );
  // 3/hr limit
  assert.match(
    src,
    /limit:\s*3[\s\S]{0,200}windowMs:\s*60\s*\*\s*60\s*\*\s*1000/,
    "rate-limit must be 3 requests per 60min (3/hr per IP)",
  );
  // Token generation via randomBytes(32)
  assert.match(
    src,
    /crypto\.randomBytes\(\s*32\s*\)/,
    "must generate the reset token via crypto.randomBytes(32) for ≥256 bits of entropy",
  );
  // bcrypt at cost 10 — either an inline literal or a named constant
  // bound to 10 (the spec contract). We match either shape but also
  // pin the literal 10 below so a future contributor can't quietly
  // drop the cost to 4.
  assert.match(
    src,
    /bcrypt\.hash\(/,
    "must bcrypt-hash the token before storage (look for bcrypt.hash(...) call)",
  );
  assert.match(
    src,
    /(?:BCRYPT_COST\s*=\s*10|bcrypt\.hash\([^,]+,\s*10\b)/,
    "must use bcrypt cost = 10 (matches lib/password.ts; load-bearing for the LMS-wide convention)",
  );
  // No enumeration — the contracted comment marker
  assert.match(
    src,
    /NO ENUMERATION/i,
    "must carry an inline NO ENUMERATION marker so a future contributor doesn't add a branch that leaks user existence",
  );
  // 30-minute TTL
  assert.match(
    src,
    /30\s*\*\s*60\s*\*\s*1000/,
    "token expiry must be 30 minutes (= 30 * 60 * 1000 ms)",
  );
  // Audit action
  assert.match(
    src,
    /"auth\.password\.reset_requested"/,
    "must emit the auth.password.reset_requested audit action",
  );
  // Spec 141 fail-closed pattern on rate-limit error
  assert.match(
    src,
    /"auth\.rate_limit\.redis_down"/,
    "must emit auth.rate_limit.redis_down on Redis fault (spec 141 fail-closed pattern)",
  );
});

// ---------- (4) Reset-password API ----------

test("spec 161 — reset-password route validates, transactions, and audits", () => {
  assert.ok(existsSync(resolve(root, RESET_API_PATH)), "reset-password route.ts must exist");
  const src = read(RESET_API_PATH);
  assert.match(src, /export\s+async\s+function\s+POST\(/, "must export an async POST handler");
  // Filter to unconsumed-non-expired rows
  assert.match(
    src,
    /isNull\(\s*passwordResetTokens\.consumedAt\s*\)/,
    "must filter SELECT to unconsumed tokens (consumedAt IS NULL)",
  );
  assert.match(
    src,
    /gt\(\s*passwordResetTokens\.expiresAt\s*,\s*now\s*\)/,
    "must filter SELECT to non-expired tokens (expiresAt > now)",
  );
  // bcrypt.compare loop
  assert.match(
    src,
    /bcrypt\.compare\(\s*token\s*,\s*row\.tokenHash\s*\)/,
    "must bcrypt-compare the plaintext token against each candidate row's tokenHash",
  );
  // Transactional update
  assert.match(
    src,
    /db\.transaction\(/,
    "must wrap the (update users + stamp consumedAt) writes in db.transaction so a partial failure can't leave the state inconsistent",
  );
  // Reset lockout in the same transaction
  assert.match(
    src,
    /failedLoginCount:\s*0[\s\S]{0,200}lockedUntil:\s*null/,
    "must reset failedLoginCount=0 AND lockedUntil=null in the same UPDATE",
  );
  // 410 status for invalid/expired/consumed
  assert.match(
    src,
    /status:\s*410/,
    "must respond 410 for invalid/expired/consumed tokens (single code so a probing attacker can't distinguish)",
  );
  // Audit action
  assert.match(
    src,
    /"auth\.password\.reset_completed"/,
    "must emit the auth.password.reset_completed audit action on success",
  );
});

// ---------- (5) UI pages ----------

test("spec 161 — /login/forgot page renders the email-input form and a no-enumeration success state", () => {
  assert.ok(existsSync(resolve(root, FORGOT_PAGE_PATH)), "/login/forgot page must exist");
  const src = read(FORGOT_PAGE_PATH);
  // POSTs to the forgot-password API
  assert.match(
    src,
    /\/api\/auth\/forgot-password/,
    "/login/forgot page must POST to /api/auth/forgot-password",
  );
  // Has a form with an email input
  assert.match(src, /type=["']email["']/, "/login/forgot page must have an email input");
  // The success state is generic ("If an account exists for that email")
  assert.match(
    src,
    /If an account exists for that email/i,
    "/login/forgot page success state must be generic (no enumeration) — phrasing 'If an account exists for that email'",
  );
});

test("spec 161 — /login/reset page reads the token from the URL and prompts for a new password", () => {
  assert.ok(existsSync(resolve(root, RESET_PAGE_PATH)), "/login/reset page must exist");
  const src = read(RESET_PAGE_PATH);
  // Reads ?token=... from the URL
  assert.match(
    src,
    /useSearchParams|searchParams/,
    "/login/reset page must read the token from the URL search params",
  );
  // Posts to the reset-password API
  assert.match(
    src,
    /\/api\/auth\/reset-password/,
    "/login/reset page must POST to /api/auth/reset-password",
  );
  // Has at least two password inputs (new + confirm)
  const passwordInputs = src.match(/type=["']password["']/g) ?? [];
  assert.ok(
    passwordInputs.length >= 2,
    `/login/reset page must have at least 2 password inputs (new + confirm); found ${passwordInputs.length}`,
  );
});

// ---------- (6) Lockout in auth.ts ----------

test("spec 161 — auth.ts honours the locked_until check before bcrypt verify", () => {
  const src = read(AUTH_PATH);
  // The check itself — locked_until > now
  assert.match(
    src,
    /user\.lockedUntil\s*&&\s*user\.lockedUntil\s*>\s*new\s+Date\(\)/,
    "auth.ts authorize() must check `user.lockedUntil && user.lockedUntil > new Date()` BEFORE the bcrypt verify so a locked account doesn't burn bcrypt CPU",
  );
  // The audit action for the locked attempt
  assert.match(
    src,
    /"auth\.account\.locked_attempt"/,
    "auth.ts must emit auth.account.locked_attempt when a login is refused due to lockout",
  );
});

test("spec 161 — auth.ts increments failedLoginCount on miss and locks at the 5th miss", () => {
  const src = read(AUTH_PATH);
  // The increment shape
  assert.match(
    src,
    /\(user\.failedLoginCount\s*\?\?\s*0\)\s*\+\s*1/,
    "auth.ts must compute newCount = (user.failedLoginCount ?? 0) + 1 — the ?? guards a backfilled-NULL row",
  );
  // The threshold check at 5
  assert.match(
    src,
    /newCount\s*>=\s*5/,
    "auth.ts must lock when newCount >= 5 (the spec-contracted threshold)",
  );
  // The 1-hour lock duration
  assert.match(
    src,
    /60\s*\*\s*60\s*\*\s*1000/,
    "auth.ts must set lockedUntil = +1 hour (= 60 * 60 * 1000 ms)",
  );
  // The audit action for the lock-now branch
  assert.match(
    src,
    /"auth\.account\.locked"/,
    "auth.ts must emit auth.account.locked when the lockout is armed",
  );
});

test("spec 161 — auth.ts resets failedLoginCount and lockedUntil on successful credentials login", () => {
  const src = read(AUTH_PATH);
  // The success-path UPDATE must reset BOTH columns alongside lastSeenAt.
  assert.match(
    src,
    /\.set\(\s*\{\s*lastSeenAt:\s*new\s+Date\(\)\s*,\s*failedLoginCount:\s*0\s*,\s*lockedUntil:\s*null\s*\}\s*\)/,
    "auth.ts success-path UPDATE must reset { lastSeenAt: new Date(), failedLoginCount: 0, lockedUntil: null } so a successful login clears any pending lockout state",
  );
});

// ---------- (7) Unlock endpoint ----------

test("spec 161 — /api/admin/users/[id]/unlock guards super_admin only and clears the lockout state", () => {
  assert.ok(
    existsSync(resolve(root, UNLOCK_API_PATH)),
    "unlock endpoint route.ts must exist at apps/web/src/app/api/admin/users/[id]/unlock/route.ts",
  );
  const src = read(UNLOCK_API_PATH);
  // requireRole call
  assert.match(
    src,
    /requireRole\(\[\s*"super_admin"\s*\]\)/,
    "unlock endpoint must guard with requireRole(['super_admin'])",
  );
  // Clears the lockout state
  assert.match(
    src,
    /failedLoginCount:\s*0[\s\S]{0,200}lockedUntil:\s*null/,
    "unlock endpoint UPDATE must set { failedLoginCount: 0, lockedUntil: null }",
  );
  // Audit action
  assert.match(
    src,
    /"auth\.account\.unlocked"/,
    "unlock endpoint must emit auth.account.unlocked audit",
  );
});

// ---------- (8) Login UI link wiring ----------

test("spec 161 — DesktopLogin's Forgot password link points at /login/forgot, not the # stub", () => {
  const src = read(DESKTOP_LOGIN_PATH);
  assert.match(
    src,
    /href="\/login\/forgot"/,
    'DesktopLogin must wire the "Forgot password?" Link to /login/forgot (was href="#" pre-fix)',
  );
});

test("spec 161 — MobileLogin gains a Forgot password Link below the credentials Sign-in button", () => {
  const src = read(MOBILE_LOGIN_PATH);
  // Imports Link from next/link
  assert.match(
    src,
    /import\s+Link\s+from\s+"next\/link"/,
    "MobileLogin must import Link from next/link to render the forgot-password link",
  );
  // The Link itself
  assert.match(
    src,
    /href="\/login\/forgot"/,
    "MobileLogin must include a Link with href=/login/forgot below the credentials Sign-in button",
  );
});

// ---------- No-regression / hygiene ----------

test("spec 161 — no TODO / FIXME / placeholder markers leaked into shipped source", () => {
  for (const path of [
    FORGOT_API_PATH,
    RESET_API_PATH,
    UNLOCK_API_PATH,
    FORGOT_PAGE_PATH,
    RESET_PAGE_PATH,
    AUTH_PATH,
    SCHEMA_PATH,
    MIGRATION_PATH,
  ]) {
    const src = read(path);
    assert.ok(!/\bTODO\b/i.test(src), `${path} must not contain TODO markers`);
    assert.ok(!/\bFIXME\b/i.test(src), `${path} must not contain FIXME markers`);
  }
});

test("spec 161 — no new dependencies were introduced (bcryptjs / nodemailer / crypto are pre-existing)", () => {
  const pkg = read("apps/web/package.json");
  // The spec uses bcryptjs (already a dep), nodemailer (already), and
  // node:crypto (built-in). No new password-strength or token-gen
  // library should have crept in.
  assert.ok(
    !/"argon2"/.test(pkg),
    "apps/web must not depend on argon2 — the LMS-wide convention is bcryptjs(10) for all secret-verify use cases",
  );
  assert.ok(
    !/"jsonwebtoken"/.test(pkg),
    "apps/web must not depend on jsonwebtoken for the reset tokens — random + bcrypt is the contract",
  );
  assert.ok(
    !/"zxcvbn"/.test(pkg),
    "apps/web must not depend on zxcvbn — password strength scoring is a non-goal of spec 161",
  );
});
