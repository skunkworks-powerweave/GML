// A direct upload's life after the bytes start moving, executed against
// Postgres: the reservation, the completion call, and the reconciler that
// backstops a completion call that never arrived.
//
// ── THE DEFECTS THESE CATCH ──────────────────────────────────────────────────
//
// Found by uploading real files through the production build, 2026-09-24:
//
//   1. Every reservation issued a NEW object key, but tus resumes a previous
//      upload of the same file from the browser's own storage -- and that
//      upload is bound to the OLD key. Picking the same file again (which the
//      tray tells a teacher to do after a dropped connection) sent the bytes
//      to an abandoned reservation, and the new one reported "We could not find
//      the uploaded file" forever.
//   2. The reconciler failed every reservation older than 30 minutes whose
//      object was not in Storage. A resumable object appears only when its LAST
//      byte lands, so any upload longer than 30 minutes -- every large video on
//      a 2G link -- was failed while still transferring.
//   3. completeUpload then returned ok:true for any status other than
//      'received', so the teacher was told the upload succeeded while the
//      submission sat at 'failed' and was never transcoded.
//   4. When the reconciler finished an upload whose completion call was lost,
//      it skipped the observation_evidence row, so the video never appeared on
//      its cycle's page.
//
// ── HOW ──────────────────────────────────────────────────────────────────────
//
// The functions under test use the application's own pool, so a wrapping
// transaction cannot contain them. Each test builds its rows under a unique
// tag, commits them, and deletes them afterwards. Storage is the one thing
// replaced: `stat` is handed a function that answers from a map, which is the
// only question these code paths ask Storage.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
import "./_ui.js"; // the @/ alias and the server-only stub, for apps/web modules
import { needsDatabase, DATABASE_URL, tag } from "./_harness.js";

const skip = needsDatabase();
const webUpload = () => import("../../apps/web/src/lib/video/upload.ts");
const reconciler = () => import("../../apps/worker/src/reconcile-uploads.ts");
const uploads = () => import("../../packages/db/src/uploads.ts");

type Stat = (bucket: string, key: string) => Promise<{ size: number } | null>;

/** Storage as far as these paths can see it: which keys exist, at what size. */
function fakeStorage(): { objects: Map<string, number>; stat: Stat } {
  const objects = new Map<string, number>();
  return { objects, stat: async (_bucket, key) => (objects.has(key) ? { size: objects.get(key)! } : null) };
}

type World = {
  c: Client;
  T: string;
  userId: string;
  cycleId: string;
  row: (submissionId: string) => Promise<{ status: string; fileStatus: string; objectKey: string; processingLog: string | null }>;
  evidence: (submissionId: string) => Promise<Array<{ caption: string | null }>>;
  liveJobs: (submissionId: string) => Promise<number>;
  age: (submissionId: string, interval: string) => Promise<void>;
};

async function withWorld(body: (w: World) => Promise<void>): Promise<void> {
  const c = new Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 5000 });
  await c.connect();
  const T = tag("upl");
  const one = async (q: string, params: unknown[]): Promise<string> => (await c.query(q, params)).rows[0].id as string;
  const district = await one(`INSERT INTO districts (name, code) VALUES ($1, $2) RETURNING id`, [`D ${T}`, T.slice(-12)]);
  const zone = await one(`INSERT INTO zones (district_id, name) VALUES ($1, $2) RETURNING id`, [district, `Z ${T}`]);
  const school = await one(`INSERT INTO schools (zone_id, name, code) VALUES ($1, $2, $3) RETURNING id`, [zone, `S ${T}`, T.slice(-12)]);
  const userId = await one(`INSERT INTO users (id, email, name, role) VALUES (gen_random_uuid(), $1, $2, 'teacher') RETURNING id`, [`${T}@example.test`, `Teacher ${T}`]);
  const teacherId = await one(`INSERT INTO teachers (user_id, school_id, full_name) VALUES ($1, $2, $3) RETURNING id`, [userId, school, `Teacher ${T}`]);
  const cycleId = await one(
    `INSERT INTO observation_cycles (code, teacher_id, kind, topic, scheduled_at) VALUES ($1, $2, 'evaluative', 'Fractions', now()) RETURNING id`,
    [`${T}-C1`, teacherId],
  );
  const w: World = {
    c,
    T,
    userId,
    cycleId,
    row: async (id) =>
      (
        await c.query(
          `SELECT v.status, f.status AS "fileStatus", f.object_key AS "objectKey", v.processing_log AS "processingLog"
             FROM video_submissions v JOIN files f ON f.id = v.file_id WHERE v.id = $1`,
          [id],
        )
      ).rows[0],
    evidence: async (id) => (await c.query(`SELECT caption FROM observation_evidence WHERE video_submission_id = $1`, [id])).rows,
    liveJobs: async (id) =>
      Number(
        (
          await c.query(`SELECT count(*) AS n FROM jobs WHERE dedupe_key = $1 AND status IN ('queued','running')`, [
            `submission:${id}`,
          ])
        ).rows[0].n,
      ),
    age: async (id, interval) => {
      await c.query(`UPDATE video_submissions SET created_at = now() - $2::interval WHERE id = $1`, [id, interval]);
    },
  };
  try {
    await body(w);
  } finally {
    const subs = (await c.query(`SELECT id, file_id FROM video_submissions WHERE submitted_by_user_id = $1`, [userId])).rows;
    for (const s of subs) await c.query(`DELETE FROM jobs WHERE dedupe_key = $1`, [`submission:${s.id}`]);
    await c.query(`DELETE FROM observation_evidence WHERE cycle_id = $1`, [cycleId]);
    await c.query(`DELETE FROM video_submissions WHERE submitted_by_user_id = $1`, [userId]);
    await c.query(`DELETE FROM files WHERE owner_user_id = $1`, [userId]);
    await c.query(`DELETE FROM observation_cycles WHERE id = $1`, [cycleId]);
    await c.query(`DELETE FROM teachers WHERE id = $1`, [teacherId]);
    await c.query(`DELETE FROM users WHERE id = $1`, [userId]);
    await c.query(`DELETE FROM schools WHERE id = $1`, [school]);
    await c.query(`DELETE FROM zones WHERE id = $1`, [zone]);
    await c.query(`DELETE FROM districts WHERE id = $1`, [district]);
    await c.end();
  }
}

const FILE = { filename: "lesson.mp4", sizeBytes: 300 * 1024 * 1024, contentType: "video/mp4" };

async function reserve(w: World, over: Partial<typeof FILE> & { contextType?: string; contextId?: string | null } = {}) {
  const { beginUpload } = await webUpload();
  const r = await beginUpload({
    userId: w.userId,
    ...FILE,
    contextType: "observation_cycle",
    contextId: w.cycleId,
    ...over,
  } as Parameters<typeof beginUpload>[0]);
  assert.ok(!("error" in r), `reservation refused: ${JSON.stringify(r)}`);
  return r as Exclude<typeof r, { error: string }>;
}

// ── The reservation ──────────────────────────────────────────────────────────

test("picking the same file again for the same cycle continues the same reservation", { skip }, async () => {
  await withWorld(async (w) => {
    const first = await reserve(w);
    const again = await reserve(w);
    assert.equal(again.submissionId, first.submissionId, "a second reservation strands the bytes tus resumes into the first key");
    assert.equal(again.objectKey, first.objectKey, "tus resumes by key: the key must be the same one the partial upload is bound to");
    const n = (await w.c.query(`SELECT count(*) AS n FROM video_submissions WHERE submitted_by_user_id = $1`, [w.userId])).rows[0].n;
    assert.equal(Number(n), 1, "no orphan reservation may be left for the reconciler to fail");
  });
});

test("a finished upload, a different file or a different context gets a reservation of its own", { skip }, async () => {
  await withWorld(async (w) => {
    const first = await reserve(w);
    const otherSize = await reserve(w, { sizeBytes: FILE.sizeBytes + 1 });
    const otherContext = await reserve(w, { contextType: "generic", contextId: null });
    assert.notEqual(otherSize.submissionId, first.submissionId);
    assert.notEqual(otherContext.submissionId, first.submissionId);
    await w.c.query(`UPDATE video_submissions SET status = 'queued' WHERE id = $1`, [first.submissionId]);
    const afterDone = await reserve(w);
    assert.notEqual(afterDone.submissionId, first.submissionId, "uploading the same file again later is a new submission");
  });
});

test("a reservation older than the abandonment window is not handed out again", { skip }, async () => {
  await withWorld(async (w) => {
    const { UPLOAD_ABANDON_AFTER_HOURS } = await uploads();
    const first = await reserve(w);
    await w.age(first.submissionId, `${UPLOAD_ABANDON_AFTER_HOURS + 1} hours`);
    const later = await reserve(w);
    assert.notEqual(later.submissionId, first.submissionId, "the reconciler is about to fail that one");
  });
});

// ── The browser's completion call ────────────────────────────────────────────

test("a completed upload for a cycle queues one transcode and one evidence row, however often it is reported", { skip }, async () => {
  await withWorld(async (w) => {
    const { completeUpload } = await webUpload();
    const storage = fakeStorage();
    const r = await reserve(w);
    storage.objects.set(r.objectKey, FILE.sizeBytes);
    for (let i = 0; i < 2; i++) {
      const res = await completeUpload({ submissionId: r.submissionId, userId: w.userId, isAdmin: false, caption: "audit- lesson", stat: storage.stat });
      assert.equal(res.ok, true);
    }
    const row = await w.row(r.submissionId);
    assert.deepEqual([row.status, row.fileStatus], ["queued", "stored"]);
    assert.deepEqual(await w.evidence(r.submissionId), [{ caption: "audit- lesson" }]);
    assert.equal(await w.liveJobs(r.submissionId), 1);
  });
});

test("an upload that lands after the reconciler gave up on it is transcoded, not reported as a success that never plays", { skip }, async () => {
  await withWorld(async (w) => {
    const { completeUpload } = await webUpload();
    const storage = fakeStorage();
    const r = await reserve(w);
    await w.c.query(`UPDATE files SET status = 'failed' WHERE object_key = $1`, [r.objectKey]);
    await w.c.query(`UPDATE video_submissions SET status = 'failed', processing_log = 'upload abandoned or incomplete; reconciled' WHERE id = $1`, [r.submissionId]);
    storage.objects.set(r.objectKey, FILE.sizeBytes);
    const res = await completeUpload({ submissionId: r.submissionId, userId: w.userId, isAdmin: false, stat: storage.stat });
    assert.equal(res.ok, true);
    const row = await w.row(r.submissionId);
    assert.deepEqual([row.status, row.fileStatus], ["queued", "stored"], "the bytes are there; the submission must move on");
    assert.equal(await w.liveJobs(r.submissionId), 1, "and be queued for transcoding");
    assert.match(row.processingLog ?? "", /resumed/, "the log must say why a failed row came back");
  });
});

test("a reconciled reservation whose bytes never arrived is reported as missing, not as a success", { skip }, async () => {
  await withWorld(async (w) => {
    const { completeUpload } = await webUpload();
    const r = await reserve(w);
    await w.c.query(`UPDATE files SET status = 'failed' WHERE object_key = $1`, [r.objectKey]);
    await w.c.query(`UPDATE video_submissions SET status = 'failed' WHERE id = $1`, [r.submissionId]);
    const res = await completeUpload({ submissionId: r.submissionId, userId: w.userId, isAdmin: false, stat: fakeStorage().stat });
    assert.equal(res.ok, false, "telling the teacher it worked means they never re-send it");
    assert.equal(res.ok === false && res.error, "object_missing");
  });
});

test("a transcode failure is not revived by a late completion call", { skip }, async () => {
  await withWorld(async (w) => {
    const { completeUpload } = await webUpload();
    const storage = fakeStorage();
    const r = await reserve(w);
    storage.objects.set(r.objectKey, FILE.sizeBytes);
    await w.c.query(`UPDATE files SET status = 'stored' WHERE object_key = $1`, [r.objectKey]);
    await w.c.query(`UPDATE video_submissions SET status = 'failed' WHERE id = $1`, [r.submissionId]);
    const res = await completeUpload({ submissionId: r.submissionId, userId: w.userId, isAdmin: false, stat: storage.stat });
    assert.equal(res.ok, true);
    assert.equal((await w.row(r.submissionId)).status, "failed", "only an operator Retry re-runs a failed transcode");
    assert.equal(await w.liveJobs(r.submissionId), 0);
  });
});

test("the finalizer itself refuses a submission the transcoder failed, whoever calls it", { skip }, async () => {
  await withWorld(async (w) => {
    const { finalizeUpload } = await uploads();
    const { db } = await import("../../packages/db/src/client.ts");
    const r = await reserve(w);
    await w.c.query(`UPDATE files SET status = 'stored' WHERE object_key = $1`, [r.objectKey]);
    await w.c.query(`UPDATE video_submissions SET status = 'failed' WHERE id = $1`, [r.submissionId]);
    const fileId = (await w.c.query(`SELECT file_id FROM video_submissions WHERE id = $1`, [r.submissionId])).rows[0].file_id;
    const res = await finalizeUpload(db, {
      submissionId: r.submissionId,
      fileId,
      bucket: r.bucket,
      objectKey: r.objectKey,
      storedBytes: FILE.sizeBytes,
      contextType: "observation_cycle",
      contextId: w.cycleId,
    });
    assert.equal(res.finalized, false, "a file the reconciler never failed was not abandoned; its transcode failed");
    assert.equal((await w.row(r.submissionId)).status, "failed");
    assert.equal(await w.liveJobs(r.submissionId), 0);
    assert.equal((await w.evidence(r.submissionId)).length, 0);
  });
});

// ── The reconciler ───────────────────────────────────────────────────────────

test("an upload still transferring after 45 minutes is left alone", { skip }, async () => {
  await withWorld(async (w) => {
    const { reconcileStalledUploads } = await reconciler();
    const r = await reserve(w);
    await w.age(r.submissionId, "45 minutes");
    await reconcileStalledUploads({ stat: fakeStorage().stat });
    const row = await w.row(r.submissionId);
    assert.deepEqual([row.status, row.fileStatus], ["received", "uploading"], "a resumable object only exists once its last byte lands");
  });
});

test("an upload abandoned for longer than the window is failed", { skip }, async () => {
  await withWorld(async (w) => {
    const { reconcileStalledUploads } = await reconciler();
    const { UPLOAD_ABANDON_AFTER_HOURS } = await uploads();
    const r = await reserve(w);
    await w.age(r.submissionId, `${UPLOAD_ABANDON_AFTER_HOURS + 1} hours`);
    await reconcileStalledUploads({ stat: fakeStorage().stat });
    const row = await w.row(r.submissionId);
    assert.deepEqual([row.status, row.fileStatus], ["failed", "failed"]);
  });
});

test("a complete upload whose completion call was lost is finished and appears on its cycle", { skip }, async () => {
  await withWorld(async (w) => {
    const { reconcileStalledUploads } = await reconciler();
    const storage = fakeStorage();
    const r = await reserve(w);
    storage.objects.set(r.objectKey, FILE.sizeBytes);
    await w.age(r.submissionId, "15 minutes");
    await reconcileStalledUploads({ stat: storage.stat });
    const row = await w.row(r.submissionId);
    assert.deepEqual([row.status, row.fileStatus], ["queued", "stored"]);
    assert.equal(await w.liveJobs(r.submissionId), 1);
    assert.equal((await w.evidence(r.submissionId)).length, 1, "the cycle page is where the observer looks for the video");
  });
});

test("a complete upload gets a grace period for the browser's own call, which carries the caption", { skip }, async () => {
  await withWorld(async (w) => {
    const { reconcileStalledUploads } = await reconciler();
    const storage = fakeStorage();
    const r = await reserve(w);
    storage.objects.set(r.objectKey, FILE.sizeBytes);
    await w.age(r.submissionId, "2 minutes");
    await reconcileStalledUploads({ stat: storage.stat });
    assert.equal((await w.row(r.submissionId)).status, "received");
  });
});

// ── The decision itself ──────────────────────────────────────────────────────

test("the reconciler's decision: bytes decide completion, only the window decides abandonment", async () => {
  const { reconcileDecision, UPLOAD_ABANDON_AFTER_HOURS, UPLOAD_COMPLETE_GRACE_MINUTES } = await uploads();
  const H = 3600;
  const cases: Array<[number, number | null, number | null, string]> = [
    [45 * 60, null, 1000, "wait"],
    [(UPLOAD_ABANDON_AFTER_HOURS - 1) * H, null, 1000, "wait"],
    [UPLOAD_ABANDON_AFTER_HOURS * H + 1, null, 1000, "fail"],
    [UPLOAD_ABANDON_AFTER_HOURS * H + 1, 500, 1000, "fail"],
    [(UPLOAD_COMPLETE_GRACE_MINUTES - 1) * 60, 1000, 1000, "wait"],
    [UPLOAD_COMPLETE_GRACE_MINUTES * 60, 1000, 1000, "complete"],
    [UPLOAD_COMPLETE_GRACE_MINUTES * 60, 995, 1000, "complete"],
    [UPLOAD_COMPLETE_GRACE_MINUTES * 60, 500, 1000, "wait"],
  ];
  for (const [ageSeconds, storedBytes, expectedBytes, want] of cases) {
    assert.equal(reconcileDecision({ ageSeconds, storedBytes, expectedBytes }), want, JSON.stringify({ ageSeconds, storedBytes, expectedBytes }));
  }
});
