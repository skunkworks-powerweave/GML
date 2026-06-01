// Spec 121 — GET /api/quickfind?q=<term>
//
// Cross-entity Cmd+K / Ctrl+K quick-find. Mirrors the JSX prototype's
// `WikiQuickFind` overlay (LMS GML Frontend/shell.jsx line 187 trigger;
// LMS GML Frontend/app.jsx lines 275-288 mount + navigation glue) which
// fan-outs an ILIKE search across the entire repository spine.
//
// The endpoint returns a FLAT array of result rows — the client renders
// them as a single keyboard-navigable list (groups are recovered visually
// from the `kind` discriminator). Cap at 20 rows total to keep the
// rendering snappy on weak Ladakhi bandwidth.
//
// Method matrix:
//   GET ?q=<2+ chars>          → 200 { ok:true, q, results: [...] }
//   GET ?q=<<2 chars>          → 200 { ok:true, q, results: [] } (no-op, but still 200)
//   GET (no session)           → 401 { error: "unauthenticated" }
//   POST / PUT / DELETE        → 405 { error: "method_not_allowed" }
//
// SM-1: every search writes one audit row with action="quickfind.query"
// and metadata { q, resultCount }. Audit-on-completion so resultCount is
// accurate. Best-effort `void` — never block the 200 response.
//
// SM-9: learner rows are NOT exposed here. The endpoint only walks
// teachers / schools / classes / subjects / outlines / observation cycles
// / mentor pairings / classroom sessions. If a future spec adds learners,
// the role gate documented in the spec body (super_admin/programme_admin)
// belongs HERE, not in the client.

import { NextResponse } from "next/server";
import { and, asc, eq, ilike, or, sql } from "drizzle-orm";
import { db } from "@gml/db";
import {
  teachers,
  schools,
  classes,
  subjects,
  observationCycles,
  mentorPairings,
  mentors,
  courseOutlines,
  sessions,
} from "@gml/db/schema";
import { auth } from "@/auth";
import { recordAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

const MIN_QUERY = 2;
const MAX_PER_KIND = 4; // 8 kinds × 4 ≈ 20-row cap after the flat merge.
const HARD_CAP = 20;

export type QuickFindKind =
  | "teacher"
  | "school"
  | "class"
  | "subject"
  | "observation_cycle"
  | "mentor_pairing"
  | "outline"
  | "session";

export type QuickFindResult = {
  kind: QuickFindKind;
  id: string;
  label: string;
  sublabel: string;
  href: string;
};

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const url = new URL(req.url);
  const rawQ = (url.searchParams.get("q") ?? "").trim();

  // Below MIN_QUERY chars: short-circuit to an empty result list. Still 200 +
  // empty array (NOT 400) — the client polls this endpoint while the user is
  // typing and a 400 would spam the console with errors.
  if (rawQ.length < MIN_QUERY) {
    return NextResponse.json(
      { ok: true, q: rawQ, results: [] satisfies QuickFindResult[] },
      { status: 200 },
    );
  }

  const pattern = `%${rawQ}%`;
  const results: QuickFindResult[] = [];

  // 1) Teachers — full_name ILIKE. School code joined for the sublabel.
  const teacherRows = await db
    .select({
      id: teachers.id,
      fullName: teachers.fullName,
      schoolCode: schools.code,
      schoolName: schools.name,
    })
    .from(teachers)
    .leftJoin(schools, eq(teachers.schoolId, schools.id))
    .where(and(eq(teachers.active, true), ilike(teachers.fullName, pattern)))
    .orderBy(asc(teachers.fullName))
    .limit(MAX_PER_KIND);
  for (const r of teacherRows) {
    results.push({
      kind: "teacher",
      id: r.id,
      label: r.fullName,
      sublabel: r.schoolCode ? `${r.schoolCode} · ${r.schoolName ?? ""}`.trim() : "Teacher",
      href: `/repo/teacher/${r.id}`,
    });
  }

  // 2) Schools — name OR code ILIKE.
  const schoolRows = await db
    .select({
      id: schools.id,
      code: schools.code,
      name: schools.name,
    })
    .from(schools)
    .where(
      and(
        eq(schools.active, true),
        or(ilike(schools.name, pattern), ilike(schools.code, pattern)),
      ),
    )
    .orderBy(asc(schools.code))
    .limit(MAX_PER_KIND);
  for (const r of schoolRows) {
    results.push({
      kind: "school",
      id: r.id,
      label: r.name,
      sublabel: r.code,
      href: `/repo/school/${r.id}`,
    });
  }

  // 3) Classes — match on the synthesized "Grade N" label since the table
  //    doesn't have a literal `label` column. The class teacher's name is the
  //    other indexed field we can search.
  const classRows = await db
    .select({
      id: classes.id,
      grade: classes.grade,
      classTeacherName: classes.classTeacherName,
      schoolCode: schools.code,
    })
    .from(classes)
    .leftJoin(schools, eq(classes.schoolId, schools.id))
    .where(
      and(
        eq(classes.active, true),
        or(
          ilike(sql`'Grade ' || ${classes.grade}::text`, pattern),
          ilike(classes.classTeacherName, pattern),
        ),
      ),
    )
    .orderBy(asc(classes.grade))
    .limit(MAX_PER_KIND);
  for (const r of classRows) {
    results.push({
      kind: "class",
      id: r.id,
      label: `Grade ${r.grade}${r.schoolCode ? ` · ${r.schoolCode}` : ""}`,
      sublabel: r.classTeacherName ?? "Class",
      href: `/repo/class/${r.id}`,
    });
  }

  // 4) Subjects — name OR code ILIKE.
  const subjectRows = await db
    .select({
      id: subjects.id,
      name: subjects.name,
      code: subjects.code,
    })
    .from(subjects)
    .where(
      and(
        eq(subjects.active, true),
        or(ilike(subjects.name, pattern), ilike(subjects.code, pattern)),
      ),
    )
    .orderBy(asc(subjects.displayOrder))
    .limit(MAX_PER_KIND);
  for (const r of subjectRows) {
    results.push({
      kind: "subject",
      id: r.id,
      label: r.name,
      sublabel: r.code,
      href: `/repo/subject/${r.id}`,
    });
  }

  // 5) Observation cycles — `code` ILIKE (e.g. "OBS-2026-001"). Cycles are a
  //    high-traffic deep link from the dashboard.
  const cycleRows = await db
    .select({
      id: observationCycles.id,
      code: observationCycles.code,
      kind: observationCycles.kind,
      topic: observationCycles.topic,
    })
    .from(observationCycles)
    .where(ilike(observationCycles.code, pattern))
    .orderBy(asc(observationCycles.code))
    .limit(MAX_PER_KIND);
  for (const r of cycleRows) {
    results.push({
      kind: "observation_cycle",
      id: r.id,
      label: r.code,
      sublabel: r.topic ?? `Observation · ${r.kind}`,
      href: `/observation/${r.id}`,
    });
  }

  // 6) Mentor pairings — via mentor name OR teacher name. The pairing has no
  //    free-text label of its own so we hydrate both sides for the search.
  const pairingRows = await db
    .select({
      id: mentorPairings.id,
      mentorName: mentors.name,
      teacherName: teachers.fullName,
    })
    .from(mentorPairings)
    .leftJoin(mentors, eq(mentorPairings.mentorId, mentors.id))
    .leftJoin(teachers, eq(mentorPairings.teacherId, teachers.id))
    .where(or(ilike(mentors.name, pattern), ilike(teachers.fullName, pattern)))
    .limit(MAX_PER_KIND);
  for (const r of pairingRows) {
    const label = `${r.mentorName ?? "?"} → ${r.teacherName ?? "?"}`;
    results.push({
      kind: "mentor_pairing",
      id: r.id,
      label,
      sublabel: "Mentor pairing",
      href: `/mentorship/${r.id}`,
    });
  }

  // 7) Course outlines — name ILIKE.
  const outlineRows = await db
    .select({
      id: courseOutlines.id,
      name: courseOutlines.name,
      grade: courseOutlines.grade,
      term: courseOutlines.term,
      subjectName: subjects.name,
    })
    .from(courseOutlines)
    .leftJoin(subjects, eq(courseOutlines.subjectId, subjects.id))
    .where(ilike(courseOutlines.name, pattern))
    .orderBy(asc(courseOutlines.name))
    .limit(MAX_PER_KIND);
  for (const r of outlineRows) {
    results.push({
      kind: "outline",
      id: r.id,
      label: r.name,
      sublabel: `${r.subjectName ?? ""} · Grade ${r.grade} · Term ${r.term}`.trim(),
      href: `/repo/outline/${r.id}`,
    });
  }

  // 8) Classroom sessions — match by topic (the only free-text column).
  //    `scheduledDate` is joined into the sublabel so the user can disambiguate
  //    repeat topics on different days.
  const sessionRows = await db
    .select({
      id: sessions.id,
      topic: sessions.topic,
      scheduledDate: sessions.scheduledDate,
      subjectName: subjects.name,
    })
    .from(sessions)
    .leftJoin(subjects, eq(sessions.subjectId, subjects.id))
    .where(ilike(sessions.topic, pattern))
    .limit(MAX_PER_KIND);
  for (const r of sessionRows) {
    results.push({
      kind: "session",
      id: r.id,
      label: r.topic ?? "Session",
      sublabel: `${r.subjectName ?? ""} · ${r.scheduledDate ?? ""}`.trim(),
      href: `/repo/session/${r.id}`,
    });
  }

  // Hard cap at HARD_CAP rows regardless of how each per-kind LIMIT lands —
  // the prototype renders at most 20 rows in the overlay scroller.
  const capped = results.slice(0, HARD_CAP);

  // SM-1 audit — fires AFTER the searches complete so resultCount is the post-
  // cap count actually returned to the user.
  void recordAudit({
    action: "quickfind.query",
    entityType: "quickfind",
    metadata: { q: rawQ, resultCount: capped.length },
  });

  return NextResponse.json(
    { ok: true, q: rawQ, results: capped },
    { status: 200 },
  );
}

export async function POST() {
  return NextResponse.json({ error: "method_not_allowed" }, { status: 405 });
}
export async function PUT() {
  return NextResponse.json({ error: "method_not_allowed" }, { status: 405 });
}
export async function DELETE() {
  return NextResponse.json({ error: "method_not_allowed" }, { status: 405 });
}
export async function PATCH() {
  return NextResponse.json({ error: "method_not_allowed" }, { status: 405 });
}
