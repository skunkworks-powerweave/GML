// A student's school and grade agree with her class.
//
// ── THE DEFECT ─────────────────────────────────────────────────────────────
//
// The grid's Add row and Edit, and the CSV import, took a student's classId,
// schoolId and grade as three unrelated answers. A student could be saved at
// one school in another school's class, or as a Grade 9 in a Grade 5 class, and
// then showed up in the wrong school's reports and on the wrong class page.
// (Found in the 5 Oct 2026 QA of the admin flows.)
//
// ── THE RULE ───────────────────────────────────────────────────────────────
//
// Given a class, a blank school and a blank grade are filled from it; a school
// or grade that differs from the class's is refused, in the user's language,
// naming both. The same rule holds for every writer: the grid (create and
// update), the CSV import (new rows, and updates by id that carry only some
// columns, which are judged against the row's stored school and grade), and the
// teacher's own add-student screen. A trigger on learners (_post/016) holds it
// for anything else -- a seed, SQL run by hand -- and judges only a write that
// sets or changes the class, school or grade, so a student stored before the
// rule can still be edited for anything else.
//
// Executed against Postgres through the real server actions and importCsv.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { needsDatabase, withClient, tag } from "./_harness.js";
import { fixture, form, type Fixture } from "./_admin-fixture.js";
import { closeAppDb, signIn } from "./_server-actions.js";
import { request } from "./_ui.js";

const skip = needsDatabase();
after(async () => {
  if (!skip) await closeAppDb();
});

const csvModule = () => import("../../apps/web/src/app/(authenticated)/admin/data/[entity]/csv.ts");
const gridActions = () => import("../../apps/web/src/app/(authenticated)/admin/data/[entity]/actions.ts");
const studentActions = () => import("../../apps/web/src/app/(authenticated)/teaching/students/actions.ts");

type World = {
  t: string;
  schoolA: string;
  schoolB: string;
  nameA: string;
  nameB: string;
  /** Grade 5 and Grade 6 at school A, Grade 5 at school B. */
  a5: string;
  a6: string;
  b5: string;
  /** How a CSV cell names a class, as the grid's drop-down shows it. */
  label: (school: "A" | "B", grade: number) => string;
};

async function world(f: Fixture, t: string): Promise<World> {
  const code = t.replace(/[^a-z0-9]/gi, "").slice(-8).toUpperCase();
  const district = await f.row("districts", { name: `D ${t}`, code: t.slice(-12) });
  const zone = await f.row("zones", { district_id: district, name: `Z ${t}` });
  const nameA = `Alpha ${t}`;
  const nameB = `Beta ${t}`;
  const schoolA = await f.row("schools", { zone_id: zone, name: nameA, code: `A${code}` });
  const schoolB = await f.row("schools", { zone_id: zone, name: nameB, code: `B${code}` });
  const a5 = await f.row("classes", { school_id: schoolA, grade: 5, stage: "Primary" });
  const a6 = await f.row("classes", { school_id: schoolA, grade: 6, stage: "Primary" });
  const b5 = await f.row("classes", { school_id: schoolB, grade: 5, stage: "Primary" });
  // Before the classes go (defers run last-registered first).
  f.defer(`DELETE FROM learners WHERE class_id = ANY($1)`, [[a5, a6, b5]]);
  const names = { A: nameA, B: nameB };
  return { t, schoolA, schoolB, nameA, nameB, a5, a6, b5, label: (s, g) => `${names[s]} · Grade ${g}` };
}

const asSuperAdmin = async (f: Fixture) => {
  signIn({ id: await f.user("super_admin", "sadmin"), role: "super_admin", name: null, email: null });
};

const stored = async (f: Fixture, id: string) =>
  (await f.c.query(`SELECT class_id, school_id, grade FROM learners WHERE id = $1`, [id])).rows[0] as {
    class_id: string;
    school_id: string;
    grade: number;
  };

const countNamed = async (f: Fixture, name: string): Promise<number> =>
  (await f.c.query(`SELECT count(*)::int AS n FROM learners WHERE name = $1`, [name])).rows[0].n as number;

test("the grid's Add row fills a blank school and grade from the class", { skip }, async () => {
  const { createRowAction } = await gridActions();
  await withClient(async (c) => {
    const t = tag("lfit-add-fill");
    const f = fixture(c, t);
    try {
      const w = await world(f, t);
      await asSuperAdmin(f);
      const add = (name: string, fields: Record<string, string>) =>
        createRowAction(undefined, form({ entitySlug: "learners", active: "true", classId: w.a6, name: `${name} ${t}`, ...fields }));
      const idOf = async (name: string) =>
        (await c.query(`SELECT id FROM learners WHERE name = $1`, [`${name} ${t}`])).rows[0].id as string;

      const both = await add("Both", { schoolId: "", grade: "" });
      assert.equal(both?.ok, true, JSON.stringify(both));
      assert.deepEqual(await stored(f, await idOf("Both")), { class_id: w.a6, school_id: w.schoolA, grade: 6 });

      const onlySchool = await add("OnlySchool", { schoolId: w.schoolA, grade: "" });
      assert.equal(onlySchool?.ok, true, JSON.stringify(onlySchool));
      assert.equal((await stored(f, await idOf("OnlySchool"))).grade, 6, "a blank grade is the class's");

      const onlyGrade = await add("OnlyGrade", { schoolId: "", grade: "6" });
      assert.equal(onlyGrade?.ok, true, JSON.stringify(onlyGrade));
      assert.equal((await stored(f, await idOf("OnlyGrade"))).school_id, w.schoolA, "a blank school is the class's");

      const agreeing = await add("Agreeing", { schoolId: w.schoolA, grade: "6" });
      assert.equal(agreeing?.ok, true, "values that agree with the class are saved as they are");
    } finally {
      await f.cleanup();
    }
  });
});

test("the grid's Add row refuses a school or grade that contradicts the class, naming both, in the user's language", { skip }, async () => {
  const { createRowAction } = await gridActions();
  await withClient(async (c) => {
    const t = tag("lfit-add-bad");
    const f = fixture(c, t);
    try {
      const w = await world(f, t);
      await asSuperAdmin(f);
      const add = (name: string, fields: Record<string, string>) =>
        createRowAction(undefined, form({ entitySlug: "learners", active: "true", classId: w.a5, name: `${name} ${t}`, ...fields }));

      const wrongSchool = await add("WrongSchool", { schoolId: w.schoolB, grade: "5" });
      assert.equal(wrongSchool?.ok, false);
      assert.match(wrongSchool?.fieldErrors?.schoolId ?? "", new RegExp(`${w.nameB}`), "names the school she was given");
      assert.match(wrongSchool?.fieldErrors?.schoolId ?? "", new RegExp(`${w.nameA}`), "and the class's school");
      assert.match(wrongSchool?.error ?? "", /^schoolId: /, "the summary says which field");
      assert.equal(wrongSchool?.fieldErrors?.grade, undefined, "the grade was right");
      assert.equal(await countNamed(f, `WrongSchool ${t}`), 0, "nothing was saved");

      const wrongGrade = await add("WrongGrade", { schoolId: w.schoolA, grade: "9" });
      assert.equal(wrongGrade?.ok, false);
      assert.match(wrongGrade?.fieldErrors?.grade ?? "", /9/);
      assert.match(wrongGrade?.fieldErrors?.grade ?? "", /5/);
      assert.equal(await countNamed(f, `WrongGrade ${t}`), 0);

      const both = await add("Both", { schoolId: w.schoolB, grade: "9" });
      assert.deepEqual(Object.keys(both?.fieldErrors ?? {}).sort(), ["grade", "schoolId"], "each wrong field is marked");

      // Blank is only a way to say "the class's": a class that does not exist
      // leaves nothing to fill from, and says so on the class.
      const nowhere = "99999999-9999-4999-8999-999999999999";
      const noClass = await createRowAction(
        undefined,
        form({ entitySlug: "learners", active: "true", classId: nowhere, name: `NoClass ${t}`, schoolId: "", grade: "" }),
      );
      assert.equal(noClass?.ok, false);
      assert.ok(noClass?.fieldErrors?.classId, JSON.stringify(noClass));

      request.locale = "hi";
      try {
        const hindi = await add("WrongSchoolHi", { schoolId: w.schoolB, grade: "5" });
        const text = hindi?.fieldErrors?.schoolId ?? "";
        assert.match(text, /[ऀ-ॿ]/, `in Hindi: ${text}`);
        assert.ok(text.includes(w.nameA) && text.includes(w.nameB), "both schools are named in Hindi too");
      } finally {
        request.locale = "en";
      }
    } finally {
      await f.cleanup();
    }
  });
});

test("the grid's Edit keeps school and grade with the class, and an old inconsistent row can still be edited for anything else", { skip }, async () => {
  const { updateRowAction } = await gridActions();
  await withClient(async (c) => {
    const t = tag("lfit-edit");
    const f = fixture(c, t);
    try {
      const w = await world(f, t);
      await asSuperAdmin(f);
      const kid = await f.row("learners", { class_id: w.a5, school_id: w.schoolA, grade: 5, name: `Kid ${t}`, guardian: "Old" });
      const save = (fields: Record<string, string>) =>
        updateRowAction(
          undefined,
          form({ entitySlug: "learners", rowId: kid, active: "true", name: `Kid ${t}`, classId: w.a5, schoolId: w.schoolA, grade: "5", ...fields }),
        );

      // Moved to Grade 6 with the old grade still in the form: refused.
      const stale = await save({ classId: w.a6, grade: "5" });
      assert.equal(stale?.ok, false, JSON.stringify(stale));
      assert.match(stale?.fieldErrors?.grade ?? "", /6/);
      assert.match(stale?.fieldErrors?.grade ?? "", /5/);
      assert.deepEqual(await stored(f, kid), { class_id: w.a5, school_id: w.schoolA, grade: 5 }, "the refusal changed nothing");

      // The grade left blank is the new class's.
      const blankGrade = await save({ classId: w.a6, grade: "" });
      assert.equal(blankGrade?.ok, true, JSON.stringify(blankGrade));
      assert.deepEqual(await stored(f, kid), { class_id: w.a6, school_id: w.schoolA, grade: 6 });

      // Another school's class, with the old school in the form: refused; the
      // school left blank is the class's.
      const elsewhere = await save({ classId: w.b5, schoolId: w.schoolA, grade: "5" });
      assert.equal(elsewhere?.ok, false);
      assert.ok(elsewhere?.fieldErrors?.schoolId?.includes(w.nameA) && elsewhere.fieldErrors.schoolId.includes(w.nameB));
      const moved = await save({ classId: w.b5, schoolId: "", grade: "5" });
      assert.equal(moved?.ok, true, JSON.stringify(moved));
      assert.deepEqual(await stored(f, kid), { class_id: w.b5, school_id: w.schoolB, grade: 5 });

      // A student stored before the rule: her class's grade was changed after
      // she was added. Editing her guardian re-posts the same class, school
      // and grade, and is not refused; changing her grade to another wrong one
      // is, and a blank grade puts it right.
      await c.query(`UPDATE classes SET grade = 8 WHERE id = $1`, [w.b5]);
      const old = { classId: w.b5, schoolId: w.schoolB, grade: "5" };
      const guardian = await save({ ...old, guardian: "New" });
      assert.equal(guardian?.ok, true, `an unrelated edit of an old row: ${JSON.stringify(guardian)}`);
      assert.equal((await c.query(`SELECT guardian FROM learners WHERE id = $1`, [kid])).rows[0].guardian, "New");
      const stillWrong = await save({ ...old, grade: "9" });
      assert.equal(stillWrong?.ok, false);
      assert.match(stillWrong?.fieldErrors?.grade ?? "", /8/);
      const mended = await save({ ...old, grade: "" });
      assert.equal(mended?.ok, true, JSON.stringify(mended));
      assert.equal((await stored(f, kid)).grade, 8);
    } finally {
      await f.cleanup();
    }
  });
});

test("a CSV adds students: blanks are filled, contradictions are refused on their own line, the rest land", { skip }, async () => {
  const { importCsv } = await csvModule();
  await withClient(async (c) => {
    const t = tag("lfit-csv-add");
    const f = fixture(c, t);
    try {
      const w = await world(f, t);
      await asSuperAdmin(f);
      const r = await importCsv(
        "learners",
        [
          "classId,schoolId,grade,name,rollNumber",
          `${w.label("A", 5)},,,Filled ${t},1`, // line 2: school and grade from the class
          `${w.label("A", 5)},${w.nameB},5,WrongSchool ${t},2`, // line 3
          `${w.label("A", 5)},${w.nameA},9,WrongGrade ${t},3`, // line 4
          `${w.label("A", 6)},${w.schoolA},,OnlyGrade ${t},4`, // line 5: grade from the class
          `${w.label("B", 5)},${w.nameB},5,Agrees ${t},5`, // line 6
        ].join("\n"),
      );
      assert.equal(r.inserted, 3, JSON.stringify(r));
      assert.deepEqual(r.errors.map((e) => e.row), [3, 4], JSON.stringify(r.errors));
      const [school, grade] = r.errors.map((e) => e.message);
      assert.ok(school!.includes(w.nameA) && school!.includes(w.nameB), school);
      assert.match(school!, /schoolId/);
      assert.ok(/9/.test(grade!) && /5/.test(grade!), grade);
      assert.match(grade!, /grade/);
      assert.equal(await countNamed(f, `WrongSchool ${t}`) + (await countNamed(f, `WrongGrade ${t}`)), 0);

      const row = async (name: string) =>
        (await c.query(`SELECT school_id, grade FROM learners WHERE name = $1`, [`${name} ${t}`])).rows[0];
      assert.deepEqual(await row("Filled"), { school_id: w.schoolA, grade: 5 });
      assert.deepEqual(await row("OnlyGrade"), { school_id: w.schoolA, grade: 6 });
      assert.deepEqual(await row("Agrees"), { school_id: w.schoolB, grade: 5 });

      // A file with no school or grade column at all is the plainest roster.
      const plain = await importCsv("learners", ["classId,name", `${w.label("B", 5)},Plain ${t}`].join("\n"));
      assert.equal(plain.inserted, 1, JSON.stringify(plain));
      assert.deepEqual(await row("Plain"), { school_id: w.schoolB, grade: 5 });
    } finally {
      await f.cleanup();
    }
  });
});

test("a CSV update with only some columns is judged against the row's stored school and grade", { skip }, async () => {
  const { importCsv } = await csvModule();
  await withClient(async (c) => {
    const t = tag("lfit-csv-upd");
    const f = fixture(c, t);
    try {
      const w = await world(f, t);
      await asSuperAdmin(f);
      const kid = await f.row("learners", { class_id: w.a5, school_id: w.schoolA, grade: 5, name: `Mover ${t}` });
      const only = async (csv: string) => importCsv("learners", csv);

      // Only the class, and it is at another school: the stored school differs.
      const school = await only(`id,classId\n${kid},${w.label("B", 5)}`);
      assert.equal(school.updated, 0, JSON.stringify(school));
      assert.equal(school.errors[0]?.row, 2);
      assert.ok(school.errors[0]!.message.includes(w.nameA) && school.errors[0]!.message.includes(w.nameB), school.errors[0]!.message);
      // Only the class, and it is another grade: the stored grade differs.
      const grade = await only(`id,classId\n${kid},${w.label("A", 6)}`);
      assert.equal(grade.updated, 0, JSON.stringify(grade));
      assert.match(grade.errors[0]!.message, /grade/);
      assert.deepEqual(await stored(f, kid), { class_id: w.a5, school_id: w.schoolA, grade: 5 }, "refused rows change nothing");

      // The file says the new grade too: saved, and the class is found by name.
      const moved = await only(`id,classId,grade\n${kid},${w.label("A", 6)},6`);
      assert.equal(moved.updated, 1, JSON.stringify(moved));
      assert.deepEqual(await stored(f, kid), { class_id: w.a6, school_id: w.schoolA, grade: 6 });

      // School and grade both given for another school's class.
      const other = await only(`id,classId,schoolId,grade\n${kid},${w.label("B", 5)},${w.nameB},5`);
      assert.equal(other.updated, 1, JSON.stringify(other));
      assert.deepEqual(await stored(f, kid), { class_id: w.b5, school_id: w.schoolB, grade: 5 });

      // A blank cell in a column the file carries is "the class's".
      const blank = await only(`id,classId,schoolId,grade\n${kid},${w.label("A", 6)},,`);
      assert.equal(blank.updated, 1, JSON.stringify(blank));
      assert.deepEqual(await stored(f, kid), { class_id: w.a6, school_id: w.schoolA, grade: 6 });

      // A student stored before the rule keeps her unrelated edits; a grade
      // that is still wrong is refused.
      await c.query(`UPDATE classes SET grade = 8 WHERE id = $1`, [w.a6]);
      const guardian = await only(`id,guardian\n${kid},Pema`);
      assert.equal(guardian.updated, 1, `an unrelated edit of an old row: ${JSON.stringify(guardian)}`);
      const wrong = await only(`id,grade\n${kid},9`);
      assert.equal(wrong.updated, 0);
      assert.match(wrong.errors[0]!.message, /8/);
      const right = await only(`id,grade\n${kid},8`);
      assert.equal(right.updated, 1, JSON.stringify(right));
    } finally {
      await f.cleanup();
    }
  });
});

test("a teacher adding a student gets the class's school and grade", { skip }, async () => {
  const { addStudentAction } = await studentActions();
  await withClient(async (c) => {
    const t = tag("lfit-teacher");
    const f = fixture(c, t);
    try {
      const w = await world(f, t);
      const login = await f.user("teacher", "tch");
      const teacher = await f.row("teachers", { school_id: w.schoolA, full_name: `Teacher ${t}`, user_id: login });
      const link = await f.row("teacher_classes", { teacher_id: teacher, class_id: w.a6 });
      signIn({ id: login, role: "teacher", name: null, email: null });
      const r = await addStudentAction(undefined, form({ linkId: link, name: `Tashi ${t}` }));
      assert.equal(r?.error, undefined, JSON.stringify(r));
      const [row] = (await c.query(`SELECT school_id, grade FROM learners WHERE class_id = $1 AND name = $2`, [w.a6, `Tashi ${t}`])).rows;
      assert.deepEqual(row, { school_id: w.schoolA, grade: 6 });
    } finally {
      await f.cleanup();
    }
  });
});

test("the database holds the rule for any other writer, and leaves old rows editable", { skip }, async () => {
  await withClient(async (c) => {
    const t = tag("lfit-db");
    const f = fixture(c, t);
    try {
      const w = await world(f, t);
      const refused = (sql: string, params: unknown[]) =>
        assert.rejects(c.query(sql, params), (e: { code?: string }) => e.code === "23514", sql);
      const insert = `INSERT INTO learners (class_id, school_id, grade, name) VALUES ($1, $2, $3, $4)`;

      await refused(insert, [w.a5, w.schoolB, 5, `Wrong school ${t}`]);
      await refused(insert, [w.a5, w.schoolA, 9, `Wrong grade ${t}`]);

      // Blank (omitted, or NULL) is the class's.
      const omitted = await c.query(`INSERT INTO learners (class_id, name) VALUES ($1, $2) RETURNING id, school_id, grade`, [w.a6, `Omitted ${t}`]);
      assert.deepEqual({ school: omitted.rows[0].school_id, grade: omitted.rows[0].grade }, { school: w.schoolA, grade: 6 });
      const nulls = await c.query(`INSERT INTO learners (class_id, school_id, grade, name) VALUES ($1, NULL, NULL, $2) RETURNING school_id, grade`, [w.b5, `Nulls ${t}`]);
      assert.deepEqual(nulls.rows[0], { school_id: w.schoolB, grade: 5 });

      // Moving a student takes her school and grade with her.
      const kid = omitted.rows[0].id as string;
      await refused(`UPDATE learners SET class_id = $2 WHERE id = $1`, [kid, w.a5]);
      await c.query(`UPDATE learners SET class_id = $2, grade = 5 WHERE id = $1`, [kid, w.a5]);
      await refused(`UPDATE learners SET grade = 9 WHERE id = $1`, [kid]);
      await refused(`UPDATE learners SET school_id = $2 WHERE id = $1`, [kid, w.schoolB]);

      // An old row: the class's grade changed after she was added. Anything
      // that leaves class, school and grade as they were goes through, even
      // when the statement names those columns; the read-only query an
      // administrator runs to list such rows finds her.
      await c.query(`UPDATE classes SET grade = 8 WHERE id = $1`, [w.a5]);
      await c.query(`UPDATE learners SET guardian = 'x', active = false WHERE id = $1`, [kid]);
      await c.query(`UPDATE learners SET class_id = class_id, school_id = school_id, grade = grade WHERE id = $1`, [kid]);
      await refused(`UPDATE learners SET grade = 7 WHERE id = $1`, [kid]);
      const { rows: contradicting } = await c.query(
        `SELECT l.id, c.grade AS class_grade, l.grade AS learner_grade
           FROM learners l
           JOIN classes c ON c.id = l.class_id
          WHERE (l.school_id <> c.school_id OR l.grade <> c.grade) AND l.name LIKE $1`,
        [`% ${t}`],
      );
      assert.deepEqual(contradicting, [{ id: kid, class_grade: 8, learner_grade: 5 }]);
    } finally {
      await f.cleanup();
    }
  });
});
