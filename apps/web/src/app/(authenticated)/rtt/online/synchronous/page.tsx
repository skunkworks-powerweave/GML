// /rtt/online/synchronous — webinars + live-quizzes calendar.
//
// Spec 064: surfaces every synchronous rtt_session (type IN webinar|quiz|synchronous)
// that has a scheduledAt in the present or future, laid out across a 3-week
// Mon-Fri grid plus an upcoming-5 side panel.

import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { and, asc, eq, gte, inArray, isNotNull } from "drizzle-orm";
import { getLocale, getTranslations } from "next-intl/server";
import { db } from "@gml/db";
import { rttSessions, rttSubjects, terms, phases } from "@gml/db/schema";
import { auth } from "@/auth";
import { INTL_LOCALE, type Locale } from "@/i18n/config";
import { rttScope } from "@/lib/rtt/scope";
import { webLink } from "@/lib/rtt/links";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("rtt");
  return { title: t("sync.metaTitle") };
}

// rtt_sessions.type uses the same string convention as the seed/import scripts:
// synchronous | asynchronous | webinar | quiz. The synchronous surface excludes
// "asynchronous" only — webinars and live quizzes belong on this calendar too.
const SYNC_TYPES = ["synchronous", "webinar", "quiz"] as const;

type SyncSessionRow = {
  id: string;
  title: string;
  scheduledAt: Date | null;
  durationMin: number | null;
  type: string | null;
  platform: string | null;
  notes: string | null;
  linkOrRecording: string | null;
  rttSubjectId: string;
  subjectName: string | null;
  termName: string | null;
  phaseLabel: string | null;
};

// Each pill's label is rtt.sync.type.<type>.
const TYPE_PILL: Record<string, { bg: string; ink: string; type: string }> = {
  webinar: { bg: "var(--indigo-soft)", ink: "var(--indigo)", type: "webinar" },
  quiz: { bg: "var(--saffron-soft)", ink: "var(--saffron)", type: "quiz" },
  synchronous: { bg: "var(--lichen-soft)", ink: "var(--lichen)", type: "synchronous" },
};

// Mon→Fri only (RTT cohorts skip weekends): days after the week's Monday.
// Their names are the viewer's language's (Intl), not a list here.
const WEEKDAYS = [0, 1, 2, 3, 4];

function startOfWeekMonday(d: Date): Date {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  const day = c.getDay(); // 0 Sun … 6 Sat
  const diff = day === 0 ? -6 : 1 - day;
  c.setDate(c.getDate() + diff);
  return c;
}

function addDays(d: Date, days: number): Date {
  const c = new Date(d);
  c.setDate(c.getDate() + days);
  return c;
}

function isoDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function fmtTime(d: Date, intl: string): string {
  return d.toLocaleTimeString(intl, { hour: "numeric", minute: "2-digit", hour12: true });
}

function fmtMonthDay(d: Date, intl: string): string {
  return d.toLocaleDateString(intl, { day: "numeric", month: "short" });
}

/** A day's short name in the viewer's language: "Mon" in English. */
function fmtWeekday(d: Date, intl: string): string {
  return d.toLocaleDateString(intl, { weekday: "short" });
}

export default async function RttOnlineSynchronousPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const t = await getTranslations("rtt");
  const intl = INTL_LOCALE[(await getLocale()) as Locale];
  // Sessions of the subjects this viewer is shown (lib/rtt/scope.ts): a
  // retired subject's webinars stayed on the calendar for everyone.
  const scope = await rttScope(db, { id: session.user.id, role: session.user.role });

  const now = new Date();
  const weekStart = startOfWeekMonday(now);
  const windowEnd = addDays(weekStart, 21); // 3 weeks × 7 days

  // Pull every synchronous-flavoured rtt_session inside the 3-week window with a
  // resolved subject → term → phase trail (the facilitator lives in
  // rtt_sessions.notes — there's no facilitator FK in the locked schema).
  const rows = await db
    .select({
      id: rttSessions.id,
      title: rttSessions.title,
      scheduledAt: rttSessions.scheduledAt,
      durationMin: rttSessions.durationMin,
      type: rttSessions.type,
      platform: rttSessions.platform,
      notes: rttSessions.notes,
      linkOrRecording: rttSessions.linkOrRecording,
      rttSubjectId: rttSessions.rttSubjectId,
      subjectName: rttSubjects.name,
      termName: terms.name,
      phaseLabel: phases.label,
    })
    .from(rttSessions)
    .leftJoin(rttSubjects, eq(rttSessions.rttSubjectId, rttSubjects.id))
    .leftJoin(terms, eq(rttSubjects.termId, terms.id))
    .leftJoin(phases, eq(terms.phaseId, phases.id))
    .where(
      and(
        isNotNull(rttSessions.scheduledAt),
        inArray(rttSessions.type, SYNC_TYPES as unknown as string[]),
        gte(rttSessions.scheduledAt, weekStart),
        scope.subjectWhere,
      ),
    )
    .orderBy(asc(rttSessions.scheduledAt))
    .limit(200);

  // Bucket into the 3-week grid by ISO date key. Sessions outside the 3-week
  // window (i.e. >= week 4) still feed the side-panel "upcoming" list but not
  // the grid.
  const grid = new Map<string, SyncSessionRow[]>();
  for (let w = 0; w < 3; w++) {
    for (let d = 0; d < 5; d++) {
      grid.set(isoDateKey(addDays(weekStart, w * 7 + d)), []);
    }
  }
  for (const r of rows) {
    if (!r.scheduledAt) continue;
    if (r.scheduledAt >= windowEnd) continue;
    const key = isoDateKey(new Date(r.scheduledAt));
    const bucket = grid.get(key);
    if (bucket) bucket.push(r);
  }

  const upcoming = rows
    .filter((r) => r.scheduledAt && r.scheduledAt >= now)
    .slice(0, 5);

  const totalScheduled = rows.length;

  return (
    <div>
      <header style={{ marginBottom: 22 }}>
        <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--ink-3)" }}>
          {t("sync.eyebrow")}
        </div>
        <h1 style={{ fontFamily: "var(--serif)", fontSize: 28, marginTop: 4 }}>
          {t("sync.title")}
        </h1>
        <p style={{ color: "var(--ink-3)", fontSize: 13, marginTop: 4 }}>
          {totalScheduled > 0 ? t("sync.introWithCount", { count: totalScheduled }) : t("sync.intro")}
        </p>
      </header>

      {totalScheduled === 0 ? (
        <div
          style={{
            background: "var(--card-hi)",
            border: "1px solid var(--line)",
            borderRadius: "var(--r-3)",
            padding: 32,
            textAlign: "center",
            color: "var(--ink-3)",
          }}
        >
          <p style={{ fontSize: 14, margin: 0 }}>
            {/* /admin/data/sessions manages the CLASSROOM sessions table, which is
                not what this calendar renders -- nothing entered there has ever
                appeared here. This calendar reads rtt_sessions. */}
            {t.rich("sync.empty", {
              link: (chunks) => (
                <Link href="/admin/data/rtt-sessions" style={{ color: "var(--indigo)" }}>
                  {chunks}
                </Link>
              ),
            })}
          </p>
        </div>
      ) : (
        // PHONE WIDTH (F11). The calendar and the upcoming panel were an inline
        // "minmax(0, 2.2fr) minmax(280px, 1fr)" at every width: on a 360 px
        // phone the panel kept its 280 px and the calendar got the ~30 px
        // left over, its five day columns spilling over the panel. Below
        // 768 px they stack, and the calendar becomes a list of the days that
        // have something on (see the classes in the grid and WeekRow).
        <section className="grid grid-cols-1 gap-[18px] md:grid-cols-[minmax(0,2.2fr)_minmax(280px,1fr)]">
          {/* ── 3-week Mon-Fri grid ─────────────────────────────────────── */}
          <article
            style={{
              background: "var(--card-hi)",
              border: "1px solid var(--line)",
              borderRadius: "var(--r-3)",
              padding: 16,
              display: "flex",
              flexDirection: "column",
              gap: 12,
            }}
          >
            <header style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
              <h2 style={{ fontFamily: "var(--serif)", fontSize: 18, margin: 0 }}>{t("sync.calendar")}</h2>
              <span style={{ fontSize: 11, color: "var(--ink-3)", fontFamily: "var(--mono)" }}>
                {fmtMonthDay(weekStart, intl)} – {fmtMonthDay(addDays(windowEnd, -1), intl)}
              </span>
            </header>

            {/* Five day columns from 768 px. On a phone they would be ~40 px
                each, too narrow for a time or a title, so the grid is one
                column there: the weekday headers are hidden, each week's
                label heads the days of that week that have a session, and
                each of those days names its weekday (WeekRow). */}
            <div className="grid grid-cols-1 gap-[6px] md:grid-cols-[60px_repeat(5,minmax(0,1fr))]">
              <div className="hidden md:block" />
              {WEEKDAYS.map((wd) => (
                <div
                  key={wd}
                  className="hidden md:block"
                  style={{
                    fontSize: 10,
                    textTransform: "uppercase",
                    letterSpacing: "0.08em",
                    color: "var(--ink-3)",
                    padding: "4px 6px",
                  }}
                >
                  {fmtWeekday(addDays(weekStart, wd), intl)}
                </div>
              ))}

              {Array.from({ length: 3 }).map((_, w) => (
                <WeekRow
                  key={w}
                  weekStart={addDays(weekStart, w * 7)}
                  grid={grid}
                  isCurrent={isoDateKey(addDays(weekStart, w * 7)) === isoDateKey(weekStart)}
                  intl={intl}
                />
              ))}
            </div>
          </article>

          {/* ── Upcoming 5 side panel ───────────────────────────────────── */}
          <aside
            style={{
              background: "var(--card-hi)",
              border: "1px solid var(--line)",
              borderRadius: "var(--r-3)",
              padding: 16,
              display: "flex",
              flexDirection: "column",
              gap: 10,
              alignSelf: "start",
            }}
          >
            <header>
              <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--ink-3)" }}>
                {t("sync.nextUp")}
              </div>
              <h2 style={{ fontFamily: "var(--serif)", fontSize: 18, margin: "4px 0 0" }}>{t("sync.upcoming")}</h2>
            </header>

            {upcoming.length === 0 ? (
              <p style={{ fontSize: 12, color: "var(--ink-3)", margin: 0 }}>
                {t("sync.nothingLive")}
              </p>
            ) : (
              <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 10 }}>
                {upcoming.map((u) => {
                  const pill = TYPE_PILL[u.type ?? "synchronous"] ?? TYPE_PILL.synchronous;
                  return (
                    <li
                      key={u.id}
                      style={{
                        border: "1px solid var(--line)",
                        borderRadius: "var(--r-2)",
                        padding: 10,
                        display: "flex",
                        flexDirection: "column",
                        gap: 4,
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                        <span
                          style={{
                            padding: "2px 8px",
                            background: pill.bg,
                            color: pill.ink,
                            borderRadius: 999,
                            fontSize: 10,
                            textTransform: "uppercase",
                            letterSpacing: "0.06em",
                            fontWeight: 600,
                          }}
                        >
                          {t(`sync.type.${pill.type}`)}
                        </span>
                        <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--ink-3)" }}>
                          {u.scheduledAt ? fmtMonthDay(new Date(u.scheduledAt), intl) : "—"}
                          {u.scheduledAt ? ` · ${fmtTime(new Date(u.scheduledAt), intl)}` : ""}
                        </span>
                      </div>
                      <div style={{ fontSize: 13, fontWeight: 500 }}>{u.title}</div>
                      <div style={{ fontSize: 11, color: "var(--ink-3)" }}>
                        {u.subjectName ?? t("sync.unlinkedSubject")}
                        {u.phaseLabel ? ` · ${u.phaseLabel}` : ""}
                        {u.termName ? ` · ${u.termName}` : ""}
                      </div>
                      {u.notes ? (
                        <div style={{ fontSize: 11, color: "var(--ink-3)" }}>
                          {t.rich("sync.facilitator", {
                            name: u.notes,
                            strong: (chunks) => <span style={{ color: "var(--ink-2)" }}>{chunks}</span>,
                          })}
                        </div>
                      ) : null}
                      {/* A web link or nothing (lib/rtt/links.ts): a stored
                          "meet.google.com/..." was a relative href into the app. */}
                      {webLink(u.linkOrRecording) ? (
                        <a
                          href={webLink(u.linkOrRecording)!}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ fontSize: 12, color: "var(--indigo)" }}
                        >
                          {t("sync.joinLink")}
                        </a>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}

            <footer style={{ marginTop: 8, paddingTop: 10, borderTop: "1px solid var(--line)", fontSize: 11, color: "var(--ink-3)" }}>
              {t.rich("sync.scheduleChanges", {
                link: (chunks) => (
                  <Link href="/admin/data/rtt-sessions" style={{ color: "var(--indigo)" }}>
                    {chunks}
                  </Link>
                ),
              })}
            </footer>
          </aside>
        </section>
      )}
    </div>
  );
}

function WeekRow({
  weekStart,
  grid,
  isCurrent,
  intl,
}: {
  weekStart: Date;
  grid: Map<string, SyncSessionRow[]>;
  isCurrent: boolean;
  /** The Intl locale times and dates are written in (INTL_LOCALE). */
  intl: string;
}) {
  // On a phone (one column, see the calendar grid) only the days with a
  // session are shown, under their week's label; a week with none shows
  // nothing. The desktop grid shows every day.
  const weekHasSessions = WEEKDAYS.some((dIdx) => (grid.get(isoDateKey(addDays(weekStart, dIdx)))?.length ?? 0) > 0);
  return (
    <>
      <div
        className={weekHasSessions ? undefined : "hidden md:block"}
        style={{
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          color: isCurrent ? "var(--indigo)" : "var(--ink-3)",
          fontWeight: isCurrent ? 600 : 400,
          fontFamily: "var(--mono)",
          padding: "8px 4px",
          alignSelf: "start",
        }}
      >
        {fmtMonthDay(weekStart, intl)}
      </div>
      {WEEKDAYS.map((dIdx) => {
        const day = addDays(weekStart, dIdx);
        const key = isoDateKey(day);
        const bucket = grid.get(key) ?? [];
        return (
          <div
            key={key}
            // display is a class, not inline, so the phone can hide an empty day.
            className={bucket.length === 0 ? "hidden md:flex md:flex-col" : "flex flex-col"}
            style={{
              minHeight: 88,
              border: "1px solid var(--line)",
              borderRadius: "var(--r-2)",
              background: isCurrent ? "var(--paper)" : "var(--card)",
              padding: 6,
              gap: 4,
            }}
          >
            <div style={{ fontSize: 10, color: "var(--ink-3)", fontFamily: "var(--mono)" }}>
              {/* The weekday is a column header on a desktop; a phone has none. */}
              <span className="md:hidden">{fmtWeekday(day, intl)} </span>
              {day.getDate()}
            </div>
            {bucket.length === 0 ? (
              <div style={{ flex: 1 }} />
            ) : (
              bucket.map((b) => {
                const pill = TYPE_PILL[b.type ?? "synchronous"] ?? TYPE_PILL.synchronous;
                return (
                  <div
                    key={b.id}
                    style={{
                      background: pill.bg,
                      color: pill.ink,
                      borderRadius: "var(--r-1)",
                      padding: "4px 6px",
                      fontSize: 11,
                      lineHeight: 1.3,
                      display: "flex",
                      flexDirection: "column",
                      gap: 2,
                    }}
                  >
                    <span style={{ fontFamily: "var(--mono)", fontSize: 10 }}>
                      {b.scheduledAt ? fmtTime(new Date(b.scheduledAt), intl) : "—"}
                    </span>
                    <span style={{ fontWeight: 500, color: "var(--ink)" }}>{b.title}</span>
                    {b.notes ? (
                      <span style={{ fontSize: 10, color: "var(--ink-2)" }}>{b.notes}</span>
                    ) : null}
                  </div>
                );
              })
            )}
          </div>
        );
      })}
    </>
  );
}

