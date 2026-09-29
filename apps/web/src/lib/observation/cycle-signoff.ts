import "server-only";

// What a sign-off decision does to an observation cycle. Called by the
// observation_signoff approval handler (lib/approvals/handlers/
// observation-signoff.ts) inside the decision's transaction, whichever page
// the decision was taken on (the cycle page or /approvals).
//
//   approved             post_submitted -> complete: the record locks, the
//                        audit row observation.signed_off is the "signed by"
//                        record, and the cycle's other parties are told
//                        (cycle.complete) -- exactly what signing off did
//                        before sign-off went through the approvals queue
//   changes requested /  post_submitted -> observed: the post-observation form
//   rejected             is open to the teacher again (observation.cycle.
//                        sent_back); she is told why
//
// Every status change is ONE guarded UPDATE ... WHERE status = <from>, so a
// stale tab or two approvers at once cannot move a cycle that has already
// moved: the update matches nothing and CycleStateError rolls the whole
// decision back, the approvals row included.
//
// The audit row and the notifications are written through the app's own
// database handle, not the transaction: a failed notification must never
// abort the transaction (Postgres would then quietly roll the decision back at
// COMMIT). They run after the guarded update, the last statement that can
// fail, and both helpers are best-effort and never throw.

import { and, desc, eq } from "drizzle-orm";
import { db as appDb } from "@gml/db";
import { approvals, observationCycles, teachers } from "@gml/db/schema";
import { recordAudit } from "../audit";
import { notifyLocalized } from "../notify-localized";
import type { Actor, Db } from "../visibility";
import { notifyCycleParties } from "./notify";

export type CycleStatus = "nominated" | "pre_submitted" | "observed" | "post_submitted" | "complete";

type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

/** The cycle was not in the status a decision needs: nothing was changed. */
export class CycleStateError extends Error {
  constructor(
    readonly cycleId: string,
    readonly expected: CycleStatus,
  ) {
    // i18n-ignore: a developer-facing error message (logs), never shown to a user
    super(`observation cycle ${cycleId} is not ${expected}`);
    this.name = "CycleStateError";
  }
}

/**
 * Move a cycle from `from` to `to`, or report that it was not in `from`.
 * Returns the cycle's code, or null when the precondition failed.
 *
 * A single UPDATE ... WHERE id = ? AND status = ? ... RETURNING rather than
 * SELECT-then-UPDATE: one atomic round trip, and `.returning` says whether
 * the precondition held (no TOCTOU race when two approvers act at once).
 */
export async function transitionCycleStatus(
  tx: DbOrTx,
  cycleId: string,
  from: CycleStatus,
  to: CycleStatus,
): Promise<string | null> {
  const updated = await tx
    .update(observationCycles)
    .set({ status: to, updatedAt: new Date() })
    .where(and(eq(observationCycles.id, cycleId), eq(observationCycles.status, from)))
    .returning({ code: observationCycles.code });
  if (updated.length === 0) return null;
  return updated[0]!.code;
}

/** Approved: the cycle completes and locks. */
export async function completeCycle(tx: DbOrTx, cycleId: string, actor: Actor): Promise<void> {
  const code = await transitionCycleStatus(tx, cycleId, "post_submitted", "complete");
  if (code === null) throw new CycleStateError(cycleId, "post_submitted");

  // The audit row IS the "signed by" record: metadata.signedByUserId carries
  // the signer, the action timestamps when, and audit_log is append-only
  // (SM-1). The approvals row records the same decision in the queue.
  await recordAudit({
    action: "observation.signed_off",
    entityType: "observation_cycle",
    entityId: cycleId,
    userId: actor.id,
    metadata: {
      code,
      from: "post_submitted",
      to: "complete",
      signedByUserId: actor.id,
      signedAt: new Date().toISOString(),
    },
  });

  // Everyone else on the cycle hears that it closed. Never throws.
  await notifyCycleParties(appDb as unknown as Db, "cycle.complete", cycleId, actor.id);
}

/**
 * Changes requested or rejected: the post-observation form goes back to the
 * teacher. The approvals queue tells whoever submitted the request, with the
 * comment; when that was not the teacher herself (someone submitted the form
 * on her behalf, or a cycle from before sign-off requests was sent back in
 * one step), she is told here instead, so she always hears why.
 */
export async function sendBackCycle(
  tx: DbOrTx,
  cycleId: string,
  decision: "changes_requested" | "rejected",
  ctx: { actor: Actor; comment: string | null },
): Promise<void> {
  const code = await transitionCycleStatus(tx, cycleId, "post_submitted", "observed");
  if (code === null) throw new CycleStateError(cycleId, "post_submitted");

  // Read inside the transaction: the request being decided is the latest.
  const [request] = await tx
    .select({ submittedBy: approvals.submittedByUserId })
    .from(approvals)
    .where(and(eq(approvals.itemType, "observation_signoff"), eq(approvals.itemId, cycleId)))
    .orderBy(desc(approvals.submittedAt))
    .limit(1);
  const [teacher] = await tx
    .select({ userId: teachers.userId })
    .from(observationCycles)
    .innerJoin(teachers, eq(teachers.id, observationCycles.teacherId))
    .where(eq(observationCycles.id, cycleId))
    .limit(1);

  await recordAudit({
    action: "observation.cycle.sent_back",
    entityType: "observation_cycle",
    entityId: cycleId,
    userId: ctx.actor.id,
    metadata: {
      code,
      from: "post_submitted",
      to: "observed",
      decision,
      commentLength: ctx.comment?.length ?? 0,
    },
  });

  const teacherUserId = teacher?.userId ?? null;
  if (teacherUserId && teacherUserId !== request?.submittedBy) {
    // Says nothing the section password guards (lib/observation/notify.ts):
    // no code, teacher, kind or date. The comment is the approver's own words.
    await notifyLocalized(
      appDb as unknown as Db,
      "observation",
      [
        {
          userId: teacherUserId,
          kind: "approval",
          entityType: "observation_cycle",
          entityId: cycleId,
          text: (t) => ({
            subject: t("notify.sentBack.subject"),
            body: t("notify.sentBack.body", { comment: ctx.comment ?? "" }),
          }),
        },
      ],
      { excludeUserId: ctx.actor.id },
    );
  }
}
