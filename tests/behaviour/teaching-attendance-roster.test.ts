// The attendance roster on a teacher's session page does not guess.
//
// ── THE DEFECT ─────────────────────────────────────────────────────────────
//
// /teaching/sessions/[id] said "Attendance not taken yet" above a roster in
// which every student's Present radio was already selected, and the action
// marked any student the form left out as present. So one click on "Save
// attendance" recorded the whole class present and made the session look as if
// attendance had been taken. (Found in the 5 Oct 2026 QA of the teacher flows,
// D-5.)
//
// ── THE RULE ───────────────────────────────────────────────────────────────
//
// No radio is selected for a student with no recorded mark, and every group is
// `required`, so the browser stops a save with one left. The action refuses it
// too (a form is whatever the caller posts), naming how many students have no
// mark, and writes nothing. "Mark all present" is the explicit shortcut. A
// student who already has a mark keeps it. A cancelled session and a locked one
// (pending, approved) still refuse, and in that order.
//
// Executed: the real page and action, signed in as the teacher, on Postgres.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { openingTags, attr, render, withAppRouter } from "./_ui.js";
import { needsDatabase, withClient } from "./_harness.js";
import { form } from "./_admin-fixture.js";
import { closeAppDb, outcome } from "./_server-actions.js";
import { as, countsOf, marksOf, teachingWorld, type TeachingWorld } from "./_teaching-world.js";

const skip = needsDatabase();
after(async () => {
  if (!skip) await closeAppDb();
});

const APP = "../../apps/web/src/app/(authenticated)/teaching";
type State = { error?: string; ok?: string } | undefined;
type Action = (prev: unknown, fd: FormData) => Promise<State>;

const actions = async () => (await import(`${APP}/sessions/actions.ts`)) as Record<string, Action>;

async function sessionPage(id: string): Promise<{ kind: string; html?: string }> {
  const { default: Page } = (await import(`${APP}/sessions/[id]/page.tsx`)) as { default: (p: unknown) => Promise<unknown> };
  const r = await outcome(() => Page({ params: Promise.resolve({ id }) }));
  if (r.kind !== "returned") return r as { kind: string };
  return { kind: "returned", html: await render(withAppRouter(r.value)) };
}

/** The roster's radio inputs, by student id: which are checked, and whether the group is required. */
function radios(html: string, w: TeachingWorld) {
  const ids = new Map(Object.entries(w.roster).map(([name, id]) => [id, name]));
  const rows = openingTags(html, "input")
    .filter((tag) => attr(tag, "type") === "radio")
    .map((tag) => ({
      student: ids.get((attr(tag, "name") ?? "").replace("status_", "")),
      value: attr(tag, "value"),
      checked: / checked(=|\s|\/|>)/.test(tag),
      required: / required(=|\s|\/|>)/.test(tag),
    }));
  return rows;
}

async function inWorld(body: (w: TeachingWorld) => Promise<void>) {
  await withClient(async (c) => {
    const w = await teachingWorld(c, "tros");
    try {
      await body(w);
    } finally {
      await w.f.cleanup();
    }
  });
}

test("the roster offers no mark that was not recorded, and each student must be marked", { skip }, async () => {
  await inWorld(async (w) => {
    const id = await w.session();
    as(w.teacherUser, "teacher");

    const page = await sessionPage(id);
    const all = radios(page.html!, w);
    assert.equal(all.length, 5 * 4, "five students on her roster (section A), four marks each; Deskit is in section B");
    assert.deepEqual(all.filter((r) => r.checked), [], "nobody is pre-selected: attendance has not been taken");
    assert.ok(all.every((r) => r.required), "every radio group is required, so the browser stops a half-marked save");
    assert.doesNotMatch(page.html!, /Everyone starts as present/, "the hint no longer says so");
    assert.match(page.html!, /Attendance not taken yet/);

    // "Mark all present" is the explicit shortcut, so it must not be blocked by the required groups.
    const allPresent = openingTags(page.html!, "button").find((b) => attr(b, "value") === "all_present");
    assert.ok(allPresent && /formnovalidate/i.test(allPresent), "Mark all present skips the browser's required check");

    // A mark that was recorded is shown, and only that one.
    await w.c.query(`INSERT INTO session_attendance (session_id, learner_id, status) VALUES ($1, $2, 'late')`, [id, w.angmo]);
    const after = radios((await sessionPage(id)).html!, w);
    assert.deepEqual(
      after.filter((r) => r.checked).map((r) => [r.student, r.value]),
      [["angmo", "late"]],
    );
  });
});

test("Save attendance refuses while any student is unmarked, and writes nothing", { skip }, async () => {
  await inWorld(async (w) => {
    const id = await w.session();
    const a = await actions();
    as(w.teacherUser, "teacher");

    const three = form({ id, [`status_${w.angmo}`]: "present", [`status_${w.bilal}`]: "absent", [`status_${w.chosdol}`]: "late" });
    const refused = await a.saveAttendanceAction!(undefined, three);
    assert.match(refused?.error ?? "", /2 students have no attendance mark/, JSON.stringify(refused));
    assert.equal(refused?.ok, undefined);
    assert.deepEqual(await marksOf(w.c, id), {}, "not even the three that were marked: a half-saved roster is how a class gets 'present'");
    assert.deepEqual(await countsOf(w.c, id), { attended_count: 0, total_count: 0 });

    assert.match((await a.saveAttendanceAction!(undefined, form({ id })))?.error ?? "", /5 students have no attendance mark/);
    const one = await a.saveAttendanceAction!(
      undefined,
      form({ id, [`status_${w.angmo}`]: "present", [`status_${w.bilal}`]: "present", [`status_${w.chosdol}`]: "present", [`status_${w.tashi5}`]: "present" }),
    );
    assert.match(one?.error ?? "", /1 student has no attendance mark/, "singular when one is left");

    // A value that is not a mark counts as no mark; so does a learner who is not on the roster.
    const bogus = form({ id, [`status_${w.angmo}`]: "maybe", [`status_${w.deskit}`]: "present" });
    assert.match((await a.saveAttendanceAction!(undefined, bogus))?.error ?? "", /5 students have no attendance mark/);
    assert.deepEqual(await marksOf(w.c, id), {});
  });
});

test("with every student marked it saves, and a recorded mark is kept when the form leaves it out", { skip }, async () => {
  await inWorld(async (w) => {
    const id = await w.session();
    const a = await actions();
    as(w.teacherUser, "teacher");

    // Angmo was marked absent earlier (say, by a CSV); a post that omits her keeps that mark.
    await w.c.query(`INSERT INTO session_attendance (session_id, learner_id, status) VALUES ($1, $2, 'absent')`, [id, w.angmo]);
    const saved = await a.saveAttendanceAction!(
      undefined,
      form({
        id,
        [`status_${w.bilal}`]: "late",
        [`status_${w.chosdol}`]: "excused",
        [`status_${w.tashi5}`]: "present",
        [`status_${w.tashi6}`]: "absent",
      }),
    );
    assert.match(saved?.ok ?? "", /2 of 5 attended/, JSON.stringify(saved));
    assert.deepEqual(await marksOf(w.c, id), {
      [w.angmo]: "absent",
      [w.bilal]: "late",
      [w.chosdol]: "excused",
      [w.tashi5]: "present",
      [w.tashi6]: "absent",
    });
    assert.deepEqual(await countsOf(w.c, id), { attended_count: 2, total_count: 5 });

    // A saved mark can be changed: the form carries it, and a new value replaces it.
    const changed = await a.saveAttendanceAction!(
      undefined,
      form({
        id,
        [`status_${w.angmo}`]: "present",
        [`status_${w.bilal}`]: "late",
        [`status_${w.chosdol}`]: "excused",
        [`status_${w.tashi5}`]: "present",
        [`status_${w.tashi6}`]: "absent",
      }),
    );
    assert.match(changed?.ok ?? "", /3 of 5 attended/);
    assert.equal((await marksOf(w.c, id))[w.angmo], "present");
  });
});

test("Mark all present marks everyone, whatever else the form says", { skip }, async () => {
  await inWorld(async (w) => {
    const id = await w.session();
    const a = await actions();
    as(w.teacherUser, "teacher");

    const done = await a.saveAttendanceAction!(undefined, form({ id, intent: "all_present", [`status_${w.angmo}`]: "absent" }));
    assert.match(done?.ok ?? "", /5 of 5 attended/, JSON.stringify(done));
    assert.deepEqual(Object.values(await marksOf(w.c, id)), ["present", "present", "present", "present", "present"]);
    assert.deepEqual(await countsOf(w.c, id), { attended_count: 5, total_count: 5 });
  });
});

test("a cancelled session and a locked one still refuse, and say why", { skip }, async () => {
  await inWorld(async (w) => {
    const a = await actions();
    as(w.teacherUser, "teacher");
    const everyone = (id: string) =>
      form({ id, ...Object.fromEntries(Object.values(w.roster).map((l) => [`status_${l}`, "present"])) });

    const cancelled = await w.session({ status: "cancelled" });
    assert.match((await a.saveAttendanceAction!(undefined, everyone(cancelled)))?.error ?? "", /cancelled/);
    assert.match((await a.saveAttendanceAction!(undefined, form({ id: cancelled })))?.error ?? "", /cancelled/, "cancelled is said before 'unmarked'");
    assert.doesNotMatch((await sessionPage(cancelled)).html!, /type="radio"/);

    for (const state of ["pending", "approved"]) {
      const locked = await w.session({ approval_status: state });
      assert.match((await a.saveAttendanceAction!(undefined, form({ id: locked })))?.error ?? "", /can no longer be changed/, state);
      assert.match((await a.saveAttendanceAction!(undefined, everyone(locked)))?.error ?? "", /can no longer be changed/, state);
      assert.deepEqual(await marksOf(w.c, locked), {});
      assert.doesNotMatch((await sessionPage(locked)).html!, /type="radio"/, `no roster form while ${state}`);
    }

    // A colleague's session is not hers to mark.
    const theirs = await w.session({ teacher_id: w.other, class_id: w.six, section: null });
    assert.match((await a.saveAttendanceAction!(undefined, form({ id: theirs })))?.error ?? "", /not found/);
  });
});

test("a session with students left unmarked cannot be sent for approval", { skip }, async () => {
  await inWorld(async (w) => {
    const id = await w.session({ status: "complete" });
    const a = await actions();
    as(w.teacherUser, "teacher");

    assert.match((await a.submitSessionAction!(undefined, form({ id })))?.error ?? "", /Take attendance/);
    await w.c.query(`INSERT INTO session_attendance (session_id, learner_id, status) VALUES ($1, $2, 'present')`, [id, w.angmo]);
    assert.match((await a.submitSessionAction!(undefined, form({ id })))?.error ?? "", /Take attendance/, "one mark is not attendance for the class");

    await a.saveAttendanceAction!(undefined, form({ id, intent: "all_present" }));
    assert.match((await a.submitSessionAction!(undefined, form({ id })))?.ok ?? "", /Sent for approval/);
  });
});
