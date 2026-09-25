// A video already stored as 'generic' can still be attached to its cycle,
// meeting or quarterly slot by the person who sent it -- executed through the
// real /uploads page and server action, against Postgres.
//
// ── THE DEFECT (F18, the recovery half) ──────────────────────────────────────
//
// Until /uploads asked what a video was for, every upload made there was
// 'generic', and so was every WhatsApp video whose caption did not name its
// cycle. A generic video is visible to its uploader and administrators only,
// and nothing could change that afterwards: no screen re-linked a video (the
// WhatsApp ingest log said as much), so every lesson video mis-filed that way
// stayed invisible to its observer and mentor, and off the cycle's Evidence,
// for good. The only way out was to send the whole video again.
//
// Now each of the uploader's own generic videos on /uploads offers her open
// cycles, meetings and quarterly slots, and attaching runs the reservation's
// own check (assertContextAllowed) and the same link step as an upload
// (linkSubmissionToContext).

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { signIn, outcome, form, closeAppDb, type TestUser } from "./_server-actions.js";
import { render, withAppRouter, request, decodeEntities, elements, openingTags, attr } from "./_ui.js";
import { needsDatabase } from "./_harness.js";
import { observationWorld, type ObservationWorld, type WorldUser } from "./_observation-world.js";

const skip = needsDatabase();
after(async () => {
  if (!skip) await closeAppDb();
});

const asUser = (u: WorldUser): TestUser => ({ id: u.id, role: u.role, name: u.name, email: u.email });

type World = ObservationWorld & {
  cycle: { id: string; code: string };
  video: (by: WorldUser, o?: { contextType?: string; contextId?: string | null; fileStatus?: string; status?: string }) => Promise<string>;
};

async function withWorld(body: (w: World) => Promise<void>) {
  const w = await observationWorld("upatt");
  const fileIds: string[] = [];
  try {
    const cycle = await w.cycle({ status: "pre_submitted" });
    for (const u of [w.teacher, w.mentor, w.observer]) {
      await w.grant(u.id, "observation");
      await w.grant(u.id, "mentorship");
    }
    const video: World["video"] = async (by, o = {}) => {
      const fileId = (
        await w.c.query(
          `INSERT INTO files (bucket, object_key, mime_type, kind, status, owner_user_id, original_filename)
           VALUES ('videos-original', $1, 'video/mp4', 'video_original', $2, $3, 'lesson.mp4') RETURNING id`,
          [`test/${w.T}/${fileIds.length}.mp4`, o.fileStatus ?? "stored", by.id],
        )
      ).rows[0].id as string;
      fileIds.push(fileId);
      return (
        await w.c.query(
          `INSERT INTO video_submissions (file_id, source, status, context_type, context_id, submitted_by_user_id, caption_raw)
           VALUES ($1, 'direct', $5::video_status, $2, $3, $4, 'fractions lesson') RETURNING id`,
          [fileId, o.contextType ?? "generic", o.contextId ?? null, by.id, o.status ?? "queued"],
        )
      ).rows[0].id as string;
    };
    await body({ ...w, cycle, video });
  } finally {
    signIn(null);
    request.headers = {};
    await w.c.query(`DELETE FROM observation_evidence WHERE video_submission_id IN (SELECT id FROM video_submissions WHERE file_id = ANY($1::uuid[]))`, [fileIds]);
    await w.c.query(
      `DELETE FROM jobs WHERE dedupe_key IN (SELECT 'submission:' || id FROM video_submissions WHERE file_id = ANY($1::uuid[]))`,
      [fileIds],
    );
    await w.c.query(`DELETE FROM video_submissions WHERE file_id = ANY($1::uuid[])`, [fileIds]);
    await w.c.query(`DELETE FROM files WHERE id = ANY($1::uuid[])`, [fileIds]);
    await w.cleanup();
  }
}

async function uploadsHtml(who: WorldUser) {
  signIn(asUser(who));
  const { default: UploadsPage } = await import("../../apps/web/src/app/(authenticated)/uploads/page.tsx");
  const r = await outcome(async () => render(withAppRouter(await UploadsPage({ searchParams: Promise.resolve({ context: "generic" }) }))));
  assert.equal(r.kind, "returned", JSON.stringify(r));
  return decodeEntities(String((r as { value: unknown }).value));
}

async function attach(who: WorldUser, submissionId: string, target: string) {
  signIn(asUser(who));
  const { attachUploadAction } = await import("../../apps/web/src/app/(authenticated)/uploads/actions.ts");
  return outcome(() => attachUploadAction(form({ submissionId, target })));
}

async function row(w: World, id: string) {
  return (await w.c.query(`SELECT context_type, context_id, context_quarter FROM video_submissions WHERE id = $1`, [id])).rows[0];
}

test("F18: the uploader's own generic video offers her open cycle, and attaching puts it on the cycle's Evidence", { skip }, async () => {
  await withWorld(async (w) => {
    const id = await w.video(w.teacher);
    const html = await uploadsHtml(w.teacher);
    const forms = elements(html, "form").filter((f) => f.inner.includes(`value="${id}"`));
    assert.equal(forms.length, 1, "an attach control on the generic row");
    const values = openingTags(forms[0]!.inner, "option").map((o) => attr(o, "value"));
    const target = `observation_cycle|${w.cycle.id}|`;
    assert.ok(values.includes(target), `the cycle is offered: ${JSON.stringify(values)}`);

    const r = await attach(w.teacher, id, target);
    assert.equal(r.kind, "redirect", JSON.stringify(r));
    assert.deepEqual(await row(w, id), { context_type: "observation_cycle", context_id: w.cycle.id, context_quarter: null });
    const ev = (await w.c.query(`SELECT cycle_id, caption FROM observation_evidence WHERE video_submission_id = $1`, [id])).rows;
    assert.deepEqual(ev, [{ cycle_id: w.cycle.id, caption: "fractions lesson" }], "on the Evidence card, with her note");

    const { assertCanAccessVideo } = await import("../../apps/web/src/lib/authz.ts");
    const opens = await outcome(() => assertCanAccessVideo({ id: w.observer.id, role: "observer" }, id));
    assert.equal(opens.kind, "returned", "and her observer can now open it");
  });
});

test("F18: attaching is the reservation's own check: not someone else's video, not someone else's cycle, not a linked one", { skip }, async () => {
  await withWorld(async (w) => {
    const mine = await w.video(w.teacher);
    // Another teacher's cycle: the same 404 an upload to it gets.
    const foreign = await w.c.query(
      `INSERT INTO teachers (school_id, full_name) VALUES ($1, 'Someone else') RETURNING id`,
      [w.schoolId],
    );
    const foreignCycle = (
      await w.c.query(
        `INSERT INTO observation_cycles (code, teacher_id, kind, status, topic) VALUES ($1, $2, 'evaluative', 'nominated', 'x') RETURNING id`,
        [`${w.T}-FOREIGN`, foreign.rows[0].id],
      )
    ).rows[0].id as string;
    try {
      assert.deepEqual(await attach(w.teacher, mine, `observation_cycle|${foreignCycle}|`), { kind: "notFound" });
      assert.equal((await row(w, mine)).context_type, "generic");

      // Someone else's upload, even to a cycle the actor may use.
      const theirs = await w.video(w.mentor);
      const r = await attach(w.teacher, theirs, `observation_cycle|${w.cycle.id}|`);
      assert.equal(r.kind, "redirect");
      assert.equal((await row(w, theirs)).context_type, "generic");

      // A video already linked is not moved: that would take it off its evidence.
      const linked = await w.video(w.teacher, { contextType: "observation_cycle", contextId: w.cycle.id });
      await attach(w.teacher, linked, `mentee_quarterly|${w.pairingId}|1`);
      assert.deepEqual(await row(w, linked), { context_type: "observation_cycle", context_id: w.cycle.id, context_quarter: null });
    } finally {
      await w.c.query(`DELETE FROM observation_cycles WHERE id = $1`, [foreignCycle]);
      await w.c.query(`DELETE FROM teachers WHERE id = $1`, [foreign.rows[0].id]);
    }
  });
});

test("F18: a quarterly slot can be attached too, with its quarter", { skip }, async () => {
  await withWorld(async (w) => {
    const id = await w.video(w.teacher);
    const r = await attach(w.teacher, id, `mentee_quarterly|${w.pairingId}|1`);
    assert.equal(r.kind, "redirect");
    assert.deepEqual(await row(w, id), { context_type: "mentee_quarterly", context_id: w.pairingId, context_quarter: 1 });
  });
});

// Attach is offered on a row whose bytes are still arriving, and the
// completion that follows reads the context the caller saw BEFORE the attach.
// finalizeUpload links the claimed row's own context, read under its lock --
// the attach must not be lost to that stale read.
test("F18: a video attached while its file is still uploading is linked to where it was attached, when its upload completes", { skip }, async () => {
  await withWorld(async (w) => {
    const id = await w.video(w.teacher, { status: "received", fileStatus: "uploading" });
    const [{ file_id: fileId, bucket, object_key: objectKey }] = (
      await w.c.query(`SELECT v.file_id, f.bucket, f.object_key FROM video_submissions v JOIN files f ON f.id = v.file_id WHERE v.id = $1`, [id])
    ).rows;

    const r = await attach(w.teacher, id, `observation_cycle|${w.cycle.id}|`);
    assert.equal(r.kind, "redirect", JSON.stringify(r));
    assert.equal((await row(w, id)).context_type, "observation_cycle");
    const evidence = async () =>
      (await w.c.query(`SELECT cycle_id FROM observation_evidence WHERE video_submission_id = $1`, [id])).rows;
    assert.deepEqual(await evidence(), [], "nothing is on the Evidence card before the bytes exist");

    // The completion, carrying what its caller read before the attach.
    const { finalizeUpload } = await import("../../packages/db/src/uploads.ts");
    const { db } = await import("../../packages/db/src/client.ts");
    const done = await finalizeUpload(db, {
      submissionId: id,
      fileId,
      bucket,
      objectKey,
      storedBytes: 4096,
      contextType: "generic",
      contextId: null,
    });
    assert.equal(done.finalized, true);
    assert.deepEqual(await evidence(), [{ cycle_id: w.cycle.id }], "the attach is honoured when the bytes land");
  });
});

test("F18: a failed upload offers no attach, and is not moved", { skip }, async () => {
  await withWorld(async (w) => {
    const failed = await w.video(w.teacher, { status: "failed" });
    await w.video(w.teacher); // a live generic row, so the page has options to offer
    const html = await uploadsHtml(w.teacher);
    assert.equal(elements(html, "form").filter((f) => f.inner.includes(`value="${failed}"`)).length, 0, "no attach control on a failed row");
    const r = await attach(w.teacher, failed, `observation_cycle|${w.cycle.id}|`);
    assert.deepEqual(r, { kind: "redirect", location: "/uploads?attach=not_attachable" });
    assert.equal((await row(w, failed)).context_type, "generic");
    const ev = await w.c.query(`SELECT 1 FROM observation_evidence WHERE video_submission_id = $1`, [failed]);
    assert.equal(ev.rowCount, 0, "a broken video is not put on a cycle's Evidence");
  });
});

// The control offers a cycle, a meeting or a quarterly slot, and nothing else
// is attachable: a crafted teach-back target used to reach the uuid column
// unchecked (Postgres 22P02, a 500), or move a private video into every
// mentor's teach-back queue.
test("F18: only a cycle, a meeting or a quarterly slot can be attached, with a well-formed id", { skip }, async () => {
  await withWorld(async (w) => {
    const id = await w.video(w.teacher);
    for (const target of [
      "teach_back|abc|",
      `teach_back|${w.cycle.id}|`,
      "classroom_session||",
      `classroom_session|${w.cycle.id}|`,
      "observation_cycle|not-a-uuid|",
      "mentor_meeting||",
    ]) {
      const r = await attach(w.teacher, id, target);
      assert.deepEqual(r, { kind: "redirect", location: "/uploads?attach=invalid" }, target);
      assert.equal((await row(w, id)).context_type, "generic", target);
    }
  });
});

// /uploads offers attach options only once their section is unlocked; the
// action now asks for the same grant, as every action inside the section does.
test("F18: attaching into a gated section needs that section unlocked", { skip }, async () => {
  await withWorld(async (w) => {
    const id = await w.video(w.teacher);
    await w.c.query(`DELETE FROM section_gate_grants WHERE user_id = $1`, [w.teacher.id]);
    for (const target of [`observation_cycle|${w.cycle.id}|`, `mentee_quarterly|${w.pairingId}|1`]) {
      const r = await attach(w.teacher, id, target);
      assert.deepEqual(r, { kind: "redirect", location: "/uploads?attach=locked" }, target);
      assert.equal((await row(w, id)).context_type, "generic", target);
    }
  });
});
