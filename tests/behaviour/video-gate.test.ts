// Mentorship and observation videos are behind their section's gate on every
// video surface -- executed.
//
// ── THE DEFECT (F05) ─────────────────────────────────────────────────────────
//
// /mentorship and /observation require a live section_gate_grants row (their
// layouts call assertSectionGate), and the codebase's own rule (lib/visibility
// observationAccess, lib/gated-reads) is that a surface re-serving their data
// outside the section must check the gate too. The video surfaces -- /videos,
// /videos/[id], /api/media/playlist/[id], /api/videos/[id]/event -- decided
// access through assertCanAccessVideo / videoVisibilityFilter alone, which
// never read a grant. So a mentor who had not unlocked mentorship (or whose
// 8-hour grant had expired, or been revoked by rotating the password) could
// still list, open and stream mentor-meeting recordings and mentee quarterly
// videos -- the product's most sensitive artefacts -- and rotating the
// password did not revoke playback.
//
// ── HOW ──────────────────────────────────────────────────────────────────────
//
// The REAL page and route handlers, signed in through the auth stub, against
// Postgres. Rotation is simulated exactly as the rotate route does it: by
// deleting the grant rows.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { signIn, outcome, closeAppDb, type TestUser } from "./_server-actions.js";
import { render, withAppRouter } from "./_ui.js";
import { needsDatabase } from "./_harness.js";
import { observationWorld } from "./_observation-world.js";

const skip = needsDatabase();
after(closeAppDb);

type Videos = { meeting: string; quarterly: string; cycle: string; teachBack: string; ownQuarterly: string };

async function videoWorld(prefix: string) {
  const w = await observationWorld(prefix);
  const fileIds: string[] = [];
  const meetingIds: string[] = [];
  const cycle = await w.cycle();
  const meetingId = (
    await w.c.query(`INSERT INTO mentor_meetings (pairing_id, scheduled_at, notes) VALUES ($1, now(), 'held') RETURNING id`, [w.pairingId])
  ).rows[0].id as string;
  meetingIds.push(meetingId);
  const video = async (contextType: string, contextId: string | null, submittedBy: string, status = "ready") => {
    const fileId = (
      await w.c.query(
        `INSERT INTO files (bucket, object_key, mime_type, kind, status) VALUES ('videos-original', $1, 'video/mp4', 'video_original', 'stored') RETURNING id`,
        [`test/${w.T}/${contextType}/${fileIds.length}`],
      )
    ).rows[0].id as string;
    fileIds.push(fileId);
    return (
      await w.c.query(
        `INSERT INTO video_submissions (file_id, source, status, context_type, context_id, submitted_by_user_id, hls_master_key, verified_at)
         VALUES ($1, 'direct', $2::video_status, $3, $4, $5,
                 CASE WHEN $2 = 'ready' THEN 'hls/test/index.m3u8' END, CASE WHEN $2 = 'ready' THEN now() END)
         RETURNING id`,
        [fileId, status, contextType, contextId, submittedBy],
      )
    ).rows[0].id as string;
  };
  // "queued" so the playlist route stops at not_ready (409) once the gate is
  // passed, before it would reach Storage.
  const v: Videos = {
    meeting: await video("mentor_meeting", meetingId, w.admin.id, "queued"),
    quarterly: await video("mentee_quarterly", w.pairingId, w.admin.id, "queued"),
    cycle: await video("observation_cycle", cycle.id, w.admin.id, "queued"),
    teachBack: await video("teach_back", null, w.teacher.id, "queued"),
    ownQuarterly: await video("mentee_quarterly", w.pairingId, w.teacher.id, "queued"),
  };
  const revoke = async (userId: string) => {
    await w.c.query(`DELETE FROM section_gate_grants WHERE user_id = $1`, [userId]);
  };
  const cleanup = async () => {
    await w.c.query(`DELETE FROM video_submissions WHERE file_id = ANY($1::uuid[])`, [fileIds]);
    await w.c.query(`DELETE FROM files WHERE id = ANY($1::uuid[])`, [fileIds]);
    await w.c.query(`DELETE FROM mentor_meetings WHERE id = ANY($1::uuid[])`, [meetingIds]);
    await w.cleanup();
  };
  return { w, v, revoke, cleanup };
}

const asUser = (u: { id: string; role: string; name: string; email: string }): TestUser => ({ id: u.id, role: u.role, name: u.name, email: u.email });

async function openPage(user: TestUser, id: string) {
  signIn(user);
  const { default: VideoPlayerPage } = await import("../../apps/web/src/app/(authenticated)/videos/[id]/page.tsx");
  return outcome(async () => render(withAppRouter(await VideoPlayerPage({ params: Promise.resolve({ id }) }))));
}

async function playlist(user: TestUser, id: string) {
  signIn(user);
  const { GET } = await import("../../apps/web/src/app/api/media/playlist/[id]/route.ts");
  const res = await GET(new Request(`http://x/api/media/playlist/${id}`), { params: Promise.resolve({ id }) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function event(user: TestUser, id: string) {
  signIn(user);
  const { POST } = await import("../../apps/web/src/app/api/videos/[id]/event/route.ts");
  const res = await POST(
    new Request(`http://x/api/videos/${id}/event`, { method: "POST", body: JSON.stringify({ kind: "play", t: 0 }), headers: { "content-type": "application/json" } }),
    { params: Promise.resolve({ id }) },
  );
  return res.status;
}

async function library(user: TestUser): Promise<string[]> {
  signIn(user);
  const { default: VideoLibraryPage } = await import("../../apps/web/src/app/(authenticated)/videos/page.tsx");
  const html = await render(withAppRouter(await VideoLibraryPage({ searchParams: Promise.resolve({}) })));
  return [...new Set([...html.matchAll(/href="\/videos\/([0-9a-f-]{36})"/g)].map((m) => m[1]!))];
}

const gateRedirect = (slug: string, id: string) => ({ kind: "redirect", location: `/gate/${slug}?next=${encodeURIComponent(`/videos/${id}`)}` });

test("a mentor without the mentorship grant is sent to the gate, and the media routes refuse", { skip }, async () => {
  const { w, v, cleanup } = await videoWorld("vgate");
  try {
    const mentor = asUser(w.mentor);
    for (const id of [v.meeting, v.quarterly]) {
      assert.deepEqual(await openPage(mentor, id), gateRedirect("mentorship", id), "the player page is behind the mentorship gate");
      const p = await playlist(mentor, id);
      assert.equal(p.status, 403, "no playlist, so no signed segment URL, without the grant");
      assert.deepEqual(p.body, { error: "gate_required", gate: "mentorship" });
      assert.equal(await event(mentor, id), 403);
    }
  } finally {
    await cleanup();
  }
});

test("unlocking opens them; rotating the password (deleting the grants) locks them again at once", { skip }, async () => {
  const { w, v, revoke, cleanup } = await videoWorld("vgate");
  try {
    const mentor = asUser(w.mentor);
    await w.grant(w.mentor.id, "mentorship");
    assert.equal((await openPage(mentor, v.meeting)).kind, "returned");
    assert.equal((await playlist(mentor, v.meeting)).status, 409, "past the gate: stops only because it is not transcoded");
    assert.equal(await event(mentor, v.meeting), 204);

    await revoke(w.mentor.id);
    assert.deepEqual(await openPage(mentor, v.meeting), gateRedirect("mentorship", v.meeting));
    assert.equal((await playlist(mentor, v.meeting)).status, 403, "rotation revokes playback");
  } finally {
    await cleanup();
  }
});

test("an admin is gated like everyone else, and one section's grant does not open the other", { skip }, async () => {
  const { w, v, cleanup } = await videoWorld("vgate");
  try {
    const admin = asUser(w.admin);
    const observer = asUser(w.observer);
    await w.grant(w.observer.id, "mentorship");
    assert.deepEqual(await openPage(observer, v.cycle), gateRedirect("observation", v.cycle), "a mentorship grant is not an observation grant");
    await w.grant(w.observer.id, "observation");
    assert.equal((await openPage(observer, v.cycle)).kind, "returned");

    // An admin who holds no grant. (The world's admin uploaded these clips, so
    // hand this one to the teacher first: the own-upload exemption is tested
    // on its own below.)
    await w.c.query(`UPDATE video_submissions SET submitted_by_user_id = $1 WHERE id = $2`, [w.teacher.id, v.meeting]);
    assert.deepEqual(await openPage(admin, v.meeting), gateRedirect("mentorship", v.meeting), "the layouts gate admins too");
  } finally {
    await cleanup();
  }
});

test("your own upload and a teach-back need no section grant", { skip }, async () => {
  const { w, v, cleanup } = await videoWorld("vgate");
  try {
    const teacher = asUser(w.teacher);
    assert.equal((await openPage(teacher, v.ownQuarterly)).kind, "returned", "the uploader already holds the bytes");
    assert.equal((await playlist(teacher, v.ownQuarterly)).status, 409);
    assert.equal((await openPage(teacher, v.teachBack)).kind, "returned");
    assert.equal((await openPage(asUser(w.mentor), v.teachBack)).kind, "returned", "teach-backs are not in a gated section");
  } finally {
    await cleanup();
  }
});

test("/videos does not list a locked section's videos, and lists them once unlocked", { skip }, async () => {
  const { w, v, revoke, cleanup } = await videoWorld("vgate");
  try {
    const mentor = asUser(w.mentor);
    const locked = await library(mentor);
    assert.ok(!locked.includes(v.meeting) && !locked.includes(v.quarterly), "mentorship recordings are not listed without the grant");
    assert.ok(locked.includes(v.teachBack), "ungated videos still are");

    await w.grant(w.mentor.id, "mentorship");
    const open = await library(mentor);
    assert.ok(open.includes(v.meeting) && open.includes(v.quarterly));

    await revoke(w.mentor.id);
    const teacher = await library(asUser(w.teacher));
    assert.ok(teacher.includes(v.ownQuarterly), "a teacher's own upload stays in her library");
    assert.ok(!teacher.includes(v.quarterly), "but not the pairing's other mentorship video");
  } finally {
    await cleanup();
  }
});

