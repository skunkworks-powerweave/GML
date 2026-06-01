// /mentorship — pairings list with quarter chip + status.

import Link from "next/link";
import { desc } from "drizzle-orm";
import { db } from "@gml/db";
import { mentorPairings, mentors, teachers } from "@gml/db/schema";

export const dynamic = "force-dynamic";

const STATUS_COLOR: Record<string, { bg: string; ink: string }> = {
  active: { bg: "var(--lichen-soft)", ink: "var(--lichen)" },
  review: { bg: "var(--saffron-soft)", ink: "var(--saffron)" },
  paused: { bg: "var(--paper-2)", ink: "var(--ink-3)" },
  ended: { bg: "var(--paper-2)", ink: "var(--ink-3)" },
  complete: { bg: "var(--indigo-soft)", ink: "var(--indigo)" },
};

export default async function MentorshipListPage() {
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
    .leftJoin(mentors, eqCol(mentorPairings.mentorId, mentors.id))
    .leftJoin(teachers, eqCol(mentorPairings.teacherId, teachers.id))
    .orderBy(desc(mentorPairings.startedAt))
    .limit(80);

  return (
    <div>
      <header style={{ marginBottom: 22 }}>
        <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--ink-3)" }}>
          Mentorship
        </div>
        <h1 style={{ fontFamily: "var(--serif)", fontSize: 28, marginTop: 4 }}>Pairings</h1>
        <p style={{ color: "var(--ink-3)", fontSize: 13, marginTop: 4 }}>
          Quarterly feedback cycle (Q1 → Q2 → Q3 → Q4 → final). Meetings count cached per pairing.
        </p>
      </header>

      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
          gap: 14,
        }}
      >
        {rows.length === 0 ? (
          <div style={{ padding: 32, color: "var(--ink-3)" }}>No pairings yet.</div>
        ) : (
          rows.map((p) => {
            const status = STATUS_COLOR[p.status] ?? STATUS_COLOR.active;
            return (
              <Link
                key={p.id}
                href={`/mentorship/${p.id}`}
                style={{
                  background: "var(--card-hi)",
                  border: "1px solid var(--line)",
                  borderRadius: "var(--r-3)",
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
                    <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--ink-3)" }}>
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
                  <span
                    style={{
                      padding: "2px 8px",
                      background: status.bg,
                      color: status.ink,
                      borderRadius: 999,
                      fontSize: 10,
                      textTransform: "uppercase",
                      letterSpacing: "0.06em",
                      fontWeight: 600,
                    }}
                  >
                    {p.status}
                  </span>
                </header>

                <div style={{ display: "flex", gap: 8, fontFamily: "var(--mono)", fontSize: 11, color: "var(--ink-3)" }}>
                  <span style={{ padding: "2px 6px", background: "var(--paper-2)", borderRadius: 4 }}>
                    Q{p.currentQuarter ?? 1}
                  </span>
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
  );
}

function eqCol<T>(a: T, b: T) {
  // @ts-expect-error narrow drizzle import wrapper
  return require("drizzle-orm").eq(a, b);
}
