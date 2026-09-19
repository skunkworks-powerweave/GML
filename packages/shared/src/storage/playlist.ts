// HLS media-playlist rewriting.
//
// THE BUG THIS EXISTS TO FIX. ffmpeg writes a playlist whose segment lines are
// bare filenames:
//
//     #EXTINF:6.000000,
//     seg_000.ts
//
// The player loads that playlist from `/api/media/<token>`, so the browser
// resolves `seg_000.ts` RELATIVE TO THAT URL -- producing `/api/media/seg_000.ts`,
// which is not a token, fails signature verification, and 403s. The master
// playlist loaded, the first segment did not, and no video in this product has
// ever played.
//
// A custom hls.js loader is the usual fix and it is the wrong one here: Safari
// and iOS play HLS natively, and a native player never consults a JS loader.
// Field mentors are a primary iOS audience. Rewriting server-side is the only
// approach that works for both.
//
// THE SECONDARY BENEFIT IS LARGER THAN THE FIX. Because each segment line
// becomes an absolute, individually-signed Storage URL, segments stream from
// Supabase's CDN straight to the browser. They never transit the application
// server. For a 20-minute video that is ~200 requests and hundreds of megabytes
// per view that EC2 does not proxy -- which matters for the Ladakh edge, and it
// is the single biggest factor in how small the instance can be.
//
// This module is pure string handling with no dependencies so it can be unit
// tested directly and shared by both packages.

/** A playlist line that names a media segment, with its index in the file. */
export type SegmentRef = { line: number; name: string };

/**
 * Every segment referenced by a media playlist, in order.
 *
 * A line is a segment URI if it is non-empty and does not start with `#`.
 * Lines beginning with `#` are tags; blank lines are ignored. Absolute URLs are
 * returned as-is by `extract` and left untouched by `rewrite` -- a playlist that
 * already carries absolute URLs has been rewritten once already, and signing a
 * signed URL would corrupt it.
 */
export function extractSegments(playlist: string): SegmentRef[] {
  const out: SegmentRef[] = [];
  const lines = playlist.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]!.trim();
    if (raw.length === 0 || raw.startsWith("#")) continue;
    out.push({ line: i, name: raw });
  }
  return out;
}

/** True when a playlist line is already an absolute URL. */
function isAbsolute(name: string): boolean {
  return /^https?:\/\//i.test(name);
}

/**
 * Replace each relative segment URI with the URL supplied by `resolve`.
 *
 * `resolve` receives the segment name exactly as it appears in the playlist and
 * returns the absolute URL to substitute, or null to leave the line untouched.
 * Leaving a line untouched is the right behaviour for a segment the signer
 * could not sign: the rest of the video still plays, and the gap is one
 * six-second segment rather than a dead player.
 *
 * Line endings are preserved as found. A playlist produced on one platform and
 * served from another must not have its CRLFs silently rewritten -- some
 * players are strict about the byte length implied by `#EXT-X-BYTERANGE`.
 */
export function rewritePlaylist(
  playlist: string,
  resolve: (segmentName: string) => string | null,
): string {
  const lines = playlist.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const original = lines[i]!;
    const trimmed = original.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#") || isAbsolute(trimmed)) continue;
    const replacement = resolve(trimmed);
    if (replacement === null) continue;
    // Preserve a trailing \r so CRLF playlists stay CRLF.
    lines[i] = original.endsWith("\r") ? `${replacement}\r` : replacement;
  }
  return lines.join("\n");
}

/**
 * Token lifetime for a playlist's segment URLs, derived from video duration.
 *
 *     min( max(duration * 3 + 900, 1800), 21600 )   seconds
 *
 * A fixed TTL forces a choice between two bad outcomes: short enough to bound a
 * leaked URL means a viewer who pauses to take notes returns to a dead player,
 * and long enough to watch comfortably means a URL copied out of devtools works
 * for hours.
 *
 * Scaling with duration dissolves it. The x3 allows for pausing, rewinding and
 * rewatching; the +900 floor keeps a 30-second clip usable; the 30-minute
 * minimum covers the common case of stepping away mid-video; the 6-hour ceiling
 * bounds the damage from a leaked URL regardless of how long the video is.
 *
 * `durationSec` is frequently unknown -- nothing populated that column until
 * the transcoder started running ffprobe -- so an unknown duration gets the
 * 30-minute floor rather than an error.
 */
export function segmentTtlSeconds(durationSec: number | null | undefined): number {
  const d = typeof durationSec === "number" && Number.isFinite(durationSec) && durationSec > 0
    ? durationSec
    : 0;
  return Math.min(Math.max(Math.round(d * 3 + 900), 1800), 21600);
}
