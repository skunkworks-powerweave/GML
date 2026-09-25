// The dashboard's "Things waiting on you" list, rendered for real.
//
// Each to-do is a promise that the person reading it can act on it. The REAL
// dashboard page is rendered through ./_server-actions.ts for users of a small
// committed programme (./_observation-world.ts); only auth() is stubbed.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { signIn, closeAppDb, outcome, form, type TestUser } from "./_server-actions.js";
import { render, withAppRouter } from "./_ui.js";
import { needsDatabase } from "./_harness.js";
import { observationWorld } from "./_observation-world.js";

const skip = needsDatabase();
after(closeAppDb);

const DAY_MS = 24 * 60 * 60 * 1000;

async function dashboard(user: TestUser): Promise<{ todos: string; stats: string; all: string }> {
  signIn(user);
  const { default: DashboardPage } = await import("../../apps/web/src/app/(authenticated)/dashboard/page.tsx");
  const html = await render(withAppRouter(await DashboardPage()));
  const flat = (s: string) => s.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
  const all = flat(html);
  // The to-do card is the one whose header reads "Things waiting on you" (or
  // "Your training queue" for a teacher); it ends where the next card begins.
  const m = all.match(/(Things waiting on you\.|Your training queue \+ observation prep\.)(.*?)(Confidentiality|confidentiality)/i);
  return { todos: m ? m[2]! : "", stats: all.split(/Things waiting on you|Your training queue/)[0] ?? "", all: html };
}

// ── F22: an observer is not asked to do what only a mentor may do ────────────
//
// getObserverTodos turned the observer's post_submitted cycles into "Sign off
// N completed cycle(s) ->". Sign-off is mentor/admin only (signOffCycleAction's
// requireRole, and the cycle page shows the observer no such control), so the
// observer followed the link to find nothing to press -- on a cycle that is not
// "completed" either. The mentor's own to-do for the same cycle is correct.

test("an observer's to-do list never asks them to sign off a cycle", { skip }, async () => {
  const w = await observationWorld("dashobs");
  try {
    const cyc = await w.cycle({ status: "post_submitted" });
    await w.grant(w.observer.id);
    await w.grant(w.mentor.id);
    const obs = await dashboard(w.observer);
    assert.doesNotMatch(obs.todos, /sign off/i, `observer to-dos: ${obs.todos}`);
    assert.doesNotMatch(obs.todos, /completed cycle/i, "a post_submitted cycle is not complete");

    const mentor = await dashboard(w.mentor);
    assert.ok(mentor.todos.includes(`Sign off cycle ${cyc.code}`), `mentor to-dos: ${mentor.todos}`);
  } finally {
    await w.cleanup();
  }
});

// ── F23: "Q-progress forms due" counts forms that are actually due ───────────
//
// The card counted active pairings with current_quarter set and at least one
// meeting -- a proxy that never looked at feedback_responses, so it could not
// go down when the mentor submitted the quarter's form, and sat at 4 beside
// "Nothing pending -- your queue is clear".
//
// A first fix excluded pairings whose CURRENT quarter's form had a response.
// The real submit action moves the quarter on in the same transaction that
// stores the response (baseline -> Q2, progress_1 -> Q3, ...), so that state
// never arises for Q1-Q3; and a pairing created in the admin grid has no
// quarter at all, which the count skipped. Submitting the baseline made the
// number go UP. So this test drives only the real actions -- logMeetingAction
// and the form runner's submitFormAction -- from a pairing as /admin/data
// creates one.

test("a mentor's quarterly form is owed after a meeting and cleared by submitting it (real actions)", { skip }, async () => {
  const w = await observationWorld("dashforms");
  const formIds: string[] = [];
  try {
    await w.grant(w.mentor.id, "mentorship");
    const { logMeetingAction } = await import("../../apps/web/src/app/(authenticated)/mentorship/[pairingId]/actions.ts");
    const { submitFormAction } = await import("../../apps/web/src/app/(authenticated)/forms/[slug]/page.tsx");

    const state = async () => {
      const d = await dashboard(w.mentor);
      const n = Number((d.stats.match(/Q-progress forms due (\S+)/) ?? [])[1]);
      return { n, todo: /quarterly form/i.test(d.todos), todos: d.todos };
    };
    const quarter = async () =>
      (await w.c.query(`SELECT current_quarter FROM mentor_pairings WHERE id = $1`, [w.pairingId])).rows[0].current_quarter;
    const logMeeting = async (at: Date) => {
      signIn(w.mentor);
      const r = await outcome(() => logMeetingAction(form({ pairingId: w.pairingId, scheduledAt: at.toISOString() })));
      assert.deepEqual(r, { kind: "redirect", location: `/mentorship/${w.pairingId}` }, "the meeting was logged");
    };
    const submit = async (kind: string) => {
      const slug = `${kind}-mentor-${w.T}`;
      const id = (
        await w.c.query(
          `INSERT INTO feedback_forms (kind, audience, schema, version)
           VALUES ($1::feedback_kind, 'mentor', $2, $3) RETURNING id`,
          [kind, JSON.stringify({ fields: [{ name: "summary", kind: "textarea", label: "Summary", required: true }] }), w.T],
        )
      ).rows[0].id as string;
      formIds.push(id);
      signIn(w.mentor);
      const r = await outcome(() =>
        submitFormAction(form({ __formId: id, __slug: slug, __pairingId: w.pairingId, summary: "Going well." })),
      );
      // The thank-you page carries the pairing, so it can link back to it and
      // to its read-only responses (mentorship-forms, F54).
      assert.deepEqual(
        r,
        { kind: "redirect", location: `/forms/${slug}/thanks?pairingId=${encodeURIComponent(w.pairingId)}` },
        `the ${kind} form was accepted`,
      );
    };
    // A meeting just after the latest submission, on the database's clock.
    const justAfterLastForm = async () =>
      new Date(
        (
          (await w.c.query(`SELECT max(submitted_at) AS at FROM feedback_responses WHERE pairing_id = $1`, [w.pairingId]))
            .rows[0].at as Date
        ).getTime() + 1,
      );

    // A pairing as the admin grid creates it: no quarter (read as Q1), no meetings.
    assert.equal(await quarter(), null);
    let s = await state();
    assert.equal(s.n, 0, "no meeting has been held; nothing is owed yet");
    assert.equal(s.todo, false);

    await logMeeting(new Date(Date.now() + 7 * DAY_MS));
    s = await state();
    assert.equal(s.n, 0, "a meeting booked for next week has not been held");

    await logMeeting(new Date(Date.now() - DAY_MS));
    s = await state();
    assert.equal(s.n, 1, "after a meeting, a Q1 pairing (quarter NULL) owes its baseline form");
    assert.ok(s.todo, `a form that is due is a thing waiting on the mentor; to-dos: ${s.todos}`);

    await submit("baseline");
    assert.equal(await quarter(), 2, "the real action moves the pairing into Q2");
    s = await state();
    assert.equal(s.n, 0, "the baseline was submitted: nothing is owed until the next meeting");
    assert.equal(s.todo, false, `submitting the form must clear the to-do; to-dos: ${s.todos}`);

    await logMeeting(await justAfterLastForm());
    s = await state();
    assert.equal(s.n, 1, "a meeting held since the baseline makes the Q2 form owed");
    assert.ok(s.todo);

    await submit("progress_1");
    assert.equal(await quarter(), 3);
    s = await state();
    assert.equal(s.n, 0, "the Q2 form was submitted");
    assert.equal(s.todo, false);

    await logMeeting(await justAfterLastForm());
    await submit("progress_2");
    await logMeeting(await justAfterLastForm());
    assert.equal(await quarter(), 4);
    assert.equal((await state()).n, 1, "Q4 owes the final form after a meeting");

    await submit("final");
    await logMeeting(await justAfterLastForm());
    s = await state();
    assert.equal(s.n, 0, "the final form closes the quarterly cycle; a later meeting owes no further form");
    assert.equal(s.todo, false);
  } finally {
    await w.c.query(`DELETE FROM feedback_responses WHERE pairing_id = $1`, [w.pairingId]);
    if (formIds.length) await w.c.query(`DELETE FROM feedback_forms WHERE id = ANY($1::uuid[])`, [formIds]);
    await w.cleanup();
  }
});

// ── F23: the dashboard follows the section gates, as the nav badge does ──────
//
// The observation badge withholds its number until the viewer has unlocked the
// section (lib/visibility.ts: a locked surface runs no query, "so not even a
// count escapes"). The dashboard ran and showed the same kind of counts -- and
// cycle codes, in the mentor's "Sign off cycle OBS-..." -- with no grant check,
// and likewise the mentorship counts behind the mentorship gate.

test("a locked section's numbers and cycles stay off the dashboard until it is unlocked", { skip }, async () => {
  const w = await observationWorld("dashlock");
  try {
    const signOff = await w.cycle({ status: "post_submitted" });
    await w.cycle({ status: "nominated" });
    await w.cycle({ status: "pre_submitted" });

    const t = await dashboard(w.teacher);
    assert.match(t.stats, /Cycles pending pre-form — Observation locked/);
    assert.match(t.stats, /Cycles awaiting video — Observation locked/);
    assert.doesNotMatch(t.todos, /pre-form|lesson video|post-form/i, `teacher to-dos: ${t.todos}`);
    assert.match(t.todos, /Unlock Observation to see what is waiting on you/);
    assert.doesNotMatch(t.todos, /Nothing pending/, "a locked section is not an empty queue");
    assert.ok(t.all.includes(`href="/gate/observation?next=%2Fdashboard"`), "the row links to the gate and back");

    const o = await dashboard(w.observer);
    assert.match(o.stats, /Cycles I am leading \(active\) — Observation locked/);
    assert.match(o.stats, /Pending observer forms — Observation locked/);
    assert.doesNotMatch(o.todos, /observer form/i);

    const m = await dashboard(w.mentor);
    assert.ok(!m.all.includes(signOff.code), "no cycle code leaves the locked section");
    assert.match(m.stats, /Active mentees — Mentorship locked/);
    assert.match(m.stats, /Q-progress forms due — Mentorship locked/);
    assert.match(m.todos, /Unlock Observation/);
    assert.match(m.todos, /Unlock Mentorship/);

    const a = await dashboard(w.admin);
    assert.match(a.stats, /Cycles in flight — Observation locked/);
    assert.match(a.stats, /Active pairings — Mentorship locked/);
    assert.doesNotMatch(a.todos, /in flight|observer form/i, `admin to-dos: ${a.todos}`);

    for (const u of [w.teacher, w.observer, w.mentor, w.admin]) await w.grant(u.id);
    for (const u of [w.mentor, w.admin]) await w.grant(u.id, "mentorship");

    const t2 = await dashboard(w.teacher);
    assert.match(t2.stats, /Cycles pending pre-form 1 /);
    assert.match(t2.todos, /Submit pre-form for 1 cycle/);
    assert.doesNotMatch(t2.todos, /Unlock/);

    const o2 = await dashboard(w.observer);
    assert.match(o2.stats, /Pending observer forms 1 /);
    assert.match(o2.todos, /Fill observer form for 1 cycle/);

    const m2 = await dashboard(w.mentor);
    assert.ok(m2.todos.includes(`Sign off cycle ${signOff.code}`), `mentor to-dos: ${m2.todos}`);
    assert.match(m2.stats, /Active mentees 1 /);
    assert.doesNotMatch(m2.todos, /Unlock/);

    const a2 = await dashboard(w.admin);
    assert.match(a2.stats, /Cycles in flight \d+ /);
    assert.match(a2.stats, /Active pairings \d+ /);
  } finally {
    await w.cleanup();
  }
});
