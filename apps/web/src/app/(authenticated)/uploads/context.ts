import "server-only";

// What a direct upload is FOR, and whether this user may send it there.
//
// Kept out of actions.ts on purpose: every export of a "use server" module is
// a server action the browser can call, and this is not one. Living here, the
// same check can run in the /uploads page before it names the cycle, meeting or
// pairing a link points at, so the page and the reservation cannot disagree
// about who may upload where.

import { and, asc, desc, eq, lte, ne } from "drizzle-orm";
import { db } from "@gml/db";
import { classes, mentorMeetings, mentorPairings, mentors, observationCycles, phases, rttSubjects, schools, sessions, subjects, teachers, terms } from "@gml/db/schema";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { hasAnyRole } from "@gml/shared/auth/roles";
import { INTL_LOCALE, normalizeLocale } from "@/i18n/config";
import { assertCanAccessCycle, assertCanAccessPairing, isUuid, pairingClosed, sessionVideoAccess, type Actor } from "@/lib/authz";
import { rttScope } from "@/lib/rtt/scope";
import { activeGrant, isAdmin, mentorshipAccess, observationAccess } from "@/lib/visibility";
import type { UploadContextType } from "@/lib/video/upload";

// Everything below that a person reads -- a refusal, what a target is, who
// will see it -- is in the user's language (video.context.*): the page shows
// it, and beginUploadAction returns a refusal straight to the upload screen.

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
 *   teach_back         the RTT SUBJECT taught back, one the uploader is shown
 *                      (lib/rtt/scope.ts). It was any uuid at all -- the
 *                      "teach_backs" namespace it was left to does not exist
 *                      -- so no page could offer a teach-back, and a
 *                      hand-typed one named nothing a reviewer could look up.
 *   classroom_session  the SESSION, one the uploader may attach to: her own
 *                      (a teacher) or any (a programme administrator), as
 *                      lib/authz.ts sessionVideoAccess. It took any session
 *                      id from anyone. With no id the video stays private to
 *                      its uploader.
 *
 * A cycle, meeting, quarterly or teach-back upload with no id is refused. It
 * used to pass ("no id, nothing to check") and was stored linked to nothing:
 * visible to its uploader and administrators only, and on no cycle page.
 */
export async function assertContextAllowed(
  actor: Actor,
  input: { contextType: string; contextId?: string | null; quarter?: number | null },
): Promise<ContextCheck> {
  const t = await getTranslations("video");
  if (!UPLOAD_CONTEXT_TYPES.has(input.contextType)) return { ok: false, error: t("context.error.unknown") };
  const contextType = input.contextType as UploadContextType;
  const contextId = input.contextId?.trim() || null;
  const quarter = input.quarter ?? null;

  if (quarter !== null && contextType !== "mentee_quarterly") {
    return { ok: false, error: t("context.error.quarterOnly") };
  }

  switch (contextType) {
    case "generic":
      // Attached to nothing, whatever the browser sent as an id.
      return { ok: true, target: { contextType, contextId: null, quarter: null } };

    case "observation_cycle": {
      if (!contextId) return { ok: false, error: t("context.error.chooseCycle") };
      const cycle = await assertCanAccessCycle(actor, contextId);
      // Sign-off is the locking transition: the cycle page stops offering an
      // upload, and this refuses one that arrives anyway, before anything is
      // reserved. (One reserved before sign-off and finished after it gets no
      // evidence row and is made generic again, for its uploader to re-file:
      // packages/db/src/uploads.ts, linkSubmissionToContext.)
      if (cycle.status === "complete") {
        return { ok: false, error: t("context.error.cycleSignedOff") };
      }
      return { ok: true, target: { contextType, contextId, quarter: null } };
    }

    case "mentor_meeting": {
      if (!contextId) return { ok: false, error: t("context.error.chooseMeeting") };
      // A malformed id is never sent to a uuid column (Postgres would answer
      // 22P02, a 500); it names no meeting.
      if (!isUuid(contextId)) notFound();
      const [meeting] = await db
        .select({ pairingId: mentorMeetings.pairingId })
        .from(mentorMeetings)
        .where(eq(mentorMeetings.id, contextId))
        .limit(1);
      if (!meeting) notFound();
      if (pairingClosed(await assertCanAccessPairing(actor, meeting.pairingId))) {
        return { ok: false, error: t("context.error.closedPairing") };
      }
      return { ok: true, target: { contextType, contextId, quarter: null } };
    }

    case "mentee_quarterly": {
      if (!contextId) return { ok: false, error: t("context.error.choosePairing") };
      if (quarter !== 1 && quarter !== 4) {
        return { ok: false, error: t("context.error.chooseQuarter") };
      }
      const pairing = await assertCanAccessPairing(actor, contextId);
      if (pairingClosed(pairing)) return { ok: false, error: t("context.error.closedPairing") };
      // The endline video belongs to the pairing's last quarter. Q1 stays open:
      // a baseline sent late is still the baseline.
      const current = pairing.currentQuarter ?? 1;
      if (quarter === 4 && current < 4) {
        return { ok: false, error: t("context.error.q4NotYet", { quarter: current }) };
      }
      return { ok: true, target: { contextType, contextId, quarter } };
    }

    case "teach_back": {
      if (!contextId) return { ok: false, error: t("context.error.chooseSubject") };
      if (!isUuid(contextId)) notFound();
      // The subject page's own predicate: an active subject taught where the
      // teacher is (staff: the whole programme). A retired subject, another
      // district's, or an id that is no subject reads as absent, as it does on
      // /rtt/subject/[id]. A teach-back is still the uploader's own work: no
      // per-row owner is checked beyond that.
      const scope = await rttScope(db, actor);
      const [subject] = await db
        .select({ id: rttSubjects.id })
        .from(rttSubjects)
        .where(and(eq(rttSubjects.id, contextId), scope.subjectWhere))
        .limit(1);
      if (!subject) notFound();
      return { ok: true, target: { contextType, contextId, quarter: null } };
    }

    case "classroom_session":
      // A malformed id, an unknown session and a colleague's session are all
      // absent: a 404, and never a Postgres 22P02 (a 500).
      if (contextId && !(await sessionVideoAccess(actor, contextId))) notFound();
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

/** A meeting's date, in the user's language ("27 September 2026"). */
async function dateFormatter(): Promise<(d: Date) => string> {
  const intl = INTL_LOCALE[normalizeLocale(await getLocale())];
  return (d) => d.toLocaleDateString(intl, { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata" });
}

/** "Lesson video for OBS-2026-009 · Fractions · Asha": the sentence, then the data. */
function joined(first: string, ...rest: Array<string | null | undefined | false>): string {
  return [first, ...rest.filter((p): p is string => Boolean(p))].join(" · ");
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

  const t = await getTranslations("video");
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
        title: joined(t("context.title.lesson", { code: c!.code }), c!.topic, actor.role !== "teacher" && c!.teacherName),
        audience: t("context.audience.cycle"),
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
      const date = await dateFormatter();
      return described({
        title: t("context.title.meeting", { date: date(m!.scheduledAt), mentor: m!.mentorName, teacher: m!.teacherName }),
        audience: t("context.audience.meeting"),
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
      const names = { mentor: p!.mentorName, teacher: p!.teacherName };
      return described({
        title: target.quarter === 4 ? t("context.title.quarterlyQ4", names) : t("context.title.quarterlyQ1", names),
        audience: t("context.audience.quarterly"),
        // Q1-<pairing> / Q4-<pairing> (packages/shared/src/whatsapp/caption.ts).
        whatsappText: `Q${target.quarter}-${id}`,
      });
    }
    case "teach_back": {
      const [s] = await db.select({ name: rttSubjects.name }).from(rttSubjects).where(eq(rttSubjects.id, id!)).limit(1);
      return described({
        title: t("context.title.teachBack", { subject: s!.name }),
        audience: t("context.audience.teachBack"),
        // TB-<subject> (packages/shared/src/whatsapp/caption.ts); the webhook
        // holds it to the same subject check as assertContextAllowed.
        whatsappText: `TB-${id}`,
      });
    }
    case "classroom_session": {
      if (!id) return described({ title: t("context.title.classroomSession"), audience: t("context.audience.private"), whatsappText: null });
      const [s] = await db
        .select({ grade: classes.grade, school: schools.name, subject: subjects.name, topic: sessions.topic, date: sessions.scheduledDate, teacherName: teachers.fullName })
        .from(sessions)
        .innerJoin(classes, eq(classes.id, sessions.classId))
        .innerJoin(schools, eq(schools.id, sessions.schoolId))
        .innerJoin(subjects, eq(subjects.id, sessions.subjectId))
        .innerJoin(teachers, eq(teachers.id, sessions.teacherId))
        .where(eq(sessions.id, id))
        .limit(1);
      const date = await dateFormatter();
      return described({
        title: joined(t("context.title.session", { grade: s!.grade, date: date(new Date(`${s!.date}T00:00:00+05:30`)) }), s!.subject, s!.topic, actor.role !== "teacher" && `${s!.school} · ${s!.teacherName}`),
        audience: t("context.audience.session"),
        whatsappText: null,
      });
    }
    case "generic":
      return described({
        title: t("context.title.generic"),
        audience: t("context.audience.private"),
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
 *             quarter) for each active pairing; a teach-back for each RTT
 *             subject she is shown
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
  const t = await getTranslations("video");

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
          title: joined(t("context.title.lesson", { code: c.code }), c.topic),
          detail: actor.role === "teacher" ? t("context.option.cycleStatus", { status: c.status }) : c.teacherName,
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
          title: quarter === 4 ? t("context.option.quarterlyQ4") : t("context.option.quarterlyQ1"),
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
      const date = await dateFormatter();
      for (const m of meetings) {
        const target: UploadTarget = { contextType: "mentor_meeting", contextId: m.id, quarter: null };
        options.push({
          target,
          href: uploadHref(target),
          title: t("context.option.meeting", { date: date(m.scheduledAt) }),
          detail: m.teacherName,
        });
      }
    }
  }

  // Teach-backs are RTT's, which has no section password. Only a teacher is
  // offered them: she teaches a subject back, and mentors and observers review
  // what she sends (the /rtt/teach-back queue). Nothing offered one before, so
  // the queue, the mentor's card and the badge had nothing to count.
  if (actor.role === "teacher") {
    const scope = await rttScope(db, actor);
    const subjects = await db
      .select({ id: rttSubjects.id, name: rttSubjects.name, term: terms.name, phase: phases.label })
      .from(rttSubjects)
      .innerJoin(terms, eq(terms.id, rttSubjects.termId))
      .innerJoin(phases, eq(phases.id, terms.phaseId))
      .where(scope.subjectWhere)
      .orderBy(asc(phases.sequence), asc(terms.sequence), asc(rttSubjects.name))
      .limit(20);
    for (const s of subjects) {
      const target: UploadTarget = { contextType: "teach_back", contextId: s.id, quarter: null };
      options.push({ target, href: uploadHref(target), title: t("context.option.teachBack", { subject: s.name }), detail: `${s.phase} · ${s.term}` });
    }
  }
  return { options, locked };
}
