// A video can be attached to a classroom session, and the right people can see it.
//
// ── THE DEFECT ─────────────────────────────────────────────────────────────
//
// The backend accepted a "classroom_session" upload, but no screen offered it,
// and anything uploaded that way was visible to its uploader and programme
// administrators only: the session's own teacher could not open it, and no
// session or class page listed it. The guard also took ANY session id from
// ANY signed-in user, because "a classroom session is programme-wide reference
// data". (Found in the 5 Oct 2026 QA: "upload a video for a class" had no path.)
//
// ── THE RULE ───────────────────────────────────────────────────────────────
//
// A session's videos belong to the session's own teacher and to programme
// administrators, which is the same line the Repository already draws for a
// teacher's sessions (lib/teaching/visibility.ts): a colleague's session is a
// 404, and so is its video. Mentors and observers keep the programme-wide
// session list but not children's classroom videos.
//
//   upload   beginUploadAction's guard (uploads/context.ts)
//   open     assertCanAccessVideo
//   list     videoVisibilityFilter (the /videos library) and videosOfSessions
//            (the session and class pages)
//
// Executed against Postgres through the real server action and guards.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { signIn, outcome, closeAppDb, type TestUser } from "./_server-actions.js";
import { needsDatabase } from "./_harness.js";
import { observationWorld, type ObservationWorld, type WorldUser } from "./_observation-world.js";

const skip = needsDatabase();
after(async () => {
  if (!skip) await closeAppDb();
});

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://storage.test";
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??= "publishable-test-key";

const action = () => import("../../apps/web/src/app/(authenticated)/uploads/actions.ts");
const authz = () => import("../../apps/web/src/lib/authz.ts");
const sessionVideos = () => import("../../apps/web/src/lib/video/session-videos.ts");

const asUser = (u: WorldUser): TestUser => ({ id: u.id, role: u.role, name: u.name, email: u.email });

type World = ObservationWorld & {
  mine: string; // a session of the world's teacher
  theirs: string; // a session of another teacher in the same school
  classId: string;
  otherTeacher: WorldUser;
  video: (by: WorldUser, sessionId: string) => Promise<string>;
};

async function withWorld(body: (w: World) => Promise<void>) {
  const w = await observationWorld("clsvid");
  const one = async (q: string, p: unknown[]): Promise<string> => (await w.c.query(q, p)).rows[0].id as string;
  const fileIds: string[] = [];
  try {
    const subject = await one(`INSERT INTO subjects (name, code) VALUES ($1, $2) RETURNING id`, [`Subj ${w.T}`, `S${w.T.slice(-8).toUpperCase()}`]);
    const classId = await one(`INSERT INTO classes (school_id, grade, stage) VALUES ($1, 5, 'primary') RETURNING id`, [w.schoolId]);
    const otherUser = await one(
      `INSERT INTO users (id, email, name, role) VALUES (gen_random_uuid(), $1, $2, 'teacher'::role) RETURNING id`,
      [`other.${w.T}@example.test`, `Other ${w.T}`],
    );
    const otherTeacherId = await one(
      `INSERT INTO teachers (school_id, full_name, user_id) VALUES ($1, $2, $3) RETURNING id`,
      [w.schoolId, `Other teacher ${w.T}`, otherUser],
    );
    const session = (teacherId: string, topic: string) =>
      one(
        `INSERT INTO sessions (school_id, class_id, subject_id, teacher_id, scheduled_date, topic) VALUES ($1, $2, $3, $4, '2026-10-05', $5) RETURNING id`,
        [w.schoolId, classId, subject, teacherId, topic],
      );
    const mine = await session(w.teacherId, `Mine ${w.T}`);
    const theirs = await session(otherTeacherId, `Theirs ${w.T}`);
    const video: World["video"] = async (by, sessionId) => {
      const fileId = (
        await w.c.query(
          `INSERT INTO files (bucket, object_key, mime_type, kind, status, owner_user_id, original_filename)
           VALUES ('videos-original', $1, 'video/mp4', 'video_original', 'stored', $2, 'lesson.mp4') RETURNING id`,
          [`test/${w.T}/${fileIds.length}.mp4`, by.id],
        )
      ).rows[0].id as string;
      fileIds.push(fileId);
      return (
        await w.c.query(
          `INSERT INTO video_submissions (file_id, source, status, context_type, context_id, submitted_by_user_id)
           VALUES ($1, 'direct', 'queued', 'classroom_session', $2, $3) RETURNING id`,
          [fileId, sessionId, by.id],
        )
      ).rows[0].id as string;
    };
    await body({
      ...w,
      mine,
      theirs,
      classId,
      otherTeacher: { id: otherUser, role: "teacher", name: `Other ${w.T}`, email: `other.${w.T}@example.test` },
      video,
    });
  } finally {
    const q = (sql: string, p: unknown[] = []) => w.c.query(sql, p).catch(() => undefined);
    await q(`DELETE FROM video_submissions WHERE context_type = 'classroom_session' AND context_id IN (SELECT id FROM sessions WHERE school_id = $1)`, [w.schoolId]);
    await q(`DELETE FROM video_submissions WHERE file_id = ANY($1::uuid[])`, [fileIds]);
    await q(`DELETE FROM files WHERE owner_user_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`%${w.T}@example.test`]);
    await q(`DELETE FROM sessions WHERE school_id = $1`, [w.schoolId]);
    await q(`DELETE FROM classes WHERE school_id = $1`, [w.schoolId]);
    await q(`DELETE FROM teachers WHERE school_id = $1 AND full_name LIKE 'Other teacher%'`, [w.schoolId]);
    await q(`DELETE FROM users WHERE email = $1`, [`other.${w.T}@example.test`]);
    await q(`DELETE FROM subjects WHERE name = $1`, [`Subj ${w.T}`]);
    await w.cleanup();
  }
}

let seq = 0;
async function begin(who: WorldUser, input: { contextType: string; contextId?: string | null }) {
  signIn(asUser(who));
  const { beginUploadAction } = await action();
  seq += 1;
  return outcome(() =>
    beginUploadAction({ filename: `class-${seq}.mp4`, sizeBytes: 2000 + seq, contentType: "video/mp4", ...input } as never),
  );
}

function reserved(r: Awaited<ReturnType<typeof begin>>): void {
  assert.equal(r.kind, "returned", `expected a reservation, got ${JSON.stringify(r)}`);
  const v = (r as { value: { ok: boolean; error?: string } }).value;
  assert.equal(v.ok, true, `refused: ${v.error}`);
}

test("a teacher can upload for her own session; a colleague's session, a mentor and an observer cannot; an admin can", { skip }, async () => {
  await withWorld(async (w) => {
    reserved(await begin(w.teacher, { contextType: "classroom_session", contextId: w.mine }));
    reserved(await begin(w.admin, { contextType: "classroom_session", contextId: w.mine }));
    reserved(await begin(w.admin, { contextType: "classroom_session", contextId: w.theirs }));

    assert.deepEqual(await begin(w.teacher, { contextType: "classroom_session", contextId: w.theirs }), { kind: "notFound" }, "another teacher's session is a 404");
    assert.deepEqual(await begin(w.mentor, { contextType: "classroom_session", contextId: w.mine }), { kind: "notFound" });
    assert.deepEqual(await begin(w.observer, { contextType: "classroom_session", contextId: w.mine }), { kind: "notFound" });
    assert.deepEqual(
      await begin(w.teacher, { contextType: "classroom_session", contextId: "00000000-0000-4000-8000-000000000000" }),
      { kind: "notFound" },
      "a session that does not exist",
    );
    // As before: a classroom upload with no session at all stays private to its uploader.
    reserved(await begin(w.teacher, { contextType: "classroom_session" }));
  });
});

test("the session's teacher and administrators can open a classroom video; nobody else can", { skip }, async () => {
  const { assertCanAccessVideo } = await authz();
  await withWorld(async (w) => {
    const uploadedByAdmin = await w.video(w.admin, w.mine);
    const reads = (who: WorldUser, id: string) => outcome(() => assertCanAccessVideo({ id: who.id, role: who.role }, id));

    assert.equal((await reads(w.teacher, uploadedByAdmin)).kind, "returned", "the teacher whose session it is opens a video an admin uploaded for it");
    assert.equal((await reads(w.admin, uploadedByAdmin)).kind, "returned");
    assert.deepEqual(await reads(w.otherTeacher, uploadedByAdmin), { kind: "notFound" }, "a colleague does not");
    assert.deepEqual(await reads(w.mentor, uploadedByAdmin), { kind: "notFound" });
    assert.deepEqual(await reads(w.observer, uploadedByAdmin), { kind: "notFound" });

    const theirs = await w.video(w.admin, w.theirs);
    assert.deepEqual(await reads(w.teacher, theirs), { kind: "notFound" }, "and the teacher does not open a colleague's session's video");
  });
});

test("the session pages list a session's videos, and the library shows a teacher only her sessions' videos", { skip }, async () => {
  const { videoVisibilityFilter } = await authz();
  const { videosOfSessions, videosOfClass } = await sessionVideos();
  const { db } = await import("@gml/db");
  const { videoSubmissions } = await import("@gml/db/schema");
  const { and, inArray } = await import("drizzle-orm");
  await withWorld(async (w) => {
    const mineVideo = await w.video(w.admin, w.mine);
    const theirVideo = await w.video(w.admin, w.theirs);

    // The pages: what the caller names (the page has already authorised it).
    assert.deepEqual((await videosOfSessions([w.mine])).map((v) => v.id), [mineVideo]);
    assert.deepEqual((await videosOfSessions([w.mine, w.theirs])).map((v) => v.id).sort(), [mineVideo, theirVideo].sort());
    assert.deepEqual(await videosOfSessions([]), []);
    // A class page: every session of the class, or only the viewer's own.
    assert.deepEqual((await videosOfClass(w.classId, undefined)).map((v) => v.id).sort(), [mineVideo, theirVideo].sort());
    const { sessions } = await import("@gml/db/schema");
    const { eq } = await import("drizzle-orm");
    assert.deepEqual((await videosOfClass(w.classId, eq(sessions.teacherId, w.teacherId))).map((v) => v.id), [mineVideo]);
    const [row] = await videosOfSessions([w.mine]);
    assert.equal(row!.sessionId, w.mine);
    assert.equal(row!.uploadedBy, w.admin.name);

    // The library: SQL, ANDed in by /videos.
    const library = async (who: WorldUser) => {
      const where = await videoVisibilityFilter({ id: who.id, role: who.role });
      const rows = await db
        .select({ id: videoSubmissions.id })
        .from(videoSubmissions)
        .where(and(where, inArray(videoSubmissions.id, [mineVideo, theirVideo])));
      return rows.map((r) => r.id);
    };
    assert.deepEqual(await library(w.teacher), [mineVideo], "a teacher's library has her session's video and not a colleague's");
    assert.deepEqual(await library(w.otherTeacher), [theirVideo]);
    assert.deepEqual((await library(w.admin)).sort(), [mineVideo, theirVideo].sort());
    assert.deepEqual(await library(w.mentor), [], "a mentor's library has no classroom videos");
    assert.deepEqual(await library(w.observer), []);
  });
});
