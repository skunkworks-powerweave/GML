// /teaching/sessions/[id] -- one classroom session: its details, its
// attendance, and its approval.
//
// Who sees what (decided here, on the server; the actions check again):
//   her own session       editable, attendance included, while draft, changes
//                         requested or rejected; locked while pending and once
//                         approved
//   another teacher's     404
//   programme admin /     read-only: they are the approvers, and the queue
//   super admin           (/approvals) links here
// Mentors and observers have no business here (requireRole).
//
// The attendance list names students (PII): rendering it is audited as every
// learner list is (teaching.students.viewed, SM-9).

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { asc, eq } from "drizzle-orm";
import { db } from "@gml/db";
import { classes, courseOutlines, learners, outlineLessons, sessionAttendance, sessions, subjects, teachers } from "@gml/db/schema";
import { requireRole } from "@/lib/guards";
import { recordAudit } from "@/lib/audit";
import { uuidOrNotFound } from "@/lib/ids";
import { actorFrom } from "@/lib/visibility";
import { getDeviceType } from "@/lib/device";
import { isEditable } from "@/lib/approvals";
import { myTeacher, roster } from "@/lib/teaching";
import { isApprover } from "@/lib/teaching/current";
import {
  activeSubjects,
  approvalHistory,
  ATTENDANCE_STATUSES,
  attendanceOf,
  lessonChoices,
  myLinks,
  sessionSubmitBlocker,
} from "@/lib/teaching/records";
import { SubmitButton } from "@/components/SubmitButton";
import { SessionVideosCard } from "@/components/video/SessionVideosCard";
import { videosOfSessions } from "@/lib/video/session-videos";
import { MobileDetailFrame } from "@/components/shells";
import { ActionForm } from "../../_components/ActionForm";
import { MarkChoice } from "../../_components/MarkChoice";
import {
  ApprovalPanel,
  ApproverBanner,
  Card,
  classLabel,
  dateFormatter,
  Empty,
  Field,
  listRow,
  mutedText,
  PageHeader,
  wrapRow,
} from "../../_components/ui";
import { SessionFields } from "../session-fields";
import { saveAttendanceAction, submitSessionAction, updateSessionAction } from "../actions";
import { uploadAttendanceCsvAction } from "../attendance-csv";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("teaching");
  return { title: t("session.metaTitle") };
}

const ATTENDANCE_CHIP: Record<string, string> = { present: "chip-lichen", late: "chip-saffron", absent: "chip-rust", excused: "" };

export default async function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const id = uuidOrNotFound((await params).id);
  const session = await requireRole(["teacher", "programme_admin", "super_admin"]);
  const actor = actorFrom(session)!;
  const approver = isApprover(actor);
  const teacher = approver ? null : await myTeacher(db, actor);
  const t = await getTranslations("teaching");
  const fmt = await dateFormatter();

  const [s] = await db
    .select({
      id: sessions.id,
      teacherId: sessions.teacherId,
      teacherName: teachers.fullName,
      classId: sessions.classId,
      grade: classes.grade,
      section: sessions.section,
      subjectId: sessions.subjectId,
      subject: subjects.name,
      lessonId: sessions.outlineLessonId,
      lessonTitle: outlineLessons.title,
      lessonSeq: outlineLessons.sequence,
      outlineName: courseOutlines.name,
      date: sessions.scheduledDate,
      time: sessions.scheduledTime,
      durationMin: sessions.durationMin,
      topic: sessions.topic,
      notes: sessions.notes,
      status: sessions.status,
      state: sessions.approvalStatus,
      attended: sessions.attendedCount,
      total: sessions.totalCount,
    })
    .from(sessions)
    .leftJoin(teachers, eq(teachers.id, sessions.teacherId))
    .leftJoin(classes, eq(classes.id, sessions.classId))
    .leftJoin(subjects, eq(subjects.id, sessions.subjectId))
    .leftJoin(outlineLessons, eq(outlineLessons.id, sessions.outlineLessonId))
    .leftJoin(courseOutlines, eq(courseOutlines.id, outlineLessons.outlineId))
    .where(eq(sessions.id, id))
    .limit(1);
  if (!s) notFound();
  const mine = !!teacher && s.teacherId === teacher.id;
  // A teacher sees her own sessions only; another teacher's answers 404.
  if (!approver && !mine) notFound();
  const editable = mine && isEditable(s.state);
  const takesAttendance = editable && s.status !== "cancelled";

  const [history, marks, students, links, subjectRows] = await Promise.all([
    approvalHistory(db, "session", s.id),
    attendanceOf(db, s.id),
    takesAttendance
      ? roster(db, s.classId, s.section)
      : // Locked or read-only: what was recorded, including students removed since.
        db
          .select({ id: learners.id, name: learners.name, rollNumber: learners.rollNumber, section: learners.section })
          .from(sessionAttendance)
          .innerJoin(learners, eq(learners.id, sessionAttendance.learnerId))
          .where(eq(sessionAttendance.sessionId, s.id))
          .orderBy(asc(learners.rollNumber), asc(learners.name)),
    editable && teacher ? myLinks(db, teacher.id) : Promise.resolve([]),
    editable ? activeSubjects(db) : Promise.resolve([]),
  ]);
  const lessons = editable && teacher ? await lessonChoices(db, teacher.id, [...new Set(links.map((l) => l.grade))]) : [];
  const blocker = editable ? await sessionSubmitBlocker(db, s) : null;
  // Her own session, or an administrator: the two who may see and add its videos.
  const videos = await videosOfSessions([s.id]);

  if (students.length > 0) {
    void recordAudit({
      action: "teaching.students.viewed",
      entityType: "session",
      entityId: s.id,
      userId: actor.id,
      metadata: { page: "session", rowCount: students.length },
    });
  }

  const markOptions = ATTENDANCE_STATUSES.map((a) => ({ value: a, label: t(`attendance.${a}`) }));
  const cls = s.grade != null ? classLabel(t, s.grade, s.section) : "";
  const when = s.time ? t("sessions.when", { date: fmt(s.date), time: s.time.slice(0, 5) }) : fmt(s.date);
  // The edit form names her class link: the one for this class and section, else the whole-grade one.
  const linkId =
    links.find((l) => l.classId === s.classId && l.section === s.section)?.linkId ??
    links.find((l) => l.classId === s.classId && l.section === null)?.linkId;

  const facts: Array<[string, string | null]> = [
    [t("fields.date"), when],
    [t("fields.class"), cls],
    [t("fields.subject"), s.subject],
    [t("fields.lesson"), s.lessonTitle ? t("session.lessonFact", { outline: s.outlineName ?? "", n: s.lessonSeq ?? 0, title: s.lessonTitle }) : null],
    [t("fields.duration"), s.durationMin ? t("session.minutes", { minutes: s.durationMin }) : null],
    [t("fields.status"), t(`sessionStatus.${s.status}`)],
    [t("fields.notes"), s.notes],
  ];

  const body = (
    <div>
      <PageHeader
        label={t("session.label")}
        title={s.topic || t("sessions.untitled")}
        intro={[when, cls, s.subject].filter(Boolean).join(" · ")}
        back={approver ? { href: "/approvals", text: t("approval.queue") } : { href: "/teaching/sessions", text: t("sessions.title") }}
      />
      <div className="page-body" style={{ display: "grid", gap: 16 }}>
        {approver ? <ApproverBanner t={t} teacher={s.teacherName ?? ""} /> : null}
        <ApprovalPanel
          t={t}
          state={s.state}
          history={history}
          itemId={s.id}
          readOnly={approver}
          submit={mine ? submitSessionAction : undefined}
          blocker={blocker ? t(`errors.${blocker}`) : null}
        />

        {editable ? (
          <Card title={t("session.detailsTitle")}>
            <ActionForm action={updateSessionAction}>
              <input type="hidden" name="id" value={s.id} />
              <SessionFields
                t={t}
                links={links}
                subjects={subjectRows}
                lessons={lessons}
                d={{
                  linkId,
                  section: s.section,
                  subjectId: s.subjectId,
                  lessonId: s.lessonId,
                  date: s.date,
                  time: s.time,
                  durationMin: s.durationMin,
                  topic: s.topic,
                  notes: s.notes,
                  status: s.status,
                }}
              />
              <div>
                <SubmitButton className="btn btn-primary">{t("common.save")}</SubmitButton>
              </div>
            </ActionForm>
          </Card>
        ) : (
          <Card title={t("session.detailsTitle")}>
            <dl style={{ margin: 0, display: "grid", gap: 8 }}>
              {facts
                .filter(([, v]) => v)
                .map(([k, v]) => (
                  <div key={k} style={{ display: "grid", gap: 2 }}>
                    <dt className="label">{k}</dt>
                    <dd style={{ margin: 0, fontSize: 13, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{v}</dd>
                  </div>
                ))}
            </dl>
          </Card>
        )}

        <Card
          title={t("session.attendanceTitle")}
          sub={s.total > 0 ? t("sessions.attendanceCount", { attended: s.attended, total: s.total }) : t("session.attendanceNotTaken")}
        >
          {s.status === "cancelled" ? <Empty>{t("session.cancelledNote")}</Empty> : null}
          {students.length === 0 && s.status !== "cancelled" ? (
            <Empty>{takesAttendance ? t("session.noStudents") : t("session.noAttendance")}</Empty>
          ) : null}
          {/* The same marks in bulk: her roster to fill in, and the file back. Above the list, which for a
              whole class is far longer than a phone's screen. */}
          {takesAttendance && students.length > 0 ? (
            <section style={{ display: "grid", gap: 8, paddingBottom: 12, borderBottom: "1px solid var(--line)" }}>
              <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>{t("session.csvTitle")}</h3>
              <p style={{ ...mutedText, margin: 0 }}>{t("session.csvIntro")}</p>
              <div style={wrapRow}>
                <a className="btn btn-sm" href={`/api/teaching/sessions/${s.id}/roster`} download>
                  {t("session.downloadRoster")}
                </a>
              </div>
              <ActionForm action={uploadAttendanceCsvAction}>
                <input type="hidden" name="id" value={s.id} />
                <Field label={t("session.uploadCsv")}>
                  <input type="file" name="file" accept=".csv,text/csv" required />
                </Field>
                <div>
                  <SubmitButton className="btn btn-sm">{t("session.uploadCsvSubmit")}</SubmitButton>
                </div>
              </ActionForm>
            </section>
          ) : null}
          {takesAttendance && students.length > 0 ? (
            <ActionForm action={saveAttendanceAction}>
              <input type="hidden" name="id" value={s.id} />
              <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 8 }}>
                {students.map((st) => {
                  // Only a mark that was recorded is selected: an unmarked student is not "present" until she says so.
                  const current = marks.get(st.id);
                  return (
                    <li key={st.id} style={listRow}>
                      {/* Keyed by the recorded mark: the radios keep what she has picked, so a CSV that changes this
                          student's mark must start her fieldset afresh, or the page would show her click and not
                          the file. Students whose mark did not change keep what she has picked. */}
                      <fieldset
                        key={`${st.id}:${current ?? ""}`}
                        style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 6, minWidth: 0, width: "100%" }}
                      >
                        <legend style={{ fontWeight: 600, padding: 0, overflowWrap: "anywhere" }}>
                          {st.rollNumber ? t("session.studentWithRoll", { name: st.name, roll: st.rollNumber }) : st.name}
                        </legend>
                        <div style={wrapRow}>
                          <MarkChoice name={`status_${st.id}`} current={current ?? null} options={markOptions} />
                        </div>
                      </fieldset>
                    </li>
                  );
                })}
              </ul>
              <div style={wrapRow}>
                <SubmitButton className="btn btn-primary" name="intent" value="save">
                  {t("session.saveAttendance")}
                </SubmitButton>
                {/* formNoValidate: the shortcut must not wait for every group to be marked. */}
                <SubmitButton className="btn" name="intent" value="all_present" formNoValidate>
                  {t("session.allPresent")}
                </SubmitButton>
              </div>
              <p style={{ ...mutedText, margin: 0 }}>{t("session.attendanceHint")}</p>
            </ActionForm>
          ) : null}
          {!takesAttendance && students.length > 0 ? (
            <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 6 }}>
              {students.map((st) => {
                const a = marks.get(st.id);
                return (
                  <li key={st.id} style={listRow}>
                    <span style={{ overflowWrap: "anywhere" }}>
                      {st.rollNumber ? t("session.studentWithRoll", { name: st.name, roll: st.rollNumber }) : st.name}
                    </span>
                    {a ? <span className={`chip ${ATTENDANCE_CHIP[a] ?? ""}`}>{t(`attendance.${a}`)}</span> : null}
                  </li>
                );
              })}
            </ul>
          ) : null}
        </Card>

        <SessionVideosCard videos={videos} upload={{ kind: "session", sessionId: s.id }} />
      </div>
    </div>
  );

  return (await getDeviceType()) === "mobile" ? (
    <MobileDetailFrame title={s.topic || t("sessions.untitled")} backHref={approver ? "/approvals" : "/teaching/sessions"}>
      {body}
    </MobileDetailFrame>
  ) : (
    body
  );
}
