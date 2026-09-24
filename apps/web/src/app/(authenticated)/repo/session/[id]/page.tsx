// /repo/session/[id] — single classroom session detail.
// Port of repository.jsx::RepoSessionPage (lines 751-824) — 1:1 visual fidelity.
// Two-column layout: lesson notes + linked observation cycle (left), KV details (right).

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { auth } from "@/auth";
import { uuidOrNotFound } from "@/lib/ids";
import { actorFrom } from "@/lib/authz";
import { linkedCycle } from "@/lib/gated-reads";
import { observationAccess } from "@/lib/visibility";
import { db } from "@gml/db";
import {
  sessions,
  schools,
  classes,
  subjects,
  teachers,
  outlineLessons,
  courseOutlines,
} from "@gml/db/schema";

export const dynamic = "force-dynamic";

const ALLOWED_ROLES = new Set([
  "super_admin",
  "programme_admin",
  "mentor",
  "observer",
  "teacher",
]);

const STATUS_CHIP: Record<string, { kind: string; label: string }> = {
  planned: { kind: "", label: "Planned" },
  in_progress: { kind: "chip-saffron", label: "In progress" },
  complete: { kind: "chip-lichen", label: "Complete" },
  cancelled: { kind: "", label: "Cancelled" },
};

function fmtAttendance(attended: number, total: number): string {
  if (!total) return "—";
  return `${attended} / ${total}`;
}

export default async function RepoSessionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const authSession = await auth();
  const role = authSession?.user?.role;
  if (!role || !ALLOWED_ROLES.has(role)) redirect("/forbidden");
  const actor = actorFrom(authSession);
  if (!actor) redirect("/login");

  // A malformed id names no record: 404, not a Postgres 22P02 and a 500.
  const id = uuidOrNotFound((await params).id);

  const [s] = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
  if (!s) notFound();

  const [school] = await db.select().from(schools).where(eq(schools.id, s.schoolId)).limit(1);
  const [cls] = await db.select().from(classes).where(eq(classes.id, s.classId)).limit(1);
  const [subject] = await db.select().from(subjects).where(eq(subjects.id, s.subjectId)).limit(1);
  const [teacher] = await db.select().from(teachers).where(eq(teachers.id, s.teacherId)).limit(1);

  let lesson: (typeof outlineLessons.$inferSelect) | undefined;
  let outline: (typeof courseOutlines.$inferSelect) | undefined;
  if (s.outlineLessonId) {
    const [ll] = await db
      .select()
      .from(outlineLessons)
      .where(eq(outlineLessons.id, s.outlineLessonId))
      .limit(1);
    lesson = ll;
    if (ll) {
      const [ol] = await db
        .select()
        .from(courseOutlines)
        .where(eq(courseOutlines.id, ll.outlineId))
        .limit(1);
      outline = ol;
    }
  }

  // The linked cycle's code and UUID are observation-section data, and this page
  // is outside that section. It used to select the cycle by id alone, so any
  // signed-in user could read the code of any cycle a session was observed
  // under and follow its link. Now it is named only when the viewer has
  // unlocked the observation section AND may see that cycle; otherwise the
  // session just reads "Observed". See lib/gated-reads.ts.
  const cycle = s.observationCycleId
    ? await linkedCycle(db, await observationAccess(db, actor), s.observationCycleId)
    : null;

  const statusChip = STATUS_CHIP[s.status] ?? STATUS_CHIP.planned;

  return (
    <div>
      {/* Header */}
      <div className="page-header">
        <Link
          href="/repo/sessions"
          className="btn btn-sm btn-ghost"
          style={{ marginBottom: 8, marginLeft: -8, textDecoration: "none" }}
        >
          ← Sessions
        </Link>
        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "space-between",
            gap: 16,
            flexWrap: "wrap",
          }}
        >
          <div>
            <div className="label">
              Session · <span className="mono" style={{ textTransform: "none" }}>{s.id.slice(0, 8)}</span>
            </div>
            <h1 className="serif" style={{ fontSize: 26, marginTop: 4 }}>
              {s.topic ?? lesson?.title ?? "Untitled session"}
            </h1>
            <p style={{ color: "var(--ink-3)", fontSize: 13, marginTop: 4 }}>
              {school?.code ?? "—"} · Grade {cls?.grade ?? "—"} · {subject?.name ?? "—"} ·{" "}
              <span className="mono">
                {s.scheduledDate}
                {s.scheduledTime ? ` ${s.scheduledTime}` : ""}
              </span>
              {s.durationMin ? ` · ${s.durationMin} min` : ""}
            </p>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span className={`chip ${statusChip.kind}`.trim()}>{statusChip.label}</span>
            {s.observed ? (
              <span className="chip chip-saffron">
                Observed{cycle?.code ? ` · ${cycle.code}` : ""}
              </span>
            ) : null}
          </div>
        </div>
      </div>

      {/* Body: two-column */}
      <div
        className="page-body"
        style={{
          display: "grid",
          gridTemplateColumns: "1.6fr 1fr",
          gap: 18,
        }}
      >
        {/* Left col: notes + linked cycle */}
        <div style={{ display: "grid", gap: 16, alignContent: "start" }}>
          <SectionCard title="Lesson notes">
            <div
              style={{
                padding: "8px 18px 16px",
                fontSize: 13.5,
                lineHeight: 1.6,
                color: "var(--ink-2)",
              }}
            >
              {s.topic ? (
                <p style={{ margin: "8px 0" }}>
                  <b>Topic</b> — {s.topic}
                </p>
              ) : null}
              {lesson ? (
                <p style={{ margin: "8px 0" }}>
                  <b>Curriculum lesson</b> — Lesson {lesson.sequence}: {lesson.title}
                  {lesson.week ? ` (week ${lesson.week})` : ""}.
                </p>
              ) : null}
              <p style={{ margin: "8px 0" }}>
                <b>Attendance</b> —{" "}
                {s.status === "complete"
                  ? `${fmtAttendance(s.attendedCount, s.totalCount)} learners present`
                  : "Attendance recorded on completion."}
              </p>
              {!s.topic && !lesson ? (
                <p style={{ color: "var(--ink-3)", fontStyle: "italic", margin: "8px 0" }}>
                  No lesson notes captured for this session.
                </p>
              ) : null}
            </div>
          </SectionCard>

          {s.observed && cycle ? (
            <SectionCard
              title="Linked observation cycle"
              sub="Open in the Classroom Observation module"
            >
              <div style={{ padding: 14, fontSize: 13, color: "var(--ink-2)" }}>
                This session was observed by the mentor. The full pre-form, video review, and
                post-form are recorded against cycle{" "}
                <span className="mono">{cycle.code}</span>.
                <div style={{ marginTop: 10 }}>
                  <Link
                    href={`/observation/${cycle.id}`}
                    className="btn btn-sm"
                    style={{ textDecoration: "none" }}
                  >
                    Open cycle {cycle.code} →
                  </Link>
                </div>
              </div>
            </SectionCard>
          ) : null}
        </div>

        {/* Right col: KV details */}
        <div style={{ display: "grid", gap: 16, alignContent: "start" }}>
          <SectionCard title="Details">
            <div style={{ padding: "0 14px 8px" }}>
              <KVRow label="Session ID">
                <span className="mono" style={{ fontSize: 12 }}>{s.id}</span>
              </KVRow>
              <KVRow label="School">
                <RelLink href={`/repo/school/${s.schoolId}`}>
                  {school?.code} {school?.name}
                </RelLink>
              </KVRow>
              {cls ? (
                <KVRow label="Class">
                  <RelLink href={`/repo/class/${cls.id}`}>Grade {cls.grade}</RelLink>
                </KVRow>
              ) : null}
              <KVRow label="Subject">
                <RelLink href={`/repo/subject/${s.subjectId}`}>{subject?.name ?? "—"}</RelLink>
              </KVRow>
              <KVRow label="Teacher">
                <RelLink href={`/repo/teacher/${s.teacherId}`}>
                  {teacher?.fullName ?? "—"}
                  {teacher?.hindiName ? (
                    <span
                      style={{
                        fontFamily: "var(--deva)",
                        color: "var(--ink-3)",
                        marginLeft: 6,
                        fontSize: 12,
                      }}
                    >
                      {teacher.hindiName}
                    </span>
                  ) : null}
                </RelLink>
              </KVRow>
              <KVRow label="Date">
                <span className="mono" style={{ fontSize: 12 }}>
                  {s.scheduledDate}
                  {s.scheduledTime ? ` · ${s.scheduledTime}` : ""}
                </span>
              </KVRow>
              <KVRow label="Duration">{s.durationMin ? `${s.durationMin} min` : "—"}</KVRow>
              <KVRow label="Status">
                <span className={`chip ${statusChip.kind}`.trim()}>{statusChip.label}</span>
              </KVRow>
              <KVRow label="Attendance">{fmtAttendance(s.attendedCount, s.totalCount)}</KVRow>
              {outline ? (
                <KVRow label="Outline">
                  <RelLink href={`/repo/outline/${outline.id}`}>{outline.name}</RelLink>
                </KVRow>
              ) : null}
              <KVRow label="Observed">
                {s.observed ? (
                  <span className="chip chip-saffron">Yes</span>
                ) : (
                  <span className="chip">No</span>
                )}
              </KVRow>
            </div>
          </SectionCard>
        </div>
      </div>
    </div>
  );
}

function SectionCard({
  title,
  sub,
  children,
}: {
  title: string;
  sub?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="card card-hi" style={{ overflow: "hidden" }}>
      <header
        style={{
          padding: "12px 16px",
          borderBottom: "1px solid var(--line)",
          background: "var(--paper)",
        }}
      >
        <div className="serif" style={{ fontSize: 15, color: "var(--ink)" }}>{title}</div>
        {sub ? (
          <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>{sub}</div>
        ) : null}
      </header>
      {children}
    </div>
  );
}

function KVRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "120px 1fr",
        gap: 10,
        padding: "8px 0",
        borderTop: "1px solid var(--line)",
        alignItems: "flex-start",
      }}
    >
      <span className="label" style={{ paddingTop: 2 }}>
        {label}
      </span>
      <div
        style={{
          fontSize: 13,
          display: "flex",
          flexWrap: "wrap",
          gap: 4,
          alignItems: "center",
        }}
      >
        {children}
      </div>
    </div>
  );
}

function RelLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="chip" style={{ textDecoration: "none", fontSize: 12 }}>
      {children}
    </Link>
  );
}
