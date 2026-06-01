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
      <header style={{ marginBottom: 22 }}>
        <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--ink-3)" }}>
          Repository
        </div>
        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16 }}>
          <div>
            <h1 style={{ fontFamily: "var(--serif)", fontSize: 28, marginTop: 4 }}>Learners</h1>
            <p style={{ color: "var(--ink-3)", marginTop: 4, fontSize: 13 }}>
              Per-class learner records. Sample shown below; full database is restricted.
            </p>
          </div>
          {isSuperAdmin ? (
            <a
              href={`/api/admin/learners/export${schoolFilter ? `?school=${encodeURIComponent(schoolFilter)}` : ""}`}
              style={{
                padding: "7px 12px",
                background: "var(--ink)",
                color: "var(--paper)",
                borderRadius: "var(--r-2)",
                fontSize: 12,
                textDecoration: "none",
                fontWeight: 500,
                whiteSpace: "nowrap",
              }}
              title="Bulk export learner PII as CSV — super admin only, audited"
            >
              Export CSV
            </a>
          ) : null}
        </div>
      </header>

      <div style={{ display: "grid", gap: 16 }}>
        {/* PII warning card — saffron-soft per JSX line 946 */}
        <div
          style={{
            padding: 14,
            background: "var(--saffron-soft)",
            border: "1px solid oklch(0.82 0.08 60)",
            borderRadius: "var(--r-3)",
            display: "flex",
            gap: 10,
            alignItems: "center",
          }}
        >
          <LockGlyph />
          <span style={{ fontSize: 12, color: "var(--ink-2)" }}>
            Learner records contain PII (name, age, guardian). Access is restricted to school staff and programme
            leads. Bulk export is audited and requires Super Admin approval.
          </span>
        </div>

        <section
          style={{
            background: "var(--card-hi)",
            border: "1px solid var(--line)",
            borderRadius: "var(--r-3)",
            overflow: "hidden",
          }}
        >
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: 13,
            }}
          >
            <thead>
              <tr style={{ background: "var(--paper-2)", textAlign: "left" }}>
                <Th>Name</Th>
                <Th>Class</Th>
                <Th>School</Th>
                <Th>Age</Th>
                <Th>Guardian</Th>
                <Th>Attendance</Th>
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
                rows.map((st, i) => {
                  const attendance = st.attendancePct ?? 0;
                  const goodAttendance = attendance > 90;
                  return (
                    <tr
                      key={st.id}
                      style={{
                        borderTop: i ? "1px solid var(--line)" : "none",
                      }}
                    >
                      <Td>
                        {st.classId ? (
                          <Link
                            href={`/repo/class/${st.classId}`}
                            style={{ color: "var(--ink)", textDecoration: "none", fontWeight: 500 }}
                          >
                            {st.name}
                          </Link>
                        ) : (
                          <span style={{ fontWeight: 500 }}>{st.name}</span>
                        )}
                      </Td>
                      <Td>Grade {st.grade}</Td>
                      <Td>
                        <span style={{ fontFamily: "var(--mono)", fontSize: 11 }}>{st.schoolCode ?? "—"}</span>
                        {st.schoolName ? (
                          <span style={{ color: "var(--ink-3)", marginLeft: 6, fontSize: 11 }}>
                            {st.schoolName}
                          </span>
                        ) : null}
                      </Td>
                      <Td>{st.age ?? "—"}</Td>
                      <Td style={{ fontSize: 12 }}>{st.guardian ?? "—"}</Td>
                      <Td
                        style={{
                          fontFamily: "var(--mono)",
                          fontSize: 12,
                          color: goodAttendance ? "var(--lichen)" : "var(--ink-3)",
                        }}
                      >
                        {st.attendancePct !== null ? `${st.attendancePct}%` : "—"}
                      </Td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>

          <nav
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "10px 14px",
              borderTop: "1px solid var(--line)",
              fontSize: 11,
              color: "var(--ink-3)",
              fontFamily: "var(--mono)",
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
        </section>
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

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th
      style={{
        padding: "10px 14px",
        fontSize: 10,
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        color: "var(--ink-3)",
        borderBottom: "1px solid var(--line)",
      }}
    >
      {children}
    </th>
  );
}

function Td({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <td style={{ padding: "10px 14px", verticalAlign: "middle", ...style }}>{children}</td>;
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
