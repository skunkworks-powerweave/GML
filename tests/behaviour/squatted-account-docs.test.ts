// README-deploy §2.2d's remedy for a squatted address, EXECUTED against the
// real profile trigger and the real key _post/003 installs.
//
// ── THE DEFECT (W3-70) ───────────────────────────────────────────────────────
//
// The section said: delete that user in Authentication → Users and create the
// account again. But the on_auth_user_created trigger writes a profile for
// every sign-up (the deactivated teacher the section describes), and
// public.users.id references auth.users ON DELETE RESTRICT, on purpose. So the
// dashboard's Delete user -- a DELETE on auth.users -- fails with "Database
// error deleting user", and an operator who is stuck is left with the one
// button the section warns against: Reactivate.
//
// ── HOW IT RUNS ──────────────────────────────────────────────────────────────
//
// On one connection, inside a transaction that is always rolled back. The test
// database has no auth.users (it is not Supabase), and seed-bootstrap.test.ts
// may be creating a stand-in of that name concurrently, so the login table here
// is a private stand-in with the columns the trigger reads; the trigger
// function and the key's ON DELETE RESTRICT are the ones _post/003 installs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { needsDatabase, withClient, tag } from "./_harness.js";

const skip = needsDatabase();
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** §2.2d: from its bold "d)" heading to the next one. */
function sectionD(): string {
  const md = readFileSync(resolve(root, "README-deploy.md"), "utf8");
  const start = md.indexOf("**d) ");
  const end = md.indexOf("**e) ", start);
  assert.ok(start >= 0 && end > start, "README-deploy §2.2d not found");
  return md.slice(start, end);
}

/** The statements of the section's SQL block, comments dropped. */
function documentedStatements(): string[] {
  const block = /```sql\n([\s\S]*?)```/.exec(sectionD());
  assert.ok(block, "§2.2d must give the SQL that removes the squatter's profile: the dashboard's Delete user alone fails");
  return block[1]!
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

test("README-deploy §2.2d: the squatted-account remedy works against the real trigger and key", { skip }, async () => {
  const statements = documentedStatements();
  const t = tag("w370").replace(/-/g, "_");
  const logins = `${t}.users`;
  await withClient(async (c) => {
    await c.query("BEGIN");
    try {
      await c.query(`CREATE SCHEMA ${t}`);
      await c.query(`CREATE TABLE ${logins} (id uuid PRIMARY KEY, email text, raw_user_meta_data jsonb)`);
      await c.query(
        `ALTER TABLE public.users ADD CONSTRAINT ${t}_fk FOREIGN KEY (id) REFERENCES ${logins}(id) ON DELETE RESTRICT NOT VALID`,
      );
      await c.query(
        `CREATE TRIGGER ${t}_created AFTER INSERT ON ${logins} FOR EACH ROW EXECUTE FUNCTION public.handle_new_auth_user()`,
      );

      // A stranger registers a staff address before the administrator does.
      const squatter = randomUUID();
      const address = `Staff.${t}@School.example`;
      await c.query(`INSERT INTO ${logins} (id, email, raw_user_meta_data) VALUES ($1, $2, '{}')`, [squatter, address]);
      const profile = await c.query(`SELECT role, active FROM public.users WHERE id = $1`, [squatter]);
      assert.deepEqual(profile.rows, [{ role: "teacher", active: false }], "the trigger wrote the deactivated profile");

      // Why the section cannot just say "Delete user".
      await c.query("SAVEPOINT dashboard");
      await assert.rejects(c.query(`DELETE FROM ${logins} WHERE id = $1`, [squatter]), /foreign key/);
      await c.query("ROLLBACK TO SAVEPOINT dashboard");

      // The documented statements, with the address filled in.
      const results = [];
      for (const s of statements) results.push(await c.query(s.replaceAll("<address>", address)));
      const deletes = results.filter((r) => r.command === "DELETE");
      assert.deepEqual(deletes.map((r) => r.rowCount), [1], "the documented delete removes exactly the squatter's profile");

      // Then Delete user in the dashboard goes through.
      assert.equal((await c.query(`DELETE FROM ${logins} WHERE id = $1`, [squatter])).rowCount, 1);

      // And the documented delete cannot remove an account that has been used.
      const used = randomUUID();
      const usedAddress = `used.${t}@school.example`;
      await c.query(`INSERT INTO ${logins} (id, email, raw_user_meta_data) VALUES ($1, $2, '{}')`, [used, usedAddress]);
      await c.query(`UPDATE public.users SET active = true WHERE id = $1`, [used]);
      for (const s of statements) {
        const r = await c.query(s.replaceAll("<address>", usedAddress));
        if (r.command === "DELETE") assert.equal(r.rowCount, 0, "a reactivated account is not deleted");
      }
    } finally {
      await c.query("ROLLBACK");
    }
  });
});

// ── A USED ACCOUNT THAT WAS DEACTIVATED AGAIN ────────────────────────────────
//
// `active = false and role = 'teacher'` alone cannot tell a squatter from a
// real teacher an administrator deactivated after the account was used: both
// show in /admin/users as a deactivated teacher, which is what an operator sees
// when a returning teacher's address fails with "already registered". And the
// delete never raises a foreign-key error -- every key onto public.users is
// CASCADE or SET NULL -- so without a stricter guard it returned DELETE 1 and
// took the teacher's progress, notifications and record links with it.
//
// A squatter never gets a token (the access-token hook refuses an inactive
// profile), so it has never signed in, and nobody linked it to a record.
test("README-deploy §2.2d: the documented delete leaves a used, deactivated account and its records alone", { skip }, async () => {
  const statements = documentedStatements();
  const t = tag("w370u").replace(/-/g, "_");
  await withClient(async (c) => {
    await c.query("BEGIN");
    try {
      const one = async (q: string, p: unknown[]) => (await c.query(q, p)).rows[0].id as string;
      const d = await one(`INSERT INTO districts (name, code) VALUES ($1, $2) RETURNING id`, [`D ${t}`, t.slice(-12)]);
      const z = await one(`INSERT INTO zones (district_id, name) VALUES ($1, 'z') RETURNING id`, [d]);
      const s = await one(`INSERT INTO schools (zone_id, name, code) VALUES ($1, 's', $2) RETURNING id`, [z, t.slice(-12)]);
      // Each is an inactive teacher profile, as the section's step 1 shows it.
      const profile = async (label: string, lastSeen: boolean) =>
        one(
          `INSERT INTO users (id, email, role, active, last_seen_at) VALUES ($1, $2, 'teacher', false, $3) RETURNING id`,
          [randomUUID(), `${label}.${t}@school.example`, lastSeen ? new Date() : null],
        );

      // Signed in, got a notification, then was deactivated.
      const used = await profile("used", true);
      await c.query(`INSERT INTO notifications (user_id, kind, subject) VALUES ($1, 'test', 'kept')`, [used]);
      // Created at /admin/users and linked to a teacher record, deactivated
      // before the first sign-in; likewise one linked to a mentor record.
      const linkedTeacher = await profile("linked-teacher", false);
      const teacher = await one(`INSERT INTO teachers (school_id, full_name, user_id) VALUES ($1, 'Kept', $2) RETURNING id`, [s, linkedTeacher]);
      const linkedMentor = await profile("linked-mentor", false);
      const mentor = await one(`INSERT INTO mentors (name, user_id) VALUES ('Kept', $1) RETURNING id`, [linkedMentor]);

      for (const [label, id] of [["used", used], ["linked-teacher", linkedTeacher], ["linked-mentor", linkedMentor]] as const) {
        const address = `${label}.${t}@school.example`;
        for (const st of statements) {
          const r = await c.query(st.replaceAll("<address>", address));
          if (r.command === "DELETE") assert.equal(r.rowCount, 0, `the documented delete removed the ${label} account: expect DELETE 0`);
        }
        assert.equal((await c.query(`SELECT 1 FROM users WHERE id = $1`, [id])).rowCount, 1, `the ${label} profile is still there`);
      }
      assert.equal(
        (await c.query(`SELECT 1 FROM notifications WHERE user_id = $1`, [used])).rowCount,
        1,
        "the used account's notification was not cascaded away",
      );
      assert.equal((await c.query(`SELECT user_id FROM teachers WHERE id = $1`, [teacher])).rows[0].user_id, linkedTeacher);
      assert.equal((await c.query(`SELECT user_id FROM mentors WHERE id = $1`, [mentor])).rows[0].user_id, linkedMentor);
    } finally {
      await c.query("ROLLBACK");
    }
  });
});
