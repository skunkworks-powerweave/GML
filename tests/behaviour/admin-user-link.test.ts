// A login is linked to at most one teacher or mentor record, and linking never
// steals a record that is already someone's.
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
//
// createUserAction's "Link to" ran
//     UPDATE teachers SET user_id = <new> WHERE id = <linkId>
// with no check that user_id was still NULL, and nothing else enforced it:
// no unique index on teachers.user_id or mentors.user_id. The dropdown is
// rendered once per page load, so two admins onboarding the same roster (or
// one admin in two tabs) re-pointed a record linked moments earlier: the
// original teacher lost her whole programme (teacherIdFor -> null: empty
// dashboard, 404 on her own cycles) and the new account inherited her cycles,
// videos and mentorship, with no error and no audit of the unlink. The same
// gap let a CSV or grid edit link two teacher rows to one login, after which
// teacherIdFor's LIMIT 1 picked one arbitrarily.
//
// The link step is executed on a rolled-back transaction, together with the
// index; then createUserAction itself, with Supabase Auth stubbed, loses the
// race and must undo the account it made.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { request, stubSupabaseServer } from "./_ui.js";
import { needsDatabase, withClient, tag } from "./_harness.js";
import { actAs, fixture, form } from "./_admin-fixture.js";

const skip = needsDatabase();
const linkModule = () => import("../../apps/web/src/app/(authenticated)/admin/users/link.ts");

test("linking an account claims only a record nobody has claimed", { skip }, async () => {
  const { linkAccountToRecord } = await linkModule();
  await withClient(async (c) => {
    const t = tag("link");
    await c.query("BEGIN");
    try {
      const one = async (q: string, p: unknown[]) => (await c.query(q, p)).rows[0].id as string;
      const d = await one(`INSERT INTO districts (name, code) VALUES ($1, $2) RETURNING id`, [`D ${t}`, t.slice(-12)]);
      const z = await one(`INSERT INTO zones (district_id, name) VALUES ($1, 'z') RETURNING id`, [d]);
      const s = await one(`INSERT INTO schools (zone_id, name, code) VALUES ($1, 's', $2) RETURNING id`, [z, t.slice(-12)]);
      const user = async (label: string) =>
        one(`INSERT INTO users (id, email, role) VALUES ($1, $2, 'teacher') RETURNING id`, [randomUUID(), `${label}.${t}@example.test`]);
      const first = await user("first");
      const second = await user("second");
      const teacher = await one(`INSERT INTO teachers (school_id, full_name, user_id) VALUES ($1, 'Linked', $2) RETURNING id`, [s, first]);
      const free = await one(`INSERT INTO teachers (school_id, full_name) VALUES ($1, 'Free') RETURNING id`, [s]);
      const db = drizzle(c);

      assert.equal(await linkAccountToRecord(db as never, "teacher", teacher, second), false, "an already-linked teacher was re-pointed");
      const { rows: [still] } = await c.query(`SELECT user_id FROM teachers WHERE id = $1`, [teacher]);
      assert.equal(still.user_id, first, "the original account keeps its teacher record");

      assert.equal(await linkAccountToRecord(db as never, "teacher", free, second), true);
      const { rows: [now] } = await c.query(`SELECT user_id FROM teachers WHERE id = $1`, [free]);
      assert.equal(now.user_id, second);
    } finally {
      await c.query("ROLLBACK");
    }
  });
});

test("the database refuses a second teacher or mentor record on one login", { skip }, async () => {
  await withClient(async (c) => {
    const t = tag("link-uq");
    await c.query("BEGIN");
    try {
      const one = async (q: string, p: unknown[]) => (await c.query(q, p)).rows[0].id as string;
      const d = await one(`INSERT INTO districts (name, code) VALUES ($1, $2) RETURNING id`, [`D ${t}`, t.slice(-12)]);
      const z = await one(`INSERT INTO zones (district_id, name) VALUES ($1, 'z') RETURNING id`, [d]);
      const s = await one(`INSERT INTO schools (zone_id, name, code) VALUES ($1, 's', $2) RETURNING id`, [z, t.slice(-12)]);
      const u = await one(`INSERT INTO users (id, email, role) VALUES ($1, $2, 'teacher') RETURNING id`, [randomUUID(), `u.${t}@example.test`]);
      await c.query(`INSERT INTO teachers (school_id, full_name, user_id) VALUES ($1, 'A', $2)`, [s, u]);
      await c.query("SAVEPOINT t2");
      await assert.rejects(
        c.query(`INSERT INTO teachers (school_id, full_name, user_id) VALUES ($1, 'B', $2)`, [s, u]),
        /duplicate key|unique/i,
      );
      await c.query("ROLLBACK TO SAVEPOINT t2");
      // Unlinked roster rows (user_id NULL) are unaffected.
      await c.query(`INSERT INTO teachers (school_id, full_name) VALUES ($1, 'C'), ($1, 'D')`, [s]);
      await c.query(`INSERT INTO mentors (name, user_id) VALUES ('M1', $1)`, [u]);
      await assert.rejects(c.query(`INSERT INTO mentors (name, user_id) VALUES ('M2', $1)`, [u]), /duplicate key|unique/i);
    } finally {
      await c.query("ROLLBACK");
    }
  });
});

// ── THE ACTION, NOT ONLY ITS LINK STEP ───────────────────────────────────────
//
// The compare-and-set above only matters if createUserAction uses it and
// undoes the account it has just made when it loses. Supabase is stubbed
// (stubSupabaseServer, ../_ui.ts): the fake records what the action asks
// Supabase Auth to do, and nothing leaves the machine.
test("createUserAction refuses a record linked meanwhile, and removes the account it made", { skip }, async () => {
  stubSupabaseServer();
  const { createUserAction } = await import("../../apps/web/src/app/(authenticated)/admin/users/actions.ts");
  await withClient(async (c) => {
    const t = tag("link-race");
    const f = fixture(c, t);
    try {
      const district = await f.row("districts", { name: `D ${t}`, code: t.slice(-12) });
      const zone = await f.row("zones", { district_id: district, name: `Z ${t}` });
      const school = await f.row("schools", { zone_id: zone, name: `S ${t}`, code: t.slice(-12) });
      const first = await f.user("teacher", "first");
      // Linked by another admin after this admin's form was rendered.
      const teacher = await f.row("teachers", { school_id: school, full_name: `Tsering ${t}`, user_id: first });
      actAs(await f.user("programme_admin", "padmin"), "programme_admin");

      const newId = randomUUID();
      f.defer(`DELETE FROM users WHERE id = $1`, [newId]);
      const calls: string[] = [];
      request.supabaseAdmin = {
        auth: {
          admin: {
            createUser: async (o: { email: string }) => {
              calls.push(`createUser ${o.email}`);
              return { data: { user: { id: newId } }, error: null };
            },
            deleteUser: async (id: string) => {
              calls.push(`deleteUser ${id}`);
              return { data: {}, error: null };
            },
          },
        },
      };

      const email = `second.${t}@example.test`;
      const r = await createUserAction(
        undefined,
        form({ email, name: "Second", role: "teacher", password: "long enough", linkKind: "teacher", linkId: teacher }),
      );
      assert.match(r.error ?? "", /already linked/, JSON.stringify(r));
      const { rows: [still] } = await c.query(`SELECT user_id FROM teachers WHERE id = $1`, [teacher]);
      assert.equal(still.user_id, first, "the new login took over a teacher record another login holds");
      const { rows: profile } = await c.query(`SELECT 1 FROM users WHERE id = $1`, [newId]);
      assert.equal(profile.length, 0, "the new profile row must be removed");
      assert.deepEqual(calls, [`createUser ${email}`, `deleteUser ${newId}`], "and its Supabase account deleted");
    } finally {
      await f.cleanup();
    }
  });
});

// ── W3-67: THE ROLLBACK ITSELF CAN FAIL ──────────────────────────────────────
//
// auth-js RETURNS a failed deleteUser as {error}; it does not throw. Both
// rollbacks hung `.catch(() => undefined)` on it, which could never fire, so a
// failed delete still told the administrator "Nothing was created" -- leaving
// a login with the password they chose and no row in /admin/users to fix it
// from. And the generic path deleted the login WITHOUT first deleting the
// profile the on_auth_user_created trigger always writes, which public.users'
// ON DELETE RESTRICT key to auth.users (_post/003) refuses on Supabase: that
// rollback could never succeed, and nothing said so.
//
// This test database has no auth schema, so the key is modelled by the stub:
// its deleteUser answers GoTrue's "Database error deleting user" while a
// profile row still exists, as the real one does.

/** Supabase Auth stubbed as GoTrue on Supabase behaves, recording each call. */
function stubAuth(c: import("pg").Client, newId: string, calls: string[], deleteFails = false): void {
  request.supabaseAdmin = {
    auth: {
      admin: {
        createUser: async (o: { email: string }) => {
          calls.push(`createUser ${o.email}`);
          return { data: { user: { id: newId } }, error: null };
        },
        deleteUser: async (id: string) => {
          calls.push(`deleteUser ${id}`);
          const { rows } = await c.query(`SELECT 1 FROM users WHERE id = $1`, [id]);
          if (deleteFails || rows.length > 0) {
            return { data: { user: null }, error: { name: "AuthApiError", status: 500, message: "Database error deleting user" } };
          }
          return { data: { user: null }, error: null };
        },
      },
    },
  };
}

test("W3-67: a failed rollback of a raced account is reported, not called 'Nothing was created'", { skip }, async () => {
  stubSupabaseServer();
  const { createUserAction } = await import("../../apps/web/src/app/(authenticated)/admin/users/actions.ts");
  await withClient(async (c) => {
    const t = tag("link-rb");
    const f = fixture(c, t);
    try {
      const district = await f.row("districts", { name: `D ${t}`, code: t.slice(-12) });
      const zone = await f.row("zones", { district_id: district, name: `Z ${t}` });
      const school = await f.row("schools", { zone_id: zone, name: `S ${t}`, code: t.slice(-12) });
      const first = await f.user("teacher", "first");
      const teacher = await f.row("teachers", { school_id: school, full_name: `Dolma ${t}`, user_id: first });
      actAs(await f.user("programme_admin", "padmin"), "programme_admin");
      const newId = randomUUID();
      f.defer(`DELETE FROM users WHERE id = $1`, [newId]);
      const calls: string[] = [];
      stubAuth(c, newId, calls, true);

      const email = `second.${t}@example.test`;
      const r = await createUserAction(
        undefined,
        form({ email, name: "Second", role: "teacher", password: "long enough", linkKind: "teacher", linkId: teacher }),
      );
      assert.match(r.error ?? "", /already linked/, JSON.stringify(r));
      assert.doesNotMatch(r.error ?? "", /Nothing was created/, "a login was left behind");
      assert.ok((r.error ?? "").includes(`${email} could not be removed`), r.error);
    } finally {
      await f.cleanup();
    }
  });
});

test("W3-67: a profile step that fails removes the profile before the login, so the rollback can succeed", { skip }, async () => {
  stubSupabaseServer();
  const { createUserAction } = await import("../../apps/web/src/app/(authenticated)/admin/users/actions.ts");
  await withClient(async (c) => {
    const t = tag("link-gen");
    const f = fixture(c, t);
    try {
      actAs(await f.user("super_admin", "sadmin"), "super_admin");
      const newId = randomUUID();
      f.defer(`DELETE FROM users WHERE id = $1`, [newId]);
      const calls: string[] = [];
      stubAuth(c, newId, calls);

      // The upsert succeeds (the account is promoted to an active mentor) and
      // the link step then fails: a malformed record id is a database error.
      const email = `gen.${t}@example.test`;
      const r = await createUserAction(
        undefined,
        form({ email, name: "Gen", role: "mentor", password: "long enough", linkKind: "mentor", linkId: "not-a-uuid" }),
      );
      assert.match(r.error ?? "", /Could not set up the profile/, JSON.stringify(r));
      const { rows: profile } = await c.query(`SELECT role, active FROM users WHERE id = $1`, [newId]);
      assert.deepEqual(profile, [], "no active account with the administrator's password may be left behind");
      assert.deepEqual(calls, [`createUser ${email}`, `deleteUser ${newId}`]);
      assert.match(r.error ?? "", /Nothing was created/);
    } finally {
      await f.cleanup();
    }
  });
});

test("W3-67: when the profile cannot be removed either, the administrator is told where the account is", { skip }, async () => {
  stubSupabaseServer();
  const { createUserAction } = await import("../../apps/web/src/app/(authenticated)/admin/users/actions.ts");
  const { withRowFault } = await import("./_fake_gotrue.ts");
  await withClient(async (c) => {
    const t = tag("link-gen2");
    const f = fixture(c, t);
    try {
      actAs(await f.user("super_admin", "sadmin"), "super_admin");
      const newId = randomUUID();
      f.defer(`DELETE FROM users WHERE id = $1`, [newId]);
      const calls: string[] = [];
      stubAuth(c, newId, calls);

      const email = `gen2.${t}@example.test`;
      const r = await withRowFault(c, "public.users", "DELETE", `OLD.id = '${newId}'::uuid`, () =>
        createUserAction(
          undefined,
          form({ email, name: "Gen", role: "mentor", password: "long enough", linkKind: "mentor", linkId: "not-a-uuid" }),
        ),
      );
      assert.doesNotMatch(r.error ?? "", /Nothing was created/, JSON.stringify(r));
      assert.match(r.error ?? "", /still listed/, r.error);
      assert.deepEqual(calls, [`createUser ${email}`], "the login cannot go while its profile remains");
    } finally {
      await f.cleanup();
    }
  });
});
