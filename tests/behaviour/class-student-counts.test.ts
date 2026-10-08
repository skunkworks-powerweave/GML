// A class's student count is the number of students it really has.
//
// ── THE DEFECT ─────────────────────────────────────────────────────────────
//
// classes.students_count was a number an administrator typed. Students added
// afterwards, one at a time in the grid, by CSV, or by a teacher on her own
// screen, never moved it, so /repo/class/<id> and the class table on
// /repo/school/<id> said "0 students" and "View learners (0)" above a roster
// of six. (Found in the 5 Oct 2026 QA of the admin and teacher flows.)
//
// ── THE FIX ────────────────────────────────────────────────────────────────
//
// A trigger on learners (_post/015) keeps classes.students_count equal to the
// number of ACTIVE learners in the class, for every writer: grid, CSV,
// teacher screens, seeds, a hand-run SQL fix. These tests execute each of
// those writes against Postgres.

import { test } from "node:test";
import assert from "node:assert/strict";
import "./_ui.js";
import { needsDatabase, withClient, tag } from "./_harness.js";
import { actAs, fixture, form, type Fixture } from "./_admin-fixture.js";

const skip = needsDatabase();
const csvModule = () => import("../../apps/web/src/app/(authenticated)/admin/data/[entity]/csv.ts");
const actions = () =>
  import("../../apps/web/src/app/(authenticated)/admin/data/[entity]/actions.ts");

/** A school with two classes, each carrying a hand-typed count of 99. */
async function world(f: Fixture, t: string) {
  const district = await f.row("districts", { name: `D ${t}`, code: t.slice(-12) });
  const zone = await f.row("zones", { district_id: district, name: `Z ${t}` });
  const school = await f.row("schools", { zone_id: zone, name: `S ${t}`, code: t.slice(-12) });
  const a = await f.row("classes", { school_id: school, grade: 5, stage: "Primary", students_count: 99 });
  const b = await f.row("classes", { school_id: school, grade: 6, stage: "Primary", students_count: 99 });
  return { school, a, b };
}

const count = async (f: Fixture, classId: string): Promise<number> =>
  (await f.c.query(`SELECT students_count AS n FROM classes WHERE id = $1`, [classId])).rows[0].n as number;

test("the count follows every kind of write to learners", { skip }, async () => {
  await withClient(async (c) => {
    const t = tag("cls-count");
    const f = fixture(c, t);
    try {
      const w = await world(f, t);
      const add = (classId: string, name: string, active = true) =>
        f.row("learners", { class_id: classId, school_id: w.school, grade: 5, name: `${name} ${t}`, active });

      assert.equal(await count(f, w.a), 99, "a class with no students keeps what an administrator typed until a student is written");

      const one = await add(w.a, "One");
      const two = await add(w.a, "Two");
      await add(w.a, "Three");
      await add(w.a, "Left", false);
      assert.equal(await count(f, w.a), 3, "four rows inserted, one inactive: the three active ones are the class");

      await c.query(`UPDATE learners SET active = false WHERE id = $1`, [one]);
      assert.equal(await count(f, w.a), 2, "deactivating a student (a teacher removing one) lowers the count");

      await c.query(`UPDATE learners SET active = true WHERE id = $1`, [one]);
      assert.equal(await count(f, w.a), 3, "reactivating raises it again");

      await c.query(`UPDATE learners SET class_id = $2 WHERE id = $1`, [two, w.b]);
      assert.equal(await count(f, w.a), 2, "a student moved out of a class leaves its count");
      assert.equal(await count(f, w.b), 1, "and joins the other class's");

      await c.query(`UPDATE learners SET name = $2 WHERE id = $1`, [one, `Renamed ${t}`]);
      assert.equal(await count(f, w.a), 2, "a rename changes nothing");

      await c.query(`DELETE FROM learners WHERE id = $1`, [one]);
      assert.equal(await count(f, w.a), 1, "deleting a student lowers the count");
    } finally {
      await f.cleanup();
    }
  });
});

test("students added through the grid and through a CSV file move the count too", { skip }, async () => {
  const { importCsv } = await csvModule();
  const { createRowAction } = await actions();
  await withClient(async (c) => {
    const t = tag("cls-count-ui");
    const f = fixture(c, t);
    try {
      const w = await world(f, t);
      f.defer(`DELETE FROM learners WHERE class_id IN ($1, $2)`, [w.a, w.b]);
      actAs(await f.user("super_admin", "sadmin"), "super_admin");

      const row = (name: string, roll: string) => `${w.a},${w.school},5,${name} ${t},${roll}`;
      const r = await importCsv(
        "learners",
        ["classId,schoolId,grade,name,rollNumber", row("Csv One", "1"), row("Csv Two", "2"), row("Csv Three", "3")].join("\n"),
      );
      assert.equal(r.inserted, 3, JSON.stringify(r));
      assert.equal(await count(f, w.a), 3, "three students imported by CSV, and the class says three");

      const made = await createRowAction(
        undefined,
        form({ entitySlug: "learners", classId: w.a, schoolId: w.school, grade: "5", name: `Grid ${t}`, rollNumber: "4", active: "true" }),
      );
      assert.equal(made.ok, true, JSON.stringify(made));
      assert.equal(await count(f, w.a), 4, "one more added in the grid");
    } finally {
      await f.cleanup();
    }
  });
});

test("the count is not a form field any more: a typed number would be overwritten by the next student", { skip }, async () => {
  const { importCsv } = await csvModule();
  await withClient(async (c) => {
    const t = tag("cls-count-field");
    const f = fixture(c, t);
    try {
      const w = await world(f, t);
      f.defer(`DELETE FROM learners WHERE class_id IN ($1, $2)`, [w.a, w.b]);
      actAs(await f.user("super_admin", "sadmin"), "super_admin");
      const r = await importCsv("classes", `id,studentsCount\n${w.a},5`);
      assert.equal(await count(f, w.a), 99, "the class kept its number");
    } finally {
      await f.cleanup();
    }
  });
});
