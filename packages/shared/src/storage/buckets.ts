// Bucket names and the HLS key layout, in ONE place, shared by apps/web and
// apps/worker.
//
// WHY THIS IS SHARED RATHER THAN DUPLICATED. The previous arrangement had a
// `BUCKETS` constant in apps/web that the two actual HLS consumers both ignored
// in favour of hardcoded strings, a worker that read an env var
// (`MINIO_BUCKET_HLS`) which was set in no compose service and no .env file, and
// a PDF viewer pointing at a bucket named `gml-resources` that nothing ever
// created. Three different answers to "where do the files live", two of them
// wrong, and the resulting 502s were indistinguishable from a storage outage.
//
// This module is deliberately dependency-free so both packages can import it.

export const BUCKETS = {
  /** Source video as uploaded, from the browser or from WhatsApp. */
  videosOriginal: "videos-original",
  /** Transcoder output: one media playlist plus its segments. */
  videosHls: "videos-hls",
  /** Poster frames extracted during transcode. */
  posters: "posters",
  /** Reading material served through the media proxy. */
  pdfs: "pdfs",
} as const;

export type BucketName = (typeof BUCKETS)[keyof typeof BUCKETS];

const BUCKET_VALUES: ReadonlySet<string> = new Set(Object.values(BUCKETS));

/** Narrowing guard — use before trusting a bucket name decoded from a request. */
export function isBucketName(value: unknown): value is BucketName {
  return typeof value === "string" && BUCKET_VALUES.has(value);
}

// ── HLS key layout ────────────────────────────────────────────────────────────
//
// The playlist is named `index.m3u8`, not `master.m3u8`. With a single ffmpeg
// output and `-hls_playlist_type vod` there is exactly one rendition, so what
// ffmpeg writes is a MEDIA playlist -- calling it a master playlist described a
// variant-stream file that has never existed here and sent readers looking for
// a level of indirection that is not there.
//
// `video_submissions.hls_master_key` keeps its column name: renaming it would
// be a migration across every read site for no behavioural gain, and the column
// comment records the discrepancy.

/** Directory that holds one submission's playlist and segments. */
export function hlsPrefix(videoSubmissionId: string): string {
  return `hls/${videoSubmissionId}`;
}

/** Full key of the media playlist for a submission. */
export function hlsPlaylistKey(videoSubmissionId: string): string {
  return `${hlsPrefix(videoSubmissionId)}/index.m3u8`;
}

/** Poster frame key for a submission. */
export function posterKey(videoSubmissionId: string): string {
  return `${videoSubmissionId}.jpg`;
}

/**
 * Object key for a browser upload.
 *
 * The leading segment MUST be the uploader's uuid. This is not a convention --
 * the RLS policy on storage.objects checks
 * `(storage.foldername(name))[1] = auth.uid()::text`, so a key built any other
 * way is refused by the database. Verified against the live project: writing
 * under another user's prefix returns 403.
 */
export function uploadKey(userId: string, uploadId: string, extension: string): string {
  const ext = extension.replace(/[^a-z0-9]/gi, "").slice(0, 8).toLowerCase() || "bin";
  return `${userId}/${uploadId}.${ext}`;
}

/**
 * The uploader's uuid, read back out of an object key.
 *
 * Returns null when the key is not in owner-prefixed form, which the caller must
 * treat as "not attributable" rather than "mine".
 */
export function ownerFromUploadKey(key: string): string | null {
  const first = key.split("/")[0];
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(first ?? "")
    ? first
    : null;
}
