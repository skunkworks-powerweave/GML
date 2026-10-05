// The pieces the student-progress pages share -- the teacher's
// (/teaching/progress) and the admin's (/progress/students): the rule behind the
// numbers, a class's figures, and a row per student. Server components; their
// copy is teaching.progress.*. The figures are lib/teaching/progress.ts.
//
// PHONE FIRST, as the other /teaching pages: a student is a row that wraps, its
// figures an auto-fit grid, never a table of fixed columns.

import type { CSSProperties, ReactNode } from "react";
import Link from "next/link";
import { formatPct } from "@/lib/grading/format";
import { LOW_ATTENDANCE_PCT, type ClassFigures, type StudentOrder, type StudentProgress } from "@/lib/teaching/progress";
import { listRow, mutedText, wrapRow, type Translate } from "./ui";

const percent = (t: Translate, value: string) => t("progress.percent", { value });

const factGrid: CSSProperties = { display: "grid", gap: "6px 12px", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", margin: 0 };

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ minWidth: 0 }}>
      <dt className="label">{label}</dt>
      <dd style={{ margin: 0, overflowWrap: "anywhere" }}>{children}</dd>
    </div>
  );
}

/** What the figures mean, in words: the attendance rule, the marks rule and the highlight. */
export function RuleNote({ t }: { t: Translate }) {
  return (
    <section className="card" style={{ padding: 12, display: "grid", gap: 4 }}>
      <div className="label">{t("progress.howTitle")}</div>
      <p style={{ ...mutedText, margin: 0 }}>{t("progress.rule.attendance")}</p>
      <p style={{ ...mutedText, margin: 0 }}>{t("progress.rule.marks")}</p>
      <p style={{ ...mutedText, margin: 0 }}>{t("progress.rule.low", { threshold: LOW_ATTENDANCE_PCT })}</p>
    </section>
  );
}

/** The four numbers of a class, as plain text: "—" where there is nothing to average. */
function figureTexts(t: Translate, f: ClassFigures) {
  return {
    students: String(f.students),
    sessions: f.sessionsPlanned > 0 ? t("progress.stat.sessionsOf", { held: f.sessionsHeld, planned: f.sessionsPlanned }) : "—",
    attendance: f.attendancePct == null ? "—" : percent(t, String(f.attendancePct)),
    marks: f.marksAvg == null ? "—" : percent(t, formatPct(f.marksAvg)),
  };
}

/** A class's figures as tiles, with how many students are under the threshold when that is known. */
export function FiguresGrid({ t, figures, lowCount }: { t: Translate; figures: ClassFigures; lowCount?: number }) {
  const v = figureTexts(t, figures);
  const tiles: Array<[string, string]> = [
    [t("progress.stat.students"), v.students],
    [t("progress.stat.sessions"), v.sessions],
    [t("progress.stat.attendance"), v.attendance],
    [t("progress.stat.marks"), v.marks],
  ];
  if (lowCount != null) tiles.push([t("progress.stat.low", { threshold: LOW_ATTENDANCE_PCT }), String(lowCount)]);
  return (
    <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))" }}>
      {tiles.map(([label, value]) => (
        <div key={label} className="card" style={{ padding: 10, minWidth: 0 }}>
          <div className="label">{label}</div>
          <div className="serif" style={{ fontSize: 22, marginTop: 4, overflowWrap: "anywhere" }}>
            {value}
          </div>
        </div>
      ))}
    </div>
  );
}

/** A class's, or a school's, figures on one compact line of facts (the admin overview). */
export function FigureFacts({ t, figures }: { t: Translate; figures: ClassFigures }) {
  const v = figureTexts(t, figures);
  return (
    <dl style={factGrid}>
      <Fact label={t("progress.stat.students")}>{v.students}</Fact>
      <Fact label={t("progress.stat.sessions")}>{v.sessions}</Fact>
      <Fact label={t("progress.stat.attendance")}>{v.attendance}</Fact>
      <Fact label={t("progress.stat.marks")}>{v.marks}</Fact>
    </dl>
  );
}

/** "Order students by: Roll number | Lowest attendance first", as links so it works with no script. */
export function SortLinks({ t, basePath, current }: { t: Translate; basePath: string; current: StudentOrder }) {
  const chip = (on: boolean) => (on ? "chip chip-indigo" : "chip");
  return (
    <nav aria-label={t("progress.sort.label")} style={wrapRow}>
      <span style={mutedText}>{t("progress.sort.label")}</span>
      <Link href={basePath} className={chip(current === "roll")} aria-current={current === "roll" ? "page" : undefined}>
        {t("progress.sort.roll")}
      </Link>
      <Link href={`${basePath}?sort=attendance`} className={chip(current === "attendance")} aria-current={current === "attendance" ? "page" : undefined}>
        {t("progress.sort.attendance")}
      </Link>
    </nav>
  );
}

/**
 * One row per student: name and roll, then attendance (with sessions attended
 * of marked), marks and the last session. A student under the threshold is
 * outlined and says so in words -- colour is not the only signal.
 */
export function StudentRows({ t, students, fmtDate }: { t: Translate; students: StudentProgress[]; fmtDate: (iso: string | null) => string }) {
  return (
    <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 8 }}>
      {students.map((s) => (
        <li
          key={s.id}
          data-low={s.low ? "true" : undefined}
          style={{ ...listRow, display: "grid", gap: 6, ...(s.low ? { borderColor: "var(--rust)", background: "var(--rust-soft)" } : null) }}
        >
          <div style={{ ...wrapRow, justifyContent: "space-between" }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600, overflowWrap: "anywhere" }}>{s.name}</div>
              <div style={mutedText}>
                {[s.rollNumber ? t("students.roll", { roll: s.rollNumber }) : null, s.section ? t("students.section", { section: s.section }) : null]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
            </div>
            {s.low ? <span className="chip chip-rust">{t("progress.low")}</span> : null}
          </div>
          <dl style={factGrid}>
            <Fact label={t("progress.student.attendance")}>
              {s.attendancePct == null
                ? t("progress.student.notMarked")
                : s.pctFromRoster
                  ? t("progress.student.attendanceRoster", { pct: String(s.attendancePct) })
                  : t("progress.student.attendanceValue", { pct: String(s.attendancePct), attended: s.attended, marked: s.marked })}
            </Fact>
            <Fact label={t("progress.student.marks")}>{s.marksAvg == null ? t("progress.student.noMarks") : percent(t, formatPct(s.marksAvg))}</Fact>
            <Fact label={t("progress.student.last")}>{s.lastSession ? fmtDate(s.lastSession) : t("progress.student.noSession")}</Fact>
          </dl>
        </li>
      ))}
    </ul>
  );
}
