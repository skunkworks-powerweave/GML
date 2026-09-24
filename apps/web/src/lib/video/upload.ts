import "server-only";

// Direct-to-Storage upload: the server half.
//
// The browser uploads video STRAIGHT TO SUPABASE STORAGE over TUS, using its
// own access token, constrained by an RLS policy that pins the object key to
// the uploader's uuid. No bytes pass through this application in either
// direction.
//
// ── WHAT THIS REPLACES ────────────────────────────────────────────────────────
//
// A tusd sidecar behind /api/uploads/tus. That path was 0% functional and had
// been since it shipped:
//   * TUSD_INTERNAL_URL was set in no compose file and no .env, so every branch
//     of the proxy route returned 501. HEAD and DELETE returned 501
//     unconditionally regardless.
//   * tusd was configured to write to bucket `gml-media`, which `minio-init`
//     never created.
//   * Caddy's `handle_path /api/uploads/tus/*` did not match the tus CREATE
//     request (`POST /api/uploads/tus`, no trailing segment), and stripped a
//     prefix that tusd's `-base-path=/uploads/` expected.
//   * There were no post-finish hooks, so nothing wrote files or
//     video_submissions rows. `source = 'direct'` rows were unreachable.
//   * The proxy interpolated an unvalidated `?id` into the internal tusd URL
//     and forwarded the caller's own Cookie and Authorization headers to it.
//
// ── WHY ROWS ARE CREATED BEFORE THE BYTES ARRIVE ──────────────────────────────
//
// The client needs a submission id to report progress against and to poll, and
// the completion check needs a recorded expected size to compare Storage
// against. Creating the rows up front costs an orphan row when an upload is
// abandoned, which the reconciler sweeps; the alternative — trusting the client
// to declare what it uploaded on completion — has no way to detect a caller
// that claims to have finished having uploaded nothing.

import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@gml/db";
import { files, videoSubmissions } from "@gml/db/schema";
import { finalizeUpload, isCompleteSize, UPLOAD_ABANDON_AFTER_HOURS } from "@gml/db/uploads";
import { BUCKETS, uploadKey } from "@gml/shared/storage/buckets";
import { storage } from "@/lib/video/storage";
import { getSystemSettings } from "@/lib/system-settings";

export type UploadContextType =
  | "observation_cycle"
  | "teach_back"
  | "mentor_meeting"
  | "mentee_quarterly"
  | "classroom_session"
  | "generic";

/**
 * Hard ceiling, matching the bucket's own file_size_limit in _post/005.
 *
 * The EFFECTIVE limit is the programme setting `videoMaxUploadMb`, which is
 * lower by default (500 MB) and editable at /admin/system-settings. That
 * setting had UI, an API route, validation and an audit trail, and was READ BY
 * NOTHING -- an administrator could change it and nothing anywhere behaved
 * differently. This is the code that makes it real.
 *
 * Both bounds exist on purpose: the setting is what the programme has decided,
 * and this constant is what Storage will physically accept, so a mis-set
 * setting cannot ask for something the bucket would reject after the user has
 * already uploaded it.
 */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Supabase requires a chunk size of EXACTLY 6 MiB for resumable uploads.
 * The previous client used 5 MB, which is neither the tus default nor what
 * Supabase accepts.
 */
export const UPLOAD_CHUNK_BYTES = 6 * 1024 * 1024;

const ALLOWED_VIDEO_TYPES = new Set([
  "video/mp4",
  "video/quicktime",
  "video/x-matroska",
  "video/webm",
  "video/3gpp",
  "video/x-msvideo",
  "video/mpeg",
  "application/octet-stream",
]);

function extensionFor(filename: string, contentType: string): string {
  const fromName = filename.includes(".") ? filename.split(".").pop()! : "";
  if (fromName && /^[a-z0-9]{1,8}$/i.test(fromName)) return fromName.toLowerCase();
  if (contentType === "video/quicktime") return "mov";
  if (contentType === "video/webm") return "webm";
  return "mp4";
}

export type BeginUploadResult = {
  submissionId: string;
  bucket: string;
  objectKey: string;
  chunkBytes: number;
  /** True when this is an earlier, unfinished reservation for the same file. */
  resumed: boolean;
};

/**
 * Reserve a submission and tell the client where to put the bytes.
 *
 * The object key is built from the caller's OWN uuid, server-side. A client
 * cannot choose it, and even if this code were bypassed the RLS policy on
 * storage.objects would refuse a key under anyone else's prefix.
 */
export async function beginUpload(opts: {
  userId: string;
  filename: string;
  sizeBytes: number;
  contentType: string;
  contextType: UploadContextType;
  contextId?: string | null;
}): Promise<BeginUploadResult | { error: string }> {
  const contentType = ALLOWED_VIDEO_TYPES.has(opts.contentType)
    ? opts.contentType
    : "application/octet-stream";

  if (!Number.isFinite(opts.sizeBytes) || opts.sizeBytes <= 0) {
    return { error: "That file looks empty." };
  }
  // The programme's configured cap, bounded by what the bucket will accept.
  const settings = await getSystemSettings().catch(() => null);
  const configuredBytes = settings?.videoMaxUploadMb
    ? settings.videoMaxUploadMb * 1024 * 1024
    : MAX_UPLOAD_BYTES;
  const effectiveMax = Math.min(configuredBytes, MAX_UPLOAD_BYTES);

  if (opts.sizeBytes > effectiveMax) {
    const mb = Math.floor(effectiveMax / (1024 * 1024));
    return {
      error: `That file is larger than the ${mb} MB limit. Send it over WhatsApp instead.`,
    };
  }

  // CONTINUE AN UNFINISHED RESERVATION FOR THE SAME FILE.
  //
  // tus resumes a previous upload of the same file from the browser's own
  // storage, and that upload is bound to the object key it was created for.
  // Issuing a fresh key every time meant that picking the same file again --
  // which is exactly what the tray tells a teacher to do after a dropped
  // connection -- sent the bytes to the abandoned reservation's key while the
  // new reservation waited for an object that never came. Handing back the
  // same reservation is what lets the transfer actually resume.
  //
  // Matched on everything the browser knows about the file plus the context it
  // is for, and only while the reservation is still waiting for its bytes and
  // inside the window the reconciler leaves it open (packages/db/src/uploads.ts).
  const filename = opts.filename.slice(0, 255);
  const contextId = opts.contextId ?? null;
  const [unfinished] = await db
    .select({ submissionId: videoSubmissions.id, objectKey: files.objectKey })
    .from(videoSubmissions)
    .innerJoin(files, eq(files.id, videoSubmissions.fileId))
    .where(
      and(
        eq(videoSubmissions.submittedByUserId, opts.userId),
        eq(videoSubmissions.source, "direct"),
        eq(videoSubmissions.status, "received"),
        eq(videoSubmissions.contextType, opts.contextType),
        contextId ? eq(videoSubmissions.contextId, contextId) : isNull(videoSubmissions.contextId),
        eq(files.status, "uploading"),
        eq(files.originalFilename, filename),
        eq(files.sizeBytes, opts.sizeBytes),
        eq(files.mimeType, contentType),
        sql`${videoSubmissions.createdAt} > now() - make_interval(hours => ${UPLOAD_ABANDON_AFTER_HOURS})`,
      ),
    )
    .orderBy(desc(videoSubmissions.createdAt))
    .limit(1);
  if (unfinished) {
    return {
      submissionId: unfinished.submissionId,
      bucket: BUCKETS.videosOriginal,
      objectKey: unfinished.objectKey,
      chunkBytes: UPLOAD_CHUNK_BYTES,
      resumed: true,
    };
  }

  const uploadId = randomUUID();
  const objectKey = uploadKey(opts.userId, uploadId, extensionFor(opts.filename, contentType));

  const [fileRow] = await db
    .insert(files)
    .values({
      bucket: BUCKETS.videosOriginal,
      objectKey,
      mimeType: contentType,
      kind: "video_original",
      // 'uploading' is a status the CHECK constraint has always permitted and
      // that nothing has ever written: every row went straight to 'stored'.
      // It is what lets the reconciler tell an abandoned upload from a real one.
      status: "uploading",
      sizeBytes: opts.sizeBytes,
      ownerUserId: opts.userId,
      originalFilename: filename,
    })
    .returning({ id: files.id });

  const [submission] = await db
    .insert(videoSubmissions)
    .values({
      fileId: fileRow.id,
      source: "direct",
      status: "received",
      contextType: opts.contextType,
      contextId,
      // THE COLUMN THAT HAD NO WRITERS. `submitted_by_user_id` was declared,
      // indexed, read by lib/authz.ts, by the "My uploads" filter and by three
      // dashboard counts -- and written by nothing, anywhere. So the ownership
      // branch could never match, "My uploads" was permanently empty, and those
      // counts were structurally zero. This is the first code that sets it.
      submittedByUserId: opts.userId,
    })
    .returning({ id: videoSubmissions.id });

  return {
    submissionId: submission.id,
    bucket: BUCKETS.videosOriginal,
    objectKey,
    chunkBytes: UPLOAD_CHUNK_BYTES,
    resumed: false,
  };
}

export type CompleteUploadResult =
  | { ok: true; submissionId: string }
  | { ok: false; error: string; status: number };

/**
 * Confirm an upload actually landed, then hand it to the transcoder.
 *
 * The client's word is not taken for any of it. Storage is asked what it
 * holds, and the size is compared against what was reserved. Without that a
 * caller can POST "done" having uploaded nothing, and a submission enters the
 * pipeline pointing at an empty object — which then fails in the worker, where
 * it looks like a transcoding problem rather than a lying client.
 *
 * Idempotent: a submission already past 'received' returns ok without
 * re-enqueueing, because the browser retries this call on a flaky connection
 * and a double enqueue would transcode the same video twice.
 *
 * With ONE exception. A reservation the reconciler gave up on (submission and
 * file both 'failed') used to return ok here too, so the teacher was told the
 * upload had worked while the submission never left 'failed'. Now its bytes are
 * checked like any other: present, and it goes on to transcode; absent, and the
 * teacher is told it is missing.
 *
 * The transition itself is finalizeUpload (packages/db/src/uploads.ts), shared
 * with the reconciler so the two cannot drift again.
 */
export async function completeUpload(opts: {
  submissionId: string;
  userId: string;
  isAdmin: boolean;
  /** Free-text note from the uploader, stored on the evidence row. */
  caption?: string | null;
  /** What Storage holds at a key. Defaults to the service-role client. */
  stat?: (bucket: string, key: string) => Promise<{ size: number } | null>;
}): Promise<CompleteUploadResult> {
  const [row] = await db
    .select({
      id: videoSubmissions.id,
      status: videoSubmissions.status,
      submittedBy: videoSubmissions.submittedByUserId,
      contextType: videoSubmissions.contextType,
      contextId: videoSubmissions.contextId,
      fileId: files.id,
      bucket: files.bucket,
      objectKey: files.objectKey,
      expectedBytes: files.sizeBytes,
      fileStatus: files.status,
    })
    .from(videoSubmissions)
    .innerJoin(files, eq(files.id, videoSubmissions.fileId))
    .where(eq(videoSubmissions.id, opts.submissionId))
    .limit(1);

  if (!row) return { ok: false, error: "not_found", status: 404 };

  // Ownership, not just authentication. 404 rather than 403 so a caller cannot
  // probe which submission ids exist.
  if (!opts.isAdmin && row.submittedBy !== opts.userId) {
    return { ok: false, error: "not_found", status: 404 };
  }

  const reconciledAway = row.status === "failed" && row.fileStatus === "failed";
  if (row.status !== "received" && !reconciledAway) {
    return { ok: true, submissionId: row.id };
  }

  const stat = opts.stat
    ? await opts.stat(BUCKETS.videosOriginal, row.objectKey)
    : await storage.stat(BUCKETS.videosOriginal, row.objectKey);
  if (!stat) {
    return { ok: false, error: "object_missing", status: 409 };
  }
  // Allow the object to be no SMALLER than declared minus a tolerance, and
  // reject a wildly different size. Storage reports the bytes it actually
  // holds, so a truncated upload is caught here rather than in ffmpeg.
  if (!isCompleteSize(stat.size, row.expectedBytes)) {
    return { ok: false, error: "object_truncated", status: 409 };
  }

  await finalizeUpload(db, {
    submissionId: row.id,
    fileId: row.fileId,
    bucket: row.bucket,
    objectKey: row.objectKey,
    storedBytes: stat.size,
    contextType: row.contextType,
    contextId: row.contextId,
    caption: opts.caption,
  });

  return { ok: true, submissionId: row.id };
}

// The stalled-upload reconciler lives in apps/worker (reconcile-uploads.ts),
// not here. It is a background sweep over rows nobody is looking at, and it has
// to run whether or not a browser is doing anything -- so it belongs with the
// other periodic work rather than behind a request.
