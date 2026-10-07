// A teacher's own classroom sessions (/teaching/sessions,
// /teaching/sessions/[id]): planning one, taking attendance, and sending it
// for approval, which locks the session and its attendance.
//
// Executed: the real server actions and pages, signed in as each role,
// against Postgres. What is checked:
//   - a session is planned for one of HER classes, with a lesson only from her
//     plans or the programme's outline for that subject and grade; it starts
//     as a draft, in the section her class link names;
//   - attendance is taken against her roster from the database (a learner id
//     the form adds is ignored, one it leaves out keeps its recorded mark, and
//     is refused when it has none); the session's
//     attended (present + late) and total counts and each student's
//     attendance % are written with it; "mark all present" marks everyone;
//   - another teacher gets 404 on the page and "not found" from every action;
//   - it is sent once it has happened (complete, with attendance) or was
//     cancelled; pending, the session and its attendance are locked;
//   - a programme admin reads it, read-only; a mentor is turned away;
//   - the pages render in Hindi and lay out at phone width, and the
//     dashboard's "My teaching" card links here.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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

type State = { error?: string; ok?: string } | undefined;
type Action = (prev: unknown, fd: FormData) => Promise<State>;

async function world(f: Fixture, t: string) {
  const code = t.replace(/[^a-z0-9]/gi, "").slice(-10).toUpperCase();
  const district = await f.row("districts", { name: `D ${t}`, code: `D${code}` });
  const zone = await f.row("zones", { district_id: district, name: `Z ${t}` });
  const school = await f.row("schools", { zone_id: zone, name: `School ${t}`, code: `S${code}`.slice(0, 16) });
  const maths = await f.row("subjects", { name: `Maths ${t}`, code: `M${code}`.slice(0, 16) });
  const english = await f.row("subjects", { name: `English ${t}`, code: `E${code}`.slice(0, 16) });
  const teacherUser = await f.user("teacher", "t1");
  const otherUser = await f.user("teacher", "t2");
  const padmin = await f.user("programme_admin", "pa");
  const mentor = await f.user("mentor", "m");
  const teacher = await f.row("teachers", { school_id: school, full_name: `Teacher ${t}`, user_id: teacherUser });
  const other = await f.row("teachers", { school_id: school, full_name: `Other ${t}`, user_id: otherUser });
  const five = await f.row("classes", { school_id: school, grade: 5, stage: "Primary" });
  const six = await f.row("classes", { school_id: school, grade: 6, stage: "Middle" });
  const link = await f.row("teacher_classes", { teacher_id: teacher, class_id: five, section: "A", subject_id: maths });
  const sixLink = await f.row("teacher_classes", { teacher_id: teacher, class_id: six });
  const otherLink = await f.row("teacher_classes", { teacher_id: other, class_id: six });
  const learner = (name: string, roll: string, section: string) =>
    f.row("learners", { class_id: five, school_id: school, grade: 5, name, roll_number: roll, section });
  const a1 = await learner("Angmo", "1", "A");
  const a2 = await learner("Bilal", "2", "A");
  const a3 = await learner("Chosdol", "3", "A");
  const b1 = await learner("Deskit", "4", "B");
  // Her plan (Maths, grade 5), another teacher's, and a programme outline for English.
  const mine = await f.row("course_outlines", { subject_id: maths, grade: 5, term: 1, name: `Her maths ${t}`, owner_teacher_id: teacher, approval_status: "draft" });
  const theirs = await f.row("course_outlines", { subject_id: maths, grade: 5, term: 1, name: `Their maths ${t}`, owner_teacher_id: other, approval_status: "draft" });
  const programme = await f.row("course_outlines", { subject_id: english, grade: 5, term: 1, name: `Programme English ${t}` });
  const lesson = await f.row("outline_lessons", { outline_id: mine, sequence: 1, title: "Fractions" });
  const theirLesson = await f.row("outline_lessons", { outline_id: theirs, sequence: 1, title: "Their fractions" });
  const englishLesson = await f.row("outline_lessons", { outline_id: programme, sequence: 1, title: "Stories" });
  // What the actions create, removed before the rows above (defers run last-registered first).
  f.defer(`DELETE FROM sessions WHERE teacher_id = ANY($1)`, [[teacher, other]]);
  f.defer(`DELETE FROM session_attendance WHERE session_id IN (SELECT id FROM sessions WHERE teacher_id = ANY($1))`, [[teacher, other]]);
  f.defer(`DELETE FROM approvals WHERE item_id IN (SELECT id FROM sessions WHERE teacher_id = ANY($1))`, [[teacher, other]]);
  f.defer(
    `DELETE FROM notifications WHERE entity_type = 'approval' AND entity_id IN (SELECT id::text FROM approvals WHERE item_id IN (SELECT id FROM sessions WHERE teacher_id = $1))`,
    [teacher],
  );
  return { school, maths, english, teacherUser, otherUser, padmin, mentor, teacher, other, five, six, link, sixLink, otherLink, a1, a2, a3, b1, lesson, theirLesson, englishLesson };
}

const as = (id: string, role: string) => signIn({ id, role, name: null, email: null });

async function actions() {
  return (await import(`${APP}/sessions/actions.ts`)) as Record<string, Action>;
}

async function sessionPage(id: string): Promise<{ kind: string; html?: string; location?: string }> {
  const { default: Page } = (await import(`${APP}/sessions/[id]/page.tsx`)) as { default: (p: unknown) => Promise<unknown> };
  const r = await outcome(() => Page({ params: Promise.resolve({ id }) }));
  if (r.kind !== "returned") return r as { kind: string; location?: string };
  return { kind: "returned", html: await render(withAppRouter(r.value)) };
}

async function listPage(): Promise<string> {
  const { default: Page } = (await import(`${APP}/sessions/page.tsx`)) as { default: () => Promise<unknown> };
  const r = await outcome(() => Page());
  assert.equal(r.kind, "returned");
  return render(withAppRouter((r as { value: unknown }).value));
}

async function counts(c: Client, id: string) {
  return (await c.query(`SELECT attended_count, total_count, approval_status FROM sessions WHERE id = $1`, [id])).rows[0];
}

const plan = (w: Awaited<ReturnType<typeof world>>, extra: Record<string, string> = {}) =>
  form({ linkId: w.link, subjectId: w.maths, date: "2026-09-28", time: "10:30", durationMin: "40", topic: "Halves and quarters", status: "planned", ...extra });

test("she plans a session for her class, takes attendance, sends it, and it locks", { skip }, async () => {
  await withClient(async (c) => {
    const f = fixture(c, tag("teaching"));
    try {
      const w = await world(f, tag("tses"));
      const a = await actions();
      as(w.teacherUser, "teacher");

      // What is not hers, or does not fit, is refused.
      assert.match((await a.createSessionAction!(undefined, plan(w, { date: "2026-02-30" })))?.error ?? "", /valid date/);
      assert.match((await a.createSessionAction!(undefined, plan(w, { time: "25:00" })))?.error ?? "", /valid time/);
      assert.match((await a.createSessionAction!(undefined, plan(w, { linkId: w.otherLink })))?.error ?? "", /one of your classes/);
      assert.match((await a.createSessionAction!(undefined, plan(w, { lessonId: w.theirLesson })))?.error ?? "", /Choose a lesson/);
      assert.match((await a.createSessionAction!(undefined, plan(w, { lessonId: w.englishLesson })))?.error ?? "", /Choose a lesson/, "a lesson of another subject");
      assert.match((await a.createSessionAction!(undefined, plan(w, { status: "done" })))?.error ?? "", /status/);

      const made = await outcome(() => a.createSessionAction!(undefined, plan(w, { lessonId: w.lesson, section: "C", notes: "Bring paper" })));
      assert.equal(made.kind, "redirect");
      const id = (made as { location: string }).location.split("/").pop()!;
      const [row] = (await c.query(`SELECT teacher_id, school_id, class_id, section, outline_lesson_id, approval_status, scheduled_time, notes FROM sessions WHERE id = $1`, [id])).rows;
      assert.deepEqual(row, {
        teacher_id: w.teacher,
        school_id: w.school,
        class_id: w.five,
        section: "A",
        outline_lesson_id: w.lesson,
        approval_status: "draft",
        scheduled_time: "10:30:00",
        notes: "Bring paper",
      });

      // Her page, in Hindi, and at phone width.
      request.locale = "hi";
      try {
        const hi = await sessionPage(id);
        assert.match(hi.html!, /उपस्थिति सहेजें/);
        assert.match(hi.html!, /Angmo/);
        assert.doesNotMatch(hi.html!, /Deskit/, "section B is not on her roster");
      } finally {
        request.locale = "en";
      }
      request.cookies = { "gml-device": "mobile" };
      try {
        const phone = await sessionPage(id);
        assert.deepEqual(await phoneLayoutIssues(phone.html!), [], "the session page fits a phone");
        assert.deepEqual(await phoneLayoutIssues(await listPage()), [], "the sessions list fits a phone");
      } finally {
        request.cookies = {};
      }

      // Attendance: the roster comes from the database, and every student on it must be marked
      // (a learner id the form adds is ignored; a student it leaves out is not guessed present --
      // tests/behaviour/teaching-attendance-roster.test.ts).
      const saved = await a.saveAttendanceAction!(
        undefined,
        form({
          id,
          [`status_${w.a1}`]: "absent",
          [`status_${w.a2}`]: "late",
          [`status_${w.a3}`]: "present",
          [`status_${w.b1}`]: "absent",
          [`status_${randomUUID()}`]: "absent",
        }),
      );
      assert.match(saved?.ok ?? "", /2 of 3 attended/);
      assert.deepEqual(await counts(c, id), { attended_count: 2, total_count: 3, approval_status: "draft" });
      const marks = (await c.query(`SELECT learner_id, status, marked_by_user_id FROM session_attendance WHERE session_id = $1`, [id])).rows;
      assert.deepEqual(
        Object.fromEntries(marks.map((m) => [m.learner_id, m.status])),
        { [w.a1]: "absent", [w.a2]: "late", [w.a3]: "present" },
      );
      assert.ok(marks.every((m) => m.marked_by_user_id === w.teacherUser));
      const pct = async (id: string) => (await c.query(`SELECT attendance_pct FROM learners WHERE id = $1`, [id])).rows[0].attendance_pct;
      assert.deepEqual([await pct(w.a1), await pct(w.a2), await pct(w.a3), await pct(w.b1)], [0, 100, 100, null]);
      assert.match((await a.saveAttendanceAction!(undefined, form({ id, intent: "all_present", [`status_${w.a1}`]: "absent" })))?.ok ?? "", /3 of 3/);
      assert.deepEqual(await counts(c, id), { attended_count: 3, total_count: 3, approval_status: "draft" });
      assert.equal(await pct(w.a1), 100);
      const [audit] = (await c.query(`SELECT metadata FROM audit_log WHERE user_id = $1 AND action = 'teaching.attendance.saved' ORDER BY created_at LIMIT 1`, [w.teacherUser])).rows;
      assert.deepEqual(audit.metadata, { present: 1, absent: 1, late: 1, excused: 0, attended: 2, total: 3 });
      const line = DOC.split("\n").find((l) => l.startsWith("| `teaching.attendance.saved` |"))!;
      for (const k of Object.keys(audit.metadata)) assert.ok(line.split("|")[3]!.includes(`\`${k}\``), `${k} is documented`);

      // Once attendance is taken the class stays.
      assert.match((await a.updateSessionAction!(undefined, plan(w, { id, linkId: w.sixLink })))?.error ?? "", /Attendance has been taken/);

      // A submission that lands between an edit's check and its write wins: the
      // edit waits on the session's row lock, then sees it pending and refuses.
      const pid = (await c.query(`SELECT pg_backend_pid() AS pid`)).rows[0].pid as number;
      await c.query("BEGIN");
      try {
        await c.query(`UPDATE sessions SET approval_status = 'pending' WHERE id = $1`, [id]);
        const racing = a.updateSessionAction!(undefined, plan(w, { id, topic: "Raced" }));
        let waiting = 0;
        for (let i = 0; i < 100 && waiting === 0; i++) {
          await new Promise((r) => setTimeout(r, 30));
          waiting = (
            await withClient((o) => o.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))`, [pid]))
          ).rows[0].n;
        }
        assert.ok(waiting > 0, "the edit is waiting on the row lock, past its first check");
        await c.query("COMMIT");
        assert.match((await racing)?.error ?? "", /can no longer be changed/);
      } catch (err) {
        await c.query("ROLLBACK").catch(() => undefined);
        throw err;
      }
      assert.equal((await c.query(`SELECT topic FROM sessions WHERE id = $1`, [id])).rows[0].topic, "Halves and quarters");
      await c.query(`UPDATE sessions SET approval_status = 'draft' WHERE id = $1`, [id]);

      // A cancelled session does not count towards a student's attendance %.
      assert.equal((await a.updateSessionAction!(undefined, plan(w, { id, status: "cancelled" })))?.error, undefined);
      assert.equal(await pct(w.a1), null, "her only session was cancelled");
      assert.equal((await a.updateSessionAction!(undefined, plan(w, { id, status: "planned" })))?.error, undefined);
      assert.equal(await pct(w.a1), 100);

      // Another teacher: 404, and not found from every action.
      as(w.otherUser, "teacher");
      assert.equal((await sessionPage(id)).kind, "notFound");
      for (const name of ["updateSessionAction", "saveAttendanceAction", "submitSessionAction"]) {
        assert.match((await a[name]!(undefined, plan(w, { id })))?.error ?? "", /not found/, name);
      }

      // Sent once it has happened.
      as(w.teacherUser, "teacher");
      assert.match((await a.submitSessionAction!(undefined, form({ id })))?.error ?? "", /complete or cancelled/);
      assert.equal((await a.updateSessionAction!(undefined, plan(w, { id, status: "complete", lessonId: w.lesson })))?.error, undefined);
      assert.match((await a.submitSessionAction!(undefined, form({ id, note: "All present" })))?.ok ?? "", /Sent for approval/);
      assert.equal((await counts(c, id)).approval_status, "pending");

      // Pending: the session and its attendance are locked.
      assert.match((await a.updateSessionAction!(undefined, plan(w, { id, topic: "Changed" })))?.error ?? "", /can no longer be changed/);
      assert.match((await a.saveAttendanceAction!(undefined, form({ id, [`status_${w.a1}`]: "absent" })))?.error ?? "", /can no longer be changed/);
      assert.deepEqual(await counts(c, id), { attended_count: 3, total_count: 3, approval_status: "pending" });
      const lockedPage = await sessionPage(id);
      assert.doesNotMatch(lockedPage.html!, /type="radio"/, "no attendance form while pending");
      assert.match(lockedPage.html!, /Pending approval/);

      // The programme admin reads it, attendance included, read-only; a mentor is turned away.
      as(w.padmin, "programme_admin");
      const admin = await sessionPage(id);
      assert.equal(admin.kind, "returned");
      assert.match(admin.html!, /as an approver/);
      assert.match(admin.html!, /Angmo/);
      assert.doesNotMatch(admin.html!, /type="radio"|name="note"|name="topic"/);
      as(w.mentor, "mentor");
      assert.deepEqual(await sessionPage(id), { kind: "redirect", location: "/forbidden" });
    } finally {
      request.cookies = {};
      await f.cleanup();
    }
  });
});

test("attendance comes first, a cancelled session has none, and her list splits upcoming from past", { skip }, async () => {
  await withClient(async (c) => {
    const f = fixture(c, tag("teaching"));
    try {
      const w = await world(f, tag("tses2"));
      const a = await actions();
      as(w.teacherUser, "teacher");
      const make = async (extra: Record<string, string>) => {
        const r = await outcome(() => a.createSessionAction!(undefined, plan(w, extra)));
        assert.equal(r.kind, "redirect", JSON.stringify(r));
        return (r as { location: string }).location.split("/").pop()!;
      };

      const done = await make({ status: "complete", date: "2001-01-01", topic: "Long ago" });
      assert.match((await a.submitSessionAction!(undefined, form({ id: done })))?.error ?? "", /Take attendance/);
      const cancelled = await make({ status: "cancelled", date: "2099-01-02", topic: "Snow day" });
      assert.match((await a.saveAttendanceAction!(undefined, form({ id: cancelled })))?.error ?? "", /cancelled/);
      assert.match((await a.submitSessionAction!(undefined, form({ id: cancelled })))?.ok ?? "", /Sent for approval/);
      await make({ status: "planned", date: "2099-01-01", topic: "Far future" });

      const html = await listPage();
      const up = html.indexOf("Upcoming (2)");
      const past = html.indexOf("Past (1)");
      assert.ok(up >= 0 && past > up, "two upcoming, then one past");
      assert.ok(html.indexOf("Far future") > up && html.indexOf("Far future") < html.indexOf("Snow day"), "upcoming soonest first");
      assert.ok(html.indexOf("Long ago") > past);
      assert.equal((await c.query(`SELECT count(*)::int AS n FROM sessions WHERE teacher_id = $1`, [w.teacher])).rows[0].n, 3);
    } finally {
      await f.cleanup();
    }
  });
});

test("the dashboard's My teaching card shows her counts and links to /teaching", { skip }, async () => {
  await withClient(async (c) => {
    const f = fixture(c, tag("teaching"));
    try {
      const w = await world(f, tag("tdash"));
      void c;
      as(w.teacherUser, "teacher");
      const { default: DashboardPage } = (await import("../../apps/web/src/app/(authenticated)/dashboard/page.tsx")) as {
        default: () => Promise<unknown>;
      };
      const html = await render(withAppRouter(await DashboardPage()));
      assert.match(html, /data-card="my-teaching"/);
      assert.match(html, /2 classes · 3 students · 1 lesson plan · 0 sessions/);
      assert.match(html, /href="\/teaching"/);
    } finally {
      await f.cleanup();
    }
  });
});
