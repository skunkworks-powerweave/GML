// /repo/mentors — Repository · Mentors index.
// Ported 1:1 from LMS GML Frontend/repository.jsx lines 910-936 (RepoMentorsIndex).
// Replaces window.LMS.MENTORS mock with real Drizzle queries against mentors + mentorPairings.
//
// Spec 160 (Workflow Run 15 audit-closure MISS): adds a "Download CSV" button
// in the page header — visible only to super_admin + programme_admin — that
// hits /api/admin/data/mentors/export. Schools, teachers, and learners all
// had a CSV download link already; this closes the parity gap.

import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { and, eq, ilike, inArray, sql } from "drizzle-orm";
import { db } from "@gml/db";
import { mentors, mentorPairings } from "@gml/db/schema";
import { auth } from "@/auth";
// Spec 138 — mobile card-list fallback (desktop keeps the table).
import { getDeviceType } from "@/lib/device";
import { MobileRepoCardList } from "@/components/repo/MobileRepoCardList";
import { escapeIlike } from "@gml/shared/sql/ilike";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Mentors" };

// Base-location chip palette. Leh maps to indigo-soft, Kargil maps to saffron-soft.
// Renders as `.chip .chip-indigo` / `.chip .chip-saffron` via globals.css utilities.
const BASE_CHIP: Record<string, string> = {
  Leh: "chip-indigo", // indigo-soft background
  Kargil: "chip-saffron", // saffron-soft background
};

// Spec 158 — repo-search-bar contract: ?q= name filter, 200-char cap,
// escape ILIKE wildcards so a literal "%" / "_" in the query doesn't
// become a pattern character.
const SEARCH_Q_MAX = 200;

type SearchParams = Promise<{ q?: string }>;

export default async function RepoMentorsIndexPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const sp = await searchParams;
  // Spec 158 — name search on mentors.name.
  const qRaw = (sp.q ?? "").slice(0, SEARCH_Q_MAX);
  const qFilter = qRaw.trim().length > 0 ? qRaw.trim() : null;

  // Spec 160 — surface the CSV-export link only to roles allowed to call the
  // route (mirrors /api/admin/data/mentors/export role gate). `mentor` role
  // sees the index but not the bulk download — that gate is owned by the
  // route handler too, but hiding the button removes the dead-link UX.
  const canExport =
    session.user.role === "super_admin" || session.user.role === "programme_admin";

  // Mentors list — only active mentors, alphabetical.
  // Spec 158 — combine the active gate with the ?q= ILIKE narrowing.
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
    .where(
      qFilter
        ? and(eq(mentors.active, true), ilike(mentors.name, `%${escapeIlike(qFilter)}%`))
        : eq(mentors.active, true),
    )
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
        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16 }}>
          <div>
            <h1 style={{ fontFamily: "var(--serif)", fontSize: 28, marginTop: 4 }}>Mentors</h1>
            <p style={{ color: "var(--ink-3)", marginTop: 4 }}>
              Master mentors carrying 5 mentees each through quarterly progress checks.
            </p>
          </div>
          {/* Spec 160 — CSV export link. Surfaces only for super_admin and
              programme_admin (the same gate the route handler enforces). */}
          {canExport ? (
            <a
              href="/api/admin/data/mentors/export"
              className="btn btn-primary btn-sm"
              style={{ textDecoration: "none", whiteSpace: "nowrap" }}
              title="Download all mentors as CSV — admin only, audited"
              data-testid="mentors-csv-export"
            >
              Download CSV
            </a>
          ) : null}
        </div>
      </div>
      <div className="page-body" style={{ display: "grid", gap: 16 }}>
        {/* Spec 158 — name search bar. Native HTML GET form so the URL is
            shareable; no client component required. */}
        <form
          method="GET"
          action="/repo/mentors"
          className="card"
          style={{ padding: 10, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}
        >
          <label className="label" style={{ paddingLeft: 0, paddingTop: 0 }}>
            Name
            <input
              type="search"
              name="q"
              defaultValue={qFilter ?? ""}
              aria-label="Search mentors by name"
              title="Search mentors by name"
              maxLength={SEARCH_Q_MAX}
              className="text"
              style={{ marginLeft: 6, padding: "5px 10px", fontSize: 12, minWidth: 160 }}
            />
          </label>
          <button type="submit" className="btn btn-sm">
            Search
          </button>
          {qFilter ? (
            <Link href="/repo/mentors" className="btn btn-sm" style={{ textDecoration: "none" }}>
              Clear
            </Link>
          ) : null}
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <span className="chip">{rows.length} shown</span>
          </div>
        </form>
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
