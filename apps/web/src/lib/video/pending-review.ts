// "Which teach-back videos is a reviewer owed?" -- ONE definition.
//
// A clip is owed a review when it is a teach-back, it is PLAYABLE (status
// 'ready'), and nobody has reviewed it yet (reviewed_at IS NULL). Review is a
// timestamp, not a status: the review route sets only reviewed_at, and the
// `review_pending` member of the video_status enum is written by nothing (the
// worker writes ready/failed, the WhatsApp webhook writes received). See
// migration 0022.
//
// WHY A SHARED HELPER. Three surfaces answered this question three ways:
//   - the mentor dashboard card and to-do row counted
//     status IN (received, queued, transcoding, review_pending) -- i.e. only the
//     clips a mentor CANNOT watch yet -- and the card added created_at >= 48h
//     ago, so overdue reviews vanished from the card whose hint reads
//     "target: < 48 h";
//   - the sidebar badge (lib/chrome-counts.ts) used ready + reviewed_at IS NULL;
//   - /rtt/teach-back's "Pending review" tab used reviewed_at IS NULL alone,
//     which also counted clips still transcoding.
// Each caller keeps its own SCOPING (the dashboard joins to the mentor's own
// pairings; the badge is programme-wide) -- only the predicate is shared.
//
// Pure (no database client, no server-only) so tests/behaviour can render and
// execute it: tests/behaviour/pending-review.test.ts.

import { and, eq, isNull, type SQL } from "drizzle-orm";
import { videoSubmissions } from "@gml/db/schema";

/** WHERE fragment: teach-back, playable, unreviewed. No time window. */
export function pendingTeachBackReviewWhere(): SQL {
  return and(
    eq(videoSubmissions.contextType, "teach_back"),
    eq(videoSubmissions.status, "ready"),
    isNull(videoSubmissions.reviewedAt),
  ) as SQL;
}

/** The same test over an already-loaded row, for lists filtered in memory. */
export function isPendingTeachBackReview(row: {
  contextType: string;
  status: string;
  reviewedAt: Date | null;
}): boolean {
  return row.contextType === "teach_back" && row.status === "ready" && row.reviewedAt === null;
}
