// The teaching-records tables as admin data tables: every new table can be
// filled from scratch in the grid (and by CSV), by the roles the design names,
// under the rules that need the database.
//
// ── WHAT MUST HOLD ───────────────────────────────────────────────────────────
//
// Design (docs/superpowers/specs/2026-09-28-teaching-records-design.md):
// "Every new table gets an admin data-table entity, so admins can add, edit
// and delete from scratch and use CSV import and export."
//
//   - grade scales and bands, rubrics and criteria, teachers' classes,
//     students' attendance, tests and marks, and the quizzes' grade scale are
//     written by programme_admin and super_admin, and refused to anyone else;
//   - the approvals history and account requests are read-only lists: every
//     write path refuses every role (decisions are taken at /approvals);
//   - an approval state is shown, never a form field: the grid cannot approve;
//   - the rules zod cannot check are enforced on the server: one default scale
//     per use, a scale of the right kind, a class at the teacher's school, a
//     student of the record's class, marks within the maximum, a quiz live
//     only with questions and never deleted;
//   - attendance written from the grid or a CSV says who marked it.
//
// Executed: the registry and zod schemas as they are; the grid's real server
// actions and the CSV import as a signed-in user, against Postgres.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { getTableName } from "drizzle-orm";
import { needsDatabase, withClient, tag } from "./_harness.js";
import { fixture, form, redirectOf, type Fixture } from "./_admin-fixture.js";
import { closeAppDb, signIn } from "./_server-actions.js";
import { parseSubmission } from "./_admin-submit.ts";
import { ADMIN_ENTITIES } from "../../apps/web/src/admin/registry.ts";

const skip = needsDatabase();
after(async () => {
  if (!skip) await closeAppDb();
});

const actions = () => import("../../apps/web/src/app/(authenticated)/admin/data/[entity]/actions.ts");

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

/** Sign in as this user for the actions and routes that follow. */
const actAs = (id: string, role: string) => signIn({ id, role });

const failedOn = (r: ReturnType<typeof parseSubmission>) =>
  r.success ? [] : r.error.issues.map((i) => String(i.path[0]));

// ── The registry ─────────────────────────────────────────────────────────────

const WRITABLE: Record<string, string> = {
  "grading-scales": "grading_scales",
  "grading-bands": "grading_bands",
  "observation-rubrics": "observation_rubrics",
  "rubric-criteria": "rubric_criteria",
  "teacher-classes": "teacher_classes",
  "session-attendance": "session_attendance",
  assessments: "assessments",
  "assessment-marks": "assessment_marks",
  quizzes: "quizzes",
};

test("every new table is a data table, written by programme_admin and super_admin only", () => {
  for (const [slug, table] of Object.entries(WRITABLE)) {
    const e = ADMIN_ENTITIES[slug];
    assert.ok(e, `${slug} is not registered -- ${table} has no admin data table`);
    assert.equal(getTableName(e.table), table);
    assert.deepEqual([...(e.mutateRoles ?? e.readRoles)].sort(), ["programme_admin", "super_admin"], slug);
    assert.deepEqual([...e.readRoles].sort(), ["programme_admin", "super_admin"], slug);
  }
  for (const [slug, table] of [
    ["approvals", "approvals"],
    ["account-requests", "account_requests"],
  ] as const) {
    const e = ADMIN_ENTITIES[slug]!;
    assert.equal(getTableName(e.table), table);
    assert.deepEqual(e.mutateRoles, [], `${slug} is a read-only list: nobody writes it through the grid`);
    assert.deepEqual([...e.readRoles].sort(), ["programme_admin", "super_admin"]);
  }
  // A child's attendance and marks name her: audited reads, under a valid action name.
  for (const slug of ["session-attendance", "assessment-marks"]) {
    assert.equal(ADMIN_ENTITIES[slug]!.piiAudited, true, slug);
    assert.match(ADMIN_ENTITIES[slug]!.auditName ?? "", /^[a-z_]+$/);
  }
});

test("the new columns of existing tables are in the grid, and an approval state is never a form field", () => {
  const e = (slug: string) => ADMIN_ENTITIES[slug]!;
  for (const f of ["notes", "section"]) assert.ok(e("sessions").formFields.includes(f), `sessions.${f}`);
  assert.ok(e("sessions").displayColumns.some((c) => c.key === "approvalStatus"));
  for (const k of ["ownerTeacherId", "approvalStatus"]) {
    assert.ok(e("course-outlines").displayColumns.some((c) => c.key === k), `course-outlines column ${k}`);
  }
  assert.ok(e("course-outlines").formFields.includes("ownerTeacherId"));
  for (const f of ["objectives", "activities", "materials"]) {
    assert.ok(e("outline-lessons").formFields.includes(f), `outline-lessons.${f}`);
  }
  assert.ok(e("quizzes").formFields.includes("gradingScaleId"));
  for (const slug of ["sessions", "course-outlines", "assessments"]) {
    assert.ok(!e(slug).formFields.includes("approvalStatus"), `${slug}: the grid must not approve`);
    const col = e(slug).displayColumns.find((c) => c.key === "approvalStatus");
    assert.deepEqual(col?.choices, ["draft", "pending", "approved", "changes_requested", "rejected"]);
  }
});

test("the forms' own rules: a band's range, a quiz's one scope, no marks for an absent student", () => {
  assert.deepEqual(failedOn(parseSubmission("grading-bands", { scaleId: UUID_A, label: "A1", minPct: "91", maxPct: "80" })), [
    "maxPct",
  ]);
  assert.ok(parseSubmission("grading-bands", { scaleId: UUID_A, label: "A1", minPct: "91", maxPct: "100" }).success);
  const quiz = { title: "Reading check", slug: "reading-check", passThreshold: "60" };
  assert.deepEqual(failedOn(parseSubmission("quizzes", quiz)), ["rttSubjectId"], "neither scope");
  assert.deepEqual(failedOn(parseSubmission("quizzes", { ...quiz, rttSubjectId: UUID_A, subjectId: UUID_B })), ["rttSubjectId"]);
  assert.deepEqual(failedOn(parseSubmission("quizzes", { ...quiz, slug: "Reading Check", rttSubjectId: UUID_A })), ["slug"]);
  assert.ok(parseSubmission("quizzes", { ...quiz, rttSubjectId: UUID_A }).success);
  assert.deepEqual(
    failedOn(parseSubmission("assessment-marks", { assessmentId: UUID_A, learnerId: UUID_B, marks: "12", absent: "true" })),
    ["marks"],
  );
  assert.ok(parseSubmission("assessment-marks", { assessmentId: UUID_A, learnerId: UUID_B, absent: "true" }).success);
  assert.deepEqual(failedOn(parseSubmission("session-attendance", { sessionId: UUID_A, learnerId: UUID_B, status: "sick" })), [
    "status",
  ]);
});

// ── Against the database ─────────────────────────────────────────────────────

type World = {
  f: Fixture;
  t: string;
  schoolA: string;
  classA: string;
  classB: string;
  subject: string;
  rttSubject: string;
  teacher: string;
  learnerA: string;
  learnerB: string;
  session: string;
  padmin: string;
  sadmin: string;
};

async function world(f: Fixture, t: string): Promise<World> {
  const code = t.replace(/[^a-z0-9]/gi, "").slice(-10).toUpperCase();
  const district = await f.row("districts", { name: `D ${t}`, code: `D${code}` });
  const zone = await f.row("zones", { district_id: district, name: `Z ${t}` });
  const schoolA = await f.row("schools", { zone_id: zone, name: `SA ${t}`, code: `A${code}`.slice(0, 16) });
  const schoolB = await f.row("schools", { zone_id: zone, name: `SB ${t}`, code: `B${code}`.slice(0, 16) });
  const classA = await f.row("classes", { school_id: schoolA, grade: 5, stage: "Primary" });
  const classB = await f.row("classes", { school_id: schoolB, grade: 5, stage: "Primary" });
  const subject = await f.row("subjects", { name: `Sub ${t}`, code: `SB${code}`.slice(0, 16) });
  // phases.label is varchar(24) and unique; sequence is unique too.
  const phase = await f.row("phases", { label: `P ${code}`.slice(0, 24), sequence: 2_000_000 + randomInt(1_000_000_000) });
  const term = await f.row("terms", { phase_id: phase, name: `Term ${t}`, sequence: 1 });
  const rttSubject = await f.row("rtt_subjects", { term_id: term, name: `RTT ${t}` });
  const teacher = await f.row("teachers", { school_id: schoolA, full_name: `Teacher ${t}` });
  const learnerA = await f.row("learners", { class_id: classA, school_id: schoolA, grade: 5, name: `LA ${t}`, section: "A" });
  const learnerB = await f.row("learners", { class_id: classB, school_id: schoolB, grade: 5, name: `LB ${t}` });
  const session = await f.row("sessions", {
    school_id: schoolA,
    class_id: classA,
    subject_id: subject,
    teacher_id: teacher,
    scheduled_date: "2026-09-28",
    topic: `Fractions ${t}`,
  });
  const padmin = await f.user("programme_admin", "pa");
  const sadmin = await f.user("super_admin", "sa");
  // Rows the actions create, removed before the world they hang off.
  f.defer(`DELETE FROM quizzes WHERE slug LIKE $1`, [`q-${code.toLowerCase()}%`]);
  f.defer(`DELETE FROM assessments WHERE teacher_id = $1`, [teacher]);
  f.defer(`DELETE FROM session_attendance WHERE session_id = $1`, [session]);
  f.defer(`DELETE FROM teacher_classes WHERE teacher_id = $1`, [teacher]);
  f.defer(`DELETE FROM observation_rubrics WHERE name LIKE $1`, [`%${t}%`]);
  f.defer(`DELETE FROM grading_scales WHERE name LIKE $1`, [`%${t}%`]);
  return { f, t, schoolA, classA, classB, subject, rttSubject, teacher, learnerA, learnerB, session, padmin, sadmin };
}

type State = { ok?: boolean; error?: string; fieldErrors?: Record<string, string> };

async function create(slug: string, values: Record<string, string>): Promise<State> {
  const { createRowAction } = await actions();
  return (await createRowAction(undefined, form({ entitySlug: slug, ...values }))) as State;
}
async function update(slug: string, rowId: string, values: Record<string, string>): Promise<State> {
  const { updateRowAction } = await actions();
  return (await updateRowAction(undefined, form({ entitySlug: slug, rowId, ...values }))) as State;
}
async function idOf(c: Fixture["c"], sql: string, params: unknown[]): Promise<string> {
  const { rows } = await c.query(sql, params);
  assert.ok(rows[0], `no row for ${sql}`);
  return rows[0].id as string;
}

test("a programme admin builds grade scales, bands, a rubric and its criteria from scratch", { skip }, async () => {
  await withClient(async (c) => {
    const t = tag("ap-grading");
    const f = fixture(c, t);
    try {
      const w = await world(f, t);
      actAs(w.padmin, "programme_admin");

      const made = await create("grading-scales", { name: `Students ${t}`, appliesTo: "student", isDefault: "false", active: "true" });
      assert.equal(made.ok, true, JSON.stringify(made));
      const scale = await idOf(c, `SELECT id FROM grading_scales WHERE name = $1`, [`Students ${t}`]);

      const band = await create("grading-bands", { scaleId: scale, label: "A1", minPct: "91", maxPct: "100", isPass: "true", sequence: "1" });
      assert.equal(band.ok, true, JSON.stringify(band));
      const bandId = await idOf(c, `SELECT id FROM grading_bands WHERE scale_id = $1`, [scale]);
      const edited = await update("grading-bands", bandId, { scaleId: scale, label: "A+", minPct: "90", maxPct: "100", isPass: "true", sequence: "1" });
      assert.equal(edited.ok, true, JSON.stringify(edited));
      assert.deepEqual((await c.query(`SELECT label, min_pct FROM grading_bands WHERE id = $1`, [bandId])).rows[0], { label: "A+", min_pct: 90 });

      // A rubric is graded on a scale for observations, not the students' one.
      const wrongKind = await create("observation-rubrics", { name: `Rubric ${t}`, gradingScaleId: scale, isDefault: "false", active: "true" });
      assert.equal(wrongKind.ok, false);
      assert.ok(wrongKind.fieldErrors?.gradingScaleId, JSON.stringify(wrongKind));
      assert.equal((await c.query(`SELECT 1 FROM observation_rubrics WHERE name = $1`, [`Rubric ${t}`])).rowCount, 0);

      assert.equal((await create("grading-scales", { name: `Observation ${t}`, appliesTo: "observation", isDefault: "false", active: "true" })).ok, true);
      const obsScale = await idOf(c, `SELECT id FROM grading_scales WHERE name = $1`, [`Observation ${t}`]);
      assert.equal((await create("observation-rubrics", { name: `Rubric ${t}`, gradingScaleId: obsScale, isDefault: "false", active: "true" })).ok, true);
      const rubric = await idOf(c, `SELECT id FROM observation_rubrics WHERE name = $1`, [`Rubric ${t}`]);
      const criterion = await create("rubric-criteria", { rubricId: rubric, sequence: "1", title: "Questioning", maxScore: "4" });
      assert.equal(criterion.ok, true, JSON.stringify(criterion));

      // Deleting the band from the grid removes it; the audit log says who.
      const { deleteRowAction } = await actions();
      assert.equal(await redirectOf(deleteRowAction(form({ entitySlug: "grading-bands", rowId: bandId }))), null);
      assert.equal((await c.query(`SELECT 1 FROM grading_bands WHERE id = $1`, [bandId])).rowCount, 0);
      // The audit insert is not awaited by the action: wait for it to land.
      const wanted = ["admin.row.create", "admin.row.update", "admin.row.delete"];
      let seen: string[] = [];
      for (let i = 0; i < 50 && !wanted.every((a) => seen.includes(a)); i++) {
        if (i) await new Promise((r) => setTimeout(r, 100));
        const audited = await c.query(
          `SELECT action FROM audit_log WHERE user_id = $1 AND entity_type IN ('grading-scales', 'grading-bands', 'rubric-criteria')`,
          [w.padmin],
        );
        seen = audited.rows.map((r) => r.action as string);
      }
      for (const a of wanted) assert.ok(seen.includes(a), `${a} not audited`);
    } finally {
      await f.cleanup();
    }
  });
});

test("one default grade scale per use: a second is refused, naming the first", { skip }, async () => {
  await withClient(async (c) => {
    const t = tag("ap-default");
    const f = fixture(c, t);
    try {
      const w = await world(f, t);
      actAs(w.sadmin, "super_admin");
      // The test database may hold another file's default quiz scale; this
      // file's own is made when there is none.
      const existing = await c.query(`SELECT name FROM grading_scales WHERE applies_to = 'quiz' AND is_default`);
      let defaultName = existing.rows[0]?.name as string | undefined;
      if (!defaultName) {
        defaultName = `Quiz default ${t}`;
        assert.equal((await create("grading-scales", { name: defaultName, appliesTo: "quiz", isDefault: "true", active: "true" })).ok, true);
      }
      const second = await create("grading-scales", { name: `Quiz second ${t}`, appliesTo: "quiz", isDefault: "true", active: "true" });
      assert.equal(second.ok, false);
      assert.match(second.fieldErrors?.isDefault ?? "", new RegExp(defaultName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.equal((await c.query(`SELECT 1 FROM grading_scales WHERE name = $1`, [`Quiz second ${t}`])).rowCount, 0);
      // Saving the default itself again is not "a second default".
      if (defaultName.endsWith(t)) {
        const own = await idOf(c, `SELECT id FROM grading_scales WHERE name = $1`, [defaultName]);
        const again = await update("grading-scales", own, { name: defaultName, appliesTo: "quiz", isDefault: "true", active: "true", description: "kept" });
        assert.equal(again.ok, true, JSON.stringify(again));
      }
    } finally {
      await f.cleanup();
    }
  });
});

test("teachers' classes, attendance and marks: the rules that need the database", { skip }, async () => {
  await withClient(async (c) => {
    const t = tag("ap-records");
    const f = fixture(c, t);
    try {
      const w = await world(f, t);
      actAs(w.padmin, "programme_admin");

      // Her classes are at her own school.
      const elsewhere = await create("teacher-classes", { teacherId: w.teacher, classId: w.classB });
      assert.equal(elsewhere.ok, false);
      assert.ok(elsewhere.fieldErrors?.classId, JSON.stringify(elsewhere));
      const link = await create("teacher-classes", { teacherId: w.teacher, classId: w.classA, section: "A", subjectId: w.subject });
      assert.equal(link.ok, true, JSON.stringify(link));

      // Attendance: a student of the session's class, marked by whoever wrote it.
      const stranger = await create("session-attendance", { sessionId: w.session, learnerId: w.learnerB, status: "present" });
      assert.equal(stranger.ok, false);
      assert.ok(stranger.fieldErrors?.learnerId, JSON.stringify(stranger));
      const before = Date.now();
      assert.equal((await create("session-attendance", { sessionId: w.session, learnerId: w.learnerA, status: "present" })).ok, true);
      const mark = (await c.query(`SELECT id, status, marked_by_user_id, marked_at FROM session_attendance WHERE session_id = $1`, [w.session])).rows[0];
      assert.equal(mark.status, "present");
      assert.equal(mark.marked_by_user_id, w.padmin, "the grid records who marked it");
      assert.ok(new Date(mark.marked_at).getTime() >= before - 5_000);
      actAs(w.sadmin, "super_admin");
      assert.equal((await update("session-attendance", mark.id, { sessionId: w.session, learnerId: w.learnerA, status: "late" })).ok, true);
      const remarked = (await c.query(`SELECT status, marked_by_user_id FROM session_attendance WHERE id = $1`, [mark.id])).rows[0];
      assert.deepEqual(remarked, { status: "late", marked_by_user_id: w.sadmin }, "a change of mark is the editor's");

      // The numbers derived from attendance follow the grid's writes: the
      // session's attended / total, and the student's %.
      const counts = async () =>
        (
          await c.query(
            `SELECT s.attended_count AS attended, s.total_count AS total, l.attendance_pct AS pct
               FROM sessions s, learners l WHERE s.id = $1 AND l.id = $2`,
            [w.session, w.learnerA],
          )
        ).rows[0];
      assert.deepEqual(await counts(), { attended: 1, total: 1, pct: 100 }, "late counts as attended");
      assert.equal((await update("session-attendance", mark.id, { sessionId: w.session, learnerId: w.learnerA, status: "absent" })).ok, true);
      assert.deepEqual(await counts(), { attended: 0, total: 1, pct: 0 });
      const { deleteRowAction } = await actions();
      assert.equal(await redirectOf(deleteRowAction(form({ entitySlug: "session-attendance", rowId: mark.id }))), null);
      assert.deepEqual(await counts(), { attended: 0, total: 0, pct: null }, "a deleted mark no longer counts");
      assert.equal((await create("session-attendance", { sessionId: w.session, learnerId: w.learnerA, status: "present" })).ok, true);
      assert.deepEqual(await counts(), { attended: 1, total: 1, pct: 100 });
      actAs(w.padmin, "programme_admin");

      // A test for her class; its marks within its maximum, none for an absentee.
      assert.equal((await create("assessments", { teacherId: w.teacher, classId: w.classB, subjectId: w.subject, title: `Test B ${t}`, maxMarks: "20" })).ok, false);
      const made = await create("assessments", {
        teacherId: w.teacher,
        classId: w.classA,
        subjectId: w.subject,
        title: `Unit test ${t}`,
        maxMarks: "20",
        assessedOn: "2026-09-25",
        term: "1",
      });
      assert.equal(made.ok, true, JSON.stringify(made));
      const test1 = (await c.query(`SELECT id, approval_status FROM assessments WHERE title = $1`, [`Unit test ${t}`])).rows[0];
      assert.equal(test1.approval_status, "draft", "a test entered here starts as a draft for its teacher");
      const over = await create("assessment-marks", { assessmentId: test1.id, learnerId: w.learnerA, marks: "25", absent: "false" });
      assert.equal(over.ok, false);
      assert.match(over.fieldErrors?.marks ?? "", /20/);
      assert.equal((await create("assessment-marks", { assessmentId: test1.id, learnerId: w.learnerB, marks: "5", absent: "false" })).ok, false);
      const ok = await create("assessment-marks", { assessmentId: test1.id, learnerId: w.learnerA, marks: "17.5", absent: "false", remark: "good" });
      assert.equal(ok.ok, true, JSON.stringify(ok));
      assert.equal((await c.query(`SELECT marks FROM assessment_marks WHERE assessment_id = $1`, [test1.id])).rows[0].marks, "17.50");

      // Deleting the student takes her attendance and marks (the confirmation
      // says so), and her session's counts no longer include her.
      assert.equal(await redirectOf(deleteRowAction(form({ entitySlug: "learners", rowId: w.learnerA }))), null);
      assert.equal((await c.query(`SELECT 1 FROM assessment_marks WHERE assessment_id = $1`, [test1.id])).rowCount, 0);
      const after = (await c.query(`SELECT attended_count, total_count FROM sessions WHERE id = $1`, [w.session])).rows[0];
      assert.deepEqual(after, { attended_count: 0, total_count: 0 });
    } finally {
      await f.cleanup();
    }
  });
});

test("anyone but an administrator is refused every write, and the read-only lists refuse everyone", { skip }, async () => {
  const { createRowAction, updateRowAction, deleteRowAction, bulkDeleteAction } = await actions();
  await withClient(async (c) => {
    const t = tag("ap-roles");
    const f = fixture(c, t);
    try {
      const w = await world(f, t);
      for (const role of ["teacher", "mentor", "observer"]) {
        actAs(await f.user(role, role), role);
        for (const slug of Object.keys(WRITABLE)) {
          const where = await redirectOf(createRowAction(undefined, form({ entitySlug: slug, name: `x ${t}` })));
          assert.equal(where, "/forbidden", `${role} reached ${slug}'s create`);
        }
      }
      assert.equal((await c.query(`SELECT 1 FROM grading_scales WHERE name = $1`, [`x ${t}`])).rowCount, 0);

      // The approvals history: not even a super_admin writes it through the grid.
      const approval = await f.row("approvals", {
        item_type: "session",
        item_id: w.session,
        status: "approved",
        decided_at: new Date(),
        submitted_by_user_id: w.padmin,
      });
      for (const [id, role] of [
        [w.padmin, "programme_admin"],
        [w.sadmin, "super_admin"],
      ] as const) {
        actAs(id, role);
        assert.equal(await redirectOf(createRowAction(undefined, form({ entitySlug: "approvals", itemType: "session", itemId: w.session }))), "/forbidden");
        assert.equal(
          await redirectOf(updateRowAction(undefined, form({ entitySlug: "approvals", rowId: approval, itemType: "session", itemId: w.session, status: "rejected" }))),
          "/forbidden",
        );
        assert.equal(await redirectOf(deleteRowAction(form({ entitySlug: "approvals", rowId: approval }))), "/forbidden");
        assert.equal(await redirectOf(bulkDeleteAction(form({ entitySlug: "account-requests", rowIds: [approval] }))), "/forbidden");
      }
      assert.equal((await c.query(`SELECT status FROM approvals WHERE id = $1`, [approval])).rows[0].status, "approved");

      // ...nor imports it; but an administrator can read and export it.
      const imp = await import("../../apps/web/src/app/api/admin/data/[entity]/import/route.ts");
      const exp = await import("../../apps/web/src/app/api/admin/data/[entity]/export/route.ts");
      actAs(w.sadmin, "super_admin");
      const refused = await imp.POST(
        new Request("http://app.test/api/admin/data/approvals/import", { method: "POST", body: "itemType,itemId\nsession," + w.session }),
        { params: Promise.resolve({ entity: "approvals" }) },
      );
      assert.equal(refused.status, 403);
      actAs(w.padmin, "programme_admin");
      const csv = await exp.GET(new Request("http://app.test/api/admin/data/approvals/export"), { params: Promise.resolve({ entity: "approvals" }) });
      assert.equal(csv.status, 200);
      assert.match(await csv.text(), new RegExp(approval));
    } finally {
      await f.cleanup();
    }
  });
});

test("quizzes: the grade scale is set from the grid; a quiz is never deleted there, nor live without questions", { skip }, async () => {
  const { deleteRowAction } = await actions();
  await withClient(async (c) => {
    const t = tag("ap-quiz");
    const f = fixture(c, t);
    try {
      const w = await world(f, t);
      const code = t.replace(/[^a-z0-9]/gi, "").slice(-10).toLowerCase();
      actAs(w.padmin, "programme_admin");
      assert.equal((await create("grading-scales", { name: `Q scale ${t}`, appliesTo: "quiz", isDefault: "false", active: "true" })).ok, true);
      assert.equal((await create("grading-scales", { name: `S scale ${t}`, appliesTo: "student", isDefault: "false", active: "true" })).ok, true);
      const quizScale = await idOf(c, `SELECT id FROM grading_scales WHERE name = $1`, [`Q scale ${t}`]);
      const studentScale = await idOf(c, `SELECT id FROM grading_scales WHERE name = $1`, [`S scale ${t}`]);
      const base = { title: `Quiz ${t}`, slug: `q-${code}`, rttSubjectId: w.rttSubject, passThreshold: "60", active: "false" };

      const wrong = await create("quizzes", { ...base, gradingScaleId: studentScale });
      assert.equal(wrong.ok, false);
      assert.ok(wrong.fieldErrors?.gradingScaleId);
      const live = await create("quizzes", { ...base, gradingScaleId: quizScale, active: "true" });
      assert.equal(live.ok, false, "a new quiz has no questions, so it cannot be created live");
      assert.ok(live.fieldErrors?.active);
      assert.equal((await create("quizzes", { ...base, gradingScaleId: quizScale })).ok, true);
      const quiz = (await c.query(`SELECT id, grading_scale_id, active FROM quizzes WHERE slug = $1`, [base.slug])).rows[0];
      assert.deepEqual({ scale: quiz.grading_scale_id, active: quiz.active }, { scale: quizScale, active: false });

      assert.equal((await update("quizzes", quiz.id, { ...base, gradingScaleId: quizScale, active: "true" })).ok, false);
      await c.query(`INSERT INTO quiz_questions (quiz_id, sequence, prompt, options, correct_index) VALUES ($1, 1, 'Q?', '["a","b"]', 0)`, [quiz.id]);
      assert.equal((await update("quizzes", quiz.id, { ...base, gradingScaleId: quizScale, active: "true" })).ok, true);

      const where = await redirectOf(deleteRowAction(form({ entitySlug: "quizzes", rowId: quiz.id })));
      assert.match(where ?? "", /error=locked/);
      assert.equal((await c.query(`SELECT 1 FROM quizzes WHERE id = $1`, [quiz.id])).rowCount, 1, "deleting a quiz would erase every result");
    } finally {
      await f.cleanup();
    }
  });
});

test("a session's notes and section are written from the grid, and an edit keeps its approval state", { skip }, async () => {
  await withClient(async (c) => {
    const t = tag("ap-cols");
    const f = fixture(c, t);
    try {
      const w = await world(f, t);
      await c.query(`UPDATE sessions SET approval_status = 'pending' WHERE id = $1`, [w.session]);
      actAs(w.padmin, "programme_admin");
      const r = await update("sessions", w.session, {
        schoolId: w.schoolA,
        classId: w.classA,
        subjectId: w.subject,
        teacherId: w.teacher,
        scheduledDate: "2026-09-28",
        topic: `Fractions ${t}`,
        status: "complete",
        attendedCount: "0",
        totalCount: "0",
        observed: "false",
        section: "A",
        notes: "Worked in pairs.\nGood questions.",
      });
      assert.equal(r.ok, true, JSON.stringify(r));
      const row = (await c.query(`SELECT section, notes, approval_status FROM sessions WHERE id = $1`, [w.session])).rows[0];
      assert.deepEqual(row, { section: "A", notes: "Worked in pairs.\nGood questions.", approval_status: "pending" });
    } finally {
      await f.cleanup();
    }
  });
});

test("a CSV of attendance is imported by a programme admin, stamped with who marked it, and audited", { skip }, async () => {
  const { importCsv } = await import("../../apps/web/src/app/(authenticated)/admin/data/[entity]/csv.ts");
  await withClient(async (c) => {
    const t = tag("ap-csv");
    const f = fixture(c, t);
    try {
      const w = await world(f, t);
      actAs(w.padmin, "programme_admin");
      const result = await importCsv(
        "session-attendance",
        `sessionId,learnerId,status\n${w.session},${w.learnerA},absent\n${w.session},${w.learnerB},present\n`,
      );
      assert.equal(result.inserted, 1, JSON.stringify(result));
      assert.equal(result.errors.length, 1, "the student of another school's class is reported, not added");
      assert.equal(result.errors[0]!.row, 3);
      const row = (await c.query(`SELECT status, marked_by_user_id FROM session_attendance WHERE session_id = $1`, [w.session])).rows[0];
      assert.deepEqual(row, { status: "absent", marked_by_user_id: w.padmin });
      const counts = (await c.query(`SELECT attended_count, total_count FROM sessions WHERE id = $1`, [w.session])).rows[0];
      assert.deepEqual(counts, { attended_count: 0, total_count: 1 }, "the session's counts follow the imported marks");
      let audited = 0;
      for (let i = 0; i < 40 && !audited; i++) {
        audited = (await c.query(`SELECT 1 FROM audit_log WHERE user_id = $1 AND action = 'session_attendance.bulk_import'`, [w.padmin])).rowCount ?? 0;
        if (!audited) await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(audited, "session_attendance.bulk_import");
    } finally {
      await f.cleanup();
    }
  });
});
