// Meetings tell the other party, and a wrong entry can be removed -- executed
// through the real server actions.
//
// ── F21 (meeting kinds) ──────────────────────────────────────────────────────
//
// The settings page offers "Meeting scheduled — Mentor + teacher receive
// calendar entry" and "Meeting cancelled — Both parties notified", and
// meeting.scheduled is on by default, but logMeetingAction wrote only its own
// row and an audit entry: nothing ever wrote either kind, so the mentee's bell
// stayed at 0. There was no way to cancel a meeting either (F60: nothing could
// remove a mistaken one, and it inflated meetings_count for good).

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { buildWorld, closeAppPool, describe, formData, outcome, signIn, type Person, type World } from "./_mentorship.js";
import { needsDatabase } from "./_harness.js";

const skip = needsDatabase();
after(closeAppPool);

async function withWorld(body: (w: World) => Promise<void>) {
  const w = await buildWorld("meetn");
  try {
    for (const p of [w.mentor, w.teacherA]) await w.grant(p.id);
    await body(w);
  } finally {
    signIn(null);
    await w.cleanup();
  }
}

async function actions() {
  return import("../../apps/web/src/app/(authenticated)/mentorship/[pairingId]/actions.ts");
}

async function as<T>(who: Person, fn: () => Promise<T>) {
  signIn(who);
  return outcome(fn);
}

const notes = (w: World, userId: string) =>
  w.q<{ kind: string; entity_type: string; entity_id: string; subject: string; body: string | null }>(
    `SELECT kind, entity_type, entity_id, subject, body FROM notifications WHERE user_id = $1 ORDER BY created_at`,
    [userId],
  );

/**
 * A notification carries nothing the mentorship password guards.
 *
 * /inbox has no gate, so a row there is readable by a borrowed session that
 * never entered the password -- and the rows used to carry the mentor's
 * free-text meeting notes (as the body) and both people's names (in the
 * subject): the pairing roster and the meeting record, outside the section.
 * The row links to the gated pairing page, which is where the detail belongs.
 */
function assertNothingGated(w: World, rows: Array<{ subject: string; body: string | null }>, meetingNotes: string) {
  for (const row of rows) {
    const text = `${row.subject}
${row.body ?? ""}`;
    assert.equal(row.body, null, "no body: the meeting's notes stay on the pairing page");
    assert.ok(!text.includes(meetingNotes), `the meeting notes are not in the notification: ${text}`);
    for (const p of [w.teacherA, w.teacherB, w.mentor]) {
      assert.ok(!text.includes(p.name), `no name of the pairing's people (${p.name}) in: ${text}`);
    }
  }
}

test("logging a meeting notifies the mentee, not the mentor who logged it", { skip }, async () => {
  await withWorld(async (w) => {
    const { logMeetingAction } = await actions();
    const r = await as(w.mentor, () =>
      logMeetingAction(formData({ pairingId: w.pairingA, scheduledAt: "2026-10-02T10:30", durationMin: "45", notes: "phonics plan" })),
    );
    assert.equal(r.kind, "redirect", describe(r));
    const forMentee = await notes(w, w.teacherA.id);
    assert.equal(forMentee.length, 1);
    assert.equal(forMentee[0]!.kind, "meeting.scheduled");
    assert.equal(forMentee[0]!.entity_type, "mentor_pairing");
    assert.equal(forMentee[0]!.entity_id, w.pairingA, "the notification opens the pairing");
    assert.match(forMentee[0]!.subject, /^A mentorship meeting was logged for Fri,? 2 Oct/);
    assertNothingGated(w, forMentee, "phonics plan");
    assert.deepEqual(await notes(w, w.mentor.id), [], "the actor is not told about their own action");
  });
});

test("a meeting an administrator logs tells both parties, and neither row carries the notes or a name", { skip }, async () => {
  await withWorld(async (w) => {
    await w.grant(w.admin.id);
    const { logMeetingAction } = await actions();
    const r = await as(w.admin, () =>
      logMeetingAction(formData({ pairingId: w.pairingA, scheduledAt: "2026-10-02T10:30", notes: "reading corner, fluency concerns" })),
    );
    assert.equal(r.kind, "redirect", describe(r));
    const rows = [...(await notes(w, w.mentor.id)), ...(await notes(w, w.teacherA.id))];
    assert.equal(rows.length, 2, "the mentor and the mentee");
    assertNothingGated(w, rows, "reading corner, fluency concerns");
  });
});

const DAY_MS = 24 * 60 * 60 * 1000;

/** One meeting a week ago and one booked for next week, oldest first. */
async function seedMeetings(w: World) {
  const { logMeetingAction } = await actions();
  for (const at of [new Date(Date.now() - 7 * DAY_MS), new Date(Date.now() + 7 * DAY_MS)]) {
    const r = await as(w.mentor, () => logMeetingAction(formData({ pairingId: w.pairingA, scheduledAt: at.toISOString() })));
    assert.equal(r.kind, "redirect", describe(r));
  }
  const rows = await w.q<{ id: string; scheduled_at: Date }>(
    `SELECT id, scheduled_at FROM mentor_meetings WHERE pairing_id = $1 ORDER BY scheduled_at`,
    [w.pairingA],
  );
  await w.q(`DELETE FROM notifications WHERE user_id = ANY($1::uuid[])`, [[w.teacherA.id, w.mentor.id]]);
  return { past: rows[0]!, upcoming: rows[1]! };
}

const meetingCount = async (w: World) =>
  (await w.q<{ n: number }>(`SELECT count(*)::int AS n FROM mentor_meetings WHERE pairing_id = $1`, [w.pairingA]))[0]!.n;

test("the mentor can cancel an upcoming meeting: it goes, the counters follow, the mentee is told", { skip }, async () => {
  await withWorld(async (w) => {
    const { past, upcoming } = await seedMeetings(w);
    const { cancelMeetingAction } = await actions();
    const r = await as(w.mentor, () =>
      cancelMeetingAction(formData({ pairingId: w.pairingA, meetingId: upcoming.id, confirm: "1" })),
    );
    assert.deepEqual(r, { kind: "redirect", to: `/mentorship/${w.pairingA}` });

    const left = await w.q<{ id: string }>(`SELECT id FROM mentor_meetings WHERE pairing_id = $1`, [w.pairingA]);
    assert.deepEqual(left.map((m) => m.id), [past.id]);
    const [p] = await w.q<{ meetings_count: number; last_meeting_at: Date }>(
      `SELECT meetings_count, last_meeting_at FROM mentor_pairings WHERE id = $1`,
      [w.pairingA],
    );
    assert.equal(p!.meetings_count, 1);
    assert.equal(new Date(p!.last_meeting_at).getTime(), new Date(past.scheduled_at).getTime(), "last meeting falls back to the one that remains");

    const told = await notes(w, w.teacherA.id);
    assert.deepEqual(told.map((n) => [n.kind, n.entity_id]), [["meeting.cancelled", w.pairingA]]);
    assertNothingGated(w, told, "phonics plan");
  });
});

// ── F60 (review): one tap deleted a meeting for good ─────────────────────────
//
// "Cancel meeting" was a one-button form: a single tap on a phone removed the
// row permanently, with no confirmation, and it was offered on meetings that
// had already happened -- whose removal then sent a "meeting cancelled" notice
// about a meeting that took place.

test("cancelling asks first: a post without the confirmation changes nothing and asks", { skip }, async () => {
  await withWorld(async (w) => {
    const { upcoming } = await seedMeetings(w);
    const { cancelMeetingAction } = await actions();
    const r = await as(w.mentor, () => cancelMeetingAction(formData({ pairingId: w.pairingA, meetingId: upcoming.id })));
    assert.deepEqual(r, { kind: "redirect", to: `/mentorship/${w.pairingA}?confirmCancel=${upcoming.id}` });
    assert.equal(await meetingCount(w), 2, "nothing removed");
    assert.deepEqual(await notes(w, w.teacherA.id), [], "nobody told");
  });
});

test("a meeting that already happened is removed from the record, and nobody is told it was cancelled", { skip }, async () => {
  await withWorld(async (w) => {
    const { past, upcoming } = await seedMeetings(w);
    const { cancelMeetingAction } = await actions();
    const r = await as(w.mentor, () => cancelMeetingAction(formData({ pairingId: w.pairingA, meetingId: past.id, confirm: "1" })));
    assert.deepEqual(r, { kind: "redirect", to: `/mentorship/${w.pairingA}` });
    const left = await w.q<{ id: string }>(`SELECT id FROM mentor_meetings WHERE pairing_id = $1`, [w.pairingA]);
    assert.deepEqual(left.map((m) => m.id), [upcoming.id]);
    const [p] = await w.q<{ meetings_count: number }>(`SELECT meetings_count FROM mentor_pairings WHERE id = $1`, [w.pairingA]);
    assert.equal(p!.meetings_count, 1);
    assert.deepEqual(await notes(w, w.teacherA.id), [], "no 'cancelled' notice about a meeting that took place");
  });
});

test("a mentee cannot cancel a meeting, and one with a recording is kept", { skip }, async () => {
  await withWorld(async (w) => {
    const { past, upcoming } = await seedMeetings(w);
    const { cancelMeetingAction } = await actions();
    const byMentee = await as(w.teacherA, () =>
      cancelMeetingAction(formData({ pairingId: w.pairingA, meetingId: upcoming.id, confirm: "1" })),
    );
    assert.deepEqual(byMentee, { kind: "redirect", to: `/mentorship/${w.pairingA}?error=meetings_mentor_only` });

    await w.q(`UPDATE mentor_meetings SET recording_video_id = gen_random_uuid() WHERE id = $1`, [past.id]);
    const withRecording = await as(w.mentor, () =>
      cancelMeetingAction(formData({ pairingId: w.pairingA, meetingId: past.id, confirm: "1" })),
    );
    assert.deepEqual(withRecording, { kind: "redirect", to: `/mentorship/${w.pairingA}?error=meeting_has_recording` });

    assert.equal(await meetingCount(w), 2);
  });
});

test("the pairing page asks the mentor to confirm before cancelling or removing, and offers the mentee neither", { skip }, async () => {
  await withWorld(async (w) => {
    const { past, upcoming } = await seedMeetings(w);
    const { render, decodeEntities } = await import("./_ui.js");
    const { default: PairingDetailPage } = await import("../../apps/web/src/app/(authenticated)/mentorship/[pairingId]/page.tsx");
    const html = async (who: Person, sp: Record<string, string> = {}) => {
      signIn(who);
      const r = await outcome(() => PairingDetailPage({ params: Promise.resolve({ pairingId: w.pairingA }), searchParams: Promise.resolve(sp) }));
      assert.equal(r.kind, "value", describe(r));
      return decodeEntities(await render((r as { value: unknown }).value));
    };
    const confirmHref = (id: string) => `href="/mentorship/${w.pairingA}\\?confirmCancel=${id}"`;

    // The list only LINKS to a confirmation: one tap removes nothing.
    const list = await html(w.mentor);
    assert.match(list, new RegExp(`${confirmHref(upcoming.id)}[^>]*>Cancel meeting<`));
    assert.match(list, new RegExp(`${confirmHref(past.id)}[^>]*>Remove<`), "a past meeting is removed, not cancelled");
    assert.doesNotMatch(list, /name="confirm"/, "no form that removes a meeting until one is chosen");

    const askCancel = await html(w.mentor, { confirmCancel: upcoming.id });
    assert.match(askCancel, /Yes, cancel it/);
    assert.match(askCancel, /will be told/);
    assert.match(askCancel, /name="confirm" value="1"/);
    assert.match(askCancel, new RegExp(`name="meetingId" value="${upcoming.id}"`));

    const askRemove = await html(w.mentor, { confirmCancel: past.id });
    assert.match(askRemove, /Yes, remove it/);
    assert.doesNotMatch(askRemove, /will be told/, "removing a past meeting tells nobody");

    const mentee = await html(w.teacherA, { confirmCancel: upcoming.id });
    assert.doesNotMatch(mentee, /Cancel meeting|>Remove<|Yes, cancel it|name="confirm"/);
  });
});

test("a meeting id from another pairing cannot be cancelled through this one", { skip }, async () => {
  await withWorld(async (w) => {
    const { upcoming: m } = await seedMeetings(w);
    const { cancelMeetingAction } = await actions();
    // The mentor owns both pairings; the meeting belongs to A, the form names B.
    const r = await as(w.mentor, () => cancelMeetingAction(formData({ pairingId: w.pairingB, meetingId: m.id, confirm: "1" })));
    assert.deepEqual(r, { kind: "redirect", to: `/mentorship/${w.pairingB}?error=meeting_not_found` });
    const [{ n }] = await w.q<{ n: number }>(`SELECT count(*)::int AS n FROM mentor_meetings WHERE id = $1`, [m.id]);
    assert.equal(n, 1);
  });
});
