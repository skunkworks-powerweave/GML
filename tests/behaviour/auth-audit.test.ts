// Authentication events in the audit log, and users.last_seen_at, EXECUTED:
// the real login, sign-out, reset and email-link code against
// ./_fake_gotrue.ts, writing to the test database's real audit_log.
//
// ── THE DEFECT (F88) ─────────────────────────────────────────────────────────
//
// The audit log is a hard requirement, yet sign-in, failed sign-in, sign-out
// and a recovery-link password reset wrote nothing: there was no recordAudit
// anywhere in auth.ts, app/login/** or app/auth/**. The last_seen_at bump lived
// in the removed Auth.js signIn callback and had no replacement, so
// /admin/users said "never signed in" for every account -- to administrators
// deciding whether to offboard a dormant account or investigating a compromise.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Client } from "pg";
import { resetRequest, outcome, form, closeAppDb, webRequire } from "./_auth-harness.ts";
import { needsDatabase, DATABASE_URL, tag } from "./_harness.js";
import { fakeGoTrue, type FakeGoTrue } from "./_fake_gotrue.ts";

const skip = needsDatabase();

const loginActions = () => import("../../apps/web/src/app/login/actions.ts");
const authModule = () => import("../../apps/web/src/auth.ts");
const resetActions = () => import("../../apps/web/src/app/login/reset/actions.ts");
const serverClient = () => import("../../apps/web/src/lib/supabase/server.ts");
const confirmRoute = () => import("../../apps/web/src/app/auth/confirm/route.ts");

let pg: Client;
let fake: FakeGoTrue;
let restoreEnv: () => void;
const created: string[] = [];
const ip = () => `192.0.2.${Math.floor(Math.random() * 250) + 1}`;

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
  const email = `${tag("audit")}@example.test`;
  const password = `pw-${randomUUID()}`;
  await pg.query("INSERT INTO users (id, email, name, role, active) VALUES ($1, $2, 'Audit', 'teacher', true)", [id, email]);
  created.push(id);
  fake.addUser({ id, email, password });
  return { id, email, password };
}

async function rows(action: string, where: string, params: unknown[]) {
  const { rows } = await pg.query<{ user_id: string | null; ip: string | null; metadata: Record<string, unknown> }>(
    `SELECT user_id, ip, metadata FROM audit_log WHERE action = $1 AND ${where} ORDER BY created_at`,
    [action, ...params],
  );
  return rows;
}

const emailHash = (email: string) => createHash("sha256").update(email).digest("hex").slice(0, 16);

test("a sign-in is audited and stamps last_seen_at", { skip }, async () => {
  const u = await makeUser();
  resetRequest({ "x-real-ip": ip() });
  const { loginAction } = await loginActions();
  const res = await outcome(() => loginAction(undefined, form({ email: u.email, password: u.password, from: "" })));
  assert.equal(res.kind, "redirect");

  const signIns = await rows("auth.sign_in", "user_id = $2", [u.id]);
  assert.equal(signIns.length, 1, "one auth.sign_in row for the user");
  assert.equal(signIns[0]!.metadata.method, "password");
  assert.match(String(signIns[0]!.ip), /\.x$/, "the address is stored masked");
  const { rows: seen } = await pg.query<{ last_seen_at: Date | null }>("SELECT last_seen_at FROM users WHERE id = $1", [u.id]);
  assert.ok(seen[0]?.last_seen_at, "/admin/users must stop saying 'never signed in'");
});

test("a failed sign-in is audited by a hash of the address, never the address itself", { skip }, async () => {
  const u = await makeUser();
  resetRequest({ "x-real-ip": ip() });
  const { loginAction } = await loginActions();
  await loginAction(undefined, form({ email: u.email, password: "not-the-password", from: "" }));
  const failed = await rows("auth.sign_in_failed", "metadata->>'emailHash' = $2", [emailHash(u.email)]);
  assert.equal(failed.length, 1);
  assert.equal(failed[0]!.metadata.reason, "invalid_credentials");
  assert.equal(failed[0]!.user_id, null, "no account is looked up for a failure (that would be an oracle)");
  assert.doesNotMatch(JSON.stringify(failed[0]), new RegExp(u.email.replace(/[.]/g, "\\.")));
});

// W3-04. A failed signInWithPassword leaves the browser's existing session
// cookie alone, and recordAudit fell back to auth() for a row with no userId,
// so on a shared school computer someone left signed in (A) was credited with
// every failed attempt a colleague then made against their own account (B).
test("a failed sign-in in a browser someone else is signed in on is not credited to them", { skip }, async () => {
  const a = await makeUser();
  const b = await makeUser();
  resetRequest({ "x-real-ip": ip() });
  const { loginAction } = await loginActions();
  const { auth } = await authModule();
  const first = await outcome(() => loginAction(undefined, form({ email: a.email, password: a.password, from: "" })));
  assert.equal(first.kind, "redirect");
  assert.equal((await auth())?.user?.id, a.id, "precondition: A's session is in the jar");

  // Same browser, no resetRequest: B types their own address and a wrong password.
  await loginAction(undefined, form({ email: b.email, password: "not-the-password", from: "" }));
  const failed = await rows("auth.sign_in_failed", "metadata->>'emailHash' = $2", [emailHash(b.email)]);
  assert.equal(failed.length, 1);
  assert.equal(failed[0]!.user_id, null, "the leftover session is not the actor of a failed sign-in");
});

test("throttled attempts are not audited: the log must not be a flood an attacker can fill", { skip }, async () => {
  const u = await makeUser();
  const addr = ip();
  const { loginAction } = await loginActions();
  for (let i = 0; i < 13; i++) {
    resetRequest({ "x-real-ip": addr });
    await loginAction(undefined, form({ email: u.email, password: `guess-${i}`, from: "" }));
  }
  const failed = await rows("auth.sign_in_failed", "metadata->>'emailHash' = $2", [emailHash(u.email)]);
  assert.equal(failed.length, 10, "only the attempts that reached the credential check are recorded");
});

test("signing out is audited", { skip }, async () => {
  const u = await makeUser();
  resetRequest({ "x-real-ip": ip() });
  const { signInWithPassword, signOut } = await authModule();
  assert.equal((await signInWithPassword(u.email, u.password)).error, null);
  const res = await outcome(() => signOut({ redirectTo: "/login" }));
  assert.deepEqual(res, { kind: "redirect", location: "/login" });
  assert.equal((await rows("auth.sign_out", "user_id = $2", [u.id])).length, 1);
});

test("a recovery-link reset and an email-link sign-in are audited", { skip }, async () => {
  const u = await makeUser();
  resetRequest({ "x-real-ip": ip() });
  const { NextRequest } = webRequire("next/server") as typeof import("next/server");
  const { GET } = await confirmRoute();
  const hash = fake.issueOtp(u.id, "recovery");
  await GET(new NextRequest(`http://0.0.0.0:3000/auth/confirm?token_hash=${hash}&type=recovery&next=%2Flogin%2Freset`));
  const viaLink = await rows("auth.sign_in", "user_id = $2", [u.id]);
  assert.equal(viaLink.length, 1);
  assert.equal(viaLink[0]!.metadata.method, "recovery_link");

  const { resetPasswordAction } = await resetActions();
  const res = await outcome(() => resetPasswordAction(undefined, form({ password: "reset-by-me-1", confirm: "reset-by-me-1" })));
  assert.equal(res.kind, "redirect");
  assert.equal((await rows("auth.password.reset_completed", "user_id = $2", [u.id])).length, 1);
  void serverClient;
});
