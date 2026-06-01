// /mentorship/[pairingId] — pairing detail: concept note + meetings + feedback lifecycle.

import { notFound } from "next/navigation";
import Link from "next/link";
import { eq, desc } from "drizzle-orm";
import { db } from "@gml/db";
import { mentorPairings, mentors, teachers, mentorMeetings, feedbackResponses } from "@gml/db/schema";

export const dynamic = "force-dynamic";

const QUARTERS = ["baseline", "progress_1", "progress_2", "final"] as const;
const QUARTER_LABEL: Record<string, string> = {
  baseline: "Q1 · Baseline",
  progress_1: "Q2 · Progress",
  progress_2: "Q3 · Progress",
  final: "Q4 · Final",
};

export default async function PairingDetailPage({ params }: { params: Promise<{ pairingId: string }> }) {
  const { pairingId } = await params;

  const [pairing] = await db.select().from(mentorPairings).where(eq(mentorPairings.id, pairingId)).limit(1);
  if (!pairing) notFound();
  const [mentor] = await db.select().from(mentors).where(eq(mentors.id, pairing.mentorId)).limit(1);
  const [teacher] = await db.select().from(teachers).where(eq(teachers.id, pairing.teacherId)).limit(1);

  const meetings = await db
    .select()
    .from(mentorMeetings)
    .where(eq(mentorMeetings.pairingId, pairingId))
    .orderBy(desc(mentorMeetings.scheduledAt))
    .limit(20);

  const feedback = await db.select().from(feedbackResponses).where(eq(feedbackResponses.pairingId, pairingId));
  const feedbackByKind = new Set(
    feedback.map((f) => {
      // We have form_id but not kind here; query+join would be cleaner, but
      // for display we just count which kinds are present via form_id table.
      // Until spec 056 wires feedback lifecycle, show count only.
      return f.formId;
    }),
  );

  return (
    <div>
      <header style={{ marginBottom: 20 }}>
        <Link href="/mentorship" style={{ fontSize: 12, color: "var(--ink-3)" }}>
          ← Pairings
        </Link>
        <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--ink-3)", marginTop: 8 }}>
          Pairing
        </div>
        <h1 style={{ fontFamily: "var(--serif)", fontSize: 26, marginTop: 4 }}>
          {mentor?.name ?? "—"} <span style={{ color: "var(--ink-3)" }}>↔</span> {teacher?.fullName ?? "—"}
          {teacher?.hindiName ? (
            <span style={{ fontFamily: "var(--deva)", color: "var(--ink-3)", marginLeft: 10, fontSize: 18 }}>
              {teacher.hindiName}
            </span>
          ) : null}
        </h1>
        <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 4 }}>
          {pairing.status} · Q{pairing.currentQuarter ?? 1} ·{" "}
          Started {new Date(pairing.startedAt).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })}
          {pairing.meetingsCount != null ? ` · ${pairing.meetingsCount} meetings` : ""}
        </div>
      </header>

      {/* Quarter strip */}
      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: 8,
          marginBottom: 22,
          background: "var(--card-hi)",
          padding: 12,
          border: "1px solid var(--line)",
          borderRadius: "var(--r-3)",
        }}
      >
        {QUARTERS.map((q, i) => {
          const isCurrent = (pairing.currentQuarter ?? 1) === i + 1;
          const isPast = (pairing.currentQuarter ?? 1) > i + 1;
          return (
            <div
              key={q}
              style={{
                textAlign: "center",
                padding: 10,
                borderRadius: "var(--r-2)",
                background: isCurrent ? "var(--ink)" : isPast ? "var(--lichen-soft)" : "var(--paper-2)",
                color: isCurrent ? "var(--paper)" : isPast ? "var(--ink)" : "var(--ink-3)",
                fontSize: 12,
                fontWeight: isCurrent ? 600 : 500,
              }}
            >
              {QUARTER_LABEL[q]}
              {isPast ? <span style={{ marginLeft: 6, fontSize: 10 }}>✓</span> : null}
            </div>
          );
        })}
      </section>

      <section style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 18 }}>
        <article style={{ background: "var(--card-hi)", border: "1px solid var(--line)", borderRadius: "var(--r-3)", padding: 16 }}>
          <h2 style={{ fontFamily: "var(--serif)", fontSize: 16, marginBottom: 12 }}>
            Meetings ({meetings.length})
          </h2>
          {meetings.length === 0 ? (
            <p style={{ fontSize: 12, color: "var(--ink-3)" }}>No meetings logged yet.</p>
          ) : (
            <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 8 }}>
              {meetings.map((m) => (
                <li
                  key={m.id}
                  style={{
                    padding: 10,
                    border: "1px solid var(--line)",
                    borderRadius: "var(--r-2)",
                    fontSize: 12,
                  }}
                >
                  <div style={{ fontWeight: 500 }}>
                    {new Date(m.scheduledAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}
                    {m.durationMin ? ` · ${m.durationMin}` : ""}
                  </div>
                  {m.notes ? <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 4 }}>{m.notes}</div> : null}
                  {m.recordingVideoId ? (
                    <Link
                      href={`/videos/${m.recordingVideoId}`}
                      style={{ fontSize: 11, color: "var(--indigo)", marginTop: 4, display: "inline-block" }}
                    >
                      Open recording →
                    </Link>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </article>

        <article style={{ background: "var(--card-hi)", border: "1px solid var(--line)", borderRadius: "var(--r-3)", padding: 16 }}>
          <h2 style={{ fontFamily: "var(--serif)", fontSize: 16, marginBottom: 12 }}>
            Feedback ({feedbackByKind.size}/8)
          </h2>
          <p style={{ fontSize: 11, color: "var(--ink-3)", marginBottom: 12 }}>
            4 mentor forms + 4 mentee forms across baseline + progress 1 + progress 2 + final. Lifecycle wired in spec 056.
          </p>
          {pairing.conceptNote ? (
            <div style={{ padding: 10, background: "var(--paper-2)", borderRadius: "var(--r-2)", fontSize: 12 }}>
              <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--ink-3)" }}>
                Concept note
              </div>
              <p style={{ marginTop: 6, color: "var(--ink-2)", lineHeight: 1.5 }}>{pairing.conceptNote}</p>
            </div>
          ) : null}
        </article>
      </section>
    </div>
  );
}
