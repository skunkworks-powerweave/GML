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
// createUserAction itself needs Supabase Auth to run; the link step it calls
// is executed here, on a rolled-back transaction, together with the index.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import "./_ui.js";
import { needsDatabase, withClient, tag } from "./_harness.js";

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
