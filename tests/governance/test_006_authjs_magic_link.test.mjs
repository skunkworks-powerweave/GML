// Spec 006 was "Auth.js magic-link sign-in". Inverted for Supabase Auth.
//
// The original provider was the single most dangerous thing in the codebase.
// Nodemailer + DrizzleAdapter auto-created a user row for ANY address that
// requested a link -- role='teacher', active=true, no signIn callback to stop
// it -- and the magic-link path never checked users.active either, so a
// deactivated member of staff could sign straight back in. It was dormant only
// because SMTP_HOST happened to be empty.
//
// The replacement is structurally incapable of that: shouldCreateUser: false
// means no row is written, and even if one were, the access-token hook refuses
// to mint a JWT for a profile that is missing or inactive.

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


test("magic-link sign-in cannot create an account", () => {
  const src = read("apps/web/src/app/login/email-actions.ts");
  assert.match(src, /signInWithOtp\(/, "magic link must go through Supabase");
  assert.match(
    src,
    /shouldCreateUser:\s*false/,
    "THE load-bearing line: without it, requesting a link for an unknown address " +
      "creates that account",
  );
});

test("nodemailer is gone from apps/web", () => {
  const pkg = JSON.parse(read("apps/web/package.json"));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  assert.ok(!deps["nodemailer"], "nodemailer must not be a dependency");
  assert.ok(!deps["@types/nodemailer"]);
});

test("email-link-form exists and posts to a server action", () => {
  assert.ok(exists("apps/web/src/app/login/email-link-form.tsx"));
  const src = read("apps/web/src/app/login/email-link-form.tsx");
  assert.match(src, /sendMagicLinkAction/);
  assert.ok(
    !/\/api\/auth\/signin\/email/.test(code(src)),
    "the Auth.js built-in endpoint no longer exists",
  );
});

test("the magic-link UI is hidden when no mail relay is configured", () => {
  const page = read("apps/web/src/app/login/page.tsx");
  assert.match(
    page,
    /authEmailEnabled\(\)/,
    "the login page must resolve email availability server-side",
  );
  for (const shell of [
    "apps/web/src/app/login/DesktopLogin.tsx",
    "apps/web/src/app/login/MobileLogin.tsx",
  ]) {
    assert.match(
      read(shell),
      /emailEnabled/,
      `${shell} must take emailEnabled — offering a sign-in method that cannot ` +
        `deliver sends users to a form whose success message is a lie`,
    );
  }
});

test("email links land on a PKCE exchange route", () => {
  const src = read("apps/web/src/app/auth/callback/route.ts");
  assert.match(src, /exchangeCodeForSession\(/);
  assert.match(
    src,
    /startsWith\("\/\/"\)/,
    "the ?next= target arrives inside a mailed URL — the most effective possible " +
      "open-redirect vector, because the link genuinely authenticates first",
  );
});
