"use server";

// Deciding a request on /approvals and /approvals/[id]: Approve, Request
// changes, Reject. One action for every kind of item; who may decide what is
// lib/approvals' rule (decideApproval checks the role and the handler's
// canDecide, and takes the decision only while the request is still pending),
// so nothing here trusts the page that posted the form.
//
// An ACCOUNT REQUEST is decided by lib/approvals/account-requests.ts, because
// approving one creates a login: that has to happen before the approval is
// recorded and be undone if it is not (see there). Its answer carries the
// initial password, once, for the approver's screen -- so after that decision
// the page is NOT revalidated: a refresh would re-render the form and drop the
// password before it was read. Everything else revalidates, and the decided
// request leaves the pending queue.
//
// Messages come back in the approver's language (approvals.actions.*).

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { eq } from "drizzle-orm";
import { db } from "@gml/db";
import { approvals, APPROVAL_DECISIONS, type ApprovalDecision } from "@gml/db/schema";
import { auth } from "@/auth";
import { actorFrom } from "@/lib/visibility";
import { isUuid } from "@/lib/ids";
import { decideApproval } from "@/lib/approvals";
import { approveAccountRequest, rejectAccountRequest } from "@/lib/approvals/account-requests";

export type DecisionState = {
  ok?: string;
  error?: string;
  /** What was decided, once it was. */
  decided?: ApprovalDecision;
  /** An approved account request: the new login's address and its initial password. Never stored. */
  email?: string;
  password?: string;
  /** The comment as typed, so a refused decision keeps it. */
  comment?: string;
};

function revalidate(approvalId: string): void {
  revalidatePath("/approvals");
  revalidatePath(`/approvals/${approvalId}`);
}

export async function decideAction(_prev: DecisionState | undefined, formData: FormData): Promise<DecisionState> {
  const t = await getTranslations("approvals.actions");
  const actor = actorFrom(await auth());
  if (!actor) return { error: t("notSignedIn") };

  const approvalId = String(formData.get("approvalId") ?? "");
  const decision = String(formData.get("decision") ?? "");
  const typed = String(formData.get("comment") ?? "");
  const comment = typed.trim() || null;
  if (!isUuid(approvalId) || !(APPROVAL_DECISIONS as readonly string[]).includes(decision)) {
    return { error: t("invalid"), comment: typed };
  }

  const [row] = await db
    .select({ itemType: approvals.itemType })
    .from(approvals)
    .where(eq(approvals.id, approvalId))
    .limit(1);
  if (!row) return { error: t("not_found"), comment: typed };

  if (row.itemType === "account_request") {
    if (decision === "changes_requested") return { error: t("accountNoChanges"), comment: typed };
    if (decision === "rejected") {
      const r = await rejectAccountRequest(db as never, { approvalId, actor, comment });
      if (!r.ok) return { error: t(r.error), comment: typed };
      revalidate(approvalId);
      return { ok: t("rejected"), decided: "rejected" };
    }
    const r = await approveAccountRequest(db as never, { approvalId, actor, comment });
    if (!r.ok) {
      switch (r.error) {
        case "email_taken":
          return { error: t("emailTaken", { email: r.email }), comment: typed };
        case "school_missing":
          return { error: t("schoolMissing"), comment: typed };
        case "login_failed":
          return {
            error: r.leftBehind
              ? t("loginLeftBehind", { detail: r.detail, email: r.email })
              : t("loginFailed", { detail: r.detail }),
            comment: typed,
          };
        default:
          return { error: t(r.error), comment: typed };
      }
    }
    // Deliberately no revalidate (see the header).
    return { ok: t("accountApproved", { email: r.email }), decided: "approved", email: r.email, password: r.password };
  }

  let r: Awaited<ReturnType<typeof decideApproval>>;
  try {
    r = await decideApproval(db as never, { approvalId, decision: decision as ApprovalDecision, comment, actor });
  } catch (err) {
    console.error("[approvals] the decision could not be recorded:", err);
    return { error: t("failed"), comment: typed };
  }
  if (!r.ok) return { error: t(r.error), comment: typed };
  revalidate(approvalId);
  return { ok: t(decision), decided: decision as ApprovalDecision };
}
