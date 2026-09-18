// Spec 005 was "Auth.js credentials sign-in". Identity has since moved to
// Supabase Auth, so these assertions were inverted rather than deleted: the
// point of the file is now to stop Auth.js coming back alongside Supabase.
//
// Two session implementations in one application is not a redundancy, it is a
// hole -- whichever one a given code path happens to consult decides who the
// user is, and a user deactivated in one remains signed in through the other.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");
const exists = (p) => existsSync(resolve(root, p));

// Strip comments before asserting a symbol is ABSENT. These files document at
// length what was removed and why, naming the very identifiers asserted against
// -- a bare substring search would fail on the documentation of the fix.
const code = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");


test("apps/web declares the Supabase auth deps and no Auth.js", () => {
  const pkg = JSON.parse(read("apps/web/package.json"));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };

  assert.ok(deps["@supabase/ssr"], "@supabase/ssr is what reads and writes the auth cookies");
  assert.ok(deps["@supabase/supabase-js"], "@supabase/supabase-js provides the auth client");
  assert.ok(deps["@gml/db"]);
  // bcryptjs stays: section-gate passwords are a shared rotatable secret with no
  // Supabase equivalent, and are not user credentials.
  assert.ok(deps["bcryptjs"]);

  for (const gone of ["next-auth", "@auth/drizzle-adapter", "nodemailer"]) {
    assert.ok(!deps[gone], `${gone} must not be a dependency — identity is Supabase's now`);
  }
});

test("auth.ts is backed by Supabase and verifies the token locally", () => {
  const src = read("apps/web/src/auth.ts");
  assert.match(src, /createSupabaseServerClient/, "auth() must use the Supabase server client");
  assert.match(
    src,
    /getClaims\(\)/,
    "auth() must use getClaims(): getSession() trusts the cookie (a forged one " +
      "passes) and getUser() puts a network round-trip on every render",
  );
  assert.ok(
    !/DrizzleAdapter|NextAuth\(/.test(code(src)),
    "auth.ts must not wire Auth.js — see the file header for what that cost",
  );
});

test("auth() fails closed when the access-token hook has not been registered", () => {
  const src = read("apps/web/src/auth.ts");
  assert.match(
    src,
    /isRoleName\(role\)/,
    "the role claim must be validated, not cast",
  );
  assert.ok(
    !/user_role[^\n]*\?\?\s*["']teacher["']/.test(src),
    "a missing user_role claim must yield NO SESSION, never a default role. " +
      "The most likely cause of its absence is the dashboard hook not being " +
      "enabled, and defaulting would grant access to the very accounts the hook " +
      "exists to refuse",
  );
});

test("the Auth.js catch-all route is gone", () => {
  assert.ok(
    !exists("apps/web/src/app/api/auth/[...nextauth]/route.ts"),
    "the [...nextauth] handler must not exist — it would serve a second, " +
      "parallel session endpoint",
  );
});

test("password.ts keeps only the section-gate bcrypt cost", () => {
  const src = read("apps/web/src/lib/password.ts");
  assert.match(src, /BCRYPT_COST\s*=\s*10/);
  assert.ok(
    !/hashPassword|verifyPassword/.test(code(src)),
    "user-password helpers must not exist — credentials are verified by GoTrue",
  );
});

test("rate-limit.ts uses Redis sliding window", () => {
  const src = read("apps/web/src/lib/rate-limit.ts");
  assert.match(src, /ioredis|Redis/);
  assert.match(src, /ZADD|zadd|sliding|window/i);
});

test("login page + server action exist", () => {
  assert.ok(exists("apps/web/src/app/login/page.tsx"));
  assert.ok(exists("apps/web/src/app/login/actions.ts"));
});

test("loginAction validates its redirect target", () => {
  const src = read("apps/web/src/app/login/actions.ts");
  assert.match(
    src,
    /startsWith\("\/\/"\)/,
    "the post-login redirect must reject protocol-relative paths — proxy.ts puts " +
      "an attacker-suppliable value in ?from=, and //evil.example is resolved by " +
      "browsers as a foreign origin, turning a real sign-in into an open redirect",
  );
});
