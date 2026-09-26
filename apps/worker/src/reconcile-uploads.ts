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
//   more bytes than were declared            -> failed at once, and the object
//                                               deleted (the declared size is
//                                               what the upload cap checked)
//   Storage did not answer                   -> leave it; the next sweep asks
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
import {
  finalizeUpload,
  isOversize,
  reconcileDecision,
  UPLOAD_ABANDON_AFTER_HOURS,
  UPLOAD_COMPLETE_GRACE_MINUTES,
} from "@gml/db/uploads";
import { BUCKETS } from "@gml/shared/storage/buckets";
import { removeObjects, statObject } from "@gml/shared/storage/client";
import { log } from "./log.js";

type Stat = (bucket: string, key: string) => Promise<{ size: number } | null>;
type Remove = (bucket: string, keys: string[]) => Promise<unknown>;

function serviceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error("Supabase env not set");
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

function storageStat(): Stat {
  const sb = serviceClient();
  return (bucket, objectKey) => statObject(sb, bucket as typeof BUCKETS.videosOriginal, objectKey);
}

function storageRemove(): Remove {
  const sb = serviceClient();
  return (bucket, keys) => removeObjects(sb, bucket as typeof BUCKETS.videosOriginal, keys);
}

export async function reconcileStalledUploads(opts: { stat?: Stat; remove?: Remove } = {}): Promise<void> {
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
  let unanswered = 0;
  let oldestUnansweredSeconds = 0;
  let unansweredErr = "";

  for (const row of waiting) {
    // statObject answers null for "not there" and throws when Storage errs.
    // This used to be `.catch(() => null)`: during an outage, every stored
    // upload past the abandon window was failed as if its object were missing.
    let found: { size: number } | null;
    try {
      found = await stat(BUCKETS.videosOriginal, row.objectKey);
    } catch (err) {
      unanswered += 1;
      oldestUnansweredSeconds = Math.max(oldestUnansweredSeconds, Number(row.ageSeconds));
      unansweredErr = String(err).slice(0, 300);
      continue;
    }
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
      const oversized = found !== null && isOversize(found.size, row.expectedBytes);
      // The submission is claimed first, so a completion that lands between
      // the stat above and this write cannot leave a queued submission
      // pointing at a file marked failed.
      const claimed = await db.transaction(async (tx) => {
        const rows = await tx
          .update(videoSubmissions)
          .set({
            status: "failed",
            processingLog: oversized
              ? sql`'stored size exceeds the declared size; reconciled ' || now()::text`
              : sql`'upload abandoned or incomplete; reconciled ' || now()::text`,
          })
          .where(and(eq(videoSubmissions.id, row.id), eq(videoSubmissions.status, "received")))
          .returning({ id: videoSubmissions.id });
        if (rows.length > 0) await tx.update(files).set({ status: "failed" }).where(eq(files.id, row.fileId));
        return rows.length > 0;
      });
      if (claimed) failed += 1;
      // Bytes the cap never allowed, which nothing will ever transcode, are not
      // kept: completeUpload deletes them, and a client that skips that call
      // must not park them here instead. Only once claimed, so an object a live
      // submission points at is never removed. Best effort, as there: the row
      // is already failed.
      if (claimed && oversized) {
        try {
          await (opts.remove ?? storageRemove())(BUCKETS.videosOriginal, [row.objectKey]);
        } catch (err) {
          log.warn("could not delete an oversized upload", { submissionId: row.id, err: String(err) });
        }
      }
    } else {
      inFlight += 1;
    }
  }

  log.info("reconciled stalled uploads", { completed, failed, inFlight, unanswered, examined: waiting.length });

  // Leaving an upload alone while Storage does not answer is right for an
  // outage, but it has no end: the abandon rule is reached only through an
  // answer, so an upload whose stat keeps throwing (a permission error on the
  // bucket, a revoked key) stays 'received' for good. That was a count in the
  // info line above. Said on its own, and as an error once it has outlasted
  // twice the abandon window, which no outage this sweep waits out does.
  if (unanswered > 0) {
    const oldestHours = Math.floor(oldestUnansweredSeconds / 3600);
    const say = oldestHours >= 2 * UPLOAD_ABANDON_AFTER_HOURS ? log.error : log.warn;
    say("Storage did not answer for stalled uploads; they stay 'received' until it does", {
      unanswered,
      oldestHours,
      err: unansweredErr,
    });
  }
}
