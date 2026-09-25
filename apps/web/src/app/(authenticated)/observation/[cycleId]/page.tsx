// /observation/[cycleId] — cycle drill-in with 5-step flow diagram.
// Status: nominated → pre_submitted → observed → post_submitted → complete
//
// Spec 117 (frontend-parity Tier B): wires the six interactive elements the
// JSX prototype (`LMS GML Frontend/observation-detail.jsx`) ships but the
// real page did not — pre/observer/post form submit, sign-off CTA, add-note,
// and the video-upload context handle. All status transitions go through
// guarded server actions in ./actions.ts.

import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { hasAnyRole } from "@gml/shared/auth/roles";
import { actorFrom, assertCanAccessCycle } from "@/lib/authz";
import Link from "next/link";
import { eq } from "drizzle-orm";
import { db } from "@gml/db";
import { teachers, subjects, observationEvidence } from "@gml/db/schema";
import { UploadProgress } from "@/components/video/UploadProgress";
import { uploadHref } from "@/app/(authenticated)/uploads/context";
import { Fragment } from "react";
import { loadSubmittedForms, STAGE_FORMS, stageFieldLabel, type StageKind } from "@/lib/observation/forms";
import { parseNotes } from "@/lib/observation/notes";
import { SubmittedForms } from "./SubmittedForms";
import { DraftTextarea } from "./DraftTextarea";
import { draftScope } from "@/lib/observation/drafts";
import { MAX_TEXT_LENGTH } from "@/lib/forms/validate";
import { getDeviceType } from "@/lib/device";
import { lookupOwn } from "@/lib/lookup";
import { MobileDetailFrame } from "@/components/shells";
import {
  submitPreFormAction,
  submitObserverFormAction,
  submitPostFormAction,
  signOffCycleAction,
  addNoteAction,
} from "./actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Observation cycle" };

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
  searchParams?: Promise<{ error?: string; field?: string }>;
}) {
  const { cycleId } = await params;
  const sp = (await searchParams) ?? {};
  // A repeated ?error=a&error=b arrives as an array, which has no trim().
  const error = typeof sp.error === "string" ? sp.error.trim() : "";
  // Only a known question's label is echoed back, never the raw parameter.
  const invalidField = stageFieldLabel(typeof sp.field === "string" ? sp.field.trim() : "");

  const CYCLE_ERRORS: Record<string, { message: string; tone: "warn" | "error" }> = {
    invalid_form: {
      // The limit is stated: "too long" told nobody how long was allowed.
      message: `${invalidField ? `"${invalidField}"` : "An answer"} was blank or longer than ${MAX_TEXT_LENGTH.toLocaleString("en-IN")} characters, so nothing was recorded and the cycle has not moved on. Please correct it and submit again.`,
      tone: "warn",
    },
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
    cycle_locked: {
      message: "This cycle has been signed off. Its record is closed, so nothing more can be added to it.",
      tone: "warn",
    },
    invalid_cycle: { message: "That cycle reference was not valid.", tone: "error" },
    cycle_not_found: { message: "That cycle no longer exists.", tone: "error" },
  };
  const cycleError = error
    ? (lookupOwn(CYCLE_ERRORS, error) ?? {
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
  // The SUBMITTED forms, with their answers and who submitted each. This used
  // to be `select *` rendered as a kind chip and a timestamp: the answers were
  // shown to nobody, so the observer never read the lesson plan, the teacher
  // never read the rubric, and sign-off happened blind. Seed templates in the
  // same table are dropped here rather than counted as submissions.
  const forms = await loadSubmittedForms(db, cycleId, teacher?.userId ?? null);
  const evidence = await db.select().from(observationEvidence).where(eq(observationEvidence.cycleId, cycleId));
  const notes = parseNotes(cycle.remark);
  // What each textarea keeps if a submit is refused, keyed to this viewer and
  // this version of the cycle (lib/observation/drafts.ts).
  const drafts = { userId: actor.id, cycleId, version: String(cycle.updatedAt.getTime()) };

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
  // SIGNED OFF IS CLOSED. Sign-off is the locking transition, so a complete
  // cycle offers no note form and no upload; addNoteAction refuses a note on
  // the server as well. The upload path's own refusal (beginUploadAction and
  // finalizeUpload) belongs to the upload plumbing, not to this page.
  const locked = cycle.status === "complete";
  // addNoteAction: observer, mentor, programme_admin, super_admin.
  const canAddNote =
    !locked && hasAnyRole(viewerRole, ["observer", "mentor", "programme_admin", "super_admin"]);

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
      <header style={{ marginBottom: 20, display: "flex", alignItems: "flex-end", justifyContent: "space-between", flexWrap: "wrap", gap: 16 }}>
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
          {/* flex-wrap: five steps in one row are ~500 px, so on a phone
              "Post-form" and "Complete" sat off screen. */}
          <div className="stepper flex-wrap">
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

      {/* One column below 768 px, two beside each other above it. This was an
          inline "1fr 1fr", which holds at every width: on a phone the pre-form
          textarea was 96 px wide and the Evidence card, with the upload tray
          teachers use from their phones, was pushed off screen. */}
      <section className="grid grid-cols-1 gap-[18px] md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <article className="card card-hi" style={{ padding: 16 }}>
          <div className="label" style={{ marginBottom: 6 }}>Forms · {forms.length}</div>
          <h2 className="serif" style={{ fontSize: 16, marginBottom: 12 }}>Pre &amp; post-observation</h2>
          <SubmittedForms forms={forms} />

          {/* CTA: Submit pre-form */}
          {canSubmitPre ? (
            <form action={submitPreFormAction} style={{ marginTop: 12, display: "grid", gap: 8 }}>
              <input type="hidden" name="cycleId" value={cycleId} />
              <StageFields kind="pre" drafts={drafts} />
              <button type="submit" className="btn btn-primary btn-sm">
                Submit pre-form
              </button>
            </form>
          ) : null}

          {/* CTA: Submit observer-form */}
          {canSubmitObserver ? (
            <form action={submitObserverFormAction} style={{ marginTop: 12, display: "grid", gap: 8 }}>
              <input type="hidden" name="cycleId" value={cycleId} />
              <StageFields kind="observer" drafts={drafts} />
              <button type="submit" className="btn btn-primary btn-sm">
                Submit observer-form
              </button>
            </form>
          ) : null}

          {/* CTA: Submit post-form */}
          {canSubmitPost ? (
            <form action={submitPostFormAction} style={{ marginTop: 12, display: "grid", gap: 8 }}>
              <input type="hidden" name="cycleId" value={cycleId} />
              <StageFields kind="post" drafts={drafts} />
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
            {locked ? (
              <p style={{ fontSize: 12, color: "var(--ink-3)" }}>
                Signed off — this record is closed and accepts no further evidence.
              </p>
            ) : (
              <>
                <UploadProgress contextType="observation_cycle" contextId={cycleId} />
                {/* The upload page, bound to this cycle: the phone flow (record
                    with the camera) and the exact WhatsApp caption live there. */}
                <Link
                  href={uploadHref({ contextType: "observation_cycle", contextId: cycleId })}
                  style={{ display: "inline-block", marginTop: 8, fontSize: 12, color: "var(--indigo)" }}
                >
                  Record on a phone, or send by WhatsApp →
                </Link>
              </>
            )}
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
        {/* "Notes", not "Mentor notes": observers and administrators write
            here too, and each entry now names its author and role. */}
        <h2 className="serif" style={{ fontSize: 16, marginBottom: 8 }}>Notes</h2>
        {notes.length > 0 ? (
          // ENTRY BY ENTRY, not the column printed whole. Printed pre-wrap, a
          // note holding a blank line and a line shaped like an entry header
          // read as a separate entry by whoever it named. Each entry's author
          // is now its own markup; what a body says stays inside it.
          <ol style={{ listStyle: "none", padding: 0, margin: "0 0 12px", display: "grid", gap: 10 }}>
            {notes.map((n, i) => (
              <li key={i} data-note-entry="" style={{ borderLeft: "2px solid var(--line)", paddingLeft: 10 }}>
                <div data-note-author="" style={{ fontSize: 11, color: "var(--ink-3)" }}>
                  {n.author ? (
                    <>
                      <strong style={{ color: "var(--ink)" }}>{n.author}</strong> ({n.role})
                    </>
                  ) : (
                    "Earlier note"
                  )}
                  {n.at ? <span className="mono">{` · ${n.at} UTC`}</span> : null}
                </div>
                {/* pre-wrap keeps the line breaks inside the note. */}
                <p
                  data-note-body=""
                  style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.5, margin: "2px 0 0", whiteSpace: "pre-wrap" }}
                >
                  {n.body}
                </p>
              </li>
            ))}
          </ol>
        ) : (
          <p style={{ fontSize: 12, color: "var(--ink-3)", marginBottom: 12 }}>No notes yet.</p>
        )}
        {canAddNote ? (
        <form action={addNoteAction} style={{ display: "grid", gap: 8 }}>
          <input type="hidden" name="cycleId" value={cycleId} />
          <DraftTextarea
            name="note"
            draftScope={draftScope(drafts.userId, drafts.cycleId, "note")}
            draftVersion={drafts.version}
            rows={3}
            required
            className="text"
            // Named: a placeholder is not a label, and vanishes as you type.
            aria-label="New note"
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

// A stage's questions, from the same definition the server validates against
// (lib/observation/forms.ts), so an input the server would drop cannot appear,
// capped where the server caps them, and kept if a submit is refused.
function StageFields({
  kind,
  drafts,
}: {
  kind: StageKind;
  drafts: { userId: string; cycleId: string; version: string };
}) {
  return (
    <>
      {STAGE_FORMS[kind].fields.map((f) => (
        <Fragment key={f.name}>
          {/* htmlFor/id: the label sat beside the box without naming it, so a
              screen reader announced only the placeholder, which is gone
              once anything is typed. */}
          <label htmlFor={`cycle-${kind}-${f.name}`} className="label" style={{ fontSize: 11 }}>{f.label}</label>
          <DraftTextarea
            id={`cycle-${kind}-${f.name}`}
            name={f.name}
            draftScope={draftScope(drafts.userId, drafts.cycleId, f.name)}
            draftVersion={drafts.version}
            rows={3}
            required={f.required}
            maxLength={MAX_TEXT_LENGTH}
            className="text"
            placeholder={f.placeholder}
            style={{ fontSize: 13 }}
          />
        </Fragment>
      ))}
    </>
  );
}
