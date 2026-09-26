// Which feedback-form draft a request means, and whether the caller may touch
// the pairing it is about.
//
// A draft of a feedback form is identified by (user, template, PAIRING). The
// pairing used to be missing from the key, so one mentor had one draft per
// form shared by every mentee: mentee A's half-written answers pre-filled
// mentee B's form, and submitting B deleted A's work. The runner page, its
// submit action and /api/form-drafts all select, write and clear drafts
// through templateDraftWhere(), so the three cannot disagree about the key
// again. Migration 0031 adds the column and the unique index.

import { and, eq, isNull, type SQL } from "drizzle-orm";
import { formDrafts, mentorPairings } from "@gml/db/schema";
import { isUuid } from "@/lib/ids";
import { mentorshipAccess, type Actor, type Db } from "@/lib/visibility";

/**
 * The one draft for this user, form and pairing. `pairingId` null is the
 * draft of a form opened without one (an administrator's preview) -- matched
 * with IS NULL, never left out, or it would match every pairing's draft.
 */
export function templateDraftWhere(userId: string, templateId: string, pairingId: string | null): SQL {
  return and(
    eq(formDrafts.userId, userId),
    eq(formDrafts.templateId, templateId),
    pairingId ? eq(formDrafts.pairingId, pairingId) : isNull(formDrafts.pairingId),
  ) as SQL;
}

/**
 * May `actor` keep a draft about this pairing -- or, for `pairingId` null, the
 * draft of a form opened without one?
 *
 *   "ok"         the mentorship section is unlocked and, for a pairing, the
 *                pairing exists and is the actor's
 *   "locked"     no mentorship grant: a draft about a mentee is mentorship data
 *                and the section password guards it like the rest
 *   "not_found"  malformed, absent, or someone else's -- indistinguishable, as
 *                assertCanAccessPairing makes them
 *
 * A draft WITHOUT a pairing needs the password too. Every feedback form is a
 * mentorship form, and the pairing-less rows include every draft written
 * before drafts had a pairing -- the one draft a mentor shared across all her
 * mentees, so in fact about one of them. Unguarded, the bare runner URL and
 * this API served those to a session that never entered the password.
 */
export async function pairingDraftAccess(
  db: Db,
  actor: Actor,
  pairingId: string | null,
): Promise<"ok" | "locked" | "not_found"> {
  if (pairingId !== null && !isUuid(pairingId)) return "not_found";
  const access = await mentorshipAccess(db, actor);
  if (!access.granted) return "locked";
  if (pairingId === null) return "ok";
  const [row] = await db
    .select({ id: mentorPairings.id })
    .from(mentorPairings)
    .where(and(eq(mentorPairings.id, pairingId), ...(access.where ? [access.where] : [])))
    .limit(1);
  return row ? "ok" : "not_found";
}
