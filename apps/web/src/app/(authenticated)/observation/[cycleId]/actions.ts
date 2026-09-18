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
//        - transition status pre_submitted → observed
//        - audit `observation.observer_form.submitted`
//
//   3. submitPostFormAction      teacher | mentor | observer | programme_admin | super_admin
//        - INSERT observation_forms(cycleId, kind="post", responses, ...)
//        - transition status observed → post_submitted
//        - audit `observation.post_form.submitted`
//
//   4. signOffCycleAction        mentor | programme_admin | super_admin
//        - transition status post_submitted → complete
//        - audit `observation.signed_off` (cycle code + signer in metadata —
//          this audit row IS the "signed by" record for v1; a dedicated
//          observation_signoffs table is deferred behind a schema migration).
//
//   5. addNoteAction             observer | mentor | programme_admin | super_admin
//        - UPDATE observation_cycles.remark (free-form mentor note — re-uses
//          the existing column rather than introducing observation_notes).
//        - audit `observation.note.added`
//
//   6. (Video upload context wiring) — no server action here; handled inline
//      on page.tsx via <UploadProgress contextType="observation_cycle"
//      contextId={cycleId} />. The existing tus pipeline (spec 045) writes
//      video_submissions.context_type/context_id on tusd post-finish.
//
// Each status transition flows through `transitionCycleStatus()` — a single
// guarded helper that asserts the cycle's CURRENT status matches the expected
// `from` value before flipping to `to`. If the precondition fails we redirect
// back with `?error=invalid_transition` (logical 409) so a stale tab can't
// move the cycle backwards through the funnel.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { actorFrom, assertCanAccessCycle } from "@/lib/authz";
import { and, eq } from "drizzle-orm";
import { db } from "@gml/db";
import { observationCycles, observationForms } from "@gml/db/schema";
import { requireRole } from "@/lib/guards";
import { recordAudit } from "@/lib/audit";

type CycleStatus =
  | "nominated"
  | "pre_submitted"
  | "observed"
  | "post_submitted"
  | "complete";

// ---------------------------------------------------------------------------
// transitionCycleStatus — guarded status flip used by all four transitions.
//
// Returns the cycle's code on success (so the audit row can carry it as
// metadata for human-readable audit reading). On precondition failure
// (cycle missing, or status != from), redirects back to the cycle page with
// ?error=invalid_transition. The redirect throws, so callers never see a
// false return.
//
// We rely on a single UPDATE ... WHERE id = ? AND status = ? ... RETURNING
// instead of SELECT-then-UPDATE: this is a single atomic round-trip and the
// `.returning` length tells us whether the precondition held (no TOCTOU
// races if two reviewers click "Sign off" simultaneously).
// ---------------------------------------------------------------------------

async function transitionCycleStatus(
  cycleId: string,
  from: CycleStatus,
  to: CycleStatus,
): Promise<string> {
  const updated = await db
    .update(observationCycles)
    .set({ status: to, updatedAt: new Date() })
    .where(
      and(
        eq(observationCycles.id, cycleId),
        eq(observationCycles.status, from),
      ),
    )
    .returning({ code: observationCycles.code });

  if (updated.length === 0) {
    redirect(`/observation/${cycleId}?error=invalid_transition`);
  }
  return updated[0].code;
}

// ---------------------------------------------------------------------------
// Helper — collect free-form FormData entries into the responses jsonb.
// Drops internal `__` prefixed keys and the cycleId field (used by the
// dispatch, not part of the response payload).
// ---------------------------------------------------------------------------

function collectResponses(formData: FormData): Record<string, unknown> {
  const responses: Record<string, unknown> = {};
  for (const [key, value] of formData.entries()) {
    if (key.startsWith("__")) continue;
    if (key === "cycleId") continue;
    const cleanKey = key.endsWith("[]") ? key.slice(0, -2) : key;
    const stringVal = typeof value === "string" ? value : String(value);
    const existing = responses[cleanKey];
    if (existing === undefined) {
      responses[cleanKey] = stringVal;
    } else if (Array.isArray(existing)) {
      existing.push(stringVal);
    } else {
      responses[cleanKey] = [String(existing), stringVal];
    }
  }
  return responses;
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
  await assertCanAccessCycle(actor, cycleId);

  const responses = collectResponses(formData);

  await db
    .insert(observationForms)
    .values({
      cycleId,
      kind: "pre",
      schemaVersion: "1",
      responses,
      submittedByUserId: userId,
    })
    .onConflictDoNothing();

  const code = await transitionCycleStatus(cycleId, "nominated", "pre_submitted");

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
  await assertCanAccessCycle(actor, cycleId);

  const responses = collectResponses(formData);

  await db
    .insert(observationForms)
    .values({
      cycleId,
      kind: "observer",
      schemaVersion: "1",
      responses,
      submittedByUserId: userId,
    })
    .onConflictDoNothing();

  const code = await transitionCycleStatus(cycleId, "pre_submitted", "observed");

  void recordAudit({
    action: "observation.observer_form.submitted",
    entityType: "observation_cycle",
    entityId: cycleId,
    metadata: { code, from: "pre_submitted", to: "observed" },
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
  await assertCanAccessCycle(actor, cycleId);

  const responses = collectResponses(formData);

  await db
    .insert(observationForms)
    .values({
      cycleId,
      kind: "post",
      schemaVersion: "1",
      responses,
      submittedByUserId: userId,
    })
    .onConflictDoNothing();

  const code = await transitionCycleStatus(cycleId, "observed", "post_submitted");

  void recordAudit({
    action: "observation.post_form.submitted",
    entityType: "observation_cycle",
    entityId: cycleId,
    metadata: { code, from: "observed", to: "post_submitted" },
  });

  revalidatePath(`/observation/${cycleId}`);
  redirect(`/observation/${cycleId}`);
}

// ---------------------------------------------------------------------------
// 4. signOffCycleAction — final mentor sign-off, locks the cycle.
//
// The audit row IS the "signed by" record for v1 — metadata.signedByUserId
// carries the actor, action="observation.signed_off" timestamps when, and the
// audit log is append-only (SM-1). A dedicated `observation_signoffs` table
// (with separate teacher + mentor signature rows) is deferred behind a
// schema migration; documented under designDeviations.
// ---------------------------------------------------------------------------

export async function signOffCycleAction(formData: FormData): Promise<void> {
  const session = await requireRole([
    "mentor",
    "programme_admin",
    "super_admin",
  ]);
  const signedByUserId = session.user.id;

  const cycleId = String(formData.get("cycleId") ?? "").trim();
  if (!cycleId) redirect("/observation?error=invalid_cycle");

  // OWNERSHIP GATE. requireRole() above answers "may this KIND of user act";
  // it never asked whether THIS cycle is theirs. cycleId arrives straight from
  // the form body, so without this any authenticated user could drive any
  // teacher's observation cycle -- submit its forms, sign it off, overwrite its
  // remark -- simply by posting a different UUID.
  const actor = actorFrom(session);
  if (!actor) redirect("/login");
  await assertCanAccessCycle(actor, cycleId);

  const code = await transitionCycleStatus(cycleId, "post_submitted", "complete");

  void recordAudit({
    action: "observation.signed_off",
    entityType: "observation_cycle",
    entityId: cycleId,
    metadata: {
      code,
      from: "post_submitted",
      to: "complete",
      signedByUserId,
      signedAt: new Date().toISOString(),
    },
  });

  revalidatePath(`/observation/${cycleId}`);
  redirect(`/observation/${cycleId}`);
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
  await assertCanAccessCycle(actor, cycleId);
  if (!note) {
    redirect(`/observation/${cycleId}?error=empty_note`);
  }

  const updated = await db
    .update(observationCycles)
    .set({ remark: note, updatedAt: new Date() })
    .where(eq(observationCycles.id, cycleId))
    .returning({ code: observationCycles.code });

  if (updated.length === 0) {
    redirect(`/observation?error=cycle_not_found`);
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
