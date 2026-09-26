// POST /api/teach-back/[id]/review — marks a teach-back submission as reviewed.
//
// Caller: /rtt/teach-back queue (spec 066) renders a native <form method="POST"
// action="/api/teach-back/<id>/review"> button labelled "Mark reviewed". This
// endpoint closes that loop: validate role, set reviewed_at on the
// matching video_submissions row (scoped to context_type='teach_back' so a
// stray observation/mentor-meeting submission id can't be reviewed through
// this surface), and audit the action under SM-1.
//
// RESPONSE SHAPE IS CONTENT-NEGOTIATED, and that is the point of this note.
// The caller is a NATIVE <form method="POST">, which NAVIGATES to whatever this
// route returns. Answering JSON meant the reviewer was thrown off the queue
// onto a blank page reading {"ok":true}, with no way back except the browser's
// back button and no indication the review had been recorded -- on a surface
// whose whole purpose is working through a list. A browser form post (Accept
// includes text/html) now gets a 303 back to the queue; anything else, such as
// fetch() or a script, still gets the documented JSON.
//
// Method matrix:
//   POST (Accept: text/html)  → 303 → /rtt/teach-back?reviewed=<id>
//   POST (otherwise)          → 200 {ok:true}        success path
//   POST (no session)    → 401 {error:"unauthenticated"}
//   POST (wrong role)    → 403 {error:"forbidden"}
//   POST (malformed id)  → 400 {error:"invalid_id"}
//   POST (unknown id)    → 404 {error:"not_found"}  (zero rows updated)
//   POST (not playable)  → 409 {error:"not_playable"}; a browser post gets a
//                          303 back to /rtt/teach-back?id=<id>
//   GET / PUT / DELETE   → 405 {error:"method_not_allowed"}
//
// ONLY A PLAYABLE CLIP CAN BE REVIEWED. The UPDATE used to match any
// teach-back by id, so a clip still received/queued/transcoding (or failed)
// could be marked reviewed before anyone could have watched it. Nothing ever
// clears reviewed_at -- not the worker when the transcode finishes, not a DLQ
// retry -- so such a clip never entered "Pending review" once it became
// playable. "Reviewable" is the shared definition in lib/video/pending-review
// (status 'ready'); the queue page renders the button on the same test.
//
// SM-1 (audit on every mutation): writes action="teach_back.reviewed" with
// entityType="video_submission" and entityId=id. The audit_log.action column
// became varchar(64) in spec 021, so this free-form action string lands
// without an enum migration.
//
// SM-7 (no PII leak): the response body contains only {ok: true}; we don't
// echo the teacher name or any joined identity columns back through the API.

import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@gml/db";
import { videoSubmissions } from "@gml/db/schema";
import { auth } from "@/auth";
import { hasAnyRole } from "@gml/shared/auth/roles";
import { recordAudit } from "@/lib/audit";
import { isUuid } from "@/lib/authz";
import { publicUrl } from "@/lib/safe-redirect";

export const dynamic = "force-dynamic";

const ALLOWED_ROLES = ["super_admin", "programme_admin", "mentor", "observer"] as const;

/**
 * Did a browser navigation send this, rather than a script?
 *
 * A native form post asks for text/html; fetch() defaults to a bare or
 * wildcard Accept. Wildcard is treated as a script so the documented JSON
 * contract still holds for API callers.
 */
function wantsHtml(request: Request): boolean {
  return (request.headers.get("accept") ?? "").includes("text/html");
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  if (!hasAnyRole(session.user.role, [...ALLOWED_ROLES])) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { id } = await ctx.params;
  // A malformed id cannot name a row; compared against the uuid column it made
  // Postgres raise 22P02, which surfaced as a 500.
  if (!isUuid(id)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  // Scope the UPDATE to context_type='teach_back' so this endpoint can never
  // mutate an observation_cycle / mentor_meeting / classroom_session row, and
  // to status='ready' so it can never review a clip nobody can watch yet.
  const updated = await db
    .update(videoSubmissions)
    // Records the review WITHOUT touching `status`. This previously set
    // status='reviewed', and because the player only builds a source when
    // status='ready', pressing "Mark reviewed" permanently destroyed playback
    // with no route back through the UI. See migration 0022.
    .set({ reviewedAt: new Date(), reviewedByUserId: session.user.id })
    .where(
      and(
        eq(videoSubmissions.id, id),
        eq(videoSubmissions.contextType, "teach_back"),
        eq(videoSubmissions.status, "ready"),
      ),
    )
    .returning({ id: videoSubmissions.id });

  if (updated.length === 0) {
    // Zero rows: either no such teach-back, or one that is not playable. Only
    // the failure path pays for telling them apart.
    const [exists] = await db
      .select({ id: videoSubmissions.id })
      .from(videoSubmissions)
      .where(and(eq(videoSubmissions.id, id), eq(videoSubmissions.contextType, "teach_back")))
      .limit(1);
    if (!exists) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    if (wantsHtml(request)) {
      // Back to the clip, whose pane says the review opens once it is ready.
      return NextResponse.redirect(await publicUrl(`/rtt/teach-back?id=${encodeURIComponent(id)}`), {
        status: 303,
      });
    }
    return NextResponse.json({ error: "not_playable" }, { status: 409 });
  }

  void recordAudit({
    action: "teach_back.reviewed",
    entityType: "video_submission",
    entityId: id,
  });

  // 303 specifically: it turns the browser's follow-up into a GET, so a
  // refresh on the queue does not re-submit the review.
  if (wantsHtml(request)) {
    return NextResponse.redirect(
      // The public origin: request.url is Next's bind address behind Caddy.
      await publicUrl(`/rtt/teach-back?reviewed=${encodeURIComponent(id)}`),
      { status: 303 },
    );
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}

export async function GET() {
  return NextResponse.json({ error: "method_not_allowed" }, { status: 405 });
}
