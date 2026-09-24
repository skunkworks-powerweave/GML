// A cycle past nomination keeps its subject, and every grid edit or delete
// leaves a before-image in the audit log.
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
//
// The grid's update and delete wrote blindly by id: they never read the row,
// so they could not enforce a rule that depends on its state and had nothing
// to put in the audit log. On a SIGNED-OFF evaluative cycle an administrator
// could change teacherId -- moving the rubric written about teacher A onto
// teacher B, and with it read access (lib/authz.ts follows cycle.teacher_id) --
// or its kind, and the audit row kept only the new code. A delete's audit row
// was literally {"op":"delete"}: not the code, not the teacher, not that forms
// existed.
//
// ── WHAT IS EXECUTED ─────────────────────────────────────────────────────────
//
// The entity's guard directly, then the grid's real server actions as a
// programme_admin holding the observation grant, against Postgres; audit rows
// are read back from audit_log.

import { test } from "node:test";
import assert from "node:assert/strict";
import "./_ui.js";
import { ADMIN_ENTITIES } from "../../apps/web/src/admin/registry.ts";
import { needsDatabase, withClient, tag } from "./_harness.js";
import { actAs, fixture, form, redirectOf, type Fixture } from "./_admin-fixture.js";

const skip = needsDatabase();
const actions = () =>
  import("../../apps/web/src/app/(authenticated)/admin/data/[entity]/actions.ts");

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

test("past nomination, a cycle's teacher and kind are fixed and it cannot be deleted", () => {
  const guard = ADMIN_ENTITIES["observation-cycles"]!.guardMutation;
  assert.ok(guard, "observation-cycles must declare a mutation guard");
  const done = { status: "complete", teacherId: A, kind: "evaluative", topic: "Fractions" };
  assert.ok(guard("update", done, { ...done, teacherId: B }), "reassigning a signed-off cycle's teacher");
  assert.ok(guard("update", done, { ...done, kind: "baseline" }), "changing a signed-off cycle's kind");
  assert.equal(guard("update", done, { ...done, topic: "Decimals" }), null, "the topic stays editable");
  assert.ok(guard("delete", done), "deleting a signed-off cycle");
  const fresh = { ...done, status: "nominated" };
  assert.equal(guard("update", fresh, { ...fresh, teacherId: B }), null, "a nomination can still be corrected");
  assert.equal(guard("delete", fresh), null, "a nomination with nothing under it can be withdrawn");
});

async function lastAudit(f: Fixture, action: string, entityId: string) {
  for (let i = 0; i < 40; i++) {
    const { rows } = await f.c.query(
      `SELECT metadata FROM audit_log WHERE action = $1 AND entity_id = $2 ORDER BY created_at DESC LIMIT 1`,
      [action, entityId],
    );
    if (rows[0]) return rows[0].metadata as Record<string, unknown>;
    await new Promise((r) => setTimeout(r, 50));
  }
  return undefined;
}

test("the grid refuses to reassign or delete a signed-off cycle, and audits what it does change", { skip }, async () => {
  const { updateRowAction, deleteRowAction, bulkDeleteAction } = await actions();
  await withClient(async (c) => {
    const t = tag("cycle-lock");
    const f = fixture(c, t);
    try {
      const district = await f.row("districts", { name: `D ${t}`, code: t.slice(-12) });
      const zone = await f.row("zones", { district_id: district, name: `Z ${t}` });
      const school = await f.row("schools", { zone_id: zone, name: `S ${t}`, code: t.slice(-12) });
      const teacherA = await f.row("teachers", { school_id: school, full_name: `A ${t}` });
      const teacherB = await f.row("teachers", { school_id: school, full_name: `B ${t}` });
      const observer = await f.user("observer", "observer");
      const admin = await f.user("programme_admin", "padmin");
      await f.row("section_gate_grants", { user_id: admin, gate_slug: "observation", expires_at: new Date(Date.now() + 3600_000) });
      const done = await f.row("observation_cycles", {
        code: `OBS-${t}`,
        teacher_id: teacherA,
        observer_id: observer,
        kind: "evaluative",
        status: "complete",
        topic: "Fractions",
        scheduled_at: new Date("2026-10-01T04:30:00Z"),
      });
      await f.row("observation_forms", { cycle_id: done, kind: "observer", responses: JSON.stringify({ about: "A" }) });
      const fresh = await f.row("observation_cycles", {
        code: `NOM-${t}`,
        teacher_id: teacherA,
        observer_id: observer,
        kind: "baseline",
        status: "nominated",
        scheduled_at: new Date("2026-11-01T04:30:00Z"),
      });
      actAs(admin, "programme_admin");

      const edit = (rowId: string, over: Record<string, string>) =>
        updateRowAction(
          undefined,
          form({
            entitySlug: "observation-cycles",
            rowId,
            code: `OBS-${t}`,
            teacherId: teacherA,
            observerId: observer,
            kind: "evaluative",
            scheduledAt: "2026-10-01T04:30:00Z",
            topic: "Fractions",
            ...over,
          }),
        );

      const moved = await edit(done, { teacherId: teacherB });
      assert.equal(moved.ok, false, "a signed-off cycle was moved to another teacher");
      const { rows: [still] } = await c.query(`SELECT teacher_id FROM observation_cycles WHERE id = $1`, [done]);
      assert.equal(still.teacher_id, teacherA);

      const retopic = await edit(done, { topic: "Decimals" });
      assert.deepEqual(retopic, { ok: true });
      const upd = await lastAudit(f, "admin.row.update", done);
      assert.deepEqual(
        (upd?.changes as Record<string, unknown>)?.topic,
        { from: "Fractions", to: "Decimals" },
        "the update's audit row must say what the value WAS",
      );

      const del = await redirectOf(deleteRowAction(form({ entitySlug: "observation-cycles", rowId: done })));
      assert.match(del ?? "", /error=locked/, "deleting a signed-off cycle must be refused with a reason");
      const bulk = await redirectOf(
        bulkDeleteAction(form({ entitySlug: "observation-cycles", rowIds: [fresh, done] })),
      );
      assert.match(bulk ?? "", /error=locked/, "a bulk delete that includes it must be refused as a whole");
      const { rows: [n] } = await c.query(`SELECT count(*)::int AS n FROM observation_cycles WHERE id IN ($1, $2)`, [done, fresh]);
      assert.equal(n.n, 2, "nothing is deleted when the batch is refused");

      await redirectOf(deleteRowAction(form({ entitySlug: "observation-cycles", rowId: fresh })));
      const { rows: [gone] } = await c.query(`SELECT count(*)::int AS n FROM observation_cycles WHERE id = $1`, [fresh]);
      assert.equal(gone.n, 0, "a plain nomination can be deleted");
      const delAudit = await lastAudit(f, "admin.row.delete", fresh);
      const before = delAudit?.before as Record<string, unknown> | undefined;
      assert.equal(before?.teacherId, teacherA, "the delete's audit row must keep who the cycle was about");
      assert.equal(before?.code, `NOM-${t}`);
    } finally {
      await f.cleanup();
    }
  });
});

test("a PII entity's update audit names the changed fields without their values", { skip }, async () => {
  const { updateRowAction } = await actions();
  await withClient(async (c) => {
    const t = tag("pii-audit");
    const f = fixture(c, t);
    try {
      const district = await f.row("districts", { name: `D ${t}`, code: t.slice(-12) });
      const zone = await f.row("zones", { district_id: district, name: `Z ${t}` });
      const school = await f.row("schools", { zone_id: zone, name: `S ${t}`, code: t.slice(-12) });
      const klass = await f.row("classes", { school_id: school, grade: 2, stage: "Primary" });
      const learner = await f.row("learners", { class_id: klass, school_id: school, grade: 2, name: `Child ${t}`, guardian: "Old guardian" });
      actAs(await f.user("super_admin", "sadmin"), "super_admin");
      const r = await updateRowAction(
        undefined,
        form({ entitySlug: "learners", rowId: learner, classId: klass, schoolId: school, grade: "2", name: `Child ${t}`, guardian: "New guardian", active: "true" }),
      );
      assert.deepEqual(r, { ok: true });
      const meta = await lastAudit(f, "admin.row.update", learner);
      assert.deepEqual(meta?.changedFields, ["guardian"]);
      assert.doesNotMatch(JSON.stringify(meta), /Old guardian|New guardian/, "a child's guardian must not be copied into audit_log");
    } finally {
      await f.cleanup();
    }
  });
});
