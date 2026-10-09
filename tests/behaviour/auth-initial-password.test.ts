// Initial passwords and the password policy, EXECUTED: the real admin actions,
// settings and reset actions, and proxy.ts, against ./_fake_gotrue.ts.
//
// ── THE DEFECT (F86) ─────────────────────────────────────────────────────────
//
// Accounts are onboarded with a password an administrator chose, typed and
// handed over; nothing ever required the holder to change it. createUserAction
// ends with "they can change it in Settings" -- and nothing checked that they
// did, so accounts ran indefinitely on a credential someone else knows. The
// policy itself was four separate copies of a length constant, with no upper
// bound (GoTrue refuses more than 72 characters, so an over-long password
// passed the app's check and failed at Supabase with a raw message).
//
// GoTrue's own minimum (6) and its strength and leaked-password checks are
// dashboard settings; README-deploy §2.2 has them. What the app enforces: one
// policy at every entry point, and a must-change flag on any password an
// administrator sets, carried in app_metadata -- which only the service role
// can write, and which rides in the access token -- until the holder chooses
// their own.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { React, request, resetRequest, form, outcome, closeAppDb, renderSync, webRequire } from "./_auth-harness.ts";
import { needsDatabase, DATABASE_URL, tag } from "./_harness.js";
import { fakeGoTrue, ensureAuthSessionsTable, type FakeGoTrue } from "./_fake_gotrue.ts";

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
  const email = `${tag("initial")}@example.test`;
  const password = `pw-${randomUUID()}`;
  await pg.query("INSERT INTO users (id, email, name, role, active) VALUES ($1, $2, 'Initial', $3::role, true)", [id, email, role]);
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

test("an account an administrator creates must change its password before using the site", { skip }, async () => {
  const actor = await makeUser("super_admin");
  await signInThroughApp(actor.email, actor.password);
  const email = `${tag("new")}@example.test`;
  createdEmails.push(email);
  const initial = "handed-over-1";
  const { createUserAction } = await adminActions();
  const res = await createUserAction(undefined, form({ email, name: "New Teacher", role: "teacher", password: initial }));
  assert.ok(res.ok, JSON.stringify(res));
  assert.equal(fakeUserByEmail(email)?.appMetadata.must_change_password, true, "the initial password must be marked for change");

  await signInThroughApp(email, initial);
  assert.equal(await proxyRedirect("/dashboard"), "/settings?password=required", "every page sends them to Settings first");
  assert.equal(await proxyRedirect("/observation/123"), "/settings?password=required");
  // The teaching-records sections too: a login made by approving an account
  // request carries the same flag, and /teaching and /attendance had no proxy
  // rule, so the redirect never ran there.
  for (const path of ["/teaching", "/teaching/sessions", "/attendance", "/approvals"]) {
    assert.equal(await proxyRedirect(path), "/settings?password=required", `${path} sends them to Settings first`);
  }
  assert.equal(await proxyRedirect("/settings?password=required"), null, "Settings itself stays reachable");

  // Settings says why they are there, whatever the URL. Straight after sign-in
  // the proxy's redirect happens inside a client navigation, which renders
  // /settings under the /dashboard URL without ?password=required, so a new
  // user saw a plain Settings page and no reason (UAT, 2026-09-27).
  const { auth } = await authModule();
  assert.equal((await auth())?.user.mustChangePassword, true, "the session says a change is required");
  const { default: SettingsPage } = await import("../../apps/web/src/app/(authenticated)/settings/page.tsx");
  const { AppRouterContext } = webRequire("next/dist/shared/lib/app-router-context.shared-runtime") as {
    AppRouterContext: import("react").Context<unknown>;
  };
  const router = { back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {} };
  const html = renderSync(React.createElement(AppRouterContext.Provider, { value: router }, await SettingsPage()));
  assert.match(html, /data-testid="password-change-required"/, "the notice shows without ?password=required");
  assert.match(html, /name="newPassword"/, "and the form is already open");

  // Choosing their own password lifts it, in the session they are already in.
  const { changePasswordAction } = await settingsActions();
  const changed = await changePasswordAction(
    undefined,
    form({ currentPassword: initial, newPassword: "my-own-choice-1", confirmPassword: "my-own-choice-1" }),
  );
  assert.ok(changed.ok, JSON.stringify(changed));
  assert.equal(changed.continueToDashboard, true, "the form goes on to the dashboard (QA, 9 Oct 2026)");
  assert.equal(fakeUserByEmail(email)?.appMetadata.must_change_password, undefined, "the flag is cleared");
  assert.equal(await proxyRedirect("/dashboard"), null, "and this browser's session no longer carries it");
  assert.equal((await auth())?.user.mustChangePassword, false);
});

test("an administrator setting someone's password requires them to change it again", { skip }, async () => {
  const actor = await makeUser("super_admin");
  const target = await makeUser("mentor");
  await signInThroughApp(actor.email, actor.password);
  const { setPasswordAction } = await adminActions();
  const res = await setPasswordAction(undefined, form({ userId: target.id, password: "set-by-admin-1" }));
  assert.ok(res.ok, JSON.stringify(res));
  assert.equal(fake.users.get(target.id)!.appMetadata.must_change_password, true);
});

test("setting a password from a recovery link counts as choosing your own", { skip }, async () => {
  const u = await makeUser("teacher");
  fake.users.get(u.id)!.appMetadata.must_change_password = true;
  resetRequest({ "x-real-ip": IP });
  const { createSupabaseServerClient } = await serverClient();
  const sb = await createSupabaseServerClient();
  assert.equal((await sb.auth.verifyOtp({ type: "recovery", token_hash: fake.issueOtp(u.id, "recovery") })).error, null);
  const { resetPasswordAction } = await resetActions();
  const res = await outcome(() => resetPasswordAction(undefined, form({ password: "chosen-by-me-1", confirm: "chosen-by-me-1" })));
  assert.deepEqual(res, { kind: "redirect", location: "/dashboard" });
  assert.equal(fake.users.get(u.id)!.appMetadata.must_change_password, undefined);
  assert.equal(await proxyRedirect("/dashboard"), null);
});

test("one password policy at every entry point: at least 8 characters, at most 72 bytes", { skip }, async () => {
  const actor = await makeUser("super_admin");
  const target = await makeUser("teacher");
  const tooLong = "é".repeat(37); // 37 characters, 74 bytes
  for (const bad of ["seven77", tooLong]) {
    await signInThroughApp(actor.email, actor.password);
    const { createUserAction, setPasswordAction } = await adminActions();
    const created = await createUserAction(undefined, form({ email: `${tag("p")}@example.test`, role: "teacher", password: bad }));
    assert.ok(created.error, `createUserAction accepted ${JSON.stringify(bad)}`);
    const set = await setPasswordAction(undefined, form({ userId: target.id, password: bad }));
    assert.ok(set.error, `setPasswordAction accepted ${JSON.stringify(bad)}`);

    const { changePasswordAction } = await settingsActions();
    const changed = await changePasswordAction(undefined, form({ currentPassword: actor.password, newPassword: bad, confirmPassword: bad }));
    assert.ok(changed.error, `changePasswordAction accepted ${JSON.stringify(bad)}`);

    const { resetPasswordAction } = await resetActions();
    const reset = await outcome(() => resetPasswordAction(undefined, form({ password: bad, confirm: bad })));
    assert.equal(reset.kind, "returned");
    assert.ok((reset as { value: { error?: string } }).value.error, `resetPasswordAction accepted ${JSON.stringify(bad)}`);
  }
  assert.equal(fake.users.get(target.id)!.password, target.password, "no bad password reached GoTrue");
});
