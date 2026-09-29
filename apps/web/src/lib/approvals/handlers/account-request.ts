// Approval handler for account_request items: "Request an account" from the
// login page. See ../types.ts for the contract; the flows that create the
// request and the login are ../account-requests.ts.
//
// NOBODY SUBMITS ONE THROUGH submitForApproval. The requester has no account,
// so there is no actor to pass it: the public form records the request and
// its pending approvals row itself (submitAccountRequest), and canSubmit
// refuses everyone.
//
// THE APPROVAL AND THE LOGIN CANNOT DISAGREE. Creating a login talks to
// Supabase Auth, which cannot take part in a database transaction, so it is
// not done here: approveAccountRequest creates the login first, records it on
// the request (created_user_id), and only then decides the approval. The
// decision below marks the request approved ONLY when that login is recorded,
// and a rejection only when none is -- anything else throws, which rolls the
// whole decision back (lib/approvals runs onDecision inside its transaction).
// So a request cannot be "approved" with no login behind it, even when
// decideApproval is called directly, and a rejection cannot land while an
// approval is half-way through creating one.
//
// There is no "changes requested" for an account request (its status is
// pending / approved / rejected): the approvals page does not offer it, and
// the decision throws if it arrives anyway.

import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { accountRequests, approvals, schools } from "@gml/db/schema";
import type { ApprovalHandler, DbOrTx, ItemSummary } from "../types";

/** The roles a person may ask for (account_requests_role_check). */
export const ACCOUNT_REQUEST_ROLES = ["teacher", "mentor", "observer"] as const;
export type AccountRequestRole = (typeof ACCOUNT_REQUEST_ROLES)[number];

/**
 * A decision arrived that the request's state cannot take: a rejection while
 * an approval is creating the login, or an approval with no login recorded.
 */
export class AccountRequestStateError extends Error {
  constructor(
    readonly requestId: string,
    readonly decision: string,
  ) {
    // i18n-ignore: an exception's message, read by developers in the logs, never shown
    super(`account request ${requestId}: cannot record "${decision}" in its current state`);
    this.name = "AccountRequestStateError";
  }
}

export const accountRequestHandler: ApprovalHandler = {
  type: "account_request",
  deciderRoles: ["programme_admin", "super_admin"],
  decisions: ["approved", "rejected"],
  async canSubmit() {
    return false;
  },
  async onDecision(tx, itemId, decision, { actor, comment }) {
    if (decision === "changes_requested") throw new AccountRequestStateError(itemId, decision);
    const now = new Date();
    const updated =
      decision === "approved"
        ? await tx
            .update(accountRequests)
            .set({ status: "approved", decidedByUserId: actor.id, decidedAt: now })
            .where(
              and(
                eq(accountRequests.id, itemId),
                eq(accountRequests.status, "pending"),
                isNotNull(accountRequests.createdUserId),
              ),
            )
            .returning({ id: accountRequests.id })
        : await tx
            .update(accountRequests)
            .set({ status: "rejected", decidedByUserId: actor.id, decidedAt: now, decisionReason: comment })
            .where(
              and(
                eq(accountRequests.id, itemId),
                eq(accountRequests.status, "pending"),
                isNull(accountRequests.createdUserId),
              ),
            )
            .returning({ id: accountRequests.id });
    if (updated.length !== 1) throw new AccountRequestStateError(itemId, decision);
  },
  async describe(db: DbOrTx, itemIds: string[]) {
    const out = new Map<string, ItemSummary>();
    if (itemIds.length === 0) return out;
    const rows = await db
      .select({
        id: accountRequests.id,
        fullName: accountRequests.fullName,
        email: accountRequests.email,
        school: schools.name,
      })
      .from(accountRequests)
      .leftJoin(schools, eq(schools.id, accountRequests.schoolId))
      .where(inArray(accountRequests.id, itemIds));
    // The request has no page of its own: the approver reviews it on its
    // approvals request, the most recent one for that item.
    const requests = await db
      .select({ itemId: approvals.itemId, id: approvals.id })
      .from(approvals)
      .where(and(eq(approvals.itemType, "account_request"), inArray(approvals.itemId, itemIds)))
      .orderBy(desc(approvals.submittedAt));
    const latest = new Map<string, string>();
    for (const r of requests) if (!latest.has(r.itemId)) latest.set(r.itemId, r.id);
    for (const r of rows) {
      const approvalId = latest.get(r.id);
      out.set(r.id, {
        title: r.fullName,
        // The requested role is shown by the approvals pages, in the reader's
        // language; a summary is data and is not translated.
        subtitle: [r.email, r.school].filter(Boolean).join(" · "),
        href: approvalId ? `/approvals/${approvalId}` : "/approvals",
      });
    }
    return out;
  },
};
