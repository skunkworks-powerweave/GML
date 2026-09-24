// Sweep direct uploads that were reserved and never confirmed.
//
// The completion call from the browser is the primary path, and it is the one
// that can be lost: a tab closed between the last chunk and the POST, a phone
// that went out of coverage on the way home from the school, a tunnel that
// dropped. Those leave a submission stuck at 'received' with the video sitting
// in Storage, and nothing would ever pick it up.
//
// This runs in the worker rather than the web app because it is a background
// sweep over rows nobody is looking at, and because it must run even when no
// browser is doing anything.
//
// The bytes decide, and the clock decides only abandonment (reconcileDecision
// in packages/db/src/uploads.ts):
//   complete object, past the grace period   -> finish it, exactly as the
//                                               browser's call would have,
//                                               cycle evidence included
//   no complete object, past the window      -> failed
//   anything else                            -> leave it; it may be in flight
//
// This used to fail any reservation older than 30 minutes without an object.
// A resumable object only appears when its last byte lands, so every upload
// longer than 30 minutes -- every large video on a 2G link -- was failed while
// it was still transferring. It also finished lost completions without the
// observation_evidence row, so those videos never appeared on their cycle.
//
// Ages are measured by the DATABASE clock, the same clock that stamped
// created_at, so a worker host whose clock drifts cannot fail uploads early.

import { and, asc, eq, sql } from "drizzle-orm";
import { createClient } from "@supabase/supabase-js";
import { db } from "@gml/db";
import { files, videoSubmissions } from "@gml/db/schema";
import { finalizeUpload, reconcileDecision, UPLOAD_COMPLETE_GRACE_MINUTES } from "@gml/db/uploads";
import { BUCKETS } from "@gml/shared/storage/buckets";
import { statObject } from "@gml/shared/storage/client";
import { log } from "./log.js";

type Stat = (bucket: string, key: string) => Promise<{ size: number } | null>;

function storageStat(): Stat {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error("Supabase env not set");
  const sb = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  return (bucket, objectKey) => statObject(sb, bucket as typeof BUCKETS.videosOriginal, objectKey);
}

export async function reconcileStalledUploads(opts: { stat?: Stat } = {}): Promise<void> {
  const stat = opts.stat ?? storageStat();

  // Nothing younger than the grace period can be acted on, so it is not read.
  // Oldest first, so a backlog is worked through rather than re-examined.
  const waiting = await db
    .select({
      id: videoSubmissions.id,
      fileId: files.id,
      bucket: files.bucket,
      objectKey: files.objectKey,
      expectedBytes: files.sizeBytes,
      contextType: videoSubmissions.contextType,
      contextId: videoSubmissions.contextId,
      ageSeconds: sql<number>`extract(epoch from now() - ${videoSubmissions.createdAt})::float8`,
    })
    .from(videoSubmissions)
    .innerJoin(files, eq(files.id, videoSubmissions.fileId))
    .where(
      and(
        eq(videoSubmissions.status, "received"),
        eq(videoSubmissions.source, "direct"),
        eq(files.status, "uploading"),
        sql`${videoSubmissions.createdAt} < now() - make_interval(mins => ${UPLOAD_COMPLETE_GRACE_MINUTES})`,
      ),
    )
    .orderBy(asc(videoSubmissions.createdAt))
    .limit(200);

  if (waiting.length === 0) return;

  let completed = 0;
  let failed = 0;
  let inFlight = 0;

  for (const row of waiting) {
    const found = await stat(BUCKETS.videosOriginal, row.objectKey).catch(() => null);
    const decision = reconcileDecision({
      ageSeconds: Number(row.ageSeconds),
      storedBytes: found ? found.size : null,
      expectedBytes: row.expectedBytes,
    });

    if (decision === "complete") {
      const { finalized } = await finalizeUpload(db, {
        submissionId: row.id,
        fileId: row.fileId,
        bucket: row.bucket,
        objectKey: row.objectKey,
        storedBytes: found!.size,
        contextType: row.contextType,
        contextId: row.contextId,
      });
      if (finalized) completed += 1;
    } else if (decision === "fail") {
      // The submission is claimed first, so a completion that lands between
      // the stat above and this write cannot leave a queued submission
      // pointing at a file marked failed.
      const claimed = await db.transaction(async (tx) => {
        const rows = await tx
          .update(videoSubmissions)
          .set({
            status: "failed",
            processingLog: sql`'upload abandoned or incomplete; reconciled ' || now()::text`,
          })
          .where(and(eq(videoSubmissions.id, row.id), eq(videoSubmissions.status, "received")))
          .returning({ id: videoSubmissions.id });
        if (rows.length > 0) await tx.update(files).set({ status: "failed" }).where(eq(files.id, row.fileId));
        return rows.length > 0;
      });
      if (claimed) failed += 1;
    } else {
      inFlight += 1;
    }
  }

  log.info("reconciled stalled uploads", { completed, failed, inFlight, examined: waiting.length });
}
