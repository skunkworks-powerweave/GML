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
import { and, eq, notInArray, sql } from "drizzle-orm";
import { db } from "@gml/db";
import { notify } from "@gml/db/notify";
import { mentorPairings, mentorMeetings, mentors, teachers, videoSubmissions } from "@gml/db/schema";
import { auth } from "@/auth";
import { requireRole } from "@/lib/guards";
import { hasAnyRole } from "@gml/shared/auth/roles";
import { actorFrom, assertCanAccessPairing, pairingClosed } from "@/lib/authz";
import { assertSectionGate } from "@/lib/gates";
import { recordAudit } from "@/lib/audit";
import { isUuid } from "@/lib/ids";

/**
 * The two people on a pairing, as users, for notify(). Either may be null: a
 * mentor record need not have a login, nor a teacher's. Their user ids only:
 * what a notification says must not name them (see logMeetingAction).
 */
async function pairingParties(pairing: { mentorId: string; teacherId: string }) {
  const [m] = await db.select({ userId: mentors.userId }).from(mentors).where(eq(mentors.id, pairing.mentorId)).limit(1);
  const [t] = await db.select({ userId: teachers.userId }).from(teachers).where(eq(teachers.id, pairing.teacherId)).limit(1);
  return { mentor: m ?? null, mentee: t ?? null };
}

/** "Thu 2 Oct, 10:30 am", in the programme's timezone. */
function meetingWhen(d: Date): string {
  return d.toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

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

  // A WHOLE NUMBER OF MINUTES. The field was free text, so "forty" was stored
  // and rendered as "fortym". Optional; when given, 1..600.
  if (durationMinRaw.length > 0) {
    const minutes = Number(durationMinRaw);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 600) {
      redirect(`/mentorship/${pairingId}?logMeeting=1&error=invalid_duration`);
    }
  }

  // OWNERSHIP GATE. What stood here was described as a "cheap guard against URL
  // tampering", but it only confirmed the pairing EXISTED -- not that the caller
  // had anything to do with it. With no role check either, any authenticated
  // user could log meetings against any mentorship pairing and bump its
  // meetings_count / last_meeting_at counters.
  const actor = actorFrom(session);
  if (!actor) redirect("/login");
  // THE MENTOR LOGS MEETINGS (or an administrator). The page says "Mentor logs
  // every contact", yet the mentee was offered the button and her posts were
  // accepted -- and nothing could remove a meeting row, so a mistaken entry
  // inflated meetings_count on the list and the dashboard for good. (The
  // mentor can now remove one: cancelMeetingAction.)
  if (!hasAnyRole(actor.role, ["mentor", "programme_admin", "super_admin"])) {
    redirect(`/mentorship/${pairingId}?error=meetings_mentor_only`);
  }
  // SECTION GATE. Asserted HERE and not left to the layout: Next runs a Server
  // Action to completion BEFORE it renders any layout, so observation/layout.tsx's
  // assertSectionGate never executes on a mutation. Every action in this file
  // was therefore reachable by anyone who had never entered the section
  // password -- and because rotation works by invalidating grants, an
  // unasserted action is also an unrevoked one. The section-level rotatable
  // password is a hard product requirement; a gate that guards only the reading
  // of a page and none of the writing does not meet it.
  await assertSectionGate(actor.id, "mentorship", "/mentorship");
  const pairing = await assertCanAccessPairing(actor, pairingId);
  if (pairingClosed(pairing)) redirect(`/mentorship/${pairingId}?error=pairing_closed`);

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
        // GREATEST, not an assignment. "Last meeting" means the most recent
        // one, and this used to be set unconditionally to whatever date was
        // submitted -- so back-filling a meeting from three months ago moved
        // the pairing's "last meeting" backwards to it. The dashboard's
        // stale-pairing view reads this column, so a mentor doing the
        // conscientious thing and recording a missed entry made their pairing
        // look neglected.
        lastMeetingAt: sql`GREATEST(COALESCE(${mentorPairings.lastMeetingAt}, ${scheduledAt}), ${scheduledAt})`,
      })
      .where(eq(mentorPairings.id, pairingId));
  });

  void recordAudit({
    action: "mentor.meeting.logged",
    entityType: "mentor_meeting",
    entityId: newMeetingId,
    metadata: { pairingId, scheduledAt: scheduledAt.toISOString() },
  });

  // TELL THE OTHER PARTY. The settings page offers "Meeting scheduled --
  // Mentor + teacher receive calendar entry", on by default, and nothing ever
  // wrote it: the mentee's bell stayed at 0. Both parties, minus whoever
  // logged it; the row opens the pairing. notify() never throws, so the
  // meeting stands whatever happens to the bell.
  //
  // NOTHING THE SECTION PASSWORD GUARDS goes into the row: no notes, no names.
  // /inbox has no gate, and a subject naming mentor and mentee with the notes
  // as its body put the pairing roster and the meeting record in front of a
  // borrowed session that never entered the password. The row opens the
  // (gated) pairing page, which shows both.
  const parties = await pairingParties(pairing);
  await notify(
    db,
    [parties.mentor?.userId, parties.mentee?.userId]
      .filter((u): u is string => Boolean(u))
      .map((userId) => ({
        userId,
        kind: "meeting.scheduled",
        subject: `A mentorship meeting was logged for ${meetingWhen(scheduledAt)}`,
        body: null,
        entityType: "mentor_pairing",
        entityId: pairingId,
      })),
    { excludeUserId: actor.id },
  );

  revalidatePath(`/mentorship/${pairingId}`);
  redirect(`/mentorship/${pairingId}`);
}

// ---------------------------------------------------------------------------
// Cancel (remove) a logged meeting.
//
// There was no way to remove a meeting at all: a mistaken or called-off entry
// stayed on the pairing and in meetings_count -- the list page and the
// dashboard's stale-pairing view read it -- for good. The mentor (or an
// administrator) removes it here; the counters are recomputed from what is
// left.
//
// AN UPCOMING MEETING IS CANCELLED, and the other party is told
// (meeting.cancelled). A meeting whose time has passed is REMOVED from the
// record -- a mistaken entry -- and nobody is told it was "cancelled": it
// either happened or never did.
//
// ONLY ONCE CONFIRMED. The delete is permanent, and the page offered it as a
// single button on a touch-first product. Without `confirm=1` nothing changes
// and the page is sent back asking (?confirmCancel=<id>); the page's own
// buttons only link to that question.
//
// A meeting with a recording attached is kept: video_submissions points at it
// by id with no foreign key, and removing the meeting would orphan the video.
//
// Form fields: pairingId, meetingId (both uuids), confirm ("1").
// ---------------------------------------------------------------------------

export async function cancelMeetingAction(formData: FormData): Promise<void> {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const actor = actorFrom(session);
  if (!actor) redirect("/login");

  const pairingId = String(formData.get("pairingId") ?? "").trim();
  const meetingId = String(formData.get("meetingId") ?? "").trim();
  if (!pairingId || !meetingId) redirect(`/mentorship/${pairingId || ""}?error=invalid_meeting`);
  if (!hasAnyRole(actor.role, ["mentor", "programme_admin", "super_admin"])) {
    redirect(`/mentorship/${pairingId}?error=meetings_mentor_only`);
  }
  // SECTION GATE, in the action for the reason every action in this file
  // asserts it (see logMeetingAction).
  await assertSectionGate(actor.id, "mentorship", "/mentorship");
  const pairing = await assertCanAccessPairing(actor, pairingId);
  if (pairingClosed(pairing)) redirect(`/mentorship/${pairingId}?error=pairing_closed`);

  // The meeting must be THIS pairing's: a meeting id from another pairing, or
  // a malformed one (never sent to a uuid column), is treated as absent.
  const [meeting] = isUuid(meetingId)
    ? await db
        .select({ id: mentorMeetings.id, scheduledAt: mentorMeetings.scheduledAt, recordingVideoId: mentorMeetings.recordingVideoId })
        .from(mentorMeetings)
        .where(and(eq(mentorMeetings.id, meetingId), eq(mentorMeetings.pairingId, pairingId)))
        .limit(1)
    : [];
  if (!meeting) redirect(`/mentorship/${pairingId}?error=meeting_not_found`);

  const [attached] = await db
    .select({ id: videoSubmissions.id })
    .from(videoSubmissions)
    .where(and(eq(videoSubmissions.contextType, "mentor_meeting"), eq(videoSubmissions.contextId, meetingId)))
    .limit(1);
  if (meeting.recordingVideoId || attached) redirect(`/mentorship/${pairingId}?error=meeting_has_recording`);

  if (String(formData.get("confirm") ?? "") !== "1") {
    redirect(`/mentorship/${pairingId}?confirmCancel=${encodeURIComponent(meetingId)}`);
  }
  const upcoming = new Date(meeting.scheduledAt).getTime() > Date.now();

  await db.transaction(async (tx) => {
    await tx.delete(mentorMeetings).where(eq(mentorMeetings.id, meetingId));
    // Recomputed from the meetings that remain, not decremented blind: the
    // cached counters are what the list page and the dashboard read.
    await tx
      .update(mentorPairings)
      .set({
        meetingsCount: sql`(SELECT count(*)::int FROM ${mentorMeetings} WHERE ${mentorMeetings.pairingId} = ${pairingId})`,
        lastMeetingAt: sql`(SELECT max(${mentorMeetings.scheduledAt}) FROM ${mentorMeetings} WHERE ${mentorMeetings.pairingId} = ${pairingId})`,
      })
      .where(eq(mentorPairings.id, pairingId));
  });

  void recordAudit({
    action: upcoming ? "mentor.meeting.cancelled" : "mentor.meeting.removed",
    entityType: "mentor_meeting",
    entityId: meetingId,
    metadata: { pairingId, scheduledAt: new Date(meeting.scheduledAt).toISOString() },
  });

  if (!upcoming) {
    revalidatePath(`/mentorship/${pairingId}`);
    redirect(`/mentorship/${pairingId}`);
  }

  const parties = await pairingParties(pairing);
  await notify(
    db,
    [parties.mentor?.userId, parties.mentee?.userId]
      .filter((u): u is string => Boolean(u))
      .map((userId) => ({
        userId,
        kind: "meeting.cancelled",
        subject: `Mentorship meeting ${meetingWhen(new Date(meeting.scheduledAt))} cancelled`,
        entityType: "mentor_pairing",
        entityId: pairingId,
      })),
    { excludeUserId: actor.id },
  );

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
  // SECTION GATE. Asserted HERE and not left to the layout: Next runs a Server
  // Action to completion BEFORE it renders any layout, so observation/layout.tsx's
  // assertSectionGate never executes on a mutation. Every action in this file
  // was therefore reachable by anyone who had never entered the section
  // password -- and because rotation works by invalidating grants, an
  // unasserted action is also an unrevoked one. The section-level rotatable
  // password is a hard product requirement; a gate that guards only the reading
  // of a page and none of the writing does not meet it.
  await assertSectionGate(completeActor.id, "mentorship", "/mentorship");
  await assertCanAccessPairing(completeActor, pairingId);

  // Only an open pairing completes: a re-post (the button is hidden, the
  // action is not) overwrote ended_at and wrote a second audit row.
  const endedAt = new Date();
  const updated = await db
    .update(mentorPairings)
    .set({ status: "complete", endedAt })
    .where(and(eq(mentorPairings.id, pairingId), notInArray(mentorPairings.status, ["complete", "ended"])))
    .returning({ id: mentorPairings.id });

  // assertCanAccessPairing found it, so no row updated means it was closed.
  if (updated.length === 0) {
    redirect(`/mentorship/${pairingId}?error=pairing_closed`);
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
  // SECTION GATE. Asserted HERE and not left to the layout: Next runs a Server
  // Action to completion BEFORE it renders any layout, so observation/layout.tsx's
  // assertSectionGate never executes on a mutation. Every action in this file
  // was therefore reachable by anyone who had never entered the section
  // password -- and because rotation works by invalidating grants, an
  // unasserted action is also an unrevoked one. The section-level rotatable
  // password is a hard product requirement; a gate that guards only the reading
  // of a page and none of the writing does not meet it.
  await assertSectionGate(commitmentActor.id, "mentorship", "/mentorship");
  const pairing = await assertCanAccessPairing(commitmentActor, pairingId);
  if (pairingClosed(pairing)) redirect(`/mentorship/${pairingId}?error=pairing_closed`);

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

  // SECTION GATE. Asserted HERE and not left to the layout: Next runs a Server
  // Action to completion BEFORE it renders any layout, so observation/layout.tsx's
  // assertSectionGate never executes on a mutation. Every action in this file
  // was therefore reachable by anyone who had never entered the section
  // password -- and because rotation works by invalidating grants, an
  // unasserted action is also an unrevoked one. The section-level rotatable
  // password is a hard product requirement; a gate that guards only the reading
  // of a page and none of the writing does not meet it.
  await assertSectionGate(actor.id, "mentorship", "/mentorship");
  const pairing = await assertCanAccessPairing(actor, pairingId);
  if (pairingClosed(pairing)) redirect(`/mentorship/${pairingId}?error=pairing_closed`);

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
  //
  // THE CAP IS ON OPEN COMMITMENTS: at most 50 not yet done. It used to count
  // every entry, done ones included, and nothing removes a commitment -- so
  // "mark some done before adding more" could never free a place, and a
  // weekly-meeting pairing filled up within the year for good. A hard ceiling
  // of 500 entries still bounds a row read on every visit to the page.
  //
  // WHETHER IT WAS APPENDED is read back from the row -- is the new entry's id
  // in the array? -- rather than inferred from its length: the old
  // `length >= 50` check after the update reported the 50th commitment as
  // refused while saving it.
  const openCount = sql`(SELECT count(*) FROM jsonb_array_elements(${mentorPairings.commitments}) AS c(e)
    WHERE NOT COALESCE((e->>'done')::boolean, false))`;
  const updated = await db
    .update(mentorPairings)
    .set({
      commitments: sql`CASE
        WHEN ${openCount} >= 50 OR jsonb_array_length(${mentorPairings.commitments}) >= 500
        THEN ${mentorPairings.commitments}
        ELSE ${mentorPairings.commitments} || ${JSON.stringify([entry])}::jsonb
      END`,
    })
    .where(eq(mentorPairings.id, pairingId))
    .returning({
      id: mentorPairings.id,
      appended: sql<boolean>`EXISTS (SELECT 1 FROM jsonb_array_elements(${mentorPairings.commitments}) AS c(e) WHERE e->>'id' = ${entry.id})`,
    });

  if (updated.length === 0) {
    redirect(`/mentorship/${pairingId}?error=pairing_not_found`);
  }
  if (!updated[0]?.appended) {
    redirect(`/mentorship/${pairingId}?error=commitments_full`);
  }

  void recordAudit({
    action: "mentor.commitment.added",
    entityType: "mentor_pairing",
    entityId: pairingId,
    metadata: { commitmentId: entry.id, who },
  });

  revalidatePath(`/mentorship/${pairingId}`);
}
