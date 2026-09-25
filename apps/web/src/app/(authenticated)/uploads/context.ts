import "server-only";

// What a direct upload is FOR, and whether this user may send it there.
//
// Kept out of actions.ts on purpose: every export of a "use server" module is
// a server action the browser can call, and this is not one. Living here, the
// same check can run in the /uploads page before it names the cycle, meeting or
// pairing a link points at, so the page and the reservation cannot disagree
// about who may upload where.

import { eq } from "drizzle-orm";
import { db } from "@gml/db";
import { mentorMeetings } from "@gml/db/schema";
import { notFound } from "next/navigation";
import { assertCanAccessCycle, assertCanAccessPairing, isUuid, type Actor } from "@/lib/authz";
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
      // reserved.
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
      // submission still records who uploaded it.
      return { ok: true, target: { contextType, contextId, quarter: null } };
  }
}
