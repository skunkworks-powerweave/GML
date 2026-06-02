// /repo/mentor/[id] — Repository · Mentor detail.
// Synthesized to mirror the teacher-detail pattern: KV header (name + Hindi + base_location),
// pairings grouped by status (active / review / paused / ended / complete), current quarter chip,
// meetings_count cached per pairing. SM-7 keeps Hindi rendering conditional.
//
// Spec 153 (Workflow Run 14 audit-closure MEDIUM) — the detail SELECT now filters
// on `mentors.active = true`. The mentors index page already filters on active
// (see /repo/mentors page.tsx, eq(mentors.active, true)); without the same
// guard here a soft-retired mentor remained reachable by /repo/mentor/<id>
// even though they were hidden from the list view. The mentors schema uses
// `active boolean` rather than a `deletedAt` timestamp (packages/db/src/schema/
// mentorship.ts) so the WHERE clause uses `and(eq(mentors.id, id), eq(mentors.
// active, true))`. A soft-retired mentor now 404s consistently with the index.

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { and, eq, desc } from "drizzle-orm";
import { db } from "@gml/db";
import { mentors, mentorPairings, teachers } from "@gml/db/schema";
import { auth } from "@/auth";

export const dynamic = "force-dynamic";

const STATUS_ORDER = ["active", "review", "paused", "complete", "ended"] as const;
type Status = (typeof STATUS_ORDER)[number];

const STATUS_CHIP: Record<Status, { kind: string; label: string }> = {
  active: { kind: "chip-lichen", label: "Active" },
  review: { kind: "chip-saffron", label: "In review" },
  paused: { kind: "", label: "Paused" },
  complete: { kind: "chip-indigo", label: "Complete" },
  ended: { kind: "", label: "Ended" },
};

const BASE_CHIP: Record<string, string> = {
  Leh: "chip-indigo",
  Kargil: "chip-saffron",
};

export default async function RepoMentorDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const { id } = await params;

  // Spec 153 — only return active mentors. A soft-retired mentor (active=false)
  // must not render here; the row exists in the DB so without this guard the
  // page would render full detail. notFound() keeps the response symmetric with
  // the index page hiding the same mentor.
  const [mentor] = await db
    .select()
    .from(mentors)
    .where(and(eq(mentors.id, id), eq(mentors.active, true)))
    .limit(1);
  if (!mentor) notFound();

  const pairings = await db
    .select({
      id: mentorPairings.id,
      status: mentorPairings.status,
      currentQuarter: mentorPairings.currentQuarter,
      meetingsCount: mentorPairings.meetingsCount,
      lastMeetingAt: mentorPairings.lastMeetingAt,
      startedAt: mentorPairings.startedAt,
      endedAt: mentorPairings.endedAt,
      teacherId: mentorPairings.teacherId,
      teacherName: teachers.fullName,
      teacherHindi: teachers.hindiName,
    })
    .from(mentorPairings)
    .leftJoin(teachers, eq(mentorPairings.teacherId, teachers.id))
    .where(eq(mentorPairings.mentorId, id))
    .orderBy(desc(mentorPairings.startedAt))
    .limit(120);

  // Group pairings by status for the cluster lists.
  const grouped = new Map<Status, typeof pairings>();
  for (const s of STATUS_ORDER) grouped.set(s, []);
  for (const p of pairings) {
    const key = (STATUS_ORDER.includes(p.status as Status) ? p.status : "active") as Status;
    grouped.get(key)!.push(p);
  }

  const activeCount = grouped.get("active")!.length;
  const totalMeetings = pairings.reduce((sum, p) => sum + (p.meetingsCount ?? 0), 0);
  const expertise = Array.isArray(mentor.expertiseAreas) ? mentor.expertiseAreas : [];
  const baseChipKind = mentor.baseLocation ? BASE_CHIP[mentor.baseLocation] ?? "" : "";

  return (
    <div>
      <div className="page-header">
        <Link
          href="/repo/mentors"
          className="btn btn-sm btn-ghost"
          style={{ marginBottom: 8, marginLeft: -8, display: "inline-flex" }}
        >
          ← Mentors
        </Link>
        <div className="label">Repository · Mentor</div>
        <h1 style={{ fontFamily: "var(--serif)", fontSize: 28, marginTop: 4 }}>
          {mentor.name}
          {mentor.hindiName ? (
            <span
              className="deva"
              style={{ fontFamily: "var(--deva)", color: "var(--ink-3)", marginLeft: 12, fontSize: 20 }}
            >
              {mentor.hindiName}
            </span>
          ) : null}
        </h1>
        <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 8, flexWrap: "wrap" }}>
          {mentor.baseLocation ? (
            <span className={`chip ${baseChipKind}`}>{mentor.baseLocation}</span>
          ) : null}
          <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
            {activeCount} active mentee{activeCount === 1 ? "" : "s"} · {totalMeetings} meeting{totalMeetings === 1 ? "" : "s"} lifetime
          </span>
        </div>
      </div>

      <div className="page-body">
        {/* KV summary card */}
        <section
          className="card card-hi"
          style={{
            padding: 16,
            marginBottom: 22,
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
            gap: 14,
          }}
        >
          <KV label="Name" value={mentor.name} />
          {mentor.hindiName ? <KV label="नाम" value={mentor.hindiName} deva /> : null}
          <KV label="Based in" value={mentor.baseLocation ?? "—"} />
          <KV
            label="Expertise"
            value={expertise.length ? expertise.join(", ") : "—"}
          />
          {mentor.bio ? <KV label="Bio" value={mentor.bio} span /> : null}
        </section>

        {/* Pairings grouped by status */}
        <section>
          <h2
            style={{
              fontFamily: "var(--serif)",
              fontSize: 18,
              marginBottom: 12,
            }}
          >
            Pairings ({pairings.length})
          </h2>

          {pairings.length === 0 ? (
            <div
              className="card card-hi"
              style={{ padding: 24, color: "var(--ink-3)", fontSize: 13 }}
            >
              No pairings yet.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
              {STATUS_ORDER.map((status) => {
                const items = grouped.get(status)!;
                if (items.length === 0) return null;
                const info = STATUS_CHIP[status];
                return (
                  <div key={status}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        marginBottom: 8,
                      }}
                    >
                      <span className={`chip ${info.kind}`}>{info.label}</span>
                      <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
                        {items.length}
                      </span>
                    </div>
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
                        gap: 12,
                      }}
                    >
                      {items.map((p) => (
                        <Link
                          key={p.id}
                          href={`/mentorship/${p.id}`}
                          className="card card-hi"
                          style={{
                            padding: 14,
                            textDecoration: "none",
                            color: "var(--ink)",
                            display: "flex",
                            flexDirection: "column",
                            gap: 8,
                          }}
                        >
                          <div>
                            <div style={{ fontWeight: 500 }}>
                              {p.teacherName ?? "—"}
                              {p.teacherHindi ? (
                                <span
                                  className="deva"
                                  style={{
                                    color: "var(--ink-3)",
                                    marginLeft: 8,
                                    fontSize: 13,
                                  }}
                                >
                                  {p.teacherHindi}
                                </span>
                              ) : null}
                            </div>
                            <div
                              className="label"
                              style={{ marginTop: 4 }}
                            >
                              Started{" "}
                              {new Date(p.startedAt).toLocaleDateString("en-IN", {
                                day: "numeric",
                                month: "short",
                                year: "numeric",
                              })}
                            </div>
                          </div>
                          <div
                            className="mono"
                            style={{
                              display: "flex",
                              gap: 8,
                              fontSize: 11,
                              color: "var(--ink-3)",
                              flexWrap: "wrap",
                            }}
                          >
                            <span
                              style={{
                                padding: "2px 6px",
                                background: "var(--paper-2)",
                                borderRadius: 4,
                              }}
                            >
                              Q{p.currentQuarter ?? 1}
                            </span>
                            <span>{p.meetingsCount ?? 0} meetings</span>
                            {p.lastMeetingAt ? (
                              <span>
                                · last{" "}
                                {new Date(p.lastMeetingAt).toLocaleDateString("en-IN", {
                                  day: "numeric",
                                  month: "short",
                                })}
                              </span>
                            ) : null}
                          </div>
                        </Link>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function KV({
  label,
  value,
  deva = false,
  span = false,
}: {
  label: string;
  value: string;
  deva?: boolean;
  span?: boolean;
}) {
  return (
    <div style={{ gridColumn: span ? "1 / -1" : undefined }}>
      <div className="label" style={{ marginBottom: 4 }}>
        {label}
      </div>
      <div
        className={deva ? "deva" : undefined}
        style={{
          fontSize: 13,
          color: "var(--ink-2)",
          lineHeight: 1.5,
          whiteSpace: "pre-wrap",
        }}
      >
        {value}
      </div>
    </div>
  );
}
