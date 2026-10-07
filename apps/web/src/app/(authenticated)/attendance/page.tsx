// /attendance — RTT sessions a programme admin takes teachers' attendance at.
//
// rtt_attendance had no screen: a mark was a row typed into the super_admin
// data grid, so a teacher's "Sessions attended" and the staff attendance
// table on /rtt/progress read what almost nobody could write. This lists the
// RTT sessions -- the next ones coming up, the ones just held, and any not
// yet dated, or one day's -- each with how many of its teachers are marked;
// a session opens its roster to mark (./[rttSessionId]). The queries are
// lib/rtt/attendance.ts.
//
// Programme admins and super admins only (the menu's Mark training attendance item).
// Filters are a plain GET form: it works with no JavaScript on a slow link.

import type { Metadata } from "next";
import Link from "next/link";
import { asc } from "drizzle-orm";
import { getLocale, getTranslations } from "next-intl/server";
import { db } from "@gml/db";
import { rttSubjects } from "@gml/db/schema";
import { INTL_LOCALE, type Locale } from "@/i18n/config";
import { requireRole } from "@/lib/guards";
import { isUuid } from "@/lib/ids";
import { listMarkingSessions, parseDay, PROGRAMME_TIME_ZONE, SESSION_LIST_LIMIT, type MarkingSessionRow } from "@/lib/rtt/attendance";
import { placeLabel } from "@/lib/rtt/scope";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("rtt");
  return { title: t("marking.metaTitle") };
}

type Translate = Awaited<ReturnType<typeof getTranslations>>;

/** rtt_sessions.type values with a label under rtt.sessionType. */
const SESSION_TYPES = new Set(["synchronous", "asynchronous", "webinar", "quiz"]);

export default async function AttendancePage({
  searchParams,
}: {
  searchParams: Promise<{ subject?: string; date?: string }>;
}) {
  await requireRole(["programme_admin", "super_admin"]);
  const sp = await searchParams;
  const t = await getTranslations("rtt");
  const intl = INTL_LOCALE[(await getLocale()) as Locale];
  const subjectId = isUuid(sp.subject) ? sp.subject : null;
  const day = parseDay(sp.date);

  const [subjects, groups] = await Promise.all([
    db
      .select({ id: rttSubjects.id, name: rttSubjects.name, active: rttSubjects.active })
      .from(rttSubjects)
      .orderBy(asc(rttSubjects.name)),
    listMarkingSessions(db, { subjectId, date: day }),
  ]);

  const list = (rows: MarkingSessionRow[], empty: string) => <SessionList rows={rows} empty={empty} t={t} intl={intl} />;

  return (
    <div>
      <div className="page-header">
        <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--ink-3)" }}>
          {t("marking.eyebrow")}
        </div>
        <h1 style={{ fontFamily: "var(--serif)", fontSize: 28, marginTop: 4 }}>{t("marking.listTitle")}</h1>
        <p style={{ color: "var(--ink-3)", fontSize: 13, marginTop: 4, maxWidth: 620 }}>{t("marking.intro")}</p>
      </div>
      <div className="page-body" style={{ display: "grid", gap: 16 }}>
        <form
          method="get"
          aria-label={t("marking.filterLabel")}
          style={{ display: "flex", gap: 8, alignItems: "end", flexWrap: "wrap" }}
        >
          <label style={{ display: "grid", gap: 3, fontSize: 11, color: "var(--ink-2)", minWidth: 0, flex: "1 1 200px" }}>
            {t("marking.subject")}
            <select name="subject" defaultValue={subjectId ?? ""} style={{ maxWidth: "100%" }}>
              <option value="">{t("marking.allSubjects")}</option>
              {subjects.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.active ? s.name : t("marking.inactiveSubject", { name: s.name })}
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: "grid", gap: 3, fontSize: 11, color: "var(--ink-2)" }}>
            {t("marking.date")}
            <input type="date" name="date" defaultValue={day ?? ""} />
          </label>
          <button type="submit" className="btn btn-sm">
            {t("marking.show")}
          </button>
          {subjectId || day ? (
            <Link href="/attendance" className="btn btn-sm btn-ghost">
              {t("marking.clear")}
            </Link>
          ) : null}
        </form>

        {groups.kind === "day" ? (
          <section style={{ display: "grid", gap: 8 }}>
            <h2 style={{ fontSize: 14, fontWeight: 600 }}>
              {t("marking.onDate", {
                date: new Date(`${groups.day}T00:00:00Z`).toLocaleDateString(intl, {
                  day: "numeric",
                  month: "long",
                  year: "numeric",
                  timeZone: "UTC",
                }),
              })}
            </h2>
            {list(groups.sessions, t("marking.noneOnDate"))}
          </section>
        ) : (
          <>
            <section style={{ display: "grid", gap: 8 }}>
              <h2 style={{ fontSize: 14, fontWeight: 600 }}>{t("marking.recent")}</h2>
              {list(groups.recent, t("marking.noneRecent"))}
            </section>
            <section style={{ display: "grid", gap: 8 }}>
              <h2 style={{ fontSize: 14, fontWeight: 600 }}>{t("marking.upcoming")}</h2>
              {list(groups.upcoming, t("marking.noneUpcoming"))}
            </section>
            {groups.unscheduled.length > 0 ? (
              <section style={{ display: "grid", gap: 8 }}>
                <h2 style={{ fontSize: 14, fontWeight: 600 }}>{t("marking.unscheduled")}</h2>
                {list(groups.unscheduled, "")}
              </section>
            ) : null}
          </>
        )}
        {groups.more ? (
          <p style={{ fontSize: 12, color: "var(--ink-3)" }}>{t("marking.more", { limit: SESSION_LIST_LIMIT })}</p>
        ) : null}
      </div>
    </div>
  );
}

/** One group of sessions: a card per session, one column at phone width. */
function SessionList({ rows, empty, t, intl }: { rows: MarkingSessionRow[]; empty: string; t: Translate; intl: string }) {
  if (rows.length === 0) {
    return <p style={{ fontSize: 13, color: "var(--ink-3)" }}>{empty}</p>;
  }
  return (
    <ul className="card card-hi" style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {rows.map((s, i) => {
        const complete = s.rosterSize > 0 && s.marked >= s.rosterSize;
        return (
          <li key={s.id} style={{ borderTop: i ? "1px solid var(--line)" : "none" }}>
            <Link
              href={`/attendance/${s.id}`}
              style={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
                padding: "12px 14px",
                color: "var(--ink)",
                textDecoration: "none",
              }}
            >
              <div style={{ minWidth: 0, flex: "1 1 220px" }}>
                <div style={{ fontWeight: 500, fontSize: 13 }}>{s.title}</div>
                <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 3, display: "flex", flexWrap: "wrap", gap: 6 }}>
                  <span>{s.subjectName}</span>
                  <span>· {s.place ? t("subject.onlyIn", { place: placeLabel(s.place) }) : t("placePicker.whole")}</span>
                  {s.type ? <span>· {SESSION_TYPES.has(s.type) ? t(`sessionType.${s.type}`) : s.type}</span> : null}
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span className="mono" style={{ fontSize: 12, color: "var(--ink-2)" }}>
                  {s.scheduledAt
                    ? new Date(s.scheduledAt).toLocaleString(intl, {
                        dateStyle: "medium",
                        timeStyle: "short",
                        timeZone: PROGRAMME_TIME_ZONE,
                      })
                    : t("common.unscheduled")}
                </span>
                <span className={complete ? "chip chip-lichen" : s.marked > 0 ? "chip chip-saffron" : "chip"}>
                  {t("marking.markedOf", { marked: s.marked, total: s.rosterSize })}
                </span>
              </div>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
