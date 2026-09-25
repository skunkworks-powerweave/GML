// A video reaches its cycle, or its meeting, whichever way it arrived --
// executed through the WhatsApp webhook and worker and through the direct
// upload's completion, against Postgres.
//
// ── THE DEFECT (F03) ─────────────────────────────────────────────────────────
//
// The cycle page's Evidence card reads observation_evidence, and the ONLY
// writer of that table was finalizeUpload -- the direct upload's transition.
// The WhatsApp path, which the product calls primary and which the empty card
// itself tells the teacher to use ("Teacher uploads via WhatsApp with caption
// OBS-..."), resolved the caption to the cycle, stored and transcoded the
// video, and never linked it. The teacher, her observer and her mentor all
// kept reading "Evidence · 0 -- No video evidence linked yet", while the clip
// sat in /videos.
//
// Meeting recordings had the same gap on both paths: the pairing page shows a
// meeting's recording through mentor_meetings.recording_video_id, which
// nothing in the codebase wrote, so an MM-<meeting> recording never appeared on
// its meeting.
//
// Linking is now ONE function (linkSubmissionToContext, packages/db/src/
// uploads.ts), run where each path verifies the bytes: finalizeUpload for a
// direct upload, the worker's fetch for WhatsApp.
//
// A meeting can have more than one recording: a long meeting sent over
// WhatsApp arrives in parts (a video message stops at 16 MB), and a first
// upload can be the wrong file or fail to transcode. The first fix wrote only
// the first into recording_video_id and the page showed only that column, so
// every later part was accepted -- the sender told "It will be on the meeting"
// -- and then shown nowhere. The pairing page now lists every recording stored
// against the meeting.
//
// A cycle signed off while its video was still arriving gets no evidence row
// (the closed record is not reopened), and the video no longer claims the
// cycle either: it is made 'generic' again, audited, so its uploader sees it
// as not linked on /uploads and can attach it where it belongs.
//
// ── HOW ──────────────────────────────────────────────────────────────────────
//
// A signed Meta payload through the real webhook, then the real worker handler
// with Graph and Storage replaced (see _whatsapp.ts); the direct upload through
// the real beginUpload/completeUpload with Storage's stat answered from a map;
// the cycle page rendered as the teacher.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { signIn, closeAppDb } from "./_server-actions.js";
import { render, withAppRouter, decodeEntities, elements, attr } from "./_ui.js";
import { needsDatabase } from "./_harness.js";
import {
  acceptAndClaim,
  envelope,
  fakeGraph,
  fakeStorage,
  route,
  SECRET,
  signed,
  videoMessage,
  waitFor,
  withEnv,
  withWorld,
  type World,
} from "./_whatsapp.js";

const skip = needsDatabase();
after(async () => {
  if (!skip) await closeAppDb();
});

const CONFIGURED = { WHATSAPP_APP_SECRET: SECRET, WHATSAPP_ACCESS_TOKEN: undefined };
const fetcher = () => import("../../apps/worker/src/whatsapp-fetch.ts");
const webUpload = () => import("../../apps/web/src/lib/video/upload.ts");

/** Run the worker's fetch for a claimed job, with Graph and Storage faked. */
async function fetchJob(job: { payload: unknown; attempts: number; maxAttempts: number }) {
  const { fetchWhatsAppMedia } = await fetcher();
  await fetchWhatsAppMedia(job.payload as never, { attempt: job.attempts, maxAttempts: job.maxAttempts }, {
    fetch: fakeGraph().fetch,
    put: fakeStorage().put,
    env: { WHATSAPP_ACCESS_TOKEN: "test-token" },
  });
}

async function evidenceFor(w: World, submissionId: string) {
  return (
    await w.c.query(`SELECT cycle_id, caption FROM observation_evidence WHERE video_submission_id = $1`, [submissionId])
  ).rows as Array<{ cycle_id: string; caption: string | null }>;
}

/** What linkSubmissionToContext recorded when it took a video off a closed cycle. */
async function unlinkedAudits(w: World, submissionId: string) {
  return (
    await w.c.query(`SELECT metadata FROM audit_log WHERE action = 'video.context.unlinked' AND entity_id = $1`, [submissionId])
  ).rows.map((r) => r.metadata as Record<string, unknown>);
}

/** The world's teacher as the mentee of a pairing with one past meeting. */
async function withMeeting(w: World, body: (m: { meetingId: string; pairingId: string }) => Promise<void>) {
  const one = async (q: string, p: unknown[]) => (await w.c.query(q, p)).rows[0].id as string;
  const mentorId = await one(`INSERT INTO mentors (name) VALUES ($1) RETURNING id`, [`Mentor ${w.T}`]);
  const pairingId = await one(`INSERT INTO mentor_pairings (mentor_id, teacher_id) VALUES ($1, $2) RETURNING id`, [
    mentorId,
    w.teacher.teacherId,
  ]);
  const meetingId = await one(
    `INSERT INTO mentor_meetings (pairing_id, scheduled_at) VALUES ($1, now() - interval '1 hour') RETURNING id`,
    [pairingId],
  );
  try {
    await body({ meetingId, pairingId });
  } finally {
    await w.c.query(`DELETE FROM section_gate_grants WHERE user_id = $1`, [w.teacher.userId]);
    await w.c.query(`DELETE FROM mentor_meetings WHERE id = $1`, [meetingId]);
    await w.c.query(`DELETE FROM mentor_pairings WHERE id = $1`, [pairingId]);
    await w.c.query(`DELETE FROM mentors WHERE id = $1`, [mentorId]);
  }
}

/** Direct uploads made in a test; the WhatsApp world only removes its own rows. */
async function removeDirectUploads(w: World) {
  const subs = (
    await w.c.query(`SELECT id FROM video_submissions WHERE source = 'direct' AND submitted_by_user_id = $1`, [w.teacher.userId])
  ).rows as Array<{ id: string }>;
  for (const s of subs) await w.c.query(`DELETE FROM jobs WHERE dedupe_key = $1`, [`submission:${s.id}`]);
  await w.c.query(`DELETE FROM observation_evidence WHERE video_submission_id = ANY($1::uuid[])`, [subs.map((s) => s.id)]);
  await w.c.query(`DELETE FROM video_submissions WHERE source = 'direct' AND submitted_by_user_id = $1`, [w.teacher.userId]);
  await w.c.query(`DELETE FROM files WHERE owner_user_id = $1`, [w.teacher.userId]);
}

/** Reserve and confirm a direct upload as the world's teacher. */
async function directUpload(w: World, contextType: string, contextId: string) {
  const { beginUpload, completeUpload } = await webUpload();
  const r = await beginUpload({
    userId: w.teacher.userId,
    filename: `lesson-${Math.random().toString(36).slice(2)}.mp4`,
    sizeBytes: 4096,
    contentType: "video/mp4",
    contextType: contextType as never,
    contextId,
  });
  assert.ok(!("error" in r), JSON.stringify(r));
  const reservation = r as Exclude<typeof r, { error: string }>;
  const done = await completeUpload({
    submissionId: reservation.submissionId,
    userId: w.teacher.userId,
    isAdmin: false,
    caption: "lesson note",
    stat: async () => ({ size: 4096 }),
  });
  assert.equal(done.ok, true, JSON.stringify(done));
  return reservation.submissionId;
}

async function cyclePageText(w: World) {
  signIn({ id: w.teacher.userId, role: "teacher" });
  const { default: CycleDetailPage } = await import("../../apps/web/src/app/(authenticated)/observation/[cycleId]/page.tsx");
  const html = await render(
    withAppRouter(await CycleDetailPage({ params: Promise.resolve({ cycleId: w.cycleId }), searchParams: Promise.resolve({}) })),
  );
  signIn(null);
  // React separates adjacent text with <!-- --> in static markup.
  return decodeEntities(html.replace(/<!-- -->/g, ""));
}

/** Every /videos/<id> the pairing page links, rendered as the world's teacher (the mentee). */
async function pairingVideoLinks(w: World, pairingId: string) {
  await w.c.query(
    `INSERT INTO section_gate_grants (user_id, gate_slug, granted_at, expires_at)
     VALUES ($1, 'mentorship', now(), now() + interval '1 hour')`,
    [w.teacher.userId],
  );
  signIn({ id: w.teacher.userId, role: "teacher" });
  const { default: PairingDetailPage } = await import("../../apps/web/src/app/(authenticated)/mentorship/[pairingId]/page.tsx");
  const html = await render(await PairingDetailPage({ params: Promise.resolve({ pairingId }), searchParams: Promise.resolve({}) }));
  signIn(null);
  return elements(decodeEntities(html), "a")
    .map((a) => attr(a.open, "href") ?? "")
    .filter((h) => h.startsWith("/videos/"));
}

test("F03: a WhatsApp lesson video captioned with its cycle code reaches the cycle's Evidence once its bytes are stored", { skip }, async () => {
  await withEnv(CONFIGURED, () =>
    withWorld(async (w) => {
      const { id, job } = await acceptAndClaim(w, { caption: `${w.cycleCode} fractions lesson` });
      const sub = await w.submission(id);
      assert.equal(sub!.context_id, w.cycleId);
      assert.deepEqual(await evidenceFor(w, String(sub!.id)), [], "nothing is linked before the bytes exist");

      await fetchJob(job);
      assert.deepEqual(
        await evidenceFor(w, String(sub!.id)),
        [{ cycle_id: w.cycleId, caption: `${w.cycleCode} fractions lesson` }],
        "the cycle's Evidence card reads observation_evidence; the WhatsApp video must be there",
      );

      const page = await cyclePageText(w);
      assert.match(page, /Evidence · 1/);
      assert.ok(page.includes(`href="/videos/${sub!.id}"`), "the card links the video");
      assert.doesNotMatch(page, /No video evidence linked yet/);

      // The job run again (a lease that expired mid-fetch, say) links nothing twice.
      await fetchJob(job);
      assert.equal((await evidenceFor(w, String(sub!.id))).length, 1);
    }),
  );
});

test("F03/F50: every MM- recording of a meeting is on the meeting -- the first and a later part alike", { skip }, async () => {
  await withEnv(CONFIGURED, () =>
    withWorld((w) =>
      withMeeting(w, async ({ meetingId, pairingId }) => {
        const recording = async () => (await w.c.query(`SELECT recording_video_id FROM mentor_meetings WHERE id = $1`, [meetingId])).rows[0].recording_video_id;
        const first = await acceptAndClaim(w, { caption: `MM-${meetingId} part 1` });
        assert.equal(await recording(), null, "not before the bytes are stored");
        await fetchJob(first.job);
        const firstSub = await w.submission(first.id);
        assert.equal(await recording(), firstSub!.id, "the first stored recording is the meeting's recording");

        // Part 2 of a long meeting, as WhatsApp's 16 MB video cap forces.
        const second = await acceptAndClaim(w, { caption: `MM-${meetingId} part 2` });
        await fetchJob(second.job);
        const secondSub = await w.submission(second.id);
        assert.deepEqual([secondSub!.context_type, secondSub!.context_id], ["mentor_meeting", meetingId]);
        assert.equal(await recording(), firstSub!.id, "an attached recording is never silently swapped for another");

        // The sender was told "It will be on the meeting": both parts are.
        const links = await pairingVideoLinks(w, pairingId);
        assert.ok(links.includes(`/videos/${firstSub!.id}`), `part 1 is on the meeting: ${JSON.stringify(links)}`);
        assert.ok(links.includes(`/videos/${secondSub!.id}`), `part 2 is on the meeting too: ${JSON.stringify(links)}`);
      }),
    ),
  );
});

test("F03: a direct meeting recording is linked the same way, when its upload is confirmed -- and a second one is listed with it", { skip }, async () => {
  await withWorld((w) =>
    withMeeting(w, async ({ meetingId, pairingId }) => {
      try {
        const id = await directUpload(w, "mentor_meeting", meetingId);
        const [m] = (await w.c.query(`SELECT recording_video_id FROM mentor_meetings WHERE id = $1`, [meetingId])).rows;
        assert.equal(m.recording_video_id, id);
        const [v] = (await w.c.query(`SELECT caption_raw FROM video_submissions WHERE id = $1`, [id])).rows;
        assert.equal(v.caption_raw, "lesson note", "the uploader's note is kept on the submission, whatever it is for");

        // A replacement for a wrong file or a failed transcode, uploaded from
        // the meeting's "Attach another recording".
        const again = await directUpload(w, "mentor_meeting", meetingId);
        const links = await pairingVideoLinks(w, pairingId);
        assert.ok(links.includes(`/videos/${id}`), JSON.stringify(links));
        assert.ok(links.includes(`/videos/${again}`), `the second recording is on the meeting: ${JSON.stringify(links)}`);
      } finally {
        await removeDirectUploads(w);
      }
    }),
  );
});

test("F03: a signed-off cycle's closed record gains no evidence, by either path -- and the video is its uploader's to re-file", { skip }, async () => {
  await withEnv(CONFIGURED, () =>
    withWorld(async (w) => {
      try {
        // WhatsApp: the cycle was signed off before the video arrived. Kept,
        // as generic, and the refusal is audited -- as for any target the
        // sender may not write to.
        await w.c.query(`UPDATE observation_cycles SET status = 'complete' WHERE id = $1`, [w.cycleId]);
        const { POST } = await route();
        const late = w.wamid();
        assert.equal((await POST(signed(envelope([videoMessage({ id: late, from: w.teacher.phone, caption: w.cycleCode })])))).status, 200);
        const lateSub = await w.submission(late);
        assert.equal(lateSub!.context_type, "generic");
        const [audit] = await waitFor(() => w.audits("whatsapp.context.forbidden", late), (r) => r.length >= 1);
        assert.equal((audit?.metadata as { reason?: string } | undefined)?.reason, "observation_cycle.signed_off");

        // Accepted while open, signed off before its bytes were fetched.
        await w.c.query(`UPDATE observation_cycles SET status = 'observed' WHERE id = $1`, [w.cycleId]);
        const { id, job } = await acceptAndClaim(w);
        await w.c.query(`UPDATE observation_cycles SET status = 'complete' WHERE id = $1`, [w.cycleId]);
        await fetchJob(job);
        const sub = await w.submission(id);
        assert.equal(sub!.status, "queued", "the video itself is kept and transcoded");
        assert.deepEqual(await evidenceFor(w, String(sub!.id)), []);
        assert.deepEqual(
          [sub!.context_type, sub!.context_id],
          ["generic", null],
          "not left claiming a cycle it is not on: /uploads shows it as not linked, and it can be attached elsewhere",
        );
        assert.deepEqual(await unlinkedAudits(w, String(sub!.id)), [
          { contextType: "observation_cycle", contextId: w.cycleId, reason: "observation_cycle.signed_off" },
        ]);

        // Direct: reserved while open, confirmed after sign-off.
        await w.c.query(`UPDATE observation_cycles SET status = 'observed' WHERE id = $1`, [w.cycleId]);
        const { beginUpload, completeUpload } = await webUpload();
        const r = await beginUpload({ userId: w.teacher.userId, filename: "late.mp4", sizeBytes: 4096, contentType: "video/mp4", contextType: "observation_cycle", contextId: w.cycleId });
        assert.ok(!("error" in r));
        await w.c.query(`UPDATE observation_cycles SET status = 'complete' WHERE id = $1`, [w.cycleId]);
        const reservation = r as Exclude<typeof r, { error: string }>;
        const done = await completeUpload({ submissionId: reservation.submissionId, userId: w.teacher.userId, isAdmin: false, stat: async () => ({ size: 4096 }) });
        assert.equal(done.ok, true);
        assert.deepEqual(await evidenceFor(w, reservation.submissionId), []);
        const [direct] = (
          await w.c.query(`SELECT context_type, context_id FROM video_submissions WHERE id = $1`, [reservation.submissionId])
        ).rows;
        assert.deepEqual(direct, { context_type: "generic", context_id: null });
        assert.equal((await unlinkedAudits(w, reservation.submissionId)).length, 1);
      } finally {
        await removeDirectUploads(w);
      }
    }),
  );
});
