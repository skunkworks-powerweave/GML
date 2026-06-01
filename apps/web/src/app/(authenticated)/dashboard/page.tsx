// Role-aware dashboard — 1:1 ports `LMS GML Frontend/dashboard.jsx`.

import { count, eq } from "drizzle-orm";
import { db } from "@gml/db";
import { auth } from "@/auth";
import {
  mentorPairings,
  observationCycles,
  videoSubmissions,
  teachers,
  schools,
  mentors,
} from "@gml/db/schema";
import { redirect } from "next/navigation";
import Link from "next/link";

export const dynamic = "force-dynamic";

type Stat = { label: string; value: string | number; hint?: string };

async function getCounts() {
  const [pairingsTotal, cyclesTotal, teachersTotal, schoolsTotal, mentorsTotal, videosReady] = await Promise.all([
    db.select({ c: count() }).from(mentorPairings),
    db.select({ c: count() }).from(observationCycles),
    db.select({ c: count() }).from(teachers),
    db.select({ c: count() }).from(schools),
    db.select({ c: count() }).from(mentors),
    db.select({ c: count() }).from(videoSubmissions).where(eq(videoSubmissions.status, "ready")),
  ]);
  return {
    pairings: pairingsTotal[0]?.c ?? 0,
    cycles: cyclesTotal[0]?.c ?? 0,
    teachers: teachersTotal[0]?.c ?? 0,
    schools: schoolsTotal[0]?.c ?? 0,
    mentors: mentorsTotal[0]?.c ?? 0,
    videosReady: videosReady[0]?.c ?? 0,
  };
}

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const role = session.user.role ?? "teacher";
  const name = session.user.name ?? session.user.email ?? "there";
  const counts = await getCounts();

  const stats: Stat[] =
    role === "super_admin" || role === "programme_admin"
      ? [
          { label: "Teachers", value: counts.teachers, hint: `across ${counts.schools} schools` },
          { label: "Active pairings", value: counts.pairings, hint: `${counts.mentors} mentors` },
          { label: "Observation cycles", value: counts.cycles, hint: "this term" },
          { label: "Videos ready", value: counts.videosReady, hint: "awaiting review" },
        ]
      : role === "mentor"
        ? [
            { label: "Active mentees", value: counts.pairings, hint: `of ${counts.teachers} teachers` },
            { label: "Observation cycles", value: counts.cycles, hint: "this term" },
            { label: "Pending video reviews", value: counts.videosReady, hint: "target: < 48 h" },
            { label: "Schools you cover", value: counts.schools },
          ]
        : role === "observer"
          ? [
              { label: "Observation cycles", value: counts.cycles },
              { label: "Schools", value: counts.schools },
              { label: "Videos ready", value: counts.videosReady },
              { label: "Teachers", value: counts.teachers },
            ]
          : [
              { label: "My phase progress", value: "Term 2 · Week 7" },
              { label: "My observations", value: counts.cycles },
              { label: "My uploads", value: counts.videosReady },
              { label: "Resources available", value: "—" },
            ];

  const greeting = (() => {
    const h = new Date().getUTCHours();
    if (h < 5) return "Late night";
    if (h < 12) return "Good morning";
    if (h < 17) return "Good afternoon";
    return "Good evening";
  })();

  const firstName = name.replace(/^(Dr\.|Prof\.|Mr\.|Ms\.|Mrs\.|Mohd\.)\s+/i, "").split(/\s+/)[0];

  const roleLabel = role.replace("_", " ");

  return (
    <div>
      <div className="page-header">
        <div className="label">{roleLabel} dashboard</div>
        <h1 className="serif" style={{ fontSize: 30, marginTop: 4 }}>
          {greeting}, {firstName}.
        </h1>
        <p style={{ color: "var(--ink-3)", marginTop: 6 }}>
          {new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
          {" · Term 2 Week 7 of 12 · "}
          {role === "teacher" ? "RTT Phase 2" : `${roleLabel} view`}
        </p>
      </div>

      <div className="page-body" style={{ display: "grid", gap: 18 }}>
        <section
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            gap: 14,
          }}
        >
          {stats.map((s) => (
            <article key={s.label} className="card card-hi" style={{ padding: 14 }}>
              <div className="label">{s.label}</div>
              <div className="serif" style={{ fontSize: 32, marginTop: 6 }}>
                {s.value}
              </div>
              {s.hint ? (
                <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>{s.hint}</div>
              ) : null}
            </article>
          ))}
        </section>

        <section style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 18 }}>
          <article className="card card-hi">
            <header style={{ padding: 14, borderBottom: "1px solid var(--line)" }}>
              <h2 className="serif" style={{ fontSize: 16, fontWeight: 600 }}>
                {role === "teacher" ? "What's next" : "Today"}
              </h2>
              <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>
                {role === "teacher" ? "Your training queue + observation prep." : "Things waiting on you."}
              </div>
            </header>
            <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
              <TodoRow text="Review pending video submissions" href="/videos" />
              <TodoRow text="Confirm school visits this week" href="/observation" />
              <TodoRow text="Check today's cohort attendance" href="/admin/data/rtt-attendance" />
            </div>
          </article>

          <article className="card card-hi">
            <header style={{ padding: 14, borderBottom: "1px solid var(--line)" }}>
              <h2 className="serif" style={{ fontSize: 16, fontWeight: 600 }}>
                Confidentiality
              </h2>
              <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>
                Reminder for every viewer.
              </div>
            </header>
            <div style={{ padding: 14 }}>
              <p style={{ fontSize: 12, color: "var(--ink-2)", lineHeight: 1.5 }}>
                All resources here are confidential. Videos are watermarked with your name and timestamp; downloads are
                disabled. Section passwords rotate periodically — ask your programme admin if a section appears locked.
              </p>
              <Link
                href="/inbox"
                style={{ fontSize: 12, color: "var(--indigo)", display: "inline-block", marginTop: 10 }}
              >
                Notifications →
              </Link>
            </div>
          </article>
        </section>
      </div>
    </div>
  );
}

function TodoRow({ text, href }: { text: string; href: string }) {
  return (
    <Link
      href={href}
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        padding: "8px 10px",
        border: "1px solid var(--line)",
        borderRadius: "var(--r-2)",
        background: "var(--paper)",
        fontSize: 13,
        color: "var(--ink-2)",
        textDecoration: "none",
      }}
    >
      <span>{text}</span>
      <span style={{ fontSize: 12, color: "var(--ink-3)" }}>→</span>
    </Link>
  );
}
