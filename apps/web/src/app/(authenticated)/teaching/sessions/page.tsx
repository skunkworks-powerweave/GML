// /teaching/sessions -- a teacher's own classroom sessions, upcoming and past,
// and "Plan a session". Each opens on /teaching/sessions/[id], where she takes
// attendance and sends it for approval. Her sessions only (teacher_id = her).

import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { and, asc, desc, eq, gte, lt } from "drizzle-orm";
import { db } from "@gml/db";
import { classes, sessions, subjects } from "@gml/db/schema";
import { requireRole } from "@/lib/guards";
import { actorFrom } from "@/lib/visibility";
import { myTeacher } from "@/lib/teaching";
import { activeSubjects, lessonChoices, myLinks, todayInProgramme } from "@/lib/teaching/records";
import { SubmitButton } from "@/components/SubmitButton";
import { ActionForm } from "../_components/ActionForm";
import {
  Card,
  classLabel,
  dateFormatter,
  Empty,
  listRow,
  mutedText,
  NoTeacherRecord,
  PageHeader,
  StateChip,
  wrapRow,
  type Translate,
} from "../_components/ui";
import { SessionFields } from "./session-fields";
import { createSessionAction } from "./actions";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("teaching");
  return { title: t("sessions.title") };
}

const STATUS_CHIP: Record<string, string> = { planned: "", in_progress: "chip-saffron", complete: "chip-lichen", cancelled: "chip-rust" };

type Row = {
  id: string;
  date: string;
  time: string | null;
  topic: string | null;
  status: string;
  state: string;
  attended: number;
  total: number;
  grade: number | null;
  section: string | null;
  subject: string | null;
};

function SessionList({ t, rows, fmt, empty }: { t: Translate; rows: Row[]; fmt: (d: string) => string; empty: string }) {
  if (rows.length === 0) return <Empty>{empty}</Empty>;
  return (
    <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 8 }}>
      {rows.map((s) => (
        <li key={s.id} style={listRow}>
          <div style={{ minWidth: 0 }}>
            <Link href={`/teaching/sessions/${s.id}`} style={{ fontWeight: 600, color: "var(--ink)", overflowWrap: "anywhere" }}>
              {s.topic || t("sessions.untitled")}
            </Link>
            <div style={mutedText}>
              {[
                s.time ? t("sessions.when", { date: fmt(s.date), time: s.time.slice(0, 5) }) : fmt(s.date),
                s.grade != null ? classLabel(t, s.grade, s.section) : null,
                s.subject,
                s.total > 0 ? t("sessions.attendanceCount", { attended: s.attended, total: s.total }) : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </div>
          </div>
          <div style={wrapRow}>
            <span className={`chip ${STATUS_CHIP[s.status] ?? ""}`}>{t(`sessionStatus.${s.status}`)}</span>
            <StateChip t={t} state={s.state} />
          </div>
        </li>
      ))}
    </ul>
  );
}

export default async function MySessionsPage() {
  const session = await requireRole(["teacher"]);
  const actor = actorFrom(session)!;
  const teacher = await myTeacher(db, actor);
  if (!teacher) return <NoTeacherRecord />;
  const t = await getTranslations("teaching");
  const fmt = await dateFormatter();
  const today = todayInProgramme();

  const columns = {
    id: sessions.id,
    date: sessions.scheduledDate,
    time: sessions.scheduledTime,
    topic: sessions.topic,
    status: sessions.status,
    state: sessions.approvalStatus,
    attended: sessions.attendedCount,
    total: sessions.totalCount,
    grade: classes.grade,
    section: sessions.section,
    subject: subjects.name,
  };
  const base = () =>
    db
      .select(columns)
      .from(sessions)
      .leftJoin(classes, eq(classes.id, sessions.classId))
      .leftJoin(subjects, eq(subjects.id, sessions.subjectId));

  const links = await myLinks(db, teacher.id);
  const [upcoming, past, subjectRows, lessons] = await Promise.all([
    base()
      .where(and(eq(sessions.teacherId, teacher.id), gte(sessions.scheduledDate, today)))
      .orderBy(asc(sessions.scheduledDate), asc(sessions.scheduledTime))
      .limit(100),
    base()
      .where(and(eq(sessions.teacherId, teacher.id), lt(sessions.scheduledDate, today)))
      .orderBy(desc(sessions.scheduledDate), desc(sessions.scheduledTime))
      .limit(100),
    activeSubjects(db),
    lessonChoices(db, teacher.id, [...new Set(links.map((l) => l.grade))]),
  ]);

  return (
    <div>
      <PageHeader label={t("hub.label")} title={t("sessions.title")} intro={t("sessions.intro")} back={{ href: "/teaching", text: t("hub.title") }} />
      <div className="page-body" style={{ display: "grid", gap: 16 }}>
        <Card title={t("sessions.planTitle")} sub={t("sessions.planSub")}>
          {links.length === 0 ? (
            <div style={{ display: "grid", gap: 10 }}>
              <Empty>{t("sessions.noClasses")}</Empty>
              <div>
                <Link href="/teaching/classes" className="btn btn-sm">
                  {t("hub.links.classes")}
                </Link>
              </div>
            </div>
          ) : (
            <details open={upcoming.length + past.length === 0}>
              <summary className="btn btn-sm btn-primary" style={{ listStyle: "none", cursor: "pointer", display: "inline-flex" }}>
                {t("sessions.plan")}
              </summary>
              <ActionForm action={createSessionAction} style={{ marginTop: 10 }}>
                <SessionFields
                  t={t}
                  links={links}
                  subjects={subjectRows}
                  lessons={lessons}
                  d={{ date: today, linkId: links.length === 1 ? links[0]!.linkId : undefined, subjectId: links.length === 1 ? (links[0]!.subjectId ?? undefined) : undefined }}
                />
                <div>
                  <SubmitButton className="btn btn-primary">{t("sessions.create")}</SubmitButton>
                </div>
              </ActionForm>
            </details>
          )}
        </Card>
        <Card title={t("sessions.upcomingTitle", { count: upcoming.length })}>
          <SessionList t={t} rows={upcoming} fmt={(d) => fmt(d)} empty={t("sessions.upcomingEmpty")} />
        </Card>
        <Card title={t("sessions.pastTitle", { count: past.length })}>
          <SessionList t={t} rows={past} fmt={(d) => fmt(d)} empty={t("sessions.pastEmpty")} />
        </Card>
      </div>
    </div>
  );
}
