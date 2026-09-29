// The approvals queue (apps/web/src/lib/approvals): who may submit and decide,
// what a decision does to the record, and who hears about it.
//
// Executed against the test database with the app's own pool: a teacher's own
// session goes draft -> pending -> changes requested -> pending -> approved,
// with every refusal the rules promise along the way.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { h } from "./_ui.js";
import { needsDatabase, withClient, tag } from "./_harness.js";
import { fixture, type Fixture } from "./_admin-fixture.js";
import { closeAppDb } from "./_server-actions.js";

void h; // _ui.js registers the @/ and server-only hooks lib/approvals needs.
const skip = needsDatabase();
after(async () => {
  if (!skip) await closeAppDb();
});

type World = {
  f: Fixture;
  teacherUser: string;
  otherTeacherUser: string;
  padmin: string;
  mentor: string;
  sessionId: string;
};

async function world(f: Fixture, t: string): Promise<World> {
  const code = t.replace(/[^a-z0-9]/gi, "").slice(-10).toUpperCase();
  const district = await f.row("districts", { name: `D ${t}`, code: `D${code}` });
  const zone = await f.row("zones", { district_id: district, name: `Z ${t}` });
  const school = await f.row("schools", { zone_id: zone, name: `S ${t}`, code: `S${code}`.slice(0, 16) });
  const klass = await f.row("classes", { school_id: school, grade: 5, stage: "Primary" });
  const subject = await f.row("subjects", { name: `Sub ${t}`, code: `SB${code}`.slice(0, 16) });
  const teacherUser = await f.user("teacher", "t1");
  const otherTeacherUser = await f.user("teacher", "t2");
  const padmin = await f.user("programme_admin", "pa");
  const mentor = await f.user("mentor", "m");
  const teacher = await f.row("teachers", { school_id: school, full_name: `Teacher ${t}`, user_id: teacherUser });
  await f.row("teachers", { school_id: school, full_name: `Other ${t}`, user_id: otherTeacherUser });
  const sessionId = await f.row("sessions", {
    school_id: school,
    class_id: klass,
    subject_id: subject,
    teacher_id: teacher,
    scheduled_date: "2026-09-28",
    topic: `Fractions ${t}`,
    approval_status: "draft",
  });
  f.defer(`DELETE FROM notifications WHERE user_id = ANY($1)`, [[teacherUser, otherTeacherUser, padmin, mentor]]);
  f.defer(`DELETE FROM approvals WHERE item_id = $1`, [sessionId]);
  return { f, teacherUser, otherTeacherUser, padmin, mentor, sessionId };
}

const as = (id: string, role: string) => ({ id, role });

test("a teacher's session goes to the programme admin and back, and the record follows", { skip }, async () => {
  const lib = await import("../../apps/web/src/lib/approvals/index.ts");
  const { db } = await import("@gml/db");
  await withClient(async (c) => {
    const f = fixture(c, tag("approvals"));
    try {
      const w = await world(f, tag("appr"));
      const state = async () =>
        (await c.query(`SELECT approval_status FROM sessions WHERE id = $1`, [w.sessionId])).rows[0].approval_status;

      // Only the session's own teacher may send it.
      assert.deepEqual(
        await lib.submitForApproval(db as never, { itemType: "session", itemId: w.sessionId, actor: as(w.otherTeacherUser, "teacher") }),
        { ok: false, error: "not_allowed" },
      );
      const sent = await lib.submitForApproval(db as never, {
        itemType: "session",
        itemId: w.sessionId,
        actor: as(w.teacherUser, "teacher"),
        note: "Please check the attendance",
      });
      assert.equal(sent.ok, true);
      assert.equal(await state(), "pending");
      // Once pending, it cannot be sent again.
      assert.deepEqual(
        await lib.submitForApproval(db as never, { itemType: "session", itemId: w.sessionId, actor: as(w.teacherUser, "teacher") }),
        { ok: false, error: "not_allowed" },
      );
      // The programme admin was told.
      // Filtered to this request: every submission from any suite running at
      // the same time tells every active programme admin, this one included.
      const told = await c.query(
        `SELECT subject, body FROM notifications WHERE user_id = $1 AND kind = 'approval' AND entity_type = 'approval' AND entity_id = $2`,
        [w.padmin, sent.ok ? sent.approvalId : null],
      );
      assert.equal(told.rowCount, 1);
      assert.match(told.rows[0].subject, /Session waiting for approval: Fractions/);
      assert.equal(told.rows[0].body, "Please check the attendance");

      // The queue: the programme admin sees it, a mentor (who decides no sessions) does not.
      const queue = await lib.listApprovals(db as never, as(w.padmin, "programme_admin"));
      const mine = queue.find((q) => q.itemId === w.sessionId);
      assert.ok(mine, "the session is in the programme admin's queue");
      assert.match(mine!.summary!.title, /Fractions/);
      assert.equal(mine!.summary!.href, `/teaching/sessions/${w.sessionId}`);
      assert.equal((await lib.listApprovals(db as never, as(w.mentor, "mentor"))).some((q) => q.itemId === w.sessionId), false);

      // Deciding: not the teacher; a request for changes needs a reason.
      assert.deepEqual(
        await lib.decideApproval(db as never, { approvalId: sent.ok ? sent.approvalId : "", decision: "approved", actor: as(w.teacherUser, "teacher") }),
        { ok: false, error: "not_allowed" },
      );
      assert.deepEqual(
        await lib.decideApproval(db as never, { approvalId: sent.ok ? sent.approvalId : "", decision: "changes_requested", actor: as(w.padmin, "programme_admin") }),
        { ok: false, error: "comment_required" },
      );
      const back = await lib.decideApproval(db as never, {
        approvalId: sent.ok ? sent.approvalId : "",
        decision: "changes_requested",
        comment: "Add the late arrivals",
        actor: as(w.padmin, "programme_admin"),
      });
      assert.equal(back.ok, true);
      assert.equal(await state(), "changes_requested");
      // A second decision on the same request is refused.
      assert.deepEqual(
        await lib.decideApproval(db as never, { approvalId: sent.ok ? sent.approvalId : "", decision: "approved", actor: as(w.padmin, "programme_admin") }),
        { ok: false, error: "not_pending" },
      );
      const heard = await c.query(`SELECT subject, body FROM notifications WHERE user_id = $1 AND kind = 'approval'`, [w.teacherUser]);
      assert.equal(heard.rowCount, 1);
      assert.match(heard.rows[0].subject, /Session needs changes/);
      assert.equal(heard.rows[0].body, "Add the late arrivals");

      // She can see why, then resubmit; approval locks it.
      const latest = await lib.latestApprovals(db as never, "session", [w.sessionId]);
      assert.equal(latest.get(w.sessionId)?.comment, "Add the late arrivals");
      const again = await lib.submitForApproval(db as never, { itemType: "session", itemId: w.sessionId, actor: as(w.teacherUser, "teacher") });
      assert.equal(again.ok, true);
      const ok = await lib.decideApproval(db as never, {
        approvalId: again.ok ? again.approvalId : "",
        decision: "approved",
        actor: as(w.padmin, "programme_admin"),
      });
      assert.equal(ok.ok, true);
      assert.equal(await state(), "approved");
      assert.equal(lib.isEditable("approved"), false);
      assert.deepEqual(
        await lib.submitForApproval(db as never, { itemType: "session", itemId: w.sessionId, actor: as(w.teacherUser, "teacher") }),
        { ok: false, error: "not_allowed" },
        "an approved record is locked",
      );

      // The history keeps both requests.
      const history = await c.query(`SELECT status FROM approvals WHERE item_id = $1 ORDER BY submitted_at`, [w.sessionId]);
      assert.deepEqual(history.rows.map((r) => r.status), ["changes_requested", "approved"]);
    } finally {
      await f.cleanup();
    }
  });
});

test("a decision on a request that does not exist is not found, not a crash", { skip }, async () => {
  const lib = await import("../../apps/web/src/lib/approvals/index.ts");
  const { db } = await import("@gml/db");
  assert.deepEqual(
    await lib.decideApproval(db as never, { approvalId: randomUUID(), decision: "approved", actor: { id: randomUUID(), role: "programme_admin" } }),
    { ok: false, error: "not_found" },
  );
});
