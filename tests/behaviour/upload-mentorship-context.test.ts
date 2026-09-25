// What a direct upload may be attached to in mentorship -- executed through the
// real /uploads server action, against Postgres.
//
// ── THE DEFECT (F50) ─────────────────────────────────────────────────────────
//
// CLAUDE.md defines the Mentorship surface as meeting recordings plus Q1/Q4
// mentee videos, and neither could be attached by any path. Underneath the
// missing UI, the upload guard and every reader disagreed on what a
// mentor_meeting context id IS:
//
//   beginUploadAction (assertContextAllowed)   a PAIRING id
//   assertCanAccessVideo, videoVisibilityFilter,
//   the WhatsApp MM- branch                    a MEETING id
//
// So no id worked for both: the meeting's own id was refused at reservation
// (a 404 for the pairing's mentor), and the pairing id the guard accepted made
// a recording the mentee could not open. And a context with no id at all
// passed the guard ("!contextId -> allowed"), storing a cycle or meeting video
// that is linked to nothing and visible to nobody but its uploader. A
// quarterly video carried no quarter, so a Q1 and a Q4 video were
// indistinguishable.
//
// ── HOW ──────────────────────────────────────────────────────────────────────
//
// beginUploadAction runs for real, signed in through the auth stub; its guard,
// its reservation and the rows it writes are the production code. The reader
// side is the real assertCanAccessVideo.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { signIn, outcome, closeAppDb, type TestUser } from "./_server-actions.js";
import { needsDatabase } from "./_harness.js";
import { observationWorld, type ObservationWorld, type WorldUser } from "./_observation-world.js";

const skip = needsDatabase();
after(async () => {
  if (!skip) await closeAppDb();
});

// beginUploadAction refuses to reserve anything on a deployment without the two
// public Supabase values; any value will do, nothing here reaches Storage.
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://storage.test";
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??= "publishable-test-key";

const action = () => import("../../apps/web/src/app/(authenticated)/uploads/actions.ts");
const authz = () => import("../../apps/web/src/lib/authz.ts");

const asUser = (u: WorldUser): TestUser => ({ id: u.id, role: u.role, name: u.name, email: u.email });

type World = ObservationWorld & { meetingId: string; otherMentor: WorldUser };

async function withWorld(body: (w: World) => Promise<void>) {
  const w = await observationWorld("upmc");
  const one = async (q: string, p: unknown[]) => (await w.c.query(q, p)).rows[0].id as string;
  const meetingId = await one(
    `INSERT INTO mentor_meetings (pairing_id, scheduled_at, notes) VALUES ($1, now() - interval '1 day', 'held') RETURNING id`,
    [w.pairingId],
  );
  // A mentor with a pairing of their own -- just not this one.
  const otherMentorUser = await one(
    `INSERT INTO users (id, email, name, role) VALUES (gen_random_uuid(), $1, $2, 'mentor') RETURNING id`,
    [`other-mentor.${w.T}@example.test`, `Other Mentor ${w.T}`],
  );
  const otherMentorId = await one(`INSERT INTO mentors (user_id, name) VALUES ($1, $2) RETURNING id`, [otherMentorUser, `Other ${w.T}`]);
  const people = [w.admin, w.teacher, w.mentor, w.observer, w.otherObserver].map((p) => p.id).concat(otherMentorUser);
  try {
    await body({ ...w, meetingId, otherMentor: { id: otherMentorUser, role: "mentor", name: `Other Mentor ${w.T}`, email: "" } });
  } finally {
    signIn(null);
    const subs = (await w.c.query(`SELECT id, file_id FROM video_submissions WHERE submitted_by_user_id = ANY($1::uuid[])`, [people])).rows;
    for (const s of subs) await w.c.query(`DELETE FROM jobs WHERE dedupe_key = $1`, [`submission:${s.id}`]);
    await w.c.query(`UPDATE mentor_meetings SET recording_video_id = NULL WHERE id = $1`, [meetingId]);
    await w.c.query(`DELETE FROM video_submissions WHERE submitted_by_user_id = ANY($1::uuid[])`, [people]);
    await w.c.query(`DELETE FROM files WHERE owner_user_id = ANY($1::uuid[])`, [people]);
    await w.c.query(`DELETE FROM mentors WHERE id = $1`, [otherMentorId]);
    await w.c.query(`DELETE FROM users WHERE id = $1`, [otherMentorUser]);
    await w.cleanup();
  }
}

let seq = 0;
async function begin(who: WorldUser, input: { contextType: string; contextId?: string | null; quarter?: number | null }) {
  signIn(asUser(who));
  const { beginUploadAction } = await action();
  seq += 1;
  return outcome(() =>
    beginUploadAction({ filename: `lesson-${seq}.mp4`, sizeBytes: 1000 + seq, contentType: "video/mp4", ...input } as never),
  );
}

async function row(w: World, submissionId: string) {
  return (await w.c.query(`SELECT * FROM video_submissions WHERE id = $1`, [submissionId])).rows[0] as Record<string, unknown>;
}

function reserved(r: Awaited<ReturnType<typeof begin>>): string {
  assert.equal(r.kind, "returned", `expected a reservation, got ${JSON.stringify(r)}`);
  const v = (r as { value: { ok: boolean; submissionId?: string; error?: string } }).value;
  assert.equal(v.ok, true, `refused: ${v.error}`);
  return v.submissionId!;
}

function refused(r: Awaited<ReturnType<typeof begin>>): string {
  assert.equal(r.kind, "returned", `expected a refusal message, got ${JSON.stringify(r)}`);
  const v = (r as { value: { ok: boolean; error?: string } }).value;
  assert.equal(v.ok, false, "the upload was reserved");
  return v.error!;
}

test("F50: the pairing's mentor attaches a recording to a meeting by the meeting's own id", { skip }, async () => {
  await withWorld(async (w) => {
    const id = reserved(await begin(w.mentor, { contextType: "mentor_meeting", contextId: w.meetingId }));
    const r = await row(w, id);
    assert.equal(r.context_type, "mentor_meeting");
    assert.equal(r.context_id, w.meetingId, "recorded against the meeting, not just the pairing");
  });
});

test("F50: a meeting recording is refused outside the pairing, and for a pairing id posing as a meeting", { skip }, async () => {
  await withWorld(async (w) => {
    for (const stranger of [w.otherMentor, w.observer]) {
      assert.deepEqual(await begin(stranger, { contextType: "mentor_meeting", contextId: w.meetingId }), { kind: "notFound" }, stranger.role);
    }
    // The shape the guard used to demand: it stored a recording no reader
    // could resolve to a meeting, so the mentee got a 404 for it.
    assert.deepEqual(await begin(w.mentor, { contextType: "mentor_meeting", contextId: w.pairingId }), { kind: "notFound" });
  });
});

test("F50: a quarterly video names its pairing and its quarter, Q1 or Q4", { skip }, async () => {
  await withWorld(async (w) => {
    const id = reserved(await begin(w.teacher, { contextType: "mentee_quarterly", contextId: w.pairingId, quarter: 1 }));
    const r = await row(w, id);
    assert.equal(r.context_type, "mentee_quarterly");
    assert.equal(r.context_id, w.pairingId);
    assert.equal(r.context_quarter, 1, "which quarter the video is for is kept on the submission");

    assert.match(refused(await begin(w.teacher, { contextType: "mentee_quarterly", contextId: w.pairingId })), /Q1|Q4|quarter/i);
    assert.match(refused(await begin(w.teacher, { contextType: "mentee_quarterly", contextId: w.pairingId, quarter: 2 })), /Q1|Q4|quarter/i);
    // Q4 is the endline: not before the pairing has reached it.
    assert.match(refused(await begin(w.teacher, { contextType: "mentee_quarterly", contextId: w.pairingId, quarter: 4 })), /Q4/);
    await w.c.query(`UPDATE mentor_pairings SET current_quarter = 4 WHERE id = $1`, [w.pairingId]);
    reserved(await begin(w.teacher, { contextType: "mentee_quarterly", contextId: w.pairingId, quarter: 4 }));

    assert.deepEqual(
      await begin(w.otherObserver, { contextType: "mentee_quarterly", contextId: w.pairingId, quarter: 1 }),
      { kind: "notFound" },
      "someone off the pairing cannot attach a video to it",
    );
    // A quarter means nothing for any other context.
    assert.match(refused(await begin(w.teacher, { contextType: "generic", quarter: 1 })), /quarter/i);
  });
});

test("F50: a cycle, meeting or quarterly upload with no target is refused, not stored linked to nothing", { skip }, async () => {
  await withWorld(async (w) => {
    for (const contextType of ["observation_cycle", "mentor_meeting", "mentee_quarterly"]) {
      assert.match(refused(await begin(w.admin, { contextType, contextId: null, quarter: contextType === "mentee_quarterly" ? 1 : null })), /choose|which/i, contextType);
    }
    const n = (await w.c.query(`SELECT count(*)::int AS n FROM video_submissions WHERE submitted_by_user_id = $1`, [w.admin.id])).rows[0].n;
    assert.equal(n, 0, "nothing was reserved");
    // A video for nothing in particular is still welcome, as 'generic'.
    reserved(await begin(w.teacher, { contextType: "generic" }));
  });
});

test("F50: what the guard lets one side of a pairing attach, the other side can open -- and an observer cannot", { skip }, async () => {
  await withWorld(async (w) => {
    const { assertCanAccessVideo } = await authz();
    const recording = reserved(await begin(w.mentor, { contextType: "mentor_meeting", contextId: w.meetingId }));
    const quarterly = reserved(await begin(w.teacher, { contextType: "mentee_quarterly", contextId: w.pairingId, quarter: 1 }));
    const reads = async (who: WorldUser, id: string) => outcome(() => assertCanAccessVideo({ id: who.id, role: who.role }, id));
    assert.equal((await reads(w.teacher, recording)).kind, "returned", "the mentee opens her mentor's meeting recording");
    assert.equal((await reads(w.mentor, quarterly)).kind, "returned", "the mentor opens his mentee's quarterly video");
    for (const id of [recording, quarterly]) {
      assert.deepEqual(await reads(w.observer, id), { kind: "notFound" });
      assert.deepEqual(await reads(w.otherMentor, id), { kind: "notFound" });
    }
  });
});
