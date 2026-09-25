// Supabase's "require current password" setting, EXECUTED: the real /settings,
// /login/reset and admin actions and proxy.ts against ./_fake_gotrue.ts with
// GoTrue's Security.UpdatePasswordRequireCurrentPassword turned on.
//
// ── THE DEFECT (W3-05) ───────────────────────────────────────────────────────
//
// README-deploy §2.2f called the direct password change unclosable: anyone at
// a browser left signed in can read the JS-readable access token and PUT
// /auth/v1/user with a new password. GoTrue has a setting that closes it for
// password sessions, and the README never named it. Worse, turning it on would
// have broken the app: changePasswordAction re-verified the current password
// itself but never passed it to GoTrue, so every /settings change -- including
// the one an administrator-created account must make before it can reach any
// other page -- came back "Current password required".

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { request, resetRequest, form, outcome, closeAppDb, webRequire } from "./_auth-harness.ts";
import { needsDatabase, DATABASE_URL, tag } from "./_harness.js";
import { fakeGoTrue, ensureAuthSessionsTable, ANON_KEY, type FakeGoTrue } from "./_fake_gotrue.ts";

const skip = needsDatabase();

const authModule = () => import("../../apps/web/src/auth.ts");
const adminActions = () => import("../../apps/web/src/app/(authenticated)/admin/users/actions.ts");
const settingsActions = () => import("../../apps/web/src/app/(authenticated)/settings/actions.ts");
const resetActions = () => import("../../apps/web/src/app/login/reset/actions.ts");
const serverClient = () => import("../../apps/web/src/lib/supabase/server.ts");
const proxyModule = () => import("../../apps/web/src/proxy.ts");

let pg: Client;
let fake: FakeGoTrue;
let restoreEnv: () => void;
const createdIds: string[] = [];
const createdEmails: string[] = [];
const IP = `203.0.113.${Math.floor(Math.random() * 250) + 1}`;

before(async () => {
  if (skip) return;
  pg = new Client({ connectionString: DATABASE_URL });
  await pg.connect();
  await ensureAuthSessionsTable(pg);
  fake = await fakeGoTrue({
    sessionTable: pg,
    requireCurrentPassword: true,
    hook: async (id) => {
      const { rows } = await pg.query<{ role: string; active: boolean }>("SELECT role, active FROM users WHERE id = $1", [id]);
      if (!rows[0]?.active) return { error: { http_code: 403, message: "not active" } };
      return { role: rows[0].role };
    },
  });
  restoreEnv = fake.install();
});

after(async () => {
  if (skip) return;
  await pg.query("DELETE FROM users WHERE id = ANY($1::uuid[]) OR email = ANY($2::text[])", [createdIds, createdEmails]);
  restoreEnv();
  await fake.close();
  await pg.end();
  await closeAppDb();
});

async function makeUser(role: string) {
  const id = randomUUID();
  const email = `${tag("curpw")}@example.test`;
  const password = `pw-${randomUUID()}`;
  await pg.query("INSERT INTO users (id, email, name, role, active) VALUES ($1, $2, 'CurPw', $3::role, true)", [id, email, role]);
  createdIds.push(id);
  fake.addUser({ id, email, password });
  return { id, email, password };
}

async function signInThroughApp(email: string, password: string) {
  resetRequest({ "x-real-ip": IP });
  const { signInWithPassword } = await authModule();
  const r = await signInWithPassword(email, password);
  assert.equal(r.error, null, `sign-in as ${email}: ${String(r.error)}`);
}

/** Where the proxy sends this browser for GET `path` (null: straight through). */
async function proxyRedirect(path: string): Promise<string | null> {
  const { NextRequest } = webRequire("next/server") as typeof import("next/server");
  const { default: proxy } = await proxyModule();
  const cookie = Object.entries(request.cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
  const res = await proxy(new NextRequest(`http://0.0.0.0:3000${path}`, { headers: { cookie } }));
  const location = res.headers.get("location");
  if (!location) return null;
  const u = new URL(location);
  return u.pathname + u.search;
}

const fakeUserByEmail = (email: string) => [...fake.users.values()].find((u) => u.email === email);

test("with the setting on, /settings still changes the password", { skip }, async () => {
  const u = await makeUser("teacher");
  await signInThroughApp(u.email, u.password);
  const { changePasswordAction } = await settingsActions();
  const res = await changePasswordAction(
    undefined,
    form({ currentPassword: u.password, newPassword: "chosen-with-setting-1", confirmPassword: "chosen-with-setting-1" }),
  );
  assert.ok(res.ok, JSON.stringify(res));
  assert.equal(fake.users.get(u.id)!.password, "chosen-with-setting-1");
});

test("with the setting on, an administrator-created account can still replace its initial password", { skip }, async () => {
  const actor = await makeUser("super_admin");
  await signInThroughApp(actor.email, actor.password);
  const email = `${tag("curpw-new")}@example.test`;
  createdEmails.push(email);
  const initial = "handed-over-1";
  const { createUserAction } = await adminActions();
  const created = await createUserAction(undefined, form({ email, name: "New Teacher", role: "teacher", password: initial }));
  assert.ok(created.ok, JSON.stringify(created));

  await signInThroughApp(email, initial);
  assert.equal(await proxyRedirect("/dashboard"), "/settings?password=required");
  const { changePasswordAction } = await settingsActions();
  const res = await changePasswordAction(
    undefined,
    form({ currentPassword: initial, newPassword: "my-own-choice-1", confirmPassword: "my-own-choice-1" }),
  );
  assert.ok(res.ok, JSON.stringify(res));
  assert.equal(fakeUserByEmail(email)?.appMetadata.must_change_password, undefined);
  assert.equal(await proxyRedirect("/dashboard"), null, "no longer held on /settings");
});

test("with the setting on, a recovery-link reset still works: GoTrue exempts emailed-link sessions", { skip }, async () => {
  const u = await makeUser("teacher");
  resetRequest({ "x-real-ip": IP });
  const { createSupabaseServerClient } = await serverClient();
  const sb = await createSupabaseServerClient();
  assert.equal((await sb.auth.verifyOtp({ type: "recovery", token_hash: fake.issueOtp(u.id, "recovery") })).error, null);
  const { resetPasswordAction } = await resetActions();
  const res = await outcome(() => resetPasswordAction(undefined, form({ password: "reset-by-me-1", confirm: "reset-by-me-1" })));
  assert.deepEqual(res, { kind: "redirect", location: "/dashboard" });
  assert.equal(fake.users.get(u.id)!.password, "reset-by-me-1");
});

test("a recovery-link reset to the same password is refused, with the setting on or off", { skip }, async () => {
  // Only the current-password check exempts an emailed-link session; GoTrue's
  // same_password check runs for every session whose user has a password
  // (user.go:167-196 in v2.196.0). /login/reset surfaces GoTrue's message.
  for (const on of [true, false]) {
    fake.setRequireCurrentPassword(on);
    try {
      const u = await makeUser("teacher");
      resetRequest({ "x-real-ip": IP });
      const { createSupabaseServerClient } = await serverClient();
      const sb = await createSupabaseServerClient();
      assert.equal((await sb.auth.verifyOtp({ type: "recovery", token_hash: fake.issueOtp(u.id, "recovery") })).error, null);
      const { resetPasswordAction } = await resetActions();
      const res = await outcome(() => resetPasswordAction(undefined, form({ password: u.password, confirm: u.password })));
      assert.deepEqual(
        res,
        { kind: "returned", value: { error: "New password should be different from the old password." } },
        `setting ${on ? "on" : "off"}`,
      );
    } finally {
      fake.setRequireCurrentPassword(true);
    }
  }
});

test("with the setting on, a bare PUT /user from a password session cannot set a password", { skip }, async () => {
  // What someone at a browser left signed in could do with the token the
  // page scripts can read (README-deploy §2.2f).
  const u = await makeUser("teacher");
  const signedIn = await fake.deviceSignIn(u.email, u.password);
  const token = String(signedIn.body.access_token);
  const put = async (body: Record<string, unknown>) => {
    const r = await fetch(`${fake.url}/auth/v1/user`, {
      method: "PUT",
      headers: { apikey: ANON_KEY, authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json()) as { code?: string } };
  };
  assert.deepEqual(
    [await put({ password: "attacker-choice-1" })].map((r) => [r.status, r.body.code]),
    [[400, "current_password_required"]],
  );
  assert.deepEqual(
    [await put({ password: "attacker-choice-1", current_password: "a-guess" })].map((r) => [r.status, r.body.code]),
    [[400, "current_password_mismatch"]],
  );
  assert.equal(fake.users.get(u.id)!.password, u.password, "the owner's password is untouched");
});
