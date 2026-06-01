// /repo/resources — reading-material library index.
// Replaces `window.WIKI.RESOURCES` + `window.wikiLookup.subject()` from
// `repository.jsx` lines 977-1012 with one Drizzle round-trip: resources
// joined to a per-row aggregate of subject names from resource_subjects.
//
// Filter via `?kind=Policy|Guide|Handbook|...` (matches the resources_kind_check
// CHECK constraint). Active filter pill renders inverted (--ink ground).

import { redirect } from "next/navigation";
import Link from "next/link";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@gml/db";
import { resources, resourceSubjects, subjects } from "@gml/db/schema";
import { auth } from "@/auth";

export const dynamic = "force-dynamic";

// Kept aligned with `resources_kind_check` CHECK constraint in
// packages/db/src/schema/resources.ts. "Rubric" and "Other" intentionally omitted
// from the filter strip — same pills the JSX prototype shows.
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

export default async function RepoResourcesIndexPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const sp = await searchParams;
  const kindFilter: KindFilter | undefined = (KIND_FILTERS as readonly string[]).includes(
    sp.kind ?? "",
  )
    ? (sp.kind as KindFilter)
    : undefined;

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
    .where(
      kindFilter
        ? and(eq(resources.active, true), eq(resources.kind, kindFilter))
        : eq(resources.active, true),
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
          Repository
        </div>
        <h1 style={{ fontFamily: "var(--serif)", fontSize: 28, marginTop: 4 }}>
          Reading material
        </h1>
        <p style={{ color: "var(--ink-3)", fontSize: 13, marginTop: 4, maxWidth: 640 }}>
          Handbooks, policy documents, lesson templates, routines and worksheets.
        </p>
      </header>

      <section style={{ display: "flex", gap: 4, marginBottom: 16, flexWrap: "wrap" }}>
        <FilterPill href="/repo/resources" active={!kindFilter} label="All" count={totalActive} />
        {KIND_FILTERS.map((k) => (
          <FilterPill
            key={k}
            href={`/repo/resources?kind=${encodeURIComponent(k)}`}
            active={kindFilter === k}
            label={k}
            count={countMap.get(k) ?? 0}
          />
        ))}
      </section>

      <section
        style={{
          background: "var(--card)",
          border: "1px solid var(--line)",
          borderRadius: "var(--r-3)",
          overflow: "hidden",
        }}
      >
        {rows.length === 0 ? (
          <div style={{ padding: 32, color: "var(--ink-3)", fontSize: 13 }}>
            No reading material matches this filter.
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 13 }}>
            <thead>
              <tr>
                {["Title", "Kind", "Subjects", "Owner", "Pages", "Updated", ""].map((h, i) => (
                  <th
                    key={i}
                    style={{
                      padding: "9px 12px",
                      textAlign: "left",
                      fontSize: 11,
                      textTransform: "uppercase",
                      letterSpacing: "0.07em",
                      color: "var(--ink-3)",
                      fontWeight: 600,
                      background: "var(--paper-2)",
                      borderBottom: "1px solid var(--line)",
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const subs = r.subjectsAgg ?? [];
                const head = subs.slice(0, 2);
                const overflow = subs.length - head.length;
                return (
                  <tr key={r.id} style={{ borderBottom: "1px solid var(--line)" }}>
                    <td style={cellTd}>
                      <Link
                        href={`/repo/resource/${r.id}`}
                        style={{
                          color: "var(--ink)",
                          textDecoration: "none",
                          fontWeight: 500,
                        }}
                      >
                        {r.name}
                      </Link>
                    </td>
                    <td style={cellTd}>
                      <Chip>{r.kind}</Chip>
                    </td>
                    <td style={{ ...cellTd, fontSize: 12 }}>
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
                            <span style={{ color: "var(--ink-4)", marginLeft: 4 }}>
                              {" "}+{overflow}
                            </span>
                          ) : null}
                        </>
                      )}
                    </td>
                    <td style={{ ...cellTd, fontSize: 12, color: "var(--ink-3)" }}>
                      {r.owner ?? <span style={{ color: "var(--ink-4)" }}>—</span>}
                    </td>
                    <td style={cellTd}>
                      {r.pages ?? <span style={{ color: "var(--ink-4)" }}>—</span>}
                    </td>
                    <td
                      style={{
                        ...cellTd,
                        fontFamily: "var(--mono)",
                        fontSize: 12,
                        color: "var(--ink-3)",
                      }}
                    >
                      {r.updatedAt
                        ? new Date(r.updatedAt).toLocaleDateString("en-IN", {
                            day: "numeric",
                            month: "short",
                            year: "numeric",
                          })
                        : "—"}
                    </td>
                    <td style={{ ...cellTd, color: "var(--ink-4)", textAlign: "right" }}>
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
      </section>
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
    <Link
      href={href}
      style={{
        padding: "6px 12px",
        background: active ? "var(--ink)" : "transparent",
        color: active ? "var(--paper)" : "var(--ink-2)",
        border: active ? "1px solid var(--ink)" : "1px solid transparent",
        borderRadius: "var(--r-2)",
        fontSize: 12,
        textDecoration: "none",
      }}
    >
      {label} <span style={{ opacity: 0.6, marginLeft: 4 }}>{count}</span>
    </Link>
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

const cellTd: React.CSSProperties = {
  padding: "9px 12px",
  textAlign: "left",
  borderBottom: "1px solid var(--line)",
  verticalAlign: "middle",
};
