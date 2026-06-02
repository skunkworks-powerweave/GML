// /repo/mentors — Repository · Mentors index.
// Ported 1:1 from LMS GML Frontend/repository.jsx lines 910-936 (RepoMentorsIndex).
// Replaces window.LMS.MENTORS mock with real Drizzle queries against mentors + mentorPairings.

import Link from "next/link";
import { redirect } from "next/navigation";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@gml/db";
import { mentors, mentorPairings } from "@gml/db/schema";
import { auth } from "@/auth";
// Spec 138 — mobile card-list fallback (desktop keeps the table).
import { getDeviceType } from "@/lib/device";
import { MobileRepoCardList } from "@/components/repo/MobileRepoCardList";

export const dynamic = "force-dynamic";

// Base-location chip palette. Leh maps to indigo-soft, Kargil maps to saffron-soft.
// Renders as `.chip .chip-indigo` / `.chip .chip-saffron` via globals.css utilities.
const BASE_CHIP: Record<string, string> = {
  Leh: "chip-indigo", // indigo-soft background
  Kargil: "chip-saffron", // saffron-soft background
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

  // Spec 138 — device-aware card/table fork.
  const device = await getDeviceType();

  return (
    <div>
      <div className="page-header">
        <div className="label">Repository</div>
        <h1 style={{ fontFamily: "var(--serif)", fontSize: 28, marginTop: 4 }}>Mentors</h1>
        <p style={{ color: "var(--ink-3)", marginTop: 4 }}>
          Master mentors carrying 5 mentees each through quarterly progress checks.
        </p>
      </div>
      <div className="page-body">
        {/* Spec 138 — mobile branch: card list. Desktop keeps the table. */}
        {device === "mobile" ? (
          <MobileRepoCardList
            testIdSuffix="mentors"
            emptyMessage="No mentors yet."
            items={rows.map((m) => {
              const base = m.baseLocation ?? "";
              const chipKind = BASE_CHIP[base] ?? "";
              const expertise = Array.isArray(m.expertiseAreas)
                ? m.expertiseAreas.join(", ")
                : "";
              return {
                id: m.id,
                primary: m.name,
                hindi: m.hindiName ?? null,
                href: `/repo/mentor/${m.id}`,
                chip: base ? { label: base, kind: chipKind } : null,
                secondary: [
                  { label: "Expertise", value: expertise || "—" },
                  {
                    value: `${menteeCount.get(m.id) ?? 0} mentees`,
                  },
                ],
              };
            })}
          />
        ) : null}
        <div className="card card-hi" style={device === "mobile" ? { display: "none" } : undefined} aria-hidden={device === "mobile"}>
          <table className="t">
            <thead>
              <tr>
                <th>Name</th>
                <th className="deva" style={{ fontFamily: "var(--deva)" }}>नाम</th>
                <th>Expertise</th>
                <th>Based in</th>
                <th>Mentees</th>
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
                  const chipKind = BASE_CHIP[base];
                  const expertise = Array.isArray(m.expertiseAreas) ? m.expertiseAreas.join(", ") : "";
                  return (
                    <tr key={m.id}>
                      <td style={{ fontWeight: 500 }}>
                        <Link
                          href={`/repo/mentor/${m.id}`}
                          style={{ color: "var(--ink)", textDecoration: "none" }}
                        >
                          {m.name}
                        </Link>
                      </td>
                      <td className="deva" style={{ fontFamily: "var(--deva)", fontSize: 12, color: "var(--ink-3)" }}>
                        {m.hindiName ?? ""}
                      </td>
                      <td>{expertise || "—"}</td>
                      <td>
                        {base && chipKind ? (
                          <span className={`chip ${chipKind}`}>{base}</span>
                        ) : base ? (
                          <span className="chip">{base}</span>
                        ) : (
                          <span style={{ color: "var(--ink-3)" }}>—</span>
                        )}
                      </td>
                      <td>{menteeCount.get(m.id) ?? 0}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
