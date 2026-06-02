// /repo/teachers — Repository: index of all teachers across partner schools.
// Mirrors `repository.jsx` RepoTeachersIndex (lines 829-867 of the prototype):
// name + Hindi (SM-7 optional), school code, current phase, subject, sessions count.
//
// Visual presentation: utility classes from globals.css — `className="deva"`
// applies `font-family: var(--deva)` for the Devanagari Hindi name column,
// `className="mono"` applies `font-family: var(--mono)` for school codes and
// numeric counts. `className="t"` styles the table; `chip-*` variants style
// the subject pill. No inline font-family declarations beyond the serif H1.
//
// Spec 129 (Workflow Run 11 frontend-parity closure): add a server-side
// school + current-phase filter (?school=<id>&phase=<id>). Defaults to
// "all" when the param is absent — the WHERE clause stays unchanged so
// the existing 200-row cap still applies. Filter form submits via native
// HTML GET (no client component) and bookmarkable URLs are first-class.

import Link from "next/link";
import { redirect } from "next/navigation";
import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import { db } from "@gml/db";
import {
  teachers,
  schools,
  phases,
  sessions as classroomSessions,
  observationCycles,
} from "@gml/db/schema";
import { auth } from "@/auth";

export const dynamic = "force-dynamic";

// Mirrors `subjectColor(...)` in the JSX prototype (repository.jsx line 854):
// English/Science → blue → chip-indigo; Mathematics/EVS → green → chip-lichen;
// Hindi → orange → chip-saffron; Urdu → purple → chip-rust (closest semantic).
const SUBJECT_CHIP: Record<string, string> = {
  English: "chip-indigo",
  Science: "chip-indigo",
  Mathematics: "chip-lichen",
  Math: "chip-lichen",
  EVS: "chip-lichen",
  Hindi: "chip-saffron",
  Urdu: "chip-rust",
};

const READ_ROLES = new Set([
  "super_admin",
  "programme_admin",
  "mentor",
  "observer",
  "teacher",
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type SearchParams = Promise<{ school?: string; phase?: string }>;

export default async function RepoTeachersIndexPage({
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
  const schoolFilter = sp.school && UUID_RE.test(sp.school) ? sp.school : null;
  const phaseFilter = sp.phase && UUID_RE.test(sp.phase) ? sp.phase : null;

  // Per-teacher session counter joined inline so the index hits the DB once.
  const sessionCounts = db
    .select({
      teacherId: classroomSessions.teacherId,
      sessionsTotal: sql<number>`count(*)::int`.as("sessions_total"),
    })
    .from(classroomSessions)
    .groupBy(classroomSessions.teacherId)
    .as("session_counts");

  const cycleCounts = db
    .select({
      teacherId: observationCycles.teacherId,
      cyclesTotal: sql<number>`count(*)::int`.as("cycles_total"),
    })
    .from(observationCycles)
    .groupBy(observationCycles.teacherId)
    .as("cycle_counts");

  const conds: SQL[] = [eq(teachers.active, true)];
  if (schoolFilter) conds.push(eq(teachers.schoolId, schoolFilter));
  if (phaseFilter) conds.push(eq(teachers.currentPhaseId, phaseFilter));

  const rows = await db
    .select({
      id: teachers.id,
      fullName: teachers.fullName,
      hindiName: teachers.hindiName,
      phone: teachers.phone,
      subjectSpecialism: teachers.subjectSpecialism,
      active: teachers.active,
      schoolCode: schools.code,
      schoolName: schools.name,
      phaseLabel: phases.label,
      sessionsTotal: sessionCounts.sessionsTotal,
      cyclesTotal: cycleCounts.cyclesTotal,
    })
    .from(teachers)
    .leftJoin(schools, eq(teachers.schoolId, schools.id))
    .leftJoin(phases, eq(teachers.currentPhaseId, phases.id))
    .leftJoin(sessionCounts, eq(sessionCounts.teacherId, teachers.id))
    .leftJoin(cycleCounts, eq(cycleCounts.teacherId, teachers.id))
    .where(and(...conds))
    .orderBy(asc(teachers.fullName))
    .limit(200);

  // Filter options come from one round-trip each — both lists are small
  // (≤ 60 schools, 3 phases per the JSX prototype seed).
  const schoolOptions = await db
    .select({ id: schools.id, code: schools.code, name: schools.name })
    .from(schools)
    .where(eq(schools.active, true))
    .orderBy(asc(schools.name));
  const phaseOptions = await db
    .select({ id: phases.id, label: phases.label })
    .from(phases)
    .orderBy(asc(phases.sequence));

  return (
    <div>
      <div className="page-header">
        <div className="label">Repository</div>
        <h1 style={{ fontFamily: "var(--serif)", fontSize: 28, marginTop: 4 }}>
          Teachers
        </h1>
        <p style={{ color: "var(--ink-3)", marginTop: 4 }}>
          {rows.length} {rows.length === 1 ? "teacher" : "teachers"} across the
          partner schools. Tap a teacher to see their sessions and pairing.
        </p>
      </div>
      <div className="page-body" style={{ display: "grid", gap: 16 }}>
        <form
          method="GET"
          action="/repo/teachers"
          className="card"
          style={{ padding: 10, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}
        >
          <label className="label" style={{ paddingLeft: 0, paddingTop: 0 }}>
            School
            <select
              name="school"
              defaultValue={schoolFilter ?? ""}
              className="text"
              style={{ marginLeft: 6, padding: "5px 10px", fontSize: 12, maxWidth: 220 }}
            >
              <option value="">All schools</option>
              {schoolOptions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.code} · {s.name}
                </option>
              ))}
            </select>
          </label>
          <label className="label" style={{ paddingLeft: 0, paddingTop: 0 }}>
            Phase
            <select
              name="phase"
              defaultValue={phaseFilter ?? ""}
              className="text"
              style={{ marginLeft: 6, padding: "5px 10px", fontSize: 12 }}
            >
              <option value="">All phases</option>
              {phaseOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="btn btn-sm">
            Apply
          </button>
          {(schoolFilter || phaseFilter) ? (
            <Link
              href="/repo/teachers"
              className="btn btn-sm"
              style={{ textDecoration: "none" }}
            >
              Reset
            </Link>
          ) : null}
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <span className="chip">{rows.length} shown</span>
          </div>
        </form>
        <div className="card">
          {rows.length === 0 ? (
            <div
              style={{
                padding: 32,
                textAlign: "center",
                color: "var(--ink-3)",
                fontSize: 13,
              }}
            >
              No teachers match this filter.
            </div>
          ) : (
            <table className="t">
              <thead>
                <tr>
                  <th>Name</th>
                  <th className="deva" style={{ textTransform: "none", letterSpacing: 0 }}>
                    नाम
                  </th>
                  <th>Subject</th>
                  <th>School</th>
                  <th>Phase</th>
                  <th style={{ textAlign: "right" }}>Sessions</th>
                  <th style={{ textAlign: "right" }}>Obs. cycles</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => {
                  const chipKind =
                    (t.subjectSpecialism && SUBJECT_CHIP[t.subjectSpecialism]) ||
                    "";
                  return (
                    <tr key={t.id} style={{ cursor: "pointer" }}>
                      <td>
                        <Link
                          href={`/repo/teacher/${t.id}`}
                          style={{
                            color: "var(--ink)",
                            textDecoration: "none",
                            fontWeight: 500,
                          }}
                        >
                          {t.fullName}
                        </Link>
                      </td>
                      <td className="deva" style={{ fontSize: 12, color: "var(--ink-3)" }}>
                        {t.hindiName ?? (
                          <span style={{ color: "var(--ink-4)" }}>—</span>
                        )}
                      </td>
                      <td>
                        {t.subjectSpecialism ? (
                          <span className={`chip ${chipKind}`.trim()}>
                            {t.subjectSpecialism}
                          </span>
                        ) : (
                          <span style={{ color: "var(--ink-4)" }}>—</span>
                        )}
                      </td>
                      <td className="mono" style={{ fontSize: 12 }}>
                        {t.schoolCode ?? (
                          <span style={{ color: "var(--ink-4)" }}>—</span>
                        )}
                      </td>
                      <td>{t.phaseLabel ?? "—"}</td>
                      <td
                        className="mono"
                        style={{ fontSize: 12, textAlign: "right" }}
                      >
                        {t.sessionsTotal ?? 0}
                      </td>
                      <td
                        className="mono"
                        style={{ fontSize: 12, textAlign: "right" }}
                      >
                        {t.cyclesTotal ?? 0}
                      </td>
                      <td style={{ textAlign: "right", color: "var(--ink-4)" }}>
                        <Link
                          href={`/repo/teacher/${t.id}`}
                          style={{ color: "var(--ink-4)", textDecoration: "none" }}
                          aria-label={`Open ${t.fullName}`}
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
