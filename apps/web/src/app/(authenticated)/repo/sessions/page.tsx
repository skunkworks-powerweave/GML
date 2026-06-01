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

const STATUS_COLOR: Record<string, { bg: string; ink: string; label: string }> = {
  planned: { bg: "var(--paper-2)", ink: "var(--ink-2)", label: "Planned" },
  in_progress: { bg: "var(--saffron-soft)", ink: "var(--saffron)", label: "In progress" },
  complete: { bg: "var(--lichen-soft)", ink: "var(--lichen)", label: "Complete" },
  cancelled: { bg: "var(--paper-2)", ink: "var(--ink-3)", label: "Cancelled" },
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
      <header style={{ marginBottom: 22 }}>
        <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--ink-3)" }}>
          Repository
        </div>
        <h1 style={{ fontFamily: "var(--serif)", fontSize: 28, marginTop: 4 }}>Sessions</h1>
        <p style={{ color: "var(--ink-3)", fontSize: 13, marginTop: 4, maxWidth: 720 }}>
          Every classroom session held — planned, in progress and complete. Each session links to its
          school, class, subject, teacher and course outline.
        </p>
      </header>

      <section style={{ display: "grid", gap: 16 }}>
        {/* Filter card */}
        <div
          style={{
            background: "var(--card-hi)",
            border: "1px solid var(--line)",
            borderRadius: "var(--r-3)",
            padding: 10,
            display: "flex",
            gap: 12,
            alignItems: "center",
            flexWrap: "wrap",
          }}
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
                  style={{
                    background: active ? "var(--ink)" : "transparent",
                    color: active ? "var(--paper)" : "var(--ink-2)",
                    border: `1px solid ${active ? "var(--ink)" : "transparent"}`,
                    borderRadius: "var(--r-2)",
                    fontSize: 12,
                    padding: "5px 10px",
                    textDecoration: "none",
                    fontWeight: 500,
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
              style={{
                maxWidth: 200,
                padding: "5px 10px",
                fontSize: 12,
                fontFamily: "var(--sans)",
                background: "var(--paper)",
                border: "1px solid var(--line)",
                borderRadius: "var(--r-2)",
                color: "var(--ink-2)",
              }}
            >
              <option value="all">All subjects</option>
              {subjectOptions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <button
              type="submit"
              style={{
                fontSize: 12,
                padding: "5px 10px",
                background: "var(--paper-2)",
                color: "var(--ink-2)",
                border: "1px solid var(--line)",
                borderRadius: "var(--r-2)",
                cursor: "pointer",
              }}
            >
              Apply
            </button>
          </form>

          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <span
              style={{
                fontSize: 12,
                padding: "5px 10px",
                background: "var(--paper-2)",
                color: "var(--ink-3)",
                border: "1px solid var(--line)",
                borderRadius: "var(--r-2)",
              }}
            >
              {visible.length} shown
            </span>
          </div>
        </div>

        {/* Table card */}
        <div
          style={{
            background: "var(--card-hi)",
            border: "1px solid var(--line)",
            borderRadius: "var(--r-3)",
            overflow: "hidden",
          }}
        >
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr
                style={{
                  background: "var(--paper-2)",
                  textAlign: "left",
                  fontSize: 10,
                  textTransform: "uppercase",
                  letterSpacing: "0.07em",
                  color: "var(--ink-3)",
                }}
              >
                <th style={{ padding: "10px 12px", fontWeight: 500 }}>Date</th>
                <th style={{ padding: "10px 12px", fontWeight: 500 }}>Time</th>
                <th style={{ padding: "10px 12px", fontWeight: 500 }}>School</th>
                <th style={{ padding: "10px 12px", fontWeight: 500 }}>Grade</th>
                <th style={{ padding: "10px 12px", fontWeight: 500 }}>Subject</th>
                <th style={{ padding: "10px 12px", fontWeight: 500 }}>Topic</th>
                <th style={{ padding: "10px 12px", fontWeight: 500 }}>Teacher</th>
                <th style={{ padding: "10px 12px", fontWeight: 500 }}>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 ? (
                <tr>
                  <td
                    colSpan={9}
                    style={{ textAlign: "center", color: "var(--ink-3)", padding: 24, fontSize: 13 }}
                  >
                    No sessions recorded yet.
                  </td>
                </tr>
              ) : (
                visible.map((s, i) => {
                  const statusInfo = STATUS_COLOR[s.status] ?? STATUS_COLOR.planned;
                  return (
                    <tr
                      key={s.id}
                      style={{
                        borderTop: i ? "1px solid var(--line)" : "none",
                        fontSize: 13,
                      }}
                    >
                      <td style={{ padding: "10px 12px", fontFamily: "var(--mono)", fontSize: 12 }}>
                        {s.scheduledDate}
                      </td>
                      <td style={{ padding: "10px 12px", fontFamily: "var(--mono)", fontSize: 12 }}>
                        {s.scheduledTime ?? "—"}
                      </td>
                      <td style={{ padding: "10px 12px" }}>{s.schoolCode ?? "—"}</td>
                      <td style={{ padding: "10px 12px" }}>{s.grade ?? "—"}</td>
                      <td style={{ padding: "10px 12px" }}>
                        <span
                          style={{
                            padding: "2px 8px",
                            background: "var(--paper-2)",
                            color: s.subjectColor ?? "var(--ink-2)",
                            borderRadius: 999,
                            fontSize: 11,
                            fontWeight: 500,
                          }}
                        >
                          {s.subjectName ?? "—"}
                        </span>
                      </td>
                      <td style={{ padding: "10px 12px" }}>{s.topic ?? "—"}</td>
                      <td style={{ padding: "10px 12px" }}>
                        {s.teacherName ?? "—"}
                        {s.teacherHindi ? (
                          <span
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
                      <td style={{ padding: "10px 12px" }}>
                        <span
                          style={{
                            padding: "2px 8px",
                            background: statusInfo.bg,
                            color: statusInfo.ink,
                            borderRadius: 999,
                            fontSize: 10,
                            textTransform: "uppercase",
                            letterSpacing: "0.06em",
                            fontWeight: 600,
                          }}
                        >
                          {statusInfo.label}
                        </span>
                      </td>
                      <td style={{ padding: "10px 12px", textAlign: "right" }}>
                        <Link
                          href={`/repo/session/${s.id}`}
                          style={{
                            fontSize: 12,
                            padding: "4px 10px",
                            background: "var(--ink)",
                            color: "var(--paper)",
                            borderRadius: "var(--r-2)",
                            textDecoration: "none",
                          }}
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
      </section>
    </div>
  );
}
