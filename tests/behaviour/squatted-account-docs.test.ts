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
