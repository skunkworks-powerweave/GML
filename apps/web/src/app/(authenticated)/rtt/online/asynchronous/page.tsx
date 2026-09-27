// /rtt/online/asynchronous — async hub of pre-recorded lectures, external embeds,
// and microlearning. Pulls two streams:
//   1) resources WHERE external_url IS NOT NULL  (kind ∈ Guide/Handbook/Worksheet/…)
//   2) video_submissions WHERE source ∈ ('external_link','google_drive')
//
// Filter by RTT subject via ?subject=<id>. Filtering is best-effort: the schema
// has no formal join between rtt_subjects and resources/videos, so we string-match
// the RTT subject name against resources.tags (JSONB) and video_submissions.caption_raw.
// See specs/065-rtt-online-asynchronous/spec.md for the rationale.

import type { Metadata } from "next";
import { redirect } from "next/navigation";
import Link from "next/link";
import { and, asc, desc, eq, inArray, isNotNull, or } from "drizzle-orm";
import { getLocale, getTranslations } from "next-intl/server";
import { db } from "@gml/db";
import { resources, rttSubjects, videoSubmissions } from "@gml/db/schema";
import { auth } from "@/auth";
import { INTL_LOCALE, type Locale } from "@/i18n/config";
import { rttScope } from "@/lib/rtt/scope";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("rtt");
  return { title: t("async.metaTitle") };
}

// Resource kinds suitable for the async hub (everything that reads like
// "microlearning material" — excludes Policy / Calendar / Routine / Rubric).
const ASYNC_RESOURCE_KINDS = [
  "Guide",
  "Handbook",
  "Worksheet",
  "Template",
  "Lab-guide",
  "Other",
] as const;

/** A resource kind above -> its label's key under rtt.async.kind. */
const KIND_KEYS: Record<string, string> = {
  Guide: "guide",
  Handbook: "handbook",
  Worksheet: "worksheet",
  Template: "template",
  "Lab-guide": "labGuide",
  Other: "other",
};

type CardItem = {
  cardKey: string;
  href: string;
  hrefExternal: boolean;
  title: string;
  subtitle: string;
  badge: string;
  badgeBg: string;
  badgeInk: string;
  durationLabel: string | null;
  createdAt: Date | null;
  /** createdAt as the viewer reads a date. */
  dateLabel: string | null;
};

export default async function RttOnlineAsynchronousPage({
  searchParams,
}: {
  searchParams: Promise<{ subject?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const t = await getTranslations("rtt");
  const intl = INTL_LOCALE[(await getLocale()) as Locale];

  const sp = await searchParams;
  const selectedSubjectId = sp.subject?.trim() || null;

  // Tab strip: every active RTT subject the viewer is shown -- for a teacher,
  // those of her own district and zone (lib/rtt/scope.ts).
  const scope = await rttScope(db, { id: session.user.id, role: session.user.role });
  const subjectRows = await db
    .select({
      id: rttSubjects.id,
      name: rttSubjects.name,
      code: rttSubjects.code,
    })
    .from(rttSubjects)
    .where(and(eq(rttSubjects.active, true), scope.subjectWhere))
    .orderBy(asc(rttSubjects.name));

  const selectedSubject =
    selectedSubjectId != null
      ? subjectRows.find((s) => s.id === selectedSubjectId) ?? null
      : null;

  // Stream 1 — resources with external URLs.
  const resourceRowsAll = await db
    .select({
      id: resources.id,
      name: resources.name,
      kind: resources.kind,
      owner: resources.owner,
      externalUrl: resources.externalUrl,
      tags: resources.tags,
      updatedAt: resources.updatedAt,
      createdAt: resources.createdAt,
    })
    .from(resources)
    .where(
      and(
        eq(resources.active, true),
        isNotNull(resources.externalUrl),
        inArray(resources.kind, ASYNC_RESOURCE_KINDS as unknown as string[]),
      ),
    )
    .orderBy(desc(resources.updatedAt))
    .limit(120);

  const filteredResources = selectedSubject
    ? resourceRowsAll.filter((r) =>
        Array.isArray(r.tags) ? r.tags.some((t) => normalize(t) === normalize(selectedSubject.name)) : false,
      )
    : resourceRowsAll;

  // Stream 2 — external-link / google-drive video submissions.
  const videoRowsAll = await db
    .select({
      id: videoSubmissions.id,
      source: videoSubmissions.source,
      externalUrl: videoSubmissions.externalUrl,
      durationSec: videoSubmissions.durationSec,
      contextType: videoSubmissions.contextType,
      captionRaw: videoSubmissions.captionRaw,
      createdAt: videoSubmissions.createdAt,
    })
    .from(videoSubmissions)
    .where(
      or(
        eq(videoSubmissions.source, "external_link"),
        eq(videoSubmissions.source, "google_drive"),
      ),
    )
    .orderBy(desc(videoSubmissions.createdAt))
    .limit(120);

  const filteredVideos = selectedSubject
    ? videoRowsAll.filter((v) =>
        v.captionRaw ? v.captionRaw.toLowerCase().includes(selectedSubject.name.toLowerCase()) : false,
      )
    : videoRowsAll;

  // Build a unified card stream, capped at 60.
  const cards: CardItem[] = [
    ...filteredResources.map<CardItem>((r) => ({
      cardKey: `r:${r.id}`,
      href: r.externalUrl ?? "#",
      hrefExternal: true,
      title: r.name,
      subtitle: r.owner ?? t("async.externalResource"),
      badge: KIND_KEYS[r.kind] ? t(`async.kind.${KIND_KEYS[r.kind]}`) : r.kind,
      badgeBg: "var(--paper-2)",
      badgeInk: "var(--ink-2)",
      durationLabel: null,
      createdAt: r.updatedAt ?? r.createdAt ?? null,
      dateLabel: null,
    })),
    ...filteredVideos.map<CardItem>((v) => {
      const minutes = v.durationSec ? Math.max(1, Math.round(v.durationSec / 60)) : null;
      const sourceLabel = v.source === "google_drive" ? t("async.drive") : t("common.externalLink");
      return {
        cardKey: `v:${v.id}`,
        href: `/videos/${v.id}`,
        hrefExternal: false,
        title: v.captionRaw?.slice(0, 80) || t("async.videoTitle", { context: v.contextType }),
        subtitle: sourceLabel,
        badge: t("async.video"),
        badgeBg: "var(--indigo-soft)",
        badgeInk: "var(--indigo)",
        durationLabel: minutes ? t("common.minutes", { minutes }) : null,
        createdAt: v.createdAt ?? null,
        dateLabel: null,
      };
    }),
  ]
    .sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0))
    .slice(0, 60)
    .map((c) => ({ ...c, dateLabel: c.createdAt ? c.createdAt.toLocaleDateString(intl, { day: "numeric", month: "short" }) : null }));

  const totalAvailable = resourceRowsAll.length + videoRowsAll.length;

  return (
    <div>
      <header style={{ marginBottom: 22 }}>
        <div
          style={{
            fontSize: 10,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            color: "var(--ink-3)",
          }}
        >
          {t("async.eyebrow")}
        </div>
        <h1 style={{ fontFamily: "var(--serif)", fontSize: 28, marginTop: 4 }}>
          {t("async.title")}
        </h1>
        <p style={{ color: "var(--ink-3)", fontSize: 13, marginTop: 4, maxWidth: 600 }}>
          {t("async.intro")}
          {totalAvailable > 0 ? (
            <span style={{ marginLeft: 6, color: "var(--ink-4)", fontFamily: "var(--mono)", fontSize: 11 }}>
              {t("async.indexed", { count: totalAvailable })}
            </span>
          ) : null}
        </p>
      </header>

      {/* Subject tab strip */}
      <nav
        aria-label={t("async.filterLabel")}
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 6,
          marginBottom: 18,
          paddingBottom: 12,
          borderBottom: "1px solid var(--hairline)",
        }}
      >
        <SubjectPill
          href="/rtt/online/asynchronous"
          label={t("common.all")}
          active={selectedSubject == null}
        />
        {subjectRows.map((s) => (
          <SubjectPill
            key={s.id}
            href={`/rtt/online/asynchronous?subject=${encodeURIComponent(s.id)}`}
            label={s.name}
            active={selectedSubject?.id === s.id}
          />
        ))}
      </nav>

      {/* 3-column card grid. The minimum is min(100%, 280px), not 280px, so a
          card never demands more width than the column it sits in: a fixed
          280 px minimum overflows any column narrower than that (a small
          phone, or this page inside the usual page padding) and widens the
          page (F11). */}
      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 280px), 1fr))",
          gap: 14,
        }}
      >
        {cards.length === 0 ? (
          <div
            style={{
              gridColumn: "1 / -1",
              padding: "32px 16px",
              background: "var(--card)",
              border: "1px dashed var(--line)",
              borderRadius: "var(--r-3)",
              color: "var(--ink-3)",
              fontSize: 13,
              textAlign: "center",
            }}
          >
            <div style={{ marginBottom: 6 }}>
              {selectedSubject
                ? t.rich("async.emptyFor", {
                    subject: selectedSubject.name,
                    strong: (chunks) => <strong style={{ color: "var(--ink-2)" }}>{chunks}</strong>,
                  })
                : t("async.empty")}
            </div>
            <div style={{ fontSize: 11, color: "var(--ink-4)" }}>
              {t.rich("async.emptyHint", {
                link: (chunks) => (
                  <Link href="/admin/data/resources" style={{ color: "var(--indigo)" }}>
                    {chunks}
                  </Link>
                ),
              })}
            </div>
          </div>
        ) : (
          cards.map((c) => <Card key={c.cardKey} item={c} />)
        )}
      </section>
    </div>
  );
}

function SubjectPill({
  href,
  label,
  active,
}: {
  href: string;
  label: string;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      // The pill that is on was shown by its fill alone; a screen reader could
      // not tell which subject the grid was filtered to (F135).
      aria-current={active ? "page" : undefined}
      style={{
        padding: "6px 12px",
        background: active ? "var(--ink)" : "transparent",
        color: active ? "var(--paper)" : "var(--ink-2)",
        border: `1px solid ${active ? "var(--ink)" : "var(--line)"}`,
        borderRadius: "var(--r-2)",
        fontSize: 12,
        textDecoration: "none",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </Link>
  );
}

function Card({ item }: { item: CardItem }) {
  const linkProps = item.hrefExternal
    ? { href: item.href, target: "_blank" as const, rel: "noopener noreferrer" }
    : { href: item.href };

  return (
    <Link
      {...linkProps}
      style={{
        background: "var(--card-hi)",
        border: "1px solid var(--line)",
        borderRadius: "var(--r-3)",
        textDecoration: "none",
        color: "var(--ink)",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Thumbnail placeholder (16:9) with centered play glyph */}
      <div
        aria-hidden
        style={{
          aspectRatio: "16 / 9",
          background: "var(--paper-2)",
          position: "relative",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <span
          style={{
            width: 44,
            height: 44,
            borderRadius: 999,
            background: "rgba(28, 24, 22, 0.55)",
            color: "var(--paper)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 16,
            paddingLeft: 3,
          }}
        >
          ▶
        </span>
        <span
          style={{
            position: "absolute",
            top: 8,
            right: 8,
            padding: "2px 8px",
            background: item.badgeBg,
            color: item.badgeInk,
            borderRadius: 999,
            fontSize: 10,
            textTransform: "uppercase",
            letterSpacing: "0.05em",
            fontWeight: 600,
          }}
        >
          {item.badge}
        </span>
        {item.durationLabel ? (
          <span
            style={{
              position: "absolute",
              bottom: 8,
              right: 8,
              padding: "2px 6px",
              background: "rgba(28, 24, 22, 0.7)",
              color: "var(--paper)",
              fontFamily: "var(--mono)",
              fontSize: 10,
              borderRadius: "var(--r-1)",
            }}
          >
            {item.durationLabel}
          </span>
        ) : null}
      </div>

      <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 4 }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 500,
            lineHeight: 1.35,
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
        >
          {item.title}
        </div>
        <div style={{ fontSize: 11, color: "var(--ink-3)" }}>
          {item.subtitle}
          {item.dateLabel ? (
            <>
              {" · "}
              <span style={{ fontFamily: "var(--mono)" }}>
                {item.dateLabel}
              </span>
            </>
          ) : null}
        </div>
      </div>
    </Link>
  );
}

function normalize(s: string): string {
  return s.trim().toLowerCase();
}
