// /rtt/online/synchronous — webinars + live-quizzes calendar.
//
// Spec 064: surfaces every synchronous rtt_session (type IN webinar|quiz|synchronous)
// that has a scheduledAt in the present or future, laid out across a 3-week
// Mon-Fri grid plus an upcoming-5 side panel.

import Link from "next/link";
import { redirect } from "next/navigation";
import { and, asc, eq, gte, inArray, isNotNull } from "drizzle-orm";
import { db } from "@gml/db";
import { rttSessions, rttSubjects, terms, phases } from "@gml/db/schema";
import { auth } from "@/auth";

export const dynamic = "force-dynamic";

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

const TYPE_PILL: Record<string, { bg: string; ink: string; label: string }> = {
  webinar: { bg: "var(--indigo-soft)", ink: "var(--indigo)", label: "Webinar" },
  quiz: { bg: "var(--saffron-soft)", ink: "var(--saffron)", label: "Live quiz" },
  synchronous: { bg: "var(--lichen-soft)", ink: "var(--lichen)", label: "Live" },
};

// Mon→Fri only (RTT cohorts skip weekends).
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"];

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

function fmtTime(d: Date): string {
  return d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true });
}

function fmtMonthDay(d: Date): string {
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

export default async function RttOnlineSynchronousPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

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
          RTT online hub
        </div>
        <h1 style={{ fontFamily: "var(--serif)", fontSize: 28, marginTop: 4 }}>
          Online · Synchronous
        </h1>
        <p style={{ color: "var(--ink-3)", fontSize: 13, marginTop: 4 }}>
          Webinars and live quizzes scheduled across the next three working weeks.
          {totalScheduled > 0 ? ` ${totalScheduled} session${totalScheduled === 1 ? "" : "s"} in window.` : ""}
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
            No webinars scheduled. Schedule via{" "}
            {/* /admin/data/sessions manages the CLASSROOM sessions table, which is
                not what this calendar renders -- nothing entered there has ever
                appeared here. This calendar reads rtt_sessions. */}
            <Link href="/admin/data/rtt-sessions" style={{ color: "var(--indigo)" }}>
              /admin/data/rtt-sessions
            </Link>
            .
          </p>
        </div>
      ) : (
        <section style={{ display: "grid", gridTemplateColumns: "minmax(0, 2.2fr) minmax(280px, 1fr)", gap: 18 }}>
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
              <h2 style={{ fontFamily: "var(--serif)", fontSize: 18, margin: 0 }}>3-week calendar</h2>
              <span style={{ fontSize: 11, color: "var(--ink-3)", fontFamily: "var(--mono)" }}>
                {fmtMonthDay(weekStart)} – {fmtMonthDay(addDays(windowEnd, -1))}
              </span>
            </header>

            <div style={{ display: "grid", gridTemplateColumns: `60px repeat(${WEEKDAYS.length}, minmax(0, 1fr))`, gap: 6 }}>
              <div />
              {WEEKDAYS.map((wd) => (
                <div
                  key={wd}
                  style={{
                    fontSize: 10,
                    textTransform: "uppercase",
                    letterSpacing: "0.08em",
                    color: "var(--ink-3)",
                    padding: "4px 6px",
                  }}
                >
                  {wd}
                </div>
              ))}

              {Array.from({ length: 3 }).map((_, w) => (
                <WeekRow
                  key={w}
                  weekStart={addDays(weekStart, w * 7)}
                  grid={grid}
                  isCurrent={isoDateKey(addDays(weekStart, w * 7)) === isoDateKey(weekStart)}
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
                Next up
              </div>
              <h2 style={{ fontFamily: "var(--serif)", fontSize: 18, margin: "4px 0 0" }}>Upcoming webinars</h2>
            </header>

            {upcoming.length === 0 ? (
              <p style={{ fontSize: 12, color: "var(--ink-3)", margin: 0 }}>
                Nothing live in the next three weeks.
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
                          {pill.label}
                        </span>
                        <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--ink-3)" }}>
                          {u.scheduledAt
                            ? new Date(u.scheduledAt).toLocaleDateString("en-IN", { day: "numeric", month: "short" })
                            : "—"}
                          {u.scheduledAt ? ` · ${fmtTime(new Date(u.scheduledAt))}` : ""}
                        </span>
                      </div>
                      <div style={{ fontSize: 13, fontWeight: 500 }}>{u.title}</div>
                      <div style={{ fontSize: 11, color: "var(--ink-3)" }}>
                        {u.subjectName ?? "(unlinked subject)"}
                        {u.phaseLabel ? ` · ${u.phaseLabel}` : ""}
                        {u.termName ? ` · ${u.termName}` : ""}
                      </div>
                      {u.notes ? (
                        <div style={{ fontSize: 11, color: "var(--ink-3)" }}>
                          Facilitator: <span style={{ color: "var(--ink-2)" }}>{u.notes}</span>
                        </div>
                      ) : null}
                      {u.linkOrRecording ? (
                        <a
                          href={u.linkOrRecording}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ fontSize: 12, color: "var(--indigo)" }}
                        >
                          Join link →
                        </a>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}

            <footer style={{ marginTop: 8, paddingTop: 10, borderTop: "1px solid var(--line)", fontSize: 11, color: "var(--ink-3)" }}>
              Schedule changes? Open{" "}
              <Link href="/admin/data/rtt-sessions" style={{ color: "var(--indigo)" }}>
                /admin/data/rtt-sessions
              </Link>
              .
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
}: {
  weekStart: Date;
  grid: Map<string, SyncSessionRow[]>;
  isCurrent: boolean;
}) {
  return (
    <>
      <div
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
        {fmtMonthDay(weekStart)}
      </div>
      {WEEKDAYS.map((_, dIdx) => {
        const day = addDays(weekStart, dIdx);
        const key = isoDateKey(day);
        const bucket = grid.get(key) ?? [];
        return (
          <div
            key={key}
            style={{
              minHeight: 88,
              border: "1px solid var(--line)",
              borderRadius: "var(--r-2)",
              background: isCurrent ? "var(--paper)" : "var(--card)",
              padding: 6,
              display: "flex",
              flexDirection: "column",
              gap: 4,
            }}
          >
            <div style={{ fontSize: 10, color: "var(--ink-3)", fontFamily: "var(--mono)" }}>
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
                      {b.scheduledAt ? fmtTime(new Date(b.scheduledAt)) : "—"}
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

