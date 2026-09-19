// /mentorship/[pairingId] — pairing detail: concept note + meetings + feedback lifecycle.
//
// Spec 118 (Workflow Run 9 — frontend parity Tier C) wired the action buttons:
//   - "Log meeting"   → native form POSTs to logMeetingAction (actions.ts).
//   - "WhatsApp"      → external link to wa.me/<phone>?text=<msg>.
//   - "Message"       → /inbox link (internal messaging deferred; see
//                       specs/118-.../research.md design deviations).
//   - Q1-Q4 strip     → links to /forms/<kind>-<audience>-1?pairingId=&quarter=.
//   - Commitments     → persisted on mentor_pairings.commitments. This used
//                       to render a hardcoded array of four placeholder
//                       strings, identical for every pairing, with a toggle
//                       that wrote an audit row and changed nothing.
//   - "Complete"      → completePairingAction (super_admin + programme_admin).

import { redirect } from "next/navigation";
import { actorFrom, assertCanAccessPairing } from "@/lib/authz";
import Link from "next/link";
import { and, eq, desc } from "drizzle-orm";
import { db } from "@gml/db";
import {
  mentors,
  teachers,
  mentorMeetings,
  feedbackForms,
  feedbackResponses,
} from "@gml/db/schema";
import { auth } from "@/auth";
import { hasAnyRole } from "@gml/shared/auth/roles";
import { getDeviceType } from "@/lib/device";
import { MobileDetailFrame } from "@/components/shells";
import {
  logMeetingAction,
  completePairingAction,
  toggleCommitmentAction,
  addCommitmentAction,
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

// THE FORM SLUG IS RESOLVED FROM THE DATABASE, NOT ASSEMBLED FROM CONSTANTS.
//
// What stood here was `DEFAULT_AUDIENCE = "mentor"` and `FORM_VERSION = "1"`,
// and both were wrong in a way that silently broke the quarter strip:
//
//   VERSION   progress_2 is seeded at version "2" for BOTH audiences, so the
//             Q3 link pointed at a slug matching no feedback_forms row and
//             rendered the "Form not found" shell. Q3 has never been openable
//             from this page.
//
//   AUDIENCE  Hardcoding "mentor" assumed a mentor-first surface, but this page
//             is reachable by the MENTEE -- assertCanAccessPairing admits the
//             teacher on the pairing, by design, and the mentee's own contact
//             card is rendered on it. A teacher clicking any quarter was sent
//             to a mentor-audience form, where the runner's audience check
//             bounced them to /forbidden. Their own quarterly form is the
//             mentee-audience one.
//
// A lookup also means the next version bump does not silently break this page
// again, which a corrected constant would not have prevented.

export default async function PairingDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ pairingId: string }>;
  searchParams?: Promise<{ logMeeting?: string; error?: string }>;
}) {
  const { pairingId } = await params;
  const sp = (await searchParams) ?? {};
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const canComplete = hasAnyRole(session.user.role, ["programme_admin", "super_admin"]);
  const showLogMeetingForm = sp.logMeeting === "1";

  // EVERY ?error= actions.ts CAN REDIRECT WITH.
  // All six were silent: the actions bounced back here on failure and the page
  // rendered nothing, so a rejected "Log meeting" or "Add commitment" looked
  // exactly like a successful one that had not appeared yet. Unknown codes fall
  // through to a generic sentence rather than rendering the raw code.
  const PAIRING_ERRORS: Record<string, string> = {
    invalid_meeting: "A meeting needs both a date and a time. Nothing was saved.",
    invalid_meeting_time: "That meeting date could not be read. Please pick it again.",
    invalid_pairing: "That pairing reference was not valid.",
    pairing_not_found: "That pairing no longer exists.",
    invalid_commitment: "That commitment reference was not valid.",
    empty_commitment: "A commitment needs some text before it can be added.",
    commitments_full:
      "This pairing already has the maximum of 50 commitments. Mark some done before adding more.",
  };
  const pairingError = sp.error
    ? (PAIRING_ERRORS[sp.error] ?? "That action could not be completed. Please try again.")
    : null;

  // OWNERSHIP GATE. auth() above only established that SOMEONE is signed in.
  // The page then loaded the pairing by id and rendered the mentee teacher's
  // row -- including their phone number, straight into a wa.me deep link -- so
  // any authenticated user could read any mentee's contact details from a
  // guessed UUID.
  const pairingActor = actorFrom(session);
  if (!pairingActor) redirect("/login");
  const pairing = await assertCanAccessPairing(pairingActor, pairingId);

  // Which audience's forms does THIS viewer answer? A mentor answers the
  // mentor-audience form about their mentee; the mentee answers the
  // mentee-audience one. Admins preview the mentor side.
  const formAudience = session.user.role === "teacher" ? "mentee" : "mentor";

  // Active form versions for that audience, keyed by kind. Resolved once.
  const activeForms = await db
    .select({ kind: feedbackForms.kind, version: feedbackForms.version })
    .from(feedbackForms)
    .where(and(eq(feedbackForms.audience, formAudience), eq(feedbackForms.active, true)));
  const versionByKind = new Map(activeForms.map((f) => [f.kind, f.version]));
  const [mentor] = await db.select().from(mentors).where(eq(mentors.id, pairing.mentorId)).limit(1);
  const [teacher] = await db.select().from(teachers).where(eq(teachers.id, pairing.teacherId)).limit(1);

  // assertCanAccessPairing returns the pairing row, so the commitments come
  // along with the ownership check rather than costing a second query.
  const commitments = Array.isArray(pairing.commitments) ? pairing.commitments : [];

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
      {/* Rendered inside the shared `body`, so it reaches the mobile frame and
          the desktop layout alike -- a banner added to only one of them would
          be invisible on exactly the device most meetings are logged from. */}
      {pairingError ? (
        <div
          role="alert"
          data-testid="pairing-error"
          style={{
            background: "var(--rust-soft)",
            color: "var(--rust)",
            border: "1px solid var(--rust)",
            borderRadius: "var(--r-2)",
            padding: 12,
            fontSize: 13,
            margin: "0 0 12px",
          }}
        >
          {pairingError}
        </div>
      ) : null}
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
            // No active form for this quarter yet -> no link, rather than a
            // link to a "Form not found" shell.
            const formVersion = versionByKind.get(formKind);
            const formHref = formVersion
              ? `/forms/${formKind}-${formAudience}-${formVersion}?pairingId=${pairingId}&quarter=${qNum}`
              : null;
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
                {!formHref ? (
                  // No active form published for this quarter and audience.
                  // Saying so beats a link into a "Form not found" shell.
                  state === "future" ? null : (
                    <span style={{ marginTop: 10, fontSize: 11, color: "var(--ink-3)", display: "inline-flex" }}>
                      No form published for this quarter yet.
                    </span>
                  )
                ) : state === "current" ? (
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

          {/* Commitments register.
              Until now this rendered a HARDCODED array of four placeholder
              strings -- the same four for every mentor and every teacher -- and
              the toggle wrote an audit row while persisting nothing. A mentor
              could tick an item, see nothing change, reload, and find it
              untouched. It was the one place in the application that showed
              invented content as real programme data. */}
          <div className="card card-hi">
            <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--line)" }}>
              <h2 style={{ fontFamily: "var(--serif)", fontSize: 16, margin: 0 }}>
                Commitments register
              </h2>
              <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>
                What each of you agreed to do before the next meeting.
              </div>
            </div>

            <div style={{ padding: 4 }}>
              {commitments.length === 0 ? (
                <p style={{ padding: "12px 14px", fontSize: 12, color: "var(--ink-3)", margin: 0 }}>
                  Nothing agreed yet. Add the first commitment below.
                </p>
              ) : (
                commitments.map((c, i) => (
                  <form
                    key={c.id}
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
                    {/* BY ID, not by index: an index is unstable the moment
                        anything is added or removed, so two mentors editing at
                        once would toggle each other's items. */}
                    <input type="hidden" name="commitmentId" value={c.id} />
                    <button
                      type="submit"
                      aria-label={`${c.done ? "Unmark" : "Mark"} commitment: ${c.text}`}
                      style={{
                        width: 16,
                        height: 16,
                        border: "1px solid var(--ink-3)",
                        background: c.done ? "var(--ink)" : "var(--card)",
                        borderRadius: 3,
                        cursor: "pointer",
                        padding: 0,
                      }}
                    />
                    <div>
                      <div
                        style={{
                          color: c.done ? "var(--ink-3)" : "var(--ink)",
                          textDecoration: c.done ? "line-through" : "none",
                        }}
                      >
                        {c.text}
                      </div>
                      <div style={{ fontSize: 10, color: "var(--ink-3)" }}>
                        {c.who}
                        {c.due ? ` · ${c.due}` : ""}
                      </div>
                    </div>
                    <span
                      className="mono"
                      style={{ fontSize: 10, color: "var(--ink-3)", textAlign: "right" }}
                    >
                      {c.done ? "done" : (c.due ?? "")}
                    </span>
                  </form>
                ))
              )}
            </div>

            <form
              action={addCommitmentAction}
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 90px 70px auto",
                gap: 6,
                padding: "10px 12px",
                borderTop: "1px solid var(--line)",
                alignItems: "center",
              }}
            >
              <input type="hidden" name="pairingId" value={pairingId} />
              <input
                name="text"
                required
                maxLength={500}
                placeholder="Add a commitment…"
                style={{
                  padding: "6px 8px",
                  border: "1px solid var(--line-2)",
                  borderRadius: 6,
                  fontSize: 12,
                  background: "var(--card)",
                }}
              />
              <select
                name="who"
                defaultValue="mentee"
                style={{
                  padding: "6px 4px",
                  border: "1px solid var(--line-2)",
                  borderRadius: 6,
                  fontSize: 11,
                  background: "var(--card)",
                }}
              >
                <option value="mentee">mentee</option>
                <option value="mentor">mentor</option>
              </select>
              <input
                name="due"
                maxLength={40}
                placeholder="Wk 8"
                style={{
                  padding: "6px 6px",
                  border: "1px solid var(--line-2)",
                  borderRadius: 6,
                  fontSize: 11,
                  background: "var(--card)",
                }}
              />
              <button
                type="submit"
                style={{
                  padding: "6px 12px",
                  border: "none",
                  borderRadius: 6,
                  background: "var(--ink)",
                  color: "var(--paper)",
                  fontSize: 12,
                  cursor: "pointer",
                }}
              >
                Add
              </button>
            </form>
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
