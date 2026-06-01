// GET /api/admin/learners/export — bulk CSV export of all learners (SM-9 PII).
//
// Caller: /repo/students (spec 054) renders an "Export CSV" link visible only
// when the resolved session role === "super_admin". The link points at this
// endpoint with an optional `?school=<uuid>` filter mirrored from the caller's
// query string. The link is a plain anchor; the browser opens the URL in a new
// document, the response declares text/csv + Content-Disposition: attachment,
// and the file is saved to the user's downloads directory.
//
// Method matrix:
//   GET                   → 200 text/csv               success path
//   GET (no session)      → 401 {error:"unauthenticated"}
//   GET (role != super)   → 403 {error:"forbidden"}    programme_admin blocked!
//   POST / PUT / DELETE   → 405 {error:"method_not_allowed"}
//
// SM-9 (PII bulk-export audit, MORE STRICT than /repo/students bulk_view):
//   - The endpoint is gated to `super_admin` ONLY. `programme_admin` can VIEW
//     /repo/students but cannot bulk-export — that's the SM-9 policy split
//     documented in CLAUDE.md and the spec 054 acceptance test
//     ("bulk CSV export is super_admin-only").
//   - One audit row is written PER REQUEST with action="learners.bulk_export",
//     entityType="all", metadata.piiAudited=true, metadata.rowCount = the
//     actual selected count, metadata.schoolFilter = the ?school param or null.
//   - The audit fires AFTER the SELECT completes so rowCount is accurate.
//     Audit-on-intent (fire BEFORE the SELECT with rowCount=null) was
//     considered and rejected: the auditor needs the exfiltrated row count to
//     scope post-incident damage assessment, and the SELECT is cheap+local so
//     the latency cost of audit-after is negligible. See research.md D-002.
//
// Response shape:
//   Headers: Content-Type: text/csv; charset=utf-8
//            Content-Disposition: attachment; filename="learners-YYYYMMDD.csv"
//   Body:    CSV with header row [id,name,age,grade,school_code,class_label,
//            guardian,attendance_pct], one learner per data row.
//   Filename: learners-YYYYMMDD.csv where YYYYMMDD is today's UTC date.
//
// Imports use the locked workspace packages — no new deps. `papaparse` is
// already in apps/web/package.json (^5.4.1) and used by
// apps/web/src/app/(authenticated)/admin/data/[entity]/csv.ts.

import { NextResponse } from "next/server";
import Papa from "papaparse";
import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "@gml/db";
import { learners, classes, schools } from "@gml/db/schema";
import { auth } from "@/auth";
import { recordAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

const ALLOWED_ROLES = ["super_admin"] as const;

export async function GET(req: Request) {
  // Auth gate — no session → 401 (JSON, never redirect — this is an API route).
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  // Role gate — SM-9 narrows export to super_admin only. programme_admin
  // gets 403 even though they can view /repo/students.
  if (!ALLOWED_ROLES.includes(session.user.role as (typeof ALLOWED_ROLES)[number])) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // Optional ?school=<uuid> filter, mirroring /repo/students.
  const url = new URL(req.url);
  const schoolFilter = url.searchParams.get("school") || undefined;

  const whereExpr = schoolFilter
    ? and(eq(learners.active, true), isNull(learners.deletedAt), eq(learners.schoolId, schoolFilter))
    : and(eq(learners.active, true), isNull(learners.deletedAt));

  // SELECT all learners with class + school joined for the human-readable
  // school_code and class_label columns. No LIMIT — the CSV consumes the full
  // result set (super_admin is by definition trusted to read the whole table).
  const rows = await db
    .select({
      id: learners.id,
      name: learners.name,
      age: learners.age,
      grade: learners.grade,
      schoolCode: schools.code,
      classGrade: classes.grade,
      guardian: learners.guardian,
      attendancePct: learners.attendancePct,
    })
    .from(learners)
    .leftJoin(classes, eq(learners.classId, classes.id))
    .leftJoin(schools, eq(learners.schoolId, schools.id))
    .where(whereExpr)
    .orderBy(asc(schools.code), asc(learners.grade), asc(learners.name));

  // SM-9 audit — fires AFTER the SELECT so rowCount is accurate. Best-effort
  // `void` so audit-log failure never blocks the user-facing 200.
  void recordAudit({
    action: "learners.bulk_export",
    entityType: "all",
    metadata: {
      piiAudited: true,
      rowCount: rows.length,
      schoolFilter: schoolFilter ?? null,
    },
  });

  // Shape rows into the documented CSV columns. The `class_label` is rendered
  // as "Grade N" to match the on-screen label in /repo/students.
  const data = rows.map((r) => ({
    id: r.id,
    name: r.name,
    age: r.age ?? "",
    grade: r.grade,
    school_code: r.schoolCode ?? "",
    class_label: r.classGrade !== null && r.classGrade !== undefined ? `Grade ${r.classGrade}` : "",
    guardian: r.guardian ?? "",
    attendance_pct: r.attendancePct ?? "",
  }));

  const headers = ["id", "name", "age", "grade", "school_code", "class_label", "guardian", "attendance_pct"];
  const csv = Papa.unparse({ fields: headers, data });

  // YYYYMMDD in UTC — strip dashes from the ISO date prefix.
  const filename = `learners-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}.csv`;

  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}

export async function POST() {
  return NextResponse.json({ error: "method_not_allowed" }, { status: 405 });
}
