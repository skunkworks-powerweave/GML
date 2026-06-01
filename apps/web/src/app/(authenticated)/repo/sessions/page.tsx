// /repo/sessions — every classroom session held (planned / in progress / complete).
// Port of repository.jsx::RepoSessionsIndex (lines 693-746) — 1:1 visual fidelity.
// Filters by status + subject in-memory (table is paged at 200 server-side).

import Link from "next/link";
import { redirect } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@gml/db";
import { sessions, schools, classes, subjects, teachers } from "@gml/db/schema";

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

type SearchParams = Promise<{ status?: string; subject?: string }>;

export default async function RepoSessionsIndex({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const session = await auth();
  const role = session?.user?.role;
  if (!role || !ALLOWED_ROLES.has(role)) redirect("/forbidden");

  const sp = await searchParams;
  const statusFilter = sp.status ?? "all";
  const subjectFilter = sp.subject ?? "all";

  const rows = await db
    .select({
      id: sessions.id,
      scheduledDate: sessions.scheduledDate,
      scheduledTime: sessions.scheduledTime,
      topic: sessions.topic,
      status: sessions.status,
      attendedCount: sessions.attendedCount,
      totalCount: sessions.totalCount,
      observed: sessions.observed,
      schoolCode: schools.code,
      grade: classes.grade,
      subjectId: sessions.subjectId,
      subjectName: subjects.name,
      subjectColor: subjects.color,
      teacherName: teachers.fullName,
      teacherHindi: teachers.hindiName,
    })
    .from(sessions)
    .leftJoin(schools, eq(sessions.schoolId, schools.id))
    .leftJoin(classes, eq(sessions.classId, classes.id))
    .leftJoin(subjects, eq(sessions.subjectId, subjects.id))
    .leftJoin(teachers, eq(sessions.teacherId, teachers.id))
    .orderBy(desc(sessions.scheduledDate), desc(sessions.scheduledTime))
    .limit(200);

  const subjectOptions = await db
    .select({ id: subjects.id, name: subjects.name })
    .from(subjects)
    .where(eq(subjects.active, true))
    .orderBy(subjects.displayOrder);

  const visible = rows.filter(
    (s) =>
      (statusFilter === "all" || s.status === statusFilter) &&
      (subjectFilter === "all" || s.subjectId === subjectFilter),
  );

  const counts = {
    all: rows.length,
    planned: rows.filter((s) => s.status === "planned").length,
    in_progress: rows.filter((s) => s.status === "in_progress").length,
    complete: rows.filter((s) => s.status === "complete").length,
  };

  const filterTabs = [
    { v: "all", l: "All", n: counts.all },
    { v: "planned", l: "Planned", n: counts.planned },
    { v: "in_progress", l: "Today", n: counts.in_progress },
    { v: "complete", l: "Complete", n: counts.complete },
  ];

  return (
    <div>
      <div className="page-header">
        <div className="label">Repository</div>
        <h1 style={{ fontFamily: "var(--serif)", fontSize: 28, marginTop: 4 }}>Sessions</h1>
        <p style={{ color: "var(--ink-3)", marginTop: 4, maxWidth: 720 }}>
          Every classroom session held — planned, in progress and complete. Each session links to its
          school, class, subject, teacher and course outline.
        </p>
      </div>

      <div className="page-body" style={{ display: "grid", gap: 16 }}>
        {/* Filter card */}
        <div
          className="card card-hi"
          style={{ padding: 10, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}
        >
          <div style={{ display: "flex", gap: 4 }}>
            {filterTabs.map((f) => {
              const active = statusFilter === f.v;
              const href = `/repo/sessions?${new URLSearchParams({
                ...(f.v === "all" ? {} : { status: f.v }),
                ...(subjectFilter !== "all" ? { subject: subjectFilter } : {}),
              }).toString()}`;
              return (
                <Link
                  key={f.v}
                  href={href}
                  className="btn btn-sm"
                  style={{
                    background: active ? "var(--ink)" : "transparent",
                    color: active ? "var(--paper)" : "var(--ink-2)",
                    borderColor: active ? "var(--ink)" : "transparent",
                    boxShadow: "none",
                    textDecoration: "none",
                  }}
                >
                  {f.l}{" "}
                  <span style={{ opacity: 0.6, marginLeft: 4 }}>{f.n}</span>
                </Link>
              );
            })}
          </div>

          <div style={{ width: 1, height: 20, background: "var(--line)" }} />

          <form method="GET" action="/repo/sessions" style={{ display: "contents" }}>
            {statusFilter !== "all" ? <input type="hidden" name="status" value={statusFilter} /> : null}
            <select
              name="subject"
              defaultValue={subjectFilter}
              className="text"
              style={{ maxWidth: 200, padding: "5px 10px", fontSize: 12 }}
            >
              <option value="all">All subjects</option>
              {subjectOptions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <button type="submit" className="btn btn-sm">
              Apply
            </button>
          </form>

          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <span className="chip">{visible.length} shown</span>
          </div>
        </div>

        {/* Table card */}
        <div className="card card-hi">
          <table className="t">
            <thead>
              <tr>
                <th>Date</th>
                <th>Time</th>
                <th>School</th>
                <th>Grade</th>
                <th>Subject</th>
                <th>Topic</th>
                <th>Teacher</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 ? (
                <tr>
                  <td
                    colSpan={9}
                    style={{ textAlign: "center", color: "var(--ink-3)", padding: 24 }}
                  >
                    No sessions recorded yet.
                  </td>
                </tr>
              ) : (
                visible.map((s) => {
                  const statusInfo = STATUS_CHIP[s.status] ?? STATUS_CHIP.planned;
                  return (
                    <tr key={s.id}>
                      <td className="mono" style={{ fontSize: 12 }}>
                        {s.scheduledDate}
                      </td>
                      <td className="mono" style={{ fontSize: 12 }}>
                        {s.scheduledTime ?? "—"}
                      </td>
                      <td>{s.schoolCode ?? "—"}</td>
                      <td>{s.grade ?? "—"}</td>
                      <td>{s.subjectName ?? "—"}</td>
                      <td>{s.topic ?? "—"}</td>
                      <td>
                        {s.teacherName ?? "—"}
                        {s.teacherHindi ? (
                          <span
                            className="deva"
                            style={{
                              fontFamily: "var(--deva)",
                              color: "var(--ink-3)",
                              marginLeft: 6,
                              fontSize: 12,
                            }}
                          >
                            {s.teacherHindi}
                          </span>
                        ) : null}
                      </td>
                      <td>
                        <span className={`chip ${statusInfo.kind}`.trim()}>{statusInfo.label}</span>
                      </td>
                      <td style={{ textAlign: "right" }}>
                        <Link
                          href={`/repo/session/${s.id}`}
                          className="btn btn-sm btn-primary"
                          style={{ textDecoration: "none" }}
                        >
                          Open →
                        </Link>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
