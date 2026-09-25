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
// A session that came from a recovery link is distinguishable: GoTrue records
// how it was authenticated in the token's `amr` claim, and a recovery link
// yields {"method":"recovery","timestamp":...}. A password sign-in yields
// {"method":"password"}.
//
// These run the real page and action, with the real @supabase/ssr client
// writing and reading the session cookies, against ./_fake_gotrue.ts.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resetRequest, outcome, form, renderSync, closeAppDb } from "./_auth-harness.ts";
import { needsDatabase } from "./_harness.js";
import { fakeGoTrue, type FakeGoTrue } from "./_fake_gotrue.ts";

// Password sign-in is throttled by a Postgres counter (auth.ts signInAllowed).
const skip = needsDatabase();

const authModule = () => import("../../apps/web/src/auth.ts");
const serverClient = () => import("../../apps/web/src/lib/supabase/server.ts");
const resetActions = () => import("../../apps/web/src/app/login/reset/actions.ts");
const resetPage = () => import("../../apps/web/src/app/login/reset/page.tsx");

let fake: FakeGoTrue;
let restoreEnv: () => void;
const IP = `198.19.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

before(async () => {
  if (skip) return;
  fake = await fakeGoTrue();
  restoreEnv = fake.install();
});

after(async () => {
  if (skip) return;
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
