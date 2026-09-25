// Signing out a password-changer's OTHER devices, EXECUTED: the real /settings
// and /login/reset actions against ./_fake_gotrue.ts, with GoTrue failing the
// POST /logout?scope=others they make.
//
// ── THE DEFECT (W3-67) ───────────────────────────────────────────────────────
//
// auth-js RETURNS a failed sign-out as {error}; it does not throw. /login/reset
// discarded the result and /settings hung a `.catch()` on it that could never
// fire, and both then wrote `otherSessionsEnded: true` as a constant -- the
// pattern F62 was (sessionsEnded: true for sessions that were all alive). The
// audit row and /settings' "You have been signed out on other devices" must
// say what happened. (GoTrue's own password update usually ends the other
// sessions anyway; the log still may not assert what nothing checked.)

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { resetRequest, form, outcome, closeAppDb } from "./_auth-harness.ts";
import { needsDatabase, DATABASE_URL, tag } from "./_harness.js";
import { fakeGoTrue, type FakeGoTrue, type Seen } from "./_fake_gotrue.ts";

const skip = needsDatabase();

const authModule = () => import("../../apps/web/src/auth.ts");
const settingsActions = () => import("../../apps/web/src/app/(authenticated)/settings/actions.ts");
const resetActions = () => import("../../apps/web/src/app/login/reset/actions.ts");
const serverClient = () => import("../../apps/web/src/lib/supabase/server.ts");

let pg: Client;
let fake: FakeGoTrue;
let restoreEnv: () => void;
const created: string[] = [];
const IP = `198.51.100.${Math.floor(Math.random() * 250) + 1}`;

before(async () => {
  if (skip) return;
  pg = new Client({ connectionString: DATABASE_URL });
  await pg.connect();
  fake = await fakeGoTrue();
  restoreEnv = fake.install();
});

after(async () => {
  if (skip) return;
  if (created.length) await pg.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [created]);
  restoreEnv();
  await fake.close();
  await pg.end();
  await closeAppDb();
});

async function makeUser() {
  const id = randomUUID();
  const email = `${tag("others")}@example.test`;
  const password = `pw-${randomUUID()}`;
  await pg.query("INSERT INTO users (id, email, name, role, active) VALUES ($1, $2, 'Others', 'teacher', true)", [id, email]);
  created.push(id);
  fake.addUser({ id, email, password });
  return { id, email, password };
}

/** The row's metadata. /settings writes it without awaiting, so wait a moment for it. */
async function auditMetadata(action: string, userId: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 40; i++) {
    const { rows } = await pg.query<{ metadata: Record<string, unknown> }>(
      "SELECT metadata FROM audit_log WHERE action = $1 AND entity_id = $2 ORDER BY created_at DESC LIMIT 1",
      [action, userId],
    );
    if (rows[0]) return rows[0].metadata;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`no ${action} row for ${userId}`);
}

/** GoTrue answers the sign-out of other sessions with a 500, for the duration of `body`. */
async function whileOthersSignOutFails<T>(body: () => Promise<T>): Promise<T> {
  fake.setFault((r: Seen) =>
    r.method === "POST" && r.path === "/logout" && r.query.get("scope") === "others"
      ? { status: 500, code: "unexpected_failure", message: "Database error ending sessions" }
      : null,
  );
  try {
    return await body();
  } finally {
    fake.setFault(null);
  }
}

test("W3-67: /settings does not claim other devices were signed out when that failed", { skip }, async () => {
  const u = await makeUser();
  resetRequest({ "x-real-ip": IP });
  const { signInWithPassword } = await authModule();
  assert.equal((await signInWithPassword(u.email, u.password)).error, null);
  const { changePasswordAction } = await settingsActions();
  const res = await whileOthersSignOutFails(() =>
    changePasswordAction(
      undefined,
      form({ currentPassword: u.password, newPassword: "a-new-one-for-me", confirmPassword: "a-new-one-for-me" }),
    ),
  );
  assert.ok(res.ok, `the password change itself succeeded and must be reported: ${JSON.stringify(res)}`);
  assert.equal(fake.users.get(u.id)!.password, "a-new-one-for-me");
  assert.doesNotMatch(res.ok ?? "", /You have been signed out on other devices/);
  assert.equal((await auditMetadata("auth.password.changed", u.id)).otherSessionsEnded, false);
});

test("W3-67: /settings records otherSessionsEnded: true when the sign-out worked", { skip }, async () => {
  const u = await makeUser();
  resetRequest({ "x-real-ip": IP });
  const { signInWithPassword } = await authModule();
  assert.equal((await signInWithPassword(u.email, u.password)).error, null);
  const phone = await fake.deviceSignIn(u.email, u.password);
  const { changePasswordAction } = await settingsActions();
  const res = await changePasswordAction(
    undefined,
    form({ currentPassword: u.password, newPassword: "a-new-one-for-me", confirmPassword: "a-new-one-for-me" }),
  );
  assert.match(res.ok ?? "", /signed out on other devices/);
  assert.equal((await fake.deviceRefresh(String(phone.body.refresh_token))).status, 400, "the phone's session ended");
  assert.equal((await auditMetadata("auth.password.changed", u.id)).otherSessionsEnded, true);
});

test("W3-67: a recovery-link reset does not record other sessions ended when that failed", { skip }, async () => {
  const u = await makeUser();
  resetRequest({ "x-real-ip": IP });
  const { createSupabaseServerClient } = await serverClient();
  const sb = await createSupabaseServerClient();
  assert.equal((await sb.auth.verifyOtp({ type: "recovery", token_hash: fake.issueOtp(u.id, "recovery") })).error, null);
  const { resetPasswordAction } = await resetActions();
  const res = await whileOthersSignOutFails(() =>
    outcome(() => resetPasswordAction(undefined, form({ password: "reset-by-me-1", confirm: "reset-by-me-1" }))),
  );
  assert.deepEqual(res, { kind: "redirect", location: "/dashboard" }, "the reset itself succeeded");
  assert.equal((await auditMetadata("auth.password.reset_completed", u.id)).otherSessionsEnded, false);
});
