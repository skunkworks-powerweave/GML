// Email-link sign-in and password recovery, EXECUTED: the real route handlers
// and the real @supabase/ssr client, against ./_fake_gotrue.ts.
//
// ── THE DEFECT (F84) ─────────────────────────────────────────────────────────
//
// Both email flows used @supabase/ssr's PKCE default, where the code verifier
// is a cookie in the browser that asked for the email. A teacher who requests a
// reset on a school computer and opens the email on her phone -- the normal
// case here -- gets exchangeCodeForSession failing and lands on
// /login?error=link_expired. And /login ignored ?error=, so she saw a plain
// sign-in form with no explanation.
//
// The fix is Supabase's documented server-side pattern: the email templates
// link to /auth/confirm?token_hash={{ .TokenHash }}&type=..., and the route
// calls verifyOtp({ type, token_hash }), which needs nothing from the browser
// that requested the email. README-deploy §2.3 has the template text.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request, resetRequest, closeAppDb, webRequire } from "./_auth-harness.ts";
import { needsDatabase } from "./_harness.js";
import { fakeGoTrue, type FakeGoTrue } from "./_fake_gotrue.ts";

// auth.ts imports @gml/db (it confirms administrative roles against the profile).
const skip = needsDatabase();

const confirmRoute = () => import("../../apps/web/src/app/auth/confirm/route.ts");
const callbackRoute = () => import("../../apps/web/src/app/auth/callback/route.ts");
const authModule = () => import("../../apps/web/src/auth.ts");

let fake: FakeGoTrue;
let restoreEnv: () => void;
const savedAppUrl = process.env.APP_URL;
const ORIGIN = "https://lms.example.test";

before(async () => {
  fake = await fakeGoTrue();
  restoreEnv = fake.install();
  process.env.APP_URL = ORIGIN;
});

after(async () => {
  if (savedAppUrl === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = savedAppUrl;
  restoreEnv();
  await fake.close();
  await closeAppDb();
});

const { NextRequest } = webRequire("next/server") as typeof import("next/server");

/** Open a link as a browser that has never seen this site (the phone). */
async function openOnAnotherDevice(route: { GET: (r: InstanceType<typeof NextRequest>) => Promise<Response> }, path: string) {
  resetRequest();
  // What the handler sees behind Caddy: Next's own bind address.
  const res = await route.GET(new NextRequest(`http://0.0.0.0:3000${path}`));
  return { status: res.status, location: res.headers.get("location") ?? "" };
}

function makeUser() {
  return fake.addUser({ email: `link-${randomUUID()}@example.test`, password: `pw-${randomUUID()}` });
}

test("a PKCE callback link opened on another device fails -- the defect the token_hash route removes", { skip }, async () => {
  const res = await openOnAnotherDevice(await callbackRoute(), "/auth/callback?code=abc&next=%2Flogin%2Freset");
  assert.equal(res.location, `${ORIGIN}/login?error=link_expired`);
});

test("a recovery link works in a browser that did not request it, and lands on /login/reset", { skip }, async () => {
  const u = makeUser();
  const hash = fake.issueOtp(u.id, "recovery");
  const res = await openOnAnotherDevice(await confirmRoute(), `/auth/confirm?token_hash=${hash}&type=recovery&next=%2Flogin%2Freset`);
  assert.equal(res.location, `${ORIGIN}/login/reset`);
  assert.ok(
    request.cookieWrites.some((w) => /^sb-.*-auth-token/.test(w.name) && w.value !== ""),
    "the session must be written to this browser",
  );
  const { recoverySessionState } = await authModule();
  assert.equal(await recoverySessionState(), "recovery", "and it must be a recovery session, which /login/reset accepts");
});

test("a magic link works cross-device and lands where it points", { skip }, async () => {
  const u = makeUser();
  const hash = fake.issueOtp(u.id, "magiclink");
  const res = await openOnAnotherDevice(await confirmRoute(), `/auth/confirm?token_hash=${hash}&type=magiclink&next=%2Fdashboard`);
  assert.equal(res.location, `${ORIGIN}/dashboard`);
});

test("a used or expired link says so; a mangled one says it is invalid; next cannot leave the site", { skip }, async () => {
  const route = await confirmRoute();
  const u = makeUser();
  const hash = fake.issueOtp(u.id, "recovery");
  await openOnAnotherDevice(route, `/auth/confirm?token_hash=${hash}&type=recovery&next=%2Flogin%2Freset`);
  const again = await openOnAnotherDevice(route, `/auth/confirm?token_hash=${hash}&type=recovery&next=%2Flogin%2Freset`);
  assert.equal(again.location, `${ORIGIN}/login?error=link_expired`, "a link is single-use");

  for (const q of ["", "?type=recovery", "?token_hash=x", "?token_hash=x&type=signup", "?token_hash=x&type=email"]) {
    const r = await openOnAnotherDevice(route, `/auth/confirm${q}`);
    assert.equal(r.location, `${ORIGIN}/login?error=link_invalid`, `for ${q || "no query"}`);
  }

  const evil = await openOnAnotherDevice(
    route,
    `/auth/confirm?token_hash=${fake.issueOtp(u.id, "magiclink")}&type=magiclink&next=%2F%2Fevil.example`,
  );
  assert.equal(evil.location, `${ORIGIN}/dashboard`);
});

// GoTrue's verifyTokenHash resolves type=email against confirmation_token as
// well as recovery_token, and redeems a confirmation as a SIGN-UP
// verification (internal/api/verify.go:649-651, 734-742). type=magiclink and
// type=recovery read recovery_token only -- which is where GoTrue keeps a
// magic-link token too (mail.go sendMagicLink). So "email" is not accepted:
// it is the one type that would let a confirmation link through.
test("a sign-up confirmation link signs nobody in at /auth/confirm, whatever type it is sent as", { skip }, async () => {
  const route = await confirmRoute();
  const u = makeUser();
  for (const type of ["email", "signup", "invite", "magiclink", "recovery"]) {
    const hash = fake.issueOtp(u.id, "signup");
    const r = await openOnAnotherDevice(route, `/auth/confirm?token_hash=${hash}&type=${type}&next=%2Fdashboard`);
    assert.match(r.location, /\/login\?error=link_(invalid|expired)$/, `type=${type} must not be redeemed: ${r.location}`);
    assert.ok(
      !request.cookieWrites.some((w) => /^sb-.*-auth-token/.test(w.name) && w.value !== ""),
      `type=${type}: no session may be written for a confirmation link`,
    );
  }
});
