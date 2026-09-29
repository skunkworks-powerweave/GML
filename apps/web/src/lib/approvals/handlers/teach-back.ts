// Approval handler for teach_back items: a teacher's teach-back video
// (video_submissions, context_type 'teach_back'), reviewed by her mentor, an
// observer or a programme admin. See ../types.ts for the contract.
//
//   submit    the video's own teacher, once the upload is recorded
//             (lib/rtt/teach-back.ts submitTeachBackUpload), and only while
//             nobody has reviewed it
//   decide    a mentor only for her own mentees (an active pairing); an
//             observer, a programme admin or a super admin for anyone -- and
//             only once the clip plays, as the review queue has always held
//             (lib/video/pending-review.ts): nobody reviews what nobody could
//             watch
//   decision  any decision marks the video reviewed (reviewed_at /
//             reviewed_by_user_id, the queue's "reviewed" predicate); the
//             approver's comment is the written feedback the teacher reads on
//             her subject page
//   told      her active mentor(s) and every active programme admin
//
// The video has no approval state of its own: the approvals row is it
// (latestApprovals), and reviewed_at says whether a decision has been taken.

import { and, eq, inArray, isNull } from "drizzle-orm";
import { mentorPairings, mentors, rttSubjects, teachers, users, videoSubmissions, type ApprovalDecision } from "@gml/db/schema";
import { mentorIdFor, teacherIdFor } from "@/lib/visibility";
import type { ApprovalHandler, DbOrTx, ItemSummary } from "../types";

/** The teach-back itself, with the teacher who sent it; null if `itemId` is none. */
async function teachBack(db: DbOrTx, itemId: string) {
  const [row] = await db
    .select({
      id: videoSubmissions.id,
      status: videoSubmissions.status,
      reviewedAt: videoSubmissions.reviewedAt,
      submittedBy: videoSubmissions.submittedByUserId,
      teacherId: teachers.id,
    })
    .from(videoSubmissions)
    .leftJoin(teachers, eq(teachers.userId, videoSubmissions.submittedByUserId))
    .where(and(eq(videoSubmissions.id, itemId), eq(videoSubmissions.contextType, "teach_back")))
    .limit(1);
  return row ?? null;
}

/** The programme's day a video arrived, as data (YYYY-MM-DD). */
const day = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

/** Approve or Request changes: the design gives a teach-back no Reject. */
export const TEACH_BACK_DECISIONS = ["approved", "changes_requested"] as const satisfies readonly ApprovalDecision[];

export const teachBackHandler: ApprovalHandler = {
  type: "teach_back",
  deciderRoles: ["mentor", "observer", "programme_admin", "super_admin"],
  decisions: TEACH_BACK_DECISIONS,

  async canSubmit(db, actor, itemId) {
    const video = await teachBack(db, itemId);
    if (!video || video.submittedBy !== actor.id || video.reviewedAt !== null) return false;
    // The video's own TEACHER: a teach-back is taught back by someone learning RTT.
    const teacherId = await teacherIdFor(db as never, actor);
    return !!teacherId && teacherId === video.teacherId;
  },

  async canDecide(db, actor, itemId) {
    const video = await teachBack(db, itemId);
    if (!video || video.status !== "ready") return false;
    if (actor.role !== "mentor") return true;
    if (!video.teacherId) return false;
    const mentorId = await mentorIdFor(db as never, actor);
    if (!mentorId) return false;
    const [pairing] = await db
      .select({ id: mentorPairings.id })
      .from(mentorPairings)
      .where(
        and(
          eq(mentorPairings.mentorId, mentorId),
          eq(mentorPairings.teacherId, video.teacherId),
          eq(mentorPairings.status, "active"),
        ),
      )
      .limit(1);
    return !!pairing;
  },

  async onDecision(tx, itemId, _decision, { actor }) {
    // Reviewed, whatever the decision: it leaves "Pending review". Only once:
    // a video reviewed before keeps its first reviewer.
    await tx
      .update(videoSubmissions)
      .set({ reviewedAt: new Date(), reviewedByUserId: actor.id })
      .where(
        and(
          eq(videoSubmissions.id, itemId),
          eq(videoSubmissions.contextType, "teach_back"),
          isNull(videoSubmissions.reviewedAt),
        ),
      );
  },

  async describe(db, itemIds) {
    const out = new Map<string, ItemSummary>();
    if (itemIds.length === 0) return out;
    const rows = await db
      .select({
        id: videoSubmissions.id,
        createdAt: videoSubmissions.createdAt,
        subject: rttSubjects.name,
        teacher: teachers.fullName,
        account: users.name,
      })
      .from(videoSubmissions)
      .leftJoin(rttSubjects, eq(rttSubjects.id, videoSubmissions.contextId))
      .leftJoin(users, eq(users.id, videoSubmissions.submittedByUserId))
      .leftJoin(teachers, eq(teachers.userId, videoSubmissions.submittedByUserId))
      .where(and(inArray(videoSubmissions.id, itemIds), eq(videoSubmissions.contextType, "teach_back")));
    for (const r of rows) {
      out.set(r.id, {
        title: [r.subject, day(r.createdAt)].filter(Boolean).join(" · "),
        subtitle: r.teacher ?? r.account ?? undefined,
        href: `/videos/${r.id}`,
      });
    }
    return out;
  },

  async approverUserIds(db, itemId) {
    const [mentorRows, admins] = await Promise.all([
      db
        .select({ userId: mentors.userId })
        .from(videoSubmissions)
        .innerJoin(teachers, eq(teachers.userId, videoSubmissions.submittedByUserId))
        .innerJoin(mentorPairings, and(eq(mentorPairings.teacherId, teachers.id), eq(mentorPairings.status, "active")))
        .innerJoin(mentors, and(eq(mentors.id, mentorPairings.mentorId), eq(mentors.active, true)))
        .innerJoin(users, and(eq(users.id, mentors.userId), eq(users.active, true)))
        .where(eq(videoSubmissions.id, itemId)),
      db
        .select({ userId: users.id })
        .from(users)
        .where(and(eq(users.active, true), eq(users.role, "programme_admin"))),
    ]);
    const ids = [...mentorRows.map((r) => r.userId), ...admins.map((r) => r.userId)].filter((id): id is string => !!id);
    return [...new Set(ids)];
  },
};
