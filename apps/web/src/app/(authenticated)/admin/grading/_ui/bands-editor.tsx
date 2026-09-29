"use client";

// The bands of one grading scale: label, from %, to %, whether it counts as a
// pass, in order. Rows are added, removed and moved here; the whole list is
// saved at once (saveBandsAction replaces the scale's bands). Gaps and
// overlaps are shown as the administrator types -- the same scaleProblems()
// the page shows for what is saved -- and do not stop a save: a scale can be
// built up in steps.
//
// Words: grading.client.bands.

import { useActionState, useState } from "react";
import { useTranslations } from "next-intl";
import { SubmitButton } from "@/components/SubmitButton";
import { scaleProblems } from "@/lib/grading/bands";
import { formatRanges } from "@/lib/grading/format";
import type { FormState } from "./action-form";

type Row = { key: number; label: string; min: string; max: string; pass: boolean };
export type BandValue = { label: string; minPct: number; maxPct: number; isPass: boolean };

const blank = (key: number): Row => ({ key, label: "", min: "", max: "", pass: true });
const isWhole = (s: string) => /^\d{1,3}$/.test(s.trim());

export function BandsEditor({
  scaleId,
  initial,
  action,
}: {
  scaleId: string;
  initial: BandValue[];
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
}) {
  const t = useTranslations("grading.client.bands");
  const [state, formAction] = useActionState<FormState, FormData>(action, undefined);
  const [rows, setRows] = useState<Row[]>(() =>
    initial.length
      ? initial.map((b, i) => ({ key: i, label: b.label, min: String(b.minPct), max: String(b.maxPct), pass: b.isPass }))
      : [blank(0)],
  );
  const nextKey = () => rows.reduce((m, r) => Math.max(m, r.key), -1) + 1;
  const update = (key: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const move = (index: number, by: -1 | 1) =>
    setRows((rs) => {
      const to = index + by;
      if (to < 0 || to >= rs.length) return rs;
      const copy = [...rs];
      [copy[index], copy[to]] = [copy[to]!, copy[index]!];
      return copy;
    });

  // Live check: only once every row has whole-number bounds.
  const complete = rows.length > 0 && rows.every((r) => isWhole(r.min) && isWhole(r.max));
  const problems = complete
    ? scaleProblems(rows.map((r, i) => ({ label: r.label, minPct: Number(r.min), maxPct: Number(r.max), isPass: r.pass, sequence: i })))
    : null;

  return (
    <form action={formAction} data-testid="bands-editor" style={{ display: "grid", gap: 10 }}>
      <input type="hidden" name="scaleId" value={scaleId} />
      {rows.map((r, i) => (
        <fieldset
          key={r.key}
          style={{ border: "1px solid var(--line)", borderRadius: "var(--r-2)", padding: "8px 10px", margin: 0, minWidth: 0 }}
        >
          <legend style={{ fontSize: 11, color: "var(--ink-3)", padding: "0 4px" }}>{t("row", { n: i + 1 })}</legend>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(92px, 1fr))", gap: 8, alignItems: "end" }}>
            <label style={{ display: "grid", gap: 3, fontSize: 11, color: "var(--ink-2)" }}>
              {t("label")}
              <input
                className="text"
                name="label"
                value={r.label}
                maxLength={32}
                required
                onChange={(e) => update(r.key, { label: e.target.value })}
              />
            </label>
            <label style={{ display: "grid", gap: 3, fontSize: 11, color: "var(--ink-2)" }}>
              {t("from")}
              <input
                className="text"
                name="min"
                type="number"
                inputMode="numeric"
                min={0}
                max={100}
                step={1}
                required
                value={r.min}
                onChange={(e) => update(r.key, { min: e.target.value })}
              />
            </label>
            <label style={{ display: "grid", gap: 3, fontSize: 11, color: "var(--ink-2)" }}>
              {t("to")}
              <input
                className="text"
                name="max"
                type="number"
                inputMode="numeric"
                min={0}
                max={100}
                step={1}
                required
                value={r.max}
                onChange={(e) => update(r.key, { max: e.target.value })}
              />
            </label>
            <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12, minHeight: 34 }}>
              <input type="checkbox" checked={r.pass} onChange={(e) => update(r.key, { pass: e.target.checked })} />
              {t("pass")}
              <input type="hidden" name="pass" value={r.pass ? "1" : "0"} />
            </label>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => move(i, -1)} disabled={i === 0}>
              {t("moveUp")}
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => move(i, 1)} disabled={i === rows.length - 1}>
              {t("moveDown")}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}
              disabled={rows.length === 1}
            >
              {t("remove")}
            </button>
          </div>
        </fieldset>
      ))}

      <div>
        <button type="button" className="btn btn-sm" onClick={() => setRows((rs) => [...rs, blank(nextKey())])}>
          {t("add")}
        </button>
      </div>

      {problems ? (
        problems.gaps.length || problems.overlaps.length ? (
          <div role="note" data-testid="bands-problems" style={{ fontSize: 12, color: "var(--saffron)", display: "grid", gap: 4 }}>
            {problems.gaps.length ? <span>{t("gaps", { list: formatRanges(problems.gaps) })}</span> : null}
            {problems.overlaps.length ? <span>{t("overlaps", { list: formatRanges(problems.overlaps) })}</span> : null}
          </div>
        ) : (
          <p style={{ margin: 0, fontSize: 12, color: "var(--lichen)" }}>{t("complete")}</p>
        )
      ) : null}

      <div>
        <SubmitButton className="btn btn-primary btn-sm">{t("save")}</SubmitButton>
      </div>
      {state ? (
        <p role={state.ok ? "status" : "alert"} style={{ margin: 0, fontSize: 13, color: state.ok ? "var(--lichen)" : "var(--rust)" }}>
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
