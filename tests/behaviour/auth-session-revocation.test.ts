// Ending a user's sessions from /admin/users, EXECUTED.
//
// ── THE DEFECT (F62) ─────────────────────────────────────────────────────────
//
// Demoting, deactivating and re-passwording an account all called
//
//     supabaseAdmin().auth.admin.signOut(targetId, "global").catch(() => undefined)
//
// auth-js's signature is signOut(JWT, scope): the first argument is sent to
// POST /logout as the bearer token. A user id is not a JWT, so GoTrue answered
// 403 bad_jwt every time; auth-js RETURNS that as {error} rather than throwing,
// so the .catch never fired, and the audit row recorded sessionsEnded:true for
// sessions that were all still alive. Consequences, reproduced live by the
// audit: a demoted programme_admin kept administering (and created a new
// account with their old cookie); a deactivated account's sessions came back
// to life the moment it was reactivated.
//
// And separately: every guard trusts the user_role claim of a LOCALLY verified
// access token, so even a working revocation left a demoted administrator with
// full powers until that token expired.
//
// These tests run the real admin actions and the real auth() against
// ./_fake_gotrue.ts, whose sessions are rows in auth.sessions of the test
// database -- where GoTrue keeps them -- and whose access-token hook reads
// public.users there, as _post/004's does.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { request, resetRequest, form, closeAppDb } from "./_auth-harness.ts";
import { needsDatabase, DATABASE_URL, tag } from "./_harness.js";
import { fakeGoTrue, ensureAuthSessionsTable, withRowFault, type FakeGoTrue, type Seen } from "./_fake_gotrue.ts";

const skip = needsDatabase();

const authModule = () => import("../../apps/web/src/auth.ts");
const adminActions = () => import("../../apps/web/src/app/(authenticated)/admin/users/actions.ts");

let pg: Client;
let fake: FakeGoTrue;
let restoreEnv: () => void;
const created: string[] = [];
// One client address per run, so the sign-in throttle's per-address window is
// never shared with an earlier run of this file.
const IP = `198.18.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

before(async () => {
  if (skip) return;
  pg = new Client({ connectionString: DATABASE_URL });
  await pg.connect();
  await ensureAuthSessionsTable(pg);
  fake = await fakeGoTrue({
    sessionTable: pg,
    // What _post/004's hook does: re-read the profile on every mint.
    hook: async (id) => {
      const { rows } = await pg.query<{ role: string; active: boolean; deleted_at: Date | null; name: string | null }>(
        "SELECT role, active, deleted_at, name FROM users WHERE id = $1",
        [id],
      );
      const p = rows[0];
      if (!p) return { error: { http_code: 403, message: "No LMS profile for this account." } };
      if (!p.active || p.deleted_at) return { error: { http_code: 403, message: "This account is not active." } };
      return { role: p.role, name: p.name };
    },
  });
  restoreEnv = fake.install();
});

after(async () => {
  if (skip) return;
  if (created.length) await pg.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [created]);
  await pg.query("DELETE FROM auth.sessions WHERE user_id = ANY($1::uuid[])", [created]);
  restoreEnv();
  await fake.close();
  await pg.end();
  await closeAppDb();
});

async function makeUser(role: string, active = true) {
  const id = randomUUID();
  const email = `${tag("revoke")}@example.test`;
  const password = `pw-${randomUUID()}`;
  await pg.query("INSERT INTO users (id, email, name, role, active) VALUES ($1, $2, $3, $4::role, $5)", [
    id,
    email,
    `Revoke ${role}`,
    role,
    active,
  ]);
  created.push(id);
  fake.addUser({ id, email, password });
  return { id, email, password };
}

/** Sign in through the app, in a fresh browser; the session lands in the cookie jar. */
async function signInThroughApp(u: { email: string; password: string }) {
  resetRequest({ "x-real-ip": IP });
  const { signInWithPassword } = await authModule();
  const r = await signInWithPassword(u.email, u.password);
  assert.equal(r.error, null, `sign-in as ${u.email} failed: ${String(r.error)}`);
}

async function auditMetadata(action: string, entityId: string): Promise<Record<string, unknown>> {
  const { rows } = await pg.query<{ metadata: Record<string, unknown> }>(
    "SELECT metadata FROM audit_log WHERE action = $1 AND entity_id = $2 ORDER BY created_at DESC LIMIT 1",
    [action, entityId],
  );
  assert.ok(rows[0], `expected an ${action} audit row for ${entityId}`);
  return rows[0]!.metadata;
}

test("demoting an administrator ends every session they hold, and the audit row says so truthfully", { skip }, async () => {
  const actor = await makeUser("super_admin");
  const target = await makeUser("programme_admin");
  const phone = await fake.deviceSignIn(target.email, target.password);
  const laptop = await fake.deviceSignIn(target.email, target.password);
  assert.equal(phone.status, 200);
  assert.equal((await fake.sessionsOf(target.id)).length, 2);

  await signInThroughApp(actor);
  const { setRoleAction } = await adminActions();
  const res = await setRoleAction(undefined, form({ userId: target.id, role: "teacher" }));
  assert.ok(res.ok, `setRoleAction refused: ${JSON.stringify(res)}`);

  assert.deepEqual(
    await fake.sessionsOf(target.id),
    [],
    "a demotion must end the demoted user's sessions on every device",
  );
  for (const device of [phone, laptop]) {
    const refreshed = await fake.deviceRefresh(String(device.body.refresh_token));
    assert.equal(refreshed.status, 400, "a refresh token issued before the demotion must no longer work");
  }
  const meta = await auditMetadata("admin.user.role_change", target.id);
  assert.equal(meta.sessionsEnded, true);
  assert.equal(meta.sessionsEndedCount, 2, "the audit row records how many sessions were ended");
});

test("a demoted administrator's unexpired access token no longer carries admin authority", { skip }, async () => {
  const target = await makeUser("programme_admin");
  await signInThroughApp(target);
  const { auth } = await authModule();
  assert.equal((await auth())?.user.role, "programme_admin");

  // What setRoleAction writes. The access token in the cookie jar still says
  // programme_admin and verifies locally for up to one token lifetime.
  await pg.query("UPDATE users SET role = 'teacher' WHERE id = $1", [target.id]);
  const after = await auth();
  assert.equal(
    after?.user.role,
    "teacher",
    "an administrative role claim must be confirmed against public.users: a demoted admin " +
      "otherwise keeps /admin/users (and can mint a replacement super_admin) until the token expires",
  );

  // Deactivated or soft-deleted: no session at all.
  await pg.query("UPDATE users SET role = 'super_admin', active = false WHERE id = $1", [target.id]);
  assert.equal(await auth(), null, "a deactivated administrator must not keep an admin session");
});

test("deactivation ends every session, and reactivation does not bring them back", { skip }, async () => {
  const actor = await makeUser("super_admin");
  const target = await makeUser("teacher");
  const phone = await fake.deviceSignIn(target.email, target.password);
  assert.equal(phone.status, 200);

  await signInThroughApp(actor);
  const { setActiveAction } = await adminActions();
  const off = await setActiveAction(undefined, form({ userId: target.id, active: "false" }));
  assert.ok(off.ok, JSON.stringify(off));
  assert.deepEqual(await fake.sessionsOf(target.id), [], "deactivation must end the user's sessions");

  const on = await setActiveAction(undefined, form({ userId: target.id, active: "true" }));
  assert.ok(on.ok, JSON.stringify(on));
  const revived = await fake.deviceRefresh(String(phone.body.refresh_token));
  assert.equal(
    revived.status,
    400,
    "a session from before the deactivation must stay dead after reactivation (a lost phone, an attacker's browser)",
  );
  const meta = await auditMetadata("admin.user.deactivate", target.id);
  assert.equal(meta.sessionsEnded, true);
  assert.equal(meta.banApplied, true, "the audit row records that sign-in was blocked");
  assert.equal((await auditMetadata("admin.user.activate", target.id)).banLifted, true);
});

test("when sessions cannot be ended, the administrator and the audit log are told so", { skip }, async () => {
  const actor = await makeUser("super_admin");
  const target = await makeUser("programme_admin");
  await fake.deviceSignIn(target.email, target.password);
  await signInThroughApp(actor);
  const { setRoleAction } = await adminActions();

  // Deleting THIS user's sessions fails for the duration of the call.
  const res = await withRowFault(pg, "auth.sessions", "DELETE", `OLD.user_id = '${target.id}'::uuid`, () =>
    setRoleAction(undefined, form({ userId: target.id, role: "mentor" })),
  );
  assert.ok(res.ok, "the role change itself committed and must be reported");
  assert.match(res.ok ?? "", /sessions could not be ended/i, `the message must not claim sessions ended: ${res.ok}`);
  const meta = await auditMetadata("admin.user.role_change", target.id);
  assert.equal(meta.sessionsEnded, false, "the audit row must not record a revocation that did not happen");
});

// The ban is the third layer of a deactivation, and lifting it is what lets a
// reactivated account sign in. Both calls RETURN their error (auth-js does
// not throw), and both were followed by `.catch(() => undefined)` -- the
// pattern that hid F62's failed revocation -- so a failed unban still said
// "Account reactivated." to an administrator whose colleague could not sign in.
test("a sign-in ban that cannot be applied or lifted is reported, not swallowed", { skip }, async () => {
  const actor = await makeUser("super_admin");
  const target = await makeUser("teacher");
  await signInThroughApp(actor);
  const { setActiveAction } = await adminActions();
  const failBan = (lifting: boolean) => (r: Seen) =>
    r.method === "PUT" &&
    r.path === `/admin/users/${target.id}` &&
    typeof r.body.ban_duration === "string" &&
    (r.body.ban_duration === "none") === lifting
      ? { status: 500, code: "unexpected_failure", message: "Database error updating user" }
      : null;

  fake.setFault(failBan(false));
  let off: Awaited<ReturnType<typeof setActiveAction>>;
  try {
    off = await setActiveAction(undefined, form({ userId: target.id, active: "false" }));
  } finally {
    fake.setFault(null);
  }
  assert.equal(fake.users.get(target.id)!.bannedUntil, null, "precondition: the ban really was not applied");
  assert.ok(off.ok, `the deactivation itself committed and must be reported: ${JSON.stringify(off)}`);
  assert.match(off.ok ?? "", /did not block their sign-in/i, `the message must say the ban failed: ${off.ok}`);
  assert.equal((await auditMetadata("admin.user.deactivate", target.id)).banApplied, false);

  // Deactivated properly this time, so there is a ban to lift.
  assert.ok((await setActiveAction(undefined, form({ userId: target.id, active: "false" }))).ok);
  assert.notEqual(fake.users.get(target.id)!.bannedUntil, null);

  fake.setFault(failBan(true));
  let on: Awaited<ReturnType<typeof setActiveAction>>;
  try {
    on = await setActiveAction(undefined, form({ userId: target.id, active: "true" }));
  } finally {
    fake.setFault(null);
  }
  assert.notEqual(fake.users.get(target.id)!.bannedUntil, null, "precondition: the ban really is still on");
  assert.ok(on.ok, JSON.stringify(on));
  assert.match(
    on.ok ?? "",
    /still blocks their sign-in/i,
    `a reactivated account that still cannot sign in must not be reported as plainly reactivated: ${on.ok}`,
  );
  assert.equal((await auditMetadata("admin.user.activate", target.id)).banLifted, false);
});

test("setting a password ends the user's sessions and records it", { skip }, async () => {
  const actor = await makeUser("super_admin");
  const target = await makeUser("mentor");
  await fake.deviceSignIn(target.email, target.password);
  await signInThroughApp(actor);
  const { setPasswordAction } = await adminActions();
  const res = await setPasswordAction(undefined, form({ userId: target.id, password: "a-new-password-1" }));
  assert.ok(res.ok, JSON.stringify(res));
  assert.deepEqual(await fake.sessionsOf(target.id), []);
  const meta = await auditMetadata("admin.user.password_set", target.id);
  assert.equal(meta.sessionsEnded, true);
  // Nothing about the admin call path should have reached GoTrue's /logout
  // with a user id as the bearer.
  assert.ok(
    fake.calls("POST", "/logout").every((c) => c.auth?.split(".").length === 3),
    "no request may present a non-JWT bearer to /logout",
  );
  void request;
});
