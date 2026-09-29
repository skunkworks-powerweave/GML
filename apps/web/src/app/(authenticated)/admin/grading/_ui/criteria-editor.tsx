"use client";

// The criteria of one observation rubric: title, what good looks like, and the
// highest score (1-10), in order. Saved together (saveCriteriaAction). A
// criterion keeps its id through renames and moves, so the scores observers
// gave it stay attached; one that has been scored cannot be removed.
//
// Words: grading.client.criteria.

import { useActionState, useState } from "react";
import { useTranslations } from "next-intl";
import { SubmitButton } from "@/components/SubmitButton";
import type { FormState } from "./action-form";

type Row = { key: number; id: string; title: string; description: string; max: string; scored: number };
export type CriterionValue = { id: string; title: string; description: string | null; maxScore: number; scored: number };

const blank = (key: number): Row => ({ key, id: "", title: "", description: "", max: "4", scored: 0 });

export function CriteriaEditor({
  rubricId,
  initial,
  action,
}: {
  rubricId: string;
  initial: CriterionValue[];
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
}) {
  const t = useTranslations("grading.client.criteria");
  const [state, formAction] = useActionState<FormState, FormData>(action, undefined);
  const [rows, setRows] = useState<Row[]>(() =>
    initial.length
      ? initial.map((c, i) => ({
          key: i,
          id: c.id,
          title: c.title,
          description: c.description ?? "",
          max: String(c.maxScore),
          scored: c.scored,
        }))
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
  const total = rows.reduce((sum, r) => sum + (/^\d+$/.test(r.max) ? Number(r.max) : 0), 0);

  return (
    <form action={formAction} data-testid="criteria-editor" style={{ display: "grid", gap: 10 }}>
      <input type="hidden" name="rubricId" value={rubricId} />
      {rows.map((r, i) => (
        <fieldset
          key={r.key}
          style={{ border: "1px solid var(--line)", borderRadius: "var(--r-2)", padding: "8px 10px", margin: 0, minWidth: 0 }}
        >
          <legend style={{ fontSize: 11, color: "var(--ink-3)", padding: "0 4px" }}>{t("row", { n: i + 1 })}</legend>
          <input type="hidden" name="criterionId" value={r.id} />
          <div style={{ display: "grid", gap: 8 }}>
            <label style={{ display: "grid", gap: 3, fontSize: 11, color: "var(--ink-2)" }}>
              {t("title")}
              <input
                className="text"
                name="title"
                value={r.title}
                maxLength={200}
                required
                onChange={(e) => update(r.key, { title: e.target.value })}
              />
            </label>
            <label style={{ display: "grid", gap: 3, fontSize: 11, color: "var(--ink-2)" }}>
              {t("description")}
              <textarea
                className="text"
                name="description"
                rows={2}
                value={r.description}
                onChange={(e) => update(r.key, { description: e.target.value })}
              />
            </label>
            <label style={{ display: "grid", gap: 3, fontSize: 11, color: "var(--ink-2)", maxWidth: 160 }}>
              {t("max")}
              <input
                className="text"
                name="maxScore"
                type="number"
                inputMode="numeric"
                min={1}
                max={10}
                step={1}
                required
                value={r.max}
                onChange={(e) => update(r.key, { max: e.target.value })}
              />
            </label>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8, alignItems: "center" }}>
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
              disabled={rows.length === 1 || r.scored > 0}
            >
              {t("remove")}
            </button>
            {r.scored > 0 ? <span style={{ fontSize: 11, color: "var(--ink-3)" }}>{t("scored", { count: r.scored })}</span> : null}
          </div>
        </fieldset>
      ))}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
        <button type="button" className="btn btn-sm" onClick={() => setRows((rs) => [...rs, blank(nextKey())])}>
          {t("add")}
        </button>
        <span style={{ fontSize: 12, color: "var(--ink-3)" }}>{t("total", { total })}</span>
      </div>
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
