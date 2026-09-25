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
  type BucketName,
} from "@gml/shared/storage/buckets";
import { rewritePlaylist, extractSegments, segmentTtlSeconds } from "@gml/shared/storage/playlist";

export { BUCKETS, hlsPrefix, hlsPlaylistKey, segmentTtlSeconds };
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

/** How long a signed poster URL lives: longer than anyone keeps a page open. */
export const POSTER_TTL_SECONDS = 3600;

/**
 * Signed URLs for poster frames, keyed by poster key, in ONE round trip.
 *
 * The worker has always produced a poster per video (posters/<id>.jpg, in a
 * PRIVATE bucket, so it needs a signed URL) and recorded poster_key -- and
 * nothing in the web app read either, so every library card was a grey box and
 * the player opened black. Callers pass only keys of rows they have already
 * authorised (the visibility-scoped list, or a row assertCanAccessVideo
 * returned); this makes no authorization decision.
 *
 * Never throws. signObjects throws on a Storage error, and a poster is
 * decoration: an outage must degrade to the placeholder, not fail /videos.
 */
export async function signPosterUrls(
  keys: Array<string | null | undefined>,
  ttlSeconds = POSTER_TTL_SECONDS,
): Promise<Map<string, string>> {
  const unique = [...new Set(keys.filter((k): k is string => Boolean(k)))];
  if (unique.length === 0) return new Map();
  try {
    const signed = await storage.signMany(BUCKETS.posters, unique, ttlSeconds);
    return new Map([...signed].map(([key, s]) => [key, s.url]));
  } catch {
    return new Map();
  }
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
 */
export async function buildSignedPlaylist(
  videoSubmissionId: string,
  playlistKey: string,
  durationSec: number | null,
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
