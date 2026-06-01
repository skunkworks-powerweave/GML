// /repo — Repository home. 1:1 port of `RepoHome` in `LMS GML Frontend/repository.jsx`
// (lines 40-134). Swaps the prototype's window.WIKI / window.LMS globals for live
// Drizzle counts + a this-week classroom-sessions query joined to schools/subjects.

import Link from "next/link";
import { and, asc, between, count, eq } from "drizzle-orm";
import { db } from "@gml/db";
import {
  classes,
  courseOutlines,
  learners,
  mentors,
  resources,
  schools,
  sessions,
  subjects,
  teachers,
} from "@gml/db/schema";

export const dynamic = "force-dynamic";

// ---------- date helpers (ISO week, Mon–Fri) ----------
function currentWeekMonFri(today: Date = new Date()): { mon: string; fri: string; monLabel: string; friLabel: string } {
  // JS getDay(): Sun=0, Mon=1 ... Sat=6. We want Monday of the current week.
  const d = new Date(today);
  d.setHours(0, 0, 0, 0);
  const dow = d.getDay(); // 0..6
  const diffToMon = (dow + 6) % 7; // Mon=0, Tue=1 ... Sun=6
  const mon = new Date(d);
  mon.setDate(d.getDate() - diffToMon);
  const fri = new Date(mon);
  fri.setDate(mon.getDate() + 4);
  const iso = (x: Date) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
  const label = (x: Date) =>
    x.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
  return { mon: iso(mon), fri: iso(fri), monLabel: label(mon), friLabel: label(fri) + " " + fri.getFullYear() };
}

// ---------- session status pill (matches JSX SessionStatus) ----------
const SESSION_STATUS: Record<string, { label: string; bg: string; ink: string }> = {
  planned: { label: "Planned", bg: "var(--paper-2)", ink: "var(--ink-3)" },
  in_progress: { label: "In progress", bg: "var(--saffron-soft)", ink: "var(--saffron)" },
  complete: { label: "Complete", bg: "var(--lichen-soft)", ink: "var(--lichen)" },
  cancelled: { label: "Cancelled", bg: "var(--paper-2)", ink: "var(--ink-3)" },
};

// ---------- inline glyphs (replace window-bound `<Icon name=…/>`) ----------
function Glyph({ name, size = 14 }: { name: string; size?: number }) {
  // tiny pictogram set — kept inline so the route is self-contained.
  const stroke = "var(--ink-3)";
  const sw = 1.5;
  const common = { width: size, height: size, viewBox: "0 0 16 16", fill: "none", stroke, strokeWidth: sw, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  switch (name) {
    case "search":
      return (
        <svg {...common}><circle cx="7" cy="7" r="4.5" /><path d="M11 11l3 3" /></svg>
      );
    case "school":
      return (
        <svg {...common}><path d="M2 6l6-3 6 3-6 3-6-3z" /><path d="M4 8v4c0 .8 1.8 1.5 4 1.5s4-.7 4-1.5V8" /></svg>
      );
    case "book":
      return (
        <svg {...common}><path d="M3 3h7a2 2 0 0 1 2 2v8H5a2 2 0 0 1-2-2V3z" /><path d="M3 3v10" /></svg>
      );
    case "filter":
      return (
        <svg {...common}><path d="M2 3h12l-4.5 5.5V13l-3 1V8.5L2 3z" /></svg>
      );
    case "cycle":
      return (
        <svg {...common}><path d="M3 8a5 5 0 0 1 9-3" /><path d="M13 8a5 5 0 0 1-9 3" /><path d="M12 3v2.5h-2.5" /><path d="M4 13v-2.5h2.5" /></svg>
      );
    case "users":
      return (
        <svg {...common}><circle cx="6" cy="6" r="2.5" /><path d="M2 13c0-2.2 1.8-4 4-4s4 1.8 4 4" /><circle cx="11" cy="6.5" r="2" /><path d="M10 13c0-2 1.4-3.5 3.5-3.5" /></svg>
      );
    case "file":
      return (
        <svg {...common}><path d="M4 2h5l3 3v9H4z" /><path d="M9 2v3h3" /></svg>
      );
    case "chev":
      return (
        <svg {...common}><path d="M6 4l4 4-4 4" /></svg>
      );
    default:
      return null;
  }
}

export default async function RepoHomePage() {
  // ---------- 8 parallel count queries ----------
  const { mon, fri, monLabel, friLabel } = currentWeekMonFri();

  const [
    schoolsCount,
    classesCount,
    subjectsCount,
    outlinesCount,
    sessionsCount,
    teachersCount,
    mentorsCount,
    learnersCount,
    resourcesCount,
  ] = await Promise.all([
    db.select({ c: count() }).from(schools),
    db.select({ c: count() }).from(classes),
    db.select({ c: count() }).from(subjects),
    db.select({ c: count() }).from(courseOutlines),
    db.select({ c: count() }).from(sessions),
    db.select({ c: count() }).from(teachers),
    db.select({ c: count() }).from(mentors),
    db.select({ c: count() }).from(learners),
    db.select({ c: count() }).from(resources),
  ]);

  const stats = {
    schools: schoolsCount[0]?.c ?? 0,
    classes: classesCount[0]?.c ?? 0,
    subjects: subjectsCount[0]?.c ?? 0,
    outlines: outlinesCount[0]?.c ?? 0,
    sessions: sessionsCount[0]?.c ?? 0,
    teachers: teachersCount[0]?.c ?? 0,
    mentors: mentorsCount[0]?.c ?? 0,
    learners: learnersCount[0]?.c ?? 0,
    resources: resourcesCount[0]?.c ?? 0,
  };

  // ---------- this-week sessions table (Mon..Fri, top 8) ----------
  const thisWeek = await db
    .select({
      id: sessions.id,
      date: sessions.scheduledDate,
      time: sessions.scheduledTime,
      grade: classes.grade,
      topic: sessions.topic,
      status: sessions.status,
      schoolCode: schools.code,
      subjectName: subjects.name,
    })
    .from(sessions)
    .leftJoin(schools, eq(sessions.schoolId, schools.id))
    .leftJoin(classes, eq(sessions.classId, classes.id))
    .leftJoin(subjects, eq(sessions.subjectId, subjects.id))
    .where(and(between(sessions.scheduledDate, mon, fri)))
    .orderBy(asc(sessions.scheduledDate), asc(sessions.scheduledTime))
    .limit(8);

  const browse: { id: string; label: string; n: number; icon: string }[] = [
    { id: "schools", label: "Schools", n: stats.schools, icon: "school" },
    { id: "subjects", label: "Subjects", n: stats.subjects, icon: "book" },
    { id: "outlines", label: "Course outlines", n: stats.outlines, icon: "filter" },
    { id: "sessions", label: "Sessions", n: stats.sessions, icon: "cycle" },
    { id: "teachers", label: "Teachers", n: stats.teachers, icon: "users" },
    { id: "mentors", label: "Mentors", n: stats.mentors, icon: "users" },
    { id: "learners", label: "Learners", n: stats.learners, icon: "users" },
    { id: "resources", label: "Reading material", n: stats.resources, icon: "file" },
  ];

  return (
    <div>
      {/* page-header */}
      <header style={{ marginBottom: 18 }}>
        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16 }}>
          <div>
            <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--ink-3)" }}>
              Repository
            </div>
            <h1 style={{ fontFamily: "var(--serif)", fontSize: 28, marginTop: 4 }}>Programme records</h1>
            <p style={{ color: "var(--ink-3)", marginTop: 4, maxWidth: 640, fontSize: 13 }}>
              The complete organizational record: schools, classes, subjects taught, sessions held,
              course outlines, learners and reading material. Every record links to the others.
            </p>
          </div>
          <button
            type="button"
            style={{
              padding: "7px 12px",
              background: "var(--card-hi)",
              color: "var(--ink)",
              border: "1px solid var(--line-2)",
              borderRadius: "var(--r-2)",
              fontSize: 12,
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              fontFamily: "var(--sans)",
            }}
          >
            <Glyph name="search" /> Find a record
          </button>
        </div>
      </header>

      {/* page-body */}
      <div style={{ display: "grid", gap: 16 }}>
        {/* 5-stat row */}
        <section style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 14 }}>
          <StatCard label="Schools" value={stats.schools} hint={stats.schools ? "2 districts" : undefined} />
          <StatCard label="Classes" value={stats.classes} />
          <StatCard label="Subjects" value={stats.subjects} hint="Grades 1–10" />
          <StatCard label="Sessions logged" value={stats.sessions} hint="Term to date" />
          <StatCard label="Resources" value={stats.resources} />
        </section>

        {/* 2-column body grid */}
        <section style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 18 }}>
          {/* This week's sessions */}
          <article
            style={{
              background: "var(--card)",
              border: "1px solid var(--line)",
              borderRadius: "var(--r-3)",
              overflow: "hidden",
            }}
          >
            <header
              style={{
                display: "flex",
                alignItems: "flex-end",
                justifyContent: "space-between",
                padding: "14px 16px",
                borderBottom: "1px solid var(--line)",
                gap: 8,
              }}
            >
              <div>
                <div style={{ fontFamily: "var(--serif)", fontSize: 18 }}>This week&apos;s sessions</div>
                <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>
                  {monLabel} → {friLabel}
                </div>
              </div>
              <Link
                href="/repo/sessions"
                style={{
                  padding: "5px 10px",
                  background: "var(--card-hi)",
                  color: "var(--ink-2)",
                  border: "1px solid var(--line-2)",
                  borderRadius: "var(--r-2)",
                  fontSize: 11,
                  textDecoration: "none",
                }}
              >
                All sessions →
              </Link>
            </header>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--line)", background: "var(--paper-2)" }}>
                    {["Date", "Time", "School", "Grade", "Subject", "Topic", "Status"].map((h) => (
                      <th
                        key={h}
                        style={{
                          textAlign: "left",
                          padding: "8px 12px",
                          fontSize: 10,
                          textTransform: "uppercase",
                          letterSpacing: "0.07em",
                          color: "var(--ink-3)",
                          fontWeight: 500,
                        }}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {thisWeek.length === 0 ? (
                    <tr>
                      <td colSpan={7} style={{ padding: 20, color: "var(--ink-3)", textAlign: "center" }}>
                        No sessions scheduled this week.
                      </td>
                    </tr>
                  ) : (
                    thisWeek.map((s) => {
                      const st = SESSION_STATUS[s.status] ?? SESSION_STATUS.planned;
                      return (
                        <tr key={s.id} style={{ borderTop: "1px solid var(--line)" }}>
                          <td style={{ padding: "10px 12px", fontFamily: "var(--mono)", fontSize: 12 }}>
                            <Link href={`/repo/sessions/${s.id}`} style={{ color: "var(--ink)", textDecoration: "none" }}>
                              {s.date}
                            </Link>
                          </td>
                          <td style={{ padding: "10px 12px", fontFamily: "var(--mono)", fontSize: 12, color: "var(--ink-2)" }}>
                            {s.time ?? "—"}
                          </td>
                          <td style={{ padding: "10px 12px" }}>{s.schoolCode ?? "—"}</td>
                          <td style={{ padding: "10px 12px" }}>{s.grade ?? "—"}</td>
                          <td style={{ padding: "10px 12px" }}>{s.subjectName ?? "—"}</td>
                          <td style={{ padding: "10px 12px", color: "var(--ink-2)" }}>{s.topic ?? "—"}</td>
                          <td style={{ padding: "10px 12px" }}>
                            <span
                              style={{
                                display: "inline-block",
                                padding: "2px 8px",
                                background: st.bg,
                                color: st.ink,
                                borderRadius: 999,
                                fontSize: 10,
                                textTransform: "uppercase",
                                letterSpacing: "0.06em",
                                fontWeight: 600,
                              }}
                            >
                              {st.label}
                            </span>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </article>

          {/* Browse */}
          <article
            style={{
              background: "var(--card)",
              border: "1px solid var(--line)",
              borderRadius: "var(--r-3)",
              overflow: "hidden",
            }}
          >
            <header style={{ padding: "14px 16px", borderBottom: "1px solid var(--line)" }}>
              <div style={{ fontFamily: "var(--serif)", fontSize: 18 }}>Browse</div>
            </header>
            <div style={{ padding: 4 }}>
              {browse.map((b, i) => (
                <Link
                  key={b.id}
                  href={`/repo/${b.id}`}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    padding: "10px 12px",
                    borderTop: i ? "1px solid var(--line)" : "none",
                    textDecoration: "none",
                    color: "var(--ink)",
                  }}
                >
                  <Glyph name={b.icon} size={14} />
                  <span style={{ flex: 1, fontWeight: 500, fontSize: 13 }}>{b.label}</span>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--ink-3)" }}>{b.n}</span>
                  <Glyph name="chev" size={11} />
                </Link>
              ))}
            </div>
          </article>
        </section>
      </div>
    </div>
  );
}

// ---------- StatCard component (matches prototype `<Stat …/>`) ----------
function StatCard({ label, value, hint }: { label: string; value: number | string; hint?: string }) {
  return (
    <div
      style={{
        background: "var(--card-hi)",
        border: "1px solid var(--line)",
        borderRadius: "var(--r-3)",
        padding: 14,
        display: "flex",
        flexDirection: "column",
        gap: 4,
        minHeight: 78,
      }}
    >
      <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--ink-3)", fontWeight: 500 }}>
        {label}
      </div>
      <div style={{ fontFamily: "var(--serif)", fontSize: 28, lineHeight: 1, color: "var(--ink)" }}>
        {value}
      </div>
      {hint ? (
        <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>{hint}</div>
      ) : null}
    </div>
  );
}
