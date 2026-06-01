// /admin/quizzes — Index of all quizzes. Mirrors the /admin/forms (spec 073)
// pattern: server component, role-gated to programme_admin + super_admin,
// renders a sortable table with edit links. Revives spec 080 (quiz builder
// framing) at the navigation layer.

import Link from "next/link";
import { asc, eq, sql } from "drizzle-orm";
import { db } from "@gml/db";
import { quizzes, quizQuestions } from "@gml/db/schema";
import { requireRole } from "@/lib/guards";

export const dynamic = "force-dynamic";

export default async function AdminQuizzesIndexPage() {
  await requireRole(["programme_admin", "super_admin"]);

  // Question counts per quiz — small grouped query to keep the index honest.
  const rows = await db
    .select({
      id: quizzes.id,
      slug: quizzes.slug,
      title: quizzes.title,
      passThreshold: quizzes.passThreshold,
      active: quizzes.active,
      subjectId: quizzes.subjectId,
      rttSubjectId: quizzes.rttSubjectId,
      questionCount: sql<number>`(
        SELECT COUNT(*)::int FROM ${quizQuestions} WHERE ${quizQuestions.quizId} = ${quizzes.id}
      )`,
    })
    .from(quizzes)
    .orderBy(asc(quizzes.title));

  return (
    <main>
      <div className="page-header">
        <div className="label">Forms & Quizzes</div>
        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "space-between",
            gap: 16,
            marginTop: 4,
          }}
        >
          <div>
            <h1 style={{ fontFamily: "var(--serif)", fontSize: 26, margin: 0 }}>
              Programme quizzes
            </h1>
            <p style={{ color: "var(--ink-3)", marginTop: 4, maxWidth: 640 }}>
              Quizzes are defined as JSON — admins compose questions; teachers and mentors
              take them. Editing a quiz lands in the audit log.
            </p>
          </div>
          <Link
            href="/admin/forms"
            className="chip"
            style={{ textDecoration: "none" }}
            title="Switch to the feedback-form registry"
          >
            → Feedback forms
          </Link>
        </div>
      </div>

      <div className="page-body">
        <div className="card card-hi" style={{ overflow: "hidden" }}>
          <table className="t">
            <thead>
              <tr>
                <th>Title</th>
                <th>Slug</th>
                <th>Scope</th>
                <th>Questions</th>
                <th>Pass</th>
                <th>Active</th>
                <th style={{ textAlign: "right" }}>&nbsp;</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td
                    colSpan={7}
                    style={{ padding: 36, textAlign: "center", color: "var(--ink-3)" }}
                  >
                    No quizzes yet. Seed via SQL or use the JSON editor on the detail page.
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link
                        href={`/admin/quizzes/${r.id}`}
                        style={{
                          color: "var(--ink)",
                          fontFamily: "var(--serif)",
                          fontSize: 16,
                          textDecoration: "none",
                        }}
                      >
                        {r.title}
                      </Link>
                    </td>
                    <td
                      style={{
                        fontFamily: "var(--mono)",
                        fontSize: 12,
                        color: "var(--ink-2)",
                      }}
                    >
                      {r.slug}
                    </td>
                    <td>
                      <span className="chip">
                        {r.subjectId
                          ? "subject"
                          : r.rttSubjectId
                            ? "rtt_subject"
                            : "—"}
                      </span>
                    </td>
                    <td
                      style={{
                        fontFamily: "var(--mono)",
                        fontSize: 12,
                        color: "var(--ink-2)",
                      }}
                    >
                      {r.questionCount}
                    </td>
                    <td
                      style={{
                        fontFamily: "var(--mono)",
                        fontSize: 12,
                        color: "var(--ink-2)",
                      }}
                    >
                      {r.passThreshold}%
                    </td>
                    <td>
                      <span className={r.active ? "chip chip-lichen" : "chip"}>
                        {r.active ? "active" : "inactive"}
                      </span>
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <Link
                        href={`/admin/quizzes/${r.id}`}
                        style={{
                          fontSize: 12,
                          color: "var(--indigo)",
                          textDecoration: "none",
                          fontWeight: 500,
                        }}
                      >
                        Edit →
                      </Link>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <p
          style={{
            marginTop: 14,
            fontSize: 11,
            color: "var(--ink-3)",
            fontFamily: "var(--mono)",
            background: "var(--paper-2)",
            padding: "6px 10px",
            borderRadius: "var(--r-2)",
            display: "inline-block",
          }}
        >
          {rows.length} quiz{rows.length === 1 ? "" : "zes"} · ordered by title
        </p>
      </div>
    </main>
  );
}
