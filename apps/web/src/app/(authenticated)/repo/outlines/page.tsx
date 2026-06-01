// /repo/outlines — repository index of curriculum course outlines.
// Ports LMS GML Frontend/repository.jsx :: RepoOutlinesIndex (lines 565-599).
// Table by subject × grade × term with status pill; click-through to detail.

import Link from "next/link";
import { asc, eq } from "drizzle-orm";
import { db } from "@gml/db";
import { courseOutlines, subjects, teachers } from "@gml/db/schema";

export const dynamic = "force-dynamic";

const STATUS_CHIP: Record<string, { kind: string; label: string }> = {
  planned: { kind: "chip-ink", label: "Planned" },
  in_progress: { kind: "chip-saffron", label: "In progress" },
  complete: { kind: "chip-lichen", label: "Complete" },
  archived: { kind: "", label: "Archived" },
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
    .leftJoin(subjects, eq(courseOutlines.subjectId, subjects.id))
    .leftJoin(teachers, eq(courseOutlines.ownerTeacherId, teachers.id))
    .orderBy(asc(subjects.name), asc(courseOutlines.grade), asc(courseOutlines.term))
    .limit(200);

  return (
    <div>
      <div className="page-header">
        <div className="label">Repository</div>
        <h1 style={{ fontFamily: "var(--serif)", fontSize: 28, marginTop: 4 }}>Course outlines</h1>
        <p style={{ color: "var(--ink-3)", marginTop: 4 }}>
          Term-level units per subject × grade. Each outline holds the learning outcomes, weekly lessons and the
          sessions delivered against it.
        </p>
      </div>
      <div className="page-body">
        <div className="card card-hi" style={{ overflow: "hidden" }}>
          {rows.length === 0 ? (
            <div style={{ padding: 32, textAlign: "center", color: "var(--ink-3)" }}>
              No outlines yet. Seed via <code className="mono" style={{ fontSize: 12 }}>/admin/data/course-outlines</code>.
            </div>
          ) : (
            <table className="t">
              <thead>
                <tr>
                  <th>Outline</th>
                  <th>Subject</th>
                  <th>Grade</th>
                  <th>Term</th>
                  <th>Sessions</th>
                  <th>Weeks</th>
                  <th>Owner</th>
                  <th>Status</th>
                  <th aria-label="open" />
                </tr>
              </thead>
              <tbody>
                {rows.map((o) => {
                  const chip = STATUS_CHIP[o.status] ?? STATUS_CHIP.planned;
                  return (
                    <tr key={o.id}>
                      <td style={{ fontWeight: 500 }}>
                        <Link
                          href={`/repo/outline/${o.id}`}
                          style={{ color: "var(--ink)", textDecoration: "none" }}
                        >
                          {o.name}
                        </Link>
                      </td>
                      <td>
                        {o.subjectName ?? <span style={{ color: "var(--ink-3)" }}>—</span>}
                      </td>
                      <td>{o.grade}</td>
                      <td>{o.term}</td>
                      <td>{o.sessionsCount}</td>
                      <td>{o.weeks ?? <span style={{ color: "var(--ink-3)" }}>—</span>}</td>
                      <td>
                        {o.ownerName ? (
                          <>
                            {o.ownerName}
                            {o.ownerHindi ? (
                              <span
                                className="deva"
                                style={{ color: "var(--ink-3)", marginLeft: 6, fontSize: 12, fontFamily: "var(--deva)" }}
                              >
                                {o.ownerHindi}
                              </span>
                            ) : null}
                          </>
                        ) : (
                          <span style={{ color: "var(--ink-3)" }}>—</span>
                        )}
                      </td>
                      <td>
                        <span className={`chip ${chip.kind}`.trim()}>{chip.label}</span>
                      </td>
                      <td style={{ textAlign: "right" }}>
                        <Link
                          href={`/repo/outline/${o.id}`}
                          style={{ fontSize: 12, color: "var(--ink-3)", textDecoration: "none" }}
                          aria-label={`Open ${o.name}`}
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

