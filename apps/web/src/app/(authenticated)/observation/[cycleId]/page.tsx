// /observation/[cycleId] — cycle drill-in with 5-step flow diagram.
// Status: nominated → pre_submitted → observed → post_submitted → complete
//
// Spec 117 (frontend-parity Tier B): wires the six interactive elements the
// JSX prototype (`LMS GML Frontend/observation-detail.jsx`) ships but the
// real page did not — pre/observer/post form submit, sign-off CTA, add-note,
// and the video-upload context handle. All status transitions go through
// guarded server actions in ./actions.ts.

import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { hasAnyRole } from "@gml/shared/auth/roles";
import { actorFrom, assertCanAccessCycle } from "@/lib/authz";
import Link from "next/link";
import { eq } from "drizzle-orm";
import { db } from "@gml/db";
import { teachers, subjects, observationForms, observationEvidence } from "@gml/db/schema";
import { UploadProgress } from "@/components/video/UploadProgress";
import { getDeviceType } from "@/lib/device";
import { MobileDetailFrame } from "@/components/shells";
import {
  submitPreFormAction,
  submitObserverFormAction,
  submitPostFormAction,
  signOffCycleAction,
  addNoteAction,
} from "./actions";

export const dynamic = "force-dynamic";

const CYCLE_STAGES = [
  { id: "nominated", label: "Nominated" },
  { id: "pre_submitted", label: "Pre-form" },
  { id: "observed", label: "Observed" },
  { id: "post_submitted", label: "Post-form" },
  { id: "complete", label: "Complete" },
];

export default async function CycleDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ cycleId: string }>;
  searchParams?: Promise<{ error?: string }>;
}) {
  const { cycleId } = await params;
  const sp = (await searchParams) ?? {};
  const error = (sp.error ?? "").trim();

  const CYCLE_ERRORS: Record<string, { message: string; tone: "warn" | "error" }> = {
    invalid_transition: {
      message:
        "That action can't be performed in the cycle's current status. The page has been refreshed.",
      tone: "error",
    },
    empty_note: { message: "Note text can't be empty.", tone: "warn" },
    submit_failed: {
      message:
        "Your answers could not be saved and nothing was recorded. Please try submitting the form again.",
      tone: "error",
    },
    invalid_cycle: { message: "That cycle reference was not valid.", tone: "error" },
    cycle_not_found: { message: "That cycle no longer exists.", tone: "error" },
  };
  const cycleError = error
    ? (CYCLE_ERRORS[error] ?? {
        message: "That action could not be completed. Please try again.",
        tone: "error" as const,
      })
    : null;

  // OWNERSHIP GATE. This page did not call auth() at all -- it was login-gated
  // only by the proxy policy and the (authenticated) layout, then loaded the
  // cycle by id with no ownership predicate. Any signed-in user could read any
  // teacher's evaluative observation, including its form responses and the
  // mentor's private remark.
  //
  // Note the layout alone was never sufficient here: layouts and pages render
  // in PARALLEL in the App Router, so this query would begin before the
  // layout's redirect() resolved.
  //
  // assertCanAccessCycle returns the row, so this replaces the old SELECT.
  const session = await auth();
  const actor = actorFrom(session);
  if (!actor) redirect("/login");
  const cycle = await assertCanAccessCycle(actor, cycleId);

  const [teacher] = await db.select().from(teachers).where(eq(teachers.id, cycle.teacherId)).limit(1);
  const [subject] = cycle.subjectId
    ? await db.select().from(subjects).where(eq(subjects.id, cycle.subjectId)).limit(1)
    : [null];
  const forms = await db.select().from(observationForms).where(eq(observationForms.cycleId, cycleId));
  const evidence = await db.select().from(observationEvidence).where(eq(observationEvidence.cycleId, cycleId));

  const currentStageIdx = CYCLE_STAGES.findIndex((s) => s.id === cycle.status);

  const kindChipClass =
    cycle.kind === "developmental"
      ? "chip chip-saffron"
      : cycle.kind === "evaluative"
        ? "chip chip-indigo"
        : "chip";
  const statusChipClass =
    cycle.status === "complete"
      ? "chip chip-lichen"
      : cycle.status === "post_submitted" || cycle.status === "pre_submitted"
        ? "chip chip-saffron"
        : cycle.status === "observed"
          ? "chip chip-indigo"
          : "chip";

  // CTA gating — each form may only be submitted once, and only when the
  // cycle is in the expected upstream status.
  // ROLE, NOT JUST STATUS.
  //
  // These four flags gated purely on cycle.status, while every action behind
  // them role-gates with requireRole() and redirects to /forbidden on a
  // mismatch. So the page showed a teacher a "Sign off cycle" button -- the
  // terminal, locking transition, which only a mentor or an administrator may
  // perform -- and clicking it threw her out of the cycle onto a permissions
  // error. Rendering a control that the server will refuse is worse than
  // hiding it: it reads as a permission that has been revoked rather than one
  // that was never held.
  //
  // Each list mirrors the requireRole() list of the action it triggers. If one
  // changes, both must.
  // `actor` is the narrowed, non-null form -- the redirect above guarantees it.
  const viewerRole = actor.role;
  const canSubmitPre =
    cycle.status === "nominated" &&
    hasAnyRole(viewerRole, ["teacher", "observer", "mentor", "programme_admin", "super_admin"]);
  const canSubmitObserver =
    cycle.status === "pre_submitted" &&
    hasAnyRole(viewerRole, ["observer", "mentor", "programme_admin", "super_admin"]);
  const canSubmitPost =
    cycle.status === "observed" &&
    hasAnyRole(viewerRole, ["teacher", "observer", "mentor", "programme_admin", "super_admin"]);
  const canSignOff =
    cycle.status === "post_submitted" &&
    hasAnyRole(viewerRole, ["mentor", "programme_admin", "super_admin"]);
  // addNoteAction: observer, mentor, programme_admin, super_admin.
  const canAddNote = hasAnyRole(viewerRole, [
    "observer",
    "mentor",
    "programme_admin",
    "super_admin",
  ]);

  // Spec 137 — device-aware adoption of MobileDetailFrame. On mobile the
  // existing single-column flow is wrapped in the thin-header + back-arrow
  // chrome the JSX prototype defines. The sign-off CTA migrates to the
  // sticky-bottom slot when active (so it stays reachable on long scrolls);
  // desktop continues to render the inline header CTA unchanged.
  const device = await getDeviceType();
  const mobileTitle = teacher?.fullName ?? cycle.code ?? "Cycle";
  const stickyAction =
    canSignOff ? (
      <form action={signOffCycleAction}>
        <input type="hidden" name="cycleId" value={cycleId} />
        <button type="submit" className="btn btn-primary btn-sm">
          Sign off cycle
        </button>
      </form>
    ) : undefined;

  const body = (
    <div>
      <header style={{ marginBottom: 20, display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16 }}>
        <div>
          <Link href="/observation" className="btn btn-sm btn-ghost" style={{ marginBottom: 6 }}>
            ← All cycles
          </Link>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
            <span className="mono" style={{ fontSize: 12, color: "var(--ink-3)" }}>{cycle.code}</span>
            <span className={kindChipClass}>{cycle.kind}</span>
            <span className={statusChipClass}>{cycle.status.replace(/_/g, " ")}</span>
          </div>
          <h1 className="serif" style={{ fontSize: 26, marginTop: 6 }}>
            {teacher?.fullName ?? "—"}
            {teacher?.hindiName ? (
              <span style={{ fontFamily: "var(--deva)", color: "var(--ink-3)", marginLeft: 10, fontSize: 18 }}>
                {teacher.hindiName}
              </span>
            ) : null}
          </h1>
          <p style={{ color: "var(--ink-3)", fontSize: 13, marginTop: 4 }}>
            {subject ? `${subject.name}` : null}
            {subject && cycle.topic ? " · " : null}
            {cycle.topic ? `${cycle.topic}` : null}
            {(subject || cycle.topic) && cycle.scheduledAt ? " · " : null}
            {cycle.scheduledAt
              ? new Date(cycle.scheduledAt).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })
              : null}
          </p>
        </div>
        {canSignOff ? (
          <form action={signOffCycleAction}>
            <input type="hidden" name="cycleId" value={cycleId} />
            <button type="submit" className="btn btn-primary">
              Sign off cycle
            </button>
          </form>
        ) : null}
      </header>

      {/* EVERY ?error= actions.ts CAN ISSUE.
          Only invalid_transition and empty_note had branches. submit_failed --
          the code a FAILED TRANSACTION redirects with, when a form submission
          was rolled back and nothing was saved -- rendered nothing at all, so
          the most consequential failure on this page was also its quietest:
          the user saw the cycle again, unchanged, with no indication their
          answers had been discarded. Unknown codes get a generic sentence
          rather than the raw code. */}
      {cycleError ? (
        <div
          role="alert"
          data-testid="cycle-error"
          data-error={error}
          style={{
            background: cycleError.tone === "warn" ? "var(--saffron-soft)" : "var(--rust-soft)",
            color: cycleError.tone === "warn" ? undefined : "var(--rust)",
            border:
              cycleError.tone === "warn"
                ? "1px solid oklch(0.82 0.08 60)"
                : "1px solid var(--rust)",
            borderRadius: "var(--r-2)",
            padding: 12,
            fontSize: 13,
            marginBottom: 16,
          }}
        >
          {cycleError.message}
        </div>
      ) : null}

      {/* Cycle Flow Diagram */}
      <section style={{ marginBottom: 24 }}>
        <div className="card card-hi" style={{ padding: 14 }}>
          <div className="stepper">
            {CYCLE_STAGES.map((stage, i) => {
              const isPast = i < currentStageIdx;
              const isCurrent = i === currentStageIdx;
              const stepClass = `step${isPast ? " done" : ""}${isCurrent ? " active" : ""}`;
              return (
                <span key={stage.id} style={{ display: "contents" }}>
                  <div className={stepClass}>
                    <span className="num">{isPast ? "✓" : i + 1}</span>
                    <span>{stage.label}</span>
                  </div>
                  {i < CYCLE_STAGES.length - 1 ? <span className="sep">·····</span> : null}
                </span>
              );
            })}
          </div>
        </div>
      </section>

      <section style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
        <article className="card card-hi" style={{ padding: 16 }}>
          <div className="label" style={{ marginBottom: 6 }}>Forms · {forms.length}</div>
          <h2 className="serif" style={{ fontSize: 16, marginBottom: 12 }}>Pre &amp; post-observation</h2>
          {forms.length === 0 ? (
            <p style={{ fontSize: 12, color: "var(--ink-3)" }}>No forms submitted yet.</p>
          ) : (
            <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 8 }}>
              {forms.map((f) => (
                <li
                  key={f.id}
                  className="card"
                  style={{ padding: 10, fontSize: 12, boxShadow: "none" }}
                >
                  <span className="chip chip-ink" style={{ fontSize: 10 }}>{f.kind}</span>
                  <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 6 }}>
                    Submitted <span className="mono">{new Date(f.submittedAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {/* CTA: Submit pre-form */}
          {canSubmitPre ? (
            <form action={submitPreFormAction} style={{ marginTop: 12, display: "grid", gap: 8 }}>
              <input type="hidden" name="cycleId" value={cycleId} />
              <label className="label" style={{ fontSize: 11 }}>Lesson plan summary</label>
              <textarea
                name="lessonPlanSummary"
                rows={3}
                required
                className="text"
                placeholder="What will you teach today?"
                style={{ fontSize: 13 }}
              />
              <button type="submit" className="btn btn-primary btn-sm">
                Submit pre-form
              </button>
            </form>
          ) : null}

          {/* CTA: Submit observer-form */}
          {canSubmitObserver ? (
            <form action={submitObserverFormAction} style={{ marginTop: 12, display: "grid", gap: 8 }}>
              <input type="hidden" name="cycleId" value={cycleId} />
              <label className="label" style={{ fontSize: 11 }}>Observer rubric notes</label>
              <textarea
                name="narrativeComments"
                rows={3}
                required
                className="text"
                placeholder="Rubric narrative…"
                style={{ fontSize: 13 }}
              />
              <button type="submit" className="btn btn-primary btn-sm">
                Submit observer-form
              </button>
            </form>
          ) : null}

          {/* CTA: Submit post-form */}
          {canSubmitPost ? (
            <form action={submitPostFormAction} style={{ marginTop: 12, display: "grid", gap: 8 }}>
              <input type="hidden" name="cycleId" value={cycleId} />
              <label className="label" style={{ fontSize: 11 }}>What worked / What didn&apos;t</label>
              <textarea
                name="whatWorked"
                rows={3}
                required
                className="text"
                placeholder="Reflect on the lesson…"
                style={{ fontSize: 13 }}
              />
              <button type="submit" className="btn btn-primary btn-sm">
                Submit post-form
              </button>
            </form>
          ) : null}
        </article>

        <article className="card card-hi" style={{ padding: 16 }}>
          <div className="label" style={{ marginBottom: 6 }}>Evidence · {evidence.length}</div>
          <h2 className="serif" style={{ fontSize: 16, marginBottom: 12 }}>Lesson video</h2>
          {evidence.length === 0 ? (
            <p style={{ fontSize: 12, color: "var(--ink-3)" }}>
              No video evidence linked yet. Teacher uploads via WhatsApp with caption{" "}
              <span className="kbd">OBS-{cycle.code.replace(/^OBS-/, "")}</span>.
            </p>
          ) : (
            <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 8 }}>
              {evidence.map((e) => (
                <li
                  key={e.id}
                  className="card"
                  style={{ padding: 10, fontSize: 12, boxShadow: "none" }}
                >
                  <div style={{ fontWeight: 500 }}>
                    {e.videoSubmissionId ? (
                      <Link href={`/videos/${e.videoSubmissionId}`}>
                        Open video →
                      </Link>
                    ) : (
                      <span style={{ color: "var(--ink-3)" }}>(no video yet)</span>
                    )}
                  </div>
                  {e.caption ? <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 4 }}>{e.caption}</div> : null}
                </li>
              ))}
            </ul>
          )}

          {/* CTA: direct browser video upload — context wired to this cycle. */}
          <div style={{ marginTop: 12 }}>
            <UploadProgress contextType="observation_cycle" contextId={cycleId} />
          </div>
        </article>
      </section>

      {/* APPEND a mentor note. Deliberately not an edit surface.
          This block used to pre-fill the textarea with the ENTIRE existing
          remark and label the button "Update note", while addNoteAction
          appends a timestamped entry. Pressing it therefore appended a second
          copy of every note already written -- growing the remark
          exponentially with each press -- and the label promised an edit the
          action has never performed. The notes are an append-only written
          record of an observer's judgement about a named teacher's lesson, so
          the fix is to make the UI honest about that rather than to make the
          action destructive. */}
      <section className="card card-hi" style={{ marginTop: 18, padding: 16 }}>
        <div className="label" style={{ marginBottom: 6 }}>Remark</div>
        <h2 className="serif" style={{ fontSize: 16, marginBottom: 8 }}>Mentor notes</h2>
        {cycle.remark ? (
          // whiteSpace: pre-wrap so the blank line between appended entries,
          // and the timestamp each one carries, survive rendering.
          <p
            style={{
              fontSize: 13,
              color: "var(--ink-2)",
              lineHeight: 1.5,
              marginBottom: 12,
              whiteSpace: "pre-wrap",
            }}
          >
            {cycle.remark}
          </p>
        ) : (
          <p style={{ fontSize: 12, color: "var(--ink-3)", marginBottom: 12 }}>No mentor note yet.</p>
        )}
        {canAddNote ? (
        <form action={addNoteAction} style={{ display: "grid", gap: 8 }}>
          <input type="hidden" name="cycleId" value={cycleId} />
          <textarea
            name="note"
            rows={3}
            required
            className="text"
            placeholder="Add a note. Existing notes are kept above."
            style={{ fontSize: 13 }}
          />
          <div>
            <button type="submit" className="btn btn-sm">
              Add note
            </button>
          </div>
        </form>
        ) : null}
      </section>
    </div>
  );

  return device === "mobile" ? (
    <MobileDetailFrame
      title={mobileTitle}
      backHref="/observation"
      stickyAction={stickyAction}
    >
      {body}
    </MobileDetailFrame>
  ) : (
    body
  );
}
