// /mentorship — pairings list with quarter chip + status.
//
// Spec 129 (Workflow Run 11 frontend-parity closure): add a server-side
// ?status= filter (active / review / paused / ended / complete). Filter
// chips are <Link>s that round-trip the URL searchParam through Postgres.
// Counts come from a single GROUP BY so the chip totals stay accurate
// even when the visible slice has narrowed.

import Link from "next/link";
import { redirect } from "next/navigation";
import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { db } from "@gml/db";
import { mentorPairings, mentors, teachers } from "@gml/db/schema";
import { auth } from "@/auth";
import { actorFrom, pairingVisibilityFilter } from "@/lib/authz";

export const dynamic = "force-dynamic";

const STATUS_CHIP: Record<string, string> = {
  active: "chip-lichen",
  review: "chip-saffron",
  paused: "",
  ended: "",
  complete: "chip-indigo",
};

const STATUS_VALUES = new Set(["active", "review", "paused", "ended", "complete"]);

const STATUS_TABS = [
  { v: "all", l: "All" },
  { v: "active", l: "Active" },
  { v: "review", l: "In review" },
  { v: "paused", l: "Paused" },
  { v: "complete", l: "Complete" },
  { v: "ended", l: "Ended" },
];

type PairingStatus = "active" | "review" | "paused" | "ended" | "complete";

type SearchParams = Promise<{ status?: string }>;

export default async function MentorshipListPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const sp = await searchParams;
  const statusFilter = STATUS_VALUES.has(sp.status ?? "") ? sp.status! : "all";

  // OWNERSHIP. The detail page refuses to show a teacher anyone else's
  // pairing (assertCanAccessPairing); this list was showing her all of them --
  // every mentor's name and base location, every mentee's name, meeting counts
  // and last-meeting dates. Same defect as /observation, same cause: the WHERE
  // was built from the filter chip alone.
  const session = await auth();
  const actor = actorFrom(session);
  if (!actor) redirect("/login");
  const visibility = await pairingVisibilityFilter(actor);

  const conds: SQL[] = [];
  if (visibility) conds.push(visibility);
  if (statusFilter !== "all") {
    conds.push(eq(mentorPairings.status, statusFilter as PairingStatus));
  }

  const rows = await db
    .select({
      id: mentorPairings.id,
      status: mentorPairings.status,
      currentQuarter: mentorPairings.currentQuarter,
      meetingsCount: mentorPairings.meetingsCount,
      lastMeetingAt: mentorPairings.lastMeetingAt,
      startedAt: mentorPairings.startedAt,
      mentorName: mentors.name,
      mentorBase: mentors.baseLocation,
      teacherName: teachers.fullName,
      teacherHindi: teachers.hindiName,
    })
    .from(mentorPairings)
    .leftJoin(mentors, eq(mentorPairings.mentorId, mentors.id))
    .leftJoin(teachers, eq(mentorPairings.teacherId, teachers.id))
    .where(conds.length === 0 ? undefined : and(...conds))
    .orderBy(desc(mentorPairings.startedAt))
    .limit(80);

  // Per-status counts so the filter chips remain truthful regardless of
  // the active filter. Cheap — pairing count is ≤ a few hundred.
  //
  // Scoped by the same predicate as the rows: an unscoped GROUP BY would keep
  // publishing programme-wide pairing totals even once the rows were fixed.
  const statusCountRows = await db
    .select({
      status: mentorPairings.status,
      n: sql<number>`count(*)::int`.as("n"),
    })
    .from(mentorPairings)
    .where(visibility)
    .groupBy(mentorPairings.status);
  const totalPairings = statusCountRows.reduce((acc, r) => acc + r.n, 0);
  const statusCount = (v: string) =>
    v === "all" ? totalPairings : (statusCountRows.find((r) => r.status === v)?.n ?? 0);

  return (
    <div>
      <div className="page-header">
        <div className="label">Mentorship</div>
        <h1 style={{ fontFamily: "var(--serif)", fontSize: 28, marginTop: 4 }}>Pairings</h1>
        <p style={{ color: "var(--ink-3)", fontSize: 13, marginTop: 4 }}>
          Quarterly feedback cycle (Q1 → Q2 → Q3 → Q4 → final). Meetings count cached per pairing.
        </p>
      </div>

      <div className="page-body" style={{ display: "grid", gap: 16 }}>
        <div
          className="card"
          style={{ padding: 10, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}
        >
          <span className="label" style={{ paddingLeft: 0, paddingTop: 0 }}>Status</span>
          {STATUS_TABS.map((f) => {
            const active = statusFilter === f.v;
            const href = f.v === "all" ? "/mentorship" : `/mentorship?status=${f.v}`;
            return (
              <Link
                key={f.v}
                href={href}
                className="btn btn-sm"
                style={{
                  background: active ? "var(--ink)" : "transparent",
                  color: active ? "var(--paper)" : "var(--ink-2)",
                  borderColor: active ? "var(--ink)" : "transparent",
                  boxShadow: "none",
                  textDecoration: "none",
                }}
              >
                {f.l}
                <span style={{ opacity: 0.6, marginLeft: 4 }}>{statusCount(f.v)}</span>
              </Link>
            );
          })}
        </div>
        <section
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
            gap: 14,
          }}
        >
          {rows.length === 0 ? (
            <div style={{ padding: 32, color: "var(--ink-3)" }}>No pairings match this filter.</div>
          ) : (
            rows.map((p) => {
              const chipKind = STATUS_CHIP[p.status] ?? "";
              return (
                <Link
                  key={p.id}
                  href={`/mentorship/${p.id}`}
                  className="card card-hi"
                  style={{
                    padding: 16,
                    textDecoration: "none",
                    color: "var(--ink)",
                    display: "flex",
                    flexDirection: "column",
                    gap: 10,
                  }}
                >
                  <header style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
                    <div>
                      <div className="label" style={{ letterSpacing: "0.05em" }}>
                        {p.mentorName ?? "—"} {p.mentorBase ? `· ${p.mentorBase}` : ""}
                      </div>
                      <div style={{ fontWeight: 500, marginTop: 4 }}>
                        {p.teacherName ?? "—"}
                        {p.teacherHindi ? (
                          <span style={{ fontFamily: "var(--deva)", color: "var(--ink-3)", marginLeft: 8, fontSize: 13 }}>
                            {p.teacherHindi}
                          </span>
                        ) : null}
                      </div>
                    </div>
                    <span className={`chip ${chipKind}`.trim()}>{p.status}</span>
                  </header>

                  <div className="mono" style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: "var(--ink-3)" }}>
                    <span className="chip">Q{p.currentQuarter ?? 1}</span>
                    <span>{p.meetingsCount ?? 0} meetings</span>
                    {p.lastMeetingAt ? (
                      <span>· last {new Date(p.lastMeetingAt).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}</span>
                    ) : null}
                  </div>
                </Link>
              );
            })
          )}
        </section>
      </div>
    </div>
  );
}
