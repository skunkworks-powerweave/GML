// /approvals — the approvals queue: everything waiting for the viewer's
// decision, one list for every kind of item (a teacher's lesson plans,
// sessions and marks; teach-backs; observation sign-off; account requests).
//
// What the viewer sees is lib/approvals' listApprovals: only the kinds of item
// their role decides (a mentor or an observer sees no sessions and no account
// requests), and within those only what the item's handler lets them decide.
// Tabs by status, chips by kind. Each pending request can be decided here or
// opened (/approvals/[id]) for its full history; the record itself opens on
// its own page (a session, a plan, marks), read-only for the approver.
//
// One column of cards: it is used on a phone as much as at a desk.

import type { Metadata } from "next";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { db } from "@gml/db";
import { requireRole } from "@/lib/guards";
import { actorFrom } from "@/lib/visibility";
import { decidableTypes, decisionsFor, listApprovals, type QueueEntry } from "@/lib/approvals";
import { accountRequestDetails } from "@/lib/approvals/account-requests";
import { INTL_LOCALE, normalizeLocale } from "@/i18n/config";
import { APPROVAL_STATUSES, DECIDER_ROLES, STATUS_CHIP, parseStatus, parseType } from "./data";
import { DecisionForm } from "./decision-form";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("approvals"))("queue.metaTitle") };
}

function queueHref(status: string, type?: string): string {
  const q = new URLSearchParams();
  if (status !== "pending") q.set("status", status);
  if (type) q.set("type", type);
  const s = q.toString();
  return s ? `/approvals?${s}` : "/approvals";
}

export default async function ApprovalsPage({
  searchParams,
}: {
  searchParams?: Promise<{ status?: string; type?: string }>;
}) {
  const session = await requireRole(DECIDER_ROLES);
  const actor = actorFrom(session)!;
  const sp = searchParams ? await searchParams : {};
  const types = decidableTypes(actor);
  const status = parseStatus(sp.status);
  const type = parseType(sp.type, types);

  const t = await getTranslations("approvals");
  const tRole = await getTranslations("role");
  const intl = INTL_LOCALE[normalizeLocale(await getLocale())];
  const when = (d: Date) => d.toLocaleDateString(intl, { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });

  const entries = await listApprovals(db as never, actor, { status, itemType: type });
  const accounts = await accountRequestDetails(
    db as never,
    entries.filter((e) => e.itemType === "account_request").map((e) => e.itemId),
  );

  const chip = (active: boolean): React.CSSProperties => ({
    textDecoration: "none",
    minHeight: 32,
    display: "inline-flex",
    alignItems: "center",
    ...(active ? { background: "var(--ink)", color: "var(--paper)", borderColor: "var(--ink)" } : {}),
  });

  const entry = (e: QueueEntry) => {
    const account = e.itemType === "account_request" ? accounts.get(e.itemId) : undefined;
    const openHref = `/approvals/${e.id}`;
    const recordHref = e.summary?.href && e.summary.href !== openHref ? e.summary.href : null;
    return (
      <li key={e.id} className="card" data-testid="approval-entry" style={{ padding: 16, display: "grid", gap: 8 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
          <span className="chip">{t(`kinds.${e.itemType}`)}</span>
          {account ? <span className="chip">{tRole(account.role)}</span> : null}
          {e.status !== "pending" ? <span className={STATUS_CHIP[e.status] ?? "chip"}>{t(`status.${e.status}`)}</span> : null}
        </div>
        <h2 style={{ fontSize: 16, fontWeight: 600, overflowWrap: "anywhere" }}>
          <Link href={openHref} style={{ color: "var(--ink)" }}>
            {e.summary?.title || t("queue.missingItem")}
          </Link>
        </h2>
        {e.summary?.subtitle ? (
          <p style={{ fontSize: 13, color: "var(--ink-2)", overflowWrap: "anywhere" }}>{e.summary.subtitle}</p>
        ) : null}
        <p style={{ fontSize: 12, color: "var(--ink-3)" }}>
          {e.itemType === "account_request" && !e.submittedBy
            ? t("queue.sentPublic", { date: when(e.submittedAt) })
            : t("queue.sentBy", { name: e.submittedBy ?? t("queue.someone"), date: when(e.submittedAt) })}
        </p>
        {e.note ? (
          <div style={{ fontSize: 13 }}>
            <div className="label">{t("queue.note")}</div>
            <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", marginTop: 2 }}>{e.note}</p>
          </div>
        ) : null}
        {e.status !== "pending" && e.decidedAt ? (
          <p style={{ fontSize: 12, color: "var(--ink-3)" }}>
            {t("queue.decidedBy", { name: e.decidedBy ?? t("queue.someone"), date: when(e.decidedAt) })}
          </p>
        ) : null}
        {e.comment ? (
          <div style={{ fontSize: 13 }}>
            <div className="label">{t("queue.comment")}</div>
            <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", marginTop: 2 }}>{e.comment}</p>
          </div>
        ) : null}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, fontSize: 13 }}>
          <Link href={openHref}>{t("queue.open")}</Link>
          {recordHref ? <Link href={recordHref}>{t("queue.openRecord")}</Link> : null}
        </div>
        {e.status === "pending" ? (
          <DecisionForm approvalId={e.id} decisions={decisionsFor(e.itemType)} />
        ) : null}
      </li>
    );
  };

  return (
    <main>
      <div className="page-header">
        <div className="label">{t("queue.eyebrow")}</div>
        <h1 className="serif" style={{ fontSize: 26, marginTop: 4 }}>
          {t("queue.title")}
        </h1>
        <p style={{ fontSize: 13, color: "var(--ink-3)", marginTop: 6, lineHeight: 1.5 }}>{t("queue.intro")}</p>
      </div>
      <div className="page-body" style={{ display: "grid", gap: 16, maxWidth: 820 }}>
        <nav aria-label={t("queue.statusNav")} style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {APPROVAL_STATUSES.map((s) => (
            <Link
              key={s}
              href={queueHref(s, type)}
              className="chip"
              aria-current={s === status ? "page" : undefined}
              style={chip(s === status)}
            >
              {t(`status.${s}`)}
            </Link>
          ))}
        </nav>
        {types.length > 1 ? (
          <nav aria-label={t("queue.typeNav")} style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            <Link href={queueHref(status)} className="chip" aria-current={!type ? "true" : undefined} style={chip(!type)}>
              {t("queue.allTypes")}
            </Link>
            {types.map((k) => (
              <Link
                key={k}
                href={queueHref(status, k)}
                className="chip"
                aria-current={k === type ? "true" : undefined}
                style={chip(k === type)}
              >
                {t(`kinds.${k}`)}
              </Link>
            ))}
          </nav>
        ) : null}
        <p style={{ fontSize: 12, color: "var(--ink-3)" }} data-testid="approval-count">
          {t("queue.count", { count: entries.length })}
        </p>
        {entries.length === 0 ? (
          <p className="card" style={{ padding: 16, fontSize: 14, color: "var(--ink-3)" }}>
            {status === "pending" ? t("queue.empty") : t("queue.emptyOther")}
          </p>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 12 }}>{entries.map(entry)}</ul>
        )}
      </div>
    </main>
  );
}
