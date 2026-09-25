// /repo — Repository home. 1:1 port of `RepoHome` in `LMS GML Frontend/repository.jsx`
// (lines 40-134). Swaps the prototype's window.WIKI / window.LMS globals for live
// Drizzle counts + a this-week classroom-sessions query joined to schools/subjects.
//
// Visual chrome: uses the .page-header / .page-body / .label / .btn / .card /
// table.t / .chip / .mono utility classes ported from the prototype's app.css —
// see globals.css for the canonical tokens (var(--serif), var(--mono), var(--r-3),
// var(--ink-3), var(--line)). No raw hex colours; everything routes through tokens.

import Link from "next/link";
import { QuickFindTrigger } from "@/components/quickfind/QuickFindTrigger";
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
// Maps to .chip + variant classes from globals.css (ported from app.css).
const SESSION_STATUS: Record<string, { label: string; kind: string }> = {
  planned: { label: "Planned", kind: "" },
  in_progress: { label: "In progress", kind: "chip-saffron" },
  complete: { label: "Complete", kind: "chip-lichen" },
  cancelled: { label: "Cancelled", kind: "" },
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

  const browse: { id: string; href?: string; label: string; n: number; icon: string }[] = [
    { id: "schools", label: "Schools", n: stats.schools, icon: "school" },
    { id: "subjects", label: "Subjects", n: stats.subjects, icon: "book" },
    { id: "outlines", label: "Course outlines", n: stats.outlines, icon: "filter" },
    { id: "sessions", label: "Sessions", n: stats.sessions, icon: "cycle" },
    { id: "teachers", label: "Teachers", n: stats.teachers, icon: "users" },
    { id: "mentors", label: "Mentors", n: stats.mentors, icon: "users" },
    // href is explicit: the Browse card derives its link from `id`, and the
    // learners page is served at /repo/students, so this one row 404d while
    // every other entry in the list happened to match its route name.
    { id: "learners", href: "/repo/students", label: "Learners", n: stats.learners, icon: "users" },
    { id: "resources", label: "Reading material", n: stats.resources, icon: "file" },
  ];

  return (
    <div>
      <div className="page-header">
        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16 }}>
          <div>
            <div className="label">Repository</div>
            <h1 style={{ fontFamily: "var(--serif)", fontSize: 28, marginTop: 4 }}>Programme records</h1>
            <p style={{ color: "var(--ink-3)", marginTop: 4, maxWidth: 640 }}>
              The complete organizational record: schools, classes, subjects taught, sessions held,
              course outlines, learners and reading material. Every record links to the others.
            </p>
          </div>
          {/* Was a bare <button type="button"> with no handler, inside an async
              Server Component that cannot carry one -- it did nothing at all
              when clicked. QuickFindTrigger is the client island that reaches
              the QuickFind panel mounted in the authenticated layout. */}
          <QuickFindTrigger>
            <Glyph name="search" /> Find a record
          </QuickFindTrigger>
        </div>
      </div>

      {/* PHONE WIDTH: these grids were inline repeat(5, 1fr) and "1.4fr 1fr",
          which hold at every width (114 px stat tiles, a 677 px page on a
          phone). Below 768 px the stats go two a row and the body stacks; the
          page column is minmax(0, 1fr) so the sessions table scrolls in its
          card instead of widening the page. */}
      <div className="page-body" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 16 }}>
        {/* 5-stat row */}
        <section className="grid grid-cols-2 gap-[14px] md:grid-cols-5">
          <StatCard label="Schools" value={stats.schools} hint={stats.schools ? "2 districts" : undefined} />
          <StatCard label="Classes" value={stats.classes} />
          <StatCard label="Subjects" value={stats.subjects} hint="Grades 1–10" />
          <StatCard label="Sessions logged" value={stats.sessions} hint="Term to date" />
          <StatCard label="Resources" value={stats.resources} />
        </section>

        {/* 2-column body grid */}
        <section className="grid grid-cols-1 gap-[18px] md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
          {/* This week's sessions */}
          <article className="card">
            <div style={{ display: "flex", alignItems: "center", padding: "12px 14px", borderBottom: "1px solid var(--line)" }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: 13 }}>This week&apos;s sessions</div>
                <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>
                  {monLabel} → {friLabel}
                </div>
              </div>
              <div style={{ marginLeft: "auto" }}>
                <Link href="/repo/sessions" className="btn btn-sm">
                  All sessions →
                </Link>
              </div>
            </div>
            <div style={{ overflowX: "auto" }}>
              <table className="t">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Time</th>
                    <th>School</th>
                    <th>Grade</th>
                    <th>Subject</th>
                    <th>Topic</th>
                    <th>Status</th>
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
                        <tr key={s.id}>
                          <td className="mono" style={{ fontSize: 12 }}>
                            {/* /repo/session/<id>, singular. The plural is the LIST route, so
                                every row in this table 404d. */}
                            <Link href={`/repo/session/${s.id}`} style={{ color: "var(--ink)", textDecoration: "none" }}>
                              {s.date}
                            </Link>
                          </td>
                          <td className="mono" style={{ fontSize: 12 }}>{s.time ?? "—"}</td>
                          <td>{s.schoolCode ?? "—"}</td>
                          <td>{s.grade ?? "—"}</td>
                          <td>{s.subjectName ?? "—"}</td>
                          <td>{s.topic ?? "—"}</td>
                          <td>
                            <span className={`chip ${st.kind}`.trim()}>{st.label}</span>
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
          <article className="card">
            <div style={{ display: "flex", alignItems: "center", padding: "12px 14px", borderBottom: "1px solid var(--line)" }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>Browse</div>
            </div>
            <div style={{ padding: 4 }}>
              {browse.map((b, i) => (
                <Link
                  key={b.id}
                  href={b.href ?? `/repo/${b.id}`}
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
                  <span className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>{b.n}</span>
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

// ---------- StatCard component (matches prototype `<Stat …/>` in ui.jsx) ----------
function StatCard({ label, value, hint }: { label: string; value: number | string; hint?: string }) {
  return (
    <div className="card" style={{ padding: 14 }}>
      <div className="label">{label}</div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 6 }}>
        <div style={{ fontSize: 26, fontWeight: 600, letterSpacing: "-0.02em", fontFamily: "var(--serif)" }}>
          {value}
        </div>
      </div>
      {hint ? (
        <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 4 }}>{hint}</div>
      ) : null}
    </div>
  );
}
