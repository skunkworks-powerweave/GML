// "My classes" and "My students" (/teaching/classes, /teaching/students):
// a teacher adds a class at her school from scratch and maintains the students
// of the classes she teaches -- and nobody else's.
//
// Executed: the real server actions and pages, signed in as each role,
// against Postgres. What is checked:
//   - adding a class reuses the school's grade row or creates it (with the
//     stage the grade belongs to), and links her to it; a duplicate link and
//     a bad grade are refused; removing a link leaves the class;
//   - another teacher cannot remove her link, add to her class, or edit or
//     remove her students; a section she does not teach is refused;
//   - a student is removed softly (deleted_at) and leaves the roster;
//   - a teacher account with no teachers row gets the explanation, and
//     another role is refused by the actions and the pages;
//   - every write is audited with exactly the metadata docs/audit-actions.md
//     documents;
//   - the students page renders in Hindi.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Client } from "pg";
import { render, request, withAppRouter } from "./_ui.js";
import { needsDatabase, withClient, tag } from "./_harness.js";
import { fixture, form, type Fixture } from "./_admin-fixture.js";
import { closeAppDb, outcome, signIn } from "./_server-actions.js";
import { phoneLayoutIssues } from "./_phone-layout.js";

const skip = needsDatabase();
after(async () => {
  if (!skip) await closeAppDb();
});

const APP = "../../apps/web/src/app/(authenticated)/teaching";
const DOC = readFileSync(new URL("../../docs/audit-actions.md", import.meta.url), "utf8");

type World = {
  f: Fixture;
  school: string;
  otherSchool: string;
  subject: string;
  teacherUser: string;
  otherUser: string;
  loneUser: string;
  padmin: string;
  teacher: string;
  other: string;
};

async function world(f: Fixture, t: string): Promise<World> {
  const code = t.replace(/[^a-z0-9]/gi, "").slice(-10).toUpperCase();
  const district = await f.row("districts", { name: `D ${t}`, code: `D${code}` });
  const zone = await f.row("zones", { district_id: district, name: `Z ${t}` });
  const school = await f.row("schools", { zone_id: zone, name: `School ${t}`, code: `S${code}`.slice(0, 16) });
  const otherSchool = await f.row("schools", { zone_id: zone, name: `Other school ${t}`, code: `O${code}`.slice(0, 16) });
  const subject = await f.row("subjects", { name: `Maths ${t}`, code: `M${code}`.slice(0, 16) });
  const teacherUser = await f.user("teacher", "t1");
  const otherUser = await f.user("teacher", "t2");
  const loneUser = await f.user("teacher", "lone");
  const padmin = await f.user("programme_admin", "pa");
  const teacher = await f.row("teachers", { school_id: school, full_name: `Teacher ${t}`, user_id: teacherUser });
  const other = await f.row("teachers", { school_id: otherSchool, full_name: `Other ${t}`, user_id: otherUser });
  // What the actions create, removed before the rows above (defers run last-registered first).
  f.defer(`DELETE FROM classes WHERE school_id = ANY($1)`, [[school, otherSchool]]);
  f.defer(`DELETE FROM learners WHERE school_id = ANY($1)`, [[school, otherSchool]]);
  f.defer(`DELETE FROM teacher_classes WHERE teacher_id = ANY($1)`, [[teacher, other]]);
  return { f, school, otherSchool, subject, teacherUser, otherUser, loneUser, padmin, teacher, other };
}

const as = (id: string, role: string) => signIn({ id, role, name: null, email: null });

async function action<T>(file: string, name: string): Promise<(prev: unknown, fd: FormData) => Promise<T>> {
  const mod = (await import(`${APP}/${file}`)) as Record<string, (prev: unknown, fd: FormData) => Promise<T>>;
  return mod[name]!;
}

type State = { error?: string; ok?: string } | undefined;

/** The audit rows this user wrote for `action`, with their metadata keys checked against the doc. */
async function audited(c: Client, userId: string, actionName: string, optional: string[] = []) {
  const { rows } = await c.query(`SELECT entity_type, metadata FROM audit_log WHERE user_id = $1 AND action = $2 ORDER BY created_at`, [
    userId,
    actionName,
  ]);
  const line = DOC.split("\n").find((l) => l.startsWith(`| \`${actionName}\` |`));
  assert.ok(line, `${actionName} is written and missing from docs/audit-actions.md`);
  const documented = new Set([...line.split("|")[3]!.matchAll(/`([A-Za-z_][A-Za-z0-9_]*)`/g)].map((m) => m[1]!));
  for (const r of rows) {
    for (const k of Object.keys(r.metadata)) assert.ok(documented.has(k), `${actionName}: \`${k}\` is written and not documented`);
    for (const k of documented) if (!optional.includes(k)) assert.ok(k in r.metadata, `${actionName}: documented \`${k}\` is not written`);
    assert.ok(line.includes(`\`${r.entity_type}\``), `${actionName}: entity_type ${r.entity_type} is not documented`);
  }
  return rows as Array<{ entity_type: string; metadata: Record<string, unknown> }>;
}

async function page(file: string): Promise<string> {
  const { default: Page } = (await import(`${APP}/${file}`)) as { default: () => Promise<unknown> };
  const r = await outcome(() => Page());
  if (r.kind !== "returned") assert.fail(`${file}: ${JSON.stringify(r)}`);
  return render(withAppRouter((r as { value: unknown }).value));
}

test("a teacher adds classes at her school, reusing or creating the grade, and removes only her own link", { skip }, async () => {
  await withClient(async (c) => {
    const f = fixture(c, tag("teaching"));
    try {
      const w = await world(f, tag("tcls"));
      const add = await action<State>("classes/actions.ts", "addClassAction");
      const remove = await action<State>("classes/actions.ts", "removeClassAction");

      // Grade 5 already exists at her school (an admin entered it): it is reused.
      const existing = await f.row("classes", { school_id: w.school, grade: 5, stage: "Primary" });
      as(w.teacherUser, "teacher");
      const first = await add(undefined, form({ grade: "5", section: " a ", subjectId: w.subject }));
      assert.equal(first?.error, undefined, JSON.stringify(first));
      const links = await c.query(`SELECT id, class_id, section, subject_id FROM teacher_classes WHERE teacher_id = $1`, [w.teacher]);
      assert.equal(links.rowCount, 1);
      assert.equal(links.rows[0].class_id, existing, "the school's Grade 5 row is reused");
      assert.equal(links.rows[0].section, "A", "the section is kept as the register writes it");
      assert.equal(links.rows[0].subject_id, w.subject);

      // The same class and section twice is refused; so is a grade that is not 1-12.
      assert.match((await add(undefined, form({ grade: "5", section: "A" })))?.error ?? "", /already on your list/);
      assert.match((await add(undefined, form({ grade: "13" })))?.error ?? "", /grade from 1 to 12/);
      assert.match((await add(undefined, form({ grade: "5", section: "ABCDEFGHIJ" })))?.error ?? "", /at most 8/);

      // Grade 9 does not exist yet: it is created at HER school, as a High class.
      assert.equal((await add(undefined, form({ grade: "9" })))?.error, undefined);
      const nine = await c.query(`SELECT school_id, stage FROM classes WHERE school_id = $1 AND grade = 9`, [w.school]);
      assert.equal(nine.rowCount, 1);
      assert.equal(nine.rows[0].stage, "High");

      // Another teacher cannot remove her link.
      as(w.otherUser, "teacher");
      const hers = links.rows[0].id as string;
      assert.match((await remove(undefined, form({ linkId: hers })))?.error ?? "", /not found/);
      assert.equal((await c.query(`SELECT 1 FROM teacher_classes WHERE id = $1`, [hers])).rowCount, 1);
      // Her own grade 5 is at HER school, not the one the form might name.
      await add(undefined, form({ grade: "5", schoolId: w.school }));
      const otherFive = await c.query(
        `SELECT c.school_id FROM teacher_classes tc JOIN classes c ON c.id = tc.class_id WHERE tc.teacher_id = $1`,
        [w.other],
      );
      assert.deepEqual(otherFive.rows.map((r) => r.school_id), [w.otherSchool]);

      // She removes her link; the class stays.
      as(w.teacherUser, "teacher");
      assert.match((await remove(undefined, form({ linkId: hers })))?.ok ?? "", /removed/);
      assert.equal((await c.query(`SELECT 1 FROM teacher_classes WHERE id = $1`, [hers])).rowCount, 0);
      assert.equal((await c.query(`SELECT 1 FROM classes WHERE id = $1`, [existing])).rowCount, 1);

      const linked = await audited(c, w.teacherUser, "teaching.class.linked");
      assert.equal(linked.length, 2);
      assert.equal(linked[0]!.metadata.classCreated, false);
      assert.equal(linked[1]!.metadata.classCreated, true);
      assert.equal((await audited(c, w.teacherUser, "teaching.class.unlinked")).length, 1);
    } finally {
      await f.cleanup();
    }
  });
});

test("no teachers row: the pages explain, the actions refuse; other roles are turned away", { skip }, async () => {
  await withClient(async (c) => {
    const f = fixture(c, tag("teaching"));
    try {
      const w = await world(f, tag("tnone"));
      const add = await action<State>("classes/actions.ts", "addClassAction");

      as(w.loneUser, "teacher");
      for (const file of ["page.tsx", "classes/page.tsx", "students/page.tsx", "plans/page.tsx", "sessions/page.tsx"]) {
        const html = await page(file);
        assert.match(html, /Your teacher record is not set up yet/, `${file} explains the missing teacher record`);
      }
      assert.match((await add(undefined, form({ grade: "5" })))?.error ?? "", /not linked to a teacher record/);

      // A programme admin keeps no teaching records of her own.
      as(w.padmin, "programme_admin");
      assert.match((await add(undefined, form({ grade: "5" })))?.error ?? "", /Only teachers/);
      const { default: Classes } = (await import(`${APP}/classes/page.tsx`)) as { default: () => Promise<unknown> };
      assert.deepEqual(await outcome(() => Classes()), { kind: "redirect", location: "/forbidden" });
      assert.equal((await c.query(`SELECT 1 FROM teacher_classes WHERE teacher_id = ANY($1)`, [[w.teacher, w.other]])).rowCount, 0);
    } finally {
      await f.cleanup();
    }
  });
});

test("a teacher adds, edits and removes the students of her classes, and only those", { skip }, async () => {
  await withClient(async (c) => {
    const f = fixture(c, tag("teaching"));
    try {
      const w = await world(f, tag("tstu"));
      const addClass = await action<State>("classes/actions.ts", "addClassAction");
      const addStudent = await action<State>("students/actions.ts", "addStudentAction");
      const update = await action<State>("students/actions.ts", "updateStudentAction");
      const removeStudent = await action<State>("students/actions.ts", "removeStudentAction");

      as(w.teacherUser, "teacher");
      await addClass(undefined, form({ grade: "5", section: "A" }));
      const [link] = (await c.query(`SELECT id, class_id FROM teacher_classes WHERE teacher_id = $1`, [w.teacher])).rows;
      // Someone in section B of the same grade: not hers.
      const sectionB = await f.row("learners", { class_id: link.class_id, school_id: w.school, grade: 5, name: "Sonam B", section: "B" });

      // Add: the section is the link's, whatever was typed.
      const added = await addStudent(undefined, form({ linkId: link.id, name: "Dolma", rollNumber: "7", age: "10", guardian: "Tsering", section: "B" }));
      assert.equal(added?.error, undefined, JSON.stringify(added));
      const [dolma] = (await c.query(`SELECT * FROM learners WHERE class_id = $1 AND name = 'Dolma'`, [link.class_id])).rows;
      assert.equal(dolma.section, "A");
      assert.equal(dolma.school_id, w.school);
      assert.equal(dolma.grade, 5);
      assert.equal(dolma.age, 10);
      assert.match((await addStudent(undefined, form({ linkId: link.id, name: "" })))?.error ?? "", /student's name/);
      assert.match((await addStudent(undefined, form({ linkId: link.id, name: "X", age: "40" })))?.error ?? "", /3 to 25/);

      // Edit: a section she does not teach is refused; the rest is saved.
      assert.match((await update(undefined, form({ learnerId: dolma.id, name: "Dolma", section: "B" })))?.error ?? "", /do not teach that section/);
      assert.equal((await update(undefined, form({ learnerId: dolma.id, name: "Dolma Angmo", rollNumber: "7", age: "11", guardian: "Tsering", section: "A" })))?.error, undefined);
      const [saved] = (await c.query(`SELECT name, age, roll_number FROM learners WHERE id = $1`, [dolma.id])).rows;
      assert.deepEqual(saved, { name: "Dolma Angmo", age: 11, roll_number: "7" });
      // A section-B student is not on her roster: not hers to edit or remove.
      assert.match((await update(undefined, form({ learnerId: sectionB, name: "Changed" })))?.error ?? "", /not found/);
      assert.match((await removeStudent(undefined, form({ learnerId: sectionB })))?.error ?? "", /not found/);
      // Nor is an inactive student of her own section: her roster leaves them
      // out, so a hand-made learnerId must not reach them either.
      const inactive = await f.row("learners", { class_id: link.class_id, school_id: w.school, grade: 5, name: "Padma inactive", section: "A", active: false });
      assert.match((await update(undefined, form({ learnerId: inactive, name: "Changed" })))?.error ?? "", /not found/);
      assert.match((await removeStudent(undefined, form({ learnerId: inactive })))?.error ?? "", /not found/);

      // Another teacher can neither add to her class nor touch her students.
      as(w.otherUser, "teacher");
      assert.match((await addStudent(undefined, form({ linkId: link.id, name: "Intruder" })))?.error ?? "", /one of your classes/);
      assert.match((await update(undefined, form({ learnerId: dolma.id, name: "Hacked" })))?.error ?? "", /not found/);
      assert.match((await removeStudent(undefined, form({ learnerId: dolma.id })))?.error ?? "", /not found/);
      assert.equal((await c.query(`SELECT name FROM learners WHERE id = $1`, [dolma.id])).rows[0].name, "Dolma Angmo");

      // Her page lists her students -- in Hindi here -- and not section B's.
      as(w.teacherUser, "teacher");
      request.locale = "hi";
      try {
        const html = await page("students/page.tsx");
        assert.match(html, /मेरे विद्यार्थी/);
        assert.match(html, /Dolma Angmo/);
        assert.doesNotMatch(html, /Sonam B/);
      } finally {
        request.locale = "en";
      }

      // Every page of hers lays out at phone width, the student list and its forms included.
      request.cookies = { "gml-device": "mobile" };
      try {
        for (const file of ["page.tsx", "classes/page.tsx", "students/page.tsx"]) {
          assert.deepEqual(await phoneLayoutIssues(await page(file)), [], `${file} fits a phone`);
        }
      } finally {
        request.cookies = {};
      }

      // Remove: soft, and she leaves the list.
      assert.match((await removeStudent(undefined, form({ learnerId: dolma.id })))?.ok ?? "", /removed/);
      assert.notEqual((await c.query(`SELECT deleted_at FROM learners WHERE id = $1`, [dolma.id])).rows[0].deleted_at, null);
      assert.doesNotMatch(await page("students/page.tsx"), /Dolma Angmo/);

      const created = await audited(c, w.teacherUser, "teaching.student.created");
      assert.equal(created.length, 1);
      assert.equal(created[0]!.metadata.section, "A");
      const updated = await audited(c, w.teacherUser, "teaching.student.updated");
      assert.deepEqual(updated[0]!.metadata.changed, ["name", "age"]);
      assert.ok(!JSON.stringify(updated).includes("Dolma"), "no learner PII in the audit metadata");
      await audited(c, w.teacherUser, "teaching.student.removed");
      // The list view is audited too (SM-9); it is written without awaiting the page.
      let viewed = 0;
      for (let i = 0; i < 40 && viewed === 0; i++) {
        viewed = (await c.query(`SELECT 1 FROM audit_log WHERE user_id = $1 AND action = 'teaching.students.viewed'`, [w.teacherUser])).rowCount ?? 0;
        if (!viewed) await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(viewed > 0);
      await audited(c, w.teacherUser, "teaching.students.viewed");
    } finally {
      await f.cleanup();
    }
  });
});
