// /repo/resource/[id] — single reading-material document.
// 1:1 port of `RepoResourcePage` (repository.jsx 1014-1063): header with kind +
// mono id, optional View/External buttons, "About this document" main
// SectionCard and a Details KV sidebar (Kind / Owner / Pages / Updated / Subjects /
// Tags). The "View PDF" button routes to the in-browser viewer shipped in spec 087.

import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { and, eq } from "drizzle-orm";
import { db } from "@gml/db";
import { resources, resourceSubjects, subjects } from "@gml/db/schema";
import { auth } from "@/auth";
import { uuidOrNotFound } from "@/lib/ids";
import { enumLabel, present, repoIntlLocale } from "@/components/repo/repo-i18n";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("repo");
  return { title: t("resource.metaTitle") };
}

export default async function RepoResourceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  // A malformed id names no record: 404, not a Postgres 22P02 and a 500.
  const id = uuidOrNotFound((await params).id);

  const [res] = await db
    .select()
    .from(resources)
    .where(and(eq(resources.id, id), eq(resources.active, true)))
    .limit(1);
  if (!res) notFound();

  const subjectRows = await db
    .select({
      id: subjects.id,
      name: subjects.name,
      color: subjects.color,
    })
    .from(resourceSubjects)
    .leftJoin(subjects, eq(subjects.id, resourceSubjects.subjectId))
    .where(eq(resourceSubjects.resourceId, id));

  const tags: string[] = Array.isArray(res.tags) ? res.tags : [];
  const t = await getTranslations("repo");
  const kindLabel = enumLabel(t, "resourceKind", res.kind);

  const updatedLabel = res.updatedAt
    ? new Date(res.updatedAt).toLocaleDateString(await repoIntlLocale(), {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : "—";
  const subjectCount = subjectRows.length;

  return (
    <div>
      <div className="page-header" style={{ padding: 0, border: 0, marginBottom: 22 }}>
        <Link
          href="/repo/resources"
          className="btn btn-sm btn-ghost"
          style={{ marginBottom: 8, marginLeft: -8, textDecoration: "none" }}
        >
          {t("resource.back")}
        </Link>
        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "space-between",
            gap: 14,
          }}
        >
          <div>
            <div className="label">
              {kindLabel}{" "}
              <span
                className="mono"
                style={{ textTransform: "none", letterSpacing: 0, color: "var(--ink-3)" }}
              >
                · {res.id.slice(0, 8)}
              </span>
            </div>
            <h1 style={{ fontFamily: "var(--serif)", fontSize: 28, marginTop: 4 }}>
              {res.name}
            </h1>
            <p style={{ color: "var(--ink-3)", fontSize: 13, marginTop: 4 }}>
              {t.rich("resource.summary", {
                hasPages: present(res.pages),
                pages: res.pages ?? 0,
                hasOwner: present(res.owner),
                owner: res.owner ?? "",
                updated: updatedLabel,
                mono: (chunks) => <span className="mono">{chunks}</span>,
              })}
            </p>
          </div>

          {/*
            Spec 119 (frontend-parity Tier H) ratifies the "View PDF" CTA
            shipped by spec 087: the JSX prototype labelled this "Download
            PDF", which is misleading — anti-download is part of the SM-4
            deterrence contract. The link must point at the in-browser
            viewer at /repo/resource/<id>/view (watermark + audit + signed
            URL); no path here should advertise a download.
          */}
          <div style={{ display: "flex", gap: 6 }}>
            {res.fileKey ? (
              <Link
                href={`/repo/resource/${res.id}/view`}
                className="btn btn-primary"
                style={{ textDecoration: "none" }}
              >
                {t("resource.viewPdf")}
              </Link>
            ) : null}
            {res.externalUrl ? (
              <a
                href={res.externalUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="btn"
                style={{ textDecoration: "none" }}
              >
                {t("resource.external")}
              </a>
            ) : null}
          </div>
        </div>
      </div>

      {/* One column below 768 px, 1.6fr 1fr above. This was an inline
          "1.6fr 1fr", which holds at every width, so on a phone the two
          columns stayed side by side and the page scrolled sideways. */}
      <section
        className="page-body grid grid-cols-1 gap-[18px] md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]"
        style={{ padding: 0 }}
      >
        <SectionCard title={t("resource.aboutTitle")}>
          <div
            style={{
              padding: "8px 18px 16px",
              fontSize: 13.5,
              lineHeight: 1.6,
              color: "var(--ink-2)",
            }}
          >
            <p>
              {t("resource.about", {
                kind: kindLabel,
                hasOwner: present(res.owner),
                owner: res.owner ?? "",
                count: subjectCount,
              })}
            </p>
            <p style={{ color: "var(--ink-3)", fontSize: 12, fontStyle: "italic" }}>
              {t("resource.previewNote")}
            </p>
          </div>
        </SectionCard>

        <div style={{ display: "grid", gap: 16, alignContent: "start" }}>
          <SectionCard title={t("common.details")}>
            <div style={{ padding: "0 14px 8px" }}>
              <KVRow label={t("common.kind")}>
                <Chip>{kindLabel}</Chip>
              </KVRow>
              <KVRow label={t("common.owner")}>
                {res.owner ?? <span style={{ color: "var(--ink-4)" }}>—</span>}
              </KVRow>
              <KVRow label={t("common.pages")}>
                {res.pages ?? <span style={{ color: "var(--ink-4)" }}>—</span>}
              </KVRow>
              <KVRow label={t("common.updated")}>
                <span style={{ fontFamily: "var(--mono)" }}>{updatedLabel}</span>
              </KVRow>
              <KVRow label={t("common.subjects")}>
                {subjectRows.length === 0 ? (
                  <span style={{ color: "var(--ink-4)" }}>—</span>
                ) : (
                  subjectRows.map((s) =>
                    s.id ? (
                      <RelLink key={s.id} href={`/repo/subject/${s.id}`} color={s.color}>
                        {s.name ?? "—"}
                      </RelLink>
                    ) : null,
                  )
                )}
              </KVRow>
              <KVRow label={t("resource.tags")}>
                {tags.length === 0 ? (
                  <span style={{ color: "var(--ink-4)" }}>—</span>
                ) : (
                  tags.map((tag) => <Chip key={tag}>{tag}</Chip>)
                )}
              </KVRow>
            </div>
          </SectionCard>
        </div>
      </section>
    </div>
  );
}

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="card card-hi" style={{ overflow: "hidden" }}>
      <header
        className="serif"
        style={{
          padding: "10px 18px",
          borderBottom: "1px solid var(--line)",
          background: "var(--card)",
          fontSize: 15,
          fontWeight: 500,
        }}
      >
        {title}
      </header>
      {children}
    </section>
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
      <span className="label" style={{ paddingTop: 2 }}>
        {label}
      </span>
      <div
        style={{
          fontSize: 13,
          display: "flex",
          flexWrap: "wrap",
          gap: 4,
          alignItems: "center",
        }}
      >
        {children}
      </div>
    </div>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return <span className="chip">{children}</span>;
}

function RelLink({
  href,
  color,
  children,
}: {
  href: string;
  color?: string | null;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="chip"
      style={{
        background: "var(--card)",
        color: "var(--ink)",
        borderColor: color ?? undefined,
        textDecoration: "none",
      }}
    >
      {color ? (
        <span
          aria-hidden
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: color,
            border: "1px solid var(--line-2)",
          }}
        />
      ) : null}
      {children}
    </Link>
  );
}
