// A lapsed section grant sends the user back to the CYCLE they were working
// on, not to the list.
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
//
// Every cycle action asserts the observation gate itself (a server action runs
// before any layout), with the return path hard-coded:
//
//     await assertSectionGate(actor.id, "observation", "/observation");
//
// So when the 8-hour grant expired -- or an administrator rotated the
// password -- while an observer was writing a rubric or a teacher her
// reflection, the submit went to /gate/observation?next=%2Fobservation, and
// after unlocking she landed on the list, with no way back to what she had
// been doing but to find the cycle again. The layout already returns people
// to the page they asked for; the actions did not.
//
// ── HOW ──────────────────────────────────────────────────────────────────────
//
// The real actions, through ./_server-actions.ts, by users who may act on the
// cycle but hold no grant.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { signIn, outcome, form, closeAppDb } from "./_server-actions.js";
import { needsDatabase } from "./_harness.js";
import { observationWorld } from "./_observation-world.js";

const skip = needsDatabase();
after(closeAppDb);

test("every cycle action returns a gate-locked user to that cycle after unlocking", { skip }, async () => {
  const w = await observationWorld("gateret");
  try {
    const a = await import("../../apps/web/src/app/(authenticated)/observation/[cycleId]/actions.ts");
    const cases = [
      { name: "pre-form", run: a.submitPreFormAction, user: w.teacher, status: "nominated", fields: { lessonPlanSummary: "x" } },
      { name: "observer form", run: a.submitObserverFormAction, user: w.observer, status: "pre_submitted", fields: { narrativeComments: "x" } },
      { name: "post-form", run: a.submitPostFormAction, user: w.teacher, status: "observed", fields: { whatWorked: "x" } },
      { name: "sign-off", run: a.signOffCycleAction, user: w.mentor, status: "post_submitted", fields: {} },
      { name: "note", run: a.addNoteAction, user: w.observer, status: "observed", fields: { note: "x" } },
    ];
    for (const c of cases) {
      const cyc = await w.cycle({ status: c.status });
      signIn(c.user);
      const r = await outcome(() => c.run(form({ cycleId: cyc.id, ...c.fields })));
      assert.deepEqual(
        r,
        { kind: "redirect", location: `/gate/observation?next=${encodeURIComponent(`/observation/${cyc.id}`)}` },
        `${c.name}: after unlocking, the user must come back to this cycle`,
      );
      const row = (await w.c.query(`SELECT status, remark FROM observation_cycles WHERE id = $1`, [cyc.id])).rows[0];
      assert.deepEqual(row, { status: c.status, remark: null }, `${c.name}: nothing is done without the grant`);
    }
  } finally {
    await w.cleanup();
  }
});
