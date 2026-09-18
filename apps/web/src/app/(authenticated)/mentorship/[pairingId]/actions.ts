"use server";

// Spec 118 — mentorship action-button server actions.
//
// Closes the 6 highest-impact frontend-parity gaps on the pairing detail
// surface from the JSX prototype (`LMS GML Frontend/mentorship.jsx`):
//
//   1. logMeetingAction          → INSERT mentor_meetings, bump pairing counters,
//                                  audit `mentor.meeting.logged`.
//   2. completePairingAction     → super_admin + programme_admin only; sets
//                                  pairings.status="complete", endedAt=now,
//                                  audits `mentor.pairing.completed`.
//   3. toggleCommitmentAction    → v1 audit-only stub. No `commitments` jsonb
//                                  column exists on mentor_pairings yet; spec
//                                  documents that the persistence is deferred
//                                  to a follow-up migration. For now we record
//                                  `mentor.commitment.toggled` so the click is
//                                  not silently dropped (and the audit row is
//                                  what powers the future replay/backfill when
//                                  the column lands).
//
// The "Message" / "WhatsApp" / quarter-strip buttons are link-based (no server
// state required) and live inline in page.tsx; only the three above need
// actions because they mutate.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { eq, sql } from "drizzle-orm";
import { db } from "@gml/db";
import { mentorPairings, mentorMeetings } from "@gml/db/schema";
import { auth } from "@/auth";
import { requireRole } from "@/lib/guards";
import { actorFrom, assertCanAccessPairing } from "@/lib/authz";
import { recordAudit } from "@/lib/audit";

// ---------------------------------------------------------------------------
// Log a meeting against a pairing.
//
// Form fields (all coerced from FormData):
//   - pairingId   uuid (required)
//   - scheduledAt ISO datetime (required)
//   - durationMin string/number (optional)
//   - notes       free text (optional)
//
// On success: bumps mentor_pairings.meetings_count + last_meeting_at, audits
// `mentor.meeting.logged`, revalidates the detail page, redirects back.
// ---------------------------------------------------------------------------

export async function logMeetingAction(formData: FormData): Promise<void> {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const pairingId = String(formData.get("pairingId") ?? "").trim();
  const scheduledAtRaw = String(formData.get("scheduledAt") ?? "").trim();
  const durationMinRaw = String(formData.get("durationMin") ?? "").trim();
  const notes = String(formData.get("notes") ?? "").trim();

  if (!pairingId || !scheduledAtRaw) {
    redirect(`/mentorship/${pairingId || ""}?error=invalid_meeting`);
  }

  const scheduledAt = new Date(scheduledAtRaw);
  if (Number.isNaN(scheduledAt.getTime())) {
    redirect(`/mentorship/${pairingId}?error=invalid_meeting_time`);
  }

  // OWNERSHIP GATE. What stood here was described as a "cheap guard against URL
  // tampering", but it only confirmed the pairing EXISTED -- not that the caller
  // had anything to do with it. With no role check either, any authenticated
  // user could log meetings against any mentorship pairing and bump its
  // meetings_count / last_meeting_at counters.
  const actor = actorFrom(session);
  if (!actor) redirect("/login");
  await assertCanAccessPairing(actor, pairingId);

  let newMeetingId = "";
  await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(mentorMeetings)
      .values({
        pairingId,
        scheduledAt,
        durationMin: durationMinRaw.length > 0 ? durationMinRaw : null,
        notes: notes.length > 0 ? notes : null,
      })
      .returning({ id: mentorMeetings.id });
    newMeetingId = inserted?.id ?? "";

    // Bump cached counters on the pairing. Using a SQL increment avoids a
    // read-modify-write race when two mentors log meetings concurrently.
    await tx
      .update(mentorPairings)
      .set({
        meetingsCount: sql`${mentorPairings.meetingsCount} + 1`,
        lastMeetingAt: scheduledAt,
      })
      .where(eq(mentorPairings.id, pairingId));
  });

  void recordAudit({
    action: "mentor.meeting.logged",
    entityType: "mentor_meeting",
    entityId: newMeetingId,
    metadata: { pairingId, scheduledAt: scheduledAt.toISOString() },
  });

  revalidatePath(`/mentorship/${pairingId}`);
  redirect(`/mentorship/${pairingId}`);
}

// ---------------------------------------------------------------------------
// Mark a pairing as complete. Hard role gate.
//
// Form fields:
//   - pairingId uuid (required)
// ---------------------------------------------------------------------------

export async function completePairingAction(formData: FormData): Promise<void> {
  const session = await requireRole(["programme_admin", "super_admin"]);

  const pairingId = String(formData.get("pairingId") ?? "").trim();
  if (!pairingId) redirect(`/mentorship?error=invalid_pairing`);

  // Admin-only already, so this is defence in depth rather than a fix -- but it
  // keeps every mutation on this resource behind one predicate, so the next
  // action added here inherits the check instead of forgetting it.
  const completeActor = actorFrom(session);
  if (!completeActor) redirect("/login");
  await assertCanAccessPairing(completeActor, pairingId);

  const endedAt = new Date();
  const updated = await db
    .update(mentorPairings)
    .set({ status: "complete", endedAt })
    .where(eq(mentorPairings.id, pairingId))
    .returning({ id: mentorPairings.id });

  if (updated.length === 0) {
    redirect(`/mentorship?error=pairing_not_found`);
  }

  void recordAudit({
    action: "mentor.pairing.completed",
    entityType: "mentor_pairing",
    entityId: pairingId,
    metadata: { endedAt: endedAt.toISOString() },
  });

  revalidatePath(`/mentorship/${pairingId}`);
  redirect(`/mentorship/${pairingId}`);
}

// ---------------------------------------------------------------------------
// Toggle a commitment checkbox (v1 audit-only stub).
//
// We DO NOT persist the boolean yet — no `commitments` jsonb column exists on
// mentor_pairings. The audit row carries enough info ({pairingId, index, text,
// done}) for a future migration to replay and reconstruct the state. The
// follow-up migration is flagged in specs/118-.../research.md.
// ---------------------------------------------------------------------------

export async function toggleCommitmentAction(formData: FormData): Promise<void> {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const commitmentActor = actorFrom(session);
  if (!commitmentActor) redirect("/login");

  const pairingId = String(formData.get("pairingId") ?? "").trim();
  const index = Number(formData.get("index") ?? -1);
  const done = String(formData.get("done") ?? "") === "true";
  const text = String(formData.get("text") ?? "").trim();

  if (!pairingId || Number.isNaN(index) || index < 0) {
    redirect(`/mentorship/${pairingId || ""}?error=invalid_commitment`);
  }

  // OWNERSHIP GATE. This action had a session check and nothing else, so any
  // authenticated user could write an unbounded attacker-controlled `text` into
  // the APPEND-ONLY audit log against any pairing id -- rows the application
  // role cannot delete afterwards.
  await assertCanAccessPairing(commitmentActor, pairingId);

  // Bound the free-text field. It is attacker-controlled and lands in a table
  // that is append-only by trigger.
  const boundedText = text.slice(0, 500);

  void recordAudit({
    action: "mentor.commitment.toggled",
    entityType: "mentor_pairing",
    entityId: pairingId,
    metadata: { index, done, text: boundedText },
  });

  revalidatePath(`/mentorship/${pairingId}`);
}
