// /repo/mentor/[id] — Repository · Mentor detail.
// Synthesized to mirror the teacher-detail pattern: KV header (name + Hindi + base_location),
// pairings grouped by status (active / review / paused / ended / complete), current quarter chip,
// meetings_count cached per pairing. SM-7 keeps Hindi rendering conditional.

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { eq, desc } from "drizzle-orm";
import { db } from "@gml/db";
import { mentors, mentorPairings, teachers } from "@gml/db/schema";
import { auth } from "@/auth";

export const dynamic = "force-dynamic";

const STATUS_ORDER = ["active", "review", "paused", "complete", "ended"] as const;
type Status = (typeof STATUS_ORDER)[number];

const STATUS_COLOR: Record<Status, { bg: string; ink: string; label: string }> = {
  active: { bg: "var(--lichen-soft)", ink: "var(--lichen)", label: "Active" },
  review: { bg: "var(--saffron-soft)", ink: "var(--saffron)", label: "In review" },
  paused: { bg: "var(--paper-2)", ink: "var(--ink-3)", label: "Paused" },
  complete: { bg: "var(--indigo-soft)", ink: "var(--indigo)", label: "Complete" },
  ended: { bg: "var(--paper-2)", ink: "var(--ink-3)", label: "Ended" },
};

const BASE_COLOR: Record<string, { bg: string; ink: string }> = {
  Leh: { bg: "var(--indigo-soft)", ink: "var(--indigo)" },
  Kargil: { bg: "var(--saffron-soft)", ink: "var(--saffron)" },
};

export default async function RepoMentorDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const { id } = await params;

  const [mentor] = await db.select().from(mentors).where(eq(mentors.id, id)).limit(1);
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
  const baseChip = mentor.baseLocation
    ? BASE_COLOR[mentor.baseLocation] ?? { bg: "var(--paper-2)", ink: "var(--ink-3)" }
    : null;

  return (
    <div>
      <header style={{ marginBottom: 22 }}>
        <Link href="/repo/mentors" style={{ fontSize: 12, color: "var(--ink-3)", textDecoration: "none" }}>
          ← Mentors
        </Link>
        <div
          style={{
            fontSize: 10,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            color: "var(--ink-3)",
            marginTop: 8,
          }}
        >
          Repository · Mentor
        </div>
        <h1 style={{ fontFamily: "var(--serif)", fontSize: 28, marginTop: 4 }}>
          {mentor.name}
          {mentor.hindiName ? (
            <span style={{ fontFamily: "var(--deva)", color: "var(--ink-3)", marginLeft: 12, fontSize: 20 }}>
              {mentor.hindiName}
            </span>
          ) : null}
        </h1>
        <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 8, flexWrap: "wrap" }}>
          {baseChip ? (
            <span
              style={{
                padding: "2px 8px",
                background: baseChip.bg,
                color: baseChip.ink,
                borderRadius: 999,
                fontSize: 10,
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                fontWeight: 600,
              }}
            >
              {mentor.baseLocation}
            </span>
          ) : null}
          <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
            {activeCount} active mentee{activeCount === 1 ? "" : "s"} · {totalMeetings} meeting{totalMeetings === 1 ? "" : "s"} lifetime
          </span>
        </div>
      </header>

      {/* KV summary card */}
      <section
        style={{
          background: "var(--card-hi)",
          border: "1px solid var(--line)",
          borderRadius: "var(--r-3)",
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
            style={{
              padding: 24,
              background: "var(--card-hi)",
              border: "1px solid var(--line)",
              borderRadius: "var(--r-3)",
              color: "var(--ink-3)",
              fontSize: 13,
            }}
          >
            No pairings yet.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            {STATUS_ORDER.map((status) => {
              const items = grouped.get(status)!;
              if (items.length === 0) return null;
              const colors = STATUS_COLOR[status];
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
                    <span
                      style={{
                        padding: "2px 8px",
                        background: colors.bg,
                        color: colors.ink,
                        borderRadius: 999,
                        fontSize: 10,
                        textTransform: "uppercase",
                        letterSpacing: "0.06em",
                        fontWeight: 600,
                      }}
                    >
                      {colors.label}
                    </span>
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
                        style={{
                          background: "var(--card-hi)",
                          border: "1px solid var(--line)",
                          borderRadius: "var(--r-3)",
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
                                style={{
                                  fontFamily: "var(--deva)",
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
                            style={{
                              fontSize: 10,
                              textTransform: "uppercase",
                              letterSpacing: "0.05em",
                              color: "var(--ink-3)",
                              marginTop: 4,
                            }}
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
                          style={{
                            display: "flex",
                            gap: 8,
                            fontFamily: "var(--mono)",
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
      <div
        style={{
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          color: "var(--ink-3)",
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 13,
          color: "var(--ink-2)",
          fontFamily: deva ? "var(--deva)" : undefined,
          lineHeight: 1.5,
          whiteSpace: "pre-wrap",
        }}
      >
        {value}
      </div>
    </div>
  );
}
