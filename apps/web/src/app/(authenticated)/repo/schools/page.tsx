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
// Spec 138 — mobile card-list fallback (desktop keeps the 8-col table).
import { getDeviceType } from "@/lib/device";
import { MobileRepoCardList } from "@/components/repo/MobileRepoCardList";

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

type SearchParams = Promise<{ district?: string; q?: string }>;

// Spec 158 — inline name-search bar. Cap at 200 chars so a copy-paste of
// a giant payload neither bloats the URL nor stresses Postgres' planner.
// We escape ILIKE wildcards because a user may legitimately search for a
// school whose name contains a literal '%' or '_'.
const SEARCH_Q_MAX = 200;
function escapeIlike(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

export default async function RepoSchoolsIndexPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const session = await auth();
  const role = session?.user?.role ?? "teacher";
  // Mirrors src/admin/entities/schools.ts readRoles. The export route enforces
  // it server-side regardless; this only decides whether to offer the control.
  const canExport = role === "programme_admin" || role === "super_admin";
  if (!READ_ROLES.has(role)) {
    redirect("/forbidden");
  }

  const sp = await searchParams;
  const districtFilter = (sp.district ?? "all").toLowerCase();
  // Spec 158 — name search. Empty string and "all whitespace" both treat
  // as absent so the input behaves intuitively (typing then deleting
  // doesn't leave a non-matching filter live).
  const qRaw = (sp.q ?? "").slice(0, SEARCH_Q_MAX);
  const qFilter = qRaw.trim().length > 0 ? qRaw.trim() : null;

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
  // Spec 158 — combine districtCond AND name-search via and(...). The
  // ilike pattern wraps the escaped query in % so it's a substring match,
  // matching the JSX-prototype's case-insensitive name filter behaviour.
  const qCond: SQL | undefined = qFilter
    ? ilike(schools.name, `%${escapeIlike(qFilter)}%`)
    : undefined;
  const conds: SQL[] = [eq(schools.active, true)];
  if (districtCond) conds.push(districtCond);
  if (qCond) conds.push(qCond);
  const whereCond = and(...conds);

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

  // Spec 138 — pick the right layout per device. The same `visible` rows
  // feed both branches so filters stay 1:1.
  const device = await getDeviceType();

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
            // Spec 158 — preserve `q` across district-tab clicks so the user
            // doesn't lose their search when narrowing by district.
            const qs = new URLSearchParams();
            if (f.v !== "all") qs.set("district", f.v);
            if (qFilter) qs.set("q", qFilter);
            const q = qs.toString();
            const href = q ? `/repo/schools?${q}` : "/repo/schools";
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

          {/* Spec 158 — name search. Native HTML GET form so the URL is
              shareable and no client component is needed. The district
              hidden input preserves the active tab across submissions. */}
          <form
            method="GET"
            action="/repo/schools"
            style={{ display: "flex", gap: 6, alignItems: "center" }}
          >
            {districtFilter !== "all" ? (
              <input type="hidden" name="district" value={districtFilter} />
            ) : null}
            <input
              type="search"
              name="q"
              defaultValue={qFilter ?? ""}
              aria-label="Search schools by name"
              title="Search schools by name"
              maxLength={SEARCH_Q_MAX}
              className="text"
              style={{ padding: "5px 10px", fontSize: 12, minWidth: 160 }}
            />
            <button type="submit" className="btn btn-sm">
              Search
            </button>
            {qFilter ? (
              <Link
                href={
                  districtFilter !== "all"
                    ? `/repo/schools?district=${districtFilter}`
                    : "/repo/schools"
                }
                className="btn btn-sm"
                style={{ textDecoration: "none" }}
              >
                Clear
              </Link>
            ) : null}
          </form>

          {/* The href was `/repo/schools.csv` — a path with no route behind it,
              so this button 404'd. The working export is the admin entity route,
              which is gated to programme_admin/super_admin
              (src/admin/entities/schools.ts readRoles). /repo/schools itself is
              visible to more roles than that, so the button is HIDDEN rather
              than shown-and-refused: offering a control that answers 403 reads
              as a broken page, not as a permission boundary. */}
          {canExport ? (
            <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
              <Link
                href="/api/admin/data/schools/export"
                className="btn btn-sm"
                style={{ textDecoration: "none" }}
                prefetch={false}
              >
                CSV
              </Link>
            </div>
          ) : null}
        </div>

        {/* Spec 138 — mobile branch: card list. Desktop keeps the table. */}
        {device === "mobile" ? (
          <MobileRepoCardList
            testIdSuffix="schools"
            emptyMessage="No schools match this filter."
            items={visible.map((s) => {
              const chip = chipFor(s.districtCode ?? s.districtName);
              return {
                id: s.id,
                primary: s.name,
                href: `/repo/school/${s.id}`,
                chip: chip.label !== "—" ? { label: chip.label, kind: chip.kind } : null,
                secondary: [
                  { label: "Code", value: s.code, mono: true },
                  { label: "Zone", value: s.zoneName ?? "—" },
                  {
                    value: `${s.teachersTotal ?? 0} teachers · ${s.classesTotal ?? 0} classes · ${s.sessionsTotal ?? 0} sessions`,
                  },
                ],
              };
            })}
          />
        ) : null}

        {/* Table card */}
        <div className="card" style={device === "mobile" ? { display: "none" } : undefined} aria-hidden={device === "mobile"}>
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
