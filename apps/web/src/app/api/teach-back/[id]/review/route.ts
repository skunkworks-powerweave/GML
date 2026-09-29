// POST /api/teach-back/[id]/review — approve a teach-back, or request changes
// to it with written feedback.
//
// Caller: the /rtt/teach-back queue (spec 066) renders a native <form
// method="POST" action="/api/teach-back/<id>/review"> with a feedback box and
// two buttons, Approve (decision=approved) and Request changes
// (decision=changes_requested). This endpoint validates the caller and hands
// the decision to the approvals queue (lib/rtt/teach-back.ts reviewTeachBack
// -> lib/approvals decideApproval), whose teach-back handler marks the video
// reviewed (reviewed_at / reviewed_by_user_id) and keeps the feedback for the
// teacher to read on her subject page. It used to set reviewed_at itself and
// record nothing else: no decision, and no word to the teacher.
//
// A teach-back with no approval request (sent before requests existed, by
// WhatsApp, or finished by the upload reconciler) gets one created and
// decided in the same step.
//
// RESPONSE SHAPE IS CONTENT-NEGOTIATED. The caller is a NATIVE <form
// method="POST">, which NAVIGATES to whatever this route returns: a browser
// post (Accept includes text/html) gets a 303 back to the queue; anything
// else, such as fetch() or a script, gets JSON.
//
// Method matrix:
//   POST (Accept: text/html)  → 303 → /rtt/teach-back?reviewed=<id>
//   POST (otherwise)          → 200 {ok:true}        success path
//   POST (no session)         → 401 {error:"unauthenticated"}
//   POST (wrong role)         → 403 {error:"forbidden"}
//   POST (malformed id)       → 400 {error:"invalid_id"}
//   POST (unknown id)         → 404 {error:"not_found"}
//   POST (not playable)       → 409 {error:"not_playable"}
//   POST (not her mentee)     → 403 {error:"forbidden"}   a mentor decides her own mentees' only
//   POST (no/odd decision)    → 400 {error:"invalid_decision"}
//   POST (changes, no text)   → 422 {error:"feedback_required"}
//   POST (decided already)    → 409 {error:"already_reviewed"}
//   Every refusal to a browser post is a 303 back to /rtt/teach-back?id=<id>
//   with &error=<code>, where the review pane says what went wrong.
//   GET / PUT / DELETE        → 405 {error:"method_not_allowed"}
//
// ONLY A PLAYABLE CLIP CAN BE REVIEWED (status 'ready', the shared definition
// in lib/video/pending-review): nothing ever clears reviewed_at, so a clip
// reviewed before anyone could watch it would never be owed a review once it
// played. Review never touches `status` (migration 0022): the player renders
// only a 'ready' clip.
//
// SM-1 (audit on every mutation): writes action="teach_back.reviewed" with
// entityType="video_submission" and entityId=id, and the queue writes its own
// approval.decided.
//
// SM-7 (no PII leak): the response body contains only {ok: true} or an error
// code; no teacher name or joined identity column is echoed back.

import { NextResponse } from "next/server";
import { db } from "@gml/db";
import { auth } from "@/auth";
import { hasAnyRole } from "@gml/shared/auth/roles";
import { recordAudit } from "@/lib/audit";
import { isUuid } from "@/lib/authz";
import { reviewTeachBack, type ReviewError } from "@/lib/rtt/teach-back";
import { publicUrl } from "@/lib/safe-redirect";

export const dynamic = "force-dynamic";

const ALLOWED_ROLES = ["super_admin", "programme_admin", "mentor", "observer"] as const;

/** Each refusal's JSON answer. */
const REFUSAL: Record<ReviewError, { error: string; status: number }> = {
  invalid_decision: { error: "invalid_decision", status: 400 },
  not_found: { error: "not_found", status: 404 },
  not_playable: { error: "not_playable", status: 409 },
  not_allowed: { error: "forbidden", status: 403 },
  feedback_required: { error: "feedback_required", status: 422 },
  already_reviewed: { error: "already_reviewed", status: 409 },
};

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

/** The decision and feedback, from a form post or a JSON body. */
async function readReview(request: Request): Promise<{ decision: unknown; feedback: string | null }> {
  try {
    if ((request.headers.get("content-type") ?? "").includes("application/json")) {
      const body = (await request.json()) as { decision?: unknown; feedback?: unknown };
      return { decision: body?.decision, feedback: typeof body?.feedback === "string" ? body.feedback : null };
    }
    const form = await request.formData();
    const feedback = form.get("feedback");
    return { decision: form.get("decision"), feedback: typeof feedback === "string" ? feedback : null };
  } catch {
    // No body, or not one we read: no decision.
    return { decision: null, feedback: null };
  }
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

  const { decision, feedback } = await readReview(request);
  const actor = { id: session.user.id, role: session.user.role };
  const result = await reviewTeachBack(db, { videoId: id, decision, feedback, actor });

  if (!result.ok) {
    const refusal = REFUSAL[result.error];
    if (wantsHtml(request) && result.error !== "not_found") {
      // Back to the clip, whose pane says why.
      const q = new URLSearchParams({ id });
      if (result.error !== "not_playable") q.set("error", result.error);
      return NextResponse.redirect(await publicUrl(`/rtt/teach-back?${q.toString()}#review`), { status: 303 });
    }
    return NextResponse.json({ error: refusal.error }, { status: refusal.status });
  }

  void recordAudit({
    action: "teach_back.reviewed",
    entityType: "video_submission",
    entityId: id,
    userId: actor.id,
    metadata: { approvalId: result.approvalId, decision: result.decision, created: result.created },
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

