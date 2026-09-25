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
  const supabaseConfig = opts.supabase;

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

  // THE TOKEN IS ASKED FOR PER REQUEST, not read once. It used to be baked
  // into `headers` before the transfer began, and Storage checks the JWT's exp
  // on every PATCH -- so the first request after that token expired came back
  // 400 '"exp" claim timestamp check failed', tus does not retry a 4xx, and a
  // teacher whose session had long since been refreshed was told it had
  // expired. A token can arrive with only minutes left (the deploy README sets
  // a 15-minute lifetime), and a phone video on a Ladakh link takes longer.
  //
  // If Storage refuses a token anyway (the browser's clock disagrees, or a
  // refresh has not run yet), the request is retried ONCE with a forced
  // refresh. A refusal of that fresh token is final: the session really is
  // gone, and the teacher is told to sign in.
  let refreshNext = false;
  let refreshedAfterRefusal = false;

  const upload: Upload = new tus.Upload(opts.file, {
    endpoint: `${supabaseUrl}/storage/v1/upload/resumable`,
    retryDelays: [0, 3000, 5000, 10000, 20000],
    // The bearer token is the only header this sets. No `x-upsert`. It asks Storage to overwrite an existing object, and there
    // never is one: the key is new for every reservation. It is also refused.
    // An upsert has to read the existing row, and _post/005 grants
    // `authenticated` INSERT/UPDATE/DELETE under its own prefix but deliberately
    // no SELECT. With the header, every teacher's upload came back 403 "new row
    // violates row-level security policy"; without it, 201. Both were checked
    // against a local Supabase stack with the same token and key.
    onBeforeRequest: async (req) => {
      const refresh = refreshNext;
      refreshNext = false;
      const current = (await accessToken(supabaseConfig, { refresh })) ?? token;
      req.setHeader("authorization", `Bearer ${current}`);
    },
    onAfterResponse: (_req, res) => {
      if (res.getStatus() < 400) refreshedAfterRefusal = false;
    },
    onShouldRetry: (err, retryAttempt, options) => {
      if (isTokenRefusal(err)) {
        if (refreshedAfterRefusal) return false;
        refreshedAfterRefusal = true;
        refreshNext = true;
        return true;
      }
      return tus.defaultOptions.onShouldRetry?.(err, retryAttempt, options) ?? false;
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
    // A finished upload's resume entry would otherwise match the next upload
    // of the same file (see the resume filter below).
    removeFingerprintOnSuccess: true,
    onError: (err) => opts.onError(uploadErrorMessage(err)),
    onProgress: (uploaded, total) => opts.onProgress(uploaded, total),
    onSuccess: () => opts.onSuccess(),
  });

  // Resume a previous attempt at THIS reservation if one is still pending. This
  // is the point of using tus on a Ladakh connection: a dropped link mid-upload
  // continues rather than restarting a 300 MB transfer.
  //
  // tus finds previous uploads by the file's fingerprint (name, type, size,
  // modified time), so an upload of the same file to an EARLIER reservation
  // matches too -- and that upload is bound to the earlier key. Resuming it
  // sent the bytes there (or, if it had finished, "succeeded" without sending
  // anything), and this reservation's completion check reported the file
  // missing on every retry. beginUpload hands back the same reservation for a
  // file picked again, so a genuine resume still matches on the key.
  const previous = (await upload.findPreviousUploads()).filter(
    (p) => p.metadata?.objectName === opts.objectKey,
  );
  if (previous.length > 0) upload.resumeFromPreviousUpload(previous[0]!);

  upload.start();
  return { abort: () => void upload.abort(true).catch(() => undefined) };
}

type TusFailure = {
  originalRequest?: unknown;
  originalResponse?: { getStatus(): number; getBody(): string } | null;
};

/** Storage's words for a bearer token it will not accept (bad signature, expired). */
const TOKEN_REFUSED = /jwt|jws|signature verification|unauthorized/i;
const POLICY_REFUSED = /row-level security|violates .*policy/i;

/**
 * Did Storage refuse the TOKEN, as opposed to the upload? Storage answers a
 * bad or expired JWT with HTTP 400 (or 401) and "Unauthorized" in the body. An
 * RLS refusal is a 403 about the object, which a new token cannot change.
 */
function isTokenRefusal(err: unknown): boolean {
  const res = (typeof err === "object" && err !== null ? (err as TusFailure).originalResponse : null) ?? null;
  if (!res) return false;
  const status = res.getStatus();
  const body = res.getBody() || "";
  if (POLICY_REFUSED.test(body)) return false;
  return status === 401 || (status >= 400 && status < 500 && TOKEN_REFUSED.test(body));
}

/**
 * What to tell the teacher when an upload fails.
 *
 * Classified from the RESPONSE tus carries, never from the error's text. The
 * text embeds the upload URL, whose id is base64, so a regex over it could read
 * "413" or "401" out of the id and call a dropped link "too large" or "session
 * expired".
 *
 *   no response at all      the link dropped. A browser XHR that fails at the
 *                           network level hands tus a bare ProgressEvent, so
 *                           this used to fall through to "Upload failed" and
 *                           the teacher was never told the upload can resume.
 *   RLS refusal (HTTP 403)  a deployment fault, not the teacher's session.
 *   bad/expired token       Storage answers HTTP 400 with "Unauthorized" in the
 *                           body. The old `/401|403|jwt|token/` over the text
 *                           matched the refusal too, and signing in again only
 *                           produced a fresh token refused the same way.
 */
export function uploadErrorMessage(err: unknown): string {
  const failure = (typeof err === "object" && err !== null ? err : {}) as TusFailure;
  const res = failure.originalResponse ?? null;
  if (failure.originalRequest != null && res === null) {
    return "The connection dropped. Reconnect and choose the same file to resume.";
  }
  const status = res ? res.getStatus() : 0;
  const body = res ? res.getBody() || "" : String(err);
  if (status === 413 || /too large|exceeded/i.test(body)) {
    return "That file is too large. Send it over WhatsApp instead.";
  }
  if (POLICY_REFUSED.test(body)) {
    return "The server refused this upload. Send the video over WhatsApp for now, and tell your programme admin.";
  }
  // Reached only after a forced token refresh was refused too (see
  // onShouldRetry above), so here the session really has ended.
  if (status === 401 || TOKEN_REFUSED.test(body)) {
    return "Your session expired during the upload. Sign in again and retry.";
  }
  if (!res && /network|failed to fetch|econn|socket hang up/i.test(body)) {
    return "The connection dropped. Reconnect and choose the same file to resume.";
  }
  return "Upload failed. Please try again, or send the video over WhatsApp.";
}
