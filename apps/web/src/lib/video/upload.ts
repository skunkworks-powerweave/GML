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
import { eq } from "drizzle-orm";
import { db } from "@gml/db";
import { files, videoSubmissions } from "@gml/db/schema";
import { BUCKETS, uploadKey } from "@gml/shared/storage/buckets";
import { storage } from "@/lib/video/storage";

export type UploadContextType =
  | "observation_cycle"
  | "teach_back"
  | "mentor_meeting"
  | "mentee_quarterly"
  | "classroom_session"
  | "generic";

/** 2 GiB, matching the bucket's server-side file_size_limit in _post/005. */
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
  if (opts.sizeBytes > MAX_UPLOAD_BYTES) {
    return { error: "That file is larger than 2 GB. Send it over WhatsApp instead." };
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
      originalFilename: opts.filename.slice(0, 255),
    })
    .returning({ id: files.id });

  const [submission] = await db
    .insert(videoSubmissions)
    .values({
      fileId: fileRow.id,
      source: "direct",
      status: "received",
      contextType: opts.contextType,
      contextId: opts.contextId ?? null,
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
 */
export async function completeUpload(opts: {
  submissionId: string;
  userId: string;
  isAdmin: boolean;
  enqueue: (input: { videoSubmissionId: string; fileId: string; bucket: string; objectKey: string }) => Promise<void>;
}): Promise<CompleteUploadResult> {
  const [row] = await db
    .select({
      id: videoSubmissions.id,
      status: videoSubmissions.status,
      submittedBy: videoSubmissions.submittedByUserId,
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

  if (row.status !== "received") {
    return { ok: true, submissionId: row.id };
  }

  const stat = await storage.stat(BUCKETS.videosOriginal, row.objectKey);
  if (!stat) {
    return { ok: false, error: "object_missing", status: 409 };
  }
  // Allow the object to be no SMALLER than declared minus a tolerance, and
  // reject a wildly different size. Storage reports the bytes it actually
  // holds, so a truncated upload is caught here rather than in ffmpeg.
  if (row.expectedBytes != null && stat.size < Math.floor(row.expectedBytes * 0.99)) {
    return { ok: false, error: "object_truncated", status: 409 };
  }

  await db
    .update(files)
    .set({ status: "stored", sizeBytes: stat.size })
    .where(eq(files.id, row.fileId));

  await db
    .update(videoSubmissions)
    .set({ status: "queued" })
    .where(eq(videoSubmissions.id, row.id));

  await opts.enqueue({
    videoSubmissionId: row.id,
    fileId: row.fileId,
    bucket: row.bucket,
    objectKey: row.objectKey,
  });

  return { ok: true, submissionId: row.id };
}

// The stalled-upload reconciler lives in apps/worker (reconcile-uploads.ts),
// not here. It is a background sweep over rows nobody is looking at, and it has
// to run whether or not a browser is doing anything -- so it belongs with the
// other periodic work rather than behind a request.
