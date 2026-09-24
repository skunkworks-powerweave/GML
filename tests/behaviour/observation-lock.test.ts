// A signed-off cycle is a closed record; every note says who wrote it.
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
//
// signOffCycleAction is documented as "final ... locks the cycle", and spec
// 117 says the record locks for audit. Nothing enforced it: addNoteAction had
// no status predicate, the page offered "Add note" and "Upload video" on a
// complete cycle, and beginUploadAction checked access but not status. So
// observers, mentors and admins kept appending to -- and attaching evidence
// to -- an evaluative record after the signer had attested to it.
//
// And each appended entry was "[timestamp UTC] text", under a heading reading
// "Mentor notes" although observers and administrators write there too. A
// teacher reading two entries stamped the same minute could not tell who
// judged what.
//
// ── HOW ──────────────────────────────────────────────────────────────────────
//
// The real server actions and page, through ./_server-actions.ts.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { signIn, outcome, form, closeAppDb, type TestUser } from "./_server-actions.js";
import { render, withAppRouter } from "./_ui.js";
import { needsDatabase } from "./_harness.js";
import { observationWorld } from "./_observation-world.js";

const skip = needsDatabase();
after(closeAppDb);

const actions = () => import("../../apps/web/src/app/(authenticated)/observation/[cycleId]/actions.ts");

async function renderCycle(user: TestUser, cycleId: string): Promise<string> {
  signIn(user);
  const { default: CycleDetailPage } = await import("../../apps/web/src/app/(authenticated)/observation/[cycleId]/page.tsx");
  const html = await render(
    withAppRouter(await CycleDetailPage({ params: Promise.resolve({ cycleId }), searchParams: Promise.resolve({}) })),
  );
  return html.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
}

test("after sign-off, a note is refused and the remark is unchanged", { skip }, async () => {
  const w = await observationWorld("lock");
  try {
    const { addNoteAction } = await actions();
    const cyc = await w.cycle({ status: "complete" });
    await w.c.query(`UPDATE observation_cycles SET remark = 'signed record' WHERE id = $1`, [cyc.id]);
    for (const u of [w.observer, w.mentor, w.admin]) {
      await w.grant(u.id);
      signIn(u);
      const r = await outcome(() => addNoteAction(form({ cycleId: cyc.id, note: `after sign-off by ${u.role}` })));
      assert.deepEqual(r, { kind: "redirect", location: `/observation/${cyc.id}?error=cycle_locked` }, u.role);
    }
    const remark = (await w.c.query(`SELECT remark FROM observation_cycles WHERE id = $1`, [cyc.id])).rows[0].remark;
    assert.equal(remark, "signed record", "a signed-off record must not change");
  } finally {
    await w.cleanup();
  }
});

test("a signed-off cycle's page offers no note form and no upload", { skip }, async () => {
  const w = await observationWorld("lockui");
  try {
    const cyc = await w.cycle({ status: "complete" });
    for (const u of [w.teacher, w.observer, w.mentor, w.admin]) {
      const out = await renderCycle(u, cyc.id);
      assert.doesNotMatch(out, /Add note/, `${u.role} is offered a note on a closed record`);
      assert.doesNotMatch(out, /Upload video/, `${u.role} is offered an upload on a closed record`);
      assert.match(out, /signed off/i, `${u.role} is told why`);
    }
  } finally {
    await w.cleanup();
  }
});

test("the upload path refuses evidence for a signed-off cycle before reserving anything", { skip }, async () => {
  const w = await observationWorld("lockup");
  // Local placeholders: beginUploadAction checks that uploads are configured
  // before it looks at the context. Nothing is contacted.
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://127.0.0.1:1";
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??= "test-publishable-key";
  let cycleId: string | null = null;
  try {
    const { beginUploadAction } = await import("../../apps/web/src/app/(authenticated)/uploads/actions.ts");
    const cyc = await w.cycle({ status: "complete" });
    cycleId = cyc.id;
    signIn(w.teacher);
    const r = await beginUploadAction({
      filename: "lesson.mp4",
      sizeBytes: 1024,
      contentType: "video/mp4",
      contextType: "observation_cycle",
      contextId: cyc.id,
    });
    assert.equal(r.ok, false, "evidence must not be attached to a signed-off record");
    assert.match((r as { error: string }).error, /signed off/i);
    const n = (await w.c.query(`SELECT count(*)::int AS n FROM video_submissions WHERE context_id = $1`, [cyc.id])).rows[0].n;
    assert.equal(n, 0, "nothing reserved");
  } finally {
    // If the refusal ever regresses, do not leave the reservation behind.
    if (cycleId) {
      await w.c.query(
        `WITH v AS (DELETE FROM video_submissions WHERE context_id = $1 RETURNING file_id)
         DELETE FROM files WHERE id IN (SELECT file_id FROM v)`,
        [cycleId],
      );
    }
    await w.cleanup();
  }
});

test("a note records who wrote it, and the section is not called 'Mentor notes'", { skip }, async () => {
  const w = await observationWorld("noteauth");
  try {
    const { addNoteAction } = await actions();
    const cyc = await w.cycle({ status: "observed" });
    await w.grant(w.observer.id);
    signIn(w.observer);
    await outcome(() => addNoteAction(form({ cycleId: cyc.id, note: "Strong questioning" })));
    const remark = (await w.c.query(`SELECT remark FROM observation_cycles WHERE id = $1`, [cyc.id])).rows[0].remark as string;
    assert.match(remark, new RegExp(`^\\[\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2} UTC\\] ${w.observer.name} \\(observer\\): Strong questioning$`));
    const out = await renderCycle(w.teacher, cyc.id);
    assert.ok(out.includes(`${w.observer.name} (observer): Strong questioning`), "the teacher sees who wrote the note");
    assert.doesNotMatch(out, /Mentor notes/, "observers and admins write here too");
  } finally {
    await w.cleanup();
  }
});
