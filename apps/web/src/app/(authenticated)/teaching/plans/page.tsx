// /teaching/plans -- a teacher's own lesson plans, a form to start one from
// scratch, and the programme's curriculum (course outlines with no owner),
// read-only, each of which she can start her own plan from. Her plans only
// (owner_teacher_id = her); another teacher's plans never appear.

import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { and, asc, count, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@gml/db";
import { courseOutlines, outlineLessons, subjects } from "@gml/db/schema";
import { requireRole } from "@/lib/guards";
import { actorFrom } from "@/lib/visibility";
import { myClassLinks, myTeacher } from "@/lib/teaching";
import { activeSubjects } from "@/lib/teaching/records";
import { SubmitButton } from "@/components/SubmitButton";
import { ActionForm } from "../_components/ActionForm";
import { Card, Empty, Field, fieldGrid, listRow, mutedText, NoTeacherRecord, PageHeader, StateChip, wrapRow } from "../_components/ui";
import { copyOutlineAction, createPlanAction } from "./actions";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("teaching");
  return { title: t("plans.title") };
}

const GRADES = Array.from({ length: 12 }, (_, i) => i + 1);
const TERMS = [1, 2, 3, 4, 5, 6];

export default async function MyPlansPage() {
  const session = await requireRole(["teacher"]);
  const actor = actorFrom(session)!;
  const teacher = await myTeacher(db, actor);
  if (!teacher) return <NoTeacherRecord />;
  const t = await getTranslations("teaching");

  const lessonCount = db
    .select({ outlineId: outlineLessons.outlineId, c: count().as("c") })
    .from(outlineLessons)
    .groupBy(outlineLessons.outlineId)
    .as("lc");
  const outlineColumns = {
    id: courseOutlines.id,
    name: courseOutlines.name,
    grade: courseOutlines.grade,
    term: courseOutlines.term,
    subjectId: courseOutlines.subjectId,
    subject: subjects.name,
    state: courseOutlines.approvalStatus,
    lessons: lessonCount.c,
  };

  const links = await myClassLinks(db, teacher.id);
  const grades = [...new Set(links.map((l) => l.grade))];
  const [mine, programme, subjectRows] = await Promise.all([
    db
      .select(outlineColumns)
      .from(courseOutlines)
      .leftJoin(subjects, eq(subjects.id, courseOutlines.subjectId))
      .leftJoin(lessonCount, eq(lessonCount.outlineId, courseOutlines.id))
      .where(eq(courseOutlines.ownerTeacherId, teacher.id))
      .orderBy(asc(courseOutlines.grade), asc(subjects.name), asc(courseOutlines.term)),
    // The programme's outlines for the grades she teaches; all of them until
    // she has added a class.
    db
      .select(outlineColumns)
      .from(courseOutlines)
      .leftJoin(subjects, eq(subjects.id, courseOutlines.subjectId))
      .leftJoin(lessonCount, eq(lessonCount.outlineId, courseOutlines.id))
      .where(
        and(
          isNull(courseOutlines.ownerTeacherId),
          eq(courseOutlines.approvalStatus, "approved"),
          grades.length > 0 ? inArray(courseOutlines.grade, grades) : undefined,
        ),
      )
      .orderBy(asc(courseOutlines.grade), asc(subjects.name), asc(courseOutlines.term))
      .limit(200),
    activeSubjects(db),
  ]);
  const hers = new Map(mine.map((p) => [`${p.subjectId}:${p.grade}:${p.term}`, p.id]));

  return (
    <div>
      <PageHeader label={t("hub.label")} title={t("plans.title")} intro={t("plans.intro")} back={{ href: "/teaching", text: t("hub.title") }} />
      <div className="page-body" style={{ display: "grid", gap: 16 }}>
        <Card title={t("plans.mineTitle", { count: mine.length })}>
          {mine.length === 0 ? (
            <Empty>{t("plans.mineEmpty")}</Empty>
          ) : (
            <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 8 }}>
              {mine.map((p) => (
                <li key={p.id} style={listRow}>
                  <div style={{ minWidth: 0 }}>
                    <Link href={`/teaching/plans/${p.id}`} style={{ fontWeight: 600, color: "var(--ink)", overflowWrap: "anywhere" }}>
                      {p.name}
                    </Link>
                    <div style={mutedText}>
                      {t("plans.meta", { subject: p.subject ?? "", grade: p.grade, term: p.term, lessons: p.lessons ?? 0 })}
                    </div>
                  </div>
                  <StateChip t={t} state={p.state} />
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title={t("plans.createTitle")} sub={t("plans.createSub")}>
          <ActionForm action={createPlanAction}>
            <div style={fieldGrid}>
              <Field label={t("fields.subject")}>
                <select name="subjectId" className="text" required defaultValue="">
                  <option value="" disabled>
                    {t("common.choose")}
                  </option>
                  {subjectRows.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t("fields.grade")}>
                <select name="grade" className="text" required defaultValue={grades[0] ? String(grades[0]) : ""}>
                  <option value="" disabled>
                    {t("common.choose")}
                  </option>
                  {GRADES.map((g) => (
                    <option key={g} value={g}>
                      {t("common.gradeN", { grade: g })}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t("fields.term")}>
                <select name="term" className="text" required defaultValue="1">
                  {TERMS.map((n) => (
                    <option key={n} value={n}>
                      {t("common.termN", { term: n })}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t("fields.weeksOptional")}>
                <input name="weeks" className="text" type="number" min={1} max={52} />
              </Field>
            </div>
            <Field label={t("fields.planName")}>
              <input name="name" className="text" required maxLength={200} autoComplete="off" />
            </Field>
            <Field label={t("fields.outcomes")} hint={t("plans.outcomesHint")}>
              <textarea name="learningOutcomes" className="text" rows={3} maxLength={4000} />
            </Field>
            <div>
              <SubmitButton className="btn btn-primary">{t("plans.create")}</SubmitButton>
            </div>
          </ActionForm>
        </Card>

        <Card title={t("plans.programmeTitle")} sub={t("plans.programmeSub")}>
          {programme.length === 0 ? (
            <Empty>{t("plans.programmeEmpty")}</Empty>
          ) : (
            <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 8 }}>
              {programme.map((o) => {
                const existing = hers.get(`${o.subjectId}:${o.grade}:${o.term}`);
                return (
                  <li key={o.id} style={listRow}>
                    <div style={{ minWidth: 0 }}>
                      <Link href={`/teaching/plans/${o.id}`} style={{ fontWeight: 600, color: "var(--ink)", overflowWrap: "anywhere" }}>
                        {o.name}
                      </Link>
                      <div style={mutedText}>
                        {t("plans.meta", { subject: o.subject ?? "", grade: o.grade, term: o.term, lessons: o.lessons ?? 0 })}
                      </div>
                    </div>
                    <div style={wrapRow}>
                      {existing ? (
                        <Link href={`/teaching/plans/${existing}`} className="btn btn-sm">
                          {t("plans.openMine")}
                        </Link>
                      ) : (
                        <ActionForm action={copyOutlineAction}>
                          <input type="hidden" name="sourceId" value={o.id} />
                          <SubmitButton className="btn btn-sm">{t("plans.startFrom")}</SubmitButton>
                        </ActionForm>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
