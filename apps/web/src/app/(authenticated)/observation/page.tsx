// /observation — Classroom Observation cycles list.
// Filter by kind (baseline | developmental | evaluative) and status — both
// reach the DB via URL searchParams so the filtered view is bookmarkable.
//
// Spec 129 (Workflow Run 11 frontend-parity closure): port the filter strip
// from LMS GML Frontend/observation-list.jsx:41-65 into the live Next page.
// Before this spec the page had zero filter UI and just dumped the latest
// 80 cycles; now the filter chips submit GET against the same URL so the
// WHERE clause runs in Postgres, not over an already-fetched mock array.

import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { db } from "@gml/db";
import { observationCycles } from "@gml/db/schema";
import { auth } from "@/auth";
import { actorFrom, cycleVisibilityFilter } from "@/lib/authz";
import { listCycles, parsePage, videoCell, type VideoCell } from "@/lib/observation/list";
import { INTL_LOCALE, normalizeLocale } from "@/i18n/config";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("observation");
  return { title: t("list.metaTitle") };
}

const KIND_CHIP: Record<string, string> = {
  baseline: "",
  developmental: "chip-indigo",
  evaluative: "chip-saffron",
};

const CYCLE_STAGES = ["nominated", "pre_submitted", "observed", "post_submitted", "complete"] as const;

const STATUS_VALUES = new Set([
  "nominated",
  "pre_submitted",
  "observed",
  "post_submitted",
  "complete",
]);

const KIND_VALUES = new Set(["baseline", "developmental", "evaluative"]);

// The chips' words are list.statusTabs.<v> and list.kindTabs.<v>.
const STATUS_TABS = ["all", ...CYCLE_STAGES] as const;

const KIND_TABS = ["all", "baseline", "developmental", "evaluative"] as const;

type SearchParams = Promise<{ status?: string; kind?: string; page?: string }>;

// A chip link carries no page, so changing a filter starts again at page 1;
// the pager passes one and keeps the filters.
function buildHref(status: string, kind: string, page = 1): string {
  const qs = new URLSearchParams();
  if (status !== "all") qs.set("status", status);
  if (kind !== "all") qs.set("kind", kind);
  if (page > 1) qs.set("page", String(page));
  const s = qs.toString();
  return s ? `/observation?${s}` : "/observation";
}

export default async function ObservationListPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const sp = await searchParams;
  const t = await getTranslations("observation");
  const intl = INTL_LOCALE[normalizeLocale(await getLocale())];
  const statusFilter = STATUS_VALUES.has(sp.status ?? "") ? sp.status! : "all";
  const kindFilter = KIND_VALUES.has(sp.kind ?? "") ? sp.kind! : "all";

  // OWNERSHIP, BEFORE ANYTHING ELSE.
  //
  // This page previously built its WHERE from the filter chips alone, so with
  // no chip selected it served the 80 most recent cycles IN THE PROGRAMME to
  // whoever asked. The section gate does not prevent that: the gate is one
  // shared rotatable password, and a teacher is given it precisely so she can
  // open her OWN cycle. Having entered, she was shown every other teacher's
  // name and Hindi name, their subject and lesson topic, whether their cycle
  // was 'evaluative', its stage, and its real UUID -- the last being the
  // enumeration signal that assertCanAccessCycle's notFound()-over-403 choice
  // exists to suppress.
  //
  // The detail page at the far end of every one of those links was already
  // guarded. The list was missed.
  const session = await auth();
  const actor = actorFrom(session);
  if (!actor) redirect("/login");
  const visibility = await cycleVisibilityFilter(actor);

  // WHERE A CYCLE COMES FROM. Nothing in this module creates one -- the four
  // stages only ever UPDATE a cycle. The only INSERT in the repository was the
  // demo seed, and purge_demo_data.ts removes those rows at hand-over, so on a
  // real deployment this list starts empty. Cycles are nominated at
  // /observation/new (pickers, code minted for you) or bulk-loaded through the
  // admin grid (admin/entities/observation-cycles.ts).
  const canNominate = actor.role === "programme_admin" || actor.role === "super_admin";

  // Build the WHERE clause server-side — only emit predicates for filters
  // the user actively chose. The visibility predicate is NOT one of them: it
  // is unconditional and cannot be cleared by removing a chip.
  const conds: SQL[] = [];
  if (visibility) conds.push(visibility);
  if (statusFilter !== "all") {
    conds.push(eq(observationCycles.status, statusFilter as (typeof CYCLE_STAGES)[number]));
  }
  if (kindFilter !== "all") {
    const kindValue = kindFilter as "baseline" | "developmental" | "evaluative";
    conds.push(eq(observationCycles.kind, kindValue));
  }

  // ONE PAGE OF EVERYTHING VISIBLE, not the first 80. The row query was capped
  // at 80 with no page parameter while the chips below counted every visible
  // cycle, so past 80 the table silently held less than the chips promised
  // and the rest could not be reached. lib/observation/list.ts pages with a
  // total order, and the table says what range it is showing. `page` is the
  // page actually shown: a stale ?page= past the end becomes the last page.
  const { rows, total, from, to, hasNext, page } = await listCycles(db, {
    where: conds.length === 0 ? undefined : and(...conds),
    page: parsePage(sp.page),
  });

  // Per-tab counts run as a single GROUP BY so the chips can show the
  // current totals even when a filter is active. One extra round-trip.
  //
  // BOTH aggregates carry the visibility predicate. They previously had no
  // WHERE at all, so even with the row query scoped the chips would still have
  // published programme-wide totals per status and per kind -- a smaller leak
  // than the rows, but the same one. /videos had to correct exactly this half
  // of the fix after the first attempt scoped only the rows.
  const statusCounts = await db
    .select({
      status: observationCycles.status,
      n: sql<number>`count(*)::int`.as("n"),
    })
    .from(observationCycles)
    .where(visibility)
    .groupBy(observationCycles.status);

  const kindCounts = await db
    .select({
      kind: observationCycles.kind,
      n: sql<number>`count(*)::int`.as("n"),
    })
    .from(observationCycles)
    .where(visibility)
    .groupBy(observationCycles.kind);

  const totalRows = statusCounts.reduce((acc, r) => acc + r.n, 0);
  const statusCount = (v: string) =>
    v === "all" ? totalRows : (statusCounts.find((c) => c.status === v)?.n ?? 0);
  const kindCount = (v: string) =>
    v === "all" ? totalRows : (kindCounts.find((c) => c.kind === v)?.n ?? 0);

  return (
    <div>
      <div className="page-header">
        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
          <div>
            <div className="label">{t("sectionLabel")}</div>
            <h1 style={{ fontFamily: "var(--serif)", fontSize: 28, marginTop: 4 }}>{t("list.title")}</h1>
            <p style={{ color: "var(--ink-3)", marginTop: 6 }}>
              {t.rich("list.intro", { b: (chunks) => <b>{chunks}</b> })}
            </p>
          </div>
          {canNominate ? (
            <Link
              href="/observation/new"
              className="btn btn-primary"
              style={{ textDecoration: "none", whiteSpace: "nowrap" }}
            >
              {t("list.nominate")}
            </Link>
          ) : null}
        </div>
      </div>

      {/* PHONE WIDTH. A teacher opens this list on her phone, and at 360 px it
          was 770 px wide: the table had nowhere to scroll but the page, and the
          chip groups could not wrap, so Chrome widened the layout viewport and
          the fixed bottom tab bar left the screen. The column is
          minmax(0, 1fr) because an `auto` track grows to the table's
          min-content width even while the table scrolls inside its card. */}
      <div className="page-body" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 16 }}>
        <div
          className="card"
          style={{ display: "flex", padding: 10, gap: 16, alignItems: "center", flexWrap: "wrap" }}
        >
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {STATUS_TABS.map((v) => {
              const active = statusFilter === v;
              return (
                <Link
                  key={v}
                  href={buildHref(v, kindFilter)}
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
                  {t(`list.statusTabs.${v}`)}
                  <span style={{ opacity: 0.6, marginLeft: 4 }}>{statusCount(v)}</span>
                </Link>
              );
            })}
          </div>
          <div style={{ width: 1, height: 20, background: "var(--line)" }} />
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {KIND_TABS.map((v) => {
              const active = kindFilter === v;
              return (
                <Link
                  key={v}
                  href={buildHref(statusFilter, v)}
                  aria-current={active ? "page" : undefined}
                  className="btn btn-sm"
                  style={{
                    background: active ? "var(--ink-2)" : "transparent",
                    color: active ? "var(--paper)" : "var(--ink-2)",
                    borderColor: active ? "var(--ink-2)" : "transparent",
                    boxShadow: "none",
                    textDecoration: "none",
                  }}
                >
                  {t(`list.kindTabs.${v}`)}
                  <span style={{ opacity: 0.6, marginLeft: 4 }}>{kindCount(v)}</span>
                </Link>
              );
            })}
          </div>
        </div>

        <div className="card">
          {rows.length === 0 ? (
            <div style={{ padding: 32, textAlign: "center", color: "var(--ink-3)" }}>
              {t("list.empty")}
              {canNominate ? (
                <div style={{ fontSize: 12, marginTop: 8 }}>
                  {t.rich("list.emptyNominate", { link: (chunks) => <Link href="/observation/new">{chunks}</Link> })}
                </div>
              ) : null}
            </div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table className="t">
                <thead>
                  <tr>
                    <th>{t("list.columns.cycle")}</th>
                    <th>{t("list.columns.teacher")}</th>
                    <th>{t("list.columns.subjectTopic")}</th>
                    <th>{t("list.columns.kind")}</th>
                    <th>{t("list.columns.stage")}</th>
                    <th>{t("list.columns.date")}</th>
                    <th>{t("list.columns.video")}</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((c) => (
                    <tr key={c.id}>
                      <td className="mono" style={{ fontSize: 11 }}>
                        {/* A way in at the row's left edge: on a phone the '›'
                            in the last column starts off screen. */}
                        <Link href={`/observation/${c.id}`} style={{ color: "var(--ink)" }}>
                          {c.code}
                        </Link>
                      </td>
                      <td>
                        <div style={{ fontWeight: 500 }}>{c.teacherName ?? "—"}</div>
                        {c.teacherHindi ? (
                          <div className="deva" style={{ fontSize: 11, color: "var(--ink-3)", fontFamily: "var(--deva)" }}>
                            {c.teacherHindi}
                          </div>
                        ) : null}
                      </td>
                      <td>
                        <div>{c.subjectName ?? "—"}</div>
                        {c.topic ? (
                          <div style={{ fontSize: 11, color: "var(--ink-3)" }}>{c.topic}</div>
                        ) : null}
                      </td>
                      <td>
                        <span className={`chip ${KIND_CHIP[c.kind] ?? ""}`}>
                          {t.has(`kindChip.${c.kind}`) ? t(`kindChip.${c.kind}`) : c.kind}
                        </span>
                      </td>
                      <td>
                        <CycleStage
                          status={c.status}
                          label={t.has(`list.stage.${c.status}`) ? t(`list.stage.${c.status}`) : c.status.replace("_", " ")}
                        />
                      </td>
                      <td className="mono" style={{ fontSize: 12 }}>
                        {c.scheduledAt
                          ? new Date(c.scheduledAt).toLocaleDateString(intl, { day: "numeric", month: "short" })
                          : <span style={{ color: "var(--ink-4)" }}>—</span>}
                      </td>
                      <td>
                        {/* From the cycle's linked videos (lib/observation/list.ts),
                            not video_min, which only the demo seed ever wrote. */}
                        <VideoCellText cell={videoCell(c)} t={t} />
                      </td>
                      <td style={{ textAlign: "right" }}>
                        <Link
                          href={`/observation/${c.id}`}
                          // The code cell's link is the row's one link for a
                          // screen reader and the Tab key; this is its mouse twin.
                          aria-hidden="true"
                          tabIndex={-1}
                          style={{ fontSize: 12, color: "var(--ink-3)", textDecoration: "none" }}
                        >
                          ›
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {total > 0 ? (
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 8,
                padding: "10px 14px",
                borderTop: "1px solid var(--line)",
                fontSize: 12,
                color: "var(--ink-3)",
              }}
            >
              <span>{t("list.showing", { from, to, total })}</span>
              <span style={{ display: "flex", gap: 8 }}>
                {page > 1 ? (
                  <Link href={buildHref(statusFilter, kindFilter, page - 1)} className="btn btn-sm">
                    {t("list.previous")}
                  </Link>
                ) : null}
                {hasNext ? (
                  <Link href={buildHref(statusFilter, kindFilter, page + 1)} className="btn btn-sm">
                    {t("list.next")}
                  </Link>
                ) : null}
              </span>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

type Translate = Awaited<ReturnType<typeof getTranslations>>;

/** The Video cell, in the reader's language ("—" when there is no video). */
function VideoCellText({ cell, t }: { cell: VideoCell; t: Translate }) {
  if (cell === null) return <span style={{ color: "var(--ink-4)" }}>—</span>;
  const words =
    cell.kind === "minutes"
      ? t("list.video.minutes", { minutes: cell.minutes })
      : cell.kind === "videos"
        ? t("list.video.count", { count: cell.count })
        : t("list.video.processing");
  return <span style={{ fontSize: 12 }}>{words}</span>;
}

function CycleStage({ status, label }: { status: string; label: string }) {
  const idx = (CYCLE_STAGES as readonly string[]).indexOf(status);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
      {CYCLE_STAGES.map((s, i) => (
        <div
          key={s}
          style={{
            width: 22,
            height: 5,
            borderRadius: 2,
            background:
              i <= idx
                ? i === CYCLE_STAGES.length - 1 && i <= idx
                  ? "var(--lichen)"
                  : "var(--ink)"
                : "var(--paper-3)",
          }}
        />
      ))}
      <span style={{ marginLeft: 6, fontSize: 11, color: "var(--ink-3)" }}>
        {label}
      </span>
    </div>
  );
}
