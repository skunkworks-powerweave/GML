// /rtt/online/asynchronous — async hub of pre-recorded lectures, external embeds,
// and microlearning. Pulls two streams:
//   1) resources WHERE external_url IS NOT NULL  (kind ∈ Guide/Handbook/Worksheet/…)
//   2) video_submissions WHERE source ∈ ('external_link','google_drive')
//
// Filter by RTT subject via ?subject=<id>. Filtering is best-effort: the schema
// has no formal join between rtt_subjects and resources/videos, so we string-match
// the RTT subject name against resources.tags (JSONB) and video_submissions.caption_raw.
// See specs/065-rtt-online-asynchronous/spec.md for the rationale.

import { redirect } from "next/navigation";
import Link from "next/link";
import { and, asc, desc, eq, inArray, isNotNull, or } from "drizzle-orm";
import { db } from "@gml/db";
import { resources, rttSubjects, videoSubmissions } from "@gml/db/schema";
import { auth } from "@/auth";

export const dynamic = "force-dynamic";

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
};

export default async function RttOnlineAsynchronousPage({
  searchParams,
}: {
  searchParams: Promise<{ subject?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const sp = await searchParams;
  const selectedSubjectId = sp.subject?.trim() || null;

  // Tab strip: every active RTT subject.
  const subjectRows = await db
    .select({
      id: rttSubjects.id,
      name: rttSubjects.name,
      code: rttSubjects.code,
    })
    .from(rttSubjects)
    .where(eq(rttSubjects.active, true))
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
      subtitle: r.owner ?? "external resource",
      badge: r.kind,
      badgeBg: "var(--paper-2)",
      badgeInk: "var(--ink-2)",
      durationLabel: null,
      createdAt: r.updatedAt ?? r.createdAt ?? null,
    })),
    ...filteredVideos.map<CardItem>((v) => {
      const minutes = v.durationSec ? Math.max(1, Math.round(v.durationSec / 60)) : null;
      const sourceLabel = v.source === "google_drive" ? "Drive" : "External link";
      return {
        cardKey: `v:${v.id}`,
        href: `/videos/${v.id}`,
        hrefExternal: false,
        title: v.captionRaw?.slice(0, 80) || `${v.contextType.replace(/_/g, " ")} video`,
        subtitle: sourceLabel,
        badge: "Video",
        badgeBg: "var(--indigo-soft)",
        badgeInk: "var(--indigo)",
        durationLabel: minutes ? `${minutes} min` : null,
        createdAt: v.createdAt ?? null,
      };
    }),
  ]
    .sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0))
    .slice(0, 60);

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
          RTT · Online · Asynchronous
        </div>
        <h1 style={{ fontFamily: "var(--serif)", fontSize: 28, marginTop: 4 }}>
          Watch &amp; read at your own pace
        </h1>
        <p style={{ color: "var(--ink-3)", fontSize: 13, marginTop: 4, maxWidth: 600 }}>
          Pre-recorded lectures, microlearning videos, and reading guides linked from
          YouTube, Google Drive and Facebook. Filter by RTT subject to narrow the grid.
          {totalAvailable > 0 ? (
            <span style={{ marginLeft: 6, color: "var(--ink-4)", fontFamily: "var(--mono)", fontSize: 11 }}>
              {totalAvailable} items indexed
            </span>
          ) : null}
        </p>
      </header>

      {/* Subject tab strip */}
      <nav
        aria-label="Filter by RTT subject"
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
          label="All"
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

      {/* 3-column card grid */}
      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
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
              No async content yet
              {selectedSubject ? <> for <strong style={{ color: "var(--ink-2)" }}>{selectedSubject.name}</strong></> : ""}.
            </div>
            <div style={{ fontSize: 11, color: "var(--ink-4)" }}>
              Programme admins can attach external videos or PDFs from{" "}
              <Link href="/admin/resources" style={{ color: "var(--indigo)" }}>
                /admin/resources
              </Link>
              .
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
          {item.createdAt ? (
            <>
              {" · "}
              <span style={{ fontFamily: "var(--mono)" }}>
                {item.createdAt.toLocaleDateString("en-IN", { day: "numeric", month: "short" })}
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
