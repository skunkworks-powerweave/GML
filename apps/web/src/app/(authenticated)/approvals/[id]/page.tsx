// /approvals/[id] — one approval request: what was sent, by whom and with what
// note; every request ever made for the same item (its history, oldest
// first, with each decision and comment); and, while it is pending, the
// decision form.
//
// Visible on the same terms as the queue (./../data.ts openApproval): only to
// someone who may decide it. Anyone else -- a teacher, a mentor opening an
// account request, a malformed id -- gets the 404 page.
//
// An account request has no page of its own, so its details are shown here:
// the name, address, phone, school and role asked for, the message, and a
// warning when the address already has a login (approving would be refused).

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { db } from "@gml/db";
import { requireRole } from "@/lib/guards";
import { actorFrom } from "@/lib/visibility";
import { decisionsFor } from "@/lib/approvals";
import { uuidOrNotFound } from "@/lib/ids";
import { getDeviceType } from "@/lib/device";
import { MobileDetailFrame } from "@/components/shells";
import { INTL_LOCALE, normalizeLocale } from "@/i18n/config";
import { DECIDER_ROLES, STATUS_CHIP, openApproval } from "../data";
import { DecisionForm } from "../decision-form";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("approvals"))("detail.metaTitle") };
}

export default async function ApprovalRequestPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireRole(DECIDER_ROLES);
  const actor = actorFrom(session)!;
  const id = uuidOrNotFound((await params).id);
  const opened = await openApproval(db as never, actor, id);
  if (!opened) notFound();
  const { approval, summary, history, account } = opened;

  const t = await getTranslations("approvals");
  const tRole = await getTranslations("role");
  const intl = INTL_LOCALE[normalizeLocale(await getLocale())];
  const when = (d: Date) =>
    d.toLocaleString(intl, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" });
  const kind = t(`kinds.${approval.itemType}`);
  const openHref = `/approvals/${approval.id}`;
  const recordHref = summary?.href && summary.href !== openHref ? summary.href : null;
  const device = await getDeviceType();
  const current = history.find((h) => h.id === approval.id);
  // An account request comes from the public form, with no sender; anything
  // else without one was sent by an account removed since.
  const sender = approval.submittedByUserId
    ? (current?.submittedBy ?? t("queue.someone"))
    : account
      ? t("detail.publicForm")
      : t("queue.someone");

  /** A label above its value: one column at every width. */
  const field = (label: string, value: React.ReactNode) => (
    <div style={{ display: "grid", gap: 2 }}>
      <dt className="label">{label}</dt>
      <dd style={{ margin: 0, fontSize: 14, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{value}</dd>
    </div>
  );
  const section: React.CSSProperties = { padding: 16, display: "grid", gap: 12 };

  const body = (
    <main>
      <div className="page-header">
        {device === "mobile" ? null : (
          <Link href="/approvals" style={{ fontSize: 13 }}>
            {t("detail.back")}
          </Link>
        )}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", marginTop: 8 }}>
          <span className="chip">{kind}</span>
          <span className={STATUS_CHIP[approval.status] ?? "chip"} data-testid="approval-status">
            {t(`status.${approval.status}`)}
          </span>
        </div>
        <h1 className="serif" style={{ fontSize: 24, marginTop: 6, overflowWrap: "anywhere" }}>
          {summary?.title || t("queue.missingItem")}
        </h1>
        {summary?.subtitle ? (
          <p style={{ fontSize: 13, color: "var(--ink-2)", marginTop: 4, overflowWrap: "anywhere" }}>{summary.subtitle}</p>
        ) : null}
      </div>

      <div className="page-body" style={{ display: "grid", gap: 16, maxWidth: 760 }}>
        <section className="card" style={section} aria-labelledby="approval-request">
          <h2 id="approval-request" style={{ fontSize: 16, fontWeight: 600 }}>
            {t("detail.request")}
          </h2>
          <dl style={{ display: "grid", gap: 10, margin: 0 }}>
            {field(t("detail.sentBy"), sender)}
            {field(t("detail.sentOn"), when(approval.submittedAt))}
            {approval.note && !account ? field(t("queue.note"), approval.note) : null}
            {account ? (
              <>
                {field(t("detail.fullName"), account.fullName)}
                {field(t("detail.email"), account.email)}
                {field(t("detail.phone"), account.phone ?? t("detail.none"))}
                {field(t("detail.school"), account.school ?? t("detail.none"))}
                {field(t("detail.role"), tRole(account.role))}
                {field(t("detail.message"), account.message ?? t("detail.none"))}
              </>
            ) : null}
          </dl>
          {account && account.emailHasLogin && approval.status === "pending" ? (
            <p role="note" data-testid="email-has-login" style={{ fontSize: 13, color: "var(--rust)" }}>
              {t("detail.emailHasLogin")}
            </p>
          ) : null}
          {recordHref ? (
            <p style={{ fontSize: 13 }}>
              <Link href={recordHref}>{t("queue.openRecord")}</Link>
            </p>
          ) : null}
        </section>

        <section className="card" style={section} aria-labelledby="approval-decision">
          <h2 id="approval-decision" style={{ fontSize: 16, fontWeight: 600 }}>
            {t("detail.decision")}
          </h2>
          {approval.status === "pending" ? (
            <DecisionForm key={approval.id} approvalId={approval.id} decisions={decisionsFor(approval.itemType)} />
          ) : (
            <>
              <dl style={{ display: "grid", gap: 10, margin: 0 }}>
                {field(t("detail.decidedBy"), current?.decidedBy ?? t("queue.someone"))}
                {approval.decidedAt ? field(t("detail.decidedOn"), when(approval.decidedAt)) : null}
                {approval.comment
                  ? field(account && approval.status === "rejected" ? t("detail.reason") : t("queue.comment"), approval.comment)
                  : null}
              </dl>
              {account?.createdUserId && approval.status === "approved" ? (
                <p style={{ fontSize: 13 }}>{t("detail.loginCreated")}</p>
              ) : null}
            </>
          )}
        </section>

        <section aria-labelledby="approval-history" style={{ display: "grid", gap: 8 }}>
          <h2 id="approval-history" style={{ fontSize: 16, fontWeight: 600 }}>
            {t("detail.history")}
          </h2>
          <p style={{ fontSize: 12, color: "var(--ink-3)" }}>{t("detail.historyIntro")}</p>
          <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }} data-testid="approval-history">
            {history.map((h) => (
              <li key={h.id} className="card" style={{ padding: 12, display: "grid", gap: 6 }}>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                  <span className={STATUS_CHIP[h.status] ?? "chip"}>{t(`status.${h.status}`)}</span>
                  {h.id === approval.id ? null : (
                    <Link href={`/approvals/${h.id}`} style={{ fontSize: 12 }}>
                      {t("queue.open")}
                    </Link>
                  )}
                </div>
                <p style={{ fontSize: 12, color: "var(--ink-3)" }}>
                  {account && !h.submittedBy
                    ? t("queue.sentPublic", { date: when(h.submittedAt) })
                    : t("queue.sentBy", { name: h.submittedBy ?? t("queue.someone"), date: when(h.submittedAt) })}
                </p>
                {h.note ? <p style={{ fontSize: 13, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{h.note}</p> : null}
                {h.decidedAt ? (
                  <p style={{ fontSize: 12, color: "var(--ink-3)" }}>
                    {t("queue.decidedBy", { name: h.decidedBy ?? t("queue.someone"), date: when(h.decidedAt) })}
                  </p>
                ) : null}
                {h.comment ? (
                  <div style={{ fontSize: 13 }}>
                    <div className="label">{t("queue.comment")}</div>
                    <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", marginTop: 2 }}>{h.comment}</p>
                  </div>
                ) : null}
              </li>
            ))}
          </ol>
        </section>
      </div>
    </main>
  );

  return device === "mobile" ? (
    <MobileDetailFrame title={kind} backHref="/approvals">
      {body}
    </MobileDetailFrame>
  ) : (
    body
  );
}
