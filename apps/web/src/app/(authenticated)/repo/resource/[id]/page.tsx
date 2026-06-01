// /repo/resource/[id] — single reading-material document.
// 1:1 port of `RepoResourcePage` (repository.jsx 1014-1063): header with kind +
// mono id, optional View/External buttons, "About this document" main
// SectionCard and a Details KV sidebar (Kind / Owner / Pages / Updated / Subjects /
// Tags). The "View PDF" button routes to the in-browser viewer shipped in spec 087.

import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { and, eq } from "drizzle-orm";
import { db } from "@gml/db";
import { resources, resourceSubjects, subjects } from "@gml/db/schema";
import { auth } from "@/auth";

export const dynamic = "force-dynamic";

export default async function RepoResourceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const { id } = await params;

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

  const updatedLabel = res.updatedAt
    ? new Date(res.updatedAt).toLocaleDateString("en-IN", {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : "—";
  const subjectCount = subjectRows.length;

  return (
    <div>
      <header style={{ marginBottom: 22 }}>
        <Link
          href="/repo/resources"
          style={{ fontSize: 12, color: "var(--ink-3)", textDecoration: "none" }}
        >
          ← Reading material
        </Link>
        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "space-between",
            gap: 14,
            marginTop: 8,
          }}
        >
          <div>
            <div
              style={{
                fontSize: 10,
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                color: "var(--ink-3)",
              }}
            >
              {res.kind}{" "}
              <span style={{ fontFamily: "var(--mono)", textTransform: "none", letterSpacing: 0 }}>
                · {res.id.slice(0, 8)}
              </span>
            </div>
            <h1 style={{ fontFamily: "var(--serif)", fontSize: 28, marginTop: 4 }}>{res.name}</h1>
            <p style={{ color: "var(--ink-3)", fontSize: 13, marginTop: 4 }}>
              {res.pages ? `${res.pages} pages · ` : ""}
              {res.owner ? `maintained by ${res.owner} · ` : ""}
              last updated <span style={{ fontFamily: "var(--mono)" }}>{updatedLabel}</span>.
            </p>
          </div>

          <div style={{ display: "flex", gap: 6 }}>
            {res.fileKey ? (
              <Link
                href={`/repo/resource/${res.id}/view`}
                style={{
                  padding: "7px 12px",
                  background: "var(--ink)",
                  color: "var(--paper)",
                  borderRadius: "var(--r-2)",
                  fontSize: 12,
                  textDecoration: "none",
                  fontWeight: 500,
                }}
              >
                View PDF
              </Link>
            ) : null}
            {res.externalUrl ? (
              <a
                href={res.externalUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  padding: "7px 12px",
                  background: "var(--card-hi)",
                  color: "var(--ink)",
                  border: "1px solid var(--line-2)",
                  borderRadius: "var(--r-2)",
                  fontSize: 12,
                  textDecoration: "none",
                }}
              >
                Open external link
              </a>
            ) : null}
          </div>
        </div>
      </header>

      <section
        style={{
          display: "grid",
          gridTemplateColumns: "1.6fr 1fr",
          gap: 18,
        }}
      >
        <SectionCard title="About this document">
          <div
            style={{
              padding: "8px 18px 16px",
              fontSize: 13.5,
              lineHeight: 1.6,
              color: "var(--ink-2)",
            }}
          >
            <p>
              {res.kind}
              {res.owner ? ` maintained by ${res.owner}` : ""}. Used by teachers in their lesson
              preparation and tagged with {subjectCount} subject
              {subjectCount === 1 ? "" : "s"}.
            </p>
            <p style={{ color: "var(--ink-3)", fontSize: 12, fontStyle: "italic" }}>
              Full document preview opens in the in-browser viewer via the buttons above.
            </p>
          </div>
        </SectionCard>

        <div style={{ display: "grid", gap: 16, alignContent: "start" }}>
          <SectionCard title="Details">
            <div style={{ padding: "0 14px 8px" }}>
              <KVRow label="Kind">
                <Chip>{res.kind}</Chip>
              </KVRow>
              <KVRow label="Owner">
                {res.owner ?? <span style={{ color: "var(--ink-4)" }}>—</span>}
              </KVRow>
              <KVRow label="Pages">
                {res.pages ?? <span style={{ color: "var(--ink-4)" }}>—</span>}
              </KVRow>
              <KVRow label="Updated">
                <span style={{ fontFamily: "var(--mono)" }}>{updatedLabel}</span>
              </KVRow>
              <KVRow label="Subjects">
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
              <KVRow label="Tags">
                {tags.length === 0 ? (
                  <span style={{ color: "var(--ink-4)" }}>—</span>
                ) : (
                  tags.map((t) => <Chip key={t}>{t}</Chip>)
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
    <section
      style={{
        background: "var(--card-hi)",
        border: "1px solid var(--line)",
        borderRadius: "var(--r-3)",
        overflow: "hidden",
      }}
    >
      <header
        style={{
          padding: "10px 18px",
          borderBottom: "1px solid var(--line)",
          background: "var(--card)",
          fontFamily: "var(--serif)",
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
        gridTemplateColumns: "120px 1fr",
        gap: 10,
        padding: "8px 0",
        borderTop: "1px solid var(--line)",
        alignItems: "flex-start",
      }}
    >
      <span
        style={{
          fontSize: 11,
          color: "var(--ink-3)",
          textTransform: "uppercase",
          letterSpacing: "0.07em",
          fontWeight: 500,
          paddingTop: 2,
        }}
      >
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
  return (
    <span
      style={{
        padding: "2px 8px",
        background: "var(--paper-2)",
        color: "var(--ink-2)",
        border: "1px solid var(--line)",
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 500,
      }}
    >
      {children}
    </span>
  );
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
      style={{
        padding: "2px 8px",
        background: "var(--card)",
        color: "var(--ink)",
        border: `1px solid ${color ?? "var(--line)"}`,
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 500,
        textDecoration: "none",
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
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
