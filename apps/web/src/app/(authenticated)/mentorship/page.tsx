// /mentorship — pairings list with quarter chip + status.
//
// Spec 129 (Workflow Run 11 frontend-parity closure): add a server-side
// ?status= filter (active / review / paused / ended / complete). Filter
// chips are <Link>s that round-trip the URL searchParam through Postgres.
// Counts come from a single GROUP BY so the chip totals stay accurate
// even when the visible slice has narrowed.

import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { db } from "@gml/db";
import { mentorPairings, mentors, teachers } from "@gml/db/schema";
import { auth } from "@/auth";
import { actorFrom, pairingVisibilityFilter } from "@/lib/authz";
import { INTL_LOCALE, normalizeLocale } from "@/i18n/config";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("mentorship");
  return { title: t("list.metaTitle") };
}

const STATUS_CHIP: Record<string, string> = {
  active: "chip-lichen",
  review: "chip-saffron",
  paused: "",
  ended: "",
  complete: "chip-indigo",
};

const STATUS_VALUES = new Set(["active", "review", "paused", "ended", "complete"]);

// The chip strip, in order. Each chip's words are mentorship.list.tabs.<v>.
const STATUS_TABS = ["all", "active", "review", "paused", "complete", "ended"] as const;

type PairingStatus = "active" | "review" | "paused" | "ended" | "complete";

type SearchParams = Promise<{ status?: string; page?: string }>;

/**
 * Cards per page. The list used to be one `.limit(80)` with no way past it,
 * while the chips counted everything: at launch scale (about 500 paired
 * teachers) an administrator saw "All 95" over 80 cards and could not reach
 * the rest from the module's own list.
 */
const PAGE_SIZE = 50;

/** /mentorship with this status and page; page 1 and "all" stay out of the URL. */
function listHref(status: string, page: number): string {
  const q = new URLSearchParams();
  if (status !== "all") q.set("status", status);
  if (page > 1) q.set("page", String(page));
  const s = q.toString();
  return s ? `/mentorship?${s}` : "/mentorship";
}

export default async function MentorshipListPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const sp = await searchParams;
  const t = await getTranslations("mentorship");
  const intl = INTL_LOCALE[normalizeLocale(await getLocale())];
  const statusFilter = STATUS_VALUES.has(sp.status ?? "") ? sp.status! : "all";
  let page = Math.min(1000, Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1));

  // OWNERSHIP. The detail page refuses to show a teacher anyone else's
  // pairing (assertCanAccessPairing); this list was showing her all of them --
  // every mentor's name and base location, every mentee's name, meeting counts
  // and last-meeting dates. Same defect as /observation, same cause: the WHERE
  // was built from the filter chip alone.
  const session = await auth();
  const actor = actorFrom(session);
  if (!actor) redirect("/login");
  const visibility = await pairingVisibilityFilter(actor);

  const conds: SQL[] = [];
  if (visibility) conds.push(visibility);
  if (statusFilter !== "all") {
    conds.push(eq(mentorPairings.status, statusFilter as PairingStatus));
  }

  const pageRows = (p: number) =>
    db
      .select({
        id: mentorPairings.id,
        status: mentorPairings.status,
        currentQuarter: mentorPairings.currentQuarter,
        meetingsCount: mentorPairings.meetingsCount,
        lastMeetingAt: mentorPairings.lastMeetingAt,
        startedAt: mentorPairings.startedAt,
        mentorName: mentors.name,
        mentorBase: mentors.baseLocation,
        teacherName: teachers.fullName,
        teacherHindi: teachers.hindiName,
      })
      .from(mentorPairings)
      .leftJoin(mentors, eq(mentorPairings.mentorId, mentors.id))
      .leftJoin(teachers, eq(mentorPairings.teacherId, teachers.id))
      .where(conds.length === 0 ? undefined : and(...conds))
      // id breaks ties: the seed gives every pairing the same started_at, and
      // without a unique tail the pages would not be a partition -- a pairing
      // could appear on two of them, or on none.
      .orderBy(desc(mentorPairings.startedAt), desc(mentorPairings.id))
      // One extra row says whether there is a next page without a second COUNT.
      .limit(PAGE_SIZE + 1)
      .offset((p - 1) * PAGE_SIZE);
  let rowsPlusOne = await pageRows(page);

  // Per-status counts so the filter chips remain truthful regardless of
  // the active filter. One GROUP BY; it also gives the pager its total.
  //
  // Scoped by the same predicate as the rows: an unscoped GROUP BY would keep
  // publishing programme-wide pairing totals even once the rows were fixed.
  const statusCountRows = await db
    .select({
      status: mentorPairings.status,
      n: sql<number>`count(*)::int`.as("n"),
    })
    .from(mentorPairings)
    .where(visibility)
    .groupBy(mentorPairings.status);
  const totalPairings = statusCountRows.reduce((acc, r) => acc + r.n, 0);
  const statusCount = (v: string) =>
    v === "all" ? totalPairings : (statusCountRows.find((r) => r.status === v)?.n ?? 0);
  const filteredTotal = statusCount(statusFilter);

  // PAST THE END IS THE LAST PAGE. A stale ?page= -- a link kept after
  // pairings were removed or changed status -- rendered "Showing 0–950 of 87"
  // and "No pairings match this filter." with a Previous link to another empty
  // page. As /observation does (lib/observation/list.ts); only that case pays
  // a second query.
  const lastPage = Math.max(1, Math.ceil(filteredTotal / PAGE_SIZE));
  if (page > lastPage) {
    page = lastPage;
    rowsPlusOne = await pageRows(page);
  }
  const hasNext = rowsPlusOne.length > PAGE_SIZE;
  const rows = rowsPlusOne.slice(0, PAGE_SIZE);
  const firstShown = rows.length === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const lastShown = rows.length === 0 ? 0 : (page - 1) * PAGE_SIZE + rows.length;

  return (
    <div>
      <div className="page-header">
        <div className="label">{t("list.eyebrow")}</div>
        <h1 style={{ fontFamily: "var(--serif)", fontSize: 28, marginTop: 4 }}>{t("list.title")}</h1>
        <p style={{ color: "var(--ink-3)", fontSize: 13, marginTop: 4 }}>
          {t("list.intro")}
        </p>
      </div>

      <div className="page-body" style={{ display: "grid", gap: 16 }}>
        <div
          className="card"
          style={{ padding: 10, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}
        >
          <span className="label" style={{ paddingLeft: 0, paddingTop: 0 }}>{t("list.statusLabel")}</span>
          {STATUS_TABS.map((v) => {
            const active = statusFilter === v;
            // A chip starts its filter at page 1.
            const href = listHref(v, 1);
            return (
              <Link
                key={v}
                href={href}
                // The chip that is on was marked by its fill alone; a screen
                // reader could not tell which status the list was showing.
                aria-current={active ? "page" : undefined}
                className="btn btn-sm"
                style={{
                  background: active ? "var(--ink)" : "transparent",
                  color: active ? "var(--paper)" : "var(--ink-2)",
                  borderColor: active ? "var(--ink)" : "transparent",
                  boxShadow: "none",
                  textDecoration: "none",
                }}
              >
                {t(`list.tabs.${v}`)}
                <span style={{ opacity: 0.6, marginLeft: 4 }}>{statusCount(v)}</span>
              </Link>
            );
          })}
        </div>
        <section
          style={{
            display: "grid",
            // min(100%, ...): a 320 px minimum is wider than a phone's content
            // box, so each card overflowed it and the page scrolled sideways.
            gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 320px), 1fr))",
            gap: 14,
          }}
        >
          {rows.length === 0 ? (
            <div style={{ padding: 32, color: "var(--ink-3)" }}>{t("list.empty")}</div>
          ) : (
            rows.map((p) => {
              const chipKind = STATUS_CHIP[p.status] ?? "";
              return (
                <Link
                  key={p.id}
                  href={`/mentorship/${p.id}`}
                  className="card card-hi"
                  style={{
                    padding: 16,
                    textDecoration: "none",
                    color: "var(--ink)",
                    display: "flex",
                    flexDirection: "column",
                    gap: 10,
                  }}
                >
                  <header style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
                    <div>
                      <div className="label" style={{ letterSpacing: "0.05em" }}>
                        {p.mentorName ?? "—"} {p.mentorBase ? `· ${p.mentorBase}` : ""}
                      </div>
                      <div style={{ fontWeight: 500, marginTop: 4 }}>
                        {p.teacherName ?? "—"}
                        {p.teacherHindi ? (
                          <span style={{ fontFamily: "var(--deva)", color: "var(--ink-3)", marginLeft: 8, fontSize: 13 }}>
                            {p.teacherHindi}
                          </span>
                        ) : null}
                      </div>
                    </div>
                    <span className={`chip ${chipKind}`.trim()}>{t("pairingStatus", { status: p.status })}</span>
                  </header>

                  <div className="mono" style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: "var(--ink-3)" }}>
                    <span className="chip">Q{p.currentQuarter ?? 1}</span>
                    <span>{t("list.meetings", { count: p.meetingsCount ?? 0 })}</span>
                    {p.lastMeetingAt ? (
                      <span>
                        {t("list.lastMeeting", {
                          date: new Date(p.lastMeetingAt).toLocaleDateString(intl, { day: "numeric", month: "short" }),
                        })}
                      </span>
                    ) : null}
                  </div>
                </Link>
              );
            })
          )}
        </section>

        {filteredTotal > 0 ? (
          <nav
            aria-label={t("list.pagesLabel")}
            style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 12, color: "var(--ink-3)" }}
          >
            <span data-testid="pairings-range">
              {t("list.range", { first: firstShown, last: lastShown, total: filteredTotal })}
            </span>
            {page > 1 ? (
              <Link href={listHref(statusFilter, page - 1)} className="btn btn-sm" style={{ textDecoration: "none" }}>
                {t("list.previous")}
              </Link>
            ) : null}
            {hasNext ? (
              <Link href={listHref(statusFilter, page + 1)} className="btn btn-sm" style={{ textDecoration: "none" }}>
                {t("list.next")}
              </Link>
            ) : null}
          </nav>
        ) : null}
      </div>
    </div>
  );
}
