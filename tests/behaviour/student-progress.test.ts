// Student progress: what a teacher and a programme admin can read about HOW THE
// STUDENTS ARE DOING, beyond a bare attendance % on the roster.
//
// ── THE DEFECT ─────────────────────────────────────────────────────────────
//
// "Review progress" had one meaning in the product: a teacher's own RTT
// training progress (/rtt/progress). There was no view, for an admin or for a
// teacher, of the students of a class: how many sessions were held, how often
// they came, how they did in tests. The only numbers were a student's attendance
// % on two lists and the marks sheet of one test. (5 Oct 2026 QA, D-8.)
//
// ── WHAT IS DELIVERED ──────────────────────────────────────────────────────
//
//   /teaching/progress            a teacher: each class she teaches, its
//                                 students, sessions held / planned, attendance
//                                 rate, average marks, and a row per student
//   /progress/students            programme admin and super admin: every
//                                 school's classes with the same figures
//   /progress/students/[classId]  one class, with its students
//   lib/teaching/progress.ts      the figures, one definition for all three
//
// The attendance % is the definition the roster already uses
// (lib/teaching/records.ts refreshLearnerAttendance: present + late out of the
// sessions the student was marked in, cancelled sessions left out); a test
// below compares the two on the same data. A teacher's figures count her own
// sessions and tests only, as every other record of hers does.
//
// Executed against Postgres: the real aggregation, the real pages signed in as
// each role. Committed fixtures under a tag, removed afterwards.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Client } from "pg";
import { render, request, withAppRouter } from "./_ui.js";
import { needsDatabase, withClient, tag } from "./_harness.js";
import { fixture, type Fixture } from "./_admin-fixture.js";
import { closeAppDb, outcome, signIn } from "./_server-actions.js";
import { phoneLayoutIssues } from "./_phone-layout.js";

const skip = needsDatabase();
after(async () => {
  if (!skip) await closeAppDb();
});

const WEB = "../../apps/web/src";
const progressLib = () => import(`${WEB}/lib/teaching/progress.ts`);
const recordsLib = () => import(`${WEB}/lib/teaching/records.ts`);
const teacherPage = () => import(`${WEB}/app/(authenticated)/teaching/progress/page.tsx`);
const overviewPage = () => import(`${WEB}/app/(authenticated)/progress/students/page.tsx`);
const classPage = () => import(`${WEB}/app/(authenticated)/progress/students/[classId]/page.tsx`);
const dbModule = () => import("../../packages/db/src/client.ts");

const DOC = readFileSync(new URL("../../docs/audit-actions.md", import.meta.url), "utf8");

const as = (id: string, role: string) => signIn({ id, role, name: null, email: null });

/** The text a reader sees: tags and React's text-boundary comments gone. */
const visible = (html: string) =>
  html
    .replace(/<!--.*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ");

// ── The world ────────────────────────────────────────────────────────────────
//
// Grade 5 of the first school (c5) is where the figures are checked. T1 teaches
// its section A, T2 the whole grade. Every number below is worked out by hand.
//
//   students     Angmo 1 A, Bilal 2 A, Chosdol 3 A, Deskit 4 B, Gyalpo 7 (no
//                section) -- and two who must never count: Eshay (inactive)
//                and Fatima (deleted), who are present and top-scoring.
//   T1 sessions  s1 s2 s3 complete, s4 cancelled, s5 planned (all section A)
//   T2 session   s7 complete (whole grade)
//   attendance   Angmo   s1 present, s2 late, s3 absent, s4 absent*, s7 absent
//                Bilal   s1 s2 s3 present, s7 present
//                Chosdol s1 excused, s2 absent                  (s3 unmarked)
//                Deskit  s7 present
//                Gyalpo  never marked                           (* cancelled)
//   tests        U1 (T1, out of 50): Angmo 40, Bilal 25, Chosdol absent, Deskit 10
//                U2 (T1, out of 20): Angmo 15, Bilal 20, Chosdol 10
//                Q  (T2, out of 10): Angmo 10
//
//   T1, section A (Angmo Bilal Chosdol Gyalpo)
//     attendance  Angmo 2/3 = 67%  Bilal 3/3 = 100%  Chosdol 0/2 = 0%  Gyalpo none
//                 class 5/8 = 62.5 -> 63%; below 75%: Angmo, Chosdol
//     sessions    3 held of 4 planned
//     marks       Angmo (80+75)/2 = 77.5   Bilal (50+100)/2 = 75   Chosdol 50
//                 class (80+50+75+100+50)/5 = 71
//   Admin, whole class (the four above and Deskit)
//     attendance  Angmo 2/4 = 50%  Bilal 4/4  Chosdol 0/2  Deskit 1/1
//                 class 7/11 = 63.6 -> 64%
//     sessions    4 held of 5 planned
//     marks       Angmo (80+75+100)/3 = 85  Deskit 20  class 475/7 = 67.857 -> 67.9
//   Hishey 80% and Ishey 60% (Grade 7) were typed on the student list; no session
//     has been marked for them, so the number shown is that one.
//   T2, whole grade: s7 and Q only -- Angmo 0/1, Bilal 1/1, Deskit 1/1 -> 2/3 = 67%

type World = Awaited<ReturnType<typeof world>>;

async function world(f: Fixture, t: string) {
  const code = t.replace(/[^a-z0-9]/gi, "").slice(-10).toUpperCase();
  const d1 = await f.row("districts", { name: `D1 ${t}`, code: `A${code}` });
  const d2 = await f.row("districts", { name: `D2 ${t}`, code: `B${code}` });
  const z1 = await f.row("zones", { district_id: d1, name: `Z1 ${t}` });
  const z2 = await f.row("zones", { district_id: d2, name: `Z2 ${t}` });
  const school = (zone: string, name: string, c: string) => f.row("schools", { zone_id: zone, name: `${name} ${t}`, code: `${c}${code}`.slice(0, 16) });
  const s1 = await school(z1, "Alpha", "1");
  const s1b = await school(z1, "Beta", "2");
  const s2 = await school(z2, "Gamma", "3");
  const maths = await f.row("subjects", { name: `Maths ${t}`, code: `M${code}`.slice(0, 16) });

  const user = (role: string, label: string) => f.user(role, label);
  const t1User = await user("teacher", "t1");
  const t2User = await user("teacher", "t2");
  const t3User = await user("teacher", "t3");
  const loneUser = await user("teacher", "lone");
  const padmin = await user("programme_admin", "pa");
  const sadmin = await user("super_admin", "sa");
  const mentor = await user("mentor", "m");
  const observer = await user("observer", "o");
  const t1 = await f.row("teachers", { school_id: s1, full_name: `Teacher One ${t}`, user_id: t1User });
  const t2 = await f.row("teachers", { school_id: s1, full_name: `Teacher Two ${t}`, user_id: t2User });
  const t3 = await f.row("teachers", { school_id: s2, full_name: `Teacher Three ${t}`, user_id: t3User });

  const klass = (school: string, grade: number, extra: Record<string, unknown> = {}) =>
    f.row("classes", { school_id: school, grade, stage: grade <= 5 ? "Primary" : "Middle", ...extra });
  const c5 = await klass(s1, 5);
  const c6 = await klass(s1, 6); // no students
  const c7 = await klass(s1, 7); // students, nothing held or marked yet
  const c8 = await klass(s1, 8, { active: false }); // retired: not listed
  const cb = await klass(s1b, 5);
  const c2 = await klass(s2, 5);
  await f.row("teacher_classes", { teacher_id: t1, class_id: c5, section: "A", subject_id: maths });
  await f.row("teacher_classes", { teacher_id: t1, class_id: c6 });
  await f.row("teacher_classes", { teacher_id: t1, class_id: c7 });
  await f.row("teacher_classes", { teacher_id: t2, class_id: c5 });
  await f.row("teacher_classes", { teacher_id: t3, class_id: c2 });

  const learner = (classId: string, schoolId: string, grade: number, name: string, roll: string, section: string | null, extra: Record<string, unknown> = {}) =>
    f.row("learners", { class_id: classId, school_id: schoolId, grade, name, roll_number: roll, section, ...extra });
  const angmo = await learner(c5, s1, 5, "Angmo", "1", "A");
  const bilal = await learner(c5, s1, 5, "Bilal", "2", "A");
  const chosdol = await learner(c5, s1, 5, "Chosdol", "3", "A");
  const deskit = await learner(c5, s1, 5, "Deskit", "4", "B");
  const eshay = await learner(c5, s1, 5, "Eshay", "5", "A", { active: false });
  const fatima = await learner(c5, s1, 5, "Fatima", "6", "A", { deleted_at: new Date("2026-09-10T00:00:00Z") });
  const gyalpo = await learner(c5, s1, 5, "Gyalpo", "7", null);
  // Typed on the student list (grid or CSV), with no session marked: the only attendance there is.
  await learner(c7, s1, 7, "Hishey", "1", null, { attendance_pct: 80 });
  await learner(c7, s1, 7, "Ishey", "2", null, { attendance_pct: 60 });
  await learner(cb, s1b, 5, "Jigmet", "1", null);
  await learner(c2, s2, 5, "Kunzang", "1", null);

  const session = (teacher: string, date: string, status: string, section: string | null) =>
    f.row("sessions", { school_id: s1, class_id: c5, subject_id: maths, teacher_id: teacher, scheduled_date: date, status, section });
  const s1a = await session(t1, "2026-09-01", "complete", "A");
  const s2a = await session(t1, "2026-09-02", "complete", "A");
  const s3a = await session(t1, "2026-09-03", "complete", "A");
  const s4a = await session(t1, "2026-09-04", "cancelled", "A");
  await session(t1, "2026-10-20", "planned", "A");
  const s7 = await session(t2, "2026-09-05", "complete", null);
  const mark = (sessionId: string, learnerId: string, status: string) =>
    f.row("session_attendance", { session_id: sessionId, learner_id: learnerId, status });
  for (const [s, l, status] of [
    [s1a, angmo, "present"], [s2a, angmo, "late"], [s3a, angmo, "absent"], [s4a, angmo, "absent"], [s7, angmo, "absent"],
    [s1a, bilal, "present"], [s2a, bilal, "present"], [s3a, bilal, "present"], [s7, bilal, "present"],
    [s1a, chosdol, "excused"], [s2a, chosdol, "absent"],
    [s7, deskit, "present"],
    [s1a, eshay, "present"], [s2a, eshay, "present"], [s3a, eshay, "present"],
    [s1a, fatima, "present"],
  ] as const) await mark(s, l, status);

  const assessment = (teacher: string, section: string | null, title: string, max: number) =>
    f.row("assessments", { teacher_id: teacher, class_id: c5, subject_id: maths, section, title, max_marks: max, approval_status: "draft" });
  const u1 = await assessment(t1, "A", "Unit 1", 50);
  const u2 = await assessment(t1, "A", "Unit 2", 20);
  const q = await assessment(t2, null, "Quiz", 10);
  const score = (assessment: string, learnerId: string, marks: number | null, absent = false) =>
    f.row("assessment_marks", { assessment_id: assessment, learner_id: learnerId, marks, absent });
  await score(u1, angmo, 40);
  await score(u1, bilal, 25);
  await score(u1, chosdol, null, true);
  await score(u1, deskit, 10);
  await score(u1, eshay, 50);
  await score(u2, angmo, 15);
  await score(u2, bilal, 20);
  await score(u2, chosdol, 10);
  await score(u2, fatima, 20);
  await score(q, angmo, 10);

  return { alpha: `Alpha ${t}`, gamma: `Gamma ${t}`, maths, d1, d2, z1, z2, s1, s1b, s2, t1, t2, t3, t1User, t2User, t3User, loneUser, padmin, sadmin, mentor, observer, c5, c6, c7, c8, cb, c2, angmo, bilal, chosdol, deskit, eshay, fatima, gyalpo };
}

const pick = <T extends object, K extends keyof T>(o: T, keys: K[]): Pick<T, K> => Object.fromEntries(keys.map((k) => [k, o[k]])) as Pick<T, K>;

const figureKeys = ["students", "sessionsHeld", "sessionsPlanned", "marked", "attended", "attendancePct", "marksCount", "marksAvg"] as const;

// ── The maths, no database ───────────────────────────────────────────────────

test("an attendance % rounds as the roster's does, and no marks is no %, not 0", async () => {
  const p = await progressLib();
  assert.equal(p.attendancePercent(2, 3), 67);
  assert.equal(p.attendancePercent(3, 3), 100);
  assert.equal(p.attendancePercent(0, 2), 0);
  assert.equal(p.attendancePercent(5, 8), 63, "62.5 rounds up, as round() in refreshLearnerAttendance");
  assert.equal(p.attendancePercent(1, 8), 13, "12.5 rounds up");
  assert.equal(p.attendancePercent(0, 0), null, "nobody marked: no percentage, no division by zero");
});

test("below 75% is low; 75% is not; no attendance yet is not a warning", async () => {
  const p = await progressLib();
  assert.equal(p.LOW_ATTENDANCE_PCT, 75);
  assert.equal(p.isLowAttendance(74), true);
  assert.equal(p.isLowAttendance(75), false);
  assert.equal(p.isLowAttendance(0), true);
  assert.equal(p.isLowAttendance(null), false);
});

test("students sort by roll number as a number, or lowest attendance first with the unmarked last", async () => {
  const p = await progressLib();
  const row = (name: string, rollNumber: string | null, attendancePct: number | null) => ({ name, rollNumber, attendancePct }) as never;
  const names = (rows: unknown[]) => rows.map((r) => (r as { name: string }).name);
  // The roster comes out of Postgres as text: "10" before "2". Here it is as given, shuffled.
  const rows = [row("C", "10", 40), row("A", "1", 90), row("F", null, 90), row("B", "2", null), row("E", "11", 10), row("D", "9", 90)];
  assert.deepEqual(names(p.sortStudents(rows, "roll")), ["A", "B", "D", "C", "E", "F"], "1, 2, 9, 10, 11, then no roll number");
  assert.deepEqual(
    names(p.sortStudents(rows, "attendance")),
    ["E", "C", "A", "D", "F", "B"],
    "worst first; the 90s keep roll order (1, 9, none); the unmarked last",
  );
  // The same roll number: by name.
  const twins = [row("Bo", "3", 50), row("Al", "3", 50)];
  assert.deepEqual(names(p.sortStudents(twins, "roll")), ["Al", "Bo"]);
  assert.deepEqual(names(p.sortStudents(twins, "attendance")), ["Al", "Bo"]);
});

// ── The figures, against Postgres ────────────────────────────────────────────

test("a teacher's figures are her section's active students, in her own sessions and tests", { skip }, async () => {
  await withClient(async (c) => {
    const f = fixture(c, tag("prog"));
    try {
      const w = await world(f, tag("tp"));
      const { db } = await dbModule();
      const p = await progressLib();

      // A number typed on the student list does not outrank what she was marked in.
      await c.query(`UPDATE learners SET attendance_pct = 99 WHERE id = $1`, [w.chosdol]);

      const r = await p.classProgress(db, { classId: w.c5, section: "A", teacherId: w.t1 });
      assert.deepEqual(
        r.students.map((s: { name: string }) => s.name),
        ["Angmo", "Bilal", "Chosdol", "Gyalpo"],
        "section A and students with no section; not Deskit (B), Eshay (inactive) or Fatima (deleted)",
      );
      const by = Object.fromEntries(r.students.map((s: { name: string }) => [s.name, s]));
      assert.deepEqual(pick(by.Angmo, ["marked", "attended", "attendancePct", "marksCount", "marksAvg", "lastSession", "low"]), {
        marked: 3, // s4 was cancelled, s7 is her colleague's
        attended: 2,
        attendancePct: 67,
        marksCount: 2,
        marksAvg: 77.5,
        lastSession: "2026-09-03",
        low: true,
      });
      assert.deepEqual(pick(by.Bilal, ["marked", "attended", "attendancePct", "marksAvg", "lastSession", "low"]), {
        marked: 3, attended: 3, attendancePct: 100, marksAvg: 75, lastSession: "2026-09-03", low: false,
      });
      assert.deepEqual(pick(by.Chosdol, ["marked", "attended", "attendancePct", "marksCount", "marksAvg", "lastSession", "low"]), {
        marked: 2, // one session left unmarked
        attended: 0, // excused and absent are both missed
        attendancePct: 0,
        marksCount: 1, // absent from Unit 1: no mark, not a zero
        marksAvg: 50,
        lastSession: "2026-09-02",
        low: true,
      });
      assert.equal(by.Chosdol.pctFromRoster, false);
      assert.deepEqual(pick(by.Gyalpo, ["marked", "attended", "attendancePct", "pctFromRoster", "marksCount", "marksAvg", "lastSession", "low"]), {
        marked: 0, attended: 0, attendancePct: null, pctFromRoster: false, marksCount: 0, marksAvg: null, lastSession: null, low: false,
      });

      assert.deepEqual(pick(r.figures, [...figureKeys]), {
        students: 4,
        sessionsHeld: 3,
        sessionsPlanned: 4,
        marked: 8,
        attended: 5,
        attendancePct: 63,
        marksCount: 5,
        marksAvg: 71,
      });
      assert.equal(r.lowCount, 2);

      // Her colleague, who teaches the whole grade, sees her own session and test.
      const other = await p.classProgress(db, { classId: w.c5, section: null, teacherId: w.t2 });
      assert.deepEqual(other.students.map((s: { name: string }) => s.name), ["Angmo", "Bilal", "Chosdol", "Deskit", "Gyalpo"]);
      assert.deepEqual(pick(other.figures, [...figureKeys]), {
        students: 5, sessionsHeld: 1, sessionsPlanned: 1, marked: 3, attended: 2, attendancePct: 67, marksCount: 1, marksAvg: 100,
      });
    } finally {
      await f.cleanup();
    }
  });
});

test("an admin's class figures cover every teacher's sessions and tests and every active student", { skip }, async () => {
  await withClient(async (c) => {
    const f = fixture(c, tag("prog"));
    try {
      const w = await world(f, tag("ad"));
      const { db } = await dbModule();
      const p = await progressLib();

      const r = await p.classProgress(db, { classId: w.c5 });
      assert.deepEqual(r.students.map((s: { name: string }) => s.name), ["Angmo", "Bilal", "Chosdol", "Deskit", "Gyalpo"]);
      const by = Object.fromEntries(r.students.map((s: { name: string }) => [s.name, s]));
      assert.deepEqual(pick(by.Angmo, ["marked", "attended", "attendancePct", "marksAvg", "lastSession"]), {
        marked: 4, attended: 2, attendancePct: 50, marksAvg: 85, lastSession: "2026-09-05",
      });
      assert.equal(by.Deskit.attendancePct, 100);
      assert.equal(by.Deskit.marksAvg, 20);
      assert.equal(by.Gyalpo.attendancePct, null);
      assert.deepEqual(pick(r.figures, [...figureKeys]), {
        students: 5, sessionsHeld: 4, sessionsPlanned: 5, marked: 11, attended: 7, attendancePct: 64, marksCount: 7, marksAvg: 67.9,
      });
      assert.equal(r.lowCount, 2, "Angmo (50%) and Chosdol (0%)");
    } finally {
      await f.cleanup();
    }
  });
});

test("a class with no students, or students and nothing held yet, answers with zeros and dashes, not NaN", { skip }, async () => {
  await withClient(async (c) => {
    const f = fixture(c, tag("prog"));
    try {
      const w = await world(f, tag("em"));
      const { db } = await dbModule();
      const p = await progressLib();
      const none = { students: 0, sessionsHeld: 0, sessionsPlanned: 0, marked: 0, attended: 0, attendancePct: null, marksCount: 0, marksAvg: null };

      const empty = await p.classProgress(db, { classId: w.c6, section: null, teacherId: w.t1 });
      assert.deepEqual(empty.students, []);
      assert.deepEqual(pick(empty.figures, [...figureKeys]), none);
      assert.equal(empty.lowCount, 0);

      // Nothing held or marked, but two typed percentages on the student list: shown as such, and a low one is low.
      const fresh = await p.classProgress(db, { classId: w.c7 });
      const [hishey, ishey] = fresh.students;
      const keys = ["name", "marked", "attendancePct", "pctFromRoster", "low", "marksAvg", "lastSession"] as const;
      assert.deepEqual(pick(hishey, [...keys]), { name: "Hishey", marked: 0, attendancePct: 80, pctFromRoster: true, low: false, marksAvg: null, lastSession: null });
      assert.deepEqual(pick(ishey, [...keys]), { name: "Ishey", marked: 0, attendancePct: 60, pctFromRoster: true, low: true, marksAvg: null, lastSession: null });
      assert.equal(fresh.lowCount, 1);
      assert.deepEqual(pick(fresh.figures, [...figureKeys]), { ...none, students: 2 }, "the class rate counts marked sessions only");
    } finally {
      await f.cleanup();
    }
  });
});

test("the programme overview lists active schools and classes, each with the figures of its class page", { skip }, async () => {
  await withClient(async (c) => {
    const f = fixture(c, tag("prog"));
    try {
      const w = await world(f, tag("ov"));
      const { db } = await dbModule();
      const p = await progressLib();

      const one = await p.programmeProgress(db, { schoolId: w.s1 });
      assert.equal(one.total, 1);
      const [school] = one.schools;
      assert.equal(school.id, w.s1);
      assert.deepEqual(school.classes.map((k: { grade: number }) => k.grade), [5, 6, 7], "by grade; the retired Grade 8 is not listed");
      const five = school.classes[0];
      const page = await p.classProgress(db, { classId: w.c5 });
      assert.deepEqual(pick(five.figures, [...figureKeys]), pick(page.figures, [...figureKeys]), "the overview and the class page say the same thing");
      assert.deepEqual(pick(school.classes[1].figures, [...figureKeys]), {
        students: 0, sessionsHeld: 0, sessionsPlanned: 0, marked: 0, attended: 0, attendancePct: null, marksCount: 0, marksAvg: null,
      });
      assert.equal(school.classes[2].figures.students, 2);
      assert.deepEqual(pick(school.totals, [...figureKeys]), {
        students: 7, sessionsHeld: 4, sessionsPlanned: 5, marked: 11, attended: 7, attendancePct: 64, marksCount: 7, marksAvg: 67.9,
      });

      // A district narrows to its schools, a zone likewise; another district's are absent.
      const place = (districtId: string, zoneId: string | null = null) => ({ districtId, districtName: "", zoneId, zoneName: null });
      const inD1 = await p.programmeProgress(db, { place: place(w.d1) });
      assert.deepEqual(inD1.schools.map((s: { id: string }) => s.id), [w.s1, w.s1b], "Alpha then Beta, by name");
      assert.deepEqual((await p.programmeProgress(db, { place: place(w.d1, w.z1) })).schools.map((s: { id: string }) => s.id), [w.s1, w.s1b]);
      assert.deepEqual((await p.programmeProgress(db, { place: place(w.d2) })).schools.map((s: { id: string }) => s.id), [w.s2]);
      assert.deepEqual((await p.programmeProgress(db, { place: place(w.d2), schoolId: w.s1 })).schools, [], "a school outside the place is not shown");

      // Pages of schools.
      const first = await p.programmeProgress(db, { place: place(w.d1), pageSize: 1, page: 1 });
      const second = await p.programmeProgress(db, { place: place(w.d1), pageSize: 1, page: 2 });
      assert.equal(first.total, 2);
      assert.deepEqual([first.schools.map((s: { id: string }) => s.id), second.schools.map((s: { id: string }) => s.id)], [[w.s1], [w.s1b]]);

      // A school with no classes is still listed.
      const bare = await p.programmeProgress(db, { schoolId: w.s2 });
      assert.deepEqual(bare.schools[0].classes.map((k: { grade: number }) => k.grade), [5]);
      assert.equal(bare.schools[0].totals.students, 1);
    } finally {
      await f.cleanup();
    }
  });
});

test("the attendance % is the number the roster stores, on the same data", { skip }, async () => {
  await withClient(async (c) => {
    const f = fixture(c, tag("prog"));
    try {
      const w = await world(f, tag("same"));
      const { db } = await dbModule();
      const p = await progressLib();
      const records = await recordsLib();
      // What saving attendance does for these students.
      await records.refreshLearnerAttendance(db, [w.angmo, w.bilal, w.chosdol, w.deskit, w.gyalpo]);
      const stored = new Map(
        (await c.query(`SELECT name, attendance_pct FROM learners WHERE class_id = $1`, [w.c5])).rows.map((r) => [r.name as string, r.attendance_pct as number | null]),
      );
      const r = await p.classProgress(db, { classId: w.c5 });
      for (const s of r.students as Array<{ name: string; attendancePct: number | null }>) {
        assert.equal(s.attendancePct, stored.get(s.name), `${s.name}: progress and the roster agree`);
      }
    } finally {
      await f.cleanup();
    }
  });
});

test("a large class costs the same handful of queries as a small one, and adds up", { skip }, async () => {
  await withClient(async (c) => {
    const f = fixture(c, tag("prog"));
    try {
      const w = await world(f, tag("big"));
      const { db, getPool } = await dbModule();
      const p = await progressLib();

      // 300 students, 20 sessions, a test each: every fifth student never comes (0%), the rest always do.
      const big = await f.row("classes", { school_id: w.s1b, grade: 9, stage: "High" });
      await c.query(
        `INSERT INTO learners (class_id, school_id, grade, name, roll_number)
         SELECT $1, $2, 9, 'Big ' || n, n::text FROM generate_series(1, 300) AS n`,
        [big, w.s1b],
      );
      f.defer(`DELETE FROM learners WHERE class_id = $1`, [big]);
      await c.query(
        `INSERT INTO sessions (school_id, class_id, subject_id, teacher_id, scheduled_date, status)
         SELECT $1, $2, $3, $4, DATE '2026-08-01' + n, 'complete' FROM generate_series(1, 20) AS n`,
        [w.s1b, big, w.maths, w.t1],
      );
      f.defer(`DELETE FROM sessions WHERE class_id = $1`, [big]);
      await c.query(
        `INSERT INTO session_attendance (session_id, learner_id, status)
         SELECT s.id, l.id, CASE WHEN l.roll_number::int % 5 = 0 THEN 'absent'::attendance_status ELSE 'present'::attendance_status END
           FROM sessions s CROSS JOIN learners l WHERE s.class_id = $1 AND l.class_id = $1`,
        [big],
      );
      f.defer(`DELETE FROM session_attendance WHERE session_id IN (SELECT id FROM sessions WHERE class_id = $1)`, [big]);

      const pool = getPool() as unknown as { query: (...a: unknown[]) => unknown };
      const real = pool.query.bind(pool);
      let queries = 0;
      pool.query = (...a: unknown[]) => {
        queries += 1;
        return real(...a);
      };
      let small = 0;
      let large = 0;
      let r: Awaited<ReturnType<typeof p.classProgress>>;
      try {
        queries = 0;
        await p.classProgress(db, { classId: w.c7 });
        small = queries;
        queries = 0;
        r = await p.classProgress(db, { classId: big });
        large = queries;
      } finally {
        pool.query = real;
      }
      assert.equal(large, small, "no query per student");
      assert.ok(large <= 10, `a class page costs ${large} queries`);
      assert.equal(r.students.length, 300);
      assert.deepEqual(pick(r.figures, ["students", "sessionsHeld", "sessionsPlanned", "marked", "attended", "attendancePct"]), {
        students: 300, sessionsHeld: 20, sessionsPlanned: 20, marked: 6000, attended: 4800, attendancePct: 80,
      });
      assert.equal(r.lowCount, 60);
    } finally {
      await f.cleanup();
    }
  });
});

// ── The pages ────────────────────────────────────────────────────────────────

async function teacherHtml(search: Record<string, string> = {}): Promise<string> {
  const { default: Page } = (await teacherPage()) as { default: (p: unknown) => Promise<unknown> };
  const r = await outcome(() => Page({ searchParams: Promise.resolve(search) }));
  if (r.kind !== "returned") assert.fail(JSON.stringify(r));
  return render(withAppRouter(r.value));
}

async function pageOutcome(load: () => Promise<{ default: unknown }>, props: unknown) {
  const { default: Page } = (await load()) as { default: (p: unknown) => Promise<unknown> };
  const r = await outcome(() => Page(props));
  return r.kind === "returned" ? { kind: "returned" as const, html: await render(withAppRouter(r.value)) } : r;
}

/** An audit row is written without awaiting the page: wait for it. */
async function auditRows(c: Client, userId: string, action: string, where = "true") {
  for (let i = 0; i < 40; i++) {
    const { rows } = await c.query(`SELECT entity_type, entity_id, metadata FROM audit_log WHERE user_id = $1 AND action = $2 AND ${where} ORDER BY created_at`, [userId, action]);
    if (rows.length) return rows as Array<{ entity_type: string; entity_id: string | null; metadata: Record<string, unknown> }>;
    await new Promise((r) => setTimeout(r, 50));
  }
  return [];
}

test("her page shows each class she teaches with its figures, and the rule behind them", { skip }, async () => {
  await withClient(async (c) => {
    const f = fixture(c, tag("prog"));
    try {
      const w = await world(f, tag("pg"));
      as(w.t1User, "teacher");
      const html = await teacherHtml();
      const text = visible(html);

      assert.match(text, /Student progress/);
      assert.match(text, /Grade 5 A/);
      assert.match(text, /Grade 6 \(all sections\)/);
      assert.match(text, /Grade 7 \(all sections\)/);
      // Her students only; the inactive, the deleted, section B and other schools' are absent.
      for (const name of ["Angmo", "Bilal", "Chosdol", "Gyalpo", "Hishey", "Ishey"]) assert.match(text, new RegExp(name), `${name} is hers`);
      for (const name of ["Deskit", "Eshay", "Fatima", "Jigmet", "Kunzang"]) assert.doesNotMatch(text, new RegExp(name), `${name} is not`);
      // The class's figures and a student's.
      assert.match(text, /3 of 4/, "sessions held of planned");
      assert.match(text, /63%/, "class attendance 5 of 8");
      assert.match(text, /71%/, "class average marks");
      assert.match(text, /67% \(2 of 3 sessions\)/, "Angmo");
      assert.match(text, /77\.5%/, "Angmo's marks");
      assert.match(text, /3 Sept? 2026/, "Angmo's last session");
      // Low attendance is said in words, not only in colour.
      assert.equal((html.match(/>Low attendance</g) ?? []).length, 3, "Angmo, Chosdol and Ishey (60% on the student list)");
      assert.match(text, /80% on the student list \(no sessions marked yet\)/);
      // The rule, in plain words, with the threshold.
      assert.match(text, /present or late/);
      assert.match(text, /below 75%/);
      // An empty class is an empty state, not a row of zeros.
      assert.match(text, /No students in this class yet\./);
    } finally {
      await f.cleanup();
    }
  });
});

test("the lowest-attendance order puts the worst first and the unmarked last", { skip }, async () => {
  await withClient(async (c) => {
    const f = fixture(c, tag("prog"));
    try {
      const w = await world(f, tag("so"));
      as(w.t1User, "teacher");
      const at = (text: string, name: string) => text.indexOf(name);
      const byRoll = visible(await teacherHtml());
      assert.ok(at(byRoll, "Angmo") < at(byRoll, "Bilal") && at(byRoll, "Bilal") < at(byRoll, "Chosdol") && at(byRoll, "Chosdol") < at(byRoll, "Gyalpo"));
      const worst = visible(await teacherHtml({ sort: "attendance" }));
      // 0% Chosdol, 67% Angmo, 100% Bilal, then Gyalpo, who has no attendance.
      assert.ok(at(worst, "Chosdol") < at(worst, "Angmo") && at(worst, "Angmo") < at(worst, "Bilal") && at(worst, "Bilal") < at(worst, "Gyalpo"));
      // Anything else is the default order.
      const junk = visible(await teacherHtml({ sort: "<script>" }));
      assert.ok(at(junk, "Angmo") < at(junk, "Chosdol"));
    } finally {
      await f.cleanup();
    }
  });
});

test("another teacher's class is not on her page, and a colleague's figures are her own sessions only", { skip }, async () => {
  await withClient(async (c) => {
    const f = fixture(c, tag("prog"));
    try {
      const w = await world(f, tag("sc"));
      // T3 teaches Gamma's Grade 5 only.
      as(w.t3User, "teacher");
      const three = visible(await teacherHtml());
      assert.match(three, /Kunzang/);
      for (const name of ["Angmo", "Bilal", "Hishey", "Jigmet"]) assert.doesNotMatch(three, new RegExp(name));
      assert.doesNotMatch(three, /Grade 6|Grade 7/);

      // T2 teaches Alpha's whole Grade 5 but held one session: 2 of 3, not T1's 5 of 8 or the 7 of 11.
      as(w.t2User, "teacher");
      const two = visible(await teacherHtml());
      assert.match(two, /Deskit/, "the whole grade is hers");
      assert.match(two, /1 of 1/);
      assert.match(two, /67%/);
      assert.doesNotMatch(two, /\b63%|\b64%/);
      assert.doesNotMatch(two, /Eshay|Fatima/);
    } finally {
      await f.cleanup();
    }
  });
});

test("a colleague's marks are not hers: no stored percentage stands in for sessions she has not marked", { skip }, async () => {
  await withClient(async (c) => {
    const f = fixture(c, tag("prog"));
    try {
      const w = await world(f, tag("co"));
      const { db } = await dbModule();
      const p = await progressLib();
      const records = await recordsLib();
      // What saving attendance does: learners.attendance_pct becomes the figure over EVERY teacher's sessions.
      await records.refreshLearnerAttendance(db, [w.angmo, w.bilal, w.chosdol, w.deskit, w.gyalpo]);
      const stored = (await c.query(`SELECT attendance_pct FROM learners WHERE id = $1`, [w.chosdol])).rows[0].attendance_pct;
      assert.equal(stored, 0, "Chosdol's stored 0% is T1's marking");

      // T2 never marked Chosdol: nothing of hers to show, and nothing to warn about.
      const two = await p.classProgress(db, { classId: w.c5, section: null, teacherId: w.t2 });
      const by = Object.fromEntries(two.students.map((s: { name: string }) => [s.name, s]));
      assert.deepEqual(pick(by.Chosdol, ["marked", "attendancePct", "pctFromRoster", "low"]), { marked: 0, attendancePct: null, pctFromRoster: false, low: false });
      assert.deepEqual(pick(by.Gyalpo, ["marked", "attendancePct", "pctFromRoster", "low"]), { marked: 0, attendancePct: null, pctFromRoster: false, low: false });
      assert.deepEqual(pick(by.Angmo, ["marked", "attended", "attendancePct", "pctFromRoster", "low"]), { marked: 1, attended: 0, attendancePct: 0, pctFromRoster: false, low: true }, "her own marks, not the pooled 50%");
      assert.equal(two.lowCount, 1, "Angmo only");
      assert.equal(two.figures.attendancePct, 67, "the tile and the rows agree");

      // T1, who did mark her, still sees it.
      const one = await p.classProgress(db, { classId: w.c5, section: "A", teacherId: w.t1 });
      assert.deepEqual(pick(one.students.find((s: { name: string }) => s.name === "Chosdol")!, ["marked", "attendancePct", "pctFromRoster", "low"]), { marked: 2, attendancePct: 0, pctFromRoster: false, low: true });

      // A percentage typed on the student list, with no session marked by anyone, is still shown to a teacher.
      const fresh = await p.classProgress(db, { classId: w.c7, section: null, teacherId: w.t1 });
      assert.deepEqual(fresh.students.map((s: { attendancePct: number | null; pctFromRoster: boolean }) => [s.attendancePct, s.pctFromRoster]), [[80, true], [60, true]]);

      // The page says so in words.
      as(w.t2User, "teacher");
      const html = await teacherHtml();
      const text = visible(html);
      assert.doesNotMatch(text, /on the student list/, "no colleague's percentage under 'no sessions marked yet'");
      assert.equal((text.match(/Not marked yet/g) ?? []).length, 2, "Chosdol and Gyalpo");
      assert.equal((html.match(/>Low attendance</g) ?? []).length, 1, "Angmo only");
    } finally {
      await f.cleanup();
    }
  });
});

test("a teacher of one section is counted on that section's sessions and tests, not the other's", { skip }, async () => {
  await withClient(async (c) => {
    const f = fixture(c, tag("prog"));
    try {
      const w = await world(f, tag("se"));
      const { db } = await dbModule();
      const p = await progressLib();
      // Grade 9: T1 teaches sections A and B. a1 is in A, b1 in B, g in neither (the roster puts g on both).
      const c9 = await f.row("classes", { school_id: w.s1, grade: 9, stage: "High" });
      await f.row("teacher_classes", { teacher_id: w.t1, class_id: c9, section: "A" });
      await f.row("teacher_classes", { teacher_id: w.t1, class_id: c9, section: "B" });
      const learner = (name: string, section: string | null) =>
        f.row("learners", { class_id: c9, school_id: w.s1, grade: 9, name, roll_number: name.slice(-1), section });
      const a1 = await learner("Student a1", "A");
      const b1 = await learner("Student b1", "B");
      const g = await learner("Student g", null);
      const held = (date: string, section: string) =>
        f.row("sessions", { school_id: w.s1, class_id: c9, subject_id: w.maths, teacher_id: w.t1, scheduled_date: date, status: "complete", section });
      const sA = await held("2026-09-01", "A");
      const sB = await held("2026-09-02", "B");
      const mark = (sessionId: string, learnerId: string, status: string) => f.row("session_attendance", { session_id: sessionId, learner_id: learnerId, status });
      await mark(sA, a1, "present");
      await mark(sA, g, "present");
      await mark(sB, b1, "present");
      await mark(sB, g, "absent");
      const test = (section: string, title: string) =>
        f.row("assessments", { teacher_id: w.t1, class_id: c9, subject_id: w.maths, section, title, max_marks: 10, approval_status: "draft" });
      const tA = await test("A", "Test A");
      const tB = await test("B", "Test B");
      const score = (assessment: string, learnerId: string, marks: number) => f.row("assessment_marks", { assessment_id: assessment, learner_id: learnerId, marks, absent: false });
      await score(tA, a1, 8);
      await score(tA, g, 8);
      await score(tB, b1, 2);
      await score(tB, g, 2);

      const keys = ["students", "sessionsHeld", "sessionsPlanned", "marked", "attended", "attendancePct", "marksCount", "marksAvg"] as const;
      const a = await p.classProgress(db, { classId: c9, section: "A", teacherId: w.t1 });
      assert.deepEqual(pick(a.figures, [...keys]), { students: 2, sessionsHeld: 1, sessionsPlanned: 1, marked: 2, attended: 2, attendancePct: 100, marksCount: 2, marksAvg: 80 });
      const gA = a.students.find((s: { id: string }) => s.id === g)!;
      assert.deepEqual(pick(gA, ["marked", "attended", "attendancePct", "marksCount", "marksAvg", "lastSession"]), {
        marked: 1, attended: 1, attendancePct: 100, marksCount: 1, marksAvg: 80, lastSession: "2026-09-01",
      }, "g on A's card: A's session and A's test only");

      const b = await p.classProgress(db, { classId: c9, section: "B", teacherId: w.t1 });
      assert.deepEqual(pick(b.figures, [...keys]), { students: 2, sessionsHeld: 1, sessionsPlanned: 1, marked: 2, attended: 1, attendancePct: 50, marksCount: 2, marksAvg: 20 });
      const gB = b.students.find((s: { id: string }) => s.id === g)!;
      assert.deepEqual(pick(gB, ["marked", "attended", "attendancePct", "marksAvg", "lastSession"]), { marked: 1, attended: 0, attendancePct: 0, marksAvg: 20, lastSession: "2026-09-02" });

      // The whole grade, as an admin sees it, is both.
      const all = await p.classProgress(db, { classId: c9 });
      assert.deepEqual(pick(all.figures, [...keys]), { students: 3, sessionsHeld: 2, sessionsPlanned: 2, marked: 4, attended: 3, attendancePct: 75, marksCount: 4, marksAvg: 50 });
    } finally {
      await f.cleanup();
    }
  });
});

test("a session with attendance taken is held, whatever its status says; a cancelled one never is", { skip }, async () => {
  await withClient(async (c) => {
    const f = fixture(c, tag("prog"));
    try {
      const w = await world(f, tag("hd"));
      const { db } = await dbModule();
      const p = await progressLib();
      const klass = await f.row("classes", { school_id: w.s1, grade: 10, stage: "High" });
      await f.row("teacher_classes", { teacher_id: w.t1, class_id: klass });
      const x = await f.row("learners", { class_id: klass, school_id: w.s1, grade: 10, name: "Xeno", roll_number: "1" });
      const session = (date: string, status: string) =>
        f.row("sessions", { school_id: w.s1, class_id: klass, subject_id: w.maths, teacher_id: w.t1, scheduled_date: date, status });
      const mark = (sessionId: string, status: string) => f.row("session_attendance", { session_id: sessionId, learner_id: x, status });
      await mark(await session("2026-09-01", "planned"), "present"); // taken, status never moved on
      await mark(await session("2026-09-02", "in_progress"), "absent");
      await mark(await session("2026-09-03", "cancelled"), "present"); // not counted anywhere
      await session("2026-09-04", "complete"); // held, no attendance taken
      await session("2026-09-05", "complete");
      await session("2026-10-30", "planned"); // still to come

      const r = await p.classProgress(db, { classId: klass, section: null, teacherId: w.t1 });
      assert.deepEqual(pick(r.figures, ["sessionsHeld", "sessionsPlanned", "marked", "attended", "attendancePct"]), {
        sessionsHeld: 4, sessionsPlanned: 5, marked: 2, attended: 1, attendancePct: 50,
      }, "held never falls below the sessions the attendance figures come from");
      const admin = await p.classProgress(db, { classId: klass });
      assert.deepEqual(pick(admin.figures, ["sessionsHeld", "sessionsPlanned"]), { sessionsHeld: 4, sessionsPlanned: 5 });
      const overview = await p.programmeProgress(db, { schoolId: w.s1 });
      assert.equal(overview.schools[0].classes.find((k: { classId: string }) => k.classId === klass)!.figures.sessionsHeld, 4);

      as(w.t1User, "teacher");
      assert.match(visible(await teacherHtml()), /4 of 5/);
    } finally {
      await f.cleanup();
    }
  });
});

test("her page says what 'held of planned' is, states the attendance rule plainly, and points an empty class to its next step", { skip }, async () => {
  await withClient(async (c) => {
    const f = fixture(c, tag("prog"));
    try {
      const w = await world(f, tag("tx"));
      as(w.t1User, "teacher");
      const html = await teacherHtml();
      const text = visible(html);
      assert.match(text, /Sessions held \(of planned\)/, "the tile says what the second number is");
      assert.match(text, /Sessions held = the sessions marked Complete or with attendance taken, out of all sessions planned\. Cancelled sessions are left out\./);
      // The one sentence the owner asked for: plain, no pronoun for the student, and what counts against her.
      assert.match(text, /Attendance % = the sessions a student was present or late, out of the sessions where attendance was taken\./);
      assert.match(text, /Absent and excused count as not attended\./);
      assert.doesNotMatch(text, /\bshe\b|\bher\b/i);
      // An empty class (Grade 6) leads on to adding students; a class with students does not.
      assert.equal((html.match(/href="\/teaching\/students"/g) ?? []).length, 1);
      assert.match(html, /<a [^>]*href="\/teaching\/students"[^>]*>Add students</);
      // The admin's pages carry the same sentences.
      as(w.padmin, "programme_admin");
      const admin = visible(((await pageOutcome(classPage, { params: Promise.resolve({ classId: w.c5 }), searchParams: Promise.resolve({}) })) as { html: string }).html);
      assert.match(admin, /Sessions held \(of planned\)/);
      assert.match(admin, /Absent and excused count as not attended\./);
    } finally {
      await f.cleanup();
    }
  });
});

test("the admin overview names each Open link by its class, labels its pages, and offers a way out of an empty filter", { skip }, async () => {
  await withClient(async (c) => {
    const f = fixture(c, tag("prog"));
    try {
      const w = await world(f, tag("a1"));
      as(w.padmin, "programme_admin");
      const one = await pageOutcome(overviewPage, { searchParams: Promise.resolve({ school: w.s1 }) });
      const html = (one as { html: string }).html;
      for (const grade of [5, 6, 7]) {
        assert.match(html, new RegExp(`<a [^>]*href="/progress/students/[0-9a-f-]+"[^>]*aria-label="Open Grade ${grade}"[^>]*>Open</a>|<a [^>]*aria-label="Open Grade ${grade}"[^>]*href="/progress/students/[0-9a-f-]+"[^>]*>Open</a>`));
      }

      // A school outside the district asked for: nothing matches, and the page says what to do.
      const none = await pageOutcome(overviewPage, { searchParams: Promise.resolve({ district: w.d2, school: w.s1 }) });
      const emptyHtml = (none as { html: string }).html;
      assert.match(visible(emptyHtml), /No schools match this filter\./);
      assert.match(emptyHtml, /<a [^>]*href="\/progress\/students"[^>]*>Show all schools</);

      // Past one page of schools, the page links are a labelled navigation.
      await c.query(
        `INSERT INTO schools (zone_id, name, code)
         SELECT $1, 'Pg ' || n || ' ' || $2, 'Q' || lpad(n::text, 2, '0') || $3 FROM generate_series(1, 26) AS n`,
        [w.z1, tag("a1"), tag("a1").replace(/[^a-z0-9]/gi, "").slice(-10).toUpperCase()],
      );
      f.defer(`DELETE FROM schools WHERE zone_id = $1 AND name LIKE 'Pg %'`, [w.z1]);
      // Only schools with classes are cards, and so only they are paged.
      await c.query(
        `INSERT INTO classes (school_id, grade, stage)
         SELECT id, 4, 'Primary' FROM schools WHERE zone_id = $1 AND name LIKE 'Pg %'`,
        [w.z1],
      );
      f.defer(`DELETE FROM classes WHERE school_id IN (SELECT id FROM schools WHERE zone_id = $1 AND name LIKE 'Pg %')`, [w.z1]);
      const paged = await pageOutcome(overviewPage, { searchParams: Promise.resolve({ district: w.d1 }) });
      assert.match((paged as { html: string }).html, /<nav [^>]*aria-label="Pages of schools"/);
    } finally {
      await f.cleanup();
    }
  });
});

test("her page is audited as the other student lists are, and refuses everyone but a teacher", { skip }, async () => {
  await withClient(async (c) => {
    const f = fixture(c, tag("prog"));
    try {
      const w = await world(f, tag("au"));
      as(w.t1User, "teacher");
      await teacherHtml();
      const rows = await auditRows(c, w.t1User, "teaching.students.viewed", `metadata->>'page' = 'progress'`);
      assert.equal(rows.length, 1, "one view, one audit row");
      assert.equal(rows[0]!.entity_type, "teacher");
      assert.equal(rows[0]!.entity_id, w.t1);
      assert.equal(rows[0]!.metadata.rowCount, 6, "the names she was shown");
      assert.deepEqual(Object.keys(rows[0]!.metadata).sort(), ["page", "rowCount"]);
      assert.ok(!JSON.stringify(rows).includes("Angmo"), "no names in the audit row");
      const line = DOC.split("\n").find((l) => l.startsWith("| `teaching.students.viewed` |"));
      assert.ok(line?.includes("/teaching/progress"), "docs/audit-actions.md says this page writes it");

      // A teacher account with no teachers row is told, and nothing is audited.
      as(w.loneUser, "teacher");
      assert.match(visible(await teacherHtml()), /Your teacher record is not set up yet/);
      assert.equal((await c.query(`SELECT 1 FROM audit_log WHERE user_id = $1 AND action = 'teaching.students.viewed'`, [w.loneUser])).rowCount, 0);

      // Other roles belong on the admin page, or nowhere.
      for (const [id, role] of [[w.padmin, "programme_admin"], [w.sadmin, "super_admin"], [w.mentor, "mentor"], [w.observer, "observer"]] as const) {
        as(id, role);
        const r = await pageOutcome(teacherPage, { searchParams: Promise.resolve({}) });
        assert.deepEqual(r, { kind: "redirect", location: "/forbidden" }, `${role} is turned away from the teacher's page`);
      }
    } finally {
      await f.cleanup();
    }
  });
});

test("the admin overview is for programme and super admins, and shows schools, classes and figures without names", { skip }, async () => {
  await withClient(async (c) => {
    const f = fixture(c, tag("prog"));
    try {
      const w = await world(f, tag("ao"));
      for (const [id, role] of [[w.padmin, "programme_admin"], [w.sadmin, "super_admin"]] as const) {
        as(id, role);
        const r = await pageOutcome(overviewPage, { searchParams: Promise.resolve({ school: w.s1 }) });
        assert.equal(r.kind, "returned", role);
        const html = (r as { html: string }).html;
        const text = visible(html);
        assert.match(text, /Student progress/);
        assert.ok(text.includes(w.alpha), "the school is named");
        // Classes link to their own page; the figures are the class's.
        assert.ok(html.includes(`/progress/students/${w.c5}`));
        assert.ok(html.includes(`/progress/students/${w.c6}`));
        assert.ok(!html.includes(`/progress/students/${w.c8}`), "the retired class is not offered");
        assert.match(text, /4 of 5/);
        assert.match(text, /64%/);
        assert.match(text, /67\.9%/);
        // The overview is counts: no student is named on it, so it writes no learner audit.
        for (const name of ["Angmo", "Bilal", "Chosdol", "Deskit", "Gyalpo", "Hishey"]) assert.doesNotMatch(text, new RegExp(name));
      }
      assert.equal((await c.query(`SELECT 1 FROM audit_log WHERE user_id = $1 AND action IN ('learners.view', 'teaching.students.viewed')`, [w.padmin])).rowCount, 0);

      // A district and zone narrow it; the picker is the RTT one.
      as(w.padmin, "programme_admin");
      const d2 = await pageOutcome(overviewPage, { searchParams: Promise.resolve({ district: w.d2 }) });
      const d2Text = visible((d2 as { html: string }).html);
      assert.ok(d2Text.includes(w.gamma));
      assert.ok(!d2Text.includes(w.alpha), "another district's school is not shown");
      // A malformed filter is ignored, not a 500.
      assert.equal((await pageOutcome(overviewPage, { searchParams: Promise.resolve({ district: "x'; drop", school: "nope", page: "-3" }) })).kind, "returned");

      // Nobody else.
      for (const [id, role] of [[w.t1User, "teacher"], [w.mentor, "mentor"], [w.observer, "observer"]] as const) {
        as(id, role);
        assert.deepEqual(await pageOutcome(overviewPage, { searchParams: Promise.resolve({}) }), { kind: "redirect", location: "/forbidden" }, role);
      }
    } finally {
      await f.cleanup();
    }
  });
});

test("an admin opens one class and sees its students; the view is audited; nobody else may", { skip }, async () => {
  await withClient(async (c) => {
    const f = fixture(c, tag("prog"));
    try {
      const w = await world(f, tag("ac"));
      as(w.padmin, "programme_admin");
      const r = await pageOutcome(classPage, { params: Promise.resolve({ classId: w.c5 }), searchParams: Promise.resolve({}) });
      assert.equal(r.kind, "returned");
      const html = (r as { html: string }).html;
      const text = visible(html);
      for (const name of ["Angmo", "Bilal", "Chosdol", "Deskit", "Gyalpo"]) assert.match(text, new RegExp(name));
      for (const name of ["Eshay", "Fatima", "Hishey", "Jigmet"]) assert.doesNotMatch(text, new RegExp(name));
      assert.match(text, /50% \(2 of 4 sessions\)/, "Angmo across every teacher's sessions");
      assert.match(text, /4 of 5/);
      assert.match(text, /64%/);
      assert.equal((html.match(/>Low attendance</g) ?? []).length, 2);
      assert.match(text, /present or late/);

      const rows = await auditRows(c, w.padmin, "learners.view", `entity_id = '${w.c5}'`);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.entity_type, "class");
      assert.equal(rows[0]!.metadata.route, "/progress/students/[classId]");
      assert.deepEqual(Object.keys(rows[0]!.metadata).sort(), ["grade", "route", "schoolId"]);
      const line = DOC.split("\n").find((l) => l.startsWith("| `learners.view` |"));
      assert.ok(line?.includes("/progress/students"), "docs/audit-actions.md says this page writes it");

      // Unknown ids are 404, not a Postgres error.
      assert.deepEqual(await pageOutcome(classPage, { params: Promise.resolve({ classId: "not-a-uuid" }), searchParams: Promise.resolve({}) }), { kind: "notFound" });
      assert.deepEqual(
        await pageOutcome(classPage, { params: Promise.resolve({ classId: "0c7ce1a2-12e4-4839-8f46-a57bfad08006" }), searchParams: Promise.resolve({}) }),
        { kind: "notFound" },
      );

      // Lowest attendance first here too (Chosdol 0%, Angmo 50%, then the two at 100% in roll order, the unmarked last).
      const worst = visible(
        ((await pageOutcome(classPage, { params: Promise.resolve({ classId: w.c5 }), searchParams: Promise.resolve({ sort: "attendance" }) })) as { html: string }).html,
      );
      const order = ["Chosdol", "Angmo", "Bilal", "Deskit", "Gyalpo"].map((n) => worst.indexOf(n));
      assert.deepEqual(order, [...order].sort((a, b) => a - b));
      // A super admin may open it as well.
      as(w.sadmin, "super_admin");
      assert.equal((await pageOutcome(classPage, { params: Promise.resolve({ classId: w.c5 }), searchParams: Promise.resolve({}) })).kind, "returned");

      // A teacher, even of this very class, a mentor and an observer are turned away: no role is widened.
      for (const [id, role] of [[w.t1User, "teacher"], [w.mentor, "mentor"], [w.observer, "observer"]] as const) {
        as(id, role);
        assert.deepEqual(await pageOutcome(classPage, { params: Promise.resolve({ classId: w.c5 }), searchParams: Promise.resolve({}) }), { kind: "redirect", location: "/forbidden" }, role);
      }
      assert.equal((await c.query(`SELECT 1 FROM audit_log WHERE user_id = ANY($1) AND action = 'learners.view'`, [[w.t1User, w.mentor, w.observer]])).rowCount, 0);
    } finally {
      await f.cleanup();
    }
  });
});

test("the pages render in Hindi and fit a phone", { skip }, async () => {
  await withClient(async (c) => {
    const f = fixture(c, tag("prog"));
    try {
      const w = await world(f, tag("ui"));
      request.locale = "hi";
      try {
        as(w.t1User, "teacher");
        assert.match(visible(await teacherHtml()), /विद्यार्थी प्रगति/);
        as(w.padmin, "programme_admin");
        const overview = await pageOutcome(overviewPage, { searchParams: Promise.resolve({ school: w.s1 }) });
        assert.match(visible((overview as { html: string }).html), /विद्यार्थी प्रगति/);
      } finally {
        request.locale = "en";
      }

      request.cookies = { "gml-device": "mobile" };
      try {
        as(w.t1User, "teacher");
        assert.deepEqual(await phoneLayoutIssues(await teacherHtml()), [], "the teacher's page fits a phone");
        as(w.padmin, "programme_admin");
        const overview = await pageOutcome(overviewPage, { searchParams: Promise.resolve({ school: w.s1 }) });
        assert.deepEqual(await phoneLayoutIssues((overview as { html: string }).html), [], "the overview fits a phone");
        const one = await pageOutcome(classPage, { params: Promise.resolve({ classId: w.c5 }), searchParams: Promise.resolve({}) });
        assert.deepEqual(await phoneLayoutIssues((one as { html: string }).html), [], "a class fits a phone");
      } finally {
        request.cookies = {};
      }
    } finally {
      await f.cleanup();
    }
  });
});

// ── The way in ───────────────────────────────────────────────────────────────

test("the teacher's menu and the admins' menu link to it, and nobody else's does", async () => {
  const { NAV_BY_ROLE } = await import(`${WEB}/config/nav.ts`);
  const hrefs = (role: string) => (NAV_BY_ROLE[role] as Array<{ items: Array<{ href: string }> }>).flatMap((s) => s.items.map((i) => i.href));
  assert.ok(hrefs("teacher").includes("/teaching/progress"));
  assert.ok(hrefs("programme_admin").includes("/progress/students"));
  assert.ok(hrefs("super_admin").includes("/progress/students"));
  for (const role of ["mentor", "observer"]) {
    assert.ok(!hrefs(role).some((h) => h.includes("progress/students") || h === "/teaching/progress"), `${role} has no way in`);
  }
});

test("/progress is gated to admins in the proxy as /admin is, and the new pages are routable for the breadcrumbs", () => {
  const proxy = readFileSync(new URL(`${WEB}/proxy.ts`, import.meta.url), "utf8");
  assert.match(proxy, /\{ prefix: "\/progress", roles: \["programme_admin", "super_admin"\] \}/);
  const crumbs = readFileSync(new URL(`${WEB}/components/nav/Breadcrumbs.tsx`, import.meta.url), "utf8");
  for (const route of ["/teaching/progress", "/progress/students", "/progress/students/[classId]"]) {
    assert.ok(crumbs.includes(`"${route}"`), `${route} is in ROUTABLE`);
  }
});

// QA on the live site, 9 Oct 2026: "Student progress is empty". It was not: of
// 14 schools, 13 had no classes yet and filled the screen with "No classes at
// this school yet", and the one school with data was 12th, under them. Schools
// with classes now come first and are the only ones paged; the rest are named
// once, together, at the end.
test("the overview pages only schools that have classes, and names the others once, after them", { skip }, async () => {
  await withClient(async (c) => {
    const f = fixture(c, tag("prog"));
    try {
      const w = await world(f, tag("nocls"));
      const code = tag("nc").replace(/[^a-z0-9]/gi, "").slice(-8).toUpperCase();
      const empty1 = await f.row("schools", { zone_id: w.z2, name: `Aaa empty ${code}`, code: `E1${code}`.slice(0, 16) });
      const empty2 = await f.row("schools", { zone_id: w.z2, name: `Zzz empty ${code}`, code: `E2${code}`.slice(0, 16) });
      const { db } = await dbModule();
      const p = await progressLib();
      const place = (districtId: string) => ({ districtId, districtName: "", zoneId: null, zoneName: null });

      const d2 = await p.programmeProgress(db, { place: place(w.d2) });
      assert.deepEqual(d2.schools.map((s: { id: string }) => s.id), [w.s2], "only the school with a class is a card, although 'Aaa empty' sorts first");
      assert.equal(d2.total, 1, "pages count schools with classes");
      assert.deepEqual(
        d2.withoutClasses.map((s: { id: string }) => s.id),
        [empty1, empty2],
        "the schools with no classes, by name",
      );

      // Choosing one school with no classes says so, rather than showing nothing.
      const one = await p.programmeProgress(db, { schoolId: empty1 });
      assert.deepEqual(one.schools, []);
      assert.deepEqual(one.withoutClasses.map((s: { id: string }) => s.id), [empty1]);
    } finally {
      await f.cleanup();
    }
  });
});
