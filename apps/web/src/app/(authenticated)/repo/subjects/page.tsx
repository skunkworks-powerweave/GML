// /repo/subjects — curriculum subjects index. Replaces window.WIKI.SUBJECTS
// with a Drizzle roll-up over subjects + course_outlines + sessions +
// resource_subjects. Visual layout: ports `repository.jsx` RepoSubjectsIndex
// (lines 444-484) 1:1.
//
// Spec 129 (Workflow Run 11 frontend-parity closure): add a server-side
// grade-range filter (?grade=N) — the WHERE narrows to subjects whose
// grades_min ≤ N ≤ grades_max. Defaults to "all" when the param is absent.

import { redirect } from "next/navigation";
import Link from "next/link";
import { and, asc, eq, gte, ilike, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { db } from "@gml/db";
import {
  subjects,
  courseOutlines,
  sessions as classroomSessions,
  resourceSubjects,
} from "@gml/db/schema";
import { auth } from "@/auth";
// Spec 138 — mobile card-list fallback (desktop keeps the table).
import { getDeviceType } from "@/lib/device";
import { MobileRepoCardList } from "@/components/repo/MobileRepoCardList";
import { escapeIlike } from "@gml/shared/sql/ilike";

export const dynamic = "force-dynamic";

// Hex → chip class. Subjects.color stores the design-system hex; we map it
// to the closest semantic chip variant so the table picks up the new utility
// classes without bespoke inline styling.
function chipClassForColor(hex: string | null): string {
  switch ((hex ?? "").toUpperCase()) {
    case "#D97757":
      return "chip chip-rust";
    case "#2A6FDB":
      return "chip chip-indigo";
    case "#1F8A5B":
      return "chip chip-lichen";
    case "#7A5AE0":
      return "chip chip-indigo";
    default:
      return "chip";
  }
}

// Spec 158 — repo-search-bar contract: ?q= name filter, 200-char cap,
// escape ILIKE wildcards so a literal "%" / "_" in the query doesn't
// become a pattern character.
const SEARCH_Q_MAX = 200;

export default async function RepoSubjectsIndexPage({
  searchParams,
}: {
  searchParams: Promise<{ grade?: string; q?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const sp = await searchParams;
  // Grade-range filter — accept 1..12. Anything else (including the
  // sentinel "all" or missing) falls through to no filter.
  const gradeParsed = Number(sp.grade);
  const gradeFilter =
    Number.isInteger(gradeParsed) && gradeParsed >= 1 && gradeParsed <= 12
      ? gradeParsed
      : null;
  // Spec 158 — name search on subjects.name.
  const qRaw = (sp.q ?? "").slice(0, SEARCH_Q_MAX);
  const qFilter = qRaw.trim().length > 0 ? qRaw.trim() : null;

  const conds: SQL[] = [eq(subjects.active, true)];
  if (gradeFilter !== null) {
    // A subject covers grade N if grades_min ≤ N ≤ grades_max. NULL bounds
    // mean "all grades" so they always match.
    conds.push(
      or(isNull(subjects.gradesMin), lte(subjects.gradesMin, gradeFilter))!,
    );
    conds.push(
      or(isNull(subjects.gradesMax), gte(subjects.gradesMax, gradeFilter))!,
    );
  }
  // Spec 158 — combine the new name search filter via and(...).
  if (qFilter) conds.push(ilike(subjects.name, `%${escapeIlike(qFilter)}%`));

  // One round-trip: subjects + grouped counts via correlated subqueries.
  // Aggregates are evaluated per-row in Postgres; ~9 subjects so cost is O(1).
  const rows = await db
    .select({
      id: subjects.id,
      name: subjects.name,
      code: subjects.code,
      color: subjects.color,
      gradesMin: subjects.gradesMin,
      gradesMax: subjects.gradesMax,
      displayOrder: subjects.displayOrder,
      outlines: sql<number>`(
        SELECT COUNT(*)::int FROM ${courseOutlines}
        WHERE ${courseOutlines.subjectId} = ${subjects.id}
      )`.as("outlines"),
      sessions: sql<number>`(
        SELECT COUNT(*)::int FROM ${classroomSessions}
        WHERE ${classroomSessions.subjectId} = ${subjects.id}
      )`.as("sessions"),
      readings: sql<number>`(
        SELECT COUNT(*)::int FROM ${resourceSubjects}
        WHERE ${resourceSubjects.subjectId} = ${subjects.id}
      )`.as("readings"),
    })
    .from(subjects)
    .where(and(...conds))
    .orderBy(asc(subjects.displayOrder), asc(subjects.name));

  // Spec 138 — device-aware card/table fork.
  const device = await getDeviceType();

  return (
    <div>
      <div className="page-header">
        <div className="label">Repository</div>
        <h1 style={{ fontFamily: "var(--serif)", fontSize: 28, marginTop: 4 }}>Subjects</h1>
        <p style={{ color: "var(--ink-3)", marginTop: 4 }}>
          Curricular subjects across Grades 1–10. Each subject links to its course outlines,
          sessions and reading material.
        </p>
      </div>
      <div className="page-body" style={{ display: "grid", gap: 16 }}>
        <form
          method="GET"
          action="/repo/subjects"
          className="card"
          style={{ padding: 10, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}
        >
          {/* Spec 158 — name search input. Submits with the grade filter
              so the URL is one bookmarkable shareable state. */}
          <label className="label" style={{ paddingLeft: 0, paddingTop: 0 }}>
            Name
            <input
              type="search"
              name="q"
              defaultValue={qFilter ?? ""}
              aria-label="Search subjects by name"
              title="Search subjects by name"
              maxLength={SEARCH_Q_MAX}
              className="text"
              style={{ marginLeft: 6, padding: "5px 10px", fontSize: 12, minWidth: 160 }}
            />
          </label>
          <span className="label" style={{ paddingLeft: 0, paddingTop: 0 }}>
            Grade
          </span>
          <select
            name="grade"
            defaultValue={gradeFilter === null ? "" : String(gradeFilter)}
            className="text"
            style={{ maxWidth: 160, padding: "5px 10px", fontSize: 12 }}
          >
            <option value="">All grades</option>
            {Array.from({ length: 12 }, (_, i) => i + 1).map((g) => (
              <option key={g} value={g}>
                Grade {g}
              </option>
            ))}
          </select>
          <button type="submit" className="btn btn-sm">
            Apply
          </button>
          {(gradeFilter !== null || qFilter) ? (
            <Link
              href="/repo/subjects"
              className="btn btn-sm"
              style={{ textDecoration: "none" }}
            >
              Clear
            </Link>
          ) : null}
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <span className="chip">{rows.length} shown</span>
          </div>
        </form>
        {/* Spec 138 — mobile branch: card list. Desktop keeps the table. */}
        {device === "mobile" ? (
          <MobileRepoCardList
            testIdSuffix="subjects"
            emptyMessage="No subjects match this filter."
            items={rows.map((s) => {
              const gradesLabel =
                s.gradesMin != null && s.gradesMax != null
                  ? `Grades ${s.gradesMin}–${s.gradesMax}`
                  : "All grades";
              const chipClass = chipClassForColor(s.color).replace(/^chip\s*/, "");
              return {
                id: s.id,
                primary: s.name,
                href: `/repo/subject/${s.id}`,
                chip: s.code ? { label: s.code, kind: chipClass } : null,
                secondary: [
                  { value: gradesLabel },
                  {
                    value: `${s.outlines} outlines · ${s.sessions} sessions · ${s.readings} readings`,
                  },
                ],
              };
            })}
          />
        ) : null}
        <div className="card" style={device === "mobile" ? { display: "none" } : undefined} aria-hidden={device === "mobile"}>
          {rows.length === 0 ? (
            <div style={{ padding: 32, color: "var(--ink-3)", fontSize: 13 }}>
              No subjects match this filter.
            </div>
          ) : (
            <table className="t">
              <thead>
                <tr>
                  {["Subject", "Grades", "Outlines", "Sessions", "Readings", ""].map((h, i) => (
                    <th key={i}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => {
                  const gradesLabel =
                    s.gradesMin != null && s.gradesMax != null
                      ? `${s.gradesMin}–${s.gradesMax}`
                      : "—";
                  return (
                    <tr key={s.id} style={{ cursor: "pointer" }}>
                      <td>
                        <Link
                          href={`/repo/subject/${s.id}`}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 8,
                            color: "var(--ink)",
                            textDecoration: "none",
                            fontWeight: 500,
                          }}
                        >
                          <span aria-hidden className={chipClassForColor(s.color)}>
                            {s.code}
                          </span>
                          <span>{s.name}</span>
                        </Link>
                      </td>
                      <td className="mono" style={{ fontSize: 12, fontFamily: "var(--mono)" }}>
                        {gradesLabel}
                      </td>
                      <td>{s.outlines}</td>
                      <td>{s.sessions}</td>
                      <td>{s.readings}</td>
                      <td style={{ color: "var(--ink-4)", textAlign: "right" }}>
                        <Link href={`/repo/subject/${s.id}`} style={{ color: "var(--ink-4)" }}>
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
