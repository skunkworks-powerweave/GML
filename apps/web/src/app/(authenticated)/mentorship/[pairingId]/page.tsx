// /mentorship/[pairingId] — pairing detail: concept note + meetings + feedback lifecycle.
//
// Spec 118 (Workflow Run 9 — frontend parity Tier C) wired the action buttons:
//   - "Log meeting"   → native form POSTs to logMeetingAction (actions.ts).
//   - "WhatsApp"      → external link to wa.me/<phone>?text=<msg>.
//   - "Message"       → /inbox link (internal messaging deferred; see
//                       specs/118-.../research.md design deviations).
//   - Q1-Q4 strip     → links to /forms/<kind>-<audience>-1?pairingId=&quarter=.
//   - Commitments     → audit-only toggle via toggleCommitmentAction (no
//                       persistence column yet; see research.md).
//   - "Complete"      → completePairingAction (super_admin + programme_admin).

import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { eq, desc } from "drizzle-orm";
import { db } from "@gml/db";
import { mentorPairings, mentors, teachers, mentorMeetings, feedbackResponses } from "@gml/db/schema";
import { auth } from "@/auth";
import { hasAnyRole } from "@gml/shared/auth/roles";
import { getDeviceType } from "@/lib/device";
import { MobileDetailFrame } from "@/components/shells";
import {
  logMeetingAction,
  completePairingAction,
  toggleCommitmentAction,
} from "./actions";

export const dynamic = "force-dynamic";

const QUARTERS = ["baseline", "progress_1", "progress_2", "final"] as const;
const QUARTER_LABEL: Record<string, string> = {
  baseline: "Q1 · Baseline",
  progress_1: "Q2 · Progress",
  progress_2: "Q3 · Progress",
  final: "Q4 · Final",
};

// Quarter index (1..4) → feedback_forms.kind value used in the /forms/ slug.
const QUARTER_TO_KIND: Record<number, (typeof QUARTERS)[number]> = {
  1: "baseline",
  2: "progress_1",
  3: "progress_2",
  4: "final",
};

// Default form audience when opening a quarter form. We pick "mentor" because
// the pairing-detail surface is mentor-first in the prototype; mentees reach
// their forms via /inbox. The audience is overridable via the URL once on the
// form page.
const DEFAULT_AUDIENCE = "mentor";
const FORM_VERSION = "1";

export default async function PairingDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ pairingId: string }>;
  searchParams?: Promise<{ logMeeting?: string }>;
}) {
  const { pairingId } = await params;
  const sp = (await searchParams) ?? {};
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const canComplete = hasAnyRole(session.user.role, ["programme_admin", "super_admin"]);
  const showLogMeetingForm = sp.logMeeting === "1";

  const [pairing] = await db.select().from(mentorPairings).where(eq(mentorPairings.id, pairingId)).limit(1);
  if (!pairing) notFound();
  const [mentor] = await db.select().from(mentors).where(eq(mentors.id, pairing.mentorId)).limit(1);
  const [teacher] = await db.select().from(teachers).where(eq(teachers.id, pairing.teacherId)).limit(1);

  // Pick a WhatsApp/Message target — the mentee (teacher) is the primary
  // contact for a mentor-led pairing. Phone may be NULL.
  const contactPhone = teacher?.phone ?? null;
  const contactName = teacher?.fullName ?? "Mentee";
  const waText = `Hi ${contactName}, checking in on our mentorship pairing.`;
  const waHref =
    contactPhone && contactPhone.replace(/[^0-9]/g, "").length >= 10
      ? `https://wa.me/${contactPhone.replace(/[^0-9]/g, "")}?text=${encodeURIComponent(waText)}`
      : null;
  const messageHref = teacher?.userId ? `/inbox?to=${teacher.userId}` : `/inbox`;

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

  // Spec 137 — device-aware adoption of MobileDetailFrame. On mobile the
  // existing two-column desktop JSX is wrapped in the thin-header + back-arrow
  // chrome the JSX prototype defines; on desktop the page renders unchanged.
  // Data-fetching, audit, and role-gate logic above stay untouched.
  const device = await getDeviceType();
  const mobileTitle = `${mentor?.name ?? "—"} ↔ ${teacher?.fullName ?? "—"}`;

  const body = (
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

          {/* Action buttons (spec 118) — Message / WhatsApp / Log meeting / Complete */}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Link href={messageHref} className="btn btn-sm" aria-label="Open message thread">
              Message
            </Link>
            {waHref ? (
              <a
                href={waHref}
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-sm"
                aria-label="Open WhatsApp chat"
              >
                WhatsApp
              </a>
            ) : (
              <span
                className="btn btn-sm"
                style={{ opacity: 0.45, cursor: "not-allowed" }}
                title="No phone on file for mentee"
                aria-disabled="true"
              >
                WhatsApp
              </span>
            )}
            <Link
              href={`/mentorship/${pairingId}?logMeeting=1`}
              className="btn btn-sm btn-primary"
              aria-label="Log a new meeting"
            >
              + Log meeting
            </Link>
            {canComplete && pairing.status !== "complete" ? (
              <form action={completePairingAction}>
                <input type="hidden" name="pairingId" value={pairingId} />
                <button
                  type="submit"
                  className="btn btn-sm"
                  aria-label="Mark pairing complete"
                  style={{ background: "var(--lichen)", color: "white", borderColor: "var(--lichen)" }}
                >
                  Complete pairing
                </button>
              </form>
            ) : null}
          </div>
        </div>

        {/* Inline "Log meeting" form — shown when ?logMeeting=1 */}
        {showLogMeetingForm ? (
          <form
            action={logMeetingAction}
            className="card"
            style={{ padding: 14, marginTop: 12, background: "var(--paper-2)", display: "grid", gap: 10 }}
          >
            <input type="hidden" name="pairingId" value={pairingId} />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 120px", gap: 10 }}>
              <label style={{ fontSize: 12 }}>
                <div className="label" style={{ marginBottom: 4 }}>When *</div>
                <input
                  type="datetime-local"
                  name="scheduledAt"
                  required
                  style={{
                    width: "100%",
                    padding: "6px 8px",
                    border: "1px solid var(--line)",
                    borderRadius: 4,
                  }}
                />
              </label>
              <label style={{ fontSize: 12 }}>
                <div className="label" style={{ marginBottom: 4 }}>Duration (min)</div>
                <input
                  type="text"
                  name="durationMin"
                  placeholder="42"
                  style={{
                    width: "100%",
                    padding: "6px 8px",
                    border: "1px solid var(--line)",
                    borderRadius: 4,
                  }}
                />
              </label>
            </div>
            <label style={{ fontSize: 12 }}>
              <div className="label" style={{ marginBottom: 4 }}>Notes</div>
              <textarea
                name="notes"
                rows={3}
                placeholder="What was discussed, what did the mentee commit to?"
                style={{
                  width: "100%",
                  padding: "6px 8px",
                  border: "1px solid var(--line)",
                  borderRadius: 4,
                  resize: "vertical",
                }}
              />
            </label>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <Link href={`/mentorship/${pairingId}`} className="btn btn-sm btn-ghost">
                Cancel
              </Link>
              <button type="submit" className="btn btn-sm btn-primary">
                Save meeting
              </button>
            </div>
          </form>
        ) : null}

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
            const formKind = QUARTER_TO_KIND[qNum];
            const formSlug = `${formKind}-${DEFAULT_AUDIENCE}-${FORM_VERSION}`;
            const formHref = `/forms/${formSlug}?pairingId=${pairingId}&quarter=${qNum}`;
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
                {state === "current" ? (
                  <Link
                    href={formHref}
                    className="btn btn-sm"
                    style={{ marginTop: 10, fontSize: 11, display: "inline-flex" }}
                    aria-label={`Fill Q${qNum} progress form`}
                  >
                    Fill progress form →
                  </Link>
                ) : state === "future" ? null : (
                  <Link
                    href={formHref}
                    className="btn btn-sm btn-ghost"
                    style={{ marginTop: 10, fontSize: 11, display: "inline-flex" }}
                    aria-label={`View Q${qNum} responses`}
                  >
                    View responses →
                  </Link>
                )}
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

          {/* Commitments register (spec 118) — v1 audit-only stub. The
              `commitments` jsonb column is not yet on mentor_pairings; the
              toggle action records an audit row instead so clicks are not
              silently dropped. See specs/118-.../research.md. */}
          <div className="card card-hi">
            <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--line)" }}>
              <h2 style={{ fontFamily: "var(--serif)", fontSize: 16, margin: 0 }}>
                Commitments register
              </h2>
              <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>
                Click a row to mark/unmark. Persistence lands in the next migration.
              </div>
            </div>
            <div style={{ padding: 4 }}>
              {[
                { t: "Use 4-minute cool-down in every lesson", who: "mentee", due: "Wk 8" },
                { t: "Share sound-box video with cohort", who: "mentor", due: "Wk 7" },
                { t: "Co-teach with mentee at school visit", who: "mentor", due: "Wk 6" },
                { t: "Track exit-ticket completion daily", who: "mentee", due: "Wk 7" },
              ].map((c, i) => (
                <form
                  key={i}
                  action={toggleCommitmentAction}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "20px 1fr 60px",
                    gap: 10,
                    padding: "8px 12px",
                    borderTop: i ? "1px solid var(--line)" : "none",
                    fontSize: 12,
                    alignItems: "center",
                  }}
                >
                  <input type="hidden" name="pairingId" value={pairingId} />
                  <input type="hidden" name="index" value={i} />
                  <input type="hidden" name="text" value={c.t} />
                  <input type="hidden" name="done" value="true" />
                  <button
                    type="submit"
                    aria-label={`Toggle commitment: ${c.t}`}
                    style={{
                      width: 16,
                      height: 16,
                      border: "1px solid var(--ink-3)",
                      background: "var(--card)",
                      borderRadius: 3,
                      cursor: "pointer",
                      padding: 0,
                    }}
                  />
                  <div>
                    <div style={{ color: "var(--ink)" }}>{c.t}</div>
                    <div style={{ fontSize: 10, color: "var(--ink-3)" }}>
                      {c.who} · {c.due}
                    </div>
                  </div>
                  <span
                    className="mono"
                    style={{ fontSize: 10, color: "var(--ink-3)", textAlign: "right" }}
                  >
                    {c.due}
                  </span>
                </form>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  return device === "mobile" ? (
    <MobileDetailFrame title={mobileTitle} backHref="/mentorship">
      {body}
    </MobileDetailFrame>
  ) : (
    body
  );
}
