"use client";

// Marks entry for one assessment: each student on the class's roster, her
// marks (or absent) and a remark, with the percentage and grade worked out as
// the teacher types -- the same gradeMark()/summarise() the page uses for
// what is saved, over the scale the server resolved. The save itself is
// checked again on the server (saveMarksAction): only her own, still-editable
// assessment, and only students on its roster.
//
// One card per student rather than a table, so it reads on a phone.
// Words: grading.client.marks.

import { useActionState, useState } from "react";
import { useTranslations } from "next-intl";
import { SubmitButton } from "@/components/SubmitButton";
import type { Band } from "@/lib/grading/bands";
import { formatPct } from "@/lib/grading/format";
import { gradeMark, parseMarks, summarise } from "@/lib/grading/summary";
import type { FormState } from "@/app/(authenticated)/admin/grading/_ui/action-form";

export type MarksEditorRow = {
  learnerId: string;
  name: string;
  rollNumber: string | null;
  marks: string;
  absent: boolean;
  remark: string;
};

type Entry = { marks: string; absent: boolean; remark: string };

export function MarksEditor({
  assessmentId,
  maxMarks,
  bands,
  rows,
  action,
}: {
  assessmentId: string;
  maxMarks: number;
  bands: Band[] | null;
  rows: MarksEditorRow[];
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
}) {
  const t = useTranslations("grading.client.marks");
  const [state, formAction] = useActionState<FormState, FormData>(action, undefined);
  const [entries, setEntries] = useState<Record<string, Entry>>(() =>
    Object.fromEntries(rows.map((r) => [r.learnerId, { marks: r.marks, absent: r.absent, remark: r.remark }])),
  );
  const entryOf = (id: string): Entry => entries[id] ?? { marks: "", absent: false, remark: "" };
  const set = (id: string, patch: Partial<Entry>) => setEntries((e) => ({ ...e, [id]: { ...entryOf(id), ...patch } }));

  const numeric = rows.map((r) => {
    const e = entryOf(r.learnerId);
    const m = e.absent ? null : parseMarks(e.marks, maxMarks);
    return { marks: m === undefined ? null : m, absent: e.absent };
  });
  const summary = summarise(numeric, maxMarks, bands);

  return (
    <form action={formAction} data-testid="marks-editor" style={{ display: "grid", gap: 10 }}>
      <input type="hidden" name="assessmentId" value={assessmentId} />
      <p style={{ margin: 0, fontSize: 12, color: "var(--ink-3)" }} data-testid="marks-live-summary">
        {summary.average == null
          ? t("summaryNone", { absent: summary.absent })
          : summary.passed == null
            ? t("summaryNoScale", { graded: summary.graded, average: formatPct(summary.average), absent: summary.absent })
            : t("summary", {
                graded: summary.graded,
                average: formatPct(summary.average),
                passed: summary.passed,
                absent: summary.absent,
              })}
      </p>
      {rows.map((r) => {
        const e = entryOf(r.learnerId);
        const parsed = e.absent ? null : parseMarks(e.marks, maxMarks);
        const invalid = parsed === undefined;
        const g = gradeMark({ marks: parsed ?? null, absent: e.absent }, maxMarks, bands);
        const fieldId = `marks-${r.learnerId}`;
        return (
          <div
            key={r.learnerId}
            className="card"
            data-testid="marks-row"
            style={{ padding: "10px 12px", display: "grid", gap: 8 }}
          >
            <input type="hidden" name="learnerId" value={r.learnerId} />
            <input type="hidden" name="absent" value={e.absent ? "1" : "0"} />
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "baseline", justifyContent: "space-between" }}>
              <span style={{ fontWeight: 500 }}>
                {r.rollNumber ? <span className="mono" style={{ color: "var(--ink-3)", fontSize: 12, marginRight: 6 }}>{r.rollNumber}</span> : null}
                {r.name}
              </span>
              <span className="mono" style={{ fontSize: 12, color: g.band && !g.band.isPass ? "var(--rust)" : "var(--ink-2)" }}>
                {e.absent
                  ? t("absentShort")
                  : g.pct == null
                    ? "—"
                    : g.band
                      ? t("pctGrade", { pct: formatPct(g.pct), grade: g.band.label })
                      : t("pctOnly", { pct: formatPct(g.pct) })}
              </span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 8, alignItems: "end" }}>
              <label htmlFor={fieldId} style={{ display: "grid", gap: 3, fontSize: 11, color: "var(--ink-2)" }}>
                {t("marks", { max: maxMarks })}
                <input
                  id={fieldId}
                  className="text"
                  name="marks"
                  inputMode="decimal"
                  autoComplete="off"
                  value={e.absent ? "" : e.marks}
                  disabled={e.absent}
                  aria-invalid={invalid || undefined}
                  onChange={(ev) => set(r.learnerId, { marks: ev.target.value })}
                />
              </label>
              <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12, minHeight: 34 }}>
                <input type="checkbox" checked={e.absent} onChange={(ev) => set(r.learnerId, { absent: ev.target.checked })} />
                {t("absent")}
              </label>
              <label style={{ display: "grid", gap: 3, fontSize: 11, color: "var(--ink-2)" }}>
                {t("remark")}
                <input
                  className="text"
                  name="remark"
                  maxLength={240}
                  value={e.remark}
                  onChange={(ev) => set(r.learnerId, { remark: ev.target.value })}
                />
              </label>
            </div>
            {/* A disabled field is not posted: keep the list aligned. */}
            {e.absent ? <input type="hidden" name="marks" value="" /> : null}
            {invalid ? (
              <span role="alert" style={{ fontSize: 11, color: "var(--rust)" }}>
                {t("invalid", { max: maxMarks })}
              </span>
            ) : null}
          </div>
        );
      })}
      <div>
        <SubmitButton className="btn btn-primary">{t("save")}</SubmitButton>
      </div>
      {state ? (
        <p role={state.ok ? "status" : "alert"} style={{ margin: 0, fontSize: 13, color: state.ok ? "var(--lichen)" : "var(--rust)" }}>
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
