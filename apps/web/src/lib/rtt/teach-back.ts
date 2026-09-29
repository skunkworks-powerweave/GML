import "server-only";

// Teach-backs through the approvals queue (lib/approvals, handler
// lib/approvals/handlers/teach-back.ts).
//
// ── WHY ──────────────────────────────────────────────────────────────────────
//
// Review was one button, "Mark reviewed", which set reviewed_at and told the
// teacher nothing: no decision, no feedback. The design (docs/superpowers/
// specs/2026-09-28-teaching-records-design.md) makes teach-back review Approve
// or Request changes, with written feedback she sees on her subject page, and
// puts it in the one approvals queue with everything else that needs a
// decision.
//
//   submitTeachBackUpload  the upload is recorded -> a pending request, and
//                          her mentor(s) and the programme admins are told
//   reviewTeachBack        the /rtt/teach-back queue's Approve / Request
//                          changes (POST /api/teach-back/[id]/review): the
//                          request's decision, through decideApproval
//   teachBackDecisions     each video's latest request, for her page
//
// ── A TEACH-BACK WITH NO REQUEST ─────────────────────────────────────────────
//
// Videos sent before this, by WhatsApp, or whose upload was finished by the
// reconciler rather than the browser have no request: nothing submitted one.
// Reviewing such a clip creates its request, on the teacher's behalf, and
// decides it in the same step, so it is reviewed the same way, the decision
// is kept the same way and she is told the same way. A clip reviewed under
// the old button (reviewed_at set, no request) stays reviewed; it is not
// reopened.

import { and, eq } from "drizzle-orm";
import { approvals, videoSubmissions } from "@gml/db/schema";
import { hasAnyRole } from "@gml/shared/auth/roles";
import { decideApproval, latestApprovals, submitForApproval, type ApprovalResult } from "@/lib/approvals";
import { TEACH_BACK_DECISIONS, teachBackHandler } from "@/lib/approvals/handlers/teach-back";
import type { Actor, Db } from "@/lib/visibility";

/** The two decisions the teach-back review offers (defined beside its approvals handler). */
export { TEACH_BACK_DECISIONS };
export type TeachBackDecision = (typeof TEACH_BACK_DECISIONS)[number];

export function isTeachBackDecision(v: unknown): v is TeachBackDecision {
  return typeof v === "string" && (TEACH_BACK_DECISIONS as readonly string[]).includes(v);
}

/**
 * The upload `submissionId` was recorded, by `actor`: when it is her own
 * teach-back, send it for review. Anything else -- another context, someone
 * else's video, a retried completion of one already sent or reviewed -- does
 * nothing. Never throws: the upload itself has succeeded either way.
 */
export async function submitTeachBackUpload(db: Db, submissionId: string, actor: Actor): Promise<ApprovalResult | null> {
  try {
    const [video] = await db
      .select({ contextType: videoSubmissions.contextType, submittedBy: videoSubmissions.submittedByUserId })
      .from(videoSubmissions)
      .where(eq(videoSubmissions.id, submissionId))
      .limit(1);
    if (!video || video.contextType !== "teach_back" || video.submittedBy !== actor.id) return null;
    return await submitForApproval(db, { itemType: "teach_back", itemId: submissionId, actor });
  } catch (err) {
    console.error("[teach-back] could not send the upload for review", { submissionId, err });
    return null;
  }
}

/** May `actor` review this teach-back now (role, her mentees only for a mentor, and it plays)? */
export async function mayReviewTeachBack(db: Db, actor: Actor, videoId: string): Promise<boolean> {
  if (!hasAnyRole(actor.role, teachBackHandler.deciderRoles)) return false;
  return (await teachBackHandler.canDecide?.(db, actor, videoId)) ?? true;
}

export type ReviewError =
  | "invalid_decision"
  | "not_found"
  | "not_playable"
  | "not_allowed"
  | "feedback_required"
  | "already_reviewed";

export type ReviewResult = { ok: true; approvalId: string; decision: TeachBackDecision; created: boolean } | { ok: false; error: ReviewError };

/** The item's open request, if it has one. */
async function pendingRequest(db: Db, videoId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: approvals.id })
    .from(approvals)
    .where(and(eq(approvals.itemType, "teach_back"), eq(approvals.itemId, videoId), eq(approvals.status, "pending")))
    .limit(1);
  return row?.id ?? null;
}

/**
 * Approve a teach-back or request changes to it, as `actor`, with written
 * feedback (required to request changes). The checks, in the order a
 * reviewer is told about them: a teach-back that exists, that plays, that
 * this reviewer may decide, a decision and its feedback, and one not already
 * decided.
 */
export async function reviewTeachBack(
  db: Db,
  input: { videoId: string; decision: unknown; feedback?: string | null; actor: Actor },
): Promise<ReviewResult> {
  const [video] = await db
    .select({
      status: videoSubmissions.status,
      reviewedAt: videoSubmissions.reviewedAt,
      submittedBy: videoSubmissions.submittedByUserId,
    })
    .from(videoSubmissions)
    .where(and(eq(videoSubmissions.id, input.videoId), eq(videoSubmissions.contextType, "teach_back")))
    .limit(1);
  if (!video) return { ok: false, error: "not_found" };
  if (video.status !== "ready") return { ok: false, error: "not_playable" };
  if (!(await mayReviewTeachBack(db, input.actor, input.videoId))) return { ok: false, error: "not_allowed" };
  if (!isTeachBackDecision(input.decision)) return { ok: false, error: "invalid_decision" };
  const decision = input.decision;
  const feedback = input.feedback?.trim() || null;
  if (decision !== "approved" && !feedback) return { ok: false, error: "feedback_required" };

  let approvalId = await pendingRequest(db, input.videoId);
  let created = false;
  if (!approvalId) {
    // Reviewed already (the old button, or a decision just taken): not reopened.
    if (video.reviewedAt !== null) return { ok: false, error: "already_reviewed" };
    try {
      const [row] = await db
        .insert(approvals)
        .values({ itemType: "teach_back", itemId: input.videoId, submittedByUserId: video.submittedBy })
        .returning({ id: approvals.id });
      approvalId = row!.id;
      created = true;
    } catch (err) {
      // approvals_one_pending_uq: another reviewer created it a moment ago.
      const code = (err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code;
      if (code !== "23505") throw err;
      approvalId = await pendingRequest(db, input.videoId);
      if (!approvalId) return { ok: false, error: "already_reviewed" };
    }
  }

  const decided = await decideApproval(db, { approvalId, decision, comment: feedback, actor: input.actor });
  if (!decided.ok) {
    const error: ReviewError =
      decided.error === "comment_required"
        ? "feedback_required"
        : decided.error === "not_pending" || decided.error === "already_pending"
          ? "already_reviewed"
          : decided.error === "decision_not_allowed"
            ? "invalid_decision"
            : decided.error;
    return { ok: false, error };
  }
  return { ok: true, approvalId, decision, created };
}

export type TeachBackDecisionState = {
  /** pending / approved / changes_requested / rejected */
  status: string;
  /** The reviewer's written feedback. */
  feedback: string | null;
  decidedAt: Date | null;
};

/** Each video's latest review request, for the teacher's own page. */
export async function teachBackDecisions(db: Db, videoIds: string[]): Promise<Map<string, TeachBackDecisionState>> {
  const latest = await latestApprovals(db, "teach_back", videoIds);
  const out = new Map<string, TeachBackDecisionState>();
  for (const [id, a] of latest) out.set(id, { status: a.status, feedback: a.comment, decidedAt: a.decidedAt });
  return out;
}
