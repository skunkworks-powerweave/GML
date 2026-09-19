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

import { randomUUID } from "node:crypto";
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
  const commitmentId = String(formData.get("commitmentId") ?? "").trim();
  if (!pairingId || !commitmentId) {
    redirect(`/mentorship/${pairingId || ""}?error=invalid_commitment`);
  }

  // OWNERSHIP GATE. This action had a session check and nothing else, so any
  // authenticated user could write an unbounded attacker-controlled string into
  // the APPEND-ONLY audit log against any pairing id -- rows the application
  // role cannot delete afterwards.
  await assertCanAccessPairing(commitmentActor, pairingId);

  // IT NOW PERSISTS. The previous version wrote an audit row and changed
  // nothing: a mentor ticked an item, saw nothing happen, reloaded, and found
  // it untouched. The control had no backing state at all.
  //
  // Addressed BY ID, not by index. The old signature took an array index,
  // which is unstable the moment an item is added or removed -- two mentors
  // editing concurrently would toggle each other's commitments.
  //
  // Done in one SQL statement so a concurrent toggle on a different item
  // cannot be lost to a read-modify-write on the whole array.
  const updated = await db
    .update(mentorPairings)
    .set({
      commitments: sql`(
        SELECT jsonb_agg(
          CASE WHEN elem->>'id' = ${commitmentId}
            THEN elem
                 || jsonb_build_object('done', NOT COALESCE((elem->>'done')::boolean, false))
                 || jsonb_build_object(
                      'doneAt',
                      CASE WHEN COALESCE((elem->>'done')::boolean, false)
                           THEN NULL ELSE to_jsonb(now()) END)
                 || jsonb_build_object(
                      'doneBy',
                      CASE WHEN COALESCE((elem->>'done')::boolean, false)
                           THEN NULL ELSE to_jsonb(${session.user.id}::text) END)
            ELSE elem
          END
          ORDER BY ord
        )
        FROM jsonb_array_elements(${mentorPairings.commitments}) WITH ORDINALITY AS t(elem, ord)
      )`,
    })
    .where(eq(mentorPairings.id, pairingId))
    .returning({ id: mentorPairings.id });

  if (updated.length === 0) {
    redirect(`/mentorship/${pairingId}?error=pairing_not_found`);
  }

  void recordAudit({
    action: "mentor.commitment.toggled",
    entityType: "mentor_pairing",
    entityId: pairingId,
    // The commitment id, not its text. The text is user-supplied and lands in a
    // table that is append-only by trigger; the id is enough to correlate.
    metadata: { commitmentId },
  });

  revalidatePath(`/mentorship/${pairingId}`);
}

/**
 * Add a commitment to a pairing.
 *
 * The register previously rendered a hardcoded array of four placeholder
 * strings -- the same four for every mentor and every teacher -- with no way to
 * add a real one. This is that way.
 */
export async function addCommitmentAction(formData: FormData): Promise<void> {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const actor = actorFrom(session);
  if (!actor) redirect("/login");

  const pairingId = String(formData.get("pairingId") ?? "").trim();
  const text = String(formData.get("text") ?? "").trim().slice(0, 500);
  const whoRaw = String(formData.get("who") ?? "mentee");
  const who = whoRaw === "mentor" ? "mentor" : "mentee";
  const due = String(formData.get("due") ?? "").trim().slice(0, 40) || null;

  if (!pairingId) redirect("/mentorship?error=invalid_commitment");
  if (!text) redirect(`/mentorship/${pairingId}?error=empty_commitment`);

  await assertCanAccessPairing(actor, pairingId);

  const entry = {
    id: randomUUID(),
    text,
    who,
    due,
    done: false,
    doneAt: null,
    doneBy: null,
  };

  // Append in SQL. A read-modify-write would lose a concurrent addition.
  // Capped at 50 so the column cannot grow without bound on a row that is read
  // on every visit to the pairing page.
  const updated = await db
    .update(mentorPairings)
    .set({
      commitments: sql`CASE
        WHEN jsonb_array_length(${mentorPairings.commitments}) >= 50
        THEN ${mentorPairings.commitments}
        ELSE ${mentorPairings.commitments} || ${JSON.stringify([entry])}::jsonb
      END`,
    })
    .where(eq(mentorPairings.id, pairingId))
    .returning({ id: mentorPairings.id });

  if (updated.length === 0) {
    redirect(`/mentorship/${pairingId}?error=pairing_not_found`);
  }

  void recordAudit({
    action: "mentor.commitment.added",
    entityType: "mentor_pairing",
    entityId: pairingId,
    metadata: { commitmentId: entry.id, who },
  });

  revalidatePath(`/mentorship/${pairingId}`);
}
