"use server";

// Spec 117 — observation-cycle progression server actions.
//
// Closes the 6 highest-impact frontend-parity gaps on the observation cycle
// detail page (`LMS GML Frontend/observation-detail.jsx` lines 60, 198, 256,
// 339). The JSX prototype's "Submit pre-form" / "Submit for sign-off" /
// "Acknowledge & sign" / "Add note" buttons all rendered without backend
// wiring; the real Next.js page at
// `apps/web/src/app/(authenticated)/observation/[cycleId]/page.tsx` only
// displayed the 5-step stepper and the read-only forms/evidence sidebars.
//
// Exports (consumed via <form action={...}> on the page):
//
//   1. submitPreFormAction       teacher | mentor | observer | programme_admin | super_admin
//        - INSERT observation_forms(cycleId, kind="pre", responses, ...)
//        - transition status nominated → pre_submitted
//        - audit `observation.pre_form.submitted`
//
//   2. submitObserverFormAction  observer | mentor | programme_admin | super_admin
//        - INSERT observation_forms(cycleId, kind="observer", responses, ...)
//          and, when a scored rubric applies (lib/observation/rubric.ts), a
//          score per criterion into observation_scores, in the SAME
//          transaction, with observation_cycles.rubric_id
//        - transition status pre_submitted → observed
//        - audit `observation.observer_form.submitted` (and
//          `observation.scores.saved` when scored)
//
//   3. submitPostFormAction      teacher | mentor | observer | programme_admin | super_admin
//        - INSERT observation_forms(cycleId, kind="post", responses, ...)
//        - transition status observed → post_submitted
//        - audit `observation.post_form.submitted`
//        - send the cycle for sign-off: an observation_signoff approval
//          request, submitted by whoever submitted the form (the teacher)
//
//   4. signOffCycleAction        mentor | programme_admin | super_admin
//        - APPROVE the cycle's observation_signoff request (lib/observation/
//          signoff.ts -> lib/approvals), optional comment; the handler moves
//          post_submitted → complete, audits `observation.signed_off` (cycle
//          code + signer in metadata: the "signed by" record) and notifies
//          the cycle's other parties (`cycle.complete`)
//        - a cycle at post_submitted with no request (from before sign-off
//          went through the queue) gets one, decided in the same step
//
//   4b. sendBackCycleAction      mentor | programme_admin | super_admin
//        - REQUEST CHANGES on the sign-off request, with a required comment:
//          post_submitted → observed, so the teacher can revise her post form
//        - audit `observation.cycle.sent_back`; the teacher is told why
//
//   4c. saveScoresAction         observer | mentor | programme_admin | super_admin
//        - revise the scored rubric while the cycle is observed or
//          post_submitted (never once it is complete)
//        - audit `observation.scores.saved`
//
//   5. addNoteAction             observer | mentor | programme_admin | super_admin
//        - APPEND to observation_cycles.remark ("[stamp] author (role): note"
//          — re-uses the existing column rather than introducing
//          observation_notes). Refused once the cycle is complete.
//        - audit `observation.note.added`
//
//   6. (Video upload context wiring) — no server action here; handled inline
//      on page.tsx via <UploadProgress contextType="observation_cycle"
//      contextId={cycleId} />. The existing tus pipeline (spec 045) writes
//      video_submissions.context_type/context_id on tusd post-finish.
//
// Each status transition is a single guarded UPDATE that asserts the cycle's
// CURRENT status matches the expected `from` value before flipping to `to`:
// submitFormAndTransition() below for the three forms, and
// lib/observation/cycle-signoff.ts transitionCycleStatus() for the sign-off
// decisions. If the precondition fails we redirect back with
// `?error=invalid_transition` (logical 409) so a stale tab can't move the
// cycle backwards through the funnel.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { actorFrom, assertCanAccessCycle } from "@/lib/authz";
import { assertSectionGate } from "@/lib/gates";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "@gml/db";
import { observationCycles, observationForms } from "@gml/db/schema";
import { requireRole } from "@/lib/guards";
import { recordAudit } from "@/lib/audit";
import { parseStageResponses, type StageKind } from "@/lib/observation/forms";
import { MAX_TEXT_LENGTH, normaliseLineBreaks } from "@/lib/forms/validate";
import { formatNoteEntry } from "@/lib/observation/notes";
import { isUuid } from "@/lib/ids";
import { parseRubricScores, rubricFor, totals, writeScores, type CycleRubric, type ScoreInput } from "@/lib/observation/rubric";
import { decideSignOff, requestSignOff } from "@/lib/observation/signoff";
import type { Actor } from "@/lib/visibility";

// Where the gate sends the user after they unlock: back to THIS cycle. Every
// action here passed "/observation", so a grant lapsing (8 h, or a password
// rotation) while someone wrote a rubric or a reflection returned them to the
// list after unlocking, with no way back to what they were doing but to find
// the cycle again. Only a well-formed id is echoed into the path.
function cyclePath(cycleId: string): string {
  return isUuid(cycleId) ? `/observation/${cycleId}` : "/observation";
}

type CycleStatus =
  | "nominated"
  | "pre_submitted"
  | "observed"
  | "post_submitted"
  | "complete";

// ---------------------------------------------------------------------------
// submitFormAndTransition — the form row and the status flip, ATOMICALLY.
//
// All three submit actions used to INSERT the observation_forms row and THEN
// call transitionCycleStatus(). When the transition was rejected — a stale tab,
// a double submit, two reviewers acting at once — the redirect threw and the
// caller got `?error=invalid_transition`, but the INSERT HAD ALREADY
// COMMITTED. So a cycle could hold a "pre-observation form" while still sitting
// in `nominated`, and the UI reported that nothing had been recorded.
//
// That is the worst shape for this particular data: observation forms are
// programme evidence about a named teacher, and a form attached to a cycle that
// never reached the corresponding state is a record nobody can account for.
//
// Ordering the two inside one transaction fixes it in both directions: the
// guarded UPDATE runs first, so a failed precondition means no row is written
// at all, and a failure in the insert rolls the status back.
//
// The observer's rubric scores ride in the same transaction: a rubric total
// with no observer form behind it, or an observed cycle whose scores were
// lost, would be the same unaccountable record.
// ---------------------------------------------------------------------------

async function submitFormAndTransition(opts: {
  cycleId: string;
  kind: "pre" | "observer" | "post";
  responses: Record<string, unknown>;
  userId: string;
  from: CycleStatus;
  to: CycleStatus;
  /** The observer's scores, when a scored rubric applies. */
  scores?: { rubricId: string; scores: ScoreInput[] } | null;
}): Promise<string> {
  let code: string | null = null;
  try {
    code = await db.transaction(async (tx) => {
      const updated = await tx
        .update(observationCycles)
        .set({ status: opts.to, updatedAt: new Date() })
        .where(
          and(
            eq(observationCycles.id, opts.cycleId),
            eq(observationCycles.status, opts.from),
          ),
        )
        .returning({ code: observationCycles.code });

      // Rolls back the transaction. The redirect happens OUTSIDE it, below:
      // redirect() throws a Next control-flow signal, and throwing that through
      // a transaction callback conflates "the precondition failed" with "the
      // database errored".
      if (updated.length === 0) return null;

      // UPSERT. `.onConflictDoNothing()` was silent DATA LOSS.
      //
      // observation_forms has a unique index on (cycle_id, kind)
      // -- observation_forms_cycle_kind_uq -- so re-submitting a form for a
      // cycle that already has one of that kind hit the conflict and the row
      // was DROPPED. The status UPDATE above is in the same transaction and
      // committed regardless, so the cycle advanced a stage while everything
      // the user had typed disappeared. No error, no warning: the page came
      // back showing the OLD submission and a NEW status.
      //
      // Re-submission is a legitimate act -- an observer correcting a form
      // before sign-off is the obvious case -- so the right semantic is that
      // the latest submission wins. submitted_at and submitted_by are
      // refreshed with it, otherwise the record would attribute the new
      // answers to whoever happened to submit first.
      await tx
        .insert(observationForms)
        .values({
          cycleId: opts.cycleId,
          kind: opts.kind,
          schemaVersion: "1",
          responses: opts.responses,
          submittedByUserId: opts.userId,
        })
        .onConflictDoUpdate({
          target: [observationForms.cycleId, observationForms.kind],
          set: {
            responses: opts.responses,
            submittedByUserId: opts.userId,
            submittedAt: new Date(),
          },
        });

      if (opts.scores) {
        await writeScores(tx, {
          cycleId: opts.cycleId,
          rubricId: opts.scores.rubricId,
          scores: opts.scores.scores,
          userId: opts.userId,
        });
      }

      return updated[0]!.code;
    });
  } catch (err) {
    console.error("[observation] submit transaction failed", err);
    redirect(`/observation/${opts.cycleId}?error=submit_failed`);
  }

  if (code === null) {
    redirect(`/observation/${opts.cycleId}?error=invalid_transition`);
  }
  return code;
}

// ---------------------------------------------------------------------------
// Helper — the stage's answers, validated, or a redirect naming the question.
//
// This was collectResponses(): every non-`__` FormData key stored verbatim,
// with no required check, no trim, no length cap and no allow-list, ahead of
// a transition that cannot be undone. An empty pre-form or a blank rubric
// advanced the cycle for good. Runs after the ownership check (so a refusal
// reveals nothing about a cycle the caller cannot see) and before the
// transaction (so a refusal writes nothing).
// ---------------------------------------------------------------------------

function stageResponses(kind: StageKind, cycleId: string, formData: FormData): Record<string, string> {
  const parsed = parseStageResponses(kind, formData);
  if (!parsed.ok) {
    redirect(`/observation/${cycleId}?error=invalid_form&field=${encodeURIComponent(parsed.field)}`);
  }
  return parsed.responses;
}

// ---------------------------------------------------------------------------
// Helper — the observer's rubric scores, validated, or a redirect naming the
// criterion. Same place in the order as stageResponses(): after the ownership
// check, before anything is written. Only a criterion id of THIS rubric is
// echoed back, and the page names it only if it is one of the rubric's.
// ---------------------------------------------------------------------------

function rubricScores(rubric: CycleRubric, cycleId: string, formData: FormData): ScoreInput[] {
  const parsed = parseRubricScores(rubric, formData);
  if (!parsed.ok) {
    redirect(`/observation/${cycleId}?error=invalid_score&criterion=${encodeURIComponent(parsed.criterionId)}`);
  }
  return parsed.scores;
}

/** A sign-off comment: trimmed, capped as every other answer, or a redirect. */
function signOffComment(cycleId: string, formData: FormData): string | null {
  const raw = formData.get("comment");
  const comment = typeof raw === "string" ? normaliseLineBreaks(raw).trim() : "";
  if (comment.length > MAX_TEXT_LENGTH) {
    redirect(`/observation/${cycleId}?error=comment_too_long`);
  }
  return comment || null;
}

// ---------------------------------------------------------------------------
// 1. submitPreFormAction — teacher's pre-observation reflection.
// ---------------------------------------------------------------------------

export async function submitPreFormAction(formData: FormData): Promise<void> {
  const session = await requireRole([
    "teacher",
    "observer",
    "mentor",
    "programme_admin",
    "super_admin",
  ]);
  const userId = session.user.id;

  const cycleId = String(formData.get("cycleId") ?? "").trim();
  if (!cycleId) redirect("/observation?error=invalid_cycle");

  // OWNERSHIP GATE. requireRole() above answers "may this KIND of user act";
  // it never asked whether THIS cycle is theirs. cycleId arrives straight from
  // the form body, so without this any authenticated user could drive any
  // teacher's observation cycle -- submit its forms, sign it off, overwrite its
  // remark -- simply by posting a different UUID.
  const actor = actorFrom(session);
  if (!actor) redirect("/login");
  // SECTION GATE. Asserted HERE and not left to the layout: Next runs a Server
  // Action to completion BEFORE it renders any layout, so observation/layout.tsx's
  // assertSectionGate never executes on a mutation. Every action in this file
  // was therefore reachable by anyone who had never entered the section
  // password -- and because rotation works by invalidating grants, an
  // unasserted action is also an unrevoked one. The section-level rotatable
  // password is a hard product requirement; a gate that guards only the reading
  // of a page and none of the writing does not meet it.
  await assertSectionGate(actor.id, "observation", cyclePath(cycleId));
  await assertCanAccessCycle(actor, cycleId);

  const responses = stageResponses("pre", cycleId, formData);

  const code = await submitFormAndTransition({
    cycleId,
    kind: "pre",
    responses,
    userId,
    from: "nominated",
    to: "pre_submitted",
  });

  void recordAudit({
    action: "observation.pre_form.submitted",
    entityType: "observation_cycle",
    entityId: cycleId,
    metadata: { code, from: "nominated", to: "pre_submitted" },
  });

  revalidatePath(`/observation/${cycleId}`);
  redirect(`/observation/${cycleId}`);
}

// ---------------------------------------------------------------------------
// 2. submitObserverFormAction — observer's rubric ratings.
// ---------------------------------------------------------------------------

export async function submitObserverFormAction(formData: FormData): Promise<void> {
  const session = await requireRole([
    "observer",
    "mentor",
    "programme_admin",
    "super_admin",
  ]);
  const userId = session.user.id;

  const cycleId = String(formData.get("cycleId") ?? "").trim();
  if (!cycleId) redirect("/observation?error=invalid_cycle");

  // OWNERSHIP GATE. requireRole() above answers "may this KIND of user act";
  // it never asked whether THIS cycle is theirs. cycleId arrives straight from
  // the form body, so without this any authenticated user could drive any
  // teacher's observation cycle -- submit its forms, sign it off, overwrite its
  // remark -- simply by posting a different UUID.
  const actor = actorFrom(session);
  if (!actor) redirect("/login");
  // SECTION GATE. Asserted HERE and not left to the layout: Next runs a Server
  // Action to completion BEFORE it renders any layout, so observation/layout.tsx's
  // assertSectionGate never executes on a mutation. Every action in this file
  // was therefore reachable by anyone who had never entered the section
  // password -- and because rotation works by invalidating grants, an
  // unasserted action is also an unrevoked one. The section-level rotatable
  // password is a hard product requirement; a gate that guards only the reading
  // of a page and none of the writing does not meet it.
  await assertSectionGate(actor.id, "observation", cyclePath(cycleId));
  const cycle = await assertCanAccessCycle(actor, cycleId);

  const responses = stageResponses("observer", cycleId, formData);
  // The scored rubric, when one applies: the cycle's own, else the default.
  // None configured -> the narrative alone, as before scored rubrics.
  const rubric = await rubricFor(db, cycle.rubricId);
  const scores = rubric ? rubricScores(rubric, cycleId, formData) : null;

  const code = await submitFormAndTransition({
    cycleId,
    kind: "observer",
    responses,
    userId,
    from: "pre_submitted",
    to: "observed",
    scores: rubric && scores ? { rubricId: rubric.id, scores } : null,
  });

  void recordAudit({
    action: "observation.observer_form.submitted",
    entityType: "observation_cycle",
    entityId: cycleId,
    metadata: { code, from: "pre_submitted", to: "observed" },
  });
  if (rubric && scores) {
    void recordAudit({
      action: "observation.scores.saved",
      entityType: "observation_cycle",
      entityId: cycleId,
      metadata: { code, rubricId: rubric.id, criteria: scores.length, ...totals(rubric, scores) },
    });
  }

  revalidatePath(`/observation/${cycleId}`);
  redirect(`/observation/${cycleId}`);
}

// ---------------------------------------------------------------------------
// 2b. saveScoresAction — the observer revises the rubric scores.
//
// Open from the observer form until sign-off: at observed and post_submitted
// (a sign-off request may be waiting; the approver then reads the revised
// scores). Refused once the cycle is complete -- in the guarded UPDATE, so a
// sign-off landing between the check and the write cannot slip a score in.
// ---------------------------------------------------------------------------

export async function saveScoresAction(formData: FormData): Promise<void> {
  const session = await requireRole([
    "observer",
    "mentor",
    "programme_admin",
    "super_admin",
  ]);
  const userId = session.user.id;

  const cycleId = String(formData.get("cycleId") ?? "").trim();
  if (!cycleId) redirect("/observation?error=invalid_cycle");

  // OWNERSHIP GATE and SECTION GATE, as for every action in this file.
  const actor = actorFrom(session);
  if (!actor) redirect("/login");
  await assertSectionGate(actor.id, "observation", cyclePath(cycleId));
  const cycle = await assertCanAccessCycle(actor, cycleId);
  if (cycle.status === "complete") {
    redirect(`/observation/${cycleId}?error=cycle_locked`);
  }
  if (cycle.status !== "observed" && cycle.status !== "post_submitted") {
    redirect(`/observation/${cycleId}?error=invalid_transition`);
  }

  const rubric = await rubricFor(db, cycle.rubricId);
  if (!rubric) redirect(`/observation/${cycleId}?error=invalid_transition`);
  const scores = rubricScores(rubric, cycleId, formData);

  let code: string | null = null;
  try {
    code = await db.transaction(async (tx) => {
      const [open] = await tx
        .update(observationCycles)
        .set({ updatedAt: new Date() })
        .where(
          and(
            eq(observationCycles.id, cycleId),
            inArray(observationCycles.status, ["observed", "post_submitted"]),
          ),
        )
        .returning({ code: observationCycles.code });
      if (!open) return null;
      await writeScores(tx, { cycleId, rubricId: rubric.id, scores, userId });
      return open.code;
    });
  } catch (err) {
    console.error("[observation] saving scores failed", err);
    redirect(`/observation/${cycleId}?error=submit_failed`);
  }
  // The cycle was signed off in between.
  if (code === null) redirect(`/observation/${cycleId}?error=cycle_locked`);

  void recordAudit({
    action: "observation.scores.saved",
    entityType: "observation_cycle",
    entityId: cycleId,
    metadata: { code, rubricId: rubric.id, criteria: scores.length, ...totals(rubric, scores) },
  });

  revalidatePath(`/observation/${cycleId}`);
  redirect(`/observation/${cycleId}`);
}

// ---------------------------------------------------------------------------
// 3. submitPostFormAction — teacher's post-observation reflection.
// ---------------------------------------------------------------------------

export async function submitPostFormAction(formData: FormData): Promise<void> {
  const session = await requireRole([
    "teacher",
    "observer",
    "mentor",
    "programme_admin",
    "super_admin",
  ]);
  const userId = session.user.id;

  const cycleId = String(formData.get("cycleId") ?? "").trim();
  if (!cycleId) redirect("/observation?error=invalid_cycle");

  // OWNERSHIP GATE. requireRole() above answers "may this KIND of user act";
  // it never asked whether THIS cycle is theirs. cycleId arrives straight from
  // the form body, so without this any authenticated user could drive any
  // teacher's observation cycle -- submit its forms, sign it off, overwrite its
  // remark -- simply by posting a different UUID.
  const actor = actorFrom(session);
  if (!actor) redirect("/login");
  // SECTION GATE. Asserted HERE and not left to the layout: Next runs a Server
  // Action to completion BEFORE it renders any layout, so observation/layout.tsx's
  // assertSectionGate never executes on a mutation. Every action in this file
  // was therefore reachable by anyone who had never entered the section
  // password -- and because rotation works by invalidating grants, an
  // unasserted action is also an unrevoked one. The section-level rotatable
  // password is a hard product requirement; a gate that guards only the reading
  // of a page and none of the writing does not meet it.
  await assertSectionGate(actor.id, "observation", cyclePath(cycleId));
  await assertCanAccessCycle(actor, cycleId);

  const responses = stageResponses("post", cycleId, formData);

  const code = await submitFormAndTransition({
    cycleId,
    kind: "post",
    responses,
    userId,
    from: "observed",
    to: "post_submitted",
  });

  void recordAudit({
    action: "observation.post_form.submitted",
    entityType: "observation_cycle",
    entityId: cycleId,
    metadata: { code, from: "observed", to: "post_submitted" },
  });

  // SIGN-OFF GOES THROUGH THE APPROVALS QUEUE. The request is recorded after
  // the form has committed: if it cannot be (one is already open), the form
  // still stands, and the cycle can be signed off without one (Sign off
  // creates and decides it in one step).
  const requested = await requestSignOff(db, cycleId, actor);
  if (!requested.ok && requested.error !== "already_pending") {
    console.warn("[observation] the sign-off request was not recorded", { cycleId, error: requested.error });
  }

  revalidatePath(`/observation/${cycleId}`);
  redirect(`/observation/${cycleId}`);
}

// ---------------------------------------------------------------------------
// 4. signOffCycleAction — the mentor or an administrator signs the cycle off,
//    which locks it.
//
// Sign-off is a decision on the cycle's observation_signoff approval request
// (lib/observation/signoff.ts), so it is the same decision whether taken here
// or from /approvals: the handler moves post_submitted → complete in the
// decision's transaction, and writes the audit row that IS the "signed by"
// record -- action "observation.signed_off", metadata.signedByUserId and
// signedAt (lib/observation/cycle-signoff.ts; audit_log is append-only,
// SM-1) -- and tells the cycle's other parties. The approvals row keeps the
// decision and its comment in the queue's history.
// ---------------------------------------------------------------------------

export async function signOffCycleAction(formData: FormData): Promise<void> {
  const session = await requireRole([
    "mentor",
    "programme_admin",
    "super_admin",
  ]);

  const cycleId = String(formData.get("cycleId") ?? "").trim();
  if (!cycleId) redirect("/observation?error=invalid_cycle");

  // OWNERSHIP GATE. requireRole() above answers "may this KIND of user act";
  // it never asked whether THIS cycle is theirs. cycleId arrives straight from
  // the form body, so without this any authenticated user could drive any
  // teacher's observation cycle -- submit its forms, sign it off, overwrite its
  // remark -- simply by posting a different UUID.
  const actor = actorFrom(session);
  if (!actor) redirect("/login");
  // SECTION GATE. Asserted HERE and not left to the layout: Next runs a Server
  // Action to completion BEFORE it renders any layout, so observation/layout.tsx's
  // assertSectionGate never executes on a mutation. Every action in this file
  // was therefore reachable by anyone who had never entered the section
  // password -- and because rotation works by invalidating grants, an
  // unasserted action is also an unrevoked one. The section-level rotatable
  // password is a hard product requirement; a gate that guards only the reading
  // of a page and none of the writing does not meet it.
  await assertSectionGate(actor.id, "observation", cyclePath(cycleId));
  await assertCanAccessCycle(actor, cycleId);

  const comment = signOffComment(cycleId, formData);
  await decide(cycleId, actor, "approved", comment);

  revalidatePath(`/observation/${cycleId}`);
  redirect(`/observation/${cycleId}`);
}

// ---------------------------------------------------------------------------
// 4b. sendBackCycleAction — the approver sends the cycle back to the teacher,
//     saying what to change: post_submitted → observed, and her post form is
//     open again.
// ---------------------------------------------------------------------------

export async function sendBackCycleAction(formData: FormData): Promise<void> {
  const session = await requireRole([
    "mentor",
    "programme_admin",
    "super_admin",
  ]);

  const cycleId = String(formData.get("cycleId") ?? "").trim();
  if (!cycleId) redirect("/observation?error=invalid_cycle");

  // OWNERSHIP GATE and SECTION GATE, as for signOffCycleAction.
  const actor = actorFrom(session);
  if (!actor) redirect("/login");
  await assertSectionGate(actor.id, "observation", cyclePath(cycleId));
  await assertCanAccessCycle(actor, cycleId);

  const comment = signOffComment(cycleId, formData);
  if (!comment) redirect(`/observation/${cycleId}?error=comment_required`);
  await decide(cycleId, actor, "changes_requested", comment);

  revalidatePath(`/observation/${cycleId}`);
  redirect(`/observation/${cycleId}`);
}

/** Decide the cycle's sign-off request, or redirect back saying why not. */
async function decide(
  cycleId: string,
  actor: Actor,
  decision: "approved" | "changes_requested",
  comment: string | null,
): Promise<void> {
  const result = await decideSignOff(db, { cycleId, actor, decision, comment });
  if (!result.ok) redirect(`/observation/${cycleId}?error=${result.error}`);
}

// ---------------------------------------------------------------------------
// 5. addNoteAction — mentor note on the cycle (free text, single field).
//
// Persists into observation_cycles.remark — reuses the existing column rather
// than introducing an observation_notes table. v1 stores one note per cycle;
// a multi-note thread is a follow-up spec.
// ---------------------------------------------------------------------------

export async function addNoteAction(formData: FormData): Promise<void> {
  const session = await requireRole([
    "observer",
    "mentor",
    "programme_admin",
    "super_admin",
  ]);

  const cycleId = String(formData.get("cycleId") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim();
  if (!cycleId) redirect("/observation?error=invalid_cycle");

  // OWNERSHIP GATE. requireRole() above answers "may this KIND of user act";
  // it never asked whether THIS cycle is theirs. cycleId arrives straight from
  // the form body, so without this any authenticated user could drive any
  // teacher's observation cycle -- submit its forms, sign it off, overwrite its
  // remark -- simply by posting a different UUID.
  const actor = actorFrom(session);
  if (!actor) redirect("/login");
  // SECTION GATE. Asserted HERE and not left to the layout: Next runs a Server
  // Action to completion BEFORE it renders any layout, so observation/layout.tsx's
  // assertSectionGate never executes on a mutation. Every action in this file
  // was therefore reachable by anyone who had never entered the section
  // password -- and because rotation works by invalidating grants, an
  // unasserted action is also an unrevoked one. The section-level rotatable
  // password is a hard product requirement; a gate that guards only the reading
  // of a page and none of the writing does not meet it.
  await assertSectionGate(actor.id, "observation", cyclePath(cycleId));
  const cycle = await assertCanAccessCycle(actor, cycleId);
  // A SIGNED-OFF RECORD IS CLOSED. Sign-off is "final ... locks the cycle"
  // (above, and spec 117), but nothing enforced it: notes kept being appended
  // to an evaluative record after the signer had attested to it. Checked here
  // for the message, and again in the UPDATE's WHERE so a sign-off landing
  // between the two cannot slip a note in.
  if (cycle.status === "complete") {
    redirect(`/observation/${cycleId}?error=cycle_locked`);
  }
  if (!note) {
    redirect(`/observation/${cycleId}?error=empty_note`);
  }
  // THE SAME CAP AS EVERY OTHER ANSWER. Only emptiness was checked, so one
  // request could append up to Next's 1 MB body limit to a remark every party
  // to the cycle loads, and repeated notes grew it without bound. Measured as
  // the note box's maxLength counts it: a line break is one character, though
  // the form posts it as two.
  if (normaliseLineBreaks(note).length > MAX_TEXT_LENGTH) {
    redirect(`/observation/${cycleId}?error=note_too_long`);
  }

  // APPEND, do not overwrite.
  //
  // The action is called addNoteAction, the button says "Add note", and it
  // replaced the entire remark with the new text. So the second note silently
  // destroyed the first — on a field that carries an observer's written
  // judgement about a named teacher's lesson, in an append-only-audited module
  // whose whole point is a durable record.
  //
  // Done in SQL rather than read-modify-write so two observers adding notes at
  // the same moment cannot lose one to a lost update.
  //
  // WHO WROTE IT. Entries were "[stamp UTC] text" alone, under a heading that
  // read "Mentor notes" although observers and administrators write here too,
  // so a teacher reading two entries from the same minute could not tell who
  // judged what; the audit row names the actor but not the text. The author
  // and their role are now part of the entry itself. formatNoteEntry drops
  // blank lines from the note, since a blank line is what separates entries:
  // otherwise a note could carry a line shaped like another author's header
  // and read as their entry (lib/observation/notes.ts).
  // i18n-ignore: stored in the note as its author's name (data, one language for every reader); every account has an email, so it is never reached
  const author = session.user.name?.trim() || session.user.email || "Unknown user";
  const entry = formatNoteEntry(new Date(), author, actor.role, note);

  const updated = await db
    .update(observationCycles)
    .set({
      remark: sql`CASE
        WHEN ${observationCycles.remark} IS NULL OR btrim(${observationCycles.remark}) = ''
        THEN ${entry}
        ELSE ${observationCycles.remark} || E'

' || ${entry}
      END`,
      updatedAt: new Date(),
    })
    .where(and(eq(observationCycles.id, cycleId), ne(observationCycles.status, "complete")))
    .returning({ code: observationCycles.code });

  // The cycle existed a moment ago (assertCanAccessCycle), so no row means it
  // was signed off in between.
  if (updated.length === 0) {
    redirect(`/observation/${cycleId}?error=cycle_locked`);
  }

  void recordAudit({
    action: "observation.note.added",
    entityType: "observation_cycle",
    entityId: cycleId,
    metadata: { code: updated[0].code, length: note.length },
  });

  revalidatePath(`/observation/${cycleId}`);
  redirect(`/observation/${cycleId}`);
}
