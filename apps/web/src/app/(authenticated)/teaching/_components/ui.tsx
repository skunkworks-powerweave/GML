// The pieces every /teaching page shares: the header, a card, a labelled
// field, the approval-state chip, the "no teacher record" empty state and the
// approval panel. Server components; their copy is the teaching namespace.
//
// PHONE FIRST. Forms are one column that becomes an auto-fit grid of fields
// when there is room (never fixed desktop columns, which hold at every width
// and push a 375 px page sideways); lists are rows that wrap, not wide tables.

import type { CSSProperties, ReactNode } from "react";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { INTL_LOCALE, normalizeLocale } from "@/i18n/config";
import { isEditable } from "@/lib/approvals";
import type { HistoryEntry } from "@/lib/teaching/records";
import type { FormAction } from "@/lib/teaching/forms";
import { SubmitButton } from "@/components/SubmitButton";
import { ActionForm } from "./ActionForm";

export type Translate = Awaited<ReturnType<typeof getTranslations>>;

/** Fields side by side where they fit, one per line on a phone. */
export const fieldGrid: CSSProperties = {
  display: "grid",
  gap: 12,
  gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
};

export const mutedText: CSSProperties = { fontSize: 12, color: "var(--ink-3)" };

/** A row of buttons or links that wraps on a narrow screen. */
export const wrapRow: CSSProperties = { display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" };

/** A list row: its parts wrap under each other on a phone. */
export const listRow: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 8,
  alignItems: "center",
  justifyContent: "space-between",
  padding: "10px 12px",
  border: "1px solid var(--line)",
  borderRadius: "var(--r-2)",
  background: "var(--paper)",
  minWidth: 0,
};

export function PageHeader({ label, title, intro, back }: { label: string; title: string; intro?: string; back?: { href: string; text: string } }) {
  return (
    <div className="page-header">
      {back ? (
        <Link href={back.href} className="btn btn-sm btn-ghost" style={{ marginBottom: 8, marginLeft: -8, display: "inline-flex" }}>
          ← {back.text}
        </Link>
      ) : null}
      <div className="label">{label}</div>
      <h1 className="serif" style={{ fontSize: 28, marginTop: 4, overflowWrap: "anywhere" }}>
        {title}
      </h1>
      {intro ? <p style={{ color: "var(--ink-3)", marginTop: 4 }}>{intro}</p> : null}
    </div>
  );
}

export function Card({ title, sub, children, id }: { title: string; sub?: string; children: ReactNode; id?: string }) {
  return (
    <section className="card card-hi" style={{ minWidth: 0 }} id={id}>
      <header style={{ padding: 14, borderBottom: "1px solid var(--line)" }}>
        <h2 className="serif" style={{ fontSize: 16, fontWeight: 600 }}>
          {title}
        </h2>
        {sub ? <div style={{ ...mutedText, fontSize: 11, marginTop: 2 }}>{sub}</div> : null}
      </header>
      <div style={{ padding: 14, display: "grid", gap: 12, minWidth: 0 }}>{children}</div>
    </section>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label style={{ display: "grid", gap: 4, minWidth: 0 }}>
      <span style={{ fontSize: 12, fontWeight: 500, color: "var(--ink-2)" }}>{label}</span>
      {children}
      {hint ? <span style={{ ...mutedText, fontSize: 11 }}>{hint}</span> : null}
    </label>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p style={{ ...mutedText, fontSize: 13, margin: 0 }}>{children}</p>;
}

const STATE_CHIP: Record<string, string> = {
  draft: "",
  pending: "chip-saffron",
  approved: "chip-lichen",
  changes_requested: "chip-rust",
  rejected: "chip-rust",
};

/** A record's approval state, as a chip in the viewer's language. */
export function StateChip({ t, state }: { t: Translate; state: string }) {
  return <span className={`chip ${STATE_CHIP[state] ?? ""}`}>{t.has(`state.${state}`) ? t(`state.${state}`) : state}</span>;
}

/** A teacher account with no (active) teachers row owns nothing: say why, and who can fix it. */
export async function NoTeacherRecord() {
  const t = await getTranslations("teaching");
  return (
    <div>
      <PageHeader label={t("hub.label")} title={t("noTeacher.title")} />
      <div className="page-body">
        <section className="card card-hi" style={{ padding: 16 }}>
          <p style={{ fontSize: 14, color: "var(--ink-2)", margin: 0 }}>{t("noTeacher.body")}</p>
        </section>
      </div>
    </div>
  );
}

/** "Grade 5 A" / "Grade 5 (all sections)". */
export function classLabel(t: Translate, grade: number, section: string | null): string {
  return section ? t("common.gradeSection", { grade, section }) : t("common.gradeAll", { grade });
}

/** A stored "YYYY-MM-DD" in the viewer's language. */
export async function dateFormatter(): Promise<(iso: string | null) => string> {
  const intl = INTL_LOCALE[normalizeLocale(await getLocale())];
  return (iso) =>
    iso ? new Date(`${iso}T00:00:00Z`).toLocaleDateString(intl, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "";
}

/** A timestamp in the viewer's language, in the programme's timezone. */
export async function stampFormatter(): Promise<(d: Date | null) => string> {
  const intl = INTL_LOCALE[normalizeLocale(await getLocale())];
  return (d) =>
    d ? d.toLocaleString(intl, { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" }) : "";
}

/**
 * The record's approval state and what came back, for its owner: the state,
 * the approver's comment on the latest decision, the form to send it (while
 * she may still change it), and every earlier request.
 */
export async function ApprovalPanel({
  t,
  state,
  history,
  itemId,
  submit,
  readOnly,
  blocker,
}: {
  t: Translate;
  state: string;
  history: HistoryEntry[];
  itemId: string;
  submit?: FormAction;
  /** An approver's view: the state, the history and a link to the queue; no form. */
  readOnly?: boolean;
  /** Why she cannot send it yet (a missing lesson, attendance not taken), if so. */
  blocker?: string | null;
}) {
  const stamp = await stampFormatter();
  const latest = history[0];
  const editable = isEditable(state);
  return (
    <Card title={t("approval.title")} sub={t(`approval.hint.${state}`)}>
      <div style={wrapRow}>
        <span style={mutedText}>{t("approval.stateLabel")}</span>
        <StateChip t={t} state={state} />
      </div>
      {latest?.comment && latest.status !== "pending" ? (
        <div role="note" style={{ padding: 10, borderRadius: "var(--r-2)", background: "var(--rust-soft)", fontSize: 13 }}>
          <div className="label">{t("approval.comment", { name: latest.decidedBy ?? t("approval.anApprover") })}</div>
          <p style={{ margin: "4px 0 0", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{latest.comment}</p>
        </div>
      ) : null}
      {readOnly ? (
        <div style={wrapRow}>
          <Link href="/approvals" className="btn btn-sm">
            {t("approval.openQueue")}
          </Link>
        </div>
      ) : editable && submit ? (
        blocker ? (
          <p style={{ ...mutedText, fontSize: 13, margin: 0 }}>{blocker}</p>
        ) : (
          <ActionForm action={submit}>
            <input type="hidden" name="id" value={itemId} />
            <Field label={t("approval.noteLabel")} hint={t("approval.noteHint")}>
              <textarea name="note" className="text" rows={2} maxLength={1000} />
            </Field>
            <div>
              <SubmitButton className="btn btn-primary" pendingLabel={t("approval.sending")}>
                {t("approval.submit")}
              </SubmitButton>
            </div>
          </ActionForm>
        )
      ) : null}
      {history.length > 0 ? (
        <details>
          <summary style={{ cursor: "pointer", fontSize: 13 }}>{t("approval.history", { count: history.length })}</summary>
          <ol style={{ listStyle: "none", padding: 0, margin: "8px 0 0", display: "grid", gap: 8 }}>
            {history.map((h, i) => (
              <li key={i} style={{ ...listRow, display: "grid", gap: 4 }}>
                <div style={wrapRow}>
                  <StateChip t={t} state={h.status} />
                  <span style={mutedText}>{t("approval.sentOn", { when: stamp(h.submittedAt) })}</span>
                  {h.decidedAt ? (
                    <span style={mutedText}>{t("approval.decidedOn", { when: stamp(h.decidedAt), name: h.decidedBy ?? t("approval.anApprover") })}</span>
                  ) : null}
                </div>
                {h.note ? <div style={{ fontSize: 13, overflowWrap: "anywhere" }}>{t("approval.yourNote", { note: h.note })}</div> : null}
                {h.comment ? <div style={{ fontSize: 13, overflowWrap: "anywhere" }}>{t("approval.theirComment", { comment: h.comment })}</div> : null}
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </Card>
  );
}

/** The banner an approver sees over a teacher's record. */
export function ApproverBanner({ t, teacher }: { t: Translate; teacher: string }) {
  return (
    <div role="note" className="card" style={{ padding: 12, background: "var(--indigo-soft)", fontSize: 13 }}>
      {t("approval.readOnlyBanner", { teacher })}
    </div>
  );
}
