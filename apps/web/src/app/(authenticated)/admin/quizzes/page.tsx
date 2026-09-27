// /admin/quizzes — Index of all quizzes. Mirrors the /admin/forms (spec 073)
// pattern: server component, role-gated to programme_admin + super_admin,
// renders a sortable table with edit links. Revives spec 080 (quiz builder
// framing) at the navigation layer.
//
// Words are in the user's language (adminData.quizzes); quiz titles, slugs
// and subject names are data.

import Link from "next/link";
import { asc, eq, sql } from "drizzle-orm";
import { getTranslations } from "next-intl/server";
import { db } from "@gml/db";
import { phases, quizzes, quizQuestions, rttSubjects, terms } from "@gml/db/schema";
import { requireRole } from "@/lib/guards";
import { NewQuizForm } from "./new-quiz-form";

export const dynamic = "force-dynamic";

export default async function AdminQuizzesIndexPage() {
  await requireRole(["programme_admin", "super_admin"]);
  const t = await getTranslations("adminData");

  // Question counts per quiz. A join, not a correlated subquery: in a
  // single-table select Drizzle leaves columns unqualified, and inside the
  // subquery "id" bound to quiz_questions.id, so every count read 0.
  const rows = await db
    .select({
      id: quizzes.id,
      slug: quizzes.slug,
      title: quizzes.title,
      passThreshold: quizzes.passThreshold,
      active: quizzes.active,
      subjectId: quizzes.subjectId,
      rttSubjectId: quizzes.rttSubjectId,
      questionCount: sql<number>`count(${quizQuestions.id})::int`,
    })
    .from(quizzes)
    .leftJoin(quizQuestions, eq(quizQuestions.quizId, quizzes.id))
    .groupBy(quizzes.id)
    .orderBy(asc(quizzes.title));

  // The subjects a new quiz can be bound to. Labelled with phase and term
  // because subject names repeat across terms ("English" in every one).
  const subjectRows = await db
    .select({
      id: rttSubjects.id,
      name: rttSubjects.name,
      term: terms.name,
      phase: phases.label,
    })
    .from(rttSubjects)
    .innerJoin(terms, eq(terms.id, rttSubjects.termId))
    .innerJoin(phases, eq(phases.id, terms.phaseId))
    .where(eq(rttSubjects.active, true))
    .orderBy(asc(phases.sequence), asc(terms.sequence), asc(rttSubjects.name));
  const subjects = subjectRows.map((s) => ({ id: s.id, label: `${s.phase} · ${s.term} · ${s.name}` }));

  return (
    <main>
      <div className="page-header">
        <div className="label">{t("common.formsAndQuizzes")}</div>
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
              {t("quizzes.title")}
            </h1>
            <p style={{ color: "var(--ink-3)", marginTop: 4, maxWidth: 640 }}>{t("quizzes.intro")}</p>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
            <NewQuizForm subjects={subjects} />
            <Link
              href="/admin/forms"
              className="chip"
              style={{ textDecoration: "none" }}
              title={t("quizzes.toFormsTitle")}
            >
              {t("quizzes.toForms")}
            </Link>
          </div>
        </div>
      </div>

      <div className="page-body">
        <div className="card card-hi" style={{ overflow: "hidden" }}>
          <table className="t">
            <thead>
              <tr>
                <th>{t("quizzes.columns.title")}</th>
                <th>{t("quizzes.columns.slug")}</th>
                <th>{t("quizzes.columns.scope")}</th>
                <th>{t("quizzes.columns.questions")}</th>
                <th>{t("quizzes.columns.pass")}</th>
                <th>{t("quizzes.columns.active")}</th>
                <th style={{ textAlign: "right" }}>{"\u00a0"}</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td
                    colSpan={7}
                    style={{ padding: 36, textAlign: "center", color: "var(--ink-3)" }}
                  >
                    {/* The old copy said "Seed via SQL or use the JSON editor on
                        the detail page" -- neither was followable: there is no
                        quiz seed script, and the detail page needs an id that
                        could not be obtained. */}
                    {t("quizzes.empty")}
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
                          ? t("quizzes.scope.subject")
                          : r.rttSubjectId
                            ? t("quizzes.scope.rttSubject")
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
                        {r.active ? t("common.active") : t("common.inactive")}
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
                        {t("quizzes.edit")}
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
          {t("quizzes.footer", { count: rows.length })}
        </p>
      </div>
    </main>
  );
}
