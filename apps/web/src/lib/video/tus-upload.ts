"use client";

// Resumable upload, browser -> Supabase Storage, direct.
//
// One shared implementation so the desktop tray and the mobile runner cannot
// drift. They previously had separate copies of the tus wiring, with separate
// (and both wrong) chunk sizes.
//
// ── WHAT IT DOES DIFFERENTLY FROM THE CODE IT REPLACES ───────────────────────
//
//   endpoint     Supabase's resumable endpoint, not /api/uploads/tus. The old
//                route proxied to a tusd sidecar via TUSD_INTERNAL_URL, which
//                was set in no compose file and no .env, so every branch
//                returned 501. Nothing was ever uploaded through it.
//
//   chunkSize    EXACTLY 6 MiB. Supabase requires this precise value for
//                resumable uploads; the old code used 5 MB, which is neither
//                the tus default nor an accepted value.
//
//   onSuccess    Calls back with the REAL video_submissions id, which the
//                server issued before the upload started. The old code did
//                `upload.url?.split("/").pop() ?? "pending"` -- the tus upload
//                id, or the literal string "pending" -- so onComplete never
//                once received a usable submission id.
//
//   completion   A server round-trip that verifies the object actually landed
//                and matches the reserved size. The old path had no post-finish
//                hook at all, so no rows were ever written and `source='direct'`
//                submissions could not exist.

import type { Upload } from "tus-js-client";
import { accessToken, type SupabaseBrowserConfig } from "@/lib/supabase/browser";

export type UploadHandle = { abort: () => void };

export type StartUploadOptions = {
  file: File;
  bucket: string;
  objectKey: string;
  chunkBytes: number;
  /** Supplied by beginUploadAction — see lib/supabase/browser.ts for why it is
   *  not read from process.env here. */
  supabase: SupabaseBrowserConfig;
  onProgress: (uploaded: number, total: number) => void;
  onError: (message: string) => void;
  onSuccess: () => void;
};

/**
 * Begin a resumable upload. Resolves once the transfer has been STARTED, not
 * when it finishes -- completion arrives via onSuccess.
 */
export async function startResumableUpload(
  opts: StartUploadOptions,
): Promise<UploadHandle | null> {
  const supabaseUrl = opts.supabase?.url;
  if (!supabaseUrl || !opts.supabase?.anonKey) {
    opts.onError("Uploads are not configured on this deployment.");
    return null;
  }

  const token = await accessToken(opts.supabase);
  if (!token) {
    opts.onError("Your session has expired. Please sign in again.");
    return null;
  }

  let tus: typeof import("tus-js-client");
  try {
    tus = await import("tus-js-client");
  } catch {
    // Kept from the previous implementation and still correct: on a corrupted
    // bundle or an offline-cached page the user needs to be told what to do
    // next, not shown a silently failed row.
    opts.onError("Upload library unavailable. Please send the video over WhatsApp instead.");
    return null;
  }

  const upload: Upload = new tus.Upload(opts.file, {
    endpoint: `${supabaseUrl}/storage/v1/upload/resumable`,
    retryDelays: [0, 3000, 5000, 10000, 20000],
    headers: {
      authorization: `Bearer ${token}`,
      // Supabase requires this on the resumable endpoint even when the
      // Authorization header is present.
      "x-upsert": "true",
    },
    uploadDataDuringCreation: true,
    // The object key is server-issued and prefixed with the uploader's uuid.
    // Even if this were tampered with, the RLS policy on storage.objects
    // refuses a key under anyone else's prefix -- verified against the live
    // project, which returns 403 for exactly that case.
    metadata: {
      bucketName: opts.bucket,
      objectName: opts.objectKey,
      contentType: opts.file.type || "video/mp4",
      cacheControl: "3600",
    },
    chunkSize: opts.chunkBytes,
    onError: (err) => opts.onError(friendlyError(err)),
    onProgress: (uploaded, total) => opts.onProgress(uploaded, total),
    onSuccess: () => opts.onSuccess(),
  });

  // Resume a previous attempt for the same file if one is still pending. This
  // is the point of using tus on a Ladakh connection: a dropped link mid-upload
  // continues rather than restarting a 300 MB transfer.
  const previous = await upload.findPreviousUploads();
  if (previous.length > 0) upload.resumeFromPreviousUpload(previous[0]!);

  upload.start();
  return { abort: () => void upload.abort(true).catch(() => undefined) };
}

function friendlyError(err: Error | unknown): string {
  const text = String(err);
  if (/413|too large|exceeded/i.test(text)) {
    return "That file is too large. Send it over WhatsApp instead.";
  }
  if (/401|403|jwt|token/i.test(text)) {
    return "Your session expired during the upload. Sign in again and retry.";
  }
  if (/network|failed to fetch|econn/i.test(text)) {
    return "The connection dropped. Reconnect and choose the same file to resume.";
  }
  return "Upload failed. Please try again, or send the video over WhatsApp.";
}
