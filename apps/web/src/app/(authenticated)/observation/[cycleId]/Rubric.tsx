// The scored rubric on the cycle page: the observer's inputs (on the observer
// form, and to revise until sign-off) and the scores everyone on the cycle
// reads, with the total, percentage and band.
//
// Server components. The criteria's titles and descriptions and the band's
// label are what an administrator typed (data, not translated); every other
// word is from the "observation" namespace, through the page's translator.

import type { getTranslations } from "next-intl/server";
import { MAX_TEXT_LENGTH } from "@/lib/forms/validate";
import { draftScope } from "@/lib/observation/drafts";
import { noteField, scoreField, type CycleRubric, type ScoreSummary } from "@/lib/observation/rubric";
import { DraftTextarea } from "./DraftTextarea";

type Translate = Awaited<ReturnType<typeof getTranslations>>;

/** 0..max, the choices a criterion's score has. */
function points(max: number): number[] {
  return Array.from({ length: max + 1 }, (_, i) => i);
}

/**
 * One fieldset per criterion: its title and description, a score from 0 to
 * its maximum (radios, which a phone can tap), and an optional note. `current`
 * pre-selects what was saved, for a revision.
 */
export function RubricFields({
  rubric,
  current,
  drafts,
  t,
}: {
  rubric: CycleRubric;
  current?: ScoreSummary | null;
  /** version: see the page's `drafts`. */
  drafts: { userId: string; cycleId: string; version: string };
  t: Translate;
}) {
  const saved = new Map((current?.criteria ?? []).map((c) => [c.id, c]));
  return (
    <div data-testid="rubric-fields" style={{ display: "grid", gap: 12 }}>
      <div className="label" style={{ fontSize: 11 }}>
        {t("cycle.rubric.formLegend", { name: rubric.name })}
      </div>
      {rubric.criteria.map((c) => {
        const was = saved.get(c.id);
        const legendId = `rubric-${c.id}-legend`;
        return (
          <fieldset
            key={c.id}
            data-criterion={c.id}
            style={{ border: "1px solid var(--line)", borderRadius: "var(--r-2)", padding: 10, margin: 0, minWidth: 0 }}
          >
            <legend id={legendId} style={{ fontSize: 13, fontWeight: 500, padding: "0 4px" }}>
              {t("cycle.rubric.criterionLegend", { title: c.title, max: c.maxScore })}
            </legend>
            {c.description ? (
              <p style={{ fontSize: 12, color: "var(--ink-3)", margin: "0 0 8px", whiteSpace: "pre-wrap" }}>{c.description}</p>
            ) : null}
            <div role="radiogroup" aria-labelledby={legendId} style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {points(c.maxScore).map((n) => (
                <label
                  key={n}
                  className="chip"
                  style={{ display: "inline-flex", alignItems: "center", gap: 4, minHeight: 32, cursor: "pointer" }}
                >
                  <input
                    type="radio"
                    name={scoreField(c.id)}
                    value={String(n)}
                    required
                    defaultChecked={was?.score === n}
                    aria-label={t("cycle.rubric.scoreOption", { score: n, max: c.maxScore, title: c.title })}
                  />
                  <span aria-hidden="true">{n}</span>
                </label>
              ))}
            </div>
            <label htmlFor={`rubric-${c.id}-note`} className="label" style={{ fontSize: 11, display: "block", marginTop: 8 }}>
              {t("cycle.rubric.noteLabel", { title: c.title })}
            </label>
            {current ? (
              // A revision starts from the saved note: a blank box would save
              // over it. The draft store keeps only text typed from empty.
              <textarea
                id={`rubric-${c.id}-note`}
                name={noteField(c.id)}
                defaultValue={was?.note ?? ""}
                rows={2}
                maxLength={MAX_TEXT_LENGTH}
                className="text"
                placeholder={t("cycle.rubric.notePlaceholder")}
                style={{ fontSize: 13, width: "100%" }}
              />
            ) : (
              <DraftTextarea
                id={`rubric-${c.id}-note`}
                name={noteField(c.id)}
                draftScope={draftScope(drafts.userId, drafts.cycleId, noteField(c.id))}
                draftVersion={drafts.version}
                rows={2}
                maxLength={MAX_TEXT_LENGTH}
                className="text"
                placeholder={t("cycle.rubric.notePlaceholder")}
                style={{ fontSize: 13, width: "100%" }}
              />
            )}
          </fieldset>
        );
      })}
    </div>
  );
}

/** The scores, per criterion, and the total, percentage and band. */
export function RubricScores({ summary, intl, t }: { summary: ScoreSummary; intl: string; t: Translate }) {
  return (
    <div data-testid="rubric-scores">
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: 8, marginBottom: 10 }}>
        <span className="serif" style={{ fontSize: 22 }} data-testid="rubric-total">
          {t("cycle.rubric.total", { total: summary.total, max: summary.max })}
        </span>
        {summary.pct != null ? (
          <span className="chip" data-testid="rubric-pct">
            {t("cycle.rubric.percent", { pct: summary.pct })}
          </span>
        ) : null}
        {summary.band ? (
          <span className={summary.band.isPass ? "chip chip-lichen" : "chip chip-saffron"} data-testid="rubric-band">
            {t("cycle.rubric.band", { band: summary.band.label })}
          </span>
        ) : (
          <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
            {summary.graded ? t("cycle.rubric.outsideScale") : t("cycle.rubric.noScale")}
          </span>
        )}
      </div>
      <ol style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 8 }}>
        {summary.criteria.map((c) => (
          <li key={c.id} data-criterion={c.id} style={{ borderLeft: "2px solid var(--line)", paddingLeft: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", fontSize: 13 }}>
              <span style={{ fontWeight: 500, minWidth: 0, overflowWrap: "anywhere" }}>{c.title}</span>
              <span className="mono" data-testid="rubric-criterion-score">
                {c.score == null ? t("cycle.rubric.notScored") : t("cycle.rubric.criterionScore", { score: c.score, max: c.maxScore })}
              </span>
            </div>
            {c.note ? (
              <p style={{ fontSize: 12, color: "var(--ink-2)", margin: "2px 0 0", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                {c.note}
              </p>
            ) : null}
          </li>
        ))}
      </ol>
      {summary.scoredAt ? (
        <p style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 8 }}>
          {summary.scoredBy
            ? t("cycle.rubric.scoredBy", {
                name: summary.scoredBy,
                date: summary.scoredAt.toLocaleDateString(intl, { day: "numeric", month: "long", year: "numeric" }),
              })
            : t("cycle.rubric.scoredOn", {
                date: summary.scoredAt.toLocaleDateString(intl, { day: "numeric", month: "long", year: "numeric" }),
              })}
        </p>
      ) : null}
    </div>
  );
}
