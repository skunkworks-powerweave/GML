// Fetch one WhatsApp video from the Graph API into Storage, then queue its
// transcode.
//
// ── WHY THIS RUNS HERE ───────────────────────────────────────────────────────
//
// It used to run in the webhook, inside Next's after(), once Meta had already
// been told 200 -- and Meta redelivers only a webhook that did NOT get a 2xx.
// Every failure on that path was final: fetchMediaUrl and downloadMediaBytes
// turned a blank or expired token, a Graph 5xx, a network error or an HTML
// error body into `null`, the handler wrote a bare {msgId} audit row, and the
// video was gone. A Storage or database error was only console.error'd. And a
// container restart mid-ingest took the work with it.
//
// Now the webhook records the submission and queues this job in one
// transaction before answering, and this handler THROWS on every failure, so
// the queue retries it with backoff (WHATSAPP_FETCH_MAX_ATTEMPTS). The last
// attempt marks the submission and its file 'failed' with the reason, which
// /admin/whatsapp-log shows next to a "Retry fetch" button.
//
// Each error names its cause -- the missing variable, the HTTP status and
// Graph's error code -- because "url_failed" alone could not tell an expired
// token from a Meta outage.

import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { createClient } from "@supabase/supabase-js";
import { db } from "@gml/db";
import { auditLog, files, videoSubmissions } from "@gml/db/schema";
import { enqueue } from "@gml/db/queue";
import type { BucketName } from "@gml/shared/storage/buckets";
import { putObject } from "@gml/shared/storage/client";
import { mediaMetadataUrl, type EnvLike } from "@gml/shared/whatsapp/graph";
import type { WhatsAppFetchPayload } from "@gml/shared/whatsapp/fetch-job";
import { log } from "./log.js";

/**
 * Meta's own ceiling for a document message is 100 MB, and a long lesson has
 * to travel as a document (video messages stop at 16 MB). The webhook's old
 * 64 MB cap would have refused the recordings that most need this path. Still
 * enforced rather than assumed: the bytes are buffered, and "the platform
 * promises it is small" is not a memory bound.
 */
export const MAX_WHATSAPP_MEDIA_BYTES = 100 * 1024 * 1024;

/** The metadata call answers in well under a second when Graph is healthy. */
const GRAPH_TIMEOUT_MS = 15_000;

/** 100 MB over a slow path; the worker holds a lease far longer than this. */
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

export type FetchDeps = {
  fetch: typeof fetch;
  put: (bucket: string, key: string, body: Uint8Array, contentType: string) => Promise<void>;
  env: EnvLike;
};

function storagePut(): FetchDeps["put"] {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY must be set for the worker to reach Storage.");
  }
  const sb = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  return (bucket, objectKey, body, contentType) => putObject(sb, bucket as BucketName, objectKey, body, contentType);
}

/** Best-effort audit row. The worker has no request scope, so no actor or IP. */
async function audit(action: string, entityId: string, metadata: Record<string, unknown>): Promise<void> {
  try {
    await db.insert(auditLog).values({ action, entityType: "video_submission", entityId, metadata });
  } catch (err) {
    log.warn("audit insert failed", { action, err: String(err).slice(0, 200) });
  }
}

/** "HTTP 401 (Graph error 190: Session has expired)", from whatever Graph sent. */
async function describeHttpFailure(res: Response): Promise<string> {
  let detail = "";
  try {
    const body = (await res.json()) as { error?: { code?: number; message?: string } };
    if (body.error) detail = ` (Graph error ${body.error.code ?? "?"}: ${String(body.error.message ?? "").slice(0, 200)})`;
  } catch {
    // Not JSON; the status is all there is.
  }
  return `HTTP ${res.status}${detail}`;
}

/**
 * Download the media. Throws, with the reason, on anything that is not a video
 * the right size -- the next attempt asks Graph for a fresh URL, because the
 * one it hands out is short-lived.
 */
async function download(p: WhatsAppFetchPayload, deps: FetchDeps): Promise<Uint8Array> {
  const token = deps.env.WHATSAPP_ACCESS_TOKEN?.trim();
  if (!token) {
    throw new Error(
      "WHATSAPP_ACCESS_TOKEN is not set, so WhatsApp media cannot be fetched. Set it (a permanent " +
        "system-user token; see README-IT.md) and use Retry fetch on /admin/whatsapp-log.",
    );
  }
  const auth = { authorization: `Bearer ${token}` };

  const meta = await deps.fetch(mediaMetadataUrl(p.mediaId, deps.env), {
    headers: auth,
    signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
  });
  if (!meta.ok) {
    const why = await describeHttpFailure(meta);
    const hint = meta.status === 401 ? " -- the access token was rejected; it may have expired" : "";
    throw new Error(`Graph media lookup failed: ${why}${hint}`);
  }
  const { url } = (await meta.json()) as { url?: string };
  if (!url) throw new Error("Graph media lookup returned no download url");

  const res = await deps.fetch(url, { headers: auth, signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`media download failed: ${await describeHttpFailure(res)}`);

  // An error page served with a 200 was stored as video/mp4 and only failed
  // later, inside ffmpeg. Refuse anything that says it is not a video.
  const type = (res.headers.get("content-type") ?? "").toLowerCase();
  if (type && !type.startsWith("video/") && !type.startsWith("application/octet-stream")) {
    throw new Error(`media download returned ${type.split(";")[0]}, not a video`);
  }

  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > MAX_WHATSAPP_MEDIA_BYTES) {
    throw new Error(`media declares ${declared} bytes, over the ${MAX_WHATSAPP_MEDIA_BYTES}-byte cap`);
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > MAX_WHATSAPP_MEDIA_BYTES) {
    throw new Error(`media delivered ${buf.byteLength} bytes, over the ${MAX_WHATSAPP_MEDIA_BYTES}-byte cap`);
  }
  if (buf.byteLength === 0) throw new Error("media download was empty");
  return buf;
}

/**
 * Compare Meta's checksum with the bytes. Reported, deliberately NOT enforced:
 * Meta documents the field only as "the checksum of the media", and no
 * delivery from this deployment has ever been compared against it, so a
 * refusal here could reject every video on a format misunderstanding. A
 * mismatch is logged and audited instead, with the digest we computed stored
 * on the file.
 */
function checksum(bytes: Uint8Array, claimed: string | null): { hex: string; matches: boolean | null } {
  const digest = createHash("sha256").update(bytes).digest();
  const hex = digest.toString("hex");
  if (!claimed) return { hex, matches: null };
  return { hex, matches: claimed.toLowerCase() === hex || claimed === digest.toString("base64") };
}

/** Mark the submission failed with the reason. Only a still-waiting one. */
async function markFailed(p: WhatsAppFetchPayload, reason: string, attempts: number): Promise<void> {
  const note = `WhatsApp media fetch failed after ${attempts} attempt(s): ${reason}`.slice(0, 2000);
  await db.transaction(async (tx) => {
    const rows = await tx
      .update(videoSubmissions)
      .set({ status: "failed", processingLog: note })
      .where(and(eq(videoSubmissions.id, p.videoSubmissionId), eq(videoSubmissions.status, "received")))
      .returning({ id: videoSubmissions.id });
    if (rows.length > 0) await tx.update(files).set({ status: "failed" }).where(eq(files.id, p.fileId));
  });
  await audit("whatsapp.media.fetch_failed", p.videoSubmissionId, { msgId: p.msgId, attempts, error: reason.slice(0, 500) });
}

/**
 * The job handler. `attempt` is the queue's count for this run (1-based) and
 * `maxAttempts` its ceiling, so the handler knows when a failure is the last.
 */
export async function fetchWhatsAppMedia(
  p: WhatsAppFetchPayload,
  run: { attempt: number; maxAttempts: number },
  overrides: Partial<FetchDeps> = {},
): Promise<void> {
  const [row] = await db
    .select({ status: videoSubmissions.status, fileStatus: files.status })
    .from(videoSubmissions)
    .innerJoin(files, eq(files.id, videoSubmissions.fileId))
    .where(eq(videoSubmissions.id, p.videoSubmissionId))
    .limit(1);
  // Nothing waiting: the submission was removed, or an earlier attempt already
  // stored the bytes and queued the transcode (that step is one transaction).
  if (!row || row.status !== "received" || row.fileStatus === "stored") {
    log.info("whatsapp fetch: nothing to do", { msgId: p.msgId, status: row?.status ?? "missing" });
    return;
  }

  const deps: FetchDeps = {
    fetch: overrides.fetch ?? fetch,
    put: overrides.put ?? storagePut(),
    env: overrides.env ?? process.env,
  };

  try {
    const bytes = await download(p, deps);
    const sum = checksum(bytes, p.sha256);
    if (sum.matches === false) {
      log.warn("whatsapp media checksum differs from Meta's", { msgId: p.msgId });
      await audit("whatsapp.media.checksum_mismatch", p.videoSubmissionId, { msgId: p.msgId, claimed: p.sha256, computed: sum.hex });
    }

    await deps.put(p.bucket, p.objectKey, bytes, p.mimeType);

    // Bytes are stored: move the submission on and queue the transcode
    // together, so a crash here cannot leave a stored video with no job.
    const moved = await db.transaction(async (tx) => {
      const claimed = await tx
        .update(videoSubmissions)
        .set({ status: "queued" })
        .where(and(eq(videoSubmissions.id, p.videoSubmissionId), eq(videoSubmissions.status, "received")))
        .returning({ id: videoSubmissions.id });
      if (claimed.length === 0) return false;
      await tx
        .update(files)
        .set({ status: "stored", sizeBytes: bytes.byteLength, checksumSha256: sum.hex })
        .where(eq(files.id, p.fileId));
      // Same dedupe key as every other transcode producer (apps/web/src/lib/queue.ts).
      await enqueue(tx as never, {
        queue: "transcode",
        name: "transcode",
        payload: { videoSubmissionId: p.videoSubmissionId, fileId: p.fileId, bucket: p.bucket, objectKey: p.objectKey },
        dedupeKey: `submission:${p.videoSubmissionId}`,
      });
      return true;
    });
    if (!moved) return;

    await audit("whatsapp.media.fetched", p.videoSubmissionId, { msgId: p.msgId, bytes: bytes.byteLength, attempt: run.attempt });
    await audit("transcode.enqueued", p.videoSubmissionId, {
      source: "whatsapp",
      msgId: p.msgId,
      bucket: p.bucket,
      objectKey: p.objectKey,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.warn("whatsapp fetch attempt failed", { msgId: p.msgId, attempt: run.attempt, of: run.maxAttempts, reason: reason.slice(0, 300) });
    if (run.attempt >= run.maxAttempts) await markFailed(p, reason, run.attempt);
    // Rethrown so the queue records last_error and schedules the retry.
    throw err;
  }
}

