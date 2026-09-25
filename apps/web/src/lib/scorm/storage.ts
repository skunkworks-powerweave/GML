// Storage for SCORM package files: write during an upload, read (streamed,
// with a forwarded byte range) for the content route.
//
// Service role, and NO authorization decision here: the content route has
// already asked lib/scorm/store.ts whether this viewer may launch the
// package, and the upload route whether this user may upload one.

import "server-only";
import { supabaseAdmin } from "@/lib/supabase/server";
import { BUCKETS } from "@gml/shared/storage/buckets";
import { putObject, removeObjects } from "@gml/shared/storage/client";

const BUCKET = BUCKETS.scormPackages;

/** Every object is stored as opaque bytes; the served type is the allowlist's (lib/scorm/files.ts). */
export function putScormObject(key: string, body: Uint8Array): Promise<void> {
  return putObject(supabaseAdmin(), BUCKET, key, body, "application/octet-stream");
}

export function removeScormObjects(keys: string[]): Promise<void> {
  return removeObjects(supabaseAdmin(), BUCKET, keys);
}

/** A single byte range, "bytes=a-b" / "bytes=a-" / "bytes=-n"; anything else is not forwarded. */
export function singleRange(header: string | null): string | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  return m && (m[1] || m[2]) ? `bytes=${m[1]}-${m[2]}` : null;
}

/**
 * Open one object as a genuine stream (a short-lived signed URL fetched here,
 * never handed out -- see getObjectStream in @gml/shared/storage/client for
 * why download() is not used). The upstream Response is returned as-is so the
 * caller can relay 200 / 206 / 416 and their length headers; null when the
 * object cannot be produced.
 */
export async function openScormObject(key: string, range: string | null): Promise<Response | null> {
  try {
    const { data, error } = await supabaseAdmin().storage.from(BUCKET).createSignedUrl(key, 60);
    if (error || !data?.signedUrl) return null;
    const res = await fetch(data.signedUrl, { headers: range ? { range } : {} });
    if (!res.body || (res.status !== 200 && res.status !== 206 && res.status !== 416)) {
      await res.body?.cancel().catch(() => undefined);
      return null;
    }
    return res;
  } catch {
    return null;
  }
}
