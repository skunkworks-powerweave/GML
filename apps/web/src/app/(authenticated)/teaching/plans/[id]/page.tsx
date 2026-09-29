// /teaching/plans/[id] -- one lesson plan.
//
// Who sees what (decided here, on the server; the actions check again):
//   her own plan          editable while draft, changes requested or rejected;
//                         locked while pending and once approved
//   a programme outline   read-only, with "Start my plan from this outline"
//   another teacher's     404 for a teacher
//   programme admin /     read-only, any plan: they are the approvers, and the
//   super admin           queue (/approvals) links here
// Mentors and observers have no business here (requireRole).

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@gml/db";
import { courseOutlines, outlineLessons, subjects, teachers } from "@gml/db/schema";
import { requireRole } from "@/lib/guards";
import { uuidOrNotFound } from "@/lib/ids";
import { actorFrom } from "@/lib/visibility";
import { getDeviceType } from "@/lib/device";
import { isEditable } from "@/lib/approvals";
import { myTeacher } from "@/lib/teaching";
import { isApprover } from "@/lib/teaching/current";
import { activeSubjects, approvalHistory } from "@/lib/teaching/records";
import { SubmitButton } from "@/components/SubmitButton";
import { MobileDetailFrame } from "@/components/shells";
import { ActionForm } from "../../_components/ActionForm";
import {
  ApprovalPanel,
  ApproverBanner,
  Card,
  Empty,
  Field,
  fieldGrid,
  listRow,
  mutedText,
  PageHeader,
  StateChip,
  wrapRow,
  type Translate,
} from "../../_components/ui";
import {
  copyOutlineAction,
  deleteLessonAction,
  deletePlanAction,
  moveLessonAction,
  saveLessonAction,
  submitPlanAction,
  updatePlanAction,
} from "../actions";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("teaching");
  return { title: t("plan.metaTitle") };
}

const GRADES = Array.from({ length: 12 }, (_, i) => i + 1);
const TERMS = [1, 2, 3, 4, 5, 6];

type Lesson = typeof outlineLessons.$inferSelect;

function LessonFields({ t, l }: { t: Translate; l?: Lesson }) {
  return (
    <>
      <div style={fieldGrid}>
        <Field label={t("fields.lessonTitle")}>
          <input name="title" className="text" required maxLength={240} defaultValue={l?.title ?? ""} autoComplete="off" />
        </Field>
        <Field label={t("fields.weekOptional")}>
          <input name="week" className="text" type="number" min={1} max={52} defaultValue={l?.week ?? ""} />
        </Field>
      </div>
      <Field label={t("fields.objectives")}>
        <textarea name="objectives" className="text" rows={2} maxLength={4000} defaultValue={l?.objectives ?? ""} />
      </Field>
      <Field label={t("fields.activities")}>
        <textarea name="activities" className="text" rows={3} maxLength={4000} defaultValue={l?.activities ?? ""} />
      </Field>
      <Field label={t("fields.materials")}>
        <textarea name="materials" className="text" rows={2} maxLength={4000} defaultValue={l?.materials ?? ""} />
      </Field>
    </>
  );
}

/** A lesson's plan, read-only: objectives, activities and materials as written. */
function LessonBody({ t, l }: { t: Translate; l: Lesson }) {
  const parts = (["objectives", "activities", "materials"] as const).filter((k) => l[k]);
  if (parts.length === 0) return null;
  return (
    <dl style={{ margin: 0, display: "grid", gap: 6 }}>
      {parts.map((k) => (
        <div key={k}>
          <dt className="label">{t(`fields.${k}`)}</dt>
          <dd style={{ margin: 0, fontSize: 13, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{l[k]}</dd>
        </div>
      ))}
    </dl>
  );
}

export default async function PlanPage({ params }: { params: Promise<{ id: string }> }) {
  const id = uuidOrNotFound((await params).id);
  const session = await requireRole(["teacher", "programme_admin", "super_admin"]);
  const actor = actorFrom(session)!;
  const approver = isApprover(actor);
  const teacher = approver ? null : await myTeacher(db, actor);
  const t = await getTranslations("teaching");

  const [plan] = await db
    .select({
      id: courseOutlines.id,
      name: courseOutlines.name,
      subjectId: courseOutlines.subjectId,
      subject: subjects.name,
      grade: courseOutlines.grade,
      term: courseOutlines.term,
      weeks: courseOutlines.weeks,
      outcomes: courseOutlines.learningOutcomes,
      owner: courseOutlines.ownerTeacherId,
      ownerName: teachers.fullName,
      state: courseOutlines.approvalStatus,
    })
    .from(courseOutlines)
    .leftJoin(subjects, eq(subjects.id, courseOutlines.subjectId))
    .leftJoin(teachers, eq(teachers.id, courseOutlines.ownerTeacherId))
    .where(eq(courseOutlines.id, id))
    .limit(1);
  if (!plan) notFound();

  const isProgramme = plan.owner === null;
  const mine = !!teacher && plan.owner === teacher.id;
  // A teacher sees her own plans and the programme's outlines; nobody else's.
  if (!approver && !mine && !(isProgramme && plan.state === "approved")) notFound();
  const editable = mine && isEditable(plan.state);

  const [lessons, history, subjectRows, [existing]] = await Promise.all([
    db.select().from(outlineLessons).where(eq(outlineLessons.outlineId, plan.id)).orderBy(asc(outlineLessons.sequence)),
    isProgramme ? Promise.resolve([]) : approvalHistory(db, "lesson_plan", plan.id),
    editable ? activeSubjects(db) : Promise.resolve([]),
    // Her own plan for the same subject, grade and term, if she opens a programme outline.
    teacher && isProgramme
      ? db
          .select({ id: courseOutlines.id })
          .from(courseOutlines)
          .where(
            and(
              eq(courseOutlines.ownerTeacherId, teacher.id),
              eq(courseOutlines.subjectId, plan.subjectId),
              eq(courseOutlines.grade, plan.grade),
              eq(courseOutlines.term, plan.term),
            ),
          )
          .limit(1)
      : Promise.resolve([]),
  ]);

  const meta = t("plan.meta", { subject: plan.subject ?? "", grade: plan.grade, term: plan.term });
  const body = (
    <div>
      <PageHeader
        label={isProgramme ? t("plan.programmeLabel") : t("plan.label")}
        title={plan.name}
        intro={plan.weeks ? t("plan.metaWeeks", { meta, weeks: plan.weeks }) : meta}
        back={approver ? { href: "/approvals", text: t("approval.queue") } : { href: "/teaching/plans", text: t("plans.title") }}
      />
      <div className="page-body" style={{ display: "grid", gap: 16 }}>
        {approver && !isProgramme ? <ApproverBanner t={t} teacher={plan.ownerName ?? ""} /> : null}
        {isProgramme ? (
          <section className="card card-hi" style={{ padding: 14, display: "grid", gap: 10 }}>
            <p style={{ margin: 0, fontSize: 13, color: "var(--ink-2)" }}>{t("plan.programmeNote")}</p>
            {teacher ? (
              <div style={wrapRow}>
                {existing ? (
                  <Link href={`/teaching/plans/${existing.id}`} className="btn btn-sm">
                    {t("plans.openMine")}
                  </Link>
                ) : (
                  <ActionForm action={copyOutlineAction}>
                    <input type="hidden" name="sourceId" value={plan.id} />
                    <SubmitButton className="btn btn-primary btn-sm">{t("plans.startFrom")}</SubmitButton>
                  </ActionForm>
                )}
              </div>
            ) : null}
          </section>
        ) : (
          <ApprovalPanel
            t={t}
            state={plan.state}
            history={history}
            itemId={plan.id}
            readOnly={approver}
            submit={mine ? submitPlanAction : undefined}
            blocker={lessons.length === 0 ? t("plan.needsLessons") : null}
          />
        )}

        {editable ? (
          <Card title={t("plan.detailsTitle")}>
            <ActionForm action={updatePlanAction}>
              <input type="hidden" name="id" value={plan.id} />
              <div style={fieldGrid}>
                <Field label={t("fields.subject")}>
                  <select name="subjectId" className="text" required defaultValue={plan.subjectId}>
                    {subjectRows.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t("fields.grade")}>
                  <select name="grade" className="text" required defaultValue={String(plan.grade)}>
                    {GRADES.map((g) => (
                      <option key={g} value={g}>
                        {t("common.gradeN", { grade: g })}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t("fields.term")}>
                  <select name="term" className="text" required defaultValue={String(plan.term)}>
                    {TERMS.map((n) => (
                      <option key={n} value={n}>
                        {t("common.termN", { term: n })}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t("fields.weeksOptional")}>
                  <input name="weeks" className="text" type="number" min={1} max={52} defaultValue={plan.weeks ?? ""} />
                </Field>
              </div>
              <Field label={t("fields.planName")}>
                <input name="name" className="text" required maxLength={200} defaultValue={plan.name} autoComplete="off" />
              </Field>
              <Field label={t("fields.outcomes")} hint={t("plans.outcomesHint")}>
                <textarea name="learningOutcomes" className="text" rows={4} maxLength={4000} defaultValue={plan.outcomes.join("\n")} />
              </Field>
              <div>
                <SubmitButton className="btn btn-primary">{t("common.save")}</SubmitButton>
              </div>
            </ActionForm>
            <details>
              <summary style={{ cursor: "pointer", fontSize: 13, color: "var(--rust)" }}>{t("plan.delete")}</summary>
              <ActionForm action={deletePlanAction} style={{ marginTop: 8 }}>
                <input type="hidden" name="id" value={plan.id} />
                <p style={{ ...mutedText, margin: 0 }}>{t("plan.deleteConfirm", { count: lessons.length })}</p>
                <div>
                  <SubmitButton className="btn btn-sm">{t("plan.deleteYes")}</SubmitButton>
                </div>
              </ActionForm>
            </details>
          </Card>
        ) : (
          <Card title={t("plan.outcomesTitle")}>
            {plan.outcomes.length === 0 ? (
              <Empty>{t("plan.noOutcomes")}</Empty>
            ) : (
              <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 4, fontSize: 13 }}>
                {plan.outcomes.map((o, i) => (
                  <li key={i} style={{ overflowWrap: "anywhere" }}>
                    {o}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}

        <Card title={t("plan.lessonsTitle", { count: lessons.length })} sub={editable ? t("plan.lessonsSub") : undefined}>
          {lessons.length === 0 ? (
            <Empty>{t("plan.noLessons")}</Empty>
          ) : (
            <ol style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 8 }}>
              {lessons.map((l, i) => (
                <li key={l.id} style={{ ...listRow, display: "grid", gap: 8 }}>
                  <div style={{ ...wrapRow, justifyContent: "space-between" }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600, overflowWrap: "anywhere" }}>{t("plan.lessonHeading", { n: l.sequence, title: l.title })}</div>
                      {l.week ? <div style={mutedText}>{t("common.weekN", { week: l.week })}</div> : null}
                    </div>
                    {editable ? (
                      <div style={wrapRow}>
                        <ActionForm action={moveLessonAction}>
                          <input type="hidden" name="id" value={plan.id} />
                          <input type="hidden" name="lessonId" value={l.id} />
                          <input type="hidden" name="direction" value="up" />
                          <SubmitButton className="btn btn-sm" disabled={i === 0} aria-label={t("plan.moveUp", { title: l.title })}>
                            ↑
                          </SubmitButton>
                        </ActionForm>
                        <ActionForm action={moveLessonAction}>
                          <input type="hidden" name="id" value={plan.id} />
                          <input type="hidden" name="lessonId" value={l.id} />
                          <input type="hidden" name="direction" value="down" />
                          <SubmitButton className="btn btn-sm" disabled={i === lessons.length - 1} aria-label={t("plan.moveDown", { title: l.title })}>
                            ↓
                          </SubmitButton>
                        </ActionForm>
                      </div>
                    ) : null}
                  </div>
                  <LessonBody t={t} l={l} />
                  {editable ? (
                    <details>
                      <summary style={{ cursor: "pointer", fontSize: 13 }}>{t("plan.editLesson")}</summary>
                      <div style={{ display: "grid", gap: 12, marginTop: 8 }}>
                        <ActionForm action={saveLessonAction}>
                          <input type="hidden" name="id" value={plan.id} />
                          <input type="hidden" name="lessonId" value={l.id} />
                          <LessonFields t={t} l={l} />
                          <div>
                            <SubmitButton className="btn btn-primary btn-sm">{t("common.save")}</SubmitButton>
                          </div>
                        </ActionForm>
                        <ActionForm action={deleteLessonAction}>
                          <input type="hidden" name="id" value={plan.id} />
                          <input type="hidden" name="lessonId" value={l.id} />
                          <div>
                            <SubmitButton className="btn btn-sm">{t("plan.deleteLesson")}</SubmitButton>
                          </div>
                        </ActionForm>
                      </div>
                    </details>
                  ) : null}
                </li>
              ))}
            </ol>
          )}
          {editable ? (
            <details open={lessons.length === 0}>
              <summary className="btn btn-sm" style={{ listStyle: "none", cursor: "pointer", display: "inline-flex" }}>
                {t("plan.addLesson")}
              </summary>
              <ActionForm action={saveLessonAction} style={{ marginTop: 10 }}>
                <input type="hidden" name="id" value={plan.id} />
                <LessonFields t={t} />
                <div>
                  <SubmitButton className="btn btn-primary">{t("plan.addLessonSubmit")}</SubmitButton>
                </div>
              </ActionForm>
            </details>
          ) : null}
        </Card>
        {!editable && mine ? (
          <p style={{ ...mutedText, margin: 0 }}>
            <StateChip t={t} state={plan.state} /> {t("plan.lockedNote")}
          </p>
        ) : null}
      </div>
    </div>
  );

  return (await getDeviceType()) === "mobile" ? (
    <MobileDetailFrame title={plan.name} backHref={approver ? "/approvals" : "/teaching/plans"}>
      {body}
    </MobileDetailFrame>
  ) : (
    body
  );
}
