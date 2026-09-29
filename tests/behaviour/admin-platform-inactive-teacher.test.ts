// A teacher whose teacher record is deactivated is locked out like an
// inactive account.
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
//
// A teacher is deactivated on her teachers row (the data tables' Active), not
// on her login. Nothing read that row when she signed in or used the app: the
// access-token hook checks public.users only, and auth() re-reads nothing for
// a teacher. So a deactivated teacher kept signing in and kept every page.
//
// ── WHAT MUST HOLD ───────────────────────────────────────────────────────────
//
//   - sign-in with the correct password is refused with the existing
//     "inactive" code (and message), and leaves no session behind;
//   - a session she already holds stops working at once: auth() is null;
//   - reactivating the record lets her back in;
//   - a teacher account with no teachers row, and every other role (even
//     with an inactive teachers row), is unaffected.
//
// Executed: the real apps/web/src/auth.ts and login action against
// ./_fake_gotrue.ts, whose access-token hook reads public.users as _post/004's
// does, and the test database.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { resetRequest, form, closeAppDb } from "./_auth-harness.ts";
import { needsDatabase, DATABASE_URL, tag } from "./_harness.js";
import { fakeGoTrue, ensureAuthSessionsTable, type FakeGoTrue } from "./_fake_gotrue.ts";

const skip = needsDatabase();

const authModule = () => import("../../apps/web/src/auth.ts");
const loginActions = () => import("../../apps/web/src/app/login/actions.ts");

let pg: Client;
let fake: FakeGoTrue;
let restoreEnv: () => void;
let school: string;
const users: string[] = [];
const cleanup: Array<[string, unknown[]]> = [];
const IP = `198.19.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

before(async () => {
  if (skip) return;
  pg = new Client({ connectionString: DATABASE_URL });
  await pg.connect();
  await ensureAuthSessionsTable(pg);
  fake = await fakeGoTrue({
    sessionTable: pg,
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
  const t = tag("ap-inactive");
  const code = t.replace(/[^a-z0-9]/gi, "").slice(-10).toUpperCase();
  const one = async (sql: string, params: unknown[]) => (await pg.query(sql, params)).rows[0].id as string;
  const district = await one(`INSERT INTO districts (name, code) VALUES ($1, $2) RETURNING id`, [`D ${t}`, `D${code}`]);
  const zone = await one(`INSERT INTO zones (district_id, name) VALUES ($1, $2) RETURNING id`, [district, `Z ${t}`]);
  school = await one(`INSERT INTO schools (zone_id, name, code) VALUES ($1, $2, $3) RETURNING id`, [zone, `S ${t}`, `S${code}`.slice(0, 16)]);
  cleanup.push([`DELETE FROM teachers WHERE school_id = $1`, [school]]);
  cleanup.push([`DELETE FROM schools WHERE id = $1`, [school]]);
  cleanup.push([`DELETE FROM zones WHERE id = $1`, [zone]]);
  cleanup.push([`DELETE FROM districts WHERE id = $1`, [district]]);
});

after(async () => {
  if (skip) return;
  for (const [sql, params] of cleanup) await pg.query(sql, params).catch(() => undefined);
  if (users.length) {
    await pg.query("DELETE FROM auth.sessions WHERE user_id = ANY($1::uuid[])", [users]);
    await pg.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [users]);
  }
  restoreEnv();
  await fake.close();
  await pg.end();
  await closeAppDb();
});

/** An account of `role`, and optionally a teachers row linked to it. */
async function person(role: string, teacherRow: "active" | "inactive" | "none") {
  const id = randomUUID();
  const email = `${tag("inactive")}@example.test`;
  const password = `pw-${randomUUID()}`;
  await pg.query("INSERT INTO users (id, email, name, role, active) VALUES ($1, $2, $3, $4::role, true)", [id, email, `P ${role}`, role]);
  users.push(id);
  fake.addUser({ id, email, password });
  if (teacherRow !== "none") {
    await pg.query("INSERT INTO teachers (school_id, full_name, user_id, active) VALUES ($1, $2, $3, $4)", [
      school,
      `Teacher ${email}`,
      id,
      teacherRow === "active",
    ]);
  }
  return { id, email, password };
}

const setTeacherActive = (userId: string, active: boolean) =>
  pg.query("UPDATE teachers SET active = $2 WHERE user_id = $1", [userId, active]);

/** A fresh browser signs in through the app; the session (if any) lands in its cookie jar. */
async function signIn(u: { email: string; password: string }) {
  resetRequest({ "x-real-ip": IP });
  const { signInWithPassword } = await authModule();
  return signInWithPassword(u.email, u.password);
}

test("a teacher whose teacher record is inactive cannot sign in, and is left with no session", { skip }, async () => {
  const u = await person("teacher", "inactive");
  const r = await signIn(u);
  assert.equal(r.error, "inactive", "the existing 'inactive' refusal");
  const { auth } = await authModule();
  assert.equal(await auth(), null, "no session in this browser");
  assert.deepEqual(await fake.sessionsOf(u.id), [], "the session the correct password created was ended");

  // Through the login form: the same code (login.error.inactive), audited as a refused sign-in.
  resetRequest({ "x-real-ip": IP });
  const { loginAction } = await loginActions();
  const state = await loginAction(undefined, form({ email: u.email, password: u.password, from: "" }));
  assert.deepEqual(state, { error: "inactive" });
  const { rows } = await pg.query(
    `SELECT metadata->>'reason' AS reason FROM audit_log WHERE action = 'auth.sign_in_failed' AND created_at > now() - interval '1 minute' ORDER BY created_at DESC LIMIT 5`,
  );
  assert.ok(rows.some((x) => x.reason === "inactive"), "auth.sign_in_failed with reason inactive");
});

test("deactivating her teacher record ends a session she already holds; reactivating lets her back", { skip }, async () => {
  const u = await person("teacher", "active");
  assert.equal((await signIn(u)).error, null);
  const { auth } = await authModule();
  assert.equal((await auth())?.user.id, u.id);

  await setTeacherActive(u.id, false);
  assert.equal(await auth(), null, "the same cookies, the same unexpired token: no longer a session");
  assert.equal((await signIn(u)).error, "inactive");

  await setTeacherActive(u.id, true);
  assert.equal((await signIn(u)).error, null);
  assert.equal((await auth())?.user.role, "teacher");
});

test("a teacher account with no teacher record, and other roles, are not affected", { skip }, async () => {
  const { auth } = await authModule();
  const unlinked = await person("teacher", "none");
  assert.equal((await signIn(unlinked)).error, null);
  assert.equal((await auth())?.user.id, unlinked.id);

  // A mentor account that (by some old link) has an inactive teachers row.
  const mentor = await person("mentor", "inactive");
  assert.equal((await signIn(mentor)).error, null);
  assert.equal((await auth())?.user.role, "mentor");

  // An administrator with one: the teacher record says nothing about her admin account.
  const admin = await person("programme_admin", "inactive");
  assert.equal((await signIn(admin)).error, null);
  assert.equal((await auth())?.user.role, "programme_admin");

  // And a wrong password is still the plain refusal, not "inactive".
  const locked = await person("teacher", "inactive");
  assert.equal((await signIn({ email: locked.email, password: "not-it" })).error, "invalid_credentials");
});
