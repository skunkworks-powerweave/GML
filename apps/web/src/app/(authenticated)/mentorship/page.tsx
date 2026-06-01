// /mentorship — pairings list with quarter chip + status.

import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { db } from "@gml/db";
import { mentorPairings, mentors, teachers } from "@gml/db/schema";

export const dynamic = "force-dynamic";

const STATUS_CHIP: Record<string, string> = {
  active: "chip-lichen",
  review: "chip-saffron",
  paused: "",
  ended: "",
  complete: "chip-indigo",
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
    .leftJoin(mentors, eq(mentorPairings.mentorId, mentors.id))
    .leftJoin(teachers, eq(mentorPairings.teacherId, teachers.id))
    .orderBy(desc(mentorPairings.startedAt))
    .limit(80);

  return (
    <div>
      <div className="page-header">
        <div className="label">Mentorship</div>
        <h1 style={{ fontFamily: "var(--serif)", fontSize: 28, marginTop: 4 }}>Pairings</h1>
        <p style={{ color: "var(--ink-3)", fontSize: 13, marginTop: 4 }}>
          Quarterly feedback cycle (Q1 → Q2 → Q3 → Q4 → final). Meetings count cached per pairing.
        </p>
      </div>

      <div className="page-body">
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

