// /repo/class/[id]/learners — PII-gated full roster (SM-9).
//
// Rules:
//   1. requireRole(["super_admin","programme_admin"]) — anyone else → /forbidden
//   2. recordAudit({action:"learners.view", ...}) fires BEFORE the DB read on every render
//      so the audit row exists even if the SELECT later errors.
//   3. The page reads learners.name + guardian + age + attendance% (the PII columns)
//      — that's why the audit is mandatory.

import { notFound } from "next/navigation";
import Link from "next/link";
import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "@gml/db";
import { classes, learners, schools } from "@gml/db/schema";
import { requireRole } from "@/lib/guards";
import { recordAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

export default async function RepoClassLearnersPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  // SM-9 step 1: gate on role. Non-privileged callers never reach the audit hook OR the DB.
  await requireRole(["super_admin", "programme_admin"]);

  const [cls] = await db.select().from(classes).where(eq(classes.id, id)).limit(1);
  if (!cls) notFound();

  const [school] = await db.select().from(schools).where(eq(schools.id, cls.schoolId)).limit(1);

  // SM-9 step 2: audit-log this PII access BEFORE the SELECT. Fire-and-forget — a failed
  // audit insert never blocks the page render (mirrors admin/data/[entity] behaviour).
  void recordAudit({
    action: "learners.view",
    entityType: "class",
    entityId: id,
    metadata: { route: "/repo/class/[id]/learners", schoolId: cls.schoolId, grade: cls.grade },
  });

  const rows = await db
    .select({
      id: learners.id,
      name: learners.name,
      age: learners.age,
      guardian: learners.guardian,
      rollNumber: learners.rollNumber,
      section: learners.section,
      attendancePct: learners.attendancePct,
      active: learners.active,
    })
    .from(learners)
    .where(and(eq(learners.classId, id), isNull(learners.deletedAt)))
    .orderBy(asc(learners.rollNumber), asc(learners.name))
    .limit(80);

  return (
    <div>
      <header style={{ marginBottom: 20 }}>
        <Link
          href={`/repo/class/${id}`}
          style={{ fontSize: 12, color: "var(--ink-3)", textDecoration: "none" }}
        >
          ← Grade {cls.grade}
        </Link>
        <div
          style={{
            fontSize: 10,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            color: "var(--ink-3)",
            marginTop: 8,
          }}
        >
          Roster · {school?.code ?? "—"} · Grade {cls.grade}
        </div>
        <h1 style={{ fontFamily: "var(--serif)", fontSize: 26, marginTop: 4 }}>Learners</h1>
        <p style={{ color: "var(--ink-3)", fontSize: 12, marginTop: 6 }}>
          {rows.length} of {cls.studentsCount} on record. PII access is logged (SM-9): your view of this
          page is recorded in audit_log under <code style={{ fontFamily: "var(--mono)" }}>learners.view</code>.
        </p>
      </header>

      <article
        style={{
          background: "var(--card-hi)",
          border: "1px solid var(--line)",
          borderRadius: "var(--r-3)",
          padding: 16,
        }}
      >
        {rows.length === 0 ? (
          <p style={{ fontSize: 12, color: "var(--ink-3)", padding: 20, textAlign: "center" }}>
            No learners on record for this class.
          </p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr
                style={{
                  textAlign: "left",
                  fontSize: 10,
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                  color: "var(--ink-3)",
                }}
              >
                <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--line)" }}>Roll</th>
                <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--line)" }}>Name</th>
                <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--line)" }}>Section</th>
                <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--line)" }}>Age</th>
                <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--line)" }}>Guardian</th>
                <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--line)" }}>Attendance</th>
                <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--line)" }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const att = r.attendancePct ?? null;
                const attColor =
                  att == null
                    ? "var(--ink-3)"
                    : att >= 90
                      ? "var(--lichen)"
                      : att >= 75
                        ? "var(--ink-2)"
                        : "var(--rust)";
                return (
                  <tr key={r.id}>
                    <td
                      style={{
                        padding: "8px",
                        borderBottom: "1px solid var(--hairline)",
                        fontFamily: "var(--mono)",
                        fontSize: 12,
                        color: "var(--ink-3)",
                      }}
                    >
                      {r.rollNumber ?? "—"}
                    </td>
                    <td
                      style={{
                        padding: "8px",
                        borderBottom: "1px solid var(--hairline)",
                        fontWeight: 500,
                      }}
                    >
                      {r.name}
                    </td>
                    <td
                      style={{
                        padding: "8px",
                        borderBottom: "1px solid var(--hairline)",
                        fontFamily: "var(--mono)",
                        fontSize: 12,
                      }}
                    >
                      {r.section ?? "—"}
                    </td>
                    <td
                      style={{
                        padding: "8px",
                        borderBottom: "1px solid var(--hairline)",
                        fontSize: 12,
                      }}
                    >
                      {r.age ?? "—"}
                    </td>
                    <td
                      style={{
                        padding: "8px",
                        borderBottom: "1px solid var(--hairline)",
                        fontSize: 12,
                        color: "var(--ink-2)",
                      }}
                    >
                      {r.guardian ?? "—"}
                    </td>
                    <td
                      style={{
                        padding: "8px",
                        borderBottom: "1px solid var(--hairline)",
                        fontFamily: "var(--mono)",
                        fontSize: 12,
                        color: attColor,
                        fontWeight: 600,
                      }}
                    >
                      {att == null ? "—" : `${att}%`}
                    </td>
                    <td
                      style={{
                        padding: "8px",
                        borderBottom: "1px solid var(--hairline)",
                        fontSize: 11,
                      }}
                    >
                      <span
                        style={{
                          padding: "2px 8px",
                          background: r.active ? "var(--lichen-soft)" : "var(--paper-2)",
                          color: r.active ? "var(--lichen)" : "var(--ink-3)",
                          borderRadius: 999,
                          fontSize: 10,
                          textTransform: "uppercase",
                          letterSpacing: "0.06em",
                          fontWeight: 600,
                        }}
                      >
                        {r.active ? "Active" : "Inactive"}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </article>

      <p style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 16, fontStyle: "italic" }}>
        Showing first 80 learners. For larger rosters, export via /admin/data/learners.
      </p>
    </div>
  );
}
