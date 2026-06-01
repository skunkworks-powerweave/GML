// /repo/students — Admin-only learner index. 1:1 port of RepoStudentsIndex
// (repository.jsx lines 938–975). Role-gated to programme_admin+, every view
// writes an SM-9 audit row ("learners.bulk_view"), bulk CSV export requires
// super_admin. Pagination via `?page=`, optional school filter via `?school=`.
//
// Schema reality (SM-7): `learners.name` is the only name column — there is
// no `hindi_name` on this table, so we render English only. The JSX prototype
// also shows a single name field, so this is 1:1 visual fidelity.

import Link from "next/link";
import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "@gml/db";
import { learners, classes, schools } from "@gml/db/schema";
import { requireRole } from "@/lib/guards";
import { recordAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 100;

type PageProps = {
  searchParams: Promise<{ page?: string; school?: string }>;
};

export default async function RepoStudentsPage({ searchParams }: PageProps) {
  // SM-9: PII-bearing learner index is gated to programme leads + super admins.
  const session = await requireRole(["programme_admin", "super_admin"]);
  const isSuperAdmin = session.user.role === "super_admin";

  const sp = await searchParams;
  const pageNum = Math.max(1, Number(sp.page ?? 1) || 1);
  const offset = (pageNum - 1) * PAGE_SIZE;
  const schoolFilter = typeof sp.school === "string" && sp.school.length > 0 ? sp.school : undefined;

  const whereExpr = schoolFilter
    ? and(eq(learners.active, true), isNull(learners.deletedAt), eq(learners.schoolId, schoolFilter))
    : and(eq(learners.active, true), isNull(learners.deletedAt));

  const rows = await db
    .select({
      id: learners.id,
      name: learners.name,
      age: learners.age,
      guardian: learners.guardian,
      attendancePct: learners.attendancePct,
      grade: learners.grade,
      classId: classes.id,
      schoolId: schools.id,
      schoolCode: schools.code,
      schoolName: schools.name,
    })
    .from(learners)
    .leftJoin(classes, eq(learners.classId, classes.id))
    .leftJoin(schools, eq(learners.schoolId, schools.id))
    .where(whereExpr)
    .orderBy(asc(schools.code), asc(learners.grade), asc(learners.name))
    .limit(PAGE_SIZE)
    .offset(offset);

  // SM-9 enforcement: bulk view of learner PII must write an audit row. Every
  // render — not just the first — because each render exposes the rows to a
  // human. Fire-and-forget so audit failure never blanks the page.
  void recordAudit({
    action: "learners.bulk_view",
    entityType: "all",
    metadata: {
      piiAudited: true,
      rowCount: rows.length,
      page: pageNum,
      schoolFilter: schoolFilter ?? null,
    },
  });

  return (
    <div>
      <div className="page-header">
        <div className="label">Repository</div>
        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16 }}>
          <div>
            <h1 style={{ fontFamily: "var(--serif)", fontSize: 28, marginTop: 4 }}>Learners</h1>
            <p style={{ color: "var(--ink-3)", marginTop: 4 }}>
              Per-class learner records. Sample shown below; full database is restricted.
            </p>
          </div>
          {isSuperAdmin ? (
            <a
              href={`/api/admin/learners/export${schoolFilter ? `?school=${encodeURIComponent(schoolFilter)}` : ""}`}
              className="btn btn-primary btn-sm"
              style={{ textDecoration: "none", whiteSpace: "nowrap" }}
              title="Bulk export learner PII as CSV — super admin only, audited"
            >
              Export CSV
            </a>
          ) : null}
        </div>
      </div>

      <div className="page-body" style={{ display: "grid", gap: 16 }}>
        {/* PII warning card — saffron-soft per JSX line 946 */}
        <div
          className="card"
          style={{
            padding: 14,
            background: "var(--saffron-soft)",
            borderColor: "oklch(0.82 0.08 60)",
            display: "flex",
            gap: 10,
            alignItems: "center",
          }}
        >
          <LockGlyph />
          <span style={{ fontSize: 12 }}>
            Learner records contain PII (name, age, guardian). Access is restricted to school staff and programme
            leads. Bulk export is audited and requires Super Admin approval.
          </span>
        </div>

        <div className="card" style={{ overflow: "hidden" }}>
          <table className="t">
            <thead>
              <tr>
                <th>Name</th>
                <th>Class</th>
                <th>School</th>
                <th>Age</th>
                <th>Guardian</th>
                <th>Attendance</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ padding: 32, textAlign: "center", color: "var(--ink-3)" }}>
                    No learners match.
                  </td>
                </tr>
              ) : (
                rows.map((st) => {
                  const attendance = st.attendancePct ?? 0;
                  const goodAttendance = attendance > 90;
                  return (
                    <tr key={st.id}>
                      <td style={{ fontWeight: 500 }}>
                        {st.classId ? (
                          <Link
                            href={`/repo/class/${st.classId}`}
                            style={{ color: "var(--ink)", textDecoration: "none" }}
                          >
                            {st.name}
                          </Link>
                        ) : (
                          st.name
                        )}
                      </td>
                      <td>Grade {st.grade}</td>
                      <td>
                        <span className="mono" style={{ fontSize: 11 }}>{st.schoolCode ?? "—"}</span>
                        {st.schoolName ? (
                          <span style={{ color: "var(--ink-3)", marginLeft: 6, fontSize: 11 }}>
                            {st.schoolName}
                          </span>
                        ) : null}
                      </td>
                      <td>{st.age ?? "—"}</td>
                      <td style={{ fontSize: 12 }}>{st.guardian ?? "—"}</td>
                      <td
                        className="mono"
                        style={{
                          fontSize: 12,
                          color: goodAttendance ? "var(--lichen)" : "var(--ink-3)",
                        }}
                      >
                        {st.attendancePct !== null ? `${st.attendancePct}%` : "—"}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>

          <nav
            className="mono"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "10px 14px",
              borderTop: "1px solid var(--line)",
              fontSize: 11,
              color: "var(--ink-3)",
            }}
          >
            <div>
              {pageNum > 1 ? (
                <Link
                  href={buildHref({ page: pageNum - 1, school: schoolFilter })}
                  style={{ color: "var(--ink-2)", textDecoration: "none" }}
                >
                  ← Prev
                </Link>
              ) : (
                <span style={{ color: "var(--ink-4)" }}>← Prev</span>
              )}
            </div>
            <div>
              Page {pageNum} · {rows.length} row{rows.length === 1 ? "" : "s"}
            </div>
            <div>
              {rows.length === PAGE_SIZE ? (
                <Link
                  href={buildHref({ page: pageNum + 1, school: schoolFilter })}
                  style={{ color: "var(--ink-2)", textDecoration: "none" }}
                >
                  Next →
                </Link>
              ) : (
                <span style={{ color: "var(--ink-4)" }}>Next →</span>
              )}
            </div>
          </nav>
        </div>
      </div>
    </div>
  );
}

function buildHref(opts: { page: number; school?: string }) {
  const qs = new URLSearchParams();
  qs.set("page", String(opts.page));
  if (opts.school) qs.set("school", opts.school);
  return `?${qs.toString()}`;
}

function LockGlyph() {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x={3} y={11} width={18} height={11} rx={2} />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}
