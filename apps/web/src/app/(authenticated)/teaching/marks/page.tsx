// /teaching/marks — a teacher's assessments: the tests she has set her own
// classes, each with its approval state, and a form to set a new one.
//
// Only her own: the list is her teachers row's assessments, and the class
// select offers only her classes (lib/teaching) -- the action checks both
// again. A programme admin or super admin sees every teacher's assessments
// here, read-only: they are the approvers. Words: grading.marks.*.

import type { Metadata } from "next";
import Link from "next/link";
import { asc, eq } from "drizzle-orm";
import { getLocale, getTranslations } from "next-intl/server";
import { db } from "@gml/db";
import { subjects } from "@gml/db/schema";
import { hasAnyRole } from "@gml/shared/auth/roles";
import { requireRole } from "@/lib/guards";
import { actorFrom } from "@/lib/visibility";
import { myClassLinks, myTeacher } from "@/lib/teaching";
import { allAssessments, MARKS_READERS, myAssessments, type AssessmentListRow } from "@/lib/grading/marks";
import { scaleOptions } from "@/lib/grading/admin";
import { formatDay, statusChip, statusKey } from "@/lib/grading/display";
import { SubmitButton } from "@/components/SubmitButton";
import { ActionForm } from "@/app/(authenticated)/admin/grading/_ui/action-form";
import { createAssessmentAction } from "./actions";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("grading");
  return { title: t("marks.metaTitle") };
}

const fieldLabel = { display: "grid", gap: 3, fontSize: 11, color: "var(--ink-2)" } as const;

export default async function MarksPage() {
  const session = await requireRole(["teacher", ...MARKS_READERS]);
  const actor = actorFrom(session)!;
  const t = await getTranslations("grading");
  const locale = await getLocale();
  const reader = hasAnyRole(actor.role, MARKS_READERS);

  const classLabel = (grade: number, section: string | null) =>
    section ? t("marks.classSection", { grade, section }) : t("marks.classWhole", { grade });

  const list = (rows: AssessmentListRow[], showTeacher: boolean) =>
    rows.length === 0 ? (
      <p style={{ margin: 0, fontSize: 13, color: "var(--ink-3)" }} data-testid="marks-empty">
        {showTeacher ? t("marks.noneAll") : t("marks.none")}
      </p>
    ) : (
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }} data-testid="marks-list">
        {rows.map((r) => (
          <li key={r.id} className="card" style={{ padding: "10px 12px", display: "grid", gap: 4 }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", justifyContent: "space-between" }}>
              <Link href={`/teaching/marks/${r.id}`} style={{ fontWeight: 500 }}>
                {r.title}
              </Link>
              <span className={statusChip(r.approvalStatus)}>{t(`status.${statusKey(r.approvalStatus)}`)}</span>
            </div>
            <div style={{ fontSize: 12, color: "var(--ink-3)", display: "flex", flexWrap: "wrap", gap: "2px 10px" }}>
              {showTeacher ? <span>{r.teacher}</span> : null}
              <span>{classLabel(r.grade, r.section)}</span>
              <span>{r.subject}</span>
              {r.assessedOn ? <span>{formatDay(r.assessedOn, locale)}</span> : null}
              <span>{t("marks.outOf", { max: r.maxMarks })}</span>
              <span>{t("marks.entered", { count: r.entered })}</span>
            </div>
          </li>
        ))}
      </ul>
    );

  if (reader) {
    const rows = await allAssessments(db);
    return (
      <main>
        <div className="page-header">
          <div className="label">{t("marks.eyebrow")}</div>
          <h1 style={{ fontFamily: "var(--serif)", fontSize: 26, marginTop: 4 }}>{t("marks.titleAll")}</h1>
          <p style={{ color: "var(--ink-3)", marginTop: 6, fontSize: 13, lineHeight: 1.5 }}>
            {t.rich("marks.introAll", { link: (chunks) => <Link href="/approvals">{chunks}</Link> })}
          </p>
        </div>
        <div className="page-body" style={{ maxWidth: 860 }}>
          {list(rows, true)}
        </div>
      </main>
    );
  }

  const me = await myTeacher(db, actor);
  if (!me) {
    return (
      <main>
        <div className="page-header">
          <div className="label">{t("marks.eyebrow")}</div>
          <h1 style={{ fontFamily: "var(--serif)", fontSize: 26, marginTop: 4 }}>{t("marks.title")}</h1>
        </div>
        <div className="page-body">
          <p role="note" style={{ margin: 0, fontSize: 14, maxWidth: 560, lineHeight: 1.5 }} data-testid="marks-not-linked">
            {t("marks.notLinked")}
          </p>
        </div>
      </main>
    );
  }

  const [links, rows, subjectRows, scales] = await Promise.all([
    myClassLinks(db, me.id),
    myAssessments(db, me.id),
    db
      .select({ id: subjects.id, name: subjects.name })
      .from(subjects)
      .where(eq(subjects.active, true))
      .orderBy(asc(subjects.displayOrder), asc(subjects.name)),
    scaleOptions(db, "student"),
  ]);
  const defaultScale = scales.find((s) => s.isDefault);
  const firstSubject = links.find((l) => l.subjectId)?.subjectId ?? "";

  return (
    <main>
      <div className="page-header">
        <div className="label">{t("marks.eyebrow")}</div>
        <h1 style={{ fontFamily: "var(--serif)", fontSize: 26, marginTop: 4 }}>{t("marks.title")}</h1>
        <p style={{ color: "var(--ink-3)", marginTop: 6, fontSize: 13, lineHeight: 1.5, maxWidth: 640 }}>{t("marks.intro")}</p>
      </div>
      <div className="page-body" style={{ display: "grid", gap: 24, maxWidth: 860 }}>
        <section aria-labelledby="new-heading" className="card" style={{ padding: 14, display: "grid", gap: 10 }}>
          <h2 id="new-heading" style={{ fontSize: 16 }}>{t("marks.newHeading")}</h2>
          {links.length === 0 ? (
            <p style={{ margin: 0, fontSize: 13 }} data-testid="marks-no-classes">
              {t.rich("marks.noClasses", { link: (chunks) => <Link href="/teaching/classes">{chunks}</Link> })}
            </p>
          ) : (
            <ActionForm action={createAssessmentAction} style={{ display: "grid", gap: 10, maxWidth: 480 }} testId="new-assessment-form">
              <label style={fieldLabel}>
                {t("marks.form.class")}
                <select className="text" name="classKey" required defaultValue={`${links[0]!.classId}:${links[0]!.section ?? ""}`}>
                  {links.map((l) => (
                    <option key={l.linkId} value={`${l.classId}:${l.section ?? ""}`}>
                      {classLabel(l.grade, l.section)}
                    </option>
                  ))}
                </select>
              </label>
              <label style={fieldLabel}>
                {t("marks.form.subject")}
                <select className="text" name="subjectId" required defaultValue={firstSubject}>
                  <option value="" disabled>
                    {t("form.choose")}
                  </option>
                  {subjectRows.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              <label style={fieldLabel}>
                {t("marks.form.title")}
                <input className="text" name="title" required maxLength={200} />
              </label>
              <label style={fieldLabel}>
                {t("marks.form.maxMarks")}
                <input className="text" name="maxMarks" type="number" inputMode="numeric" min={1} max={1000} step={1} required />
              </label>
              <label style={fieldLabel}>
                {t("marks.form.date")}
                <input className="text" name="assessedOn" type="date" />
              </label>
              <label style={fieldLabel}>
                {t("marks.form.term")}
                <select className="text" name="term" defaultValue="">
                  <option value="">{t("marks.form.noTerm")}</option>
                  {[1, 2, 3, 4, 5, 6].map((n) => (
                    <option key={n} value={n}>
                      {t("marks.form.termN", { n })}
                    </option>
                  ))}
                </select>
              </label>
              <label style={fieldLabel}>
                {t("marks.form.scale")}
                <select className="text" name="gradingScaleId" defaultValue="">
                  <option value="">
                    {defaultScale ? t("marks.form.defaultScale", { name: defaultScale.name }) : t("marks.form.noDefaultScale")}
                  </option>
                  {scales
                    .filter((s) => !s.isDefault)
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                </select>
              </label>
              <div>
                <SubmitButton className="btn btn-primary btn-sm">{t("marks.form.create")}</SubmitButton>
              </div>
            </ActionForm>
          )}
        </section>

        <section aria-labelledby="mine-heading" style={{ display: "grid", gap: 10 }}>
          <h2 id="mine-heading" style={{ fontSize: 16 }}>{t("marks.mineHeading")}</h2>
          {list(rows, false)}
        </section>
      </div>
    </main>
  );
}
