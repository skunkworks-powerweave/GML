// /teaching/progress -- "Student progress": for each class a teacher teaches,
// how many students it has, the sessions held of those planned, the attendance
// rate and the average marks, and a row per student with the same figures and
// the last session. Students under the low-attendance threshold are marked.
//
// Hers only: her class links, her roster (lib/teaching), and the figures count
// her own sessions and tests (lib/teaching/progress.ts). It lists student
// names, so rendering it is audited (teaching.students.viewed, SM-9) as the
// other student lists are. Read-only; the numbers are edited where they are
// entered (sessions, marks, students).

import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { db } from "@gml/db";
import { requireRole } from "@/lib/guards";
import { recordAudit } from "@/lib/audit";
import { actorFrom } from "@/lib/visibility";
import { myClassLinks, myTeacher, type ClassLink } from "@/lib/teaching";
import { classProgress, parseOrder, sortStudents } from "@/lib/teaching/progress";
import { Card, classLabel, dateFormatter, Empty, NoTeacherRecord, PageHeader } from "../_components/ui";
import { FiguresGrid, RuleNote, SortLinks, StudentRows } from "../_components/progress";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("teaching");
  return { title: t("progress.title") };
}

export default async function StudentProgressPage({ searchParams }: { searchParams: Promise<{ sort?: string }> }) {
  const session = await requireRole(["teacher"]);
  const actor = actorFrom(session)!;
  const teacher = await myTeacher(db, actor);
  if (!teacher) return <NoTeacherRecord />;
  const t = await getTranslations("teaching");
  const fmtDate = await dateFormatter();
  const order = parseOrder((await searchParams).sort);

  // One class link at a time: a handful of links, each a handful of queries.
  const groups: Array<{ link: ClassLink } & Awaited<ReturnType<typeof classProgress>>> = [];
  for (const link of await myClassLinks(db, teacher.id)) {
    groups.push({ link, ...(await classProgress(db, { classId: link.classId, section: link.section, teacherId: teacher.id })) });
  }
  const rowCount = groups.reduce((n, g) => n + g.students.length, 0);
  void recordAudit({
    action: "teaching.students.viewed",
    entityType: "teacher",
    entityId: teacher.id,
    userId: actor.id,
    metadata: { page: "progress", rowCount },
  });

  return (
    <div>
      <PageHeader label={t("hub.label")} title={t("progress.title")} intro={t("progress.intro")} back={{ href: "/teaching", text: t("hub.title") }} />
      <div className="page-body" style={{ display: "grid", gap: 16 }}>
        <RuleNote t={t} />
        {groups.length === 0 ? (
          <section className="card card-hi" style={{ padding: 16, display: "grid", gap: 10 }}>
            <Empty>{t("progress.noClasses")}</Empty>
            <div>
              <Link href="/teaching/classes" className="btn btn-sm">
                {t("hub.links.classes")}
              </Link>
            </div>
          </section>
        ) : (
          <SortLinks t={t} basePath="/teaching/progress" current={order} />
        )}
        {groups.map(({ link, students, figures, lowCount }) => (
          <Card key={link.linkId} id={`class-${link.linkId}`} title={classLabel(t, link.grade, link.section)} sub={t("students.count", { count: figures.students })}>
            <FiguresGrid t={t} figures={figures} lowCount={students.length > 0 ? lowCount : undefined} />
            {students.length === 0 ? <Empty>{t("progress.noStudents")}</Empty> : <StudentRows t={t} students={sortStudents(students, order)} fmtDate={fmtDate} />}
          </Card>
        ))}
      </div>
    </div>
  );
}
