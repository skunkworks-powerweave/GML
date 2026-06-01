// /repo/class/[id] — class detail: school + grade + stage + subjects taught at this grade
// + recent classroom sessions. PII-free (no learner names). The "View roster" link in the
// right column is conditionally rendered for super_admin / programme_admin only — clicking
// through to /learners is what triggers the SM-9 audit hook (see ./learners/page.tsx).

import { notFound } from "next/navigation";
import Link from "next/link";
import { and, desc, eq, gte, isNull, lte, or } from "drizzle-orm";
import { db } from "@gml/db";
import { classes, schools, subjects, sessions, teachers } from "@gml/db/schema";
import { auth } from "@/auth";

export const dynamic = "force-dynamic";

const STAGE_CHIP: Record<string, { bg: string; ink: string }> = {
  Primary: { bg: "var(--lichen-soft)", ink: "var(--lichen)" },
  Middle: { bg: "var(--indigo-soft)", ink: "var(--indigo)" },
  High: { bg: "var(--saffron-soft)", ink: "var(--saffron)" },
};

const STATUS_CHIP: Record<string, { bg: string; ink: string; label: string }> = {
  planned: { bg: "var(--paper-2)", ink: "var(--ink-3)", label: "Planned" },
  in_progress: { bg: "var(--saffron-soft)", ink: "var(--saffron)", label: "In progress" },
  complete: { bg: "var(--lichen-soft)", ink: "var(--lichen)", label: "Complete" },
  cancelled: { bg: "var(--rust-soft)", ink: "var(--rust)", label: "Cancelled" },
};

export default async function RepoClassDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  const role = session?.user?.role ?? "teacher";
  const canSeeRoster = role === "super_admin" || role === "programme_admin";

  const [cls] = await db.select().from(classes).where(eq(classes.id, id)).limit(1);
  if (!cls) notFound();

  const [school] = await db.select().from(schools).where(eq(schools.id, cls.schoolId)).limit(1);

  // Subjects whose [gradesMin..gradesMax] window covers this class's grade (NULLs treated as open-ended).
  const subjectRows = await db
    .select()
    .from(subjects)
    .where(
      and(
        eq(subjects.active, true),
        or(isNull(subjects.gradesMin), lte(subjects.gradesMin, cls.grade)),
        or(isNull(subjects.gradesMax), gte(subjects.gradesMax, cls.grade)),
      ),
    )
    .orderBy(subjects.displayOrder, subjects.name);

  // Recent classroom sessions for this class — LEFT JOIN subject + teacher for display.
  const sessionRows = await db
    .select({
      id: sessions.id,
      scheduledDate: sessions.scheduledDate,
      scheduledTime: sessions.scheduledTime,
      topic: sessions.topic,
      status: sessions.status,
      subjectName: subjects.name,
      teacherName: teachers.fullName,
      teacherHindi: teachers.hindiName,
    })
    .from(sessions)
    .leftJoin(subjects, eq(sessions.subjectId, subjects.id))
    .leftJoin(teachers, eq(sessions.teacherId, teachers.id))
    .where(eq(sessions.classId, id))
    .orderBy(desc(sessions.scheduledDate))
    .limit(12);

  const stage = STAGE_CHIP[cls.stage] ?? STAGE_CHIP.Primary;

  return (
    <div>
      <header style={{ marginBottom: 20 }}>
        <Link
          href={school ? `/repo/school/${school.id}` : "/repo"}
          style={{ fontSize: 12, color: "var(--ink-3)", textDecoration: "none" }}
        >
          ← {school?.code ?? "Repository"}
        </Link>
        <div
          style={{
            fontSize: 10,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            color: "var(--ink-3)",
            marginTop: 8,
          }}
        >
          Class · {school?.code ?? "—"}
        </div>
        <h1 style={{ fontFamily: "var(--serif)", fontSize: 28, marginTop: 4 }}>Grade {cls.grade}</h1>
        <p style={{ color: "var(--ink-3)", fontSize: 13, marginTop: 4 }}>
          {cls.studentsCount} students across {cls.sectionsCount} section
          {cls.sectionsCount > 1 ? "s" : ""}
          {cls.classTeacherName ? `. Class teacher ${cls.classTeacherName}.` : "."}
        </p>
      </header>

      <section style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr", gap: 18 }}>
        <div style={{ display: "grid", gap: 16 }}>
          {/* Subjects taught at this grade */}
          <article
            style={{
              background: "var(--card-hi)",
              border: "1px solid var(--line)",
              borderRadius: "var(--r-3)",
              padding: 16,
            }}
          >
            <header style={{ marginBottom: 10 }}>
              <h2 style={{ fontFamily: "var(--serif)", fontSize: 16, margin: 0 }}>
                Subjects ({subjectRows.length})
              </h2>
              <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>Taught at this grade</div>
            </header>
            {subjectRows.length === 0 ? (
              <p style={{ fontSize: 12, color: "var(--ink-3)" }}>No subjects mapped to this grade yet.</p>
            ) : (
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr
                    style={{
                      textAlign: "left",
                      fontSize: 10,
                      textTransform: "uppercase",
                      letterSpacing: "0.06em",
                      color: "var(--ink-3)",
                    }}
                  >
                    <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--line)" }}>Subject</th>
                    <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--line)" }}>Grades covered</th>
                    <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--line)" }}>Code</th>
                  </tr>
                </thead>
                <tbody>
                  {subjectRows.map((s) => (
                    <tr key={s.id}>
                      <td
                        style={{
                          padding: "8px",
                          borderBottom: "1px solid var(--hairline)",
                          fontWeight: 500,
                        }}
                      >
                        {s.color ? (
                          <span
                            aria-hidden
                            style={{
                              display: "inline-block",
                              width: 8,
                              height: 8,
                              borderRadius: 999,
                              background: s.color.startsWith("var(") ? s.color : s.color,
                              marginRight: 8,
                              verticalAlign: "middle",
                            }}
                          />
                        ) : null}
                        {s.name}
                      </td>
                      <td
                        style={{
                          padding: "8px",
                          borderBottom: "1px solid var(--hairline)",
                          fontFamily: "var(--mono)",
                          fontSize: 12,
                          color: "var(--ink-3)",
                        }}
                      >
                        {s.gradesMin ?? 1}–{s.gradesMax ?? 12}
                      </td>
                      <td
                        style={{
                          padding: "8px",
                          borderBottom: "1px solid var(--hairline)",
                          fontFamily: "var(--mono)",
                          fontSize: 12,
                          color: "var(--ink-3)",
                        }}
                      >
                        {s.code}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </article>

          {/* Sessions held in this class */}
          <article
            style={{
              background: "var(--card-hi)",
              border: "1px solid var(--line)",
              borderRadius: "var(--r-3)",
              padding: 16,
            }}
          >
            <header style={{ marginBottom: 10 }}>
              <h2 style={{ fontFamily: "var(--serif)", fontSize: 16, margin: 0 }}>
                Sessions held ({sessionRows.length})
              </h2>
              <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>Most recent first</div>
            </header>
            {sessionRows.length === 0 ? (
              <p style={{ fontSize: 12, color: "var(--ink-3)" }}>No classroom sessions logged yet.</p>
            ) : (
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr
                    style={{
                      textAlign: "left",
                      fontSize: 10,
                      textTransform: "uppercase",
                      letterSpacing: "0.06em",
                      color: "var(--ink-3)",
                    }}
                  >
                    <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--line)" }}>Date</th>
                    <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--line)" }}>Time</th>
                    <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--line)" }}>Subject</th>
                    <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--line)" }}>Topic</th>
                    <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--line)" }}>Teacher</th>
                    <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--line)" }}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {sessionRows.map((s) => {
                    const pill = STATUS_CHIP[s.status] ?? STATUS_CHIP.planned;
                    return (
                      <tr key={s.id}>
                        <td
                          style={{
                            padding: "8px",
                            borderBottom: "1px solid var(--hairline)",
                            fontFamily: "var(--mono)",
                            fontSize: 12,
                          }}
                        >
                          {new Date(`${s.scheduledDate}T00:00:00`).toLocaleDateString("en-IN", {
                            day: "numeric",
                            month: "short",
                          })}
                        </td>
                        <td
                          style={{
                            padding: "8px",
                            borderBottom: "1px solid var(--hairline)",
                            fontFamily: "var(--mono)",
                            fontSize: 12,
                            color: "var(--ink-3)",
                          }}
                        >
                          {s.scheduledTime ? String(s.scheduledTime).slice(0, 5) : "—"}
                        </td>
                        <td style={{ padding: "8px", borderBottom: "1px solid var(--hairline)" }}>
                          {s.subjectName ?? "—"}
                        </td>
                        <td
                          style={{
                            padding: "8px",
                            borderBottom: "1px solid var(--hairline)",
                            color: "var(--ink-2)",
                          }}
                        >
                          {s.topic ?? "—"}
                        </td>
                        <td style={{ padding: "8px", borderBottom: "1px solid var(--hairline)" }}>
                          {s.teacherName ?? "—"}
                          {s.teacherHindi ? (
                            <span
                              style={{
                                fontFamily: "var(--deva)",
                                color: "var(--ink-3)",
                                marginLeft: 8,
                                fontSize: 12,
                              }}
                            >
                              {s.teacherHindi}
                            </span>
                          ) : null}
                        </td>
                        <td style={{ padding: "8px", borderBottom: "1px solid var(--hairline)" }}>
                          <span
                            style={{
                              padding: "2px 8px",
                              background: pill.bg,
                              color: pill.ink,
                              borderRadius: 999,
                              fontSize: 10,
                              textTransform: "uppercase",
                              letterSpacing: "0.06em",
                              fontWeight: 600,
                            }}
                          >
                            {pill.label}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </article>
        </div>

        <aside style={{ display: "grid", gap: 16, alignContent: "start" }}>
          {/* Details KV */}
          <article
            style={{
              background: "var(--card-hi)",
              border: "1px solid var(--line)",
              borderRadius: "var(--r-3)",
              padding: 16,
            }}
          >
            <header style={{ marginBottom: 6 }}>
              <h2 style={{ fontFamily: "var(--serif)", fontSize: 16, margin: 0 }}>Details</h2>
            </header>
            <div style={{ padding: "0 0 4px" }}>
              <KVRow label="School">
                {school ? (
                  <Link
                    href={`/repo/school/${school.id}`}
                    style={{ color: "var(--indigo)", textDecoration: "none" }}
                  >
                    {school.code} · {school.name}
                  </Link>
                ) : (
                  "—"
                )}
              </KVRow>
              <KVRow label="Grade">{cls.grade}</KVRow>
              <KVRow label="Stage">
                <span
                  style={{
                    padding: "2px 8px",
                    background: stage.bg,
                    color: stage.ink,
                    borderRadius: 999,
                    fontSize: 10,
                    textTransform: "uppercase",
                    letterSpacing: "0.06em",
                    fontWeight: 600,
                  }}
                >
                  {cls.stage}
                </span>
              </KVRow>
              <KVRow label="Students">{cls.studentsCount}</KVRow>
              <KVRow label="Sections">{cls.sectionsCount}</KVRow>
              <KVRow label="Class teacher">{cls.classTeacherName ?? "—"}</KVRow>
              <KVRow label="Status">{cls.active ? "Active" : "Inactive"}</KVRow>
            </div>
          </article>

          {/* PII-gated link to the learner roster */}
          {canSeeRoster ? (
            <Link
              href={`/repo/class/${id}/learners`}
              style={{
                background: "var(--card-hi)",
                border: "1px solid var(--line)",
                borderRadius: "var(--r-3)",
                padding: 16,
                textDecoration: "none",
                color: "var(--ink)",
                display: "block",
              }}
            >
              <div
                style={{
                  fontSize: 10,
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                  color: "var(--ink-3)",
                }}
              >
                Roster · PII (audited)
              </div>
              <div style={{ fontWeight: 500, marginTop: 4, fontSize: 14 }}>View learners ({cls.studentsCount}) →</div>
              <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 4 }}>
                SM-9: opening this list writes an audit_log entry.
              </div>
            </Link>
          ) : (
            <div
              style={{
                background: "var(--paper-2)",
                border: "1px dashed var(--line)",
                borderRadius: "var(--r-3)",
                padding: 16,
                fontSize: 11,
                color: "var(--ink-3)",
              }}
            >
              Full learner roster restricted (PII). Programme admins only.
            </div>
          )}
        </aside>
      </section>
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
      <span
        style={{
          fontSize: 11,
          color: "var(--ink-3)",
          textTransform: "uppercase",
          letterSpacing: "0.07em",
          fontWeight: 500,
          paddingTop: 2,
        }}
      >
        {label}
      </span>
      <div style={{ fontSize: 13, display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
        {children}
      </div>
    </div>
  );
}
