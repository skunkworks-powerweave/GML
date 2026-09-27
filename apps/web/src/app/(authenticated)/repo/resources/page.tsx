// /repo/resources — reading-material library index.
// Replaces `window.WIKI.RESOURCES` + `window.wikiLookup.subject()` from
// `repository.jsx` lines 977-1012 with one Drizzle round-trip: resources
// joined to a per-row aggregate of subject names from resource_subjects.
//
// Filter via `?kind=Policy|Guide|Handbook|...` (matches the resources_kind_check
// CHECK constraint). Active filter pill renders with chip-saffron emphasis.
//
// Visuals: page-header + page-body shells, `.card` wraps `table.t` (sticky
// var(--paper-2) header row, var(--line) bottom-border per cell, saffron
// left-border hover). Chips use `.chip` utility for kind pills.

import type { Metadata } from "next";
import { redirect } from "next/navigation";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { and, desc, eq, ilike, sql, type SQL } from "drizzle-orm";
import { db } from "@gml/db";
import { resources, resourceSubjects, subjects } from "@gml/db/schema";
import { auth } from "@/auth";
// Spec 138 — mobile card-list fallback (desktop keeps the table).
import { getDeviceType } from "@/lib/device";
import { MobileRepoCardList } from "@/components/repo/MobileRepoCardList";
import { escapeIlike } from "@gml/shared/sql/ilike";
import { enumLabel, repoIntlLocale } from "@/components/repo/repo-i18n";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("repo");
  return { title: t("resources.metaTitle") };
}

// Kept aligned with `resources_kind_check` CHECK constraint in
// packages/db/src/schema/resources.ts. "Rubric" and "Other" intentionally omitted
// from the filter strip — same pills the JSX prototype shows. These are the
// stored values (and the ?kind= the URL carries); what a pill shows is the
// kind's label, repo.resourceKind.<kind>, in the viewer's language.
const KIND_FILTERS = [
  "Policy",
  "Guide",
  "Handbook",
  "Worksheet",
  "Template",
  "Routine",
  "Calendar",
  "Checklist",
  "Lab-guide",
] as const;
type KindFilter = (typeof KIND_FILTERS)[number];

// Spec 158 — repo-search-bar contract: ?q= name filter, 200-char cap,
// escape ILIKE wildcards so a literal "%" / "_" in the query doesn't
// become a pattern character.
const SEARCH_Q_MAX = 200;

export default async function RepoResourcesIndexPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string; q?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const t = await getTranslations("repo");
  const intl = await repoIntlLocale();
  const kindLabel = (kind: string) => enumLabel(t, "resourceKind", kind);

  const sp = await searchParams;
  const kindFilter: KindFilter | undefined = (KIND_FILTERS as readonly string[]).includes(
    sp.kind ?? "",
  )
    ? (sp.kind as KindFilter)
    : undefined;
  // Spec 158 — name search on resources.name.
  const qRaw = (sp.q ?? "").slice(0, SEARCH_Q_MAX);
  const qFilter = qRaw.trim().length > 0 ? qRaw.trim() : null;

  // One round-trip: resources + per-row jsonb_agg of (id, name) subject pairs.
  // Eval'd per row in Postgres; library is <500 docs in practice so cost is fine.
  const rows = await db
    .select({
      id: resources.id,
      name: resources.name,
      kind: resources.kind,
      owner: resources.owner,
      pages: resources.pages,
      updatedAt: resources.updatedAt,
      subjectsAgg: sql<Array<{ id: string; name: string }>>`(
        SELECT COALESCE(
          jsonb_agg(jsonb_build_object('id', ${subjects.id}, 'name', ${subjects.name})
                    ORDER BY ${subjects.displayOrder}, ${subjects.name}),
          '[]'::jsonb
        )
        FROM ${resourceSubjects}
        LEFT JOIN ${subjects} ON ${subjects.id} = ${resourceSubjects.subjectId}
        WHERE ${resourceSubjects.resourceId} = ${resources.id}
      )`.as("subjects_agg"),
    })
    .from(resources)
    // Spec 158 — combine the existing kind filter with the new ?q= name
    // search via and(...). Empty filters fall through.
    .where(
      (() => {
        const conds: SQL[] = [eq(resources.active, true)];
        if (kindFilter) conds.push(eq(resources.kind, kindFilter));
        if (qFilter) conds.push(ilike(resources.name, `%${escapeIlike(qFilter)}%`));
        return conds.length === 1 ? conds[0] : and(...conds);
      })(),
    )
    .orderBy(desc(resources.updatedAt))
    .limit(200);

  // Counts for the filter strip — one extra round-trip (group-by kind).
  const counts = await db
    .select({
      kind: resources.kind,
      n: sql<number>`COUNT(*)::int`.as("n"),
    })
    .from(resources)
    .where(eq(resources.active, true))
    .groupBy(resources.kind);
  const totalActive = counts.reduce((acc, c) => acc + c.n, 0);
  const countMap = new Map(counts.map((c) => [c.kind, c.n]));

  // Spec 138 — device-aware card/table fork.
  const device = await getDeviceType();

  return (
    <div>
      <div className="page-header">
        <div className="label">{t("common.repository")}</div>
        <h1 style={{ fontFamily: "var(--serif)", fontSize: 28, marginTop: 4 }}>
          {t("resources.title")}
        </h1>
        <p style={{ color: "var(--ink-3)", marginTop: 4 }}>
          {t("resources.intro")}
        </p>
      </div>
      <div className="page-body">
        {/* Spec 158 — name search bar. Inline above the filter pills so it
            sits at the top of the card just like the other repo indexes.
            Preserves the active kind filter via hidden input. */}
        <form
          method="GET"
          action="/repo/resources"
          className="card"
          style={{ padding: 10, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 16 }}
        >
          {kindFilter ? <input type="hidden" name="kind" value={kindFilter} /> : null}
          <label className="label" style={{ paddingLeft: 0, paddingTop: 0 }}>
            {t("common.name")}
            <input
              type="search"
              name="q"
              defaultValue={qFilter ?? ""}
              aria-label={t("resources.searchLabel")}
              title={t("resources.searchLabel")}
              maxLength={SEARCH_Q_MAX}
              className="text"
              style={{ marginLeft: 6, padding: "5px 10px", fontSize: 12, minWidth: 160 }}
            />
          </label>
          <button type="submit" className="btn btn-sm">
            {t("common.search")}
          </button>
          {qFilter ? (
            <Link
              href={kindFilter ? `/repo/resources?kind=${encodeURIComponent(kindFilter)}` : "/repo/resources"}
              className="btn btn-sm"
              style={{ textDecoration: "none" }}
            >
              {t("common.clear")}
            </Link>
          ) : null}
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <span className="chip">{t("common.shown", { count: rows.length })}</span>
          </div>
        </form>
        <section style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
          <FilterPill
            href={qFilter ? `/repo/resources?q=${encodeURIComponent(qFilter)}` : "/repo/resources"}
            active={!kindFilter}
            label={t("common.all")}
            count={totalActive}
          />
          {KIND_FILTERS.map((k) => {
            // Spec 158 — preserve `q` across kind-pill clicks.
            const qs = new URLSearchParams();
            qs.set("kind", k);
            if (qFilter) qs.set("q", qFilter);
            return (
              <FilterPill
                key={k}
                href={`/repo/resources?${qs.toString()}`}
                active={kindFilter === k}
                label={kindLabel(k)}
                count={countMap.get(k) ?? 0}
              />
            );
          })}
        </section>

        {/* Spec 138 — mobile branch: card list. Desktop keeps the table. */}
        {device === "mobile" ? (
          <MobileRepoCardList
            testIdSuffix="resources"
            emptyMessage={t("resources.empty")}
            items={rows.map((r) => {
              const subs = r.subjectsAgg ?? [];
              const subjectLabel =
                subs.length === 0
                  ? "—"
                  : subs
                      .slice(0, 2)
                      .map((s) => s.name)
                      .join(", ") + (subs.length > 2 ? ` +${subs.length - 2}` : "");
              const updatedLabel = r.updatedAt
                ? new Date(r.updatedAt).toLocaleDateString(intl, {
                    day: "numeric",
                    month: "short",
                    year: "numeric",
                  })
                : "—";
              return {
                id: r.id,
                primary: r.name,
                href: `/repo/resource/${r.id}`,
                chip: { label: kindLabel(r.kind), kind: "" },
                secondary: [
                  { label: t("common.subjects"), value: subjectLabel },
                  {
                    value: t("resources.cardMeta", { owner: r.owner ?? "—", pages: r.pages ?? "—" }),
                  },
                  { label: t("common.updated"), value: updatedLabel, mono: true },
                ],
              };
            })}
          />
        ) : null}
        <div className="card" style={device === "mobile" ? { display: "none", overflow: "hidden" } : { overflow: "hidden" }} aria-hidden={device === "mobile"}>
          {rows.length === 0 ? (
            <div style={{ padding: 32, color: "var(--ink-3)", fontSize: 13 }}>
              {t("resources.empty")}
            </div>
          ) : (
            <table className="t">
              <thead>
                <tr>
                  {[
                    t("common.title"),
                    t("common.kind"),
                    t("common.subjects"),
                    t("common.owner"),
                    t("common.pages"),
                    t("common.updated"),
                    "",
                  ].map((h, i) => (
                    <th key={i}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const subs = r.subjectsAgg ?? [];
                  const head = subs.slice(0, 2);
                  const overflow = subs.length - head.length;
                  return (
                    <tr key={r.id}>
                      <td style={{ fontWeight: 500 }}>
                        <Link
                          href={`/repo/resource/${r.id}`}
                          style={{ color: "var(--ink)", textDecoration: "none" }}
                        >
                          {r.name}
                        </Link>
                      </td>
                      <td>
                        <span className="chip">{kindLabel(r.kind)}</span>
                      </td>
                      <td style={{ fontSize: 12 }}>
                        {head.length === 0 ? (
                          <span style={{ color: "var(--ink-4)" }}>—</span>
                        ) : (
                          <>
                            {head.map((s, i) => (
                              <span key={s.id} style={{ color: "var(--ink-3)" }}>
                                {s.name}
                                {i < head.length - 1 ? ", " : ""}
                              </span>
                            ))}
                            {overflow > 0 ? (
                              <span style={{ color: "var(--ink-4)" }}> +{overflow}</span>
                            ) : null}
                          </>
                        )}
                      </td>
                      <td style={{ fontSize: 12 }}>
                        {r.owner ?? <span style={{ color: "var(--ink-4)" }}>—</span>}
                      </td>
                      <td>{r.pages ?? <span style={{ color: "var(--ink-4)" }}>—</span>}</td>
                      <td className="mono" style={{ fontSize: 12 }}>
                        {r.updatedAt
                          ? new Date(r.updatedAt).toLocaleDateString(intl, {
                              day: "numeric",
                              month: "short",
                              year: "numeric",
                            })
                          : "—"}
                      </td>
                      <td style={{ color: "var(--ink-4)", textAlign: "right" }}>
                        <Link href={`/repo/resource/${r.id}`} style={{ color: "var(--ink-4)" }}>
                          ›
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

function FilterPill({
  href,
  active,
  label,
  count,
}: {
  href: string;
  active: boolean;
  label: string;
  count: number;
}) {
  return (
    // The pill that is on said so by hue alone (chip-saffron vs chip, the same
    // lightness): aria-current tells assistive technology, and bold tells
    // everyone else.
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`chip ${active ? "chip-saffron" : ""}`}
      style={{ textDecoration: "none", cursor: "pointer", fontWeight: active ? 600 : undefined }}
    >
      {label} <span style={{ opacity: 0.6, marginLeft: 4 }}>{count}</span>
    </Link>
  );
}
