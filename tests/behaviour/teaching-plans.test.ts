// Lesson plans (/teaching/plans, /teaching/plans/[id]): a teacher's own course
// outlines and their lessons, the programme's curriculum she starts from, and
// the approval that locks a plan.
//
// Executed: the real server actions and pages, signed in as each role,
// against Postgres. What is checked:
//   - she creates a plan (a draft she owns), one per subject, grade and term;
//     adds, edits, reorders and deletes lessons, and sessions_count follows;
//   - "Start my plan from this outline" copies a programme outline and its
//     lessons into a new plan of hers; a programme outline is never changed;
//   - another teacher can neither read (404) nor change her plan;
//   - sending it for approval needs a lesson, and locks every change while
//     pending; changes requested unlock it and her page and the hub show the
//     approver's comment;
//   - a programme admin reads it, read-only; a mentor is turned away;
//   - the plan page renders in Bhoti.

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

type State = { error?: string; ok?: string } | undefined;
type Action = (prev: unknown, fd: FormData) => Promise<State>;

async function world(f: Fixture, t: string) {
  const code = t.replace(/[^a-z0-9]/gi, "").slice(-10).toUpperCase();
  const district = await f.row("districts", { name: `D ${t}`, code: `D${code}` });
  const zone = await f.row("zones", { district_id: district, name: `Z ${t}` });
  const school = await f.row("schools", { zone_id: zone, name: `School ${t}`, code: `S${code}`.slice(0, 16) });
  const subject = await f.row("subjects", { name: `EVS ${t}`, code: `E${code}`.slice(0, 16) });
  const teacherUser = await f.user("teacher", "t1");
  const otherUser = await f.user("teacher", "t2");
  const padmin = await f.user("programme_admin", "pa");
  const mentor = await f.user("mentor", "m");
  const teacher = await f.row("teachers", { school_id: school, full_name: `Teacher ${t}`, user_id: teacherUser });
  const other = await f.row("teachers", { school_id: school, full_name: `Other ${t}`, user_id: otherUser });
  // A programme outline (no owner) with two lessons.
  const programme = await f.row("course_outlines", { subject_id: subject, grade: 4, term: 2, name: `Programme EVS ${t}`, weeks: 8 });
  f.defer(`DELETE FROM outline_lessons WHERE outline_id = $1`, [programme]);
  await c2(f, programme);
  // What the actions create, removed before the rows above (defers run last-registered first).
  f.defer(`DELETE FROM course_outlines WHERE owner_teacher_id = ANY($1)`, [[teacher, other]]);
  f.defer(`DELETE FROM outline_lessons WHERE outline_id IN (SELECT id FROM course_outlines WHERE owner_teacher_id = ANY($1))`, [[teacher, other]]);
  f.defer(`DELETE FROM approvals WHERE item_id IN (SELECT id FROM course_outlines WHERE owner_teacher_id = ANY($1))`, [[teacher, other]]);
  return { school, subject, teacherUser, otherUser, padmin, mentor, teacher, other, programme };
}

/** The programme outline's two lessons. */
async function c2(f: Fixture, outline: string) {
  await f.c.query(
    `INSERT INTO outline_lessons (outline_id, sequence, title, week, objectives, activities, materials)
     VALUES ($1, 1, 'Water around us', 1, 'Name sources of water', 'Walk to the stream', 'Chart paper'),
            ($1, 2, 'Saving water', 2, NULL, 'Group talk', NULL)`,
    [outline],
  );
}

const as = (id: string, role: string) => signIn({ id, role, name: null, email: null });

async function actions() {
  return (await import(`${APP}/plans/actions.ts`)) as Record<string, Action>;
}

async function planPage(id: string): Promise<{ kind: string; html?: string; location?: string }> {
  const { default: Page } = (await import(`${APP}/plans/[id]/page.tsx`)) as { default: (p: unknown) => Promise<unknown> };
  const r = await outcome(() => Page({ params: Promise.resolve({ id }) }));
  if (r.kind !== "returned") return r as { kind: string; location?: string };
  return { kind: "returned", html: await render(withAppRouter(r.value)) };
}

async function lessons(c: Client, outline: string) {
  return (await c.query(`SELECT id, sequence, title FROM outline_lessons WHERE outline_id = $1 ORDER BY sequence`, [outline])).rows as Array<{
    id: string;
    sequence: number;
    title: string;
  }>;
}

function documented(actionName: string): Set<string> {
  const line = DOC.split("\n").find((l) => l.startsWith(`| \`${actionName}\` |`));
  assert.ok(line, `${actionName} is missing from docs/audit-actions.md`);
  return new Set([...line.split("|")[3]!.matchAll(/`([A-Za-z_][A-Za-z0-9_]*)`/g)].map((m) => m[1]!));
}

test("a teacher keeps her own lesson plan: create, lessons, reorder, delete; nobody else may", { skip }, async () => {
  await withClient(async (c) => {
    const f = fixture(c, tag("teaching"));
    try {
      const w = await world(f, tag("tplan"));
      const a = await actions();

      as(w.teacherUser, "teacher");
      const created = await outcome(() =>
        a.createPlanAction!(undefined, form({ subjectId: w.subject, grade: "4", term: "1", name: "My EVS", weeks: "6", learningOutcomes: "Knows water\n\nSaves water" })),
      );
      assert.equal(created.kind, "redirect");
      const id = (created as { location: string }).location.split("/").pop()!;
      const [plan] = (await c.query(`SELECT owner_teacher_id, approval_status, learning_outcomes FROM course_outlines WHERE id = $1`, [id])).rows;
      assert.equal(plan.owner_teacher_id, w.teacher);
      assert.equal(plan.approval_status, "draft");
      assert.deepEqual(plan.learning_outcomes, ["Knows water", "Saves water"]);
      // One plan per subject, grade and term.
      assert.match(
        (await a.createPlanAction!(undefined, form({ subjectId: w.subject, grade: "4", term: "1", name: "Again" })))?.error ?? "",
        /already have a plan/,
      );

      for (const title of ["One", "Two", "Three"]) {
        assert.equal((await a.saveLessonAction!(undefined, form({ id, title, objectives: `${title} goal` })))?.error, undefined);
      }
      let ls = await lessons(c, id);
      assert.deepEqual(ls.map((l) => [l.sequence, l.title]), [[1, "One"], [2, "Two"], [3, "Three"]]);
      await a.moveLessonAction!(undefined, form({ id, lessonId: ls[2]!.id, direction: "up" }));
      await a.moveLessonAction!(undefined, form({ id, lessonId: ls[0]!.id, direction: "up" })); // already first: nothing
      ls = await lessons(c, id);
      assert.deepEqual(ls.map((l) => l.title), ["One", "Three", "Two"]);
      assert.equal((await a.saveLessonAction!(undefined, form({ id, lessonId: ls[1]!.id, title: "Three!", week: "2" })))?.error, undefined);
      assert.match((await a.saveLessonAction!(undefined, form({ id, title: "Bad week", week: "99" })))?.error ?? "", /1 to 52/);
      await a.deleteLessonAction!(undefined, form({ id, lessonId: ls[0]!.id }));
      ls = await lessons(c, id);
      assert.deepEqual(ls.map((l) => [l.sequence, l.title]), [[1, "Three!"], [2, "Two"]], "renumbered after a delete");
      assert.equal((await c.query(`SELECT sessions_count FROM course_outlines WHERE id = $1`, [id])).rows[0].sessions_count, 2);

      // Another teacher: not found, and nothing changes.
      as(w.otherUser, "teacher");
      assert.equal((await planPage(id)).kind, "notFound");
      for (const [name, fields] of [
        ["updatePlanAction", { id, subjectId: w.subject, grade: "4", term: "1", name: "Mine now" }],
        ["saveLessonAction", { id, title: "Sneaky" }],
        ["deleteLessonAction", { id, lessonId: ls[0]!.id }],
        ["moveLessonAction", { id, lessonId: ls[1]!.id, direction: "up" }],
        ["submitPlanAction", { id }],
        ["deletePlanAction", { id }],
      ] as const) {
        const r = await outcome(() => a[name]!(undefined, form(fields as Record<string, string>)));
        assert.equal(r.kind, "returned", name);
        assert.match(((r as { value: State }).value?.error) ?? "", /not found/, name);
      }
      assert.deepEqual((await lessons(c, id)).map((l) => l.title), ["Three!", "Two"]);
      assert.equal((await c.query(`SELECT name FROM course_outlines WHERE id = $1`, [id])).rows[0].name, "My EVS");

      // She deletes it, lessons and all.
      as(w.teacherUser, "teacher");
      assert.deepEqual(await outcome(() => a.deletePlanAction!(undefined, form({ id }))), { kind: "redirect", location: "/teaching/plans" });
      assert.equal((await c.query(`SELECT 1 FROM course_outlines WHERE id = $1`, [id])).rowCount, 0);

      const rows = (await c.query(`SELECT action, entity_type, metadata FROM audit_log WHERE user_id = $1 AND action LIKE 'teaching.%'`, [w.teacherUser]))
        .rows as Array<{ action: string; entity_type: string; metadata: Record<string, unknown> }>;
      assert.deepEqual(
        [...new Set(rows.map((r) => r.action))].sort(),
        ["teaching.lesson.deleted", "teaching.lesson.moved", "teaching.lesson.saved", "teaching.plan.created", "teaching.plan.deleted"],
      );
      assert.equal(rows.filter((r) => r.action === "teaching.lesson.moved").length, 1, "a move past the top writes nothing");
      for (const r of rows) for (const k of Object.keys(r.metadata)) assert.ok(documented(r.action).has(k), `${r.action}: ${k} undocumented`);
    } finally {
      await f.cleanup();
    }
  });
});

test("she starts her plan from the programme curriculum, sends it, and it locks until an approver sends it back", { skip }, async () => {
  const approvals = await import("../../apps/web/src/lib/approvals/index.ts");
  const { db } = await import("@gml/db");
  await withClient(async (c) => {
    const f = fixture(c, tag("teaching"));
    try {
      const w = await world(f, tag("tcopy"));
      f.defer(`DELETE FROM notifications WHERE entity_type = 'approval' AND entity_id IN (SELECT id::text FROM approvals WHERE item_id IN (SELECT id FROM course_outlines WHERE owner_teacher_id = $1))`, [w.teacher]);
      const a = await actions();
      as(w.teacherUser, "teacher");

      // The programme outline, read-only, with the way to start from it -- here in Bhoti.
      request.locale = "bo";
      try {
        const view = await planPage(w.programme);
        assert.equal(view.kind, "returned");
        assert.match(view.html!, /སྡོམ་གཞི་འདི་ལས་ངའི་འཆར་གཞི་འགོ་འཛུགས།/, "Start my plan from this outline, in Bhoti");
        assert.match(view.html!, /Water around us/);
        assert.doesNotMatch(view.html!, /name="title"/, "no lesson form on a programme outline");
      } finally {
        request.locale = "en";
      }
      // A programme outline is not hers to change.
      assert.match((await a.saveLessonAction!(undefined, form({ id: w.programme, title: "Mine" })))?.error ?? "", /not found/);

      const copied = await outcome(() => a.copyOutlineAction!(undefined, form({ sourceId: w.programme })));
      assert.equal(copied.kind, "redirect");
      const id = (copied as { location: string }).location.split("/").pop()!;
      const [plan] = (await c.query(`SELECT owner_teacher_id, grade, term, weeks, approval_status, sessions_count FROM course_outlines WHERE id = $1`, [id])).rows;
      assert.deepEqual(plan, { owner_teacher_id: w.teacher, grade: 4, term: 2, weeks: 8, approval_status: "draft", sessions_count: 2 });
      const mine = (await c.query(`SELECT sequence, title, objectives, activities FROM outline_lessons WHERE outline_id = $1 ORDER BY sequence`, [id])).rows;
      assert.deepEqual(mine, [
        { sequence: 1, title: "Water around us", objectives: "Name sources of water", activities: "Walk to the stream" },
        { sequence: 2, title: "Saving water", objectives: null, activities: "Group talk" },
      ]);
      assert.equal((await lessons(c, w.programme)).length, 2, "the programme outline is untouched");
      // Twice is refused: she already has that plan.
      assert.match((await a.copyOutlineAction!(undefined, form({ sourceId: w.programme })))?.error ?? "", /already have a plan/);
      // Another teacher's plan is not a source.
      as(w.otherUser, "teacher");
      assert.match((await a.copyOutlineAction!(undefined, form({ sourceId: id })))?.error ?? "", /not found/);

      // A plan with no lessons cannot be sent.
      as(w.teacherUser, "teacher");
      const empty = await outcome(() => a.createPlanAction!(undefined, form({ subjectId: w.subject, grade: "4", term: "3", name: "Empty" })));
      const emptyId = (empty as { location: string }).location.split("/").pop()!;
      assert.match((await a.submitPlanAction!(undefined, form({ id: emptyId })))?.error ?? "", /at least one lesson/);

      // Sent: pending, and every change is refused.
      assert.match((await a.submitPlanAction!(undefined, form({ id, note: "Adapted for my class" })))?.ok ?? "", /Sent for approval/);
      assert.equal((await c.query(`SELECT approval_status FROM course_outlines WHERE id = $1`, [id])).rows[0].approval_status, "pending");
      const [lesson] = await lessons(c, id);
      for (const [name, fields] of [
        ["updatePlanAction", { id, subjectId: w.subject, grade: "4", term: "2", name: "Changed" }],
        ["saveLessonAction", { id, title: "New" }],
        ["saveLessonAction", { id, lessonId: lesson!.id, title: "Edited" }],
        ["deleteLessonAction", { id, lessonId: lesson!.id }],
        ["moveLessonAction", { id, lessonId: lesson!.id, direction: "down" }],
        ["submitPlanAction", { id }],
        ["deletePlanAction", { id }],
      ] as const) {
        const r = await outcome(() => a[name]!(undefined, form(fields as Record<string, string>)));
        assert.equal(r.kind, "returned", name);
        assert.match(((r as { value: State }).value?.error) ?? "", /can no longer be changed/, `${name} is locked while pending`);
      }
      const locked = await planPage(id);
      assert.doesNotMatch(locked.html!, /name="title"/, "no lesson form while pending");
      assert.match(locked.html!, /Pending approval/);

      // The programme admin reads it, read-only; a mentor has no business here.
      as(w.padmin, "programme_admin");
      const admin = await planPage(id);
      assert.equal(admin.kind, "returned");
      assert.match(admin.html!, /as an approver/);
      assert.match(admin.html!, /href="\/approvals"/);
      assert.doesNotMatch(admin.html!, /name="title"|name="note"/);
      as(w.mentor, "mentor");
      assert.deepEqual(await planPage(id), { kind: "redirect", location: "/forbidden" });

      // Sent back with a comment: editable again, and she sees why -- on the plan and on the hub.
      const [pending] = (await c.query(`SELECT id FROM approvals WHERE item_id = $1 AND status = 'pending'`, [id])).rows;
      const back = await approvals.decideApproval(db as never, {
        approvalId: pending.id,
        decision: "changes_requested",
        comment: "Add a lesson on the water cycle",
        actor: { id: w.padmin, role: "programme_admin" },
      });
      assert.equal(back.ok, true);
      as(w.teacherUser, "teacher");
      // Her plan page and her plans list lay out at phone width, forms included.
      request.cookies = { "gml-device": "mobile" };
      try {
        assert.deepEqual(await phoneLayoutIssues((await planPage(id)).html!), [], "the plan page fits a phone");
        const { default: Plans } = (await import(`${APP}/plans/page.tsx`)) as { default: () => Promise<unknown> };
        const list = await outcome(() => Plans());
        assert.deepEqual(await phoneLayoutIssues(await render(withAppRouter((list as { value: unknown }).value))), [], "the plans list fits a phone");
      } finally {
        request.cookies = {};
      }
      const again = await planPage(id);
      assert.match(again.html!, /Add a lesson on the water cycle/);
      assert.match(again.html!, /name="title"/, "the lesson form is back");
      const { default: Hub } = (await import(`${APP}/page.tsx`)) as { default: () => Promise<unknown> };
      const hub = await outcome(() => Hub());
      const hubHtml = await render(withAppRouter((hub as { value: unknown }).value));
      assert.match(hubHtml, /Sent back to you \(1\)/);
      assert.match(hubHtml, /Add a lesson on the water cycle/);
      assert.match(hubHtml, new RegExp(`href="/teaching/plans/${id}"`));
      assert.equal((await a.saveLessonAction!(undefined, form({ id, title: "The water cycle" })))?.error, undefined);
    } finally {
      await f.cleanup();
    }
  });
});
