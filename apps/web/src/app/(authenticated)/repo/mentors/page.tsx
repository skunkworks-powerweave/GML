// /repo/mentors — Repository · Mentors index.
// Ported 1:1 from LMS GML Frontend/repository.jsx lines 910-936 (RepoMentorsIndex).
// Replaces window.LMS.MENTORS mock with real Drizzle queries against mentors + mentorPairings.

import Link from "next/link";
import { redirect } from "next/navigation";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@gml/db";
import { mentors, mentorPairings } from "@gml/db/schema";
import { auth } from "@/auth";

export const dynamic = "force-dynamic";

const BASE_COLOR: Record<string, { bg: string; ink: string }> = {
  Leh: { bg: "var(--indigo-soft)", ink: "var(--indigo)" },
  Kargil: { bg: "var(--saffron-soft)", ink: "var(--saffron)" },
};

export default async function RepoMentorsIndexPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  // Mentors list — only active mentors, alphabetical.
  const rows = await db
    .select({
      id: mentors.id,
      name: mentors.name,
      hindiName: mentors.hindiName,
      baseLocation: mentors.baseLocation,
      expertiseAreas: mentors.expertiseAreas,
      active: mentors.active,
    })
    .from(mentors)
    .where(eq(mentors.active, true))
    .orderBy(mentors.name)
    .limit(200);

  // Mentee counts grouped by mentor, restricted to currently active pairings.
  // Single round-trip via groupBy keeps the index page snappy.
  const ids = rows.map((m) => m.id);
  const counts = ids.length
    ? await db
        .select({
          mentorId: mentorPairings.mentorId,
          mentees: sql<number>`count(*)::int`,
        })
        .from(mentorPairings)
        .where(and(inArray(mentorPairings.mentorId, ids), eq(mentorPairings.status, "active")))
        .groupBy(mentorPairings.mentorId)
    : [];
  const menteeCount = new Map(counts.map((c) => [c.mentorId, c.mentees]));

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
        <h1 style={{ fontFamily: "var(--serif)", fontSize: 28, marginTop: 4 }}>Mentors</h1>
        <p style={{ color: "var(--ink-3)", fontSize: 13, marginTop: 4 }}>
          Master mentors carrying 5 mentees each through quarterly progress checks.
        </p>
      </header>

      <section
        style={{
          background: "var(--card-hi)",
          border: "1px solid var(--line)",
          borderRadius: "var(--r-3)",
          overflow: "hidden",
        }}
      >
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            fontSize: 13,
          }}
        >
          <thead>
            <tr style={{ background: "var(--paper-2)" }}>
              <th style={th}>Name</th>
              <th style={{ ...th, fontFamily: "var(--deva)" }}>नाम</th>
              <th style={th}>Expertise</th>
              <th style={th}>Based in</th>
              <th style={th}>Mentees</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5} style={{ padding: 32, color: "var(--ink-3)", textAlign: "center" }}>
                  No mentors yet.
                </td>
              </tr>
            ) : (
              rows.map((m) => {
                const base = m.baseLocation ?? "";
                const chip = BASE_COLOR[base] ?? { bg: "var(--paper-2)", ink: "var(--ink-3)" };
                const expertise = Array.isArray(m.expertiseAreas) ? m.expertiseAreas.join(", ") : "";
                return (
                  <tr
                    key={m.id}
                    style={{ borderTop: "1px solid var(--line)" }}
                  >
                    <td style={{ ...td, fontWeight: 500 }}>
                      <Link
                        href={`/repo/mentor/${m.id}`}
                        style={{ color: "var(--ink)", textDecoration: "none" }}
                      >
                        {m.name}
                      </Link>
                    </td>
                    <td style={{ ...td, fontFamily: "var(--deva)", fontSize: 12, color: "var(--ink-3)" }}>
                      {m.hindiName ?? ""}
                    </td>
                    <td style={{ ...td, color: "var(--ink-2)" }}>{expertise || "—"}</td>
                    <td style={td}>
                      {base ? (
                        <span
                          style={{
                            padding: "2px 8px",
                            background: chip.bg,
                            color: chip.ink,
                            borderRadius: 999,
                            fontSize: 10,
                            textTransform: "uppercase",
                            letterSpacing: "0.06em",
                            fontWeight: 600,
                          }}
                        >
                          {base}
                        </span>
                      ) : (
                        <span style={{ color: "var(--ink-3)" }}>—</span>
                      )}
                    </td>
                    <td style={{ ...td, fontFamily: "var(--mono)", fontSize: 12 }}>
                      {menteeCount.get(m.id) ?? 0}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}

const th: React.CSSProperties = {
  textAlign: "left",
  padding: "10px 14px",
  fontSize: 10,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "var(--ink-3)",
  fontWeight: 600,
};

const td: React.CSSProperties = {
  padding: "12px 14px",
  verticalAlign: "middle",
};
