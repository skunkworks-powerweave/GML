// /teaching/marks, EXECUTED: a teacher's assessments and her students' marks,
// through the real server actions and pages, against Postgres.
//
//   - she sets a test for HER class and section only; another teacher, or a
//     section she does not teach, is refused
//   - marks entry for her roster: each student's percentage and grade from
//     the assessment's student scale, the class average and pass count; a
//     student not on the roster, or marks above the maximum, are refused
//   - sending it for approval locks it (pending and approved), and a request
//     for changes unlocks it again, with the approver's reason shown to her
//   - another teacher gets a 404, a mentor is turned away, and a programme
//     admin reads it without being able to change it
//   - every write is audited; the page renders in Hindi and fits a phone
//
// Committed fixtures under a tag, removed afterwards. The scale is the
// assessment's own (not the default), so nothing here depends on or changes
// the shared database's default scales.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Client } from "pg";
import { render, request, resetRequest } from "./_ui.js";
import { needsDatabase, withClient, tag } from "./_harness.js";
import { fixture, form, type Fixture } from "./_admin-fixture.js";
import { closeAppDb, outcome, signIn } from "./_server-actions.js";
import { phoneLayoutIssues } from "./_phone-layout.js";
import { gradeMark, parseMarks, summarise } from "../../apps/web/src/lib/grading/summary.ts";
import type { Band } from "../../apps/web/src/lib/grading/bands.ts";

const skip = needsDatabase();
after(async () => {
  if (!skip) await closeAppDb();
});

const actions = () => import("../../apps/web/src/app/(authenticated)/teaching/marks/actions.ts");
const listPage = () => import("../../apps/web/src/app/(authenticated)/teaching/marks/page.tsx");
const detailPage = () => import("../../apps/web/src/app/(authenticated)/teaching/marks/[id]/page.tsx");

const CBSE: Array<[string, number, number, boolean]> = [
  ["A1", 91, 100, true],
  ["A2", 81, 90, true],
  ["B1", 71, 80, true],
  ["B2", 61, 70, true],
  ["C1", 51, 60, true],
  ["C2", 41, 50, true],
  ["D", 33, 40, true],
  ["E", 0, 32, false],
];
const CBSE_BANDS: Band[] = CBSE.map(([label, minPct, maxPct, isPass], i) => ({ label, minPct, maxPct, isPass, sequence: i + 1 }));

// ── The maths, no database ───────────────────────────────────────────────────

test("a class key's section is read the way the teaching pages store sections", async () => {
  const { parseClassKey } = await import("../../apps/web/src/lib/grading/marks.ts");
  const id = "0c7ce1a2-12e4-4839-8f46-a57bfad08006";
  // Sections are stored upper-cased (lib/teaching parseSection); a hand-made
  // "id:a" made an assessment for a section "a" that no student is in.
  assert.deepEqual(parseClassKey(`${id}:a`), { classId: id, section: "A" });
  assert.deepEqual(parseClassKey(`${id}: b `), { classId: id, section: "B" });
  assert.deepEqual(parseClassKey(id), { classId: id, section: null });
  assert.equal(parseClassKey(`${id}:ABCDEFGHI`), null, "longer than a section can be");
  assert.equal(parseClassKey("nope:A"), null);
});

test("a student's marks become a percentage and a grade; the class gets an average and a pass count", () => {
  assert.deepEqual(gradeMark({ marks: 45.5, absent: false }, 50, CBSE_BANDS), { pct: 91, band: CBSE_BANDS[0] });
  assert.equal(gradeMark({ marks: 16, absent: false }, 50, CBSE_BANDS).band?.label, "E");
  assert.equal(gradeMark({ marks: 16.25, absent: false }, 50, CBSE_BANDS).band?.label, "D", "32.5% rounds to 33, the pass line");
  assert.deepEqual(gradeMark({ marks: 40, absent: true }, 50, CBSE_BANDS), { pct: null, band: null }, "absent: no grade");
  assert.deepEqual(gradeMark({ marks: 40, absent: false }, 50, null), { pct: 80, band: null }, "no scale: the percentage only");
  const s = summarise(
    [
      { marks: 45.5, absent: false },
      { marks: 16, absent: false },
      { marks: null, absent: true },
      { marks: null, absent: false },
    ],
    50,
    CBSE_BANDS,
  );
  // The average is graded like a student's percentage: 61.5 rounds to 62, B2.
  assert.deepEqual(
    { graded: s.graded, absent: s.absent, blank: s.blank, average: s.average, passed: s.passed, grade: s.averageBand?.label },
    { graded: 2, absent: 1, blank: 1, average: 61.5, passed: 1, grade: "B2" },
  );
  assert.equal(summarise([{ marks: 10, absent: false }], 20, null).passed, null, "no scale: nobody is counted as passing");
  assert.equal(parseMarks("", 50), null);
  assert.equal(parseMarks("12,5", 50), 12.5, "a decimal comma is read as a point");
  assert.equal(parseMarks("51", 50), undefined, "above the maximum");
  assert.equal(parseMarks("-1", 50), undefined);
  assert.equal(parseMarks("1.234", 50), undefined, "two decimals at most");
  assert.equal(parseMarks("ten", 50), undefined);
});

// ── The world ────────────────────────────────────────────────────────────────

type World = {
  f: Fixture;
  c: Client;
  t: string;
  klass: string;
  otherClass: string;
  subject: string;
  scale: string;
  teacherUser: string;
  otherUser: string;
  padmin: string;
  mentor: string;
  students: string[];
  sectionB: string;
  elsewhere: string;
};

async function world(c: Client, t: string): Promise<World> {
  const f = fixture(c, t);
  const code = t.replace(/[^a-z0-9]/gi, "").slice(-10).toUpperCase();
  const district = await f.row("districts", { name: `D ${t}`, code: `D${code}` });
  const zone = await f.row("zones", { district_id: district, name: `Z ${t}` });
  const school = await f.row("schools", { zone_id: zone, name: `School ${t}`, code: `S${code}`.slice(0, 16) });
  const klass = await f.row("classes", { school_id: school, grade: 7, stage: "Middle", sections_count: 2 });
  const otherClass = await f.row("classes", { school_id: school, grade: 8, stage: "Middle" });
  const subject = await f.row("subjects", { name: `Science ${t}`, code: `SC${code}`.slice(0, 16) });
  const teacherUser = await f.user("teacher", "t1");
  const otherUser = await f.user("teacher", "t2");
  const padmin = await f.user("programme_admin", "pa");
  const mentor = await f.user("mentor", "m");
  const teacher = await f.row("teachers", { school_id: school, full_name: `Dolma ${t}`, user_id: teacherUser });
  const other = await f.row("teachers", { school_id: school, full_name: `Other ${t}`, user_id: otherUser });
  // She teaches 7 A; the other teacher teaches grade 8.
  await f.row("teacher_classes", { teacher_id: teacher, class_id: klass, section: "A", subject_id: subject });
  await f.row("teacher_classes", { teacher_id: other, class_id: otherClass, section: null });
  const learner = (name: string, roll: string, section: string, classId = klass, grade = 7) =>
    f.row("learners", { class_id: classId, school_id: school, grade, name: `${name} ${t}`, roll_number: roll, section });
  const students = [await learner("Tsering", "1", "A"), await learner("Padma", "2", "A"), await learner("Stanzin", "3", "A")];
  const sectionB = await learner("Rigzin", "4", "B");
  const elsewhere = await learner("Norbu", "1", "A", otherClass, 8);
  const scale = await f.row("grading_scales", { name: `CBSE ${t}`, applies_to: "student" });
  for (const [i, [label, min, max, pass]] of CBSE.entries()) {
    await f.row("grading_bands", { scale_id: scale, label, min_pct: min, max_pct: max, is_pass: pass, sequence: i + 1 });
  }
  // Runs before the rows above are removed (later registrations run first).
  f.defer(`DELETE FROM assessments WHERE teacher_id = ANY($1)`, [[teacher, other]]);
  f.defer(`DELETE FROM approvals WHERE item_type = 'assessment' AND item_id IN (SELECT id FROM assessments WHERE teacher_id = ANY($1))`, [[teacher, other]]);
  f.defer(`DELETE FROM notifications WHERE user_id = ANY($1)`, [[teacherUser, otherUser, padmin, mentor]]);
  return { f, c, t, klass, otherClass, subject, scale, teacherUser, otherUser, padmin, mentor, students, sectionB, elsewhere };
}

const as = (id: string, role = "teacher") => ({ id, role });
type Returned = { ok: boolean; message: string };
async function returned(p: () => Promise<unknown>): Promise<Returned> {
  const o = await outcome(p);
  assert.equal(o.kind, "returned", `expected the action to answer, got ${JSON.stringify(o)}`);
  return (o as { value: Returned }).value;
}

async function createAssessment(w: World, fields: Record<string, string> = {}): Promise<string> {
  const a = await actions();
  signIn(as(w.teacherUser));
  const o = await outcome(() =>
    a.createAssessmentAction(
      undefined,
      form({
        classKey: `${w.klass}:A`,
        subjectId: w.subject,
        title: `Unit test ${w.t}`,
        maxMarks: "50",
        assessedOn: "2026-09-20",
        term: "2",
        gradingScaleId: w.scale,
        ...fields,
      }),
    ),
  );
  assert.equal(o.kind, "redirect", JSON.stringify(o));
  const id = (o as { location: string }).location.match(/^\/teaching\/marks\/([0-9a-f-]{36})$/)?.[1];
  assert.ok(id);
  return id!;
}

const marksForm = (id: string, rows: Array<[string, string, boolean, string]>) =>
  form({
    assessmentId: id,
    learnerId: rows.map((r) => r[0]),
    marks: rows.map((r) => r[1]),
    absent: rows.map((r) => (r[2] ? "1" : "0")),
    remark: rows.map((r) => r[3]),
  });

const DOC = readFileSync(new URL("../../docs/audit-actions.md", import.meta.url), "utf8");
async function auditRow(c: Client, action: string, entityId: string) {
  const { rows } = await c.query(`SELECT user_id, entity_type, metadata FROM audit_log WHERE action = $1 AND entity_id = $2 ORDER BY created_at DESC`, [
    action,
    entityId,
  ]);
  assert.ok(rows[0], `${action} was not audited`);
  const line = DOC.split("\n").find((l) => l.startsWith(`| \`${action}\` |`));
  assert.ok(line, `${action} is not documented in docs/audit-actions.md`);
  const documented = new Set([...line!.split("|")[3]!.matchAll(/`([A-Za-z_][A-Za-z0-9_]*)`/g)].map((m) => m[1]));
  assert.deepEqual(Object.keys(rows[0].metadata).filter((k) => !documented.has(k)), [], `${action}: undocumented metadata keys`);
  return rows[0] as { user_id: string; entity_type: string; metadata: Record<string, unknown> };
}

// ── The journey ──────────────────────────────────────────────────────────────

test("a teacher sets a test for her class, enters marks, and sees each student's grade, the average and the pass count", { skip }, async () => {
  const a = await actions();
  await withClient(async (c) => {
    const w = await world(c, tag("gmarks"));
    try {
      const id = await createAssessment(w);
      const [row] = (await c.query(`SELECT class_id, section, max_marks, term, approval_status, grading_scale_id FROM assessments WHERE id = $1`, [id])).rows;
      assert.deepEqual(row, { class_id: w.klass, section: "A", max_marks: 50, term: 2, approval_status: "draft", grading_scale_id: w.scale });
      const created = await auditRow(c, "teaching.marks.assessment_saved", id);
      assert.equal(created.user_id, w.teacherUser);
      assert.deepEqual(created.metadata, { created: true, classId: w.klass, subjectId: w.subject, maxMarks: 50 });

      const [s1, s2, s3] = w.students as [string, string, string];
      const saved = await returned(() =>
        a.saveMarksAction(undefined, marksForm(id, [[s1, "45.5", false, ""], [s2, "16", false, "Needs practice"], [s3, "", true, ""]])),
      );
      assert.deepEqual(saved, { ok: true, message: "Saved: 2 with marks, 1 absent." });
      const marks = (await c.query(`SELECT learner_id, marks, absent, remark FROM assessment_marks WHERE assessment_id = $1`, [id])).rows;
      const by = new Map(marks.map((m) => [m.learner_id, m]));
      assert.equal(Number(by.get(s1).marks), 45.5);
      assert.equal(by.get(s2).remark, "Needs practice");
      assert.deepEqual([by.get(s3).marks, by.get(s3).absent], [null, true]);
      assert.deepEqual((await auditRow(c, "teaching.marks.saved", id)).metadata, { marked: 2, absent: 1, cleared: 0 });

      // Her page: the roster with live grades from the assessment's scale.
      const { default: Detail } = await detailPage();
      const html = await render(await Detail({ params: Promise.resolve({ id }) }));
      assert.match(html, /data-testid="marks-editor"/);
      assert.match(html, /91% · A1/);
      assert.match(html, /32% · E/);
      assert.match(html, /2 students graded · average 61.5% · 1 passed · 1 absent/);
      assert.match(html, new RegExp(`Graded with CBSE ${w.t}`));
      assert.doesNotMatch(html, /Norbu|Rigzin/, "only her section's students are listed");

      // Her list shows it with its state.
      const { default: List } = await listPage();
      const list = await render(await List());
      assert.match(list, new RegExp(`Unit test ${w.t}`));
      assert.match(list, /3 students marked/);
      assert.match(list, /Draft/);

      // Leaving a student blank removes her row.
      const cleared = await returned(() =>
        a.saveMarksAction(undefined, marksForm(id, [[s1, "45.5", false, ""], [s2, "", false, ""], [s3, "", true, ""]])),
      );
      assert.equal(cleared.ok, true);
      assert.deepEqual((await auditRow(c, "teaching.marks.saved", id)).metadata, { marked: 1, absent: 1, cleared: 1 });

      // The maximum cannot drop below a mark already given.
      const lower = await returned(() =>
        a.updateAssessmentAction(undefined, form({ assessmentId: id, title: "Unit test", subjectId: w.subject, maxMarks: "40", assessedOn: "", term: "", gradingScaleId: w.scale })),
      );
      assert.equal(lower.ok, false);
      assert.match(lower.message, /already has 45.5 marks/);
      const renamed = await returned(() =>
        a.updateAssessmentAction(undefined, form({ assessmentId: id, title: `Unit 3 ${w.t}`, subjectId: w.subject, maxMarks: "60", assessedOn: "", term: "", gradingScaleId: w.scale })),
      );
      assert.equal(renamed.ok, true, renamed.message);
      assert.deepEqual((await c.query(`SELECT title, max_marks, term, assessed_on FROM assessments WHERE id = $1`, [id])).rows[0], {
        title: `Unit 3 ${w.t}`,
        max_marks: 60,
        term: null,
        assessed_on: null,
      });
    } finally {
      await w.f.cleanup();
    }
  });
});

test("her own only: another teacher, a section she does not teach, a student off the roster and bad marks are refused", { skip }, async () => {
  const a = await actions();
  await withClient(async (c) => {
    const w = await world(c, tag("gmown"));
    try {
      const id = await createAssessment(w);
      const [s1] = w.students as [string];

      // Not her section, not her class.
      signIn(as(w.teacherUser));
      for (const classKey of [`${w.klass}:B`, `${w.otherClass}:`]) {
        const r = await returned(() =>
          a.createAssessmentAction(undefined, form({ classKey, subjectId: w.subject, title: "X", maxMarks: "10", assessedOn: "", term: "", gradingScaleId: "" })),
        );
        assert.deepEqual(r, { ok: false, message: "Choose one of your own classes." }, classKey);
      }
      // Her roster only: section B, another class, marks above the maximum, not a number.
      for (const [learner, marks, why] of [
        [w.sectionB, "10", "a student of section B"],
        [w.elsewhere, "10", "a student of another class"],
      ] as const) {
        const r = await returned(() => a.saveMarksAction(undefined, marksForm(id, [[learner, marks, false, ""]])));
        assert.equal(r.ok, false, why);
        assert.match(r.message, /not in this class/);
      }
      for (const bad of ["51", "ten", "-2"]) {
        const r = await returned(() => a.saveMarksAction(undefined, marksForm(id, [[s1, bad, false, ""]])));
        assert.equal(r.ok, false, bad);
        assert.match(r.message, new RegExp(`Tsering ${w.t}: enter marks from 0 to 50`));
      }
      assert.equal((await c.query(`SELECT count(*)::int AS n FROM assessment_marks WHERE assessment_id = $1`, [id])).rows[0].n, 0);

      // Another teacher: every write refused, and the page is a 404.
      signIn(as(w.otherUser));
      const notYours = "This assessment does not exist, or it is not yours.";
      assert.deepEqual(await returned(() => a.saveMarksAction(undefined, marksForm(id, [[s1, "10", false, ""]]))), { ok: false, message: notYours });
      assert.deepEqual(
        await returned(() =>
          a.updateAssessmentAction(undefined, form({ assessmentId: id, title: "Mine now", subjectId: w.subject, maxMarks: "50", assessedOn: "", term: "", gradingScaleId: "" })),
        ),
        { ok: false, message: notYours },
      );
      assert.equal((await returned(() => a.submitAssessmentAction(undefined, form({ assessmentId: id, note: "" })))).ok, false);
      const { default: Detail } = await detailPage();
      assert.deepEqual(await outcome(() => Detail({ params: Promise.resolve({ id }) })), { kind: "notFound" });
      const { default: List } = await listPage();
      assert.doesNotMatch(await render(await List()), new RegExp(`Unit test ${w.t}`), "her assessment is not in his list");

      // A mentor is turned away; a programme admin may read but not write.
      signIn(as(w.mentor, "mentor"));
      assert.deepEqual(await outcome(() => Detail({ params: Promise.resolve({ id }) })), { kind: "redirect", location: "/forbidden" });
      signIn(as(w.padmin, "programme_admin"));
      assert.deepEqual(await outcome(() => a.saveMarksAction(undefined, marksForm(id, [[s1, "10", false, ""]]))), {
        kind: "redirect",
        location: "/forbidden",
      });
      const read = await render(await Detail({ params: Promise.resolve({ id }) }));
      assert.match(read, /data-testid="assessment-reader-note"/);
      assert.doesNotMatch(read, /data-testid="marks-editor"|data-testid="submit-assessment-form"|data-testid="assessment-details-form"/);
      assert.match(await render(await List()), new RegExp(`Unit test ${w.t}`), "the approver sees every teacher's assessments");
      assert.equal((await c.query(`SELECT title FROM assessments WHERE id = $1`, [id])).rows[0].title, `Unit test ${w.t}`);
    } finally {
      await w.f.cleanup();
    }
  });
});

test("sending the marks for approval locks them; changes requested unlocks them with the reason; approval locks them for good", { skip }, async () => {
  const a = await actions();
  const approvals = await import("../../apps/web/src/lib/approvals/index.ts");
  const { db } = await import("@gml/db");
  await withClient(async (c) => {
    const w = await world(c, tag("gmlock"));
    try {
      const id = await createAssessment(w);
      const [s1, s2] = w.students as [string, string];
      const state = async () => (await c.query(`SELECT approval_status FROM assessments WHERE id = $1`, [id])).rows[0].approval_status;

      assert.deepEqual(await returned(() => a.submitAssessmentAction(undefined, form({ assessmentId: id, note: "" }))), {
        ok: false,
        message: "Enter some marks before sending it for approval.",
      });
      await returned(() => a.saveMarksAction(undefined, marksForm(id, [[s1, "30", false, ""], [s2, "44", false, ""]])));
      const sent = await returned(() => a.submitAssessmentAction(undefined, form({ assessmentId: id, note: "Unit 3 test" })));
      assert.equal(sent.ok, true, sent.message);
      assert.equal(await state(), "pending");

      // Locked: marks, details and a second submission are refused.
      const locked = "It has been sent for approval or approved, so it cannot be changed.";
      assert.deepEqual(await returned(() => a.saveMarksAction(undefined, marksForm(id, [[s1, "50", false, ""]]))), { ok: false, message: locked });
      assert.deepEqual(
        await returned(() =>
          a.updateAssessmentAction(undefined, form({ assessmentId: id, title: "Changed", subjectId: w.subject, maxMarks: "50", assessedOn: "", term: "", gradingScaleId: w.scale })),
        ),
        { ok: false, message: locked },
      );
      assert.equal((await returned(() => a.submitAssessmentAction(undefined, form({ assessmentId: id, note: "" })))).ok, false);
      assert.equal(Number((await c.query(`SELECT marks FROM assessment_marks WHERE assessment_id = $1 AND learner_id = $2`, [id, s1])).rows[0].marks), 30);
      const { default: Detail } = await detailPage();
      const pending = await render(await Detail({ params: Promise.resolve({ id }) }));
      assert.match(pending, /data-testid="assessment-locked"[^>]*>Sent for approval/);
      assert.doesNotMatch(pending, /data-testid="marks-editor"/);
      assert.match(pending, /data-testid="assessment-marks"/, "the marks are shown read-only");
      assert.match(pending, /88%/, "44 of 50");
      assert.match(pending, /A2/);

      // The programme admin asks for changes: unlocked, with the reason shown.
      const [queued] = (await c.query(`SELECT id FROM approvals WHERE item_id = $1 AND status = 'pending'`, [id])).rows;
      const back = await approvals.decideApproval(db as never, {
        approvalId: queued.id,
        decision: "changes_requested",
        comment: "Stanzin's marks are missing",
        actor: as(w.padmin, "programme_admin"),
      });
      assert.equal(back.ok, true);
      assert.equal(await state(), "changes_requested");
      signIn(as(w.teacherUser));
      const reopened = await render(await Detail({ params: Promise.resolve({ id }) }));
      assert.match(reopened, /data-testid="marks-editor"/);
      assert.match(reopened, /data-testid="assessment-feedback"[\s\S]*Stanzin&#x27;s marks are missing|data-testid="assessment-feedback"[\s\S]*Stanzin's marks are missing/);
      assert.equal((await returned(() => a.saveMarksAction(undefined, marksForm(id, [[s1, "31", false, ""], [s2, "44", false, ""]])))).ok, true);

      // Resubmitted and approved: locked for good.
      assert.equal((await returned(() => a.submitAssessmentAction(undefined, form({ assessmentId: id, note: "" })))).ok, true);
      const [again] = (await c.query(`SELECT id FROM approvals WHERE item_id = $1 AND status = 'pending'`, [id])).rows;
      assert.equal((await approvals.decideApproval(db as never, { approvalId: again.id, decision: "approved", actor: as(w.padmin, "programme_admin") })).ok, true);
      assert.equal(await state(), "approved");
      assert.deepEqual(await returned(() => a.saveMarksAction(undefined, marksForm(id, [[s1, "50", false, ""]]))), { ok: false, message: locked });
      assert.match(await render(await Detail({ params: Promise.resolve({ id }) })), /data-testid="assessment-locked"[^>]*>Approved/);
    } finally {
      await w.f.cleanup();
    }
  });
});

test("the marks pages render in Hindi and Bhoti and fit a phone", { skip }, async () => {
  const a = await actions();
  await withClient(async (c) => {
    const w = await world(c, tag("gmi18n"));
    try {
      const id = await createAssessment(w);
      const [s1] = w.students as [string];
      await returned(() => a.saveMarksAction(undefined, marksForm(id, [[s1, "47", false, ""]])));
      const { default: Detail } = await detailPage();
      request.locale = "hi";
      const hi = await render(await Detail({ params: Promise.resolve({ id }) }));
      assert.match(hi, /विद्यार्थियों के अंक/, "the Hindi heading");
      assert.match(hi, /अंक सहेजें/, "the editor's Hindi save button");
      assert.match(hi, /94% · A1/);
      assert.deepEqual(await phoneLayoutIssues(hi), [], "the marks page fits a 360px phone");
      request.locale = "bo";
      const { default: List } = await listPage();
      const bo = await render(await List());
      assert.match(bo, /ངའི་ཚོད་དཔག/, "the Bhoti list heading");
      assert.match(bo, new RegExp(`Unit test ${w.t}`));
      assert.deepEqual(await phoneLayoutIssues(bo), []);
    } finally {
      resetRequest();
      await w.f.cleanup();
    }
  });
});
