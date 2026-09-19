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
// It does NOT trust the clock alone: an upload older than the cutoff is
// completed if the bytes are actually there and failed only if they are not.
// The bytes are the fact; the missing POST was just a notification.

import { and, eq, lt, sql } from "drizzle-orm";
import { createClient } from "@supabase/supabase-js";
import { db } from "@gml/db";
import { files, videoSubmissions } from "@gml/db/schema";
import { enqueue } from "@gml/db/queue";
import { BUCKETS } from "@gml/shared/storage/buckets";
import { statObject } from "@gml/shared/storage/client";
import { log } from "./log.js";

function supabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error("Supabase env not set");
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

export async function reconcileStalledUploads(olderThanMinutes = 30): Promise<void> {
  const sb = supabase();
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000);

  const stalled = await db
    .select({
      id: videoSubmissions.id,
      fileId: files.id,
      bucket: files.bucket,
      objectKey: files.objectKey,
      expectedBytes: files.sizeBytes,
    })
    .from(videoSubmissions)
    .innerJoin(files, eq(files.id, videoSubmissions.fileId))
    .where(
      and(
        eq(videoSubmissions.status, "received"),
        eq(videoSubmissions.source, "direct"),
        eq(files.status, "uploading"),
        lt(videoSubmissions.createdAt, cutoff),
      ),
    )
    .limit(200);

  if (stalled.length === 0) return;

  let completed = 0;
  let failed = 0;

  for (const row of stalled) {
    const stat = await statObject(sb, BUCKETS.videosOriginal, row.objectKey).catch(() => null);
    // A 1% tolerance rather than an exact match: the reserved size is what the
    // browser reported for the File, and Storage reports what it stored.
    const looksComplete =
      stat !== null &&
      (row.expectedBytes == null || stat.size >= Math.floor(row.expectedBytes * 0.99));

    if (looksComplete) {
      await db.update(files).set({ status: "stored", sizeBytes: stat!.size }).where(eq(files.id, row.fileId));
      await db.update(videoSubmissions).set({ status: "queued" }).where(eq(videoSubmissions.id, row.id));
      await enqueue(db, {
        queue: "transcode",
        name: "transcode",
        payload: {
          videoSubmissionId: row.id,
          fileId: row.fileId,
          bucket: row.bucket,
          objectKey: row.objectKey,
        },
        // Same key the web app uses, so a completion POST that arrives late
        // cannot enqueue a second job for the same submission.
        dedupeKey: `submission:${row.id}`,
      });
      completed += 1;
    } else {
      await db.update(files).set({ status: "failed" }).where(eq(files.id, row.fileId));
      await db
        .update(videoSubmissions)
        .set({
          status: "failed",
          processingLog: sql`'upload abandoned or incomplete; reconciled ' || now()::text`,
        })
        .where(eq(videoSubmissions.id, row.id));
      failed += 1;
    }
  }

  log.info("reconciled stalled uploads", { completed, failed, examined: stalled.length });
}
