// /progress/students/[classId] -- one class's progress for programme admins and
// super admins: its figures and a row per active student, over every teacher's
// sessions and tests (lib/teaching/progress.ts).
//
// It names learners, so rendering it is audited as the other class learner
// list is (learners.view on the class, SM-9, /repo/class/[id]/learners).
// Teachers, mentors and observers are turned away: a teacher's own class has
// /teaching/progress, which counts only her own sessions and tests.

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { eq } from "drizzle-orm";
import { db } from "@gml/db";
import { classes, schools } from "@gml/db/schema";
import { requireRole } from "@/lib/guards";
import { recordAudit } from "@/lib/audit";
import { uuidOrNotFound } from "@/lib/ids";
import { actorFrom } from "@/lib/visibility";
import { classProgress, parseOrder, sortStudents } from "@/lib/teaching/progress";
import { dateFormatter, Empty, mutedText, PageHeader } from "../../../teaching/_components/ui";
import { FiguresGrid, RuleNote, SortLinks, StudentRows } from "../../../teaching/_components/progress";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("teaching");
  return { title: t("progress.title") };
}

export default async function ClassProgressPage({
  params,
  searchParams,
}: {
  params: Promise<{ classId: string }>;
  searchParams: Promise<{ sort?: string }>;
}) {
  // Roles first: someone who may not read this learns nothing about which ids exist.
  const session = await requireRole(["programme_admin", "super_admin"]);
  const actor = actorFrom(session)!;
  const classId = uuidOrNotFound((await params).classId);
  const [cls] = await db
    .select({ grade: classes.grade, schoolId: classes.schoolId, schoolName: schools.name })
    .from(classes)
    .innerJoin(schools, eq(schools.id, classes.schoolId))
    .where(eq(classes.id, classId))
    .limit(1);
  if (!cls) notFound();

  void recordAudit({
    action: "learners.view",
    entityType: "class",
    entityId: classId,
    userId: actor.id,
    metadata: { route: "/progress/students/[classId]", schoolId: cls.schoolId, grade: cls.grade },
  });

  const t = await getTranslations("teaching");
  const fmtDate = await dateFormatter();
  const order = parseOrder((await searchParams).sort);
  const { students, figures, lowCount } = await classProgress(db, { classId });

  return (
    <div>
      <PageHeader
        label={t("progress.admin.label")}
        title={t("progress.admin.classTitle", { school: cls.schoolName, grade: cls.grade })}
        intro={t("progress.admin.classIntro", { school: cls.schoolName })}
        back={{ href: `/progress/students?school=${cls.schoolId}`, text: t("progress.admin.back") }}
      />
      <div className="page-body" style={{ display: "grid", gap: 16 }}>
        <RuleNote t={t} />
        <FiguresGrid t={t} figures={figures} lowCount={students.length > 0 ? lowCount : undefined} />
        {students.length === 0 ? (
          <Empty>{t("progress.noStudents")}</Empty>
        ) : (
          <>
            <SortLinks t={t} basePath={`/progress/students/${classId}`} current={order} />
            <StudentRows t={t} students={sortStudents(students, order)} fmtDate={fmtDate} />
          </>
        )}
        <p style={{ ...mutedText, margin: 0 }}>{t("progress.admin.piiNote")}</p>
      </div>
    </div>
  );
}
