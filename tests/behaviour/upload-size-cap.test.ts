// The admin's upload cap holds against the bytes Storage actually holds.
//
// ── THE DEFECT (F99) ─────────────────────────────────────────────────────────
//
// beginUpload compared the BROWSER-DECLARED size with the configured cap
// (system_settings.video_max_upload_mb). At completion the stored size only had
// to be no more than 1% SMALLER than declared -- there was no upper bound,
// despite the comment "reject a wildly different size" -- and the stored size
// was then written back to files.size_bytes. A modified client could declare
// 1 MB and send up to the bucket's 2 GB limit, and the transcode the cap exists
// to protect (one EC2 host's ffmpeg and disk) was queued. The reconciler, which
// finishes uploads whose completion call never arrived, had the same hole: a
// client could simply not make that call.
//
// ── HOW ──────────────────────────────────────────────────────────────────────
//
// The real completeUpload and reconcileStalledUploads against Postgres, with
// Storage replaced by a map (the only questions these paths ask it: what is at
// this key, and remove it). Rows are committed under a unique tag and removed.
// The /uploads server action runs for real too, signed in, with supabaseAdmin()
// answered by a fake Storage (the opt-in stub in _ui.ts).

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
import { stubSupabaseServer, request } from "./_ui.js";
import { signIn, closeAppDb } from "./_server-actions.js";
import { needsDatabase, DATABASE_URL, tag } from "./_harness.js";

stubSupabaseServer();
const skip = needsDatabase();
after(async () => {
  if (!skip) await closeAppDb();
});
const webUpload = () => import("../../apps/web/src/lib/video/upload.ts");
const reconciler = () => import("../../apps/worker/src/reconcile-uploads.ts");
const uploads = () => import("../../packages/db/src/uploads.ts");

const DECLARED = 1_000_000; // what the client said
const SENT = 1_500_000_000; // what it actually put in Storage

function fakeStorage() {
  const objects = new Map<string, number>();
  const removed: string[] = [];
  return {
    objects,
    removed,
    stat: async (_bucket: string, key: string) => (objects.has(key) ? { size: objects.get(key)! } : null),
    remove: async (_bucket: string, keys: string[]) => {
      for (const k of keys) {
        objects.delete(k);
        removed.push(k);
      }
    },
  };
}

async function withUploader(body: (w: { c: Client; userId: string }) => Promise<void>): Promise<void> {
  const c = new Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 5000 });
  await c.connect();
  const T = tag("cap");
  const userId = (
    await c.query(`INSERT INTO users (id, email, name, role) VALUES (gen_random_uuid(), $1, $2, 'teacher') RETURNING id`, [
      `${T}@example.test`,
      `Teacher ${T}`,
    ])
  ).rows[0].id as string;
  try {
    await body({ c, userId });
  } finally {
    const subs = (await c.query(`SELECT id FROM video_submissions WHERE submitted_by_user_id = $1`, [userId])).rows;
    for (const s of subs) await c.query(`DELETE FROM jobs WHERE dedupe_key = $1`, [`submission:${s.id}`]);
    await c.query(`DELETE FROM video_submissions WHERE submitted_by_user_id = $1`, [userId]);
    await c.query(`DELETE FROM files WHERE owner_user_id = $1`, [userId]);
    await c.query(`DELETE FROM users WHERE id = $1`, [userId]);
    await c.end();
  }
}

async function reserve(userId: string, filename = "lesson.mp4") {
  const { beginUpload } = await webUpload();
  const r = await beginUpload({ userId, filename, sizeBytes: DECLARED, contentType: "video/mp4", contextType: "generic" });
  assert.ok(!("error" in r), `reservation refused: ${JSON.stringify(r)}`);
  return r as Exclude<typeof r, { error: string }>;
}

async function state(c: Client, submissionId: string) {
  const row = (
    await c.query(
      `SELECT v.status, f.status AS "fileStatus", f.size_bytes AS "sizeBytes",
              (SELECT count(*)::int FROM jobs j WHERE j.dedupe_key = 'submission:' || v.id::text) AS jobs
         FROM video_submissions v JOIN files f ON f.id = v.file_id WHERE v.id = $1`,
      [submissionId],
    )
  ).rows[0];
  return { status: row.status, fileStatus: row.fileStatus, sizeBytes: Number(row.sizeBytes), jobs: row.jobs as number };
}

test("an upload larger than it was declared is refused at completion and never transcoded", { skip }, async () => {
  await withUploader(async ({ c, userId }) => {
    const { completeUpload } = await webUpload();
    const storage = fakeStorage();
    const r = await reserve(userId);
    storage.objects.set(r.objectKey, SENT);

    const res = await completeUpload({ submissionId: r.submissionId, userId, isAdmin: false, stat: storage.stat, remove: storage.remove });
    assert.deepEqual(res, { ok: false, error: "object_too_large", status: 413 }, "the cap was checked against a size the client made up");
    const s = await state(c, r.submissionId);
    assert.equal(s.jobs, 0, "no transcode for bytes the cap never allowed");
    assert.deepEqual([s.status, s.fileStatus], ["failed", "failed"]);
    assert.equal(s.sizeBytes, DECLARED, "the oversized size is not written back as if it were legitimate");
    assert.deepEqual(storage.removed, [r.objectKey], "the oversized object is deleted, not left in the bucket");

    // Reporting it again does not revive it.
    storage.objects.set(r.objectKey, SENT);
    const again = await completeUpload({ submissionId: r.submissionId, userId, isAdmin: false, stat: storage.stat, remove: storage.remove });
    assert.equal(again.ok, false);
    assert.equal((await state(c, r.submissionId)).jobs, 0);
  });
});

test("an upload of exactly the declared size still completes", { skip }, async () => {
  await withUploader(async ({ c, userId }) => {
    const { completeUpload } = await webUpload();
    const storage = fakeStorage();
    const r = await reserve(userId);
    storage.objects.set(r.objectKey, DECLARED);
    const res = await completeUpload({ submissionId: r.submissionId, userId, isAdmin: false, stat: storage.stat, remove: storage.remove });
    assert.equal(res.ok, true);
    const s = await state(c, r.submissionId);
    assert.deepEqual([s.status, s.fileStatus, s.jobs], ["queued", "stored", 1]);
    assert.deepEqual(storage.removed, []);
  });
});

test("skipping the completion call does not get an oversized upload transcoded by the reconciler", { skip }, async () => {
  await withUploader(async ({ c, userId }) => {
    const { reconcileStalledUploads } = await reconciler();
    const storage = fakeStorage();
    const r = await reserve(userId);
    storage.objects.set(r.objectKey, SENT);
    await c.query(`UPDATE video_submissions SET created_at = now() - interval '15 minutes' WHERE id = $1`, [r.submissionId]);
    await reconcileStalledUploads({ stat: storage.stat, remove: storage.remove });
    const s = await state(c, r.submissionId);
    assert.equal(s.jobs, 0, "the reconciler finished bytes the cap never allowed");
    assert.deepEqual([s.status, s.fileStatus], ["failed", "failed"], "it cannot become valid by waiting");
    // Only completeUpload deleted an oversized object, so a client that skipped
    // that call parked up to the bucket's 2 GB limit in videos-original for good.
    assert.deepEqual(storage.removed, [r.objectKey], "the oversized object is deleted, not left in the bucket");
  });
});

test("the reconciler deletes only the oversized object it failed, and a failed delete is not fatal", { skip }, async () => {
  await withUploader(async ({ c, userId }) => {
    const { reconcileStalledUploads } = await reconciler();
    const { UPLOAD_ABANDON_AFTER_HOURS } = await uploads();
    const storage = fakeStorage();
    const oversized = await reserve(userId);
    const truncated = await reserve(userId, "another-lesson.mp4");
    storage.objects.set(oversized.objectKey, SENT);
    storage.objects.set(truncated.objectKey, DECLARED / 2);
    await c.query(`UPDATE video_submissions SET created_at = now() - make_interval(hours => $2) WHERE id = ANY($1)`, [
      [oversized.submissionId, truncated.submissionId],
      UPLOAD_ABANDON_AFTER_HOURS + 1,
    ]);
    await reconcileStalledUploads({
      stat: storage.stat,
      remove: async (bucket, keys) => {
        await storage.remove(bucket, keys);
        throw new Error("storage down");
      },
    });
    assert.deepEqual(storage.removed, [oversized.objectKey], "an abandoned short upload is failed, as before, but not deleted here");
    for (const id of [oversized.submissionId, truncated.submissionId]) {
      const s = await state(c, id);
      assert.deepEqual([s.status, s.fileStatus], ["failed", "failed"]);
    }
  });
});

test("the /uploads action says an oversized upload was refused, not that it could not be found", { skip }, async () => {
  await withUploader(async ({ c, userId }) => {
    const r = await reserve(userId);
    const removed: string[] = [];
    request.supabaseAdmin = {
      storage: {
        from: () => ({
          list: async () => ({ data: [{ name: r.objectKey.split("/").pop(), metadata: { size: SENT, mimetype: "video/mp4" } }], error: null }),
          remove: async (keys: string[]) => {
            removed.push(...keys);
            return { data: [], error: null };
          },
        }),
      },
    };
    signIn({ id: userId, role: "teacher" });
    try {
      const { completeUploadAction } = await import("../../apps/web/src/app/(authenticated)/uploads/actions.ts");
      const res = await completeUploadAction(r.submissionId);
      assert.equal(res.ok, false);
      assert.doesNotMatch(res.error ?? "", /could not be found/i, "the upload exists; it was refused");
      assert.match(res.error ?? "", /larger than/i, res.error);
      assert.notEqual(res.retryable, true, "confirming again cannot help");
      assert.deepEqual(removed, [r.objectKey]);
      assert.equal((await state(c, r.submissionId)).status, "failed");
    } finally {
      signIn(null);
      delete request.supabaseAdmin;
    }
  });
});

test("the size check: up to 1% short of the declaration, and never more than it", async () => {
  const { isCompleteSize, reconcileDecision, UPLOAD_COMPLETE_GRACE_MINUTES } = await uploads();
  assert.equal(isCompleteSize(1000, 1000), true);
  assert.equal(isCompleteSize(990, 1000), true);
  assert.equal(isCompleteSize(989, 1000), false);
  assert.equal(isCompleteSize(1001, 1000), false, "more bytes than declared is not a complete upload of that file");
  assert.equal(reconcileDecision({ ageSeconds: 60, storedBytes: 1001, expectedBytes: 1000 }), "fail", "waiting cannot make it valid");
  assert.equal(reconcileDecision({ ageSeconds: UPLOAD_COMPLETE_GRACE_MINUTES * 60, storedBytes: 1000, expectedBytes: 1000 }), "complete");
});
