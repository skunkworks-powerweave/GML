import "server-only";

// What a direct upload is FOR, and whether this user may send it there.
//
// Kept out of actions.ts on purpose: every export of a "use server" module is
// a server action the browser can call, and this is not one. Living here, the
// same check can run in the /uploads page before it names the cycle, meeting or
// pairing a link points at, so the page and the reservation cannot disagree
// about who may upload where.

import { and, desc, eq, lte, ne } from "drizzle-orm";
import { db } from "@gml/db";
import { mentorMeetings, mentorPairings, mentors, observationCycles, teachers } from "@gml/db/schema";
import { notFound } from "next/navigation";
import { hasAnyRole } from "@gml/shared/auth/roles";
import { assertCanAccessCycle, assertCanAccessPairing, isUuid, type Actor } from "@/lib/authz";
import { activeGrant, isAdmin, mentorshipAccess, observationAccess } from "@/lib/visibility";
import type { UploadContextType } from "@/lib/video/upload";

export const UPLOAD_CONTEXT_TYPES: ReadonlySet<string> = new Set<UploadContextType>([
  "observation_cycle",
  "teach_back",
  "mentor_meeting",
  "mentee_quarterly",
  "classroom_session",
  "generic",
]);

/** The two quarters a mentee records a video for: the baseline and the endline. */
export const VIDEO_QUARTERS = [1, 4] as const;
export type VideoQuarter = (typeof VIDEO_QUARTERS)[number];

export type UploadTarget = {
  contextType: UploadContextType;
  contextId: string | null;
  /** Only for 'mentee_quarterly'. */
  quarter: VideoQuarter | null;
};

export type ContextCheck = { ok: true; target: UploadTarget } | { ok: false; error: string };

/**
 * Check that this user may attach a video to this context BEFORE anything is
 * reserved, and say what the context is.
 *
 * contextId arrives from the browser and is attacker-chosen. Without this, a
 * teacher could attach their upload to another teacher's observation cycle --
 * which is not a read of someone else's data but a WRITE into it, and would
 * then appear in that cycle's evidence. Throws notFound() when the actor has no
 * business with the target, so an id they may not see reads as absent.
 *
 * WHAT EACH CONTEXT ID IS, the same as every reader of it (lib/authz.ts
 * assertCanAccessVideo and videoVisibilityFilter, and the WhatsApp MM- branch):
 *
 *   observation_cycle  the cycle
 *   mentor_meeting     the MEETING. This checked it as a pairing id, so the
 *                      meeting's own id was refused (a 404 for the pairing's
 *                      own mentor) and the pairing id it accepted produced a
 *                      recording no reader could resolve -- the mentee got a
 *                      404 for it.
 *   mentee_quarterly   the pairing, with the quarter (1 or 4) it is for
 *
 * A cycle, meeting or quarterly upload with no id is refused. It used to pass
 * ("no id, nothing to check") and was stored linked to nothing: visible to its
 * uploader and administrators only, and on no cycle page.
 */
export async function assertContextAllowed(
  actor: Actor,
  input: { contextType: string; contextId?: string | null; quarter?: number | null },
): Promise<ContextCheck> {
  if (!UPLOAD_CONTEXT_TYPES.has(input.contextType)) return { ok: false, error: "Unknown upload context." };
  const contextType = input.contextType as UploadContextType;
  const contextId = input.contextId?.trim() || null;
  const quarter = input.quarter ?? null;

  if (quarter !== null && contextType !== "mentee_quarterly") {
    return { ok: false, error: "A quarter applies only to a mentee's quarterly video." };
  }

  switch (contextType) {
    case "generic":
      // Attached to nothing, whatever the browser sent as an id.
      return { ok: true, target: { contextType, contextId: null, quarter: null } };

    case "observation_cycle": {
      if (!contextId) return { ok: false, error: "Choose which observation cycle this video is for." };
      const cycle = await assertCanAccessCycle(actor, contextId);
      // Sign-off is the locking transition: the cycle page stops offering an
      // upload, and this refuses one that arrives anyway, before anything is
      // reserved. (One reserved before sign-off and finished after it gets no
      // evidence row and is made generic again, for its uploader to re-file:
      // packages/db/src/uploads.ts, linkSubmissionToContext.)
      if (cycle.status === "complete") {
        return { ok: false, error: "This cycle has been signed off. Its record is closed, so no more evidence can be added." };
      }
      return { ok: true, target: { contextType, contextId, quarter: null } };
    }

    case "mentor_meeting": {
      if (!contextId) return { ok: false, error: "Choose which meeting this recording is for." };
      // A malformed id is never sent to a uuid column (Postgres would answer
      // 22P02, a 500); it names no meeting.
      if (!isUuid(contextId)) notFound();
      const [meeting] = await db
        .select({ pairingId: mentorMeetings.pairingId })
        .from(mentorMeetings)
        .where(eq(mentorMeetings.id, contextId))
        .limit(1);
      if (!meeting) notFound();
      await assertCanAccessPairing(actor, meeting.pairingId);
      return { ok: true, target: { contextType, contextId, quarter: null } };
    }

    case "mentee_quarterly": {
      if (!contextId) return { ok: false, error: "Choose which mentorship pairing this video is for." };
      if (quarter !== 1 && quarter !== 4) {
        return { ok: false, error: "Say whether this is the Q1 (baseline) or the Q4 (endline) video." };
      }
      const pairing = await assertCanAccessPairing(actor, contextId);
      // The endline video belongs to the pairing's last quarter. Q1 stays open:
      // a baseline sent late is still the baseline.
      const current = pairing.currentQuarter ?? 1;
      if (quarter === 4 && current < 4) {
        return { ok: false, error: `The Q4 video is recorded in the pairing's last quarter; this pairing is in Q${current}.` };
      }
      return { ok: true, target: { contextType, contextId, quarter } };
    }

    case "teach_back":
    case "classroom_session":
      // Not scoped to a per-row owner: a teach-back is the uploader's own work,
      // and a classroom session is programme-wide reference data. The
      // submission still records who uploaded it. A malformed id names
      // nothing; it used to reach the uuid column and fail there (22P02, a 500).
      if (contextId && !isUuid(contextId)) notFound();
      return { ok: true, target: { contextType, contextId, quarter: null } };
  }
}

// ── What the /uploads page shows ─────────────────────────────────────────────
//
// The names below -- a cycle's code and topic, who is on a pairing, when they
// met -- are observation and mentorship data, and /uploads sits outside both
// gated sections. So, like every other surface outside them (lib/visibility.ts
// observationAccess / mentorshipAccess), nothing of a section is read until its
// password has been given: the page shows "unlock" instead.

export type GatedSection = "observation" | "mentorship";

const SECTION_OF: Partial<Record<string, GatedSection>> = {
  observation_cycle: "observation",
  mentor_meeting: "mentorship",
  mentee_quarterly: "mentorship",
};

/**
 * The gated section a context belongs to, when this user has not unlocked it;
 * null when it has no section or the password has been given.
 *
 * Asked BEFORE assertContextAllowed wherever its answer reaches the user: a
 * refusal ("This cycle has been signed off"), or a 404 against an "unlock",
 * already says something about a row of the section.
 */
export async function lockedSection(actor: Actor, contextType: string): Promise<GatedSection | null> {
  const section = SECTION_OF[contextType];
  if (!section) return null;
  return (await activeGrant(db, actor.id, section)) ? null : section;
}

export type TargetDescription = {
  /** "Lesson video for OBS-2026-009 · Fractions" */
  title: string;
  /** Who will see it, and where. */
  audience: string;
  /**
   * What a WhatsApp message should carry as its caption to reach the same
   * place, or null when WhatsApp cannot deliver it there.
   */
  whatsappText: string | null;
};

const QUARTER_NAME: Record<VideoQuarter, string> = { 1: "Q1 baseline", 4: "Q4 endline" };

function dateIn(d: Date): string {
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata" });
}

/** "OBS-2026-009", however the code was stored: the form the webhook reads. */
function cycleCaption(code: string): string {
  return `OBS-${code.replace(/^OBS-/i, "")}`;
}

/**
 * Say what an authorised target is, for the page. Call it only with a target
 * assertContextAllowed returned, so a gate answer never confirms that a row
 * exists to someone who may not see it.
 */
export async function describeUploadTarget(
  actor: Actor,
  target: UploadTarget,
): Promise<{ locked: GatedSection } | { locked: null; description: TargetDescription }> {
  const locked = await lockedSection(actor, target.contextType);
  if (locked) return { locked };

  const described = (description: TargetDescription) => ({ locked: null, description }) as const;
  const id = target.contextId;
  switch (target.contextType) {
    case "observation_cycle": {
      const [c] = await db
        .select({ code: observationCycles.code, topic: observationCycles.topic, teacherName: teachers.fullName })
        .from(observationCycles)
        .innerJoin(teachers, eq(teachers.id, observationCycles.teacherId))
        .where(eq(observationCycles.id, id!))
        .limit(1);
      return described({
        title: `Lesson video for ${c!.code}${c!.topic ? ` · ${c!.topic}` : ""}${actor.role === "teacher" ? "" : ` · ${c!.teacherName}`}`,
        audience: "It goes on the cycle's Evidence, where the teacher, the observer and the mentor review it.",
        whatsappText: cycleCaption(c!.code),
      });
    }
    case "mentor_meeting": {
      const [m] = await db
        .select({ scheduledAt: mentorMeetings.scheduledAt, mentorName: mentors.name, teacherName: teachers.fullName })
        .from(mentorMeetings)
        .innerJoin(mentorPairings, eq(mentorPairings.id, mentorMeetings.pairingId))
        .innerJoin(mentors, eq(mentors.id, mentorPairings.mentorId))
        .innerJoin(teachers, eq(teachers.id, mentorPairings.teacherId))
        .where(eq(mentorMeetings.id, id!))
        .limit(1);
      return described({
        title: `Recording of the meeting on ${dateIn(m!.scheduledAt)} · ${m!.mentorName} ↔ ${m!.teacherName}`,
        audience: "It goes on that meeting in the pairing, for the mentor and the mentee.",
        whatsappText: `MM-${id}`,
      });
    }
    case "mentee_quarterly": {
      const [p] = await db
        .select({ mentorName: mentors.name, teacherName: teachers.fullName })
        .from(mentorPairings)
        .innerJoin(mentors, eq(mentors.id, mentorPairings.mentorId))
        .innerJoin(teachers, eq(teachers.id, mentorPairings.teacherId))
        .where(eq(mentorPairings.id, id!))
        .limit(1);
      return described({
        title: `${QUARTER_NAME[target.quarter!]} video · ${p!.mentorName} ↔ ${p!.teacherName}`,
        audience: "It goes on the pairing page, for the mentor and the mentee.",
        // Q1-<pairing> / Q4-<pairing> (packages/shared/src/whatsapp/caption.ts).
        whatsappText: `Q${target.quarter}-${id}`,
      });
    }
    case "teach_back":
      return described({
        title: "Teach-back video",
        audience: "Mentors and observers review teach-backs.",
        whatsappText: id ? `TB-${id}` : null,
      });
    case "classroom_session":
      return described({ title: "Classroom session video", audience: "Only you and programme administrators can see it.", whatsappText: null });
    case "generic":
      return described({
        title: "Not linked to a cycle, meeting or pairing",
        audience: "Only you and programme administrators can see it.",
        whatsappText: "OBS-",
      });
  }
}

export type UploadOption = { target: UploadTarget; href: string; title: string; detail: string };

/**
 * A target as one form value, "type|id|quarter" -- what the attach control on
 * /uploads posts. decodeTarget answers null for anything malformed; the value
 * is still only a claim, which assertContextAllowed checks.
 */
export function encodeTarget(t: UploadTarget): string {
  return `${t.contextType}|${t.contextId ?? ""}|${t.quarter ?? ""}`;
}

export function decodeTarget(value: string): { contextType: string; contextId: string | null; quarter: number | null } | null {
  const parts = value.split("|");
  if (parts.length !== 3 || !parts[0]) return null;
  const quarter = parts[2] ? Number(parts[2]) : null;
  if (quarter !== null && !Number.isInteger(quarter)) return null;
  return { contextType: parts[0], contextId: parts[1] || null, quarter };
}

export function uploadHref(t: { contextType: string; contextId?: string | null; quarter?: number | null }): string {
  const q = new URLSearchParams({ context: t.contextType });
  if (t.contextId) q.set("contextId", t.contextId);
  if (t.quarter) q.set("quarter", String(t.quarter));
  return `/uploads?${q.toString()}`;
}

/**
 * The user's own open places a video can go, for the /uploads chooser:
 *
 *   teacher   her cycles not yet signed off; her Q1 video (Q4 in the last
 *             quarter) for each active pairing
 *   observer  the cycles she observes, not yet signed off
 *   mentor    his mentees' open cycles; his most recent past meetings
 *
 * Administrators get none: they arrive from the cycle or pairing they are
 * looking at, and a list of every open cycle in the programme is not a choice.
 * `locked` names each section whose password has not been given.
 */
export async function openUploadContexts(actor: Actor): Promise<{ options: UploadOption[]; locked: GatedSection[] }> {
  const options: UploadOption[] = [];
  const locked: GatedSection[] = [];
  if (isAdmin(actor)) return { options, locked };

  if (hasAnyRole(actor.role, ["teacher", "observer", "mentor"])) {
    const access = await observationAccess(db, actor);
    if (!access.granted) locked.push("observation");
    else {
      const cycles = await db
        .select({ id: observationCycles.id, code: observationCycles.code, topic: observationCycles.topic, status: observationCycles.status, teacherName: teachers.fullName })
        .from(observationCycles)
        .innerJoin(teachers, eq(teachers.id, observationCycles.teacherId))
        .where(and(ne(observationCycles.status, "complete"), access.where))
        .orderBy(desc(observationCycles.scheduledAt))
        .limit(20);
      for (const c of cycles) {
        const target: UploadTarget = { contextType: "observation_cycle", contextId: c.id, quarter: null };
        options.push({
          target,
          href: uploadHref(target),
          title: `Lesson video for ${c.code}${c.topic ? ` · ${c.topic}` : ""}`,
          detail: actor.role === "teacher" ? `Cycle ${c.status.replace(/_/g, " ")}` : c.teacherName,
        });
      }
    }
  }

  if (hasAnyRole(actor.role, ["teacher", "mentor"])) {
    const access = await mentorshipAccess(db, actor);
    if (!access.granted) locked.push("mentorship");
    else if (actor.role === "teacher") {
      const pairings = await db
        .select({ id: mentorPairings.id, currentQuarter: mentorPairings.currentQuarter, mentorName: mentors.name })
        .from(mentorPairings)
        .innerJoin(mentors, eq(mentors.id, mentorPairings.mentorId))
        .where(and(eq(mentorPairings.status, "active"), access.where));
      for (const p of pairings) {
        // The Q1 video until the last quarter -- a baseline sent late is still
        // the baseline, as the check above and the pairing page have it -- and
        // the Q4 video in it. Q2 and Q3 used to offer no slot at all.
        const quarter: VideoQuarter = (p.currentQuarter ?? 1) >= 4 ? 4 : 1;
        const target: UploadTarget = { contextType: "mentee_quarterly", contextId: p.id, quarter };
        options.push({
          target,
          href: uploadHref(target),
          title: `${QUARTER_NAME[quarter]} video for your mentor`,
          detail: p.mentorName,
        });
      }
    } else {
      const meetings = await db
        .select({ id: mentorMeetings.id, scheduledAt: mentorMeetings.scheduledAt, teacherName: teachers.fullName })
        .from(mentorMeetings)
        .innerJoin(mentorPairings, eq(mentorPairings.id, mentorMeetings.pairingId))
        .innerJoin(teachers, eq(teachers.id, mentorPairings.teacherId))
        // With or without a recording: a meeting can have several (the next
        // part of a long one, a replacement), and the pairing page lists each.
        .where(and(eq(mentorPairings.status, "active"), lte(mentorMeetings.scheduledAt, new Date()), access.where))
        .orderBy(desc(mentorMeetings.scheduledAt))
        .limit(10);
      for (const m of meetings) {
        const target: UploadTarget = { contextType: "mentor_meeting", contextId: m.id, quarter: null };
        options.push({
          target,
          href: uploadHref(target),
          title: `Recording of your meeting on ${dateIn(m.scheduledAt)}`,
          detail: m.teacherName,
        });
      }
    }
  }
  return { options, locked };
}
