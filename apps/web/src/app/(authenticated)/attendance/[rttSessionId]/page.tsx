// /attendance/[rttSessionId] — take teachers' attendance at one RTT session.
//
// The roster is the active teachers the session's RTT subject is taught to
// (the whole programme, a district or a zone -- lib/rtt/scope.ts), plus anyone
// already marked here; lib/rtt/attendance.ts. Each teacher is marked present,
// late, absent or excused, and each mark says who took it and when. "Mark all
// present" saves the choices made and marks everyone left unmarked present.
//
// Programme admins and super admins only; the action checks again
// (./actions.ts). One column at phone width: a teacher's name, then her four
// choices, which wrap under it.

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { db } from "@gml/db";
import { SubmitButton } from "@/components/SubmitButton";
import { INTL_LOCALE, type Locale } from "@/i18n/config";
import { requireRole } from "@/lib/guards";
import { uuidOrNotFound } from "@/lib/ids";
import { MARKING_ORDER, markingSession, PROGRAMME_TIME_ZONE, sessionRoster } from "@/lib/rtt/attendance";
import { placeLabel } from "@/lib/rtt/scope";
import { saveAttendanceAction } from "./actions";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("rtt");
  return { title: t("marking.metaTitle") };
}

/** rtt_sessions.type values with a label under rtt.sessionType. */
const SESSION_TYPES = new Set(["synchronous", "asynchronous", "webinar", "quiz"]);

/** A chosen status's colour, as the other RTT pages show it. */
const CHOSEN: Record<string, { bg: string; ink: string }> = {
  present: { bg: "var(--lichen-soft)", ink: "var(--lichen)" },
  late: { bg: "var(--saffron-soft)", ink: "var(--saffron)" },
  absent: { bg: "var(--rust-soft)", ink: "var(--rust)" },
  excused: { bg: "var(--paper-2)", ink: "var(--ink-2)" },
};

const ERRORS = new Set(["not_on_roster", "invalid"]);

export default async function AttendanceSessionPage({
  params,
  searchParams,
}: {
  params: Promise<{ rttSessionId: string }>;
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  await requireRole(["programme_admin", "super_admin"]);
  // A malformed id is a session that does not exist, not a Postgres 500.
  const id = uuidOrNotFound((await params).rttSessionId);
  const sp = await searchParams;
  const t = await getTranslations("rtt");
  const intl = INTL_LOCALE[(await getLocale()) as Locale];

  const session = await markingSession(db, id);
  if (!session) notFound();
  const roster = await sessionRoster(db, session);

  const tally = { present: 0, late: 0, absent: 0, excused: 0, unmarked: 0 };
  for (const r of roster) tally[r.status ?? "unmarked"] += 1;
  const saved = sp.saved !== undefined && /^\d+$/.test(sp.saved) ? Number(sp.saved) : null;
  const error = sp.error && ERRORS.has(sp.error) ? sp.error : null;
  const when = (d: Date) =>
    new Date(d).toLocaleString(intl, { dateStyle: "medium", timeStyle: "short", timeZone: PROGRAMME_TIME_ZONE });

  return (
    <div>
      <div className="page-header">
        <Link href="/attendance" className="btn btn-sm btn-ghost" style={{ marginBottom: 6 }}>
          {t("marking.back")}
        </Link>
        <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--ink-3)" }}>
          {session.subjectName}
        </div>
        <h1 style={{ fontFamily: "var(--serif)", fontSize: 26, marginTop: 4 }}>{session.title}</h1>
        <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 4, display: "flex", flexWrap: "wrap", gap: 6 }}>
          <span className="mono">{session.scheduledAt ? when(session.scheduledAt) : t("common.unscheduled")}</span>
          {session.type ? (
            <span>· {SESSION_TYPES.has(session.type) ? t(`sessionType.${session.type}`) : session.type}</span>
          ) : null}
          {session.durationMin ? <span>· {t("common.minutes", { minutes: session.durationMin })}</span> : null}
          <span>· {session.place ? t("subject.onlyIn", { place: placeLabel(session.place) }) : t("placePicker.whole")}</span>
        </div>
      </div>

      <div className="page-body" style={{ display: "grid", gap: 14 }}>
        {saved !== null ? (
          <p
            role="status"
            style={{ margin: 0, padding: "8px 12px", background: "var(--lichen-soft)", color: "var(--lichen)", borderRadius: "var(--r-2)", fontSize: 12 }}
          >
            {t("marking.saved", { count: saved })}
          </p>
        ) : null}
        {error ? (
          <p
            role="alert"
            style={{ margin: 0, padding: "8px 12px", background: "var(--rust-soft)", color: "var(--rust)", borderRadius: "var(--r-2)", fontSize: 12 }}
          >
            {t(`marking.error.${error}`)}
          </p>
        ) : null}

        <p style={{ margin: 0, fontSize: 12, color: "var(--ink-2)" }} data-testid="attendance-tally">
          {t("marking.tally", tally)}
        </p>

        {roster.length === 0 ? (
          <p style={{ fontSize: 13, color: "var(--ink-3)" }}>{t("marking.noTeachers")}</p>
        ) : (
          <form action={saveAttendanceAction} style={{ display: "grid", gap: 12 }}>
            <input type="hidden" name="rttSessionId" value={session.id} />
            <section className="card card-hi">
              <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--line)" }}>
                <h2 style={{ fontWeight: 600, fontSize: 13, margin: 0 }}>{t("marking.rosterTitle", { count: roster.length })}</h2>
                <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>
                  {session.place
                    ? t("marking.rosterIntroPlace", { place: placeLabel(session.place) })
                    : t("marking.rosterIntroWhole")}
                </div>
              </div>
              <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {roster.map((r, i) => (
                  <li
                    key={r.teacherId}
                    data-teacher-id={r.teacherId}
                    style={{ padding: "10px 14px", borderTop: i ? "1px solid var(--line)" : "none" }}
                  >
                    {/* The legend names the teacher for each of her four
                        choices; it has to be the fieldset's first child. */}
                    <fieldset style={{ border: 0, margin: 0, padding: 0, minWidth: 0, display: "grid", gap: 6 }}>
                      <legend style={{ padding: 0 }}>
                        <span style={{ fontWeight: 500, fontSize: 13 }}>{r.fullName}</span>
                        {r.hindiName ? (
                          <span style={{ fontFamily: "var(--deva)", color: "var(--ink-3)", marginLeft: 8, fontSize: 12 }}>
                            {r.hindiName}
                          </span>
                        ) : null}
                        <span style={{ display: "block", fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>
                          {r.schoolName} · {r.zoneName}
                        </span>
                      </legend>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                        {MARKING_ORDER.map((status) => {
                          const chosen = r.status === status;
                          return (
                            <label
                              key={status}
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: 4,
                                padding: "5px 9px",
                                minHeight: 32,
                                borderRadius: 999,
                                border: "1px solid var(--line-2)",
                                background: chosen ? CHOSEN[status]!.bg : "var(--card-hi)",
                                color: chosen ? CHOSEN[status]!.ink : "var(--ink-2)",
                                fontSize: 12,
                                cursor: "pointer",
                              }}
                            >
                              <input
                                type="radio"
                                name={`status:${r.teacherId}`}
                                value={status}
                                defaultChecked={chosen}
                              />
                              {t(`attendance.${status}`)}
                            </label>
                          );
                        })}
                      </div>
                      <div style={{ fontSize: 11, color: "var(--ink-3)" }}>
                        {r.status && r.markedAt
                          ? t("marking.markedBy", { name: r.markedBy ?? t("marking.someone"), when: when(r.markedAt) })
                          : t("marking.notMarked")}
                        {r.onRoster ? null : <span className="chip" style={{ marginLeft: 6 }}>{t("marking.offRoster")}</span>}
                      </div>
                    </fieldset>
                  </li>
                ))}
              </ul>
            </section>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
              <SubmitButton name="intent" value="save" className="btn btn-primary">
                {t("marking.save")}
              </SubmitButton>
              <SubmitButton name="intent" value="all_present" className="btn">
                {t("marking.allPresent")}
              </SubmitButton>
              <span style={{ fontSize: 11, color: "var(--ink-3)", flex: "1 1 200px" }}>{t("marking.allPresentHint")}</span>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
