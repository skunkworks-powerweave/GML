// /repo/outlines — repository index of curriculum course outlines.
// Ports LMS GML Frontend/repository.jsx :: RepoOutlinesIndex (lines 565-599).
// Table by subject × grade × term with status pill; click-through to detail.

import Link from "next/link";
import { asc } from "drizzle-orm";
import { db } from "@gml/db";
import { courseOutlines, subjects, teachers } from "@gml/db/schema";

export const dynamic = "force-dynamic";

const STATUS_STYLE: Record<string, { bg: string; ink: string; label: string }> = {
  planned: { bg: "var(--paper-2)", ink: "var(--ink-3)", label: "Planned" },
  in_progress: { bg: "var(--saffron-soft)", ink: "var(--saffron)", label: "In progress" },
  complete: { bg: "var(--lichen-soft)", ink: "var(--lichen)", label: "Complete" },
  archived: { bg: "var(--paper-2)", ink: "var(--ink-3)", label: "Archived" },
};

export default async function RepoOutlinesIndexPage() {
  const rows = await db
    .select({
      id: courseOutlines.id,
      name: courseOutlines.name,
      grade: courseOutlines.grade,
      term: courseOutlines.term,
      weeks: courseOutlines.weeks,
      sessionsCount: courseOutlines.sessionsCount,
      status: courseOutlines.status,
      subjectName: subjects.name,
      subjectColor: subjects.color,
      ownerName: teachers.fullName,
      ownerHindi: teachers.hindiName,
    })
    .from(courseOutlines)
    .leftJoin(subjects, eqCol(courseOutlines.subjectId, subjects.id))
    .leftJoin(teachers, eqCol(courseOutlines.ownerTeacherId, teachers.id))
    .orderBy(asc(subjects.name), asc(courseOutlines.grade), asc(courseOutlines.term))
    .limit(200);

  return (
    <div>
      <header style={{ marginBottom: 22 }}>
        <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--ink-3)" }}>
          Repository
        </div>
        <h1 style={{ fontFamily: "var(--serif)", fontSize: 28, marginTop: 4 }}>Course outlines</h1>
        <p style={{ color: "var(--ink-3)", fontSize: 13, marginTop: 4, maxWidth: 760 }}>
          Term-level units per subject × grade. Each outline holds the learning outcomes, weekly lessons and the
          sessions delivered against it.
        </p>
      </header>

      <section
        style={{
          background: "var(--card-hi)",
          border: "1px solid var(--line)",
          borderRadius: "var(--r-3)",
          overflow: "hidden",
        }}
      >
        {rows.length === 0 ? (
          <div style={{ padding: 32, textAlign: "center", color: "var(--ink-3)" }}>
            No outlines yet. Seed via <code style={{ fontFamily: "var(--mono)", fontSize: 12 }}>/admin/data/course-outlines</code>.
          </div>
        ) : (
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: 13,
            }}
          >
            <thead>
              <tr style={{ background: "var(--paper-2)" }}>
                <Th>Outline</Th>
                <Th>Subject</Th>
                <Th align="right">Grade</Th>
                <Th align="right">Term</Th>
                <Th align="right">Sessions</Th>
                <Th align="right">Weeks</Th>
                <Th>Owner</Th>
                <Th>Status</Th>
                <Th aria-label="open" />
              </tr>
            </thead>
            <tbody>
              {rows.map((o, i) => {
                const style = STATUS_STYLE[o.status] ?? STATUS_STYLE.planned;
                return (
                  <tr
                    key={o.id}
                    style={{
                      borderTop: i ? "1px solid var(--line)" : "none",
                    }}
                  >
                    <Td>
                      <Link
                        href={`/repo/outline/${o.id}`}
                        style={{ color: "var(--ink)", fontWeight: 500, textDecoration: "none" }}
                      >
                        {o.name}
                      </Link>
                    </Td>
                    <Td>
                      {o.subjectName ? (
                        <span
                          style={{
                            padding: "2px 8px",
                            background: o.subjectColor ?? "var(--paper-2)",
                            color: "var(--ink-2)",
                            borderRadius: 999,
                            fontSize: 11,
                          }}
                        >
                          {o.subjectName}
                        </span>
                      ) : (
                        <span style={{ color: "var(--ink-3)" }}>—</span>
                      )}
                    </Td>
                    <Td align="right" mono>
                      {o.grade}
                    </Td>
                    <Td align="right" mono>
                      {o.term}
                    </Td>
                    <Td align="right" mono>
                      {o.sessionsCount}
                    </Td>
                    <Td align="right" mono>
                      {o.weeks ?? "—"}
                    </Td>
                    <Td>
                      {o.ownerName ? (
                        <>
                          {o.ownerName}
                          {o.ownerHindi ? (
                            <span style={{ fontFamily: "var(--deva)", color: "var(--ink-3)", marginLeft: 6, fontSize: 12 }}>
                              {o.ownerHindi}
                            </span>
                          ) : null}
                        </>
                      ) : (
                        <span style={{ color: "var(--ink-3)" }}>—</span>
                      )}
                    </Td>
                    <Td>
                      <span
                        style={{
                          padding: "2px 8px",
                          background: style.bg,
                          color: style.ink,
                          borderRadius: 999,
                          fontSize: 10,
                          textTransform: "uppercase",
                          letterSpacing: "0.06em",
                          fontWeight: 600,
                        }}
                      >
                        {style.label}
                      </span>
                    </Td>
                    <Td align="right">
                      <Link
                        href={`/repo/outline/${o.id}`}
                        style={{
                          fontSize: 11,
                          color: "var(--ink-3)",
                          textDecoration: "none",
                        }}
                        aria-label={`Open ${o.name}`}
                      >
                        ›
                      </Link>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function Th({ children, align = "left", ...rest }: { children?: React.ReactNode; align?: "left" | "right" } & React.ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      {...rest}
      style={{
        textAlign: align,
        padding: "10px 14px",
        fontSize: 10,
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        color: "var(--ink-3)",
        fontWeight: 600,
        borderBottom: "1px solid var(--line)",
      }}
    >
      {children}
    </th>
  );
}

function Td({ children, align = "left", mono = false }: { children?: React.ReactNode; align?: "left" | "right"; mono?: boolean }) {
  return (
    <td
      style={{
        padding: "12px 14px",
        textAlign: align,
        fontFamily: mono ? "var(--mono)" : undefined,
        fontSize: mono ? 12 : undefined,
        color: mono ? "var(--ink-2)" : undefined,
      }}
    >
      {children}
    </td>
  );
}

// Tiny local FK join helper — mirrors mentorship/page.tsx + observation/page.tsx.
function eqCol<T>(a: T, b: T) {
  // @ts-expect-error drizzle's eq is the right type here; this wrapper exists only to shorten imports
  return require("drizzle-orm").eq(a, b);
}
