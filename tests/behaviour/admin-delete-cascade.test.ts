// A grid delete removes the row it was asked to remove, and nothing else.
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
//
// deleteRowAction and bulkDeleteAction issue one DELETE and leave the rest to
// the foreign keys, and most of those keys were ON DELETE CASCADE. So one
// confirmed click on "Delete" took a whole subtree of records with it:
//
//   schools / classes    -> learners (children's PII; learners is
//                           mutateRoles ['super_admin'], yet a programme_admin
//                           could empty it school by school)
//   rtt_sessions         -> rtt_attendance (super_admin-only as well)
//   mentor_pairings      -> mentor_meetings, feedback_responses
//   observation_cycles   -> observation_forms, observation_evidence
//
// The audit log recorded only the parent id, so what went with it could not
// even be listed afterwards.
//
// ── WHAT IS EXECUTED ─────────────────────────────────────────────────────────
//
// The grid's real server actions, as a real programme_admin (the @/auth stub
// answers with the session the test signs in), against Postgres. A refused
// delete must leave every dependent row where it was and send the operator back
// to the grid with an explanation.

import { test } from "node:test";
import assert from "node:assert/strict";
import "./_ui.js";
import { needsDatabase, withClient, tag } from "./_harness.js";
import { actAs, fixture, form, redirectOf, type Fixture } from "./_admin-fixture.js";

const skip = needsDatabase();

const actions = () =>
  import("../../apps/web/src/app/(authenticated)/admin/data/[entity]/actions.ts");

async function count(f: Fixture, table: string, id: string): Promise<number> {
  const { rows } = await f.c.query(`SELECT count(*)::int AS n FROM ${table} WHERE id = $1`, [id]);
  return rows[0].n as number;
}

/** A school with one class, one learner, and a teacher with RTT attendance and a mentor pairing. */
async function world(f: Fixture, t: string) {
  const district = await f.row("districts", { name: `D ${t}`, code: t.slice(-12) });
  const zone = await f.row("zones", { district_id: district, name: `Z ${t}` });
  const school = await f.row("schools", { zone_id: zone, name: `S ${t}`, code: t.slice(-12) });
  const klass = await f.row("classes", { school_id: school, grade: 3, stage: "Primary" });
  const learner = await f.row("learners", { class_id: klass, school_id: school, grade: 3, name: `L ${t}` });
  return { district, zone, school, klass, learner };
}

test("a programme_admin deleting a school or a class cannot take its learners with it", { skip }, async () => {
  const { deleteRowAction, bulkDeleteAction } = await actions();
  await withClient(async (c) => {
    const t = tag("cascade-learners");
    const f = fixture(c, t);
    try {
      const w = await world(f, t);
      actAs(await f.user("programme_admin", "padmin"), "programme_admin");

      const where = await redirectOf(deleteRowAction(form({ entitySlug: "schools", rowId: w.school })));
      assert.equal(await count(f, "learners", w.learner), 1, "deleting the school erased a learner record");
      assert.equal(await count(f, "classes", w.klass), 1, "deleting the school erased its class");
      assert.equal(await count(f, "schools", w.school), 1);
      assert.match(where ?? "", /^\/admin\/data\/schools\?error=still_referenced/, "the operator must be told why");

      await redirectOf(deleteRowAction(form({ entitySlug: "classes", rowId: w.klass })));
      assert.equal(await count(f, "learners", w.learner), 1, "deleting the class erased a learner record");

      await redirectOf(bulkDeleteAction(form({ entitySlug: "classes", rowIds: [w.klass] })));
      assert.equal(await count(f, "learners", w.learner), 1, "bulk-deleting the class erased a learner record");
    } finally {
      await f.cleanup();
    }
  });
});

test("deleting an RTT session, a pairing or an observation cycle keeps the work recorded under it", { skip }, async () => {
  const { deleteRowAction } = await actions();
  await withClient(async (c) => {
    const t = tag("cascade-work");
    const f = fixture(c, t);
    try {
      const w = await world(f, t);
      const admin = await f.user("programme_admin", "padmin");
      const observer = await f.user("observer", "observer");
      const teacher = await f.row("teachers", { school_id: w.school, full_name: `T ${t}` });

      const phase = await f.row("phases", { label: `P ${t}`.slice(0, 24), sequence: 900 });
      const term = await f.row("terms", { phase_id: phase, name: `Term ${t}`, sequence: 1 });
      const subject = await f.row("rtt_subjects", { term_id: term, name: `RS ${t}` });
      const session = await f.row("rtt_sessions", { rtt_subject_id: subject, sequence: 1, title: `Webinar ${t}` });
      const attendance = await f.row("rtt_attendance", { rtt_session_id: session, teacher_id: teacher, status: "present" });

      const mentor = await f.row("mentors", { name: `M ${t}` });
      const pairing = await f.row("mentor_pairings", { mentor_id: mentor, teacher_id: teacher });
      const meeting = await f.row("mentor_meetings", { pairing_id: pairing, scheduled_at: new Date(), notes: "held" });

      const cycle = await f.row("observation_cycles", {
        code: `OBS-${t}`,
        teacher_id: teacher,
        observer_id: observer,
        kind: "evaluative",
        status: "nominated",
      });
      const obsForm = await f.row("observation_forms", {
        cycle_id: cycle,
        kind: "pre",
        responses: JSON.stringify({ plan: "lesson plan" }),
        submitted_by_user_id: observer,
      });

      actAs(admin, "programme_admin");

      // rtt_attendance is mutateRoles ['super_admin']: a programme_admin cannot
      // delete a mark directly, so a session delete must not do it for them.
      await redirectOf(deleteRowAction(form({ entitySlug: "rtt-sessions", rowId: session })));
      assert.equal(await count(f, "rtt_attendance", attendance), 1, "deleting the session erased its attendance");

      await redirectOf(deleteRowAction(form({ entitySlug: "rtt-subjects", rowId: subject })));
      assert.equal(await count(f, "rtt_attendance", attendance), 1, "deleting the subject erased attendance");
      assert.equal(await count(f, "rtt_sessions", session), 1, "deleting the subject erased its sessions");

      await redirectOf(deleteRowAction(form({ entitySlug: "mentor-pairings", rowId: pairing })));
      assert.equal(await count(f, "mentor_meetings", meeting), 1, "deleting the pairing erased its meeting notes");

      await redirectOf(deleteRowAction(form({ entitySlug: "observation-cycles", rowId: cycle })));
      assert.equal(await count(f, "observation_forms", obsForm), 1, "deleting the cycle erased a submitted form");
    } finally {
      await f.cleanup();
    }
  });
});

test("a delete refused by a reference names what still references the row", { skip }, async () => {
  const { deleteRowAction } = await actions();
  await withClient(async (c) => {
    const t = tag("cascade-msg");
    const f = fixture(c, t);
    try {
      const w = await world(f, t);
      actAs(await f.user("programme_admin", "padmin"), "programme_admin");
      const where = await redirectOf(deleteRowAction(form({ entitySlug: "classes", rowId: w.klass })));
      const url = new URL(where ?? "/", "http://x");
      assert.equal(url.searchParams.get("error"), "still_referenced");
      assert.equal(url.searchParams.get("ref"), "learners", "the grid names the referencing table");
    } finally {
      await f.cleanup();
    }
  });
});
