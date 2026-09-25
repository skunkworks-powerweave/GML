// /login/reset -- choosing a new password from a recovery link -- EXECUTED.
//
// ── THE DEFECT (F78) ─────────────────────────────────────────────────────────
//
// The reset page and resetPasswordAction checked only that SOME session
// existed. So anyone at an unattended, signed-in school computer could open
// /login/reset, set a new password with no current password, and the action
// then signed out every other session -- locking the owner out everywhere.
// /settings asks for the current password for exactly this reason ("shared
// school computers"); /login/reset walked around it.
//
// A session that came from an emailed link is distinguishable: GoTrue records
// how it was authenticated in the token's `amr` claim. A password sign-in
// yields {"method":"password"}. The /auth/confirm link README-deploy §2.3
// tells IT to use is redeemed with POST /verify, which issues its session as
// {"method":"otp"} whatever the link's type (GoTrue verify.go:285, v2.196.0);
// only the older PKCE link yields "recovery" (or "magiclink"). GoTrue's own
// Session.IsRecovery() counts all three (models/factor.go), and so does the app.
//
// ── THE REWORK ───────────────────────────────────────────────────────────────
//
// The first fix accepted only "recovery", and the stand-in wrongly issued
// "recovery" for a token_hash link, so the tests passed while the recommended
// link could never set a password: /login/reset sent the person to /settings,
// which asks for the password they had forgotten. The end-to-end test below
// follows that link exactly as a browser does.
//
// These run the real route, page and action, with the real @supabase/ssr
// client writing and reading the session cookies, against ./_fake_gotrue.ts.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request, resetRequest, outcome, form, renderSync, closeAppDb, webRequire } from "./_auth-harness.ts";
import { needsDatabase } from "./_harness.js";
import { fakeGoTrue, type FakeGoTrue } from "./_fake_gotrue.ts";

// Password sign-in is throttled by a Postgres counter (auth.ts signInAllowed).
const skip = needsDatabase();

const authModule = () => import("../../apps/web/src/auth.ts");
const serverClient = () => import("../../apps/web/src/lib/supabase/server.ts");
const resetActions = () => import("../../apps/web/src/app/login/reset/actions.ts");
const resetPage = () => import("../../apps/web/src/app/login/reset/page.tsx");
const confirmRoute = () => import("../../apps/web/src/app/auth/confirm/route.ts");

let fake: FakeGoTrue;
let restoreEnv: () => void;
const IP = `198.19.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

const savedAppUrl = process.env.APP_URL;

before(async () => {
  if (skip) return;
  fake = await fakeGoTrue();
  restoreEnv = fake.install();
  process.env.APP_URL = "https://lms.example.test";
});

after(async () => {
  if (skip) return;
  if (savedAppUrl === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = savedAppUrl;
  restoreEnv();
  await fake.close();
  await closeAppDb();
});

function makeUser() {
  const password = `old-${randomUUID()}`;
  return { ...fake.addUser({ email: `reset-${randomUUID()}@example.test`, password }), password };
}

/** A browser signed in the ordinary way, with a password. */
async function passwordSession(u: { email: string; password: string }) {
  resetRequest({ "x-real-ip": IP });
  const { signInWithPassword } = await authModule();
  assert.equal((await signInWithPassword(u.email, u.password)).error, null);
}

/** A browser that followed a recovery link `ageSeconds` ago. */
async function recoverySession(userId: string, ageSeconds = 0) {
  resetRequest({ "x-real-ip": IP });
  const { createSupabaseServerClient } = await serverClient();
  const sb = await createSupabaseServerClient();
  const { error } = await sb.auth.verifyOtp({ type: "recovery", token_hash: fake.issueOtp(userId, "recovery", ageSeconds) });
  assert.equal(error, null);
}

const NEW = "a-brand-new-password";

test("a signed-in browser cannot set a new password at /login/reset without the current one", { skip }, async () => {
  const u = makeUser();
  await passwordSession(u);
  const { resetPasswordAction } = await resetActions();
  const before = fake.calls("PUT", "/user").length;
  const res = await outcome(() => resetPasswordAction(undefined, form({ password: NEW, confirm: NEW })));

  assert.equal(res.kind, "returned", `the action must refuse, not ${JSON.stringify(res)}`);
  assert.match(String((res as { value: { error?: string } }).value.error), /settings/i, "it must point at Settings");
  assert.equal(fake.calls("PUT", "/user").length, before, "GoTrue must not be asked to change the password");
  assert.equal(fake.users.get(u.id)!.password, u.password, "the password must be unchanged");
});

test("the reset page sends an ordinary session to Settings instead of offering the form", { skip }, async () => {
  const u = makeUser();
  await passwordSession(u);
  const { default: ResetPasswordPage } = await resetPage();
  const res = await outcome(() => ResetPasswordPage());
  assert.deepEqual(res, { kind: "redirect", location: "/settings" });
});

test("a recovery-link session sets the new password and ends the other sessions", { skip }, async () => {
  const u = makeUser();
  const phone = await fake.deviceSignIn(u.email, u.password);
  await recoverySession(u.id);

  const { default: ResetPasswordPage } = await resetPage();
  const page = await outcome(() => ResetPasswordPage());
  assert.equal(page.kind, "returned");
  assert.match(renderSync((page as { value: unknown }).value), /data-testid="reset-password"/, "the form is offered");

  const { resetPasswordAction } = await resetActions();
  const res = await outcome(() => resetPasswordAction(undefined, form({ password: NEW, confirm: NEW })));
  assert.deepEqual(res, { kind: "redirect", location: "/dashboard" });
  assert.equal(fake.users.get(u.id)!.password, NEW);
  assert.equal((await fake.deviceRefresh(String(phone.body.refresh_token))).status, 400, "other devices are signed out");
});

test("a recovery session is only good for a short while after the link was followed", { skip }, async () => {
  const u = makeUser();
  await recoverySession(u.id, 60 * 60);
  const { resetPasswordAction } = await resetActions();
  const res = await outcome(() => resetPasswordAction(undefined, form({ password: NEW, confirm: NEW })));
  assert.equal(res.kind, "returned");
  assert.match(String((res as { value: { error?: string } }).value.error), /expired|new one/i);
  assert.equal(fake.users.get(u.id)!.password, u.password);

  const { default: ResetPasswordPage } = await resetPage();
  const page = await outcome(() => ResetPasswordPage());
  assert.equal(page.kind, "returned");
  assert.match(renderSync((page as { value: unknown }).value), /data-testid="reset-link-invalid"/);
});

/**
 * Follow an emailed /auth/confirm link in a browser that has no cookies for
 * this site, as README-deploy §2.3's templates write it. The session the route
 * sets stays in the cookie jar for the requests that follow.
 */
async function followEmailedLink(query: string): Promise<string> {
  resetRequest({ "x-real-ip": IP });
  const { NextRequest } = webRequire("next/server") as typeof import("next/server");
  const { GET } = await confirmRoute();
  const res = await GET(new NextRequest(`http://0.0.0.0:3000/auth/confirm?${query}`));
  assert.ok(
    request.cookieWrites.some((w) => /^sb-.*-auth-token/.test(w.name) && w.value !== ""),
    "following the link must sign this browser in",
  );
  return new URL(res.headers.get("location") ?? "").pathname;
}

test("the emailed recovery link, opened in a fresh browser, offers the form and the form sets the password", { skip }, async () => {
  const u = makeUser();
  const phone = await fake.deviceSignIn(u.email, u.password);
  const hash = fake.issueOtp(u.id, "recovery");
  const landed = await followEmailedLink(`token_hash=${hash}&type=recovery&next=%2Flogin%2Freset`);
  assert.equal(landed, "/login/reset");

  const { default: ResetPasswordPage } = await resetPage();
  const page = await outcome(() => ResetPasswordPage());
  assert.equal(
    page.kind,
    "returned",
    `the page must offer the form to the session the link created, not ${JSON.stringify(page)}: ` +
      "/settings asks for the password this person has forgotten",
  );
  assert.match(renderSync((page as { value: unknown }).value), /data-testid="reset-password"/);

  const { resetPasswordAction } = await resetActions();
  const res = await outcome(() => resetPasswordAction(undefined, form({ password: NEW, confirm: NEW })));
  assert.deepEqual(res, { kind: "redirect", location: "/dashboard" });
  assert.equal(fake.users.get(u.id)!.password, NEW, "the new password must be set");
  assert.equal((await fake.deviceRefresh(String(phone.body.refresh_token))).status, 400, "other devices are signed out");
});

test("a magic-link session proves the same mailbox, and may set a password while it is fresh", { skip }, async () => {
  const u = makeUser();
  const hash = fake.issueOtp(u.id, "magiclink");
  await followEmailedLink(`token_hash=${hash}&type=magiclink&next=%2Fdashboard`);
  const { resetPasswordAction } = await resetActions();
  const res = await outcome(() => resetPasswordAction(undefined, form({ password: NEW, confirm: NEW })));
  assert.deepEqual(res, { kind: "redirect", location: "/dashboard" });
  assert.equal(fake.users.get(u.id)!.password, NEW);
});
