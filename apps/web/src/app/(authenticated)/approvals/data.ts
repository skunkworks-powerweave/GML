// What /approvals and /approvals/[id] read, as functions of the database so
// tests/behaviour can run them.
//
// WHO SEES WHAT is lib/approvals' decision, not this file's: the queue is
// listApprovals (the item types the viewer may decide, and within them only
// the items a handler's canDecide admits -- a mentor's own mentees), and one
// request is visible on exactly the same terms. A request the viewer could
// not decide answers 404, whatever its id.

import { eq } from "drizzle-orm";
import { approvals, APPROVAL_ITEM_TYPES, type ApprovalItemType } from "@gml/db/schema";
import type { RoleName } from "@gml/shared/auth/roles";
import { decidableTypes, type ItemSummary } from "@/lib/approvals";
import { APPROVAL_HANDLERS } from "@/lib/approvals/registry";
import { accountRequestDetails, approvalHistory, type AccountRequestDetails } from "@/lib/approvals/account-requests";
import type { Actor, Db } from "@/lib/visibility";

/** Every role that decides some kind of item (the handlers' deciderRoles). */
export const DECIDER_ROLES: RoleName[] = ["mentor", "observer", "programme_admin", "super_admin"];

/** The queue's status tabs, in order. */
export const APPROVAL_STATUSES = ["pending", "approved", "changes_requested", "rejected"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/** A status as a chip colour. */
export const STATUS_CHIP: Record<string, string> = {
  pending: "chip chip-saffron",
  approved: "chip chip-lichen",
  changes_requested: "chip chip-indigo",
  rejected: "chip chip-rust",
};

export function parseStatus(raw: unknown): ApprovalStatus {
  return (APPROVAL_STATUSES as readonly unknown[]).includes(raw) ? (raw as ApprovalStatus) : "pending";
}

/** The type filter, only ever one the viewer may decide. */
export function parseType(raw: unknown, allowed: ApprovalItemType[]): ApprovalItemType | undefined {
  return (APPROVAL_ITEM_TYPES as readonly unknown[]).includes(raw) && allowed.includes(raw as ApprovalItemType)
    ? (raw as ApprovalItemType)
    : undefined;
}

export type OpenedApproval = {
  approval: typeof approvals.$inferSelect;
  summary: ItemSummary | null;
  history: Awaited<ReturnType<typeof approvalHistory>>;
  account: AccountRequestDetails | null;
};

/** One request with its item's whole history, or null when `actor` may not decide it. */
export async function openApproval(db: Db, actor: Actor, approvalId: string): Promise<OpenedApproval | null> {
  const [approval] = await db.select().from(approvals).where(eq(approvals.id, approvalId)).limit(1);
  if (!approval) return null;
  if (!decidableTypes(actor).includes(approval.itemType)) return null;
  const handler = APPROVAL_HANDLERS[approval.itemType];
  if (handler.canDecide && !(await handler.canDecide(db, actor, approval.itemId))) return null;

  const [summaries, history, account] = await Promise.all([
    handler.describe(db, [approval.itemId]),
    approvalHistory(db, approval.itemType, approval.itemId),
    approval.itemType === "account_request"
      ? accountRequestDetails(db, [approval.itemId]).then((m) => m.get(approval.itemId) ?? null)
      : Promise.resolve(null),
  ]);
  return { approval, summary: summaries.get(approval.itemId) ?? null, history, account };
}
