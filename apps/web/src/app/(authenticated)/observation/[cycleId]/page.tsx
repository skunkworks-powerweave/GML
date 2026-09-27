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
import { getLocale, getTranslations } from "next-intl/server";
import { auth } from "@/auth";
import { hasAnyRole } from "@gml/shared/auth/roles";
import { actorFrom, assertCanAccessCycle } from "@/lib/authz";
import Link from "next/link";
import { SubmitButton } from "@/components/SubmitButton";
import { eq } from "drizzle-orm";
import { db } from "@gml/db";
import { teachers, subjects, observationEvidence } from "@gml/db/schema";
import { UploadProgress } from "@/components/video/UploadProgress";
import { uploadHref } from "@/app/(authenticated)/uploads/context";
import { Fragment } from "react";
import { loadSubmittedForms, STAGE_FORMS, stageFieldName, type StageKind } from "@/lib/observation/forms";
import { parseNotes } from "@/lib/observation/notes";
import { SubmittedForms } from "./SubmittedForms";
import { DraftTextarea } from "./DraftTextarea";
import { draftScope } from "@/lib/observation/drafts";
import { MAX_TEXT_LENGTH } from "@/lib/forms/validate";
import { getDeviceType } from "@/lib/device";
import { whatsappPhoneForUsers } from "@/lib/env";
import { lookupOwn } from "@/lib/lookup";
import { MobileDetailFrame } from "@/components/shells";
import { INTL_LOCALE, normalizeLocale } from "@/i18n/config";
import {
  submitPreFormAction,
  submitObserverFormAction,
  submitPostFormAction,
  signOffCycleAction,
  addNoteAction,
} from "./actions";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("observation");
  return { title: t("cycle.metaTitle") };
}

// The stepper's steps, in order; each one's words are cycle.stages.<id>.
const CYCLE_STAGES = [
  { id: "nominated" },
  { id: "pre_submitted" },
  { id: "observed" },
  { id: "post_submitted" },
  { id: "complete" },
] as const;

// Every ?error= ./actions.ts can issue, and how loudly each is shown; the
// words are cycle.errors.<code>. invalid_form is worded below, with the
// question it names.
const CYCLE_ERRORS: Record<string, "warn" | "error"> = {
  invalid_form: "warn",
  invalid_transition: "error",
  empty_note: "warn",
  note_too_long: "warn",
  submit_failed: "error",
  cycle_locked: "warn",
  invalid_cycle: "error",
  cycle_not_found: "error",
};

type Translate = Awaited<ReturnType<typeof getTranslations>>;

export default async function CycleDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ cycleId: string }>;
  searchParams?: Promise<{ error?: string; field?: string }>;
}) {
  const { cycleId } = await params;
  const sp = (await searchParams) ?? {};
  const t = await getTranslations("observation");
  const intl = INTL_LOCALE[normalizeLocale(await getLocale())];
  // A repeated ?error=a&error=b arrives as an array, which has no trim().
  const error = typeof sp.error === "string" ? sp.error.trim() : "";
  // Only a known question's label is echoed back, never the raw parameter.
  const invalidField = stageFieldName(typeof sp.field === "string" ? sp.field.trim() : "");
  // The limit is stated: "too long" told nobody how long was allowed.
  const max = MAX_TEXT_LENGTH.toLocaleString(intl);

  const tone = error ? lookupOwn(CYCLE_ERRORS, error) : undefined;
  const cycleError = !error
    ? null
    : !tone
      ? { message: t("cycle.errors.unknown"), tone: "error" as const }
      : {
          message:
            error === "invalid_form"
              ? invalidField
                ? t("cycle.errors.invalidFormField", { field: t(`fields.${invalidField}.label`), max })
                : t("cycle.errors.invalidForm", { max })
              : error === "note_too_long"
                ? t("cycle.errors.note_too_long", { max })
                : t(`cycle.errors.${error}`),
          tone,
        };

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
  const forms = await loadSubmittedForms(db, cycleId, teacher?.userId ?? null, {
    title: (kind) => t(`stages.${kind}.title`),
    field: (name) => t(`fields.${name}.label`),
  });
  const evidence = await db.select().from(observationEvidence).where(eq(observationEvidence.cycleId, cycleId));
  const notes = parseNotes(cycle.remark);
  // What each textarea keeps if a submit is refused, keyed to this viewer and
  // to a version of ITS OWN form (lib/observation/drafts.ts). A stage form's
  // version is the cycle's status: only that form landing moves it, and the
  // form is shown at that status alone. The note's is the number of entries:
  // a saved note always adds one. Both used to be the cycle's updated_at, which
  // every write moves, so saving a note emptied an unsent rubric and saving
  // the rubric emptied an unsent note.
  const drafts = { userId: actor.id, cycleId, version: cycle.status };
  const noteDraftVersion = String(notes.length);

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
  const whatsappPhone = whatsappPhoneForUsers();
  // addNoteAction: observer, mentor, programme_admin, super_admin.
  const canAddNote =
    !locked && hasAnyRole(viewerRole, ["observer", "mentor", "programme_admin", "super_admin"]);

  // Spec 137 — device-aware adoption of MobileDetailFrame. On mobile the
  // existing single-column flow is wrapped in the thin-header + back-arrow
  // chrome the JSX prototype defines. The sign-off CTA migrates to the
  // sticky-bottom slot when active (so it stays reachable on long scrolls);
  // desktop continues to render the inline header CTA unchanged.
  const device = await getDeviceType();
  const mobileTitle = teacher?.fullName ?? cycle.code ?? t("cycle.mobileTitle");
  const stickyAction =
    canSignOff ? (
      <form action={signOffCycleAction}>
        <input type="hidden" name="cycleId" value={cycleId} />
        <SubmitButton className="btn btn-primary btn-sm">
          {t("cycle.signOff")}
        </SubmitButton>
      </form>
    ) : undefined;

  const body = (
    <div>
      <header style={{ marginBottom: 20, display: "flex", alignItems: "flex-end", justifyContent: "space-between", flexWrap: "wrap", gap: 16 }}>
        <div>
          <Link href="/observation" className="btn btn-sm btn-ghost" style={{ marginBottom: 6 }}>
            {t("allCycles")}
          </Link>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
            <span className="mono" style={{ fontSize: 12, color: "var(--ink-3)" }}>{cycle.code}</span>
            <span className={kindChipClass}>{t.has(`kindChip.${cycle.kind}`) ? t(`kindChip.${cycle.kind}`) : cycle.kind}</span>
            <span className={statusChipClass}>
              {t.has(`statusChip.${cycle.status}`) ? t(`statusChip.${cycle.status}`) : cycle.status.replace(/_/g, " ")}
            </span>
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
              ? new Date(cycle.scheduledAt).toLocaleDateString(intl, { day: "numeric", month: "long", year: "numeric" })
              : null}
          </p>
        </div>
        {canSignOff ? (
          <form action={signOffCycleAction}>
            <input type="hidden" name="cycleId" value={cycleId} />
            <SubmitButton className="btn btn-primary">
              {t("cycle.signOff")}
            </SubmitButton>
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
                    <span>{t(`cycle.stages.${stage.id}`)}</span>
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
          <div className="label" style={{ marginBottom: 6 }}>{t("cycle.formsLabel", { count: forms.length })}</div>
          <h2 className="serif" style={{ fontSize: 16, marginBottom: 12 }}>{t("cycle.formsTitle")}</h2>
          <SubmittedForms forms={forms} />

          {/* CTA: Submit pre-form */}
          {canSubmitPre ? (
            <form action={submitPreFormAction} style={{ marginTop: 12, display: "grid", gap: 8 }}>
              <input type="hidden" name="cycleId" value={cycleId} />
              <StageFields kind="pre" drafts={drafts} t={t} />
              <SubmitButton className="btn btn-primary btn-sm">
                {t("cycle.submitPre")}
              </SubmitButton>
            </form>
          ) : null}

          {/* CTA: Submit observer-form */}
          {canSubmitObserver ? (
            <form action={submitObserverFormAction} style={{ marginTop: 12, display: "grid", gap: 8 }}>
              <input type="hidden" name="cycleId" value={cycleId} />
              <StageFields kind="observer" drafts={drafts} t={t} />
              <SubmitButton className="btn btn-primary btn-sm">
                {t("cycle.submitObserver")}
              </SubmitButton>
            </form>
          ) : null}

          {/* CTA: Submit post-form */}
          {canSubmitPost ? (
            <form action={submitPostFormAction} style={{ marginTop: 12, display: "grid", gap: 8 }}>
              <input type="hidden" name="cycleId" value={cycleId} />
              <StageFields kind="post" drafts={drafts} t={t} />
              <SubmitButton className="btn btn-primary btn-sm">
                {t("cycle.submitPost")}
              </SubmitButton>
            </form>
          ) : null}
        </article>

        <article className="card card-hi" style={{ padding: 16 }}>
          <div className="label" style={{ marginBottom: 6 }}>{t("cycle.evidenceLabel", { count: evidence.length })}</div>
          <h2 className="serif" style={{ fontSize: 16, marginBottom: 12 }}>{t("cycle.evidenceTitle")}</h2>
          {evidence.length === 0 ? (
            <p style={{ fontSize: 12, color: "var(--ink-3)" }}>
              {locked
                ? t("cycle.evidenceNoneLocked")
                : whatsappPhone
                  ? t.rich("cycle.evidenceNoneWhatsapp", {
                      // i18n-ignore: the caption the WhatsApp webhook links (OBS-<code>), a code, not words
                      caption: `OBS-${cycle.code.replace(/^OBS-/, "")}`,
                      kbd: (chunks) => <span className="kbd">{chunks}</span>,
                    })
                  : t("cycle.evidenceNone")}
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
                        {t("cycle.openVideo")}
                      </Link>
                    ) : (
                      <span style={{ color: "var(--ink-3)" }}>{t("cycle.noVideoYet")}</span>
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
                {t("cycle.lockedEvidence")}
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
                  {whatsappPhone ? t("cycle.recordOrWhatsapp") : t("cycle.record")}
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
        <div className="label" style={{ marginBottom: 6 }}>{t("cycle.remarkLabel")}</div>
        {/* "Notes", not "Mentor notes": observers and administrators write
            here too, and each entry now names its author and role. */}
        <h2 className="serif" style={{ fontSize: 16, marginBottom: 8 }}>{t("cycle.notesTitle")}</h2>
        {notes.length > 0 ? (
          // ENTRY BY ENTRY, not the column printed whole. Printed pre-wrap, a
          // note holding a blank line and a line shaped like an entry header
          // read as a separate entry by whoever it named. Each entry's author
          // is now its own markup; what a body says stays inside it.
          <ol style={{ listStyle: "none", padding: 0, margin: "0 0 12px", display: "grid", gap: 10 }}>
            {notes.map((n, i) => (
              <li key={i} data-note-entry="" style={{ borderLeft: "2px solid var(--line)", paddingLeft: 10 }}>
                <div data-note-author="" style={{ fontSize: 11, color: "var(--ink-3)" }}>
                  {n.author
                    ? t.rich("cycle.noteAuthor", {
                        name: n.author,
                        // The role the entry was written under, as a word.
                        role: n.role && t.has(`cycle.noteRole.${n.role}`) ? t(`cycle.noteRole.${n.role}`) : (n.role ?? ""),
                        author: (chunks) => <strong style={{ color: "var(--ink)" }}>{chunks}</strong>,
                      })
                    : t("cycle.earlierNote")}
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
          <p style={{ fontSize: 12, color: "var(--ink-3)", marginBottom: 12 }}>{t("cycle.noNotes")}</p>
        )}
        {canAddNote ? (
        <form action={addNoteAction} style={{ display: "grid", gap: 8 }}>
          <input type="hidden" name="cycleId" value={cycleId} />
          <DraftTextarea
            name="note"
            draftScope={draftScope(drafts.userId, drafts.cycleId, "note")}
            draftVersion={noteDraftVersion}
            rows={3}
            required
            // The cap addNoteAction enforces (note_too_long).
            maxLength={MAX_TEXT_LENGTH}
            className="text"
            // Named: a placeholder is not a label, and vanishes as you type.
            aria-label={t("cycle.newNoteLabel")}
            placeholder={t("cycle.newNotePlaceholder")}
            style={{ fontSize: 13 }}
          />
          <div>
            <SubmitButton className="btn btn-sm">
              {t("cycle.addNote")}
            </SubmitButton>
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
  t,
}: {
  kind: StageKind;
  /** version: the cycle's status (see `drafts` above). */
  drafts: { userId: string; cycleId: string; version: string };
  /** The page's "observation" translator: each question's words. */
  t: Translate;
}) {
  return (
    <>
      {STAGE_FORMS[kind].fields.map((f) => (
        <Fragment key={f.name}>
          {/* htmlFor/id: the label sat beside the box without naming it, so a
              screen reader announced only the placeholder, which is gone
              once anything is typed. */}
          <label htmlFor={`cycle-${kind}-${f.name}`} className="label" style={{ fontSize: 11 }}>
            {t(`fields.${f.name}.label`)}
          </label>
          <DraftTextarea
            id={`cycle-${kind}-${f.name}`}
            name={f.name}
            draftScope={draftScope(drafts.userId, drafts.cycleId, f.name)}
            draftVersion={drafts.version}
            rows={3}
            required={f.required}
            maxLength={MAX_TEXT_LENGTH}
            className="text"
            placeholder={t(`fields.${f.name}.placeholder`)}
            style={{ fontSize: 13 }}
          />
        </Fragment>
      ))}
    </>
  );
}
