// /repo/schools — Repository: index of partner schools across Leh + Kargil.
// Port of repository.jsx::RepoSchoolsIndex (lines 152-221) — 1:1 visual fidelity.
// District filter is server-side via ?district= so the URL is shareable.
//
// Spec 129 (Workflow Run 11 frontend-parity closure): the filter card was
// already URL-driven via <Link>, but the row narrowing happened in JS via
// a post-fetch .filter() call. Now the WHERE clause is built up against
// districts.code so Postgres returns the visible set directly. Counts
// come from a single GROUP BY round-trip.

import Link from "next/link";
import { redirect } from "next/navigation";
import { and, asc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
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

// District chip palette (utility-class form):
//   Leh    -> chip-indigo  (background var(--indigo-soft))
//   Kargil -> chip-saffron (background var(--saffron-soft))
const DISTRICT_CHIP: Record<string, { kind: string; label: string }> = {
  leh: { kind: "chip-indigo", label: "Leh" },
  kargil: { kind: "chip-saffron", label: "Kargil" },
  kgl: { kind: "chip-saffron", label: "Kargil" },
};

function chipFor(code: string | null | undefined) {
  if (!code) return { kind: "", label: "—" };
  const k = code.toLowerCase();
  return DISTRICT_CHIP[k] ?? { kind: "", label: code };
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

  // Spec 129 — build the district WHERE clause server-side. Accept either
  // the JSX-prototype's "kgl" code or the longer "kargil" canonical form so
  // older bookmarks keep working.
  function districtPredicate(v: string): SQL | undefined {
    if (v === "all") return undefined;
    if (v === "leh") {
      return or(ilike(districts.code, "leh"), ilike(districts.name, "leh"));
    }
    if (v === "kgl" || v === "kargil") {
      return or(
        ilike(districts.code, "kgl"),
        ilike(districts.code, "kargil"),
        ilike(districts.name, "kargil"),
      );
    }
    return or(ilike(districts.code, v), ilike(districts.name, v));
  }

  const districtCond = districtPredicate(districtFilter);
  const whereCond = districtCond
    ? and(eq(schools.active, true), districtCond)
    : eq(schools.active, true);

  const visible = await db
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
    .where(whereCond)
    .orderBy(asc(schools.name))
    .limit(200);

  // One extra round-trip for the per-tab counts so the filter chips stay
  // accurate even when the visible slice has narrowed.
  const countRows = await db
    .select({
      districtCode: districts.code,
      n: sql<number>`count(*)::int`.as("n"),
    })
    .from(schools)
    .leftJoin(zones, eq(schools.zoneId, zones.id))
    .leftJoin(districts, eq(zones.districtId, districts.id))
    .where(eq(schools.active, true))
    .groupBy(districts.code);

  const totalSchools = countRows.reduce((acc, r) => acc + r.n, 0);
  const counts = {
    all: totalSchools,
    leh: countRows
      .filter((r) => (r.districtCode ?? "").toLowerCase() === "leh")
      .reduce((acc, r) => acc + r.n, 0),
    kgl: countRows
      .filter((r) => ["kgl", "kargil"].includes((r.districtCode ?? "").toLowerCase()))
      .reduce((acc, r) => acc + r.n, 0),
  };

  const filterTabs = [
    { v: "all", l: "All", n: counts.all },
    { v: "leh", l: "Leh", n: counts.leh },
    { v: "kgl", l: "Kargil", n: counts.kgl },
  ];

  return (
    <div>
      <div className="page-header">
        <div className="label">Repository</div>
        <h1 style={{ fontFamily: "var(--serif)", fontSize: 28, marginTop: 4 }}>
          Schools
        </h1>
        <p style={{ color: "var(--ink-3)", marginTop: 4 }}>
          {totalSchools} government schools across Leh and Kargil districts. Click any row to see
          its classes, teachers and sessions.
        </p>
      </div>

      <div className="page-body" style={{ display: "grid", gap: 16 }}>
        {/* Filter card */}
        <div
          className="card"
          style={{ padding: 10, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}
        >
          <span className="label" style={{ paddingLeft: 0, paddingTop: 0 }}>
            District
          </span>
          {filterTabs.map((f) => {
            const active = districtFilter === f.v || (districtFilter === "kargil" && f.v === "kgl");
            const href = f.v === "all" ? "/repo/schools" : `/repo/schools?district=${f.v}`;
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
                {f.l}
                <span style={{ opacity: 0.6, marginLeft: 4 }}>{f.n}</span>
              </Link>
            );
          })}

          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <Link
              href="/repo/schools.csv"
              className="btn btn-sm"
              style={{ textDecoration: "none" }}
            >
              CSV
            </Link>
          </div>
        </div>

        {/* Table card */}
        <div className="card">
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
            <table className="t">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Name</th>
                  <th>Zone</th>
                  <th>District</th>
                  <th>Teachers</th>
                  <th>Classes</th>
                  <th>Sessions</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {visible.map((s) => {
                  const chip = chipFor(s.districtCode ?? s.districtName);
                  return (
                    <tr key={s.id}>
                      <td className="mono" style={{ fontSize: 12 }}>
                        {s.code}
                      </td>
                      <td>
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
                      <td>{s.zoneName ?? "—"}</td>
                      <td>
                        <span className={`chip ${chip.kind}`.trim()}>{chip.label}</span>
                      </td>
                      <td>{s.teachersTotal ?? 0}</td>
                      <td>{s.classesTotal ?? 0}</td>
                      <td>{s.sessionsTotal ?? 0}</td>
                      <td style={{ textAlign: "right" }}>
                        <Link
                          href={`/repo/school/${s.id}`}
                          style={{
                            fontSize: 12,
                            color: "var(--ink-3)",
                            textDecoration: "none",
                          }}
                          aria-label={`Open ${s.name}`}
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
      </div>
    </div>
  );
}
