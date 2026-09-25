// The pairing page carries the mentorship videos -- executed through the real
// page, rendered as the mentor and as the mentee, against Postgres.
//
// ── THE DEFECT (F50) ─────────────────────────────────────────────────────────
//
// CLAUDE.md defines the Mentorship surface as ~150 meeting recordings plus the
// mentees' Q1/Q4 videos. The pairing page had no upload control and listed no
// video: a meeting row showed "Open recording" only through
// mentor_meetings.recording_video_id, which nothing wrote, and there was no
// quarterly video anywhere. A mentee could not send her Q1 video to her mentor
// by any path, and a mentor could neither attach nor find a meeting recording
// from the pairing.
//
// Now each past meeting offers its mentor "Attach recording" (to /uploads,
// bound to that meeting), a "Quarterly videos" card offers the Q1 video -- and
// the Q4 video once the pairing reaches Q4 -- and lists the ones whose bytes
// have arrived, for both sides of the pairing.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { buildWorld, closeAppPool, describe, outcome, signIn, type Person, type World } from "./_mentorship.js";
import { render, decodeEntities, elements, attr } from "./_ui.js";
import { needsDatabase } from "./_harness.js";

const skip = needsDatabase();
after(closeAppPool);

async function withWorld(body: (w: World & { video: Video }) => Promise<void>) {
  const w = await buildWorld("pvid");
  const fileIds: string[] = [];
  const video: Video = async (o) => {
    const fileId = (
      await w.q<{ id: string }>(
        `INSERT INTO files (bucket, object_key, mime_type, kind, status) VALUES ('videos-original', $1, 'video/mp4', 'video_original', $2) RETURNING id`,
        [`test/${w.T}/${fileIds.length}.mp4`, o.fileStatus ?? "stored"],
      )
    )[0]!.id;
    fileIds.push(fileId);
    return (
      await w.q<{ id: string }>(
        `INSERT INTO video_submissions (file_id, source, status, context_type, context_id, context_quarter, submitted_by_user_id)
         VALUES ($1, 'direct', $2::video_status, $3, $4, $5, $6) RETURNING id`,
        [fileId, o.status ?? "queued", o.contextType, o.contextId, o.quarter ?? null, o.by],
      )
    )[0]!.id;
  };
  try {
    for (const p of [w.mentor, w.teacherA]) await w.grant(p.id);
    await body({ ...w, video });
  } finally {
    signIn(null);
    await w.q(`UPDATE mentor_meetings SET recording_video_id = NULL WHERE pairing_id = $1`, [w.pairingA]);
    await w.q(`DELETE FROM video_submissions WHERE file_id = ANY($1::uuid[])`, [fileIds]);
    await w.q(`DELETE FROM files WHERE id = ANY($1::uuid[])`, [fileIds]);
    await w.cleanup();
  }
}

type Video = (o: {
  contextType: string;
  contextId: string;
  by: string;
  quarter?: number | null;
  status?: string;
  fileStatus?: string;
}) => Promise<string>;

async function pairingHtml(who: Person, pairingId: string) {
  signIn(who);
  const { default: PairingDetailPage } = await import("../../apps/web/src/app/(authenticated)/mentorship/[pairingId]/page.tsx");
  const r = await outcome(() => PairingDetailPage({ params: Promise.resolve({ pairingId }), searchParams: Promise.resolve({}) }));
  assert.equal(r.kind, "value", describe(r));
  return decodeEntities((await render((r as { value: unknown }).value)).replace(/<!-- -->/g, ""));
}

const hrefs = (html: string) => elements(html, "a").map((a) => ({ href: attr(a.open, "href") ?? "", text: a.text.trim() }));

async function meeting(w: World, when: "past" | "future") {
  return (
    await w.q<{ id: string }>(
      `INSERT INTO mentor_meetings (pairing_id, scheduled_at, notes) VALUES ($1, now() + $2::interval, 'notes') RETURNING id`,
      [w.pairingA, when === "past" ? "-3 days" : "3 days"],
    )
  )[0]!.id;
}

test("F50: the mentee is offered her Q1 video, bound to the pairing and the quarter -- and Q4 once the pairing reaches it", { skip }, async () => {
  await withWorld(async (w) => {
    const q = (n: number) => `/uploads?context=mentee_quarterly&contextId=${w.pairingA}&quarter=${n}`;
    const inQ1 = hrefs(await pairingHtml(w.teacherA, w.pairingA));
    const q1 = inQ1.find((a) => a.href === q(1));
    assert.ok(q1, `an upload for the Q1 video: ${JSON.stringify(inQ1)}`);
    assert.match(q1!.text, /Q1/);
    assert.ok(!inQ1.some((a) => a.href === q(4)), "the endline video is not open in Q1");

    await w.q(`UPDATE mentor_pairings SET current_quarter = 4 WHERE id = $1`, [w.pairingA]);
    assert.ok(hrefs(await pairingHtml(w.teacherA, w.pairingA)).some((a) => a.href === q(4)));
  });
});

test("F50: the mentor can attach a recording to each past meeting; the mentee is not asked to", { skip }, async () => {
  await withWorld(async (w) => {
    const past = await meeting(w, "past");
    const upcoming = await meeting(w, "future");
    const attach = (id: string) => `/uploads?context=mentor_meeting&contextId=${id}`;
    const mentor = hrefs(await pairingHtml(w.mentor, w.pairingA));
    assert.ok(mentor.some((a) => a.href === attach(past) && /recording/i.test(a.text)), JSON.stringify(mentor));
    assert.ok(!mentor.some((a) => a.href === attach(upcoming)), "a meeting that has not happened has nothing to record");
    const mentee = hrefs(await pairingHtml(w.teacherA, w.pairingA));
    assert.ok(!mentee.some((a) => a.href.startsWith("/uploads?context=mentor_meeting")));
  });
});

test("F50: quarterly videos and meeting recordings whose bytes have arrived are on the page for both sides", { skip }, async () => {
  await withWorld(async (w) => {
    const q1 = await w.video({ contextType: "mentee_quarterly", contextId: w.pairingA, quarter: 1, by: w.teacherA.id });
    const stillUploading = await w.video({
      contextType: "mentee_quarterly",
      contextId: w.pairingA,
      quarter: 1,
      by: w.teacherA.id,
      status: "received",
      fileStatus: "uploading",
    });
    const otherPairing = await w.video({ contextType: "mentee_quarterly", contextId: w.pairingB, quarter: 1, by: w.teacherB.id });
    const past = await meeting(w, "past");
    const recording = await w.video({ contextType: "mentor_meeting", contextId: past, by: w.mentor.id });
    await w.q(`UPDATE mentor_meetings SET recording_video_id = $2 WHERE id = $1`, [past, recording]);

    for (const who of [w.mentor, w.teacherA]) {
      const links = hrefs(await pairingHtml(who, w.pairingA)).map((a) => a.href);
      assert.ok(links.includes(`/videos/${q1}`), `${who.role} sees the Q1 video`);
      assert.ok(!links.includes(`/videos/${stillUploading}`), `${who.role}: a reservation whose bytes never came is not a video`);
      assert.ok(!links.includes(`/videos/${otherPairing}`), `${who.role}: another pairing's video is not this pairing's`);
      assert.ok(links.includes(`/videos/${recording}`), `${who.role} opens the meeting's recording`);
    }
  });
});

// A long meeting sent over WhatsApp arrives in parts, and a first recording
// can be the wrong file or fail to transcode. Each later recording used to be
// accepted and then shown nowhere: the page read only recording_video_id, which
// holds the first, and hid "Attach recording" once it was set.
test("F50: every recording of a meeting is listed, and its mentor can add another once one is attached", { skip }, async () => {
  await withWorld(async (w) => {
    const past = await meeting(w, "past");
    const first = await w.video({ contextType: "mentor_meeting", contextId: past, by: w.mentor.id, status: "failed" });
    await w.q(`UPDATE mentor_meetings SET recording_video_id = $2 WHERE id = $1`, [past, first]);
    const second = await w.video({ contextType: "mentor_meeting", contextId: past, by: w.mentor.id, status: "queued" });
    const arriving = await w.video({
      contextType: "mentor_meeting",
      contextId: past,
      by: w.mentor.id,
      status: "received",
      fileStatus: "uploading",
    });

    for (const who of [w.mentor, w.teacherA]) {
      const links = hrefs(await pairingHtml(who, w.pairingA)).map((a) => a.href);
      assert.ok(links.includes(`/videos/${first}`), `${who.role}: the first recording`);
      assert.ok(links.includes(`/videos/${second}`), `${who.role}: and the one sent after it: ${JSON.stringify(links)}`);
      assert.ok(!links.includes(`/videos/${arriving}`), `${who.role}: not one whose bytes have not arrived`);
    }
    const mentor = hrefs(await pairingHtml(w.mentor, w.pairingA));
    assert.ok(
      mentor.some((a) => a.href === `/uploads?context=mentor_meeting&contextId=${past}` && /another/i.test(a.text)),
      `a replacement or a next part can still be attached: ${JSON.stringify(mentor)}`,
    );
    assert.ok(!mentor.some((a) => a.href.includes(`confirmCancel=${past}`)), "a meeting with a recording is kept, as before");
  });
});

// The cycle page's own upload stays; it also links the upload page bound to
// the cycle, which is where the phone flow and the exact WhatsApp caption are.
test("F18: the cycle page links the upload page for that cycle, and not once it is signed off", { skip }, async () => {
  const { observationWorld } = await import("./_observation-world.js");
  const { withAppRouter } = await import("./_ui.js");
  const w = await observationWorld("pvidc");
  try {
    const open = await w.cycle({ status: "pre_submitted" });
    const closed = await w.cycle({ status: "complete" });
    const cycleHtml = async (cycleId: string) => {
      signIn({ id: w.teacher.id, role: w.teacher.role, name: w.teacher.name });
      const { default: CycleDetailPage } = await import("../../apps/web/src/app/(authenticated)/observation/[cycleId]/page.tsx");
      return render(withAppRouter(await CycleDetailPage({ params: Promise.resolve({ cycleId }), searchParams: Promise.resolve({}) })));
    };
    const target = (id: string) => `/uploads?context=observation_cycle&contextId=${id}`;
    assert.ok(hrefs(decodeEntities(await cycleHtml(open.id))).some((a) => a.href === target(open.id)));
    assert.ok(!hrefs(decodeEntities(await cycleHtml(closed.id))).some((a) => a.href.startsWith("/uploads?")));
  } finally {
    signIn(null);
    await w.cleanup();
  }
});
