// Storage access for apps/web.
//
// Thin binding of the shared operations (packages/shared/src/storage) to a
// service-role Supabase client. Everything here runs server-side and makes NO
// authorization decision -- callers must have already established that this
// user may see this object, via lib/authz.ts.

import "server-only";
import { supabaseAdmin } from "@/lib/supabase/server";
import {
  signObject,
  signObjects,
  putObject,
  getObjectStream,
  statObject,
  listObjects,
  removeObjects,
  type SignedObject,
} from "@gml/shared/storage/client";
import {
  BUCKETS,
  hlsPrefix,
  hlsPlaylistKey,
  hlsMasterPlaylistKey,
  type BucketName,
} from "@gml/shared/storage/buckets";
import { rewritePlaylist, extractSegments, segmentTtlSeconds } from "@gml/shared/storage/playlist";

export { BUCKETS, hlsPrefix, hlsPlaylistKey, hlsMasterPlaylistKey, segmentTtlSeconds };
export type { BucketName, SignedObject };

export const storage = {
  sign: (bucket: BucketName, key: string, ttl: number) =>
    signObject(supabaseAdmin(), bucket, key, ttl),
  signMany: (bucket: BucketName, keys: string[], ttl: number) =>
    signObjects(supabaseAdmin(), bucket, keys, ttl),
  put: (bucket: BucketName, key: string, body: Uint8Array | Blob, contentType: string) =>
    putObject(supabaseAdmin(), bucket, key, body, contentType),
  stream: (bucket: BucketName, key: string) => getObjectStream(supabaseAdmin(), bucket, key),
  stat: (bucket: BucketName, key: string) => statObject(supabaseAdmin(), bucket, key),
  list: (bucket: BucketName, prefix: string) => listObjects(supabaseAdmin(), bucket, prefix),
  remove: (bucket: BucketName, keys: string[]) => removeObjects(supabaseAdmin(), bucket, keys),
};

/** A master playlist lists variant streams; a media playlist lists segments. */
export function isMasterPlaylist(playlist: string): boolean {
  return /^#EXT-X-STREAM-INF:/m.test(playlist);
}

/**
 * Fetch a submission's media playlist and return it with every segment line
 * replaced by an absolute, individually-signed Storage URL.
 *
 * This is the whole playback mechanism. The player fetches this text from the
 * application (which is where the authorization check happens); every byte of
 * actual video is then pulled by the browser directly from Supabase's CDN.
 *
 * Returns null when the playlist object is missing -- a submission marked ready
 * whose output is not there is a real state, and the caller renders "not
 * available" rather than a player pointed at nothing.
 *
 * A MASTER playlist (the rendition ladder) lists media playlists, not
 * segments, and is not signed at all: each variant line becomes whatever
 * `variantUrl` returns -- the app URL that serves that rendition -- so its
 * segments are signed on the request that needs them, after the same
 * authorization check. Signed as if they were segments, the variant lines
 * became bare Storage URLs whose own relative segment lines then resolved
 * against Storage with no token, and a ladder would never have played.
 */
export async function buildSignedPlaylist(
  videoSubmissionId: string,
  playlistKey: string,
  durationSec: number | null,
  opts: { variantUrl?: (variantName: string) => string } = {},
): Promise<{ body: string; expiresAt: Date } | null> {
  const bucket = BUCKETS.videosHls;
  const client = supabaseAdmin();

  let playlistText: string;
  try {
    const { data, error } = await client.storage.from(bucket).download(playlistKey);
    if (error || !data) return null;
    playlistText = await data.text();
  } catch {
    return null;
  }

  const prefix = hlsPrefix(videoSubmissionId);
  const ttl = segmentTtlSeconds(durationSec);

  if (isMasterPlaylist(playlistText)) {
    const body = rewritePlaylist(playlistText, (name) => opts.variantUrl?.(name) ?? null);
    return { body, expiresAt: new Date(Date.now() + ttl * 1000) };
  }

  // Sign exactly the names the playlist references. Supabase will not sign a
  // key with no object behind it, so a computed range would silently drop the
  // segments whose numbering we guessed wrong -- the playlist is the only
  // authoritative list of what ffmpeg actually produced.
  const segments = extractSegments(playlistText);
  const keys = segments
    .filter((s) => !/^https?:\/\//i.test(s.name))
    .map((s) => `${prefix}/${s.name}`);

  const signed = await storage.signMany(bucket, keys, ttl);

  const body = rewritePlaylist(playlistText, (name) => signed.get(`${prefix}/${name}`)?.url ?? null);
  return { body, expiresAt: new Date(Date.now() + ttl * 1000) };
}
