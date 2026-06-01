// /repo/schools — Repository: index of partner schools across Leh + Kargil.
// Port of repository.jsx::RepoSchoolsIndex (lines 152-221) — 1:1 visual fidelity.
// District filter is server-side via ?district= so the URL is shareable.

import Link from "next/link";
import { redirect } from "next/navigation";
import { asc, eq, sql } from "drizzle-orm";
import { db } from "@gml/db";
import {
  schools,
  zones,
  districts,
  teachers,
  classes,
  sessions as classroomSessions,
} from "@gml/db/schema";
import { auth } from "@/auth";

export const dynamic = "force-dynamic";

const READ_ROLES = new Set([
  "super_admin",
  "programme_admin",
  "mentor",
  "observer",
  "teacher",
]);

const DISTRICT_CHIP: Record<string, { bg: string; ink: string; label: string }> = {
  leh: { bg: "var(--indigo-soft)", ink: "var(--indigo)", label: "Leh" },
  kargil: { bg: "var(--saffron-soft)", ink: "var(--saffron)", label: "Kargil" },
  kgl: { bg: "var(--saffron-soft)", ink: "var(--saffron)", label: "Kargil" },
};

function chipFor(code: string | null | undefined) {
  if (!code) return { bg: "var(--paper-2)", ink: "var(--ink-3)", label: "—" };
  const k = code.toLowerCase();
  return DISTRICT_CHIP[k] ?? { bg: "var(--paper-2)", ink: "var(--ink-3)", label: code };
}

type SearchParams = Promise<{ district?: string }>;

export default async function RepoSchoolsIndexPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const session = await auth();
  const role = session?.user?.role ?? "teacher";
  if (!READ_ROLES.has(role)) {
    redirect("/forbidden");
  }

  const sp = await searchParams;
  const districtFilter = (sp.district ?? "all").toLowerCase();

  // Inline correlated counts so the index hits the DB in one round-trip.
  const teacherCounts = db
    .select({
      schoolId: teachers.schoolId,
      teachersTotal: sql<number>`count(*)::int`.as("teachers_total"),
    })
    .from(teachers)
    .where(eq(teachers.active, true))
    .groupBy(teachers.schoolId)
    .as("teacher_counts");

  const classCounts = db
    .select({
      schoolId: classes.schoolId,
      classesTotal: sql<number>`count(*)::int`.as("classes_total"),
    })
    .from(classes)
    .where(eq(classes.active, true))
    .groupBy(classes.schoolId)
    .as("class_counts");

  const sessionCounts = db
    .select({
      schoolId: classroomSessions.schoolId,
      sessionsTotal: sql<number>`count(*)::int`.as("sessions_total"),
    })
    .from(classroomSessions)
    .groupBy(classroomSessions.schoolId)
    .as("session_counts");

  const rows = await db
    .select({
      id: schools.id,
      code: schools.code,
      name: schools.name,
      zoneName: zones.name,
      districtName: districts.name,
      districtCode: districts.code,
      teachersTotal: teacherCounts.teachersTotal,
      classesTotal: classCounts.classesTotal,
      sessionsTotal: sessionCounts.sessionsTotal,
    })
    .from(schools)
    .leftJoin(zones, eq(schools.zoneId, zones.id))
    .leftJoin(districts, eq(zones.districtId, districts.id))
    .leftJoin(teacherCounts, eq(teacherCounts.schoolId, schools.id))
    .leftJoin(classCounts, eq(classCounts.schoolId, schools.id))
    .leftJoin(sessionCounts, eq(sessionCounts.schoolId, schools.id))
    .where(eq(schools.active, true))
    .orderBy(asc(schools.name))
    .limit(200);

  const matchesDistrict = (r: (typeof rows)[number]): boolean => {
    if (districtFilter === "all") return true;
    const dn = (r.districtName ?? "").toLowerCase();
    const dc = (r.districtCode ?? "").toLowerCase();
    if (districtFilter === "leh") return dn === "leh" || dc === "leh";
    if (districtFilter === "kgl" || districtFilter === "kargil") {
      return dn === "kargil" || dc === "kgl" || dc === "kargil";
    }
    return dn === districtFilter || dc === districtFilter;
  };

  const visible = rows.filter(matchesDistrict);

  const counts = {
    all: rows.length,
    leh: rows.filter((r) =>
      ["leh"].includes((r.districtName ?? "").toLowerCase()) ||
      (r.districtCode ?? "").toLowerCase() === "leh"
    ).length,
    kgl: rows.filter((r) =>
      ["kargil"].includes((r.districtName ?? "").toLowerCase()) ||
      ["kgl", "kargil"].includes((r.districtCode ?? "").toLowerCase())
    ).length,
  };

  const filterTabs = [
    { v: "all", l: "All", n: counts.all },
    { v: "leh", l: "Leh", n: counts.leh },
    { v: "kgl", l: "Kargil", n: counts.kgl },
  ];

  return (
    <div>
      <header style={{ marginBottom: 22 }}>
        <div
          style={{
            fontSize: 10,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            color: "var(--ink-3)",
          }}
        >
          Repository
        </div>
        <h1 style={{ fontFamily: "var(--serif)", fontSize: 28, marginTop: 4 }}>
          Schools
        </h1>
        <p style={{ color: "var(--ink-3)", fontSize: 13, marginTop: 4 }}>
          {rows.length} government schools across Leh and Kargil districts. Click any row to see
          its classes, teachers and sessions.
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
            gap: 8,
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <span
            style={{
              fontSize: 10,
              textTransform: "uppercase",
              letterSpacing: "0.07em",
              color: "var(--ink-3)",
              fontWeight: 500,
              paddingLeft: 4,
              paddingRight: 4,
            }}
          >
            District
          </span>
          {filterTabs.map((f) => {
            const active = districtFilter === f.v || (districtFilter === "kargil" && f.v === "kgl");
            const href = f.v === "all" ? "/repo/schools" : `/repo/schools?district=${f.v}`;
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
                {f.l}
                <span style={{ opacity: 0.6, marginLeft: 4 }}>{f.n}</span>
              </Link>
            );
          })}

          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <Link
              href="/repo/schools.csv"
              style={{
                fontSize: 12,
                padding: "5px 10px",
                background: "var(--paper-2)",
                color: "var(--ink-2)",
                border: "1px solid var(--line)",
                borderRadius: "var(--r-2)",
                textDecoration: "none",
                fontWeight: 500,
              }}
            >
              CSV
            </Link>
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
          {visible.length === 0 ? (
            <div
              style={{
                padding: 32,
                textAlign: "center",
                color: "var(--ink-3)",
                fontSize: 13,
              }}
            >
              No schools match this filter.
            </div>
          ) : (
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
                  <th style={{ padding: "10px 12px", fontWeight: 500 }}>Code</th>
                  <th style={{ padding: "10px 12px", fontWeight: 500 }}>Name</th>
                  <th style={{ padding: "10px 12px", fontWeight: 500 }}>Zone</th>
                  <th style={{ padding: "10px 12px", fontWeight: 500 }}>District</th>
                  <th style={{ padding: "10px 12px", fontWeight: 500, textAlign: "right" }}>Teachers</th>
                  <th style={{ padding: "10px 12px", fontWeight: 500, textAlign: "right" }}>Classes</th>
                  <th style={{ padding: "10px 12px", fontWeight: 500, textAlign: "right" }}>Sessions</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {visible.map((s, i) => {
                  const chip = chipFor(s.districtCode ?? s.districtName);
                  return (
                    <tr
                      key={s.id}
                      style={{
                        borderTop: i ? "1px solid var(--line)" : "none",
                        fontSize: 13,
                      }}
                    >
                      <td
                        style={{
                          padding: "10px 12px",
                          fontFamily: "var(--mono)",
                          fontSize: 12,
                          color: "var(--ink-2)",
                        }}
                      >
                        {s.code}
                      </td>
                      <td style={{ padding: "10px 12px" }}>
                        <Link
                          href={`/repo/school/${s.id}`}
                          style={{
                            color: "var(--ink)",
                            textDecoration: "none",
                            fontWeight: 500,
                          }}
                        >
                          {s.name}
                        </Link>
                      </td>
                      <td style={{ padding: "10px 12px", color: "var(--ink-2)" }}>
                        {s.zoneName ?? "—"}
                      </td>
                      <td style={{ padding: "10px 12px" }}>
                        <span
                          style={{
                            padding: "2px 8px",
                            background: chip.bg,
                            color: chip.ink,
                            borderRadius: 999,
                            fontSize: 10,
                            textTransform: "uppercase",
                            letterSpacing: "0.06em",
                            fontWeight: 600,
                          }}
                        >
                          {chip.label}
                        </span>
                      </td>
                      <td
                        style={{
                          padding: "10px 12px",
                          fontFamily: "var(--mono)",
                          fontSize: 12,
                          color: "var(--ink-2)",
                          textAlign: "right",
                        }}
                      >
                        {s.teachersTotal ?? 0}
                      </td>
                      <td
                        style={{
                          padding: "10px 12px",
                          fontFamily: "var(--mono)",
                          fontSize: 12,
                          color: "var(--ink-2)",
                          textAlign: "right",
                        }}
                      >
                        {s.classesTotal ?? 0}
                      </td>
                      <td
                        style={{
                          padding: "10px 12px",
                          fontFamily: "var(--mono)",
                          fontSize: 12,
                          color: "var(--ink-2)",
                          textAlign: "right",
                        }}
                      >
                        {s.sessionsTotal ?? 0}
                      </td>
                      <td style={{ padding: "10px 12px", textAlign: "right" }}>
                        <Link
                          href={`/repo/school/${s.id}`}
                          style={{
                            fontSize: 11,
                            color: "var(--ink-3)",
                            textDecoration: "none",
                          }}
                        >
                          ›
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </div>
  );
}
