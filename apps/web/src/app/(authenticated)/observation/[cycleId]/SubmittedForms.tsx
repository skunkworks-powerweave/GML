// The submitted stage forms of one cycle, read back as question and answer.
//
// A pure function of its props (lib/observation/forms.ts builds them), so it
// renders on the server with no client JavaScript -- and every answer is React
// text, never markup, whatever the submitter typed.

import type { SubmittedFormView } from "@/lib/observation/forms";

export function SubmittedForms({ forms }: { forms: SubmittedFormView[] }) {
  if (forms.length === 0) {
    return <p style={{ fontSize: 12, color: "var(--ink-3)" }}>No forms submitted yet.</p>;
  }
  return (
    <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 8 }}>
      {forms.map((f) => (
        <li key={f.id} className="card" style={{ padding: 10, fontSize: 12, boxShadow: "none" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span className="chip chip-ink" style={{ fontSize: 10 }}>{f.kind}</span>
            <span style={{ fontWeight: 500 }}>{f.title}</span>
          </div>
          <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 6 }}>
            Submitted by {f.submitterName ?? "a removed account"}
            {f.onBehalf ? " on behalf of the teacher" : ""} ·{" "}
            <span className="mono">
              {new Date(f.submittedAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}
            </span>
          </div>
          {f.entries.length > 0 ? (
            <dl style={{ margin: "8px 0 0", display: "grid", gap: 6 }}>
              {f.entries.map((e, i) => (
                <div key={`${e.label}-${i}`}>
                  <dt className="label" style={{ fontSize: 10 }}>{e.label}</dt>
                  {/* pre-wrap keeps the line breaks the submitter typed. */}
                  <dd style={{ margin: 0, fontSize: 13, color: "var(--ink-2)", lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
                    {e.value}
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
