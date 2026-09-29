// /repo/class/[id] — class detail: school + grade + stage + subjects taught at this grade
// + recent classroom sessions. PII-free (no learner names). The "View roster" link in the
// right column is conditionally rendered for super_admin / programme_admin only — clicking
// through to /learners is what triggers the SM-9 audit hook (see ./learners/page.tsx).

import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { and, desc, eq, gte, isNull, lte, or } from "drizzle-orm";
import { db } from "@gml/db";
import { classes, schools, subjects, sessions, teachers } from "@gml/db/schema";
import { auth } from "@/auth";
import { actorFrom } from "@/lib/authz";
import { mayOpenClass, repoScope, sessionsWhere } from "@/lib/teaching/visibility";
import { uuidOrNotFound } from "@/lib/ids";
import { getDeviceType } from "@/lib/device";
import { MobileDetailFrame } from "@/components/shells";
import { enumLabel, repoIntlLocale } from "@/components/repo/repo-i18n";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("repo");
  return { title: t("class.metaTitle") };
}

// Stage chip kinds — map to the new `.chip` utility class variants in globals.css.
// The `bg` field is the underlying CSS var the chip-* class resolves to (kept here
// as documentation + so governance tests can assert the Primary→lichen / Middle→indigo
// / High→saffron mapping from a single source of truth).
const STAGE_CHIP: Record<string, { kind: string; bg: string }> = {
  Primary: { kind: "chip-lichen", bg: "var(--lichen-soft)" },
  Middle: { kind: "chip-indigo", bg: "var(--indigo-soft)" },
  High: { kind: "chip-saffron", bg: "var(--saffron-soft)" },
};

// The label is repo.sessionStatus.<status>, in the viewer's language.
const STATUS_CHIP: Record<string, { kind: string }> = {
  planned: { kind: "" },
  in_progress: { kind: "chip-saffron" },
  complete: { kind: "chip-lichen" },
  cancelled: { kind: "chip-rust" },
};

export default async function RepoClassDetailPage({ params }: { params: Promise<{ id: string }> }) {
  // A malformed id names no record: 404, not a Postgres 22P02 and a 500.
  const id = uuidOrNotFound((await params).id);
  const session = await auth();
  const actor = actorFrom(session);
  if (!actor) redirect("/login");
  const role = actor.role;
  // A teacher opens only the classes she teaches (another class answers 404),
  // sees her own sessions in it, and may open its roster -- her own students,
  // audited like an administrator's read (./learners/page.tsx). Other roles
  // are unchanged (lib/teaching/visibility.ts).
  const scope = await repoScope(db, actor);
  if (!mayOpenClass(scope, id)) notFound();
  const canSeeRoster = role === "super_admin" || role === "programme_admin" || scope.own;
  const t = await getTranslations("repo");
  const intl = await repoIntlLocale();

  const [cls] = await db.select().from(classes).where(eq(classes.id, id)).limit(1);
  if (!cls) notFound();

  const [school] = await db.select().from(schools).where(eq(schools.id, cls.schoolId)).limit(1);

  // Subjects whose [gradesMin..gradesMax] window covers this class's grade (NULLs treated as open-ended).
  const subjectRows = await db
    .select()
    .from(subjects)
    .where(
      and(
        eq(subjects.active, true),
        or(isNull(subjects.gradesMin), lte(subjects.gradesMin, cls.grade)),
        or(isNull(subjects.gradesMax), gte(subjects.gradesMax, cls.grade)),
      ),
    )
    .orderBy(subjects.displayOrder, subjects.name);

  // Recent classroom sessions for this class — LEFT JOIN subject + teacher for display.
  const sessionRows = await db
    .select({
      id: sessions.id,
      scheduledDate: sessions.scheduledDate,
      scheduledTime: sessions.scheduledTime,
      topic: sessions.topic,
      status: sessions.status,
      subjectName: subjects.name,
      teacherName: teachers.fullName,
      teacherHindi: teachers.hindiName,
    })
    .from(sessions)
    .leftJoin(subjects, eq(sessions.subjectId, subjects.id))
    .leftJoin(teachers, eq(sessions.teacherId, teachers.id))
    .where(and(eq(sessions.classId, id), sessionsWhere(scope)))
    .orderBy(desc(sessions.scheduledDate))
    .limit(12);

  const stage = STAGE_CHIP[cls.stage] ?? STAGE_CHIP.Primary;

  // Spec 137 — device-aware MobileDetailFrame adoption. Existing two-column
  // body becomes the mobile vertical stack inside the thin-header chrome.
  // The back arrow targets the parent school (matching the existing inline
  // ← link) so users keep their place in the repo tree.
  const device = await getDeviceType();
  const mobileBackHref = school ? `/repo/school/${school.id}` : "/repo";
  const mobileTitle = school?.code
    ? t("class.mobileTitle", { grade: cls.grade, code: school.code })
    : t("common.gradeN", { grade: cls.grade });

  const body = (
    <div>
      <div className="page-header">
        <Link
          href={school ? `/repo/school/${school.id}` : "/repo"}
          className="btn btn-sm btn-ghost"
          style={{ marginBottom: 8, marginLeft: -8, display: "inline-flex" }}
        >
          ← {school?.code ?? t("common.repository")}
        </Link>
        <div>
          <div className="label">{t("class.label", { code: school?.code ?? "—" })}</div>
          <h1 style={{ fontFamily: "var(--serif)", fontSize: 28, marginTop: 4 }}>{t("common.gradeN", { grade: cls.grade })}</h1>
          <p style={{ color: "var(--ink-3)", marginTop: 4 }}>
            {cls.classTeacherName
              ? t("class.summaryTeacher", {
                  students: cls.studentsCount,
                  sections: cls.sectionsCount,
                  teacher: cls.classTeacherName,
                })
              : t("class.summary", { students: cls.studentsCount, sections: cls.sectionsCount })}
          </p>
        </div>
      </div>

      {/* One column below 768 px, 1.6fr 1fr above. This was an inline
          "1.6fr 1fr", which holds at every width, so on a phone the two
          columns stayed side by side and the page scrolled sideways. */}
      <section className="page-body grid grid-cols-1 items-start gap-[18px] md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div style={{ display: "grid", gap: 16 }}>
          {/* Subjects taught at this grade */}
          <SectionCard title={t("class.subjectsTitle", { count: subjectRows.length })} sub={t("class.subjectsSub")}>
            {subjectRows.length === 0 ? (
              <div style={{ padding: 18, color: "var(--ink-3)", fontSize: 13 }}>
                {t("class.noSubjects")}
              </div>
            ) : (
              <table className="t">
                <thead>
                  <tr>
                    <th>{t("common.subject")}</th>
                    <th>{t("common.gradesCovered")}</th>
                    <th>{t("common.code")}</th>
                  </tr>
                </thead>
                <tbody>
                  {subjectRows.map((s) => (
                    <tr key={s.id}>
                      <td style={{ fontWeight: 500 }}>
                        {s.color ? (
                          <span
                            aria-hidden
                            style={{
                              display: "inline-block",
                              width: 8,
                              height: 8,
                              borderRadius: 999,
                              background: s.color,
                              marginRight: 8,
                              verticalAlign: "middle",
                            }}
                          />
                        ) : null}
                        {s.name}
                      </td>
                      <td className="mono" style={{ fontSize: 12, color: "var(--ink-3)" }}>
                        {s.gradesMin ?? 1}–{s.gradesMax ?? 12}
                      </td>
                      <td className="mono" style={{ fontSize: 12, color: "var(--ink-3)" }}>
                        {s.code}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </SectionCard>

          {/* Sessions held in this class */}
          <SectionCard title={t("class.sessionsTitle", { count: sessionRows.length })} sub={t("common.mostRecentFirst")}>
            {sessionRows.length === 0 ? (
              <div style={{ padding: 18, color: "var(--ink-3)", fontSize: 13 }}>
                {t("class.noSessions")}
              </div>
            ) : (
              <table className="t">
                <thead>
                  <tr>
                    <th>{t("common.date")}</th>
                    <th>{t("common.time")}</th>
                    <th>{t("common.subject")}</th>
                    <th>{t("common.topic")}</th>
                    <th>{t("common.teacher")}</th>
                    <th>{t("common.status")}</th>
                  </tr>
                </thead>
                <tbody>
                  {sessionRows.map((s) => {
                    const pill = STATUS_CHIP[s.status] ?? STATUS_CHIP.planned;
                    const pillLabel = enumLabel(t, "sessionStatus", STATUS_CHIP[s.status] ? s.status : "planned");
                    return (
                      <tr key={s.id}>
                        <td className="mono" style={{ fontSize: 12 }}>
                          {new Date(`${s.scheduledDate}T00:00:00`).toLocaleDateString(intl, {
                            day: "numeric",
                            month: "short",
                          })}
                        </td>
                        <td className="mono" style={{ fontSize: 12, color: "var(--ink-3)" }}>
                          {s.scheduledTime ? String(s.scheduledTime).slice(0, 5) : "—"}
                        </td>
                        <td>{s.subjectName ?? "—"}</td>
                        <td style={{ color: "var(--ink-2)" }}>{s.topic ?? "—"}</td>
                        <td>
                          {s.teacherName ?? "—"}
                          {s.teacherHindi ? (
                            <span
                              style={{
                                fontFamily: "var(--deva)",
                                color: "var(--ink-3)",
                                marginLeft: 8,
                                fontSize: 12,
                              }}
                            >
                              {s.teacherHindi}
                            </span>
                          ) : null}
                        </td>
                        <td>
                          <span className={`chip ${pill.kind}`}>{pillLabel}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </SectionCard>
        </div>

        <div style={{ display: "grid", gap: 16, alignContent: "start" }}>
          {/* Details KV */}
          <SectionCard title={t("common.details")}>
            <div style={{ padding: "0 14px 8px" }}>
              <KVRow label={t("common.school")}>
                {school ? (
                  <Link
                    href={`/repo/school/${school.id}`}
                    style={{ color: "var(--indigo)", textDecoration: "none" }}
                  >
                    {school.code} · {school.name}
                  </Link>
                ) : (
                  "—"
                )}
              </KVRow>
              <KVRow label={t("common.grade")}>{cls.grade}</KVRow>
              <KVRow label={t("common.stage")}>
                <span className={`chip ${stage.kind}`}>{enumLabel(t, "stage", cls.stage)}</span>
              </KVRow>
              <KVRow label={t("common.students")}>{cls.studentsCount}</KVRow>
              <KVRow label={t("common.sections")}>{cls.sectionsCount}</KVRow>
              <KVRow label={t("common.classTeacher")}>{cls.classTeacherName ?? "—"}</KVRow>
              <KVRow label={t("common.status")}>
                <span className={`chip ${cls.active ? "chip-lichen" : ""}`}>
                  {cls.active ? t("common.active") : t("common.inactive")}
                </span>
              </KVRow>
            </div>
          </SectionCard>

          {/* PII-gated link to the learner roster — JSX prototype showed learners inline,
              but SM-9 (audit on view) requires moving the actual roster to /learners. */}
          {canSeeRoster ? (
            <Link
              href={`/repo/class/${id}/learners`}
              className="card card-hi"
              style={{
                padding: 16,
                textDecoration: "none",
                color: "var(--ink)",
                display: "block",
              }}
            >
              <div className="label">{t("class.rosterLabel")}</div>
              <div style={{ fontWeight: 500, marginTop: 4, fontSize: 14 }}>
                {t("class.viewLearners", { count: cls.studentsCount })}
              </div>
              <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 4 }}>
                {t("class.rosterAudited")}
              </div>
            </Link>
          ) : (
            <div
              style={{
                background: "var(--paper-2)",
                border: "1px dashed var(--line)",
                borderRadius: "var(--r-3)",
                padding: 16,
                fontSize: 11,
                color: "var(--ink-3)",
              }}
            >
              {t("class.rosterRestricted")}
            </div>
          )}
        </div>
      </section>
    </div>
  );

  return device === "mobile" ? (
    <MobileDetailFrame title={mobileTitle} backHref={mobileBackHref}>
      {body}
    </MobileDetailFrame>
  ) : (
    body
  );
}

function SectionCard({
  title,
  sub,
  children,
}: {
  title: string;
  sub?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="card card-hi" style={{ overflow: "hidden" }}>
      <header
        style={{
          padding: "12px 16px",
          borderBottom: "1px solid var(--line)",
          background: "var(--card)",
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 600 }}>{title}</div>
        {sub ? (
          <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>{sub}</div>
        ) : null}
      </header>
      {/* Scrolls sideways inside the card: a table wider than a phone was
          otherwise cut off by the card's overflow:hidden. */}
      <div style={{ overflowX: "auto" }}>{children}</div>
    </div>
  );
}

function KVRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "grid",
        // minmax(0, ...): a bare 1fr is at least as wide as its content, so a
        // long code or e-mail pushed the value past the card on a phone.
        gridTemplateColumns: "120px minmax(0, 1fr)",
        overflowWrap: "anywhere",
        gap: 10,
        padding: "8px 0",
        borderTop: "1px solid var(--line)",
        alignItems: "flex-start",
      }}
    >
      <span
        style={{
          fontSize: 11,
          color: "var(--ink-3)",
          textTransform: "uppercase",
          letterSpacing: "0.07em",
          fontWeight: 500,
          paddingTop: 2,
        }}
      >
        {label}
      </span>
      <div style={{ fontSize: 13, display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
        {children}
      </div>
    </div>
  );
}
