// /rtt/subject/[id] — RTT subject drill-in: modules + sessions + readings.

import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { and, desc, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import { getLocale, getTranslations } from "next-intl/server";
import { db } from "@gml/db";
import { auth } from "@/auth";
import { INTL_LOCALE, type Locale } from "@/i18n/config";
import {
  rttSubjects,
  rttModules,
  rttLessons,
  rttSessions,
  rttReadings,
  terms,
  phases,
  districts,
  zones,
  videoSubmissions,
} from "@gml/db/schema";
import { uploadHref } from "@/app/(authenticated)/uploads/context";
import { uuidOrNotFound } from "@/lib/ids";
import { listSubjectAssessments } from "@/lib/rtt/assessments";
import { attendanceOf, doneItems, resumeModule } from "@/lib/rtt/progress";
import { rttScope } from "@/lib/rtt/scope";
import { webLink } from "@/lib/rtt/links";
import { launchLabel, statusChip, statusLabel } from "@/lib/scorm/format";
import { subjectPackages } from "@/lib/scorm/store";
import { getDeviceType } from "@/lib/device";
import { markProgressAction } from "./actions";

type Translate = Awaited<ReturnType<typeof getTranslations>>;

/** A one-button form that marks a lesson or reading done, or undoes it. */
function ProgressToggle({ kind, itemId, isDone, t }: { kind: "lesson" | "reading"; itemId: string; isDone: boolean; t: Translate }) {
  return (
    <form action={markProgressAction} style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="itemId" value={itemId} />
      <input type="hidden" name="done" value={isDone ? "false" : "true"} />
      {isDone ? <span className="chip chip-lichen">{t("subject.done")}</span> : null}
      <button type="submit" className={isDone ? "btn btn-sm btn-ghost" : "btn btn-sm"}>
        {isDone ? t("subject.undo") : kind === "lesson" ? t("subject.markDone") : t("subject.markRead")}
      </button>
    </form>
  );
}

const ATTENDANCE_CHIP: Record<string, string> = {
  present: "chip chip-lichen",
  absent: "chip chip-rust",
  excused: "chip",
};

/** video_status values with a label under rtt.videoStatus. */
const VIDEO_STATUSES = new Set(["received", "queued", "transcoding", "ready", "failed", "review_pending", "reviewed"]);

/** A teach-back's state for the teacher who sent it: review first, then the pipeline. */
function teachBackChip(v: { status: string; reviewedAt: Date | null }, t: Translate): { cls: string; label: string } {
  if (v.reviewedAt) return { cls: "chip chip-lichen", label: t("subject.teachBackReviewed") };
  if (v.status === "ready") return { cls: "chip chip-saffron", label: t("subject.teachBackAwaiting") };
  if (v.status === "failed") return { cls: "chip chip-rust", label: t("subject.teachBackFailed") };
  return { cls: "chip", label: VIDEO_STATUSES.has(v.status) ? t(`videoStatus.${v.status}`) : v.status.replace(/_/g, " ") };
}

/** rtt_sessions.type values with a label under rtt.sessionType. */
const SESSION_TYPES = new Set(["synchronous", "asynchronous", "webinar", "quiz"]);

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("rtt");
  return { title: t("subject.metaTitle") };
}

export default async function RttSubjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ open?: string }>;
}) {
  // A malformed id is a subject that does not exist, not a Postgres 500.
  const id = uuidOrNotFound((await params).id);
  // ?open=<module sequence>: the module a progress tick came from stays open
  // after the form round-trip (actions.ts redirects here with it).
  const openSeq = Number((await searchParams).open);
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const viewer = { id: session.user.id, role: session.user.role };
  const t = await getTranslations("rtt");
  const intl = INTL_LOCALE[(await getLocale()) as Locale];
  // Only a subject the viewer is shown (lib/rtt/scope.ts): a retired subject
  // stayed reachable here for everyone, because this page never read `active`.
  const scope = await rttScope(db, viewer);
  const [subject] = await db
    .select()
    .from(rttSubjects)
    .where(and(eq(rttSubjects.id, id), scope.subjectWhere))
    .limit(1);
  if (!subject) notFound();
  const [term] = await db.select().from(terms).where(eq(terms.id, subject.termId)).limit(1);
  const [phase] = term ? await db.select().from(phases).where(eq(phases.id, term.phaseId)).limit(1) : [null];
  // Where it is taught, when that is not the whole programme (F42).
  const [taughtIn] = subject.zoneId
    ? await db
        .select({ name: sql<string>`${zones.name} || ', ' || ${districts.name}` })
        .from(zones)
        .innerJoin(districts, eq(districts.id, zones.districtId))
        .where(eq(zones.id, subject.zoneId))
        .limit(1)
    : subject.districtId
      ? await db.select({ name: districts.name }).from(districts).where(eq(districts.id, subject.districtId)).limit(1)
      : [null];

  const modules = await db.select().from(rttModules).where(eq(rttModules.rttSubjectId, id)).orderBy(rttModules.sequence);
  // LESSONS. rtt_lessons existed in the schema and nothing read or wrote it,
  // while the card below told teachers to "click a module to expand its
  // lessons" over static rows. They are now authored at /admin/data/rtt-lessons
  // and listed under their module in a native <details> disclosure, so the
  // expansion works with no client JavaScript.
  const lessons = modules.length
    ? await db
        .select({
          id: rttLessons.id,
          rttModuleId: rttLessons.rttModuleId,
          title: rttLessons.title,
          bodyMd: rttLessons.bodyMd,
        })
        .from(rttLessons)
        .where(
          inArray(
            rttLessons.rttModuleId,
            modules.map((m) => m.id),
          ),
        )
        .orderBy(rttLessons.rttModuleId, rttLessons.sequence)
    : [];
  const lessonsByModule = new Map<string, typeof lessons>();
  for (const l of lessons) {
    const list = lessonsByModule.get(l.rttModuleId) ?? [];
    list.push(l);
    lessonsByModule.set(l.rttModuleId, list);
  }
  // isUpcoming is computed by Postgres, not the app process. Doing it in SQL
  // uses the same clock the scheduled_at timestamps were written against (no
  // app/DB skew), gives every row one consistent "now", and keeps an impure
  // clock read out of the render path entirely.
  const sessions = await db
    .select({
      ...getTableColumns(rttSessions),
      isUpcoming: sql<boolean>`(${rttSessions.scheduledAt} IS NULL OR ${rttSessions.scheduledAt} > now())`,
    })
    .from(rttSessions)
    .where(eq(rttSessions.rttSubjectId, id))
    .orderBy(rttSessions.sequence);
  const readings = await db.select().from(rttReadings).where(eq(rttReadings.rttSubjectId, id)).orderBy(rttReadings.sequence);

  // Where an empty card points an administrator. Modules, lessons and readings
  // had no write path anywhere in the product; they are admin grid tables now,
  // and an empty card that says where to fill it reads as "not loaded yet"
  // rather than "broken".
  const viewerIsAdmin = scope.isAdmin;

  // THIS SUBJECT'S ASSESSMENTS: the active quizzes bound to it. They were
  // looked up by the fixed slugs "mid-unit" and "endline" with no subject
  // predicate, so one programme-wide "mid-unit" quiz ran on every subject and
  // a quiz under any other slug was offered nowhere (lib/rtt/assessments.ts).
  const assessments = await listSubjectAssessments(db, id, session.user.id);

  // THIS SUBJECT'S SCORM MODULES (F41), with the learner's own record of
  // each. The same predicate as the launch page and the content route
  // (lib/scorm/store.ts), so nothing listed here 404s when opened.
  const scorm = await subjectPackages(db, viewer, id);

  // THE LEARNER'S OWN PROGRESS (F36): the lessons and readings she has marked
  // done (rtt_progress, written by ./actions.ts) and the attendance taken of
  // her at this subject's sessions. None of it was recorded or shown before.
  const [done, attendance] = await Promise.all([
    doneItems(
      db,
      session.user.id,
      lessons.map((l) => l.id),
      readings.map((r) => r.id),
    ),
    attendanceOf(
      db,
      session.user.id,
      sessions.map((s) => s.id),
    ),
  ]);
  const presentCount = [...attendance.values()].filter((s) => s === "present").length;
  const passedCount = assessments.filter((q) => q.passed).length;

  // HER TEACH-BACKS OF THIS SUBJECT (FR-02). The review side -- the
  // /rtt/teach-back queue, the mentor's "Pending video reviews" card and the
  // badge -- was built, and nothing a teacher could reach sent one: no page
  // linked a teach-back upload, and its id had no meaning. A teach-back is now
  // for a subject (uploads/context.ts), offered here to the teacher learning
  // it. Staff review teach-backs; they are not asked for one.
  const teachBacks = scope.isStaff
    ? []
    : await db
        .select({
          id: videoSubmissions.id,
          status: videoSubmissions.status,
          createdAt: videoSubmissions.createdAt,
          reviewedAt: videoSubmissions.reviewedAt,
        })
        .from(videoSubmissions)
        .where(
          and(
            eq(videoSubmissions.contextType, "teach_back"),
            eq(videoSubmissions.contextId, id),
            eq(videoSubmissions.submittedByUserId, session.user.id),
          ),
        )
        .orderBy(desc(videoSubmissions.createdAt))
        .limit(10);

  // "Resume" (spec 119's in-page anchor) goes to the first module with a
  // lesson she has not done. It always went to module 1, whatever she had
  // done. No modules: the modules card, so the button is never dead.
  const resume = resumeModule(modules, lessonsByModule, done.lessons);
  const resumeHref = resume
    ? `/rtt/subject/${id}#module-${resume.sequence}`
    : `/rtt/subject/${id}#modules`;

  // The readings and assessment cards, placed per device below.
  const readingsCard = (
    <article id="readings" className="card card-hi">
      <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--line)" }}>
        <div style={{ fontWeight: 600, fontSize: 13 }}>{t("subject.readings", { count: readings.length })}</div>
      </div>
      {readings.length === 0 ? (
        <div style={{ padding: 24, fontSize: 13, color: "var(--ink-3)", textAlign: "center" }}>
          {t("subject.noReadings")}
          {viewerIsAdmin ? (
            <div style={{ fontSize: 12, marginTop: 6 }}>
              {t.rich("subject.addReadings", { link: (chunks) => <Link href="/admin/data/rtt-readings">{chunks}</Link> })}
            </div>
          ) : null}
        </div>
      ) : (
        <div>
          {readings.map((r, i) => (
            <div
              key={r.id}
              style={{
                display: "grid",
                // As the module rows: the title column cannot be pushed
                // wider than the card by a long title.
                gridTemplateColumns: "30px minmax(0, 1fr) minmax(0, auto)",
                gap: 10,
                padding: 12,
                alignItems: "center",
                borderTop: i ? "1px solid var(--line)" : "none",
              }}
            >
              <span
                aria-hidden
                style={{
                  fontFamily: "var(--mono)",
                  fontSize: 10,
                  fontWeight: 600,
                  color: "var(--rust)",
                  border: "1px solid var(--line)",
                  borderRadius: 4,
                  padding: "2px 4px",
                  textAlign: "center",
                }}
              >
                PDF
              </span>
              <div style={{ overflowWrap: "anywhere" }}>
                <div style={{ fontWeight: 500, fontSize: 13 }}>
                  {r.externalUrl ? (
                    <a
                      href={r.externalUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ color: "var(--ink)" }}
                    >
                      {r.title}
                    </a>
                  ) : (
                    r.title
                  )}
                </div>
                <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>
                  {r.externalUrl ? t("common.externalLink") : t("subject.reading")}
                </div>
                <div style={{ marginTop: 6 }}>
                  <ProgressToggle kind="reading" itemId={r.id} isDone={done.readings.has(r.id)} t={t} />
                </div>
              </div>
              {r.externalUrl ? (
                <a
                  href={r.externalUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn btn-sm"
                >
                  {t("subject.open")}
                </a>
              ) : (
                // NO "View" BUTTON for a fileKey-only reading. It sent an
                // rtt_readings id to /repo/resource/[id]/view, which looks
                // the id up in `resources` -- a different table -- so it
                // 404'd by construction. The branch could not be reached
                // honestly anyway: file_key is a MinIO object key and
                // MinIO is out of the stack, so nothing can set or serve
                // it. Readings are authored at /admin/data/rtt-readings
                // as external links, which render "Open" above.
                <span className="chip">—</span>
              )}
            </div>
          ))}
        </div>
      )}
    </article>
  );

  // Assessment card: one row per active quiz bound to this subject,
  // with the learner's own best result. Release is the quiz's
  // `active` flag at /admin/quizzes; there is no sequencing rule (an
  // endline locked until a mid-unit is passed) because nothing in the
  // programme defines one, so none is pretended here.
  const assessmentCard = (
    <article className="card card-hi">
      <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--line)" }}>
        <div style={{ fontWeight: 600, fontSize: 13 }}>{t("subject.assessment")}</div>
      </div>
      {assessments.length === 0 ? (
        <div style={{ padding: 24, fontSize: 13, color: "var(--ink-3)", textAlign: "center" }}>
          {t("subject.noAssessments")}
          {viewerIsAdmin ? (
            <div style={{ fontSize: 12, marginTop: 6 }}>
              {t.rich("subject.addAssessment", { link: (chunks) => <Link href="/admin/quizzes">{chunks}</Link> })}
            </div>
          ) : null}
        </div>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: "0 14px", fontSize: 13 }}>
          {assessments.map((q, i) => (
            <li
              key={q.id}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 10,
                padding: "12px 0",
                borderTop: i ? "1px solid var(--line)" : "none",
              }}
            >
              <div>
                <div>{q.title}</div>
                <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>
                  {q.attempts === 0
                    ? t("subject.passMark", {
                        threshold: q.passThreshold,
                        capped: q.maxAttempts !== null ? "yes" : "no",
                        max: q.maxAttempts ?? 0,
                      })
                    : t("subject.best", {
                        best: q.bestScore ?? 0,
                        attempts: q.attempts,
                        capped: q.maxAttempts !== null ? "yes" : "no",
                        max: q.maxAttempts ?? 0,
                      })}
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                {q.passed ? <span className="chip chip-lichen">{t("common.passed")}</span> : null}
                <Link
                  href={q.href}
                  className={q.attempts === 0 ? "btn btn-sm btn-primary" : "btn btn-sm"}
                  style={{ textDecoration: "none" }}
                >
                  {q.spent ? t("subject.results") : q.attempts === 0 ? t("common.start") : t("common.retake")}
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}
    </article>
  );

  // A phone reads the page as one column, in DOM order; see the section.
  const phone = (await getDeviceType()) === "mobile";

  return (
    <div>
      <header style={{ marginBottom: 22 }}>
        <Link href="/rtt" className="btn btn-sm btn-ghost" style={{ marginBottom: 6 }}>
          {t("subject.allSubjects")}
        </Link>
        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "space-between",
            gap: 14,
          }}
        >
          <div>
            <div className="label" style={{ marginTop: 8 }}>
              {phase?.label ?? t("subject.unknownPhase")} · {term?.name ?? t("subject.unknownTerm")}
              {subject.code ? ` · ${subject.code}` : ""}
              {taughtIn ? ` · ${t("subject.onlyIn", { place: taughtIn.name })}` : ""}
            </div>
            {!subject.active ? (
              // Only an administrator reaches an inactive subject.
              <span className="chip chip-rust" title={t("subject.inactiveTitle")}>
                {t("common.inactive")}
              </span>
            ) : null}
            <h1 style={{ fontFamily: "var(--serif)", fontSize: 28, marginTop: 4 }}>
              {subject.name}
            </h1>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Link
              href={resumeHref}
              className="btn btn-primary"
              style={{ textDecoration: "none" }}
            >
              {t("subject.resume")}
            </Link>
          </div>
        </div>
      </header>

      {/* PHONE WIDTH (F11). This was an inline gridTemplateColumns "1.5fr 1fr",
          which holds at every width: on a 360 px phone the left column grew to
          the sessions table's width and Required readings and the Assessment
          card -- the quiz's Start button -- sat off the right edge of the
          screen. Below 768 px the columns now stack in DOM order -- on a phone
          modules, readings, the assessment, sessions, then progress; in a
          narrow desktop window the desktop's order -- and from 768 px they are
          the same 1.5fr / 1fr, as minmax(0, ...) so wide content scrolls in
          its card instead of widening the page. The phone arrangement is one
          column at every width: the device cookie says "mobile" up to and
          including 768 px (lib/use-device.ts), where md: already applies. */}
      <section
        className={
          phone
            ? "grid grid-cols-1 gap-[18px]"
            : "grid grid-cols-1 gap-[18px] md:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]"
        }
      >
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 14 }}>
          <article id="modules" className="card card-hi">
            <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--line)" }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>{t("subject.modules", { count: modules.length })}</div>
              <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>
                {/* Only promise the expansion when there is something to
                    expand; this used to say it over rows that could not. */}
                {lessons.length > 0 ? t("subject.modulesExpand") : t("subject.modulesOrder")}
              </div>
            </div>
            {modules.length === 0 ? (
              <div style={{ padding: 24, fontSize: 13, color: "var(--ink-3)", textAlign: "center" }}>
                {t("subject.noModules")}
                {viewerIsAdmin ? (
                  <div style={{ fontSize: 12, marginTop: 6 }}>
                    {t.rich("subject.addModules", {
                      modules: (chunks) => <Link href="/admin/data/rtt-modules">{chunks}</Link>,
                      lessons: (chunks) => <Link href="/admin/data/rtt-lessons">{chunks}</Link>,
                    })}
                  </div>
                ) : null}
              </div>
            ) : (
              <div>
                {modules.map((m, i) => {
                  const moduleLessons = lessonsByModule.get(m.id) ?? [];
                  const moduleDone = moduleLessons.filter((l) => done.lessons.has(l.id)).length;
                  // minmax(0, ...): a bare 1fr is at least as wide as its
                  // content, so one long word in a title or description (a
                  // URL) pushed the row past a phone's edge; the lesson chip's
                  // column is still its content's width whenever there is room.
                  const header = (
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "36px minmax(0, 1fr) minmax(0, auto)",
                        gap: 14,
                        padding: 14,
                        alignItems: "center",
                      }}
                    >
                      <div
                        style={{
                          width: 30,
                          height: 30,
                          borderRadius: 6,
                          background: "var(--paper-2)",
                          color: "var(--ink-2)",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontFamily: "var(--mono)",
                          fontSize: 12,
                          fontWeight: 600,
                        }}
                      >
                        {i + 1}
                      </div>
                      <div style={{ overflowWrap: "anywhere" }}>
                        <div style={{ fontWeight: 500, fontSize: 13 }}>{m.title}</div>
                        {m.description ? (
                          <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>
                            {m.description}
                          </div>
                        ) : null}
                      </div>
                      {moduleLessons.length > 0 ? (
                        <span
                          className={moduleDone === moduleLessons.length ? "chip chip-lichen" : "chip"}
                          title={t("subject.lessonsMarkedTitle")}
                        >
                          {t("subject.lessonCount", { done: moduleDone, total: moduleLessons.length })}
                        </span>
                      ) : (
                        <span />
                      )}
                    </div>
                  );
                  const rowStyle = { borderTop: i ? "1px solid var(--line)" : "none" };
                  // A module with no lessons stays a plain row: a disclosure
                  // that opens onto nothing is the same false promise the old
                  // subtitle made.
                  if (moduleLessons.length === 0) {
                    return (
                      <div key={m.id} id={`module-${m.sequence}`} style={rowStyle}>
                        {header}
                      </div>
                    );
                  }
                  return (
                    <details
                      key={m.id}
                      id={`module-${m.sequence}`}
                      style={rowStyle}
                      // Where she is (the Resume module), or where she just
                      // ticked a lesson, opens without a tap.
                      open={m.id === resume?.id || m.sequence === openSeq}
                    >
                      <summary style={{ cursor: "pointer", listStyle: "none" }}>{header}</summary>
                      <ol style={{ margin: 0, padding: "0 14px 14px 64px", display: "grid", gap: 10 }}>
                        {moduleLessons.map((l) => (
                          <li key={l.id} style={{ fontSize: 13 }}>
                            <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
                              <div style={{ fontWeight: 500 }}>{l.title}</div>
                              <ProgressToggle kind="lesson" itemId={l.id} isDone={done.lessons.has(l.id)} t={t} />
                            </div>
                            {l.bodyMd ? (
                              // Plain text with the author's line breaks kept.
                              // Never rendered as markup: this is typed into an
                              // admin grid and shown to every teacher.
                              <div
                                style={{
                                  fontSize: 12,
                                  color: "var(--ink-2)",
                                  marginTop: 4,
                                  whiteSpace: "pre-wrap",
                                  lineHeight: 1.5,
                                }}
                              >
                                {l.bodyMd}
                              </div>
                            ) : null}
                          </li>
                        ))}
                      </ol>
                    </details>
                  );
                })}
              </div>
            )}
          </article>

          {/* On a phone the readings and the assessment follow the modules
              here, not the sessions table and the progress card in the
              other column: one column is read, and tabbed, top to bottom,
              and those two -- the quiz's Start button among them -- sat
              about two screens down (F11). Placed in the DOM, not by CSS
              order, so reading, focus and visual order stay the same. */}
          {phone ? readingsCard : null}
          {phone ? assessmentCard : null}

          <article id="scorm" className="card card-hi">
            <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--line)" }}>
              {/* One text node, so the count reads as one string. */}
              <div style={{ fontWeight: 600, fontSize: 13 }}>{t("subject.scormModules", { count: scorm.length })}</div>
              <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>
                {t("subject.scormIntro")}
              </div>
            </div>
            {scorm.length === 0 ? (
              <div style={{ padding: 24, fontSize: 13, color: "var(--ink-3)", textAlign: "center" }}>
                {t("subject.noScorm")}
                {viewerIsAdmin ? (
                  <div style={{ fontSize: 12, marginTop: 6 }}>
                    {t.rich("subject.addScorm", { link: (chunks) => <Link href="/admin/scorm">{chunks}</Link> })}
                  </div>
                ) : null}
              </div>
            ) : (
              <ul style={{ listStyle: "none", margin: 0, padding: "0 14px", fontSize: 13 }}>
                {scorm.map((p, i) => (
                  <li
                    key={p.id}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: 10,
                      padding: "12px 0",
                      borderTop: i ? "1px solid var(--line)" : "none",
                    }}
                  >
                    <div>
                      <div style={{ fontWeight: 500 }}>
                        {p.title}
                        {!p.active ? (
                          // Only an administrator is shown a withdrawn package.
                          <span className="chip chip-rust" style={{ marginLeft: 6 }}>
                            {t("common.withdrawn")}
                          </span>
                        ) : null}
                      </div>
                      <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 4, fontSize: 11 }}>
                        <span className={statusChip(p.lessonStatus)}>{statusLabel(p.lessonStatus, t)}</span>
                        {p.scoreRaw !== null ? <span className="mono">{t("subject.score", { score: p.scoreRaw })}</span> : null}
                      </div>
                    </div>
                    <Link
                      href={`/scorm/${p.id}`}
                      className={p.lessonStatus === "not attempted" ? "btn btn-sm btn-primary" : "btn btn-sm"}
                      style={{ textDecoration: "none" }}
                    >
                      {launchLabel(p.lessonStatus, t)}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </article>

          <article className="card card-hi">
            <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--line)" }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>{t("subject.cohortSessions", { count: sessions.length })}</div>
              <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>
                {t("subject.cohortIntro")}
              </div>
            </div>
            {sessions.length === 0 ? (
              <div style={{ padding: 24, fontSize: 13, color: "var(--ink-3)", textAlign: "center" }}>
                {t("subject.noSessions")}
              </div>
            ) : (
              // Scrolls sideways inside the card: six columns are wider than a
              // phone, and with no scroll box the table widened the page.
              <div style={{ overflowX: "auto" }}>
                <table className="t">
                  <thead>
                    <tr>
                      <th>{t("subject.col.date")}</th>
                      <th>{t("subject.col.session")}</th>
                      <th>{t("subject.col.type")}</th>
                      <th>{t("subject.col.duration")}</th>
                      <th title={t("subject.col.youTitle")}>{t("subject.col.you")}</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {sessions.map((s) => {
                      // Spec 119: each rtt-session row links to /repo/session/${id}
                      // (the classroom-session detail page). For sessions that are
                      // still upcoming (scheduledAt in the future or null) the
                      // action column shows "Join"; for past sessions "Watch".
                      // Both render as <Link href=…> so they have real handlers.
                      // NO LINK. `s.id` is an rtt_sessions id, and
                      // /repo/session/[id] looks up the CLASSROOM sessions table
                      // -- a different table entirely -- so every one of these
                      // rows 404'd. rtt_sessions has no detail page; the calendar
                      // at /rtt/online/synchronous is where these are listed.
                      const isUpcoming = s.isUpcoming;
                      // A web link or nothing (lib/rtt/links.ts): a stored
                      // "meet.google.com/..." was a relative href into the app.
                      const link = webLink(s.linkOrRecording);
                      return (
                        <tr key={s.id}>
                          <td className="mono" style={{ fontSize: 12 }}>
                            {s.scheduledAt ? (
                              new Date(s.scheduledAt).toLocaleString(intl, {
                                dateStyle: "medium",
                                timeStyle: "short",
                              })
                            ) : (
                              <span className="empty-dash">{t("common.unscheduled")}</span>
                            )}
                          </td>
                          <td>
                            {s.title}
                          </td>
                          <td>
                            {s.type ? (
                              <span className="chip">{SESSION_TYPES.has(s.type) ? t(`sessionType.${s.type}`) : s.type}</span>
                            ) : (
                              <em className="dash">—</em>
                            )}
                          </td>
                          <td className="mono" style={{ fontSize: 12 }}>
                            {s.durationMin ? t("common.minutes", { minutes: s.durationMin }) : <em className="dash">—</em>}
                          </td>
                          <td>
                            {attendance.has(s.id) ? (
                              <span className={ATTENDANCE_CHIP[attendance.get(s.id)!] ?? "chip"}>
                                {ATTENDANCE_CHIP[attendance.get(s.id)!]
                                  ? t(`attendance.${attendance.get(s.id)!}`)
                                  : attendance.get(s.id)!}
                              </span>
                            ) : (
                              <em className="dash">—</em>
                            )}
                          </td>
                          <td>
                            {link ? (
                              <a
                                href={link}
                                className="btn btn-sm"
                                target="_blank"
                                rel="noopener noreferrer"
                                style={{ textDecoration: "none" }}
                              >
                                {isUpcoming ? t("subject.join") : t("subject.watch")}
                              </a>
                            ) : (
                              <span className="chip" title={t("subject.noLinkTitle")}>
                                {isUpcoming ? t("subject.noLinkYet") : t("subject.noRecording")}
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </article>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 14, alignContent: "start" }}>
          <article className="card card-hi">
            <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--line)" }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>{t("subject.yourProgress")}</div>
            </div>
            <dl
              style={{
                margin: 0,
                padding: 14,
                display: "grid",
                gridTemplateColumns: "minmax(0, 1fr) minmax(0, auto)",
                gap: "6px 12px",
                fontSize: 13,
              }}
            >
              <dt>{t("subject.lessons")}</dt>
              <dd className="mono" style={{ margin: 0 }}>
                {t("subject.ofTotal", { done: done.lessons.size, total: lessons.length })}
              </dd>
              <dt>{t("subject.readingsLabel")}</dt>
              <dd className="mono" style={{ margin: 0 }}>
                {t("subject.ofTotal", { done: done.readings.size, total: readings.length })}
              </dd>
              <dt>{t("subject.assessmentsPassed")}</dt>
              <dd className="mono" style={{ margin: 0 }}>
                {t("subject.ofTotal", { done: passedCount, total: assessments.length })}
              </dd>
              <dt>{t("subject.sessionsAttended")}</dt>
              <dd className="mono" style={{ margin: 0 }}>
                {attendance.size === 0 ? t("subject.notTakenYet") : t("subject.ofTotal", { done: presentCount, total: attendance.size })}
              </dd>
            </dl>
            <div style={{ padding: "0 14px 12px", fontSize: 11 }}>
              <Link href="/rtt/progress">{t("subject.allProgress")}</Link>
            </div>
          </article>

          {phone ? null : readingsCard}
          {phone ? null : assessmentCard}

          {/* Last, on a phone and on a desktop: the readings and the quiz's
              Start button are what a subject is opened for (F11), and a
              teach-back comes once the subject has been learned. */}
          {scope.isStaff ? null : (
            <article id="teach-back" className="card card-hi">
              <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--line)" }}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>{t("subject.teachBack")}</div>
                <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>
                  {t("subject.teachBackIntro")}
                </div>
              </div>
              {teachBacks.length > 0 ? (
                <ul style={{ listStyle: "none", margin: 0, padding: "0 14px", fontSize: 13 }}>
                  {teachBacks.map((v, i) => {
                    const chip = teachBackChip(v, t);
                    return (
                      <li
                        key={v.id}
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          gap: 10,
                          padding: "10px 0",
                          borderTop: i ? "1px solid var(--line)" : "none",
                        }}
                      >
                        <Link href={`/videos/${v.id}`} style={{ color: "var(--indigo)" }}>
                          {t("subject.sent", {
                            date: new Date(v.createdAt).toLocaleDateString(intl, { day: "numeric", month: "long", year: "numeric" }),
                          })}
                        </Link>
                        <span className={chip.cls}>{chip.label}</span>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
              {/* The upload page, bound to this subject: the file picker, the
                  phone flow and -- when the programme has a number -- the
                  WhatsApp caption TB-<subject> live there. */}
              <div style={{ padding: "12px 14px" }}>
                <Link
                  href={uploadHref({ contextType: "teach_back", contextId: id })}
                  className="btn btn-sm"
                  style={{ textDecoration: "none" }}
                >
                  {teachBacks.length === 0 ? t("subject.uploadFirst") : t("subject.uploadAnother")}
                </Link>
              </div>
            </article>
          )}
        </div>
      </section>
    </div>
  );
}
