// A learner's progress through RTT, and who can see it, rendered for real.
//
// ── THE DEFECT (F36) ─────────────────────────────────────────────────────────
//
// Nothing recorded or showed a teacher's progress through RTT content. No table
// held lesson or reading completion, the subject page's "Resume" always jumped
// to the first module, and a teacher never saw her own attendance. On the staff
// side, quiz_submissions was read only by the learner's own result pages and a
// dashboard counter, and rtt_attendance only by the super_admin grid: no
// programme admin or mentor could see who sat or passed an assessment, or who
// attended a session, short of SQL.
//
// ── HOW ──────────────────────────────────────────────────────────────────────
//
// The REAL subject page, its REAL server action and the REAL /rtt/progress
// page, through the app's own @gml/db pool, for users of a small committed
// programme (./_rtt-world.ts). Only auth() is stubbed.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { signIn, closeAppDb, outcome, form, type TestUser } from "./_server-actions.js";
import { render, withAppRouter, openingTags, attr, decodeEntities } from "./_ui.js";
import { needsDatabase } from "./_harness.js";
import { rttWorld } from "./_rtt-world.js";

const skip = needsDatabase();
after(closeAppDb);

const subjectPage = () => import("../../apps/web/src/app/(authenticated)/rtt/subject/[id]/page.tsx");
const subjectActions = () => import("../../apps/web/src/app/(authenticated)/rtt/subject/[id]/actions.ts");
const progressPage = () => import("../../apps/web/src/app/(authenticated)/rtt/progress/page.tsx");

// What a reader sees: React's <!-- --> text-node separators are not text, and
// every tag boundary is.
const text = (html: string) =>
  decodeEntities(html.replace(/<!-- -->/g, "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ");

async function renderSubject(user: TestUser, id: string, sp: Record<string, string> = {}): Promise<string> {
  signIn(user);
  const { default: RttSubjectPage } = await subjectPage();
  return render(
    withAppRouter(await RttSubjectPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve(sp) })),
  );
}

async function renderProgress(user: TestUser, sp: Record<string, string> = {}): Promise<string> {
  signIn(user);
  const { default: RttProgressPage } = await progressPage();
  return render(withAppRouter(await RttProgressPage({ searchParams: Promise.resolve(sp) })));
}

/** The text of every table row on the page. */
const rows = (html: string) => [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => text(m[1]!).trim());

/** The one table row that mentions every one of `parts`. */
function rowWith(html: string, ...parts: string[]): string | undefined {
  return rows(html).find((r) => parts.every((p) => r.includes(p)));
}

/** The Resume button's href. */
function resumeHref(html: string): string {
  const m = html.match(/<a\b[^>]*>\s*Resume\s*<\/a>/);
  assert.ok(m, "the Resume button");
  return attr(m[0], "href") ?? "";
}

/** The hidden fields of every progress form on the page, as "kind:id:done". */
function progressForms(html: string): string[] {
  return [...html.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/g)]
    .map((m) => {
      const fields = Object.fromEntries(
        openingTags(m[1]!, "input").map((t) => [attr(t, "name") ?? "", attr(t, "value") ?? ""]),
      );
      return fields.kind ? `${fields.kind}:${fields.itemId}:${fields.done}` : "";
    })
    .filter(Boolean);
}

async function mark(user: TestUser, kind: "lesson" | "reading", itemId: string, done: boolean) {
  signIn(user);
  const { markProgressAction } = await subjectActions();
  return outcome(() => markProgressAction(form({ kind, itemId, done: String(done) })));
}

test("F36: a teacher marks lessons and readings done, and Resume follows her progress", { skip }, async () => {
  const w = await rttWorld("f36-mark");
  try {
    const s = await w.subject();
    const m1 = await w.module(s, 1);
    const m2 = await w.module(s, 2);
    const l1 = await w.lesson(m1, 1);
    const l2 = await w.lesson(m1, 2);
    const l3 = await w.lesson(m2, 1);
    const r1 = await w.reading(s, 1);

    let page = await renderSubject(w.teacher, s);
    const forms = progressForms(page);
    for (const id of [l1, l2, l3]) {
      assert.ok(forms.includes(`lesson:${id}:true`), `every lesson offers "Mark done" (forms: ${JSON.stringify(forms)})`);
    }
    assert.ok(forms.includes(`reading:${r1}:true`), "every reading offers to be marked read");
    assert.match(resumeHref(page), /#module-1$/, "nothing done yet: the first module");

    const done1 = await mark(w.teacher, "lesson", l1, true);
    assert.deepEqual(done1, { kind: "redirect", location: `/rtt/subject/${s}?open=1#module-1` }, "back to the module");
    await mark(w.teacher, "lesson", l2, true);
    // Marking twice is not an error and not a second row.
    await mark(w.teacher, "lesson", l2, true);
    await mark(w.teacher, "reading", r1, true);
    const { rows } = await w.c.query(`SELECT count(*)::int AS n FROM rtt_progress WHERE user_id = $1`, [w.teacher.id]);
    assert.equal(rows[0].n, 3, "one row per lesson or reading done");

    page = await renderSubject(w.teacher, s);
    assert.match(resumeHref(page), /#module-2$/, "module 1 is done, so Resume moves on");
    const after = progressForms(page);
    assert.ok(after.includes(`lesson:${l1}:false`), "a done lesson offers to undo it");
    assert.ok(after.includes(`reading:${r1}:false`));
    assert.match(text(page), /2\/2 lessons/, "the module shows how far she is");
    assert.match(text(page), /Lessons 2 of 3/, "and the subject's own summary");

    await mark(w.teacher, "lesson", l2, false);
    page = await renderSubject(w.teacher, s);
    assert.match(resumeHref(page), /#module-1$/, "undone: module 1 is where she is again");

    // Another learner's page is her own.
    const other = await w.user("Other", "teacher");
    const theirs = await renderSubject(other, s);
    assert.ok(progressForms(theirs).includes(`lesson:${l1}:true`), "progress is per learner");
  } finally {
    await w.cleanup();
  }
});

test("F36: the progress action refuses what is not a lesson or reading, and a signed-out caller", { skip }, async () => {
  const w = await rttWorld("f36-refuse");
  try {
    const s = await w.subject();
    const l1 = await w.lesson(await w.module(s, 1), 1);
    assert.deepEqual(await mark(w.teacher, "lesson", "not-a-uuid", true), { kind: "notFound" });
    assert.deepEqual(await mark(w.teacher, "reading", l1, true), { kind: "notFound" }, "a lesson id is not a reading");
    signIn(null);
    const { markProgressAction } = await subjectActions();
    assert.deepEqual(
      await outcome(() => markProgressAction(form({ kind: "lesson", itemId: l1, done: "true" }))),
      { kind: "redirect", location: "/login" },
    );
    const { rows } = await w.c.query(`SELECT count(*)::int AS n FROM rtt_progress WHERE rtt_lesson_id = $1`, [l1]);
    assert.equal(rows[0].n, 0);
  } finally {
    await w.cleanup();
  }
});

test("F36: a teacher sees her own attendance on the subject page and her progress on /rtt/progress", { skip }, async () => {
  const w = await rttWorld("f36-mine");
  try {
    const s = await w.subject({ name: `Mine ${w.T}` });
    const m1 = await w.module(s, 1);
    const l1 = await w.lesson(m1, 1);
    await w.lesson(m1, 2);
    await w.reading(s, 1);
    const s1 = await w.session(s, { sequence: 1, title: `Webinar one ${w.T}`, scheduledAt: new Date(Date.now() - 86_400_000) });
    const s2 = await w.session(s, { sequence: 2, title: `Webinar two ${w.T}`, scheduledAt: new Date(Date.now() - 3_600_000) });
    await w.c.query(
      `INSERT INTO rtt_attendance (rtt_session_id, teacher_id, status) VALUES ($1, $3, 'present'), ($2, $3, 'absent')`,
      [s1, s2, w.teacherId],
    );
    const q = await w.quiz(s);
    await w.quiz(s);
    await w.submission(q.id, w.teacher.id, 75, true);
    await mark(w.teacher, "lesson", l1, true);

    const page = text(await renderSubject(w.teacher, s));
    assert.match(page, new RegExp(`Webinar one ${w.T}.{0,120}Present`), "her attendance on the session row");
    assert.match(page, new RegExp(`Webinar two ${w.T}.{0,120}Absent`));

    signIn(w.teacher);
    const { default: RttIndexPage } = await import("../../apps/web/src/app/(authenticated)/rtt/page.tsx");
    const hub = await render(withAppRouter(await RttIndexPage({ searchParams: Promise.resolve({}) })));
    assert.ok(
      openingTags(hub, "a").some((t) => attr(t, "href") === "/rtt/progress"),
      "the RTT hub leads to it",
    );

    const mine = text(await renderProgress(w.teacher));
    const at = mine.indexOf(`Mine ${w.T}`);
    assert.ok(at >= 0, `her subject is on /rtt/progress: ${mine.slice(0, 400)}`);
    const row = mine.slice(at, at + 200);
    assert.match(row, /1\/2 lessons/);
    assert.match(row, /0\/1 readings/);
    assert.match(row, /1\/2 quizzes passed/);
    assert.match(row, /1\/2 sessions attended/);
  } finally {
    await w.cleanup();
  }
});

test("F36: staff see quiz results and attendance -- an admin everyone's, a mentor only her mentees' behind the mentorship password", { skip }, async () => {
  const w = await rttWorld("f36-staff");
  try {
    const s = await w.subject({ name: `Staff subject ${w.T}` });
    const q = await w.quiz(s, { title: `Staff quiz ${w.T}` });
    const other = await w.addTeacher("Unpaired");
    await w.submission(q.id, w.teacher.id, 40, false);
    await w.submission(q.id, w.teacher.id, 85, true);
    await w.submission(q.id, other.user.id, 30, false);
    const sess = await w.session(s, { sequence: 1, title: `Staff webinar ${w.T}`, scheduledAt: new Date() });
    await w.c.query(
      `INSERT INTO rtt_attendance (rtt_session_id, teacher_id, status) VALUES ($1, $2, 'present'), ($1, $3, 'excused')`,
      [sess, w.teacherId, other.teacherId],
    );
    const mentee = `Teacher Row ${w.T}`;
    const unpaired = `Unpaired Row ${w.T}`;
    const quiz = `Staff quiz ${w.T}`;
    const webinar = `Staff webinar ${w.T}`;

    const admin = await renderProgress(w.admin, { subject: s });
    const best = rowWith(admin, mentee, quiz);
    assert.ok(best, `admin sees her result (rows: ${JSON.stringify(rows(admin))})`);
    assert.match(best, /\b2\b.*85%.*Passed/, "two attempts, her best, passed");
    assert.match(rowWith(admin, unpaired, quiz) ?? "", /\b1\b.*30%/, "and every other teacher's");
    assert.doesNotMatch(rowWith(admin, unpaired, quiz) ?? "", /Passed/);
    assert.match(rowWith(admin, mentee, webinar) ?? "", /Present/, "attendance too");
    assert.match(rowWith(admin, unpaired, webinar) ?? "", /Excused/);

    const locked = await renderProgress(w.mentor, { subject: s });
    assert.ok(!text(locked).includes(mentee), "mentees are mentorship rows: nothing without the section password");
    assert.match(text(locked), /Unlock mentorship/i);

    await w.grant(w.mentor.id, "mentorship");
    const mentor = await renderProgress(w.mentor, { subject: s });
    assert.match(rowWith(mentor, mentee, quiz) ?? "", /85%/, "her mentee's result");
    assert.ok(!text(mentor).includes(unpaired), "not a teacher she does not mentor");

    const teacher = text(await renderProgress(w.teacher));
    assert.ok(!teacher.includes(unpaired), "a teacher sees nobody else's results");
    assert.ok(!teacher.includes("Quiz results"), "and no staff view");
  } finally {
    await w.cleanup();
  }
});
