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

  const currentQuarter = pairing.currentQuarter ?? 1;
  const feedbackPct = Math.min(100, Math.round((feedbackByKind.size / 8) * 100));

  return (
    <div>
      <div className="page-header">
        <Link href="/mentorship" className="btn btn-sm btn-ghost" style={{ marginBottom: 6, display: "inline-flex" }}>
          ← All pairings
        </Link>
        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16 }}>
          <div>
            <div className="label">Pairing</div>
            <h1 style={{ fontFamily: "var(--serif)", fontSize: 28, marginTop: 4, lineHeight: 1.15 }}>
              {mentor?.name ?? "—"}{" "}
              <span style={{ color: "var(--ink-3)", fontWeight: 400 }}>↔</span>{" "}
              {teacher?.fullName ?? "—"}
              {teacher?.hindiName ? (
                <span style={{ fontFamily: "var(--deva)", color: "var(--ink-3)", marginLeft: 10, fontSize: 18 }}>
                  {teacher.hindiName}
                </span>
              ) : null}
            </h1>
            <p style={{ color: "var(--ink-3)", marginTop: 4, fontSize: 13 }}>
              <span className="chip chip-ink" style={{ marginRight: 8 }}>{pairing.status}</span>
              Q{currentQuarter} · Started{" "}
              {new Date(pairing.startedAt).toLocaleDateString("en-IN", {
                day: "numeric",
                month: "long",
                year: "numeric",
              })}
              {pairing.meetingsCount != null ? ` · ${pairing.meetingsCount} meetings` : ""}
            </p>
          </div>
        </div>

        {/* Quarterly progress strip */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginTop: 18 }}>
          {QUARTERS.map((q, i) => {
            const qNum = i + 1;
            const state = currentQuarter >= qNum ? (qNum < currentQuarter ? "done" : "current") : "future";
            const subtitle =
              qNum === 1
                ? "Baseline + onboarding"
                : qNum === 2
                  ? "First developmental cycle"
                  : qNum === 3
                    ? "Mid-year evaluation"
                    : "Endline + certification";
            return (
              <div
                key={q}
                className="card"
                style={{
                  padding: 12,
                  background: state === "current" ? "var(--paper-2)" : "var(--card)",
                  borderColor: state === "current" ? "var(--ink)" : "var(--line)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div
                    style={{
                      width: 22,
                      height: 22,
                      borderRadius: "50%",
                      background:
                        state === "done"
                          ? "var(--lichen)"
                          : state === "current"
                            ? "var(--ink)"
                            : "var(--paper-3)",
                      color: state === "future" ? "var(--ink-3)" : "white",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontFamily: "var(--mono)",
                      fontSize: 11,
                      fontWeight: 600,
                    }}
                  >
                    {state === "done" ? "✓" : qNum}
                  </div>
                  <span style={{ fontWeight: 500, fontSize: 12 }}>{QUARTER_LABEL[q].split(" · ")[0]}</span>
                  <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--ink-3)" }}>
                    {state === "done" ? "Closed" : state === "current" ? "In progress" : "Upcoming"}
                  </span>
                </div>
                <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 6 }}>{subtitle}</div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="page-body" style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr", gap: 18 }}>
        <div style={{ display: "grid", gap: 14 }}>
          <div className="card card-hi">
            <div
              style={{
                padding: "14px 16px",
                borderBottom: "1px solid var(--line)",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <div>
                <h2 style={{ fontFamily: "var(--serif)", fontSize: 16, margin: 0 }}>
                  Meetings & touchpoints
                </h2>
                <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>
                  Mentor logs every contact — phone, video, in-person, WhatsApp
                </div>
              </div>
              <span className="chip">{meetings.length}</span>
            </div>
            {meetings.length === 0 ? (
              <p style={{ padding: 16, fontSize: 12, color: "var(--ink-3)", margin: 0 }}>
                No meetings logged yet.
              </p>
            ) : (
              <div>
                {meetings.map((m, i) => {
                  const d = new Date(m.scheduledAt);
                  const day = String(d.getDate()).padStart(2, "0");
                  const mon = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"][d.getMonth()];
                  return (
                    <div
                      key={m.id}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "60px 1fr",
                        gap: 14,
                        padding: 16,
                        borderTop: i ? "1px solid var(--line)" : "none",
                      }}
                    >
                      <div style={{ textAlign: "center" }}>
                        <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--ink-3)" }}>{day}</div>
                        <div style={{ fontSize: 10, color: "var(--ink-4)", textTransform: "uppercase" }}>{mon}</div>
                      </div>
                      <div>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{ fontWeight: 500 }}>
                            {d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" })}
                          </span>
                          {m.durationMin ? (
                            <span className="chip" style={{ marginLeft: "auto" }}>{m.durationMin}m</span>
                          ) : null}
                        </div>
                        {m.notes ? (
                          <p style={{ fontSize: 13, color: "var(--ink-2)", marginTop: 6, lineHeight: 1.5 }}>
                            {m.notes}
                          </p>
                        ) : null}
                        {m.recordingVideoId ? (
                          <Link
                            href={`/videos/${m.recordingVideoId}`}
                            style={{ fontSize: 11, color: "var(--indigo)", marginTop: 4, display: "inline-block" }}
                          >
                            Open recording →
                          </Link>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <div style={{ display: "grid", gap: 14, alignContent: "start" }}>
          <div className="card card-hi">
            <div
              style={{
                padding: "14px 16px",
                borderBottom: "1px solid var(--line)",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <div>
                <h2 style={{ fontFamily: "var(--serif)", fontSize: 16, margin: 0 }}>
                  Q{currentQuarter} progress feedback
                </h2>
                <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>
                  4 mentor + 4 mentee forms across the year
                </div>
              </div>
              <span className="chip chip-saffron">{feedbackByKind.size}/8</span>
            </div>
            <div style={{ padding: 14, fontSize: 12 }}>
              <p style={{ color: "var(--ink-2)", lineHeight: 1.5, margin: 0 }}>
                Mentor must complete an 8-question feedback form at the end of each quarter.
                Auto-saves draft. Closes the quarter on submit.
              </p>
              <div
                style={{
                  marginTop: 10,
                  display: "flex",
                  justifyContent: "space-between",
                  color: "var(--ink-3)",
                }}
              >
                <span>Forms completed</span>
                <span style={{ fontFamily: "var(--mono)" }}>{feedbackByKind.size} / 8 done</span>
              </div>
              <div className="bar" style={{ marginTop: 6 }}>
                <div style={{ width: `${feedbackPct}%` }} />
              </div>
            </div>
          </div>

          {pairing.conceptNote ? (
            <div className="card card-hi">
              <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--line)" }}>
                <h2 style={{ fontFamily: "var(--serif)", fontSize: 16, margin: 0 }}>Concept note</h2>
              </div>
              <div style={{ padding: 14 }}>
                <div className="label" style={{ marginBottom: 6 }}>Pairing goal</div>
                <p style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.5, margin: 0 }}>
                  {pairing.conceptNote}
                </p>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
