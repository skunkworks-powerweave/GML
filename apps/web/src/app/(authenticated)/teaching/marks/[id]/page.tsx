// /teaching/marks/[id] — one assessment: each student's marks, percentage and
// grade, the class average and pass count, and its approval.
//
//   the teacher who set it   edits the details and the marks while it is a
//                            draft or sent back, and sends it for approval;
//                            pending and approved, it is locked (read-only)
//   programme / super admin  read-only: they approve it from /approvals,
//                            which links here
//   anyone else              404 -- another teacher cannot learn it exists
//
// Grades come from the assessment's student scale, or the default student
// scale (lib/grading/scales resolveScale), through lib/grading/summary.
// Words: grading.marks.* (the editor's: grading.client.marks.*).

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { getLocale, getTranslations } from "next-intl/server";
import { db } from "@gml/db";
import { subjects } from "@gml/db/schema";
import { requireRole } from "@/lib/guards";
import { actorFrom } from "@/lib/visibility";
import { isEditable, latestApprovals } from "@/lib/approvals";
import { getDeviceType } from "@/lib/device";
import { MobileDetailFrame } from "@/components/shells";
import { SubmitButton } from "@/components/SubmitButton";
import { resolveScale } from "@/lib/grading/scales";
import { scaleOptions } from "@/lib/grading/admin";
import { gradeMark, summarise } from "@/lib/grading/summary";
import { formatPct } from "@/lib/grading/format";
import { formatDay, statusChip, statusKey } from "@/lib/grading/display";
import { assessmentAccess, assessmentHeader, markSheet, MARKS_READERS } from "@/lib/grading/marks";
import { ActionForm } from "@/app/(authenticated)/admin/grading/_ui/action-form";
import { saveMarksAction, submitAssessmentAction, updateAssessmentAction } from "../actions";
import { MarksEditor } from "./marks-editor";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("grading");
  return { title: t("marks.detailMetaTitle") };
}

const fieldLabel = { display: "grid", gap: 3, fontSize: 11, color: "var(--ink-2)" } as const;

export default async function AssessmentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requireRole(["teacher", ...MARKS_READERS]);
  const actor = actorFrom(session)!;
  const access = await assessmentAccess(db, actor, id);
  if (!access) notFound();
  const a = await assessmentHeader(db, id);
  if (!a) notFound();

  const t = await getTranslations("grading");
  const locale = await getLocale();
  const [scale, sheet, latest] = await Promise.all([
    resolveScale(db, "student", a.gradingScaleId),
    markSheet(db, a),
    latestApprovals(db, "assessment", [id]),
  ]);
  const bands = scale?.bands ?? null;
  const summary = summarise(sheet, a.maxMarks, bands);
  const last = latest.get(id);
  const editable = access.mode === "owner" && isEditable(a.approvalStatus);
  const classText = a.section ? t("marks.classSection", { grade: a.grade, section: a.section }) : t("marks.classWhole", { grade: a.grade });
  const day = formatDay(a.assessedOn, locale);

  let subjectRows: Array<{ id: string; name: string }> = [];
  let studentScales: Array<{ id: string; name: string; isDefault: boolean }> = [];
  if (editable) {
    [subjectRows, studentScales] = await Promise.all([
      db
        .select({ id: subjects.id, name: subjects.name })
        .from(subjects)
        .where(eq(subjects.active, true))
        .orderBy(asc(subjects.displayOrder), asc(subjects.name)),
      scaleOptions(db, "student"),
    ]);
    // What it has now stays choosable, even if switched off since.
    if (!subjectRows.some((s) => s.id === a.subjectId)) subjectRows.push({ id: a.subjectId, name: a.subject });
    if (a.gradingScaleId && scale && scale.id === a.gradingScaleId && !studentScales.some((s) => s.id === scale.id)) {
      studentScales.push({ id: scale.id, name: scale.name, isDefault: false });
    }
  }
  const defaultScale = studentScales.find((s) => s.isDefault);

  const summaryLine =
    summary.average == null
      ? t("marks.summaryNone", { absent: summary.absent })
      : summary.passed == null
        ? t("marks.summaryNoScale", { graded: summary.graded, average: formatPct(summary.average), absent: summary.absent })
        : t("marks.summary", {
            graded: summary.graded,
            average: formatPct(summary.average),
            grade: summary.averageBand?.label ?? "—",
            passed: summary.passed,
            absent: summary.absent,
          });

  const body = (
    <main>
      <div className="page-header">
        <Link href="/teaching/marks" className="btn btn-sm btn-ghost" style={{ marginBottom: 6, marginLeft: -8 }}>
          {t("marks.back")}
        </Link>
        <div className="label">{t("marks.detailEyebrow", { teacher: a.teacher })}</div>
        <h1 style={{ fontFamily: "var(--serif)", fontSize: 26, marginTop: 4 }}>{a.title}</h1>
        <div style={{ fontSize: 13, color: "var(--ink-3)", marginTop: 6, display: "flex", flexWrap: "wrap", gap: "2px 12px" }}>
          <span>{a.school}</span>
          <span>{classText}</span>
          <span>{a.subject}</span>
          {day ? <span>{day}</span> : null}
          {a.term ? <span>{t("marks.form.termN", { n: a.term })}</span> : null}
          <span>{t("marks.outOf", { max: a.maxMarks })}</span>
          <span>{scale ? t("marks.gradedWith", { name: scale.name }) : t("marks.noScale")}</span>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10, alignItems: "center" }}>
          <span className={statusChip(a.approvalStatus)} data-testid="assessment-status">
            {t(`status.${statusKey(a.approvalStatus)}`)}
          </span>
        </div>
      </div>

      <div className="page-body" style={{ display: "grid", gap: 20, maxWidth: 860 }}>
        {access.mode === "reader" ? (
          <p role="note" style={{ margin: 0, fontSize: 13 }} data-testid="assessment-reader-note">
            {t.rich("marks.readerNote", { link: (chunks) => <Link href="/approvals">{chunks}</Link> })}
          </p>
        ) : !editable ? (
          <p role="note" style={{ margin: 0, fontSize: 13 }} data-testid="assessment-locked">
            {a.approvalStatus === "approved" ? t("marks.lockedApproved") : t("marks.lockedPending")}
          </p>
        ) : null}
        {last?.comment && (last.status === "changes_requested" || last.status === "rejected") ? (
          <div role="note" className="card" style={{ padding: 12, borderColor: "var(--rust)" }} data-testid="assessment-feedback">
            <div className="label">{last.status === "rejected" ? t("marks.rejectedBecause") : t("marks.changesRequested")}</div>
            <p style={{ margin: "4px 0 0", fontSize: 14, whiteSpace: "pre-wrap" }}>{last.comment}</p>
          </div>
        ) : null}

        <section aria-labelledby="marks-heading" style={{ display: "grid", gap: 10 }}>
          <h2 id="marks-heading" style={{ fontSize: 16 }}>{t("marks.marksHeading")}</h2>
          {sheet.length === 0 ? (
            <p style={{ margin: 0, fontSize: 13, color: "var(--ink-3)" }} data-testid="assessment-no-students">
              {access.mode === "owner"
                ? t.rich("marks.noStudents", { link: (chunks) => <Link href="/teaching/students">{chunks}</Link> })
                : t("marks.noStudentsReader")}
            </p>
          ) : editable ? (
            <MarksEditor
              assessmentId={a.id}
              maxMarks={a.maxMarks}
              bands={bands}
              rows={sheet
                .filter((r) => r.onRoster)
                .map((r) => ({
                  learnerId: r.learnerId,
                  name: r.name,
                  rollNumber: r.rollNumber,
                  marks: r.marks == null ? "" : String(r.marks),
                  absent: r.absent,
                  remark: r.remark ?? "",
                }))}
              action={saveMarksAction}
            />
          ) : (
            <>
              <p style={{ margin: 0, fontSize: 13 }} data-testid="assessment-summary">
                {summaryLine}
              </p>
              <div className="card" style={{ padding: 0, overflowX: "auto" }}>
                <table className="t" data-testid="assessment-marks">
                  <thead>
                    <tr>
                      <th>{t("marks.col.roll")}</th>
                      <th>{t("marks.col.student")}</th>
                      <th>{t("marks.col.marks")}</th>
                      <th>{t("marks.col.pct")}</th>
                      <th>{t("marks.col.grade")}</th>
                      <th>{t("marks.col.remark")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sheet.map((r) => {
                      const g = gradeMark(r, a.maxMarks, bands);
                      return (
                        <tr key={r.learnerId}>
                          <td className="mono" style={{ fontSize: 12, color: "var(--ink-3)" }}>{r.rollNumber ?? "—"}</td>
                          <td>
                            {r.name}
                            {!r.onRoster ? <span style={{ fontSize: 11, color: "var(--ink-3)", marginLeft: 6 }}>{t("marks.leftClass")}</span> : null}
                          </td>
                          <td className="mono">{r.absent ? t("marks.absent") : r.marks == null ? "—" : formatPct(r.marks)}</td>
                          <td className="mono">{g.pct == null ? "—" : `${formatPct(g.pct)}%`}</td>
                          <td style={{ color: g.band && !g.band.isPass ? "var(--rust)" : undefined, fontWeight: 600 }}>{g.band?.label ?? "—"}</td>
                          <td style={{ fontSize: 12, color: "var(--ink-2)" }}>{r.remark ?? ""}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>

        {editable ? (
          <>
            <section aria-labelledby="submit-heading" className="card" style={{ padding: 14, display: "grid", gap: 8 }}>
              <h2 id="submit-heading" style={{ fontSize: 16 }}>{t("marks.submitHeading")}</h2>
              <p style={{ margin: 0, fontSize: 12, color: "var(--ink-3)", lineHeight: 1.5 }}>{t("marks.submitHelp")}</p>
              <ActionForm action={submitAssessmentAction} style={{ display: "grid", gap: 8, maxWidth: 480 }} testId="submit-assessment-form">
                <input type="hidden" name="assessmentId" value={a.id} />
                <label style={fieldLabel}>
                  {t("marks.form.note")}
                  <textarea className="text" name="note" rows={2} maxLength={1000} />
                </label>
                <div>
                  <SubmitButton className="btn btn-primary btn-sm">{t("marks.form.submit")}</SubmitButton>
                </div>
              </ActionForm>
            </section>

            <details className="card" style={{ padding: 14 }}>
              <summary style={{ cursor: "pointer", fontWeight: 500 }}>{t("marks.detailsHeading")}</summary>
              <ActionForm action={updateAssessmentAction} style={{ display: "grid", gap: 10, maxWidth: 480, marginTop: 12 }} testId="assessment-details-form">
                <input type="hidden" name="assessmentId" value={a.id} />
                <label style={fieldLabel}>
                  {t("marks.form.title")}
                  <input className="text" name="title" required maxLength={200} defaultValue={a.title} />
                </label>
                <label style={fieldLabel}>
                  {t("marks.form.subject")}
                  <select className="text" name="subjectId" required defaultValue={a.subjectId}>
                    {subjectRows.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label style={fieldLabel}>
                  {t("marks.form.maxMarks")}
                  <input
                    className="text"
                    name="maxMarks"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={1000}
                    step={1}
                    required
                    defaultValue={a.maxMarks}
                  />
                </label>
                <label style={fieldLabel}>
                  {t("marks.form.date")}
                  <input className="text" name="assessedOn" type="date" defaultValue={a.assessedOn ?? ""} />
                </label>
                <label style={fieldLabel}>
                  {t("marks.form.term")}
                  <select className="text" name="term" defaultValue={a.term == null ? "" : String(a.term)}>
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
                  <select className="text" name="gradingScaleId" defaultValue={a.gradingScaleId ?? ""}>
                    <option value="">
                      {defaultScale ? t("marks.form.defaultScale", { name: defaultScale.name }) : t("marks.form.noDefaultScale")}
                    </option>
                    {studentScales
                      .filter((s) => !s.isDefault)
                      .map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                  </select>
                </label>
                <p style={{ margin: 0, fontSize: 12, color: "var(--ink-3)" }}>{t("marks.classFixed", { class: classText })}</p>
                <div>
                  <SubmitButton className="btn btn-sm">{t("form.save")}</SubmitButton>
                </div>
              </ActionForm>
            </details>
          </>
        ) : null}
      </div>
    </main>
  );

  return (await getDeviceType()) === "mobile" ? (
    <MobileDetailFrame title={a.title} backHref="/teaching/marks">
      {body}
    </MobileDetailFrame>
  ) : (
    body
  );
}
