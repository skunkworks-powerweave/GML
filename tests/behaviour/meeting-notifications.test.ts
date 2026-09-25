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

async function seedMeetings(w: World) {
  const { logMeetingAction } = await actions();
  for (const at of ["2026-09-01T10:00", "2026-09-15T10:00"]) {
    const r = await as(w.mentor, () => logMeetingAction(formData({ pairingId: w.pairingA, scheduledAt: at })));
    assert.equal(r.kind, "redirect", describe(r));
  }
  return w.q<{ id: string; scheduled_at: Date }>(
    `SELECT id, scheduled_at FROM mentor_meetings WHERE pairing_id = $1 ORDER BY scheduled_at`,
    [w.pairingA],
  );
}

test("the mentor can cancel a meeting: it goes, the counters follow, the mentee is told", { skip }, async () => {
  await withWorld(async (w) => {
    const [early, late] = await seedMeetings(w);
    await w.q(`DELETE FROM notifications WHERE user_id = $1`, [w.teacherA.id]);
    const { cancelMeetingAction } = await actions();
    const r = await as(w.mentor, () => cancelMeetingAction(formData({ pairingId: w.pairingA, meetingId: late!.id })));
    assert.equal(r.kind, "redirect", describe(r));

    const left = await w.q<{ id: string }>(`SELECT id FROM mentor_meetings WHERE pairing_id = $1`, [w.pairingA]);
    assert.deepEqual(left.map((m) => m.id), [early!.id]);
    const [p] = await w.q<{ meetings_count: number; last_meeting_at: Date }>(
      `SELECT meetings_count, last_meeting_at FROM mentor_pairings WHERE id = $1`,
      [w.pairingA],
    );
    assert.equal(p!.meetings_count, 1);
    assert.equal(new Date(p!.last_meeting_at).getTime(), new Date(early!.scheduled_at).getTime(), "last meeting falls back to the one that remains");

    const told = await notes(w, w.teacherA.id);
    assert.deepEqual(told.map((n) => [n.kind, n.entity_id]), [["meeting.cancelled", w.pairingA]]);
    assertNothingGated(w, told, "phonics plan");
  });
});

test("a mentee cannot cancel a meeting, and one with a recording is kept", { skip }, async () => {
  await withWorld(async (w) => {
    const [first, second] = await seedMeetings(w);
    const { cancelMeetingAction } = await actions();
    const byMentee = await as(w.teacherA, () => cancelMeetingAction(formData({ pairingId: w.pairingA, meetingId: first!.id })));
    assert.equal(byMentee.kind, "redirect", describe(byMentee));

    await w.q(`UPDATE mentor_meetings SET recording_video_id = gen_random_uuid() WHERE id = $1`, [second!.id]);
    const withRecording = await as(w.mentor, () => cancelMeetingAction(formData({ pairingId: w.pairingA, meetingId: second!.id })));
    assert.deepEqual(withRecording, { kind: "redirect", to: `/mentorship/${w.pairingA}?error=meeting_has_recording` });

    const [{ n }] = await w.q<{ n: number }>(`SELECT count(*)::int AS n FROM mentor_meetings WHERE pairing_id = $1`, [w.pairingA]);
    assert.equal(n, 2);
  });
});

test("the pairing page offers the mentor, not the mentee, a way to cancel a meeting", { skip }, async () => {
  await withWorld(async (w) => {
    await seedMeetings(w);
    const { render, decodeEntities } = await import("./_ui.js");
    const { default: PairingDetailPage } = await import("../../apps/web/src/app/(authenticated)/mentorship/[pairingId]/page.tsx");
    const html = async (who: Person) => {
      signIn(who);
      const r = await outcome(() => PairingDetailPage({ params: Promise.resolve({ pairingId: w.pairingA }), searchParams: Promise.resolve({}) }));
      assert.equal(r.kind, "value", describe(r));
      return decodeEntities(await render((r as { value: unknown }).value));
    };
    assert.equal((await html(w.mentor)).match(/Cancel meeting/g)?.length, 2);
    assert.doesNotMatch(await html(w.teacherA), /Cancel meeting/);
  });
});

test("a meeting id from another pairing cannot be cancelled through this one", { skip }, async () => {
  await withWorld(async (w) => {
    const [m] = await seedMeetings(w);
    const { cancelMeetingAction } = await actions();
    // The mentor owns both pairings; the meeting belongs to A, the form names B.
    const r = await as(w.mentor, () => cancelMeetingAction(formData({ pairingId: w.pairingB, meetingId: m!.id })));
    assert.equal(r.kind, "redirect", describe(r));
    const [{ n }] = await w.q<{ n: number }>(`SELECT count(*)::int AS n FROM mentor_meetings WHERE id = $1`, [m!.id]);
    assert.equal(n, 1);
  });
});
