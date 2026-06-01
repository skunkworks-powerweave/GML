// POST /api/teach-back/[id]/review — marks a teach-back submission as reviewed.
//
// Caller: /rtt/teach-back queue (spec 066) renders a native <form method="POST"
// action="/api/teach-back/<id>/review"> button labelled "Mark reviewed". This
// endpoint closes that loop: validate role, flip status to 'reviewed' on the
// matching video_submissions row (scoped to context_type='teach_back' so a
// stray observation/mentor-meeting submission id can't be reviewed through
// this surface), and audit the action under SM-1.
//
// Method matrix:
//   POST                 → 200 {ok:true}        success path
//   POST (no session)    → 401 {error:"unauthenticated"}
//   POST (wrong role)    → 403 {error:"forbidden"}
//   POST (unknown id)    → 404 {error:"not_found"}  (zero rows updated)
//   GET / PUT / DELETE   → 405 {error:"method_not_allowed"}
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

export const dynamic = "force-dynamic";

const ALLOWED_ROLES = ["super_admin", "programme_admin", "mentor", "observer"] as const;

export async function POST(
  _req: Request,
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
  if (!id || typeof id !== "string") {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  // Scope the UPDATE to context_type='teach_back' so this endpoint can never
  // mutate an observation_cycle / mentor_meeting / classroom_session row.
  // `.returning({id})` lets us treat zero rows as 404 without a separate SELECT.
  const updated = await db
    .update(videoSubmissions)
    .set({ status: "reviewed" })
    .where(
      and(
        eq(videoSubmissions.id, id),
        eq(videoSubmissions.contextType, "teach_back"),
      ),
    )
    .returning({ id: videoSubmissions.id });

  if (updated.length === 0) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  void recordAudit({
    action: "teach_back.reviewed",
    entityType: "video_submission",
    entityId: id,
  });

  return NextResponse.json({ ok: true }, { status: 200 });
}

export async function GET() {
  return NextResponse.json({ error: "method_not_allowed" }, { status: 405 });
}
