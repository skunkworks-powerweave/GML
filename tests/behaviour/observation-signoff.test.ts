// Observation sign-off through the approvals queue.
//
// ── WHAT IS PROMISED ─────────────────────────────────────────────────────────
//
// The design (docs/superpowers/specs/2026-09-28-teaching-records-design.md):
// "Observation sign-off, which can now also be sent back with a comment", in
// the one approvals queue. Until now "Sign off cycle" flipped the status and
// nothing could return a cycle to the teacher.
//
//   - the teacher's post-observation form sends the cycle for sign-off: an
//     observation_signoff request to her mentor(s) and the programme admins;
//     while it waits, the post form is closed to her
//   - Send back needs a comment, returns the cycle to "observed" so she can
//     revise the post form, and tells her why
//   - Sign off approves the request: the cycle completes and locks, exactly as
//     before (the observation.signed_off audit row, cycle.complete notices)
//   - only her actively paired mentor or an administrator decides, and only
//     with the Observation section unlocked; another teacher's mentor, the
//     teacher and the observer are refused, in the queue and on the page
//   - a cycle at post_submitted from before sign-off requests can still be
//     decided: the request is created and decided in one step
//   - nothing the section password guards reaches the inbox
//
// ── HOW ──────────────────────────────────────────────────────────────────────
//
// The real cycle actions, cycle page and lib/approvals (./_server-actions.ts),
// against a committed observation programme (./_observation-world.ts).

import { test, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { signIn, outcome, form, closeAppDb, type TestUser } from "./_server-actions.js";
import { render, request, resetRequest, withAppRouter } from "./_ui.js";
import { needsDatabase } from "./_harness.js";
import { observationWorld, type ObservationWorld } from "./_observation-world.js";
import { loadMessages } from "../../apps/web/src/i18n/config.ts";

const skip = needsDatabase();
after(closeAppDb);
afterEach(resetRequest);

const actions = () => import("../../apps/web/src/app/(authenticated)/observation/[cycleId]/actions.ts");
const approvalsLib = () => import("../../apps/web/src/lib/approvals/index.ts");
const appDb = async () => (await import("@gml/db")).db as never;

type Tree = { [k: string]: string | Tree };
function msg(locale: "en" | "hi" | "bo", path: string): string {
  const v = path.split(".").reduce<unknown>((n, k) => (n as Tree)[k], loadMessages(locale));
  assert.equal(typeof v, "string", `${locale}:${path} is a message`);
  return v as string;
}

function text(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

async function renderCycle(user: TestUser, cycleId: string): Promise<string> {
  signIn(user);
  const { default: CycleDetailPage } = await import("../../apps/web/src/app/(authenticated)/observation/[cycleId]/page.tsx");
  return render(withAppRouter(await CycleDetailPage({ params: Promise.resolve({ cycleId }), searchParams: Promise.resolve({}) })));
}

async function requests(w: ObservationWorld, cycleId: string) {
  return (
    await w.c.query(
      `SELECT id, status, submitted_by_user_id, decided_by_user_id, comment FROM approvals
        WHERE item_type = 'observation_signoff' AND item_id = $1 ORDER BY submitted_at`,
      [cycleId],
    )
  ).rows as { id: string; status: string; submitted_by_user_id: string | null; decided_by_user_id: string | null; comment: string | null }[];
}

const status = async (w: ObservationWorld, cycleId: string) =>
  (await w.c.query(`SELECT status FROM observation_cycles WHERE id = $1`, [cycleId])).rows[0].status as string;

type Note = { user_id: string; kind: string; entity_type: string; entity_id: string; subject: string; body: string | null };
async function inbox(w: ObservationWorld, userId: string): Promise<Note[]> {
  return (
    await w.c.query(`SELECT user_id, kind, entity_type, entity_id, subject, body FROM notifications WHERE user_id = $1 ORDER BY created_at`, [userId])
  ).rows as Note[];
}

/** The bell and /inbox are outside the Observation section: no code, teacher, kind or date. */
function assertNothingGated(w: ObservationWorld, rows: Note[], code: string) {
  assert.ok(rows.length > 0, "something was written");
  for (const r of rows) {
    const t = `${r.subject}\n${r.body ?? ""}`;
    for (const [what, re] of Object.entries({ code: new RegExp(code), teacher: /Teacher Row/, kind: /evaluative/i, date: /2026|Sept/ })) {
      assert.doesNotMatch(t, re, `the inbox names the cycle's ${what}: ${JSON.stringify(t)}`);
    }
  }
}

async function auditRows(w: ObservationWorld, cycleId: string, action: string) {
  let rows: { user_id: string; metadata: Record<string, unknown> }[] = [];
  for (let i = 0; i < 40; i++) {
    rows = (await w.c.query(`SELECT user_id, metadata FROM audit_log WHERE entity_id = $1 AND action = $2`, [cycleId, action])).rows;
    if (rows.length > 0) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  return rows;
}

const cleanupApprovals = (w: ObservationWorld) =>
  w.c.query(`DELETE FROM approvals WHERE item_id IN (SELECT id FROM observation_cycles WHERE teacher_id = $1)`, [w.teacherId]);

test("the teacher's post form sends the cycle for sign-off to her mentor and the programme admins, and closes the form", { skip }, async () => {
  const w = await observationWorld("signreq");
  try {
    const { submitPostFormAction } = await actions();
    const { listApprovals } = await approvalsLib();
    const db = await appDb();
    const cyc = await w.cycle({ status: "observed" });
    await w.grant(w.teacher.id);
    signIn(w.teacher);
    assert.deepEqual(await outcome(() => submitPostFormAction(form({ cycleId: cyc.id, whatWorked: "Group work landed" }))), {
      kind: "redirect",
      location: `/observation/${cyc.id}`,
    });
    assert.equal(await status(w, cyc.id), "post_submitted");
    const [req, ...more] = await requests(w, cyc.id);
    assert.deepEqual(more, [], "one request");
    assert.equal(req!.status, "pending");
    assert.equal(req!.submitted_by_user_id, w.teacher.id, "submitted by the teacher");

    // Pending locks it for her: the post form is not offered, and a direct
    // resubmission is refused without a second request.
    const mine = await renderCycle(w.teacher, cyc.id);
    assert.doesNotMatch(mine, /name="whatWorked"/);
    assert.match(mine, /data-testid="signoff-state" data-state="pending"/);
    assert.doesNotMatch(mine, /name="comment"/, "the teacher is offered no decision");
    signIn(w.teacher);
    assert.deepEqual(await outcome(() => submitPostFormAction(form({ cycleId: cyc.id, whatWorked: "Changed my mind" }))), {
      kind: "redirect",
      location: `/observation/${cyc.id}?error=invalid_transition`,
    });
    assert.equal((await requests(w, cyc.id)).length, 1);

    // Her mentor and the programme admin are told -- without the cycle's
    // details. (Filtered to this request: every programme admin in the
    // database hears of every request, including other suites' running now.)
    for (const u of [w.mentor, w.admin]) {
      const told = (await inbox(w, u.id)).filter((n) => n.kind === "approval" && n.entity_id === req!.id);
      assert.equal(told.length, 1, `${u.role} is told, once`);
      assert.equal(told[0]!.entity_type, "approval", "the notice opens the request");
      assertNothingGated(w, told, cyc.code);
    }
    assert.equal((await inbox(w, w.observer.id)).filter((n) => n.entity_id === req!.id).length, 0, "the observer decides nothing");

    // The queue: only to deciders holding the section password.
    const inQueue = async (u: TestUser) => (await listApprovals(db, { id: u.id, role: u.role })).find((q) => q.itemId === cyc.id);
    assert.equal(await inQueue(w.admin), undefined, "without the Observation password the request is not listed");
    assert.equal(await inQueue(w.mentor), undefined);
    await w.grant(w.admin.id);
    await w.grant(w.mentor.id);
    for (const u of [w.admin, w.mentor]) {
      const entry = await inQueue(u);
      assert.ok(entry, `${u.role} sees it once unlocked`);
      assert.equal(entry!.summary!.href, `/observation/${cyc.id}`);
      assert.ok(entry!.summary!.subtitle!.includes(cyc.code) && entry!.summary!.subtitle!.includes("Teacher Row"), entry!.summary!.subtitle);
      // The title is what the queue prints in its inbox notices.
      assertNothingGated(
        w,
        [{ user_id: u.id, kind: "approval", entity_type: "approval", entity_id: req!.id, subject: entry!.summary!.title, body: null }],
        cyc.code,
      );
    }
    assert.equal((await listApprovals(db, { id: w.observer.id, role: "observer" })).length, 0);
  } finally {
    await cleanupApprovals(w);
    await w.cleanup();
  }
});

test("Send back needs a comment, reopens the post form and tells the teacher why", { skip }, async () => {
  const w = await observationWorld("signback");
  try {
    const { submitPostFormAction, sendBackCycleAction } = await actions();
    const cyc = await w.cycle({ status: "observed" });
    await w.grant(w.teacher.id);
    await w.grant(w.mentor.id);
    signIn(w.teacher);
    await outcome(() => submitPostFormAction(form({ cycleId: cyc.id, whatWorked: "Group work landed" })));

    // The mentor is offered both decisions.
    const offered = await renderCycle(w.mentor, cyc.id);
    assert.match(offered, /data-testid="signoff-panel"/);
    assert.equal((offered.match(/name="comment"/g) ?? []).length, 2, "a comment for each decision");

    signIn(w.mentor);
    assert.deepEqual(await outcome(() => sendBackCycleAction(form({ cycleId: cyc.id, comment: "   " }))), {
      kind: "redirect",
      location: `/observation/${cyc.id}?error=comment_required`,
    });
    assert.equal(await status(w, cyc.id), "post_submitted", "nothing moved");
    assert.equal((await requests(w, cyc.id))[0]!.status, "pending");

    signIn(w.mentor);
    const back = await outcome(() => sendBackCycleAction(form({ cycleId: cyc.id, comment: "Say more about the group work" })));
    assert.deepEqual(back, { kind: "redirect", location: `/observation/${cyc.id}` });
    assert.equal(await status(w, cyc.id), "observed", "back to the teacher");
    const [decided] = await requests(w, cyc.id);
    assert.equal(decided!.status, "changes_requested");
    assert.equal(decided!.decided_by_user_id, w.mentor.id);
    assert.equal(decided!.comment, "Say more about the group work");

    // She is told, once, with the comment, and nothing gated.
    const told = (await inbox(w, w.teacher.id)).filter((n) => n.kind === "approval" && n.entity_id === cyc.id);
    assert.equal(told.length, 1, `one notice: ${JSON.stringify(told)}`);
    assert.equal(told[0]!.body, "Say more about the group work");
    assert.equal(told[0]!.entity_id, cyc.id, "it opens her cycle");
    assertNothingGated(w, told, cyc.code);

    const [audit] = await auditRows(w, cyc.id, "observation.cycle.sent_back");
    assert.ok(audit, "sending back is audited");
    assert.equal(audit!.user_id, w.mentor.id);
    assert.deepEqual(audit!.metadata, {
      code: cyc.code,
      from: "post_submitted",
      to: "observed",
      decision: "changes_requested",
      commentLength: "Say more about the group work".length,
    });

    // Her page says why, and the post form is hers to revise.
    const page = await renderCycle(w.teacher, cyc.id);
    assert.match(page, /data-testid="signoff-state" data-state="changes_requested"/);
    assert.ok(text(page).includes("Say more about the group work"));
    assert.match(page, /name="whatWorked"/);

    // Resubmitted, it waits again: the history keeps both requests.
    signIn(w.teacher);
    await outcome(() => submitPostFormAction(form({ cycleId: cyc.id, whatWorked: "Group work landed; the quiet pair joined in" })));
    assert.deepEqual((await requests(w, cyc.id)).map((r) => r.status), ["changes_requested", "pending"]);
  } finally {
    await cleanupApprovals(w);
    await w.cleanup();
  }
});

test("Sign off approves the request: the cycle completes and locks, and its parties are told", { skip }, async () => {
  const w = await observationWorld("signok");
  try {
    const { submitPostFormAction, signOffCycleAction, sendBackCycleAction, addNoteAction } = await actions();
    const cyc = await w.cycle({ status: "observed" });
    await w.grant(w.teacher.id);
    await w.grant(w.admin.id);
    signIn(w.teacher);
    await outcome(() => submitPostFormAction(form({ cycleId: cyc.id, whatWorked: "Group work landed" })));

    signIn(w.admin);
    assert.deepEqual(await outcome(() => signOffCycleAction(form({ cycleId: cyc.id, comment: "A thoughtful reflection" }))), {
      kind: "redirect",
      location: `/observation/${cyc.id}`,
    });
    assert.equal(await status(w, cyc.id), "complete");
    const [req] = await requests(w, cyc.id);
    assert.deepEqual([req!.status, req!.decided_by_user_id, req!.comment], ["approved", w.admin.id, "A thoughtful reflection"]);

    const [audit] = await auditRows(w, cyc.id, "observation.signed_off");
    assert.ok(audit, "the signed_off row is the 'signed by' record");
    assert.equal(audit!.user_id, w.admin.id);
    assert.equal(audit!.metadata.signedByUserId, w.admin.id);
    assert.equal(audit!.metadata.code, cyc.code);
    assert.equal(typeof audit!.metadata.signedAt, "string");

    // Every other party hears it is complete, as before.
    const complete = (await w.c.query(`SELECT user_id FROM notifications WHERE entity_id = $1 AND kind = 'cycle.complete'`, [cyc.id])).rows.map(
      (r) => r.user_id,
    );
    assert.deepEqual(complete.sort(), [w.teacher.id, w.observer.id, w.mentor.id].sort());
    assertNothingGated(w, await inbox(w, w.teacher.id), cyc.code);

    // Locked: no note, no second decision either way.
    signIn(w.admin);
    assert.deepEqual(await outcome(() => addNoteAction(form({ cycleId: cyc.id, note: "one more thing" }))), {
      kind: "redirect",
      location: `/observation/${cyc.id}?error=cycle_locked`,
    });
    for (const again of [
      () => signOffCycleAction(form({ cycleId: cyc.id })),
      () => sendBackCycleAction(form({ cycleId: cyc.id, comment: "Too late" })),
    ]) {
      signIn(w.admin);
      assert.deepEqual(await outcome(again), { kind: "redirect", location: `/observation/${cyc.id}?error=invalid_transition` });
    }
    assert.equal(await status(w, cyc.id), "complete");
    assert.deepEqual((await requests(w, cyc.id)).map((r) => r.status), ["approved"], "a refused decision leaves no request behind");

    const page = await renderCycle(w.teacher, cyc.id);
    assert.match(page, /data-testid="signoff-state" data-state="approved"/);
    assert.ok(text(page).includes("A thoughtful reflection"), "the approver's comment is shown");
  } finally {
    await cleanupApprovals(w);
    await w.cleanup();
  }
});

test("another teacher's mentor, the teacher, the observer and a locked-out mentor cannot decide", { skip }, async () => {
  const w = await observationWorld("signrefuse");
  const c = w.c;
  const one = async (q: string, p: unknown[]) => (await c.query(q, p)).rows[0].id as string;
  // A mentor paired with a DIFFERENT teacher.
  const otherTeacher = await one(`INSERT INTO teachers (school_id, full_name) VALUES ($1, $2) RETURNING id`, [w.schoolId, `Else ${w.T}`]);
  const otherMentorUser = await one(
    `INSERT INTO users (id, email, name, role) VALUES (gen_random_uuid(), $1, $2, 'mentor') RETURNING id`,
    [`om.${w.T}@example.test`, `OtherMentor ${w.T}`],
  );
  const otherMentor = await one(`INSERT INTO mentors (user_id, name, base_location) VALUES ($1, $2, 'Leh') RETURNING id`, [
    otherMentorUser,
    `OM ${w.T}`,
  ]);
  const otherPairing = await one(
    `INSERT INTO mentor_pairings (mentor_id, teacher_id, status, started_at) VALUES ($1, $2, 'active', now()) RETURNING id`,
    [otherMentor, otherTeacher],
  );
  try {
    const { submitPostFormAction, signOffCycleAction, sendBackCycleAction } = await actions();
    const { decideApproval, listApprovals } = await approvalsLib();
    const db = await appDb();
    const cyc = await w.cycle({ status: "observed" });
    await w.grant(w.teacher.id);
    signIn(w.teacher);
    await outcome(() => submitPostFormAction(form({ cycleId: cyc.id, whatWorked: "Group work landed" })));
    const [req] = await requests(w, cyc.id);

    const om: TestUser = { id: otherMentorUser, role: "mentor" };
    await w.grant(otherMentorUser);
    signIn(om);
    assert.deepEqual(await outcome(() => signOffCycleAction(form({ cycleId: cyc.id }))), { kind: "notFound" });
    signIn(om);
    assert.deepEqual(await outcome(() => sendBackCycleAction(form({ cycleId: cyc.id, comment: "No" }))), { kind: "notFound" });
    assert.deepEqual(await decideApproval(db, { approvalId: req!.id, decision: "approved", actor: om }), { ok: false, error: "not_allowed" });
    assert.equal((await listApprovals(db, om)).some((q) => q.itemId === cyc.id), false, "not in her queue");

    // The teacher and the observer hold no deciding role.
    await w.grant(w.observer.id);
    for (const u of [w.teacher, w.observer]) {
      signIn(u);
      assert.deepEqual(await outcome(() => signOffCycleAction(form({ cycleId: cyc.id }))), { kind: "redirect", location: "/forbidden" });
      signIn(u);
      assert.deepEqual(await outcome(() => sendBackCycleAction(form({ cycleId: cyc.id, comment: "x" }))), {
        kind: "redirect",
        location: "/forbidden",
      });
      assert.deepEqual(await decideApproval(db, { approvalId: req!.id, decision: "approved", actor: u }), { ok: false, error: "not_allowed" });
    }
    const observerPage = await renderCycle(w.observer, cyc.id);
    assert.doesNotMatch(observerPage, /name="comment"/, "the observer is offered no decision");

    // Her own mentor, but without the Observation password: not from the
    // queue, and the cycle's actions send her to the gate.
    assert.deepEqual(await decideApproval(db, { approvalId: req!.id, decision: "approved", actor: w.mentor }), {
      ok: false,
      error: "not_allowed",
    });
    signIn(w.mentor);
    const gated = await outcome(() => signOffCycleAction(form({ cycleId: cyc.id })));
    assert.match((gated as { location: string }).location, /^\/gate\/observation/);

    assert.equal(await status(w, cyc.id), "post_submitted", "nothing moved");
    assert.deepEqual((await requests(w, cyc.id)).map((r) => r.status), ["pending"]);

    // Unlocked, from the queue, she may.
    await w.grant(w.mentor.id);
    assert.equal((await decideApproval(db, { approvalId: req!.id, decision: "approved", actor: w.mentor })).ok, true);
    assert.equal(await status(w, cyc.id), "complete", "a decision from /approvals completes the cycle too");
  } finally {
    await c.query(`DELETE FROM section_gate_grants WHERE user_id = $1`, [otherMentorUser]);
    await c.query(`DELETE FROM mentor_pairings WHERE id = $1`, [otherPairing]);
    await c.query(`DELETE FROM mentors WHERE id = $1`, [otherMentor]);
    await c.query(`DELETE FROM users WHERE id = $1`, [otherMentorUser]);
    await c.query(`DELETE FROM teachers WHERE id = $1`, [otherTeacher]);
    await cleanupApprovals(w);
    await w.cleanup();
  }
});

test("a cycle waiting from before sign-off requests is decided in one step", { skip }, async () => {
  const w = await observationWorld("signlegacy");
  try {
    const { signOffCycleAction, sendBackCycleAction } = await actions();
    await w.grant(w.mentor.id);

    // Sent back: the request is recorded already decided, and -- nobody
    // having submitted it -- the teacher is told here, in her language.
    await w.c.query(`INSERT INTO user_prefs (user_id, ui_language) VALUES ($1, 'hi')`, [w.teacher.id]);
    const back = await w.cycle({ status: "post_submitted" });
    signIn(w.mentor);
    assert.deepEqual(await outcome(() => sendBackCycleAction(form({ cycleId: back.id, comment: "Please add the reflection" }))), {
      kind: "redirect",
      location: `/observation/${back.id}`,
    });
    assert.equal(await status(w, back.id), "observed");
    const [legacy] = await requests(w, back.id);
    assert.deepEqual(
      [legacy!.status, legacy!.submitted_by_user_id, legacy!.decided_by_user_id, legacy!.comment],
      ["changes_requested", null, w.mentor.id, "Please add the reflection"],
    );
    const told = (await inbox(w, w.teacher.id)).filter((n) => n.entity_id === back.id);
    assert.equal(told.length, 1);
    assert.equal(told[0]!.subject, msg("hi", "observation.notify.sentBack.subject"));
    assert.ok(told[0]!.body!.startsWith("Please add the reflection"));
    assertNothingGated(w, told, back.code);

    // Signed off: recorded approved, and the cycle completes.
    const done = await w.cycle({ status: "post_submitted" });
    signIn(w.mentor);
    assert.deepEqual(await outcome(() => signOffCycleAction(form({ cycleId: done.id }))), { kind: "redirect", location: `/observation/${done.id}` });
    assert.equal(await status(w, done.id), "complete");
    assert.deepEqual((await requests(w, done.id)).map((r) => [r.status, r.submitted_by_user_id]), [["approved", null]]);
    assert.equal((await auditRows(w, done.id, "approval.decided")).length, 1, "decided in the queue's own terms");
  } finally {
    await cleanupApprovals(w);
    await w.cleanup();
  }
});

test("the sign-off state and the approver's comment are in the reader's language", { skip }, async () => {
  const w = await observationWorld("signbo");
  try {
    const { submitPostFormAction, sendBackCycleAction } = await actions();
    const cyc = await w.cycle({ status: "observed" });
    await w.grant(w.teacher.id);
    await w.grant(w.mentor.id);
    signIn(w.teacher);
    await outcome(() => submitPostFormAction(form({ cycleId: cyc.id, whatWorked: "Group work landed" })));

    request.locale = "bo";
    const mentorPage = text(await renderCycle(w.mentor, cyc.id));
    for (const path of ["observation.cycle.signoff.label", "observation.cycle.signoff.states.pending", "observation.cycle.signoff.sendBack", "observation.cycle.signOff"]) {
      assert.ok(mentorPage.includes(msg("bo", path)), `bo: ${path}`);
    }
    for (const english of ["Sign-off", "Waiting for sign-off", "Send back", "Comment (optional)", "What needs to change"]) {
      assert.ok(!mentorPage.includes(english), `bo: "${english}" is still English on the mentor's page`);
    }

    signIn(w.mentor);
    await outcome(() => sendBackCycleAction(form({ cycleId: cyc.id, comment: "ཚིག་གསལ་པོ།" })));
    const teacherPage = text(await renderCycle(w.teacher, cyc.id));
    assert.ok(teacherPage.includes(msg("bo", "observation.cycle.signoff.states.changes_requested")));
    assert.ok(teacherPage.includes(msg("bo", "observation.cycle.signoff.commentHeading")));
    assert.ok(teacherPage.includes("ཚིག་གསལ་པོ།"), "the comment as the approver wrote it");
    for (const english of ["Sent back", "Comment", "revises the post-observation form"]) {
      assert.ok(!teacherPage.includes(english), `bo: "${english}" is still English on the teacher's page`);
    }
  } finally {
    await cleanupApprovals(w);
    await w.cleanup();
  }
});
