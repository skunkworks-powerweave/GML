import "server-only";

// The approvals queue: one place where everything that needs a decision waits.
//
//   submitForApproval   the owner sends an item: a pending row is recorded,
//                       the item's handler marks it (e.g. a session becomes
//                       "pending"), the approvers get an inbox message
//   decideApproval      an approver approves, requests changes or rejects:
//                       the row records who, when and why, the handler applies
//                       it to the item, the submitter gets an inbox message
//   listApprovals /     the queue and its count, for what the viewer may decide
//   pendingApprovalCount
//   latestApprovals     each item's most recent request: its state and the
//                       approver's comment, shown to the owner
//
// Both writes run in one transaction with the handler's own change, so an
// item is never "approved" in the queue and still "pending" on its page. A
// decision is taken only while the row is still pending (compare-and-set), so
// two approvers cannot both decide the same request. Every submission and
// decision is audited. Handlers: ./registry.ts. Design:
// docs/superpowers/specs/2026-09-28-teaching-records-design.md.

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { APPROVAL_DECISIONS, approvals, users, type ApprovalDecision, type ApprovalItemType } from "@gml/db/schema";
import { hasAnyRole } from "@gml/shared/auth/roles";
import { recordAudit } from "@/lib/audit";
import { notifyLocalized } from "@/lib/notify-localized";
import type { Actor, Db } from "@/lib/visibility";
import { APPROVAL_HANDLERS } from "./registry";
import type { ItemSummary } from "./types";

export { isEditable } from "./handlers/records";
export type { ItemSummary } from "./types";

export type ApprovalResult =
  | { ok: true; approvalId: string }
  | { ok: false; error: "not_allowed" | "already_pending" | "not_pending" | "comment_required" | "not_found" | "decision_not_allowed" };

/** The notification kind approvals write (lib/notification-kinds.ts). */
const NOTIFY_KIND = "approval";

async function defaultApprovers(db: Db, roles: readonly string[]): Promise<string[]> {
  const rows = await db
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(and(eq(users.active, true), inArray(users.role, roles as never)));
  return rows.map((r) => r.id);
}

/** Send `itemId` of `itemType` for approval, as `actor`, with an optional note. */
export async function submitForApproval(
  db: Db,
  input: { itemType: ApprovalItemType; itemId: string; actor: Actor; note?: string | null },
): Promise<ApprovalResult> {
  const handler = APPROVAL_HANDLERS[input.itemType];
  if (!(await handler.canSubmit(db, input.actor, input.itemId))) return { ok: false, error: "not_allowed" };

  let approvalId: string;
  try {
    approvalId = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(approvals)
        .values({
          itemType: input.itemType,
          itemId: input.itemId,
          note: input.note?.trim() || null,
          submittedByUserId: input.actor.id,
        })
        .returning({ id: approvals.id });
      await handler.onSubmit?.(tx, input.itemId);
      return row!.id;
    });
  } catch (err) {
    // approvals_one_pending_uq: this item already has an open request.
    if ((err as { code?: string }).code === "23505" || (err as { cause?: { code?: string } }).cause?.code === "23505") {
      return { ok: false, error: "already_pending" };
    }
    throw err;
  }

  await recordAudit({
    action: "approval.submitted",
    entityType: input.itemType,
    entityId: input.itemId,
    userId: input.actor.id,
    metadata: { approvalId },
  });

  const summary = (await handler.describe(db, [input.itemId])).get(input.itemId);
  const approverIds = handler.approverUserIds
    ? await handler.approverUserIds(db, input.itemId)
    : await defaultApprovers(db, handler.deciderRoles);
  await notifyLocalized(
    db,
    "approvals",
    approverIds.map((userId) => ({
      userId,
      kind: NOTIFY_KIND,
      entityType: "approval",
      entityId: approvalId,
      text: (t) => ({
        subject: t("notify.submitted", { kind: t(`kinds.${input.itemType}`), title: summary?.title ?? "" }),
        body: input.note?.trim() || null,
      }),
    })),
    { excludeUserId: input.actor.id },
  );
  return { ok: true, approvalId };
}

/** Decide a pending request. Changes requested and rejections need a comment. */
export async function decideApproval(
  db: Db,
  input: { approvalId: string; decision: ApprovalDecision; comment?: string | null; actor: Actor },
): Promise<ApprovalResult> {
  const comment = input.comment?.trim() || null;
  if (input.decision !== "approved" && !comment) return { ok: false, error: "comment_required" };

  const [row] = await db.select().from(approvals).where(eq(approvals.id, input.approvalId)).limit(1);
  if (!row) return { ok: false, error: "not_found" };
  if (row.status !== "pending") return { ok: false, error: "not_pending" };
  const handler = APPROVAL_HANDLERS[row.itemType];
  if (!hasAnyRole(input.actor.role, handler.deciderRoles)) return { ok: false, error: "not_allowed" };
  if (handler.canDecide && !(await handler.canDecide(db, input.actor, row.itemId))) return { ok: false, error: "not_allowed" };
  if (!decisionsFor(row.itemType).includes(input.decision)) return { ok: false, error: "decision_not_allowed" };

  const decided = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(approvals)
      .set({ status: input.decision, decidedByUserId: input.actor.id, decidedAt: new Date(), comment })
      .where(and(eq(approvals.id, row.id), eq(approvals.status, "pending")))
      .returning({ id: approvals.id });
    if (!updated) return false;
    await handler.onDecision(tx, row.itemId, input.decision, { actor: input.actor, comment });
    return true;
  });
  if (!decided) return { ok: false, error: "not_pending" };

  await recordAudit({
    action: "approval.decided",
    entityType: row.itemType,
    entityId: row.itemId,
    userId: input.actor.id,
    metadata: { approvalId: row.id, decision: input.decision },
  });

  if (row.submittedByUserId) {
    const summary = (await handler.describe(db, [row.itemId])).get(row.itemId);
    await notifyLocalized(db, "approvals", [
      {
        userId: row.submittedByUserId,
        kind: NOTIFY_KIND,
        entityType: row.itemType,
        entityId: row.itemId,
        text: (t) => ({
          subject: t(`notify.${input.decision}`, { kind: t(`kinds.${row.itemType}`), title: summary?.title ?? "" }),
          body: comment,
        }),
      },
    ]);
  }
  return { ok: true, approvalId: row.id };
}

/** The decisions an item of this type takes (all three unless its handler narrows them). */
export function decisionsFor(type: ApprovalItemType): readonly ApprovalDecision[] {
  return APPROVAL_HANDLERS[type].decisions ?? APPROVAL_DECISIONS;
}

/** The item types `actor` may decide. */
export function decidableTypes(actor: Actor): ApprovalItemType[] {
  return (Object.keys(APPROVAL_HANDLERS) as ApprovalItemType[]).filter((t) =>
    hasAnyRole(actor.role, APPROVAL_HANDLERS[t].deciderRoles),
  );
}

export type QueueEntry = {
  id: string;
  itemType: ApprovalItemType;
  itemId: string;
  status: string;
  note: string | null;
  submittedAt: Date;
  submittedBy: string | null;
  decidedAt: Date | null;
  decidedBy: string | null;
  comment: string | null;
  summary: ItemSummary | null;
};

/**
 * The queue `actor` sees: requests of the types they may decide, filtered by
 * status (default pending), newest first. Items a handler's canDecide refuses
 * (another mentor's mentee) are left out.
 */
export async function listApprovals(
  db: Db,
  actor: Actor,
  opts: { status?: string; itemType?: ApprovalItemType; limit?: number } = {},
): Promise<QueueEntry[]> {
  const types = decidableTypes(actor).filter((t) => !opts.itemType || t === opts.itemType);
  if (types.length === 0) return [];
  const submitter = sql<string | null>`(select coalesce(u.name, u.email) from users u where u.id = ${approvals.submittedByUserId})`;
  const decider = sql<string | null>`(select coalesce(u.name, u.email) from users u where u.id = ${approvals.decidedByUserId})`;
  const rows = await db
    .select({
      id: approvals.id,
      itemType: approvals.itemType,
      itemId: approvals.itemId,
      status: approvals.status,
      note: approvals.note,
      submittedAt: approvals.submittedAt,
      submittedBy: submitter,
      decidedAt: approvals.decidedAt,
      decidedBy: decider,
      comment: approvals.comment,
    })
    .from(approvals)
    .where(and(inArray(approvals.itemType, types), eq(approvals.status, opts.status ?? "pending")))
    .orderBy(desc(approvals.submittedAt))
    .limit(opts.limit ?? 200);

  const out: QueueEntry[] = [];
  for (const type of types) {
    const mine = rows.filter((r) => r.itemType === type);
    if (mine.length === 0) continue;
    const handler = APPROVAL_HANDLERS[type];
    const summaries = await handler.describe(db, mine.map((r) => r.itemId));
    for (const r of mine) {
      if (handler.canDecide && !(await handler.canDecide(db, actor, r.itemId))) continue;
      out.push({ ...r, itemType: type, summary: summaries.get(r.itemId) ?? null });
    }
  }
  return out.sort((a, b) => b.submittedAt.getTime() - a.submittedAt.getTime());
}

/** How many requests wait on `actor` (the menu badge). */
export async function pendingApprovalCount(db: Db, actor: Actor): Promise<number> {
  return (await listApprovals(db, actor, { status: "pending" })).length;
}

/** Each item's most recent request -- its state and the approver's comment -- for the owner's pages. */
export async function latestApprovals(db: Db, itemType: ApprovalItemType, itemIds: string[]) {
  const out = new Map<string, { status: string; comment: string | null; decidedAt: Date | null; submittedAt: Date }>();
  if (itemIds.length === 0) return out;
  const rows = await db
    .select({
      itemId: approvals.itemId,
      status: approvals.status,
      comment: approvals.comment,
      decidedAt: approvals.decidedAt,
      submittedAt: approvals.submittedAt,
    })
    .from(approvals)
    .where(and(eq(approvals.itemType, itemType), inArray(approvals.itemId, itemIds)))
    .orderBy(desc(approvals.submittedAt));
  for (const r of rows) if (!out.has(r.itemId)) out.set(r.itemId, r);
  return out;
}
