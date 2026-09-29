import "server-only";

// Sign-off of an observation cycle, through the approvals queue.
//
//   requestSignOff  the teacher's post-observation form has gone in (the cycle
//                   is post_submitted): an observation_signoff request goes to
//                   her mentor(s) and the programme admins
//   decideSignOff   the Sign off / Send back controls on the cycle page: the
//                   cycle's open request is decided through lib/approvals,
//                   exactly as it would be from /approvals
//
// A cycle that reached post_submitted before sign-off went through the queue
// (or whose request could not be recorded) has no request. It can still be
// signed off or sent back: the request is created already decided, and the
// decision applied, in ONE transaction -- so there is never a request left
// pending for a cycle that did not move, nor a moved cycle without its request.
//
// What a decision does to the cycle is lib/observation/cycle-signoff.ts, via
// the handler in lib/approvals/handlers/observation-signoff.ts.

import { and, eq, sql } from "drizzle-orm";
import { approvals, type ApprovalDecision } from "@gml/db/schema";
import { hasAnyRole } from "@gml/shared/auth/roles";
import { decideApproval, submitForApproval, type ApprovalResult } from "../approvals";
import { observationSignoffHandler } from "../approvals/handlers/observation-signoff";
import { recordAudit } from "../audit";
import type { Actor, Db } from "../visibility";
import { CycleStateError } from "./cycle-signoff";

const ITEM = "observation_signoff" as const;

/** Send a post_submitted cycle for sign-off, as `actor`. */
export async function requestSignOff(db: Db, cycleId: string, actor: Actor): Promise<ApprovalResult> {
  return submitForApproval(db, { itemType: ITEM, itemId: cycleId, actor });
}

export type SignOffOutcome =
  | { ok: true; approvalId: string }
  | { ok: false; error: "invalid_transition" | "not_allowed" | "comment_required" };

/** The cycle's open sign-off request, if it has one. */
export async function pendingSignOffId(db: Db, cycleId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: approvals.id })
    .from(approvals)
    .where(and(eq(approvals.itemType, ITEM), eq(approvals.itemId, cycleId), eq(approvals.status, "pending")))
    .limit(1);
  return row?.id ?? null;
}

/**
 * Decide a cycle's sign-off: approve (comment optional), or send it back
 * (changes_requested / rejected, comment required).
 */
export async function decideSignOff(
  db: Db,
  input: { cycleId: string; actor: Actor; decision: ApprovalDecision; comment?: string | null },
): Promise<SignOffOutcome> {
  const comment = input.comment?.trim() || null;
  if (input.decision !== "approved" && !comment) return { ok: false, error: "comment_required" };

  try {
    const pending = await pendingSignOffId(db, input.cycleId);
    const result = pending
      ? await decideApproval(db, { approvalId: pending, decision: input.decision, comment, actor: input.actor })
      : await decideWithoutRequest(db, { ...input, comment });
    if (result.ok) return { ok: true, approvalId: result.approvalId };
    if (result.error === "not_allowed") return { ok: false, error: "not_allowed" };
    if (result.error === "comment_required") return { ok: false, error: "comment_required" };
    return { ok: false, error: "invalid_transition" };
  } catch (err) {
    // The cycle had already moved (a stale tab, two approvers at once): the
    // decision was rolled back with it.
    if (err instanceof CycleStateError) return { ok: false, error: "invalid_transition" };
    throw err;
  }
}

/**
 * A cycle at post_submitted with no request: record the request already
 * decided and apply the decision, in one transaction. Nobody submitted it
 * through the queue, so it has no submitter, and nobody is asked to approve
 * what is being decided now.
 */
async function decideWithoutRequest(
  db: Db,
  input: { cycleId: string; actor: Actor; decision: ApprovalDecision; comment: string | null },
): Promise<ApprovalResult> {
  const handler = observationSignoffHandler;
  if (!hasAnyRole(input.actor.role, handler.deciderRoles)) return { ok: false, error: "not_allowed" };
  if (!(await handler.canDecide!(db, input.actor, input.cycleId))) return { ok: false, error: "not_allowed" };

  const approvalId = await db.transaction(async (tx) => {
    // The cycle's row first, locked: a post form landing or another decision
    // on this cycle waits for this one, and one that landed first is seen.
    await tx.execute(sql`SELECT id FROM observation_cycles WHERE id = ${input.cycleId} FOR UPDATE`);
    const [open] = await tx
      .select({ id: approvals.id })
      .from(approvals)
      .where(and(eq(approvals.itemType, ITEM), eq(approvals.itemId, input.cycleId), eq(approvals.status, "pending")))
      .limit(1);
    // A request was opened in the meantime: decide that one instead.
    if (open) return null;
    const now = new Date();
    const [row] = await tx
      .insert(approvals)
      .values({
        itemType: ITEM,
        itemId: input.cycleId,
        status: input.decision,
        submittedByUserId: null,
        submittedAt: now,
        decidedByUserId: input.actor.id,
        decidedAt: now,
        comment: input.comment,
      })
      .returning({ id: approvals.id });
    await handler.onDecision(tx, input.cycleId, input.decision, { actor: input.actor, comment: input.comment });
    return row!.id;
  });
  if (approvalId === null) {
    const pending = await pendingSignOffId(db, input.cycleId);
    if (!pending) return { ok: false, error: "not_pending" };
    return decideApproval(db, { approvalId: pending, decision: input.decision, comment: input.comment, actor: input.actor });
  }

  // The same two rows lib/approvals writes for a request made and decided
  // through the queue.
  await recordAudit({
    action: "approval.submitted",
    entityType: ITEM,
    entityId: input.cycleId,
    userId: input.actor.id,
    metadata: { approvalId },
  });
  await recordAudit({
    action: "approval.decided",
    entityType: ITEM,
    entityId: input.cycleId,
    userId: input.actor.id,
    metadata: { approvalId, decision: input.decision },
  });
  return { ok: true, approvalId };
}
