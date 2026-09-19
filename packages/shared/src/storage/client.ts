// Supabase Storage operations, shared by apps/web and apps/worker.
//
// Takes a SupabaseClient rather than constructing one, so the caller decides
// which identity it runs as. Everything here runs as the SERVICE ROLE: signing,
// uploading transcoder output and reading source video are all server-side acts
// performed after the application has already decided the caller may do them.
// Nothing in this module makes an authorization decision, and nothing in it
// should ever be reachable from a browser.
//
// WHAT THIS REPLACED. `lib/video/minio.ts` wrapped @aws-sdk/client-s3 against a
// MinIO container, with a second, separately-configured S3Client duplicated
// inside the worker. MinIO withdrew their public Docker images, so that stack
// could not start on any machine (docs/verification.md B9); the duplication is
// why the worker and the web app disagreed about which bucket HLS output lived
// in.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { BucketName } from "./buckets.js";

/** A signed URL and the moment it stops working. */
export type SignedObject = { key: string; url: string; expiresAt: Date };

/**
 * Sign many object keys in ONE round trip.
 *
 * This is the call that makes server-side playlist rewriting cheap. Measured
 * against the live project: 200 keys signed in 43ms, single HTTP request. The
 * plan originally reached for SigV4 presigning to avoid a per-segment network
 * hop -- that concern was real but the premise was wrong, because the batch API
 * signs the whole playlist at once. SigV4 would also have required Storage S3
 * access keys, an extra credential to provision and rotate.
 *
 * IMPORTANT: Supabase only signs objects that EXIST. A key with no object gets
 * an entry with `error` set and no URL. That is useful -- it means a typo
 * cannot produce a plausible-looking dead URL -- but it means the caller must
 * pass exactly the keys the transcoder wrote, never a computed range.
 */
export async function signObjects(
  supabase: SupabaseClient,
  bucket: BucketName,
  keys: string[],
  ttlSeconds: number,
): Promise<Map<string, SignedObject>> {
  const out = new Map<string, SignedObject>();
  if (keys.length === 0) return out;

  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  const { data, error } = await supabase.storage.from(bucket).createSignedUrls(keys, ttlSeconds);
  if (error) throw new Error(`sign ${bucket}: ${error.message}`);

  for (const row of data ?? []) {
    // `path` is echoed back for every entry; `signedUrl` only for those that
    // resolved. Entries with an error are omitted rather than returned with a
    // null URL, so a caller cannot accidentally emit `undefined` into a playlist.
    if (!row.signedUrl || !row.path) continue;
    out.set(row.path, { key: row.path, url: row.signedUrl, expiresAt });
  }
  return out;
}

/** Sign a single object. Returns null when the object does not exist. */
export async function signObject(
  supabase: SupabaseClient,
  bucket: BucketName,
  key: string,
  ttlSeconds: number,
): Promise<SignedObject | null> {
  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(key, ttlSeconds);
  if (error || !data?.signedUrl) return null;
  return { key, url: data.signedUrl, expiresAt: new Date(Date.now() + ttlSeconds * 1000) };
}

/**
 * Upload bytes, replacing anything already at the key.
 *
 * Accepts Uint8Array or Blob rather than naming Buffer: this package carries no
 * @types/node, and a Node Buffer IS a Uint8Array, so nothing is excluded.
 *
 * `upsert: true` is deliberate and load-bearing for the transcoder. A retry
 * re-uploads the same deterministic keys, and without upsert the second attempt
 * fails on a duplicate object -- which is precisely the shape of bug that made
 * transcode attempts 2 and 3 impossible on the old pipeline.
 */
export async function putObject(
  supabase: SupabaseClient,
  bucket: BucketName,
  key: string,
  body: Uint8Array | Blob,
  contentType: string,
): Promise<void> {
  const { error } = await supabase.storage.from(bucket).upload(key, body, {
    contentType,
    upsert: true,
  });
  if (error) throw new Error(`upload ${bucket}/${key}: ${error.message}`);
}

/** Fetch an object's bytes. */
export async function getObject(
  supabase: SupabaseClient,
  bucket: BucketName,
  key: string,
): Promise<Uint8Array> {
  const { data, error } = await supabase.storage.from(bucket).download(key);
  if (error || !data) throw new Error(`download ${bucket}/${key}: ${error?.message ?? "no data"}`);
  return new Uint8Array(await data.arrayBuffer());
}

/**
 * Stream an object. ACTUALLY stream it.
 *
 * ── WHY NOT supabase.storage.download() ─────────────────────────────────────
 *
 * That is what this function used to call, and it defeats the entire purpose:
 * `download()` resolves to a **Blob**, which means the whole object has
 * already been read into memory before there is anything to call `.stream()`
 * on. The returned stream is a stream over a fully-materialised buffer, so the
 * peak stays the full object size.
 *
 * The docstring said the opposite. The transcoder's own comment says "Source
 * to disk, streamed" (apps/worker/src/transcode.ts) while piping from that
 * Blob, so a 2 GB upload -- MAX_UPLOAD_BYTES is exactly that -- meant 2 GB of
 * worker heap before one byte reached the scratch disk. Node's default old-space
 * ceiling is well under that on a 2 vCPU box, so the worker would be OOM-killed
 * by the container rather than failing the job cleanly, and the job would be
 * retried by the lease reaper and killed again.
 *
 * A signed URL plus fetch() gives a genuine network stream: undici exposes the
 * response body as a ReadableStream that yields chunks as they arrive, so the
 * peak is one chunk rather than one file.
 *
 * The signed URL is short-lived and never leaves this process -- it exists only
 * to turn a private object into something fetch() can open.
 */
export async function getObjectStream(
  supabase: SupabaseClient,
  bucket: BucketName,
  key: string,
): Promise<{ body: ReadableStream<Uint8Array>; contentType: string; size: number }> {
  // Long enough for a large transfer on a slow link, short enough that a URL
  // captured from a log is not useful for long.
  const { data: signed, error: signError } = await supabase.storage
    .from(bucket)
    .createSignedUrl(key, 3600);
  if (signError || !signed?.signedUrl) {
    throw new Error(`sign ${bucket}/${key}: ${signError?.message ?? "no url"}`);
  }

  const res = await fetch(signed.signedUrl);
  if (!res.ok || !res.body) {
    throw new Error(`download ${bucket}/${key}: HTTP ${res.status}`);
  }

  return {
    body: res.body as ReadableStream<Uint8Array>,
    contentType: res.headers.get("content-type") || "application/octet-stream",
    // Absent on a chunked response. Callers treat 0 as "unknown" -- the
    // transcoder stats the file on disk afterwards rather than trusting this.
    size: Number(res.headers.get("content-length") ?? 0),
  };
}

/**
 * Does an object exist, and how big is it?
 *
 * Used by the upload-completion route to check the client's claim against what
 * Storage actually holds. Without this a caller can POST "I finished" having
 * uploaded nothing, and the submission enters the pipeline pointing at an empty
 * object.
 *
 * Implemented with a prefix `list` rather than a HEAD because Storage's list
 * returns metadata without transferring the object, and a HEAD on a private
 * object needs a signed URL we would have to mint first.
 */
export async function statObject(
  supabase: SupabaseClient,
  bucket: BucketName,
  key: string,
): Promise<{ size: number; contentType: string | null } | null> {
  const lastSlash = key.lastIndexOf("/");
  const prefix = lastSlash === -1 ? "" : key.slice(0, lastSlash);
  const name = lastSlash === -1 ? key : key.slice(lastSlash + 1);

  const { data, error } = await supabase.storage.from(bucket).list(prefix, {
    limit: 1,
    search: name,
  });
  if (error || !data) return null;
  const hit = data.find((o) => o.name === name);
  if (!hit) return null;

  const meta = hit.metadata as { size?: number; mimetype?: string } | null;
  return { size: meta?.size ?? 0, contentType: meta?.mimetype ?? null };
}

/** Every object directly under a prefix. Used to find the segments to sign. */
export async function listObjects(
  supabase: SupabaseClient,
  bucket: BucketName,
  prefix: string,
): Promise<{ name: string; size: number }[]> {
  const out: { name: string; size: number }[] = [];
  const PAGE = 100;
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await supabase.storage.from(bucket).list(prefix, {
      limit: PAGE,
      offset,
      sortBy: { column: "name", order: "asc" },
    });
    if (error) throw new Error(`list ${bucket}/${prefix}: ${error.message}`);
    const page = data ?? [];
    for (const o of page) {
      // Storage returns a synthetic entry with a null id for nested folders.
      if (!o.id) continue;
      out.push({ name: o.name, size: (o.metadata as { size?: number } | null)?.size ?? 0 });
    }
    if (page.length < PAGE) break;
  }
  return out;
}

/** Remove objects. Missing keys are not an error. */
export async function removeObjects(
  supabase: SupabaseClient,
  bucket: BucketName,
  keys: string[],
): Promise<void> {
  if (keys.length === 0) return;
  const { error } = await supabase.storage.from(bucket).remove(keys);
  if (error) throw new Error(`remove ${bucket}: ${error.message}`);
}
