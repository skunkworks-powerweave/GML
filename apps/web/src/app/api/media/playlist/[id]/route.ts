// HLS media playlist for one video submission.
//
// The player requests this URL; it returns an .m3u8 whose every segment line is
// an absolute, individually-signed Supabase Storage URL. The browser then pulls
// the segments straight from Supabase's CDN -- they never transit this server.
//
// AUTHORIZATION IS A REAL CHECK, NOT A TOKEN. This replaces `/api/media/[token]`,
// which verified a hand-rolled HMAC over
// `bucket:objectKey:userId:ipBindKey:exp`. That design was a liability in four
// distinct ways, all of which disappear here rather than getting fixed:
//
//   * It bound the token to a /24 (v4) or /64 (v6) IP prefix. Behind carrier-
//     grade NAT that is not identity -- thousands of unrelated subscribers share
//     the prefix -- while for a teacher whose phone hops between Jio and Airtel
//     mid-lesson it is a hard failure. It was hostile to the actual users and
//     useless against the actual threat.
//   * The secret fell back to AUTH_SECRET when MEDIA_SIGN_SECRET was unset,
//     which it always was. The shipped `.env` carried a `dev-only-...` value, so
//     media URLs were signed with a published placeholder.
//   * The payload was split on ":" and objectKey read as field[1], so any key
//     containing a colon decoded to the wrong object.
//   * It answered "does this token verify", never "may this person watch this
//     video". A leaked token was a capability; here, access is re-decided from
//     the session on every request, so revoking a role revokes playback.
//
// Segment URLs remain bearer capabilities -- that is what a signed URL is -- but
// they are minted only after the check below passes, scoped to one object, and
// expire on a duration-derived schedule (see segmentTtlSeconds).

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { actorFrom, assertCanAccessVideo, videoGateRequired } from "@/lib/authz";
import { buildSignedPlaylist, hlsMasterPlaylistKey, hlsPrefix } from "@/lib/video/storage";

export const dynamic = "force-dynamic";

/** A rendition's playlist name as the transcoder writes it (apps/worker/src/encode.ts). */
const VARIANT_NAME = /^v\d{1,2}\.m3u8$/;

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const session = await auth();
  const actor = actorFrom(session);
  if (!actor) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  // Throws notFound() when this actor may not see this video. 404 rather than
  // 403 on purpose: a 403 on /api/media/playlist/<uuid> confirms the uuid names
  // a real video, which is exactly the enumeration a guessed-uuid attack wants.
  const video = await assertCanAccessVideo(actor, id);

  // Section gate, before anything is signed: without it a user who had not
  // unlocked mentorship (or whose grant a password rotation had just deleted)
  // was handed signed segment URLs for mentorship recordings. JSON rather than
  // a redirect -- the player fetches this, it does not navigate to it -- and
  // only after ownership passed, so it reveals nothing to a stranger.
  const gate = await videoGateRequired(actor, video);
  if (gate) {
    return NextResponse.json({ error: "gate_required", gate }, { status: 403 });
  }

  if (video.status !== "ready" || !video.hlsMasterKey) {
    return NextResponse.json({ error: "not_ready", status: video.status }, { status: 409 });
  }

  // THE RENDITION LADDER. A video's master playlist lists its renditions, and
  // each comes back through this same route as ?variant=<its playlist name>,
  // authorised exactly as the master was. The name must be one the transcoder
  // writes -- never a path -- and the video must HAVE a master: one transcoded
  // before the ladder points at its single index.m3u8 and has no variants.
  const variant = new URL(req.url).searchParams.get("variant");
  let playlistKey = video.hlsMasterKey;
  if (variant !== null) {
    if (!VARIANT_NAME.test(variant) || video.hlsMasterKey !== hlsMasterPlaylistKey(id)) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    playlistKey = `${hlsPrefix(id)}/${variant}`;
  }

  const playlist = await buildSignedPlaylist(id, playlistKey, video.durationSec ?? null, {
    variantUrl: (name) => `/api/media/playlist/${id}?variant=${encodeURIComponent(name)}`,
  });
  if (!playlist) {
    // Marked ready, output missing. Real state, worth distinguishing from a
    // permission failure so an operator reading logs can tell them apart.
    return NextResponse.json({ error: "playlist_missing" }, { status: 502 });
  }

  return new NextResponse(playlist.body, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.apple.mpegurl",
      // private: the response embeds URLs minted for this viewer. A shared
      // cache holding it would hand another user a working set of segment URLs.
      //
      // The max-age is deliberately far shorter than the segment TTL: when the
      // player re-fetches the playlist after a network error it must get freshly
      // signed URLs, not a cached copy of the ones that just expired.
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
      // Advisory, for the player's refresh scheduling.
      "X-Media-Expires-At": playlist.expiresAt.toISOString(),
    },
  });
}
