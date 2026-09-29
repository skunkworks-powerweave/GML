"use client";

// Approve / Request changes / Reject, with the comment the last two need.
// The action (./actions.ts) re-checks everything; this only lays it out.
// Copy: approvals.client.decision.*; the outcome sentence comes back from the
// action already in the approver's language.
//
// An approved account request answers with the new login's initial password.
// It is shown here, once, in this component's own state: it is not in the
// page, not in the URL and not stored anywhere, so a reload loses it (the
// approver then sets a new one on /admin/users).

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import type { ApprovalDecision } from "@gml/db/schema";
import { decideAction, type DecisionState } from "./actions";

export function DecisionForm({
  approvalId,
  decisions,
}: {
  approvalId: string;
  /**
   * The decisions this kind of item takes (lib/approvals decisionsFor): an
   * account request has no "Request changes", a teach-back no "Reject".
   */
  decisions: readonly ApprovalDecision[];
}) {
  const allowChanges = decisions.includes("changes_requested");
  const allowReject = decisions.includes("rejected");
  const [state, formAction, pending] = useActionState<DecisionState | undefined, FormData>(decideAction, undefined);
  const t = useTranslations("approvals.client.decision");

  if (state?.password && state.email) {
    return (
      <div role="status" data-testid="initial-password-panel" style={{ display: "grid", gap: 8 }}>
        <p style={{ fontSize: 14, color: "var(--ok-ink, #047857)" }}>{state.ok}</p>
        <div className="label">{t("passwordTitle", { email: state.email })}</div>
        <output
          data-testid="initial-password"
          className="mono"
          style={{
            display: "block",
            fontSize: 20,
            letterSpacing: "0.04em",
            padding: "10px 12px",
            border: "1px solid var(--line-2)",
            borderRadius: "var(--r-2)",
            background: "var(--card-hi)",
            userSelect: "all",
            overflowWrap: "anywhere",
          }}
        >
          {state.password}
        </output>
        <p style={{ fontSize: 13, color: "var(--ink-3)", lineHeight: 1.5 }}>{t("passwordHint")}</p>
      </div>
    );
  }
  if (state?.decided) {
    return (
      <p role="status" style={{ fontSize: 14, color: "var(--ok-ink, #047857)" }}>
        {state.ok}
      </p>
    );
  }

  const commentId = `decision-comment-${approvalId}`;
  const hintId = `${commentId}-hint`;
  return (
    <form action={formAction} style={{ display: "grid", gap: 8 }}>
      <input type="hidden" name="approvalId" value={approvalId} />
      <label htmlFor={commentId} style={{ fontSize: 12, fontWeight: 500, color: "var(--ink-2)" }}>
        {t("comment")}
      </label>
      <textarea
        id={commentId}
        name="comment"
        rows={3}
        maxLength={4000}
        defaultValue={state?.comment ?? ""}
        aria-describedby={hintId}
        style={{
          width: "100%",
          boxSizing: "border-box",
          padding: "8px 10px",
          border: "1px solid var(--line-2)",
          borderRadius: "var(--r-2)",
          background: "var(--card-hi)",
          fontSize: 16,
          resize: "vertical",
        }}
      />
      <span id={hintId} style={{ fontSize: 12, color: "var(--ink-3)" }}>
        {allowChanges && allowReject ? t("commentHint") : allowChanges ? t("commentHintChanges") : t("commentHintAccount")}
      </span>
      {state?.error ? (
        <p role="alert" style={{ fontSize: 13, color: "var(--rust)" }}>
          {state.error}
        </p>
      ) : null}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <button
          type="submit"
          name="decision"
          value="approved"
          className="btn btn-primary"
          disabled={pending}
          aria-busy={pending || undefined}
          style={{ minHeight: 40 }}
        >
          {pending ? t("saving") : t("approve")}
        </button>
        {allowChanges ? (
          <button type="submit" name="decision" value="changes_requested" className="btn" disabled={pending} style={{ minHeight: 40 }}>
            {t("requestChanges")}
          </button>
        ) : null}
        {allowReject ? (
          <button type="submit" name="decision" value="rejected" className="btn" disabled={pending} style={{ minHeight: 40 }}>
            {t("reject")}
          </button>
        ) : null}
      </div>
    </form>
  );
}
