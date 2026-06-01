"use client";

// Section-gate prompt page. Re-skin per spec 035 — matches the prototype's
// SectionGate visual: centered card on parchment background, lock icon, friendly
// copy, attempt counter inline with the error.

import { useActionState, use } from "react";
import Link from "next/link";
import { verifyGate, type GateState } from "./actions";

const LABELS: Record<string, { title: string; tagline: string }> = {
  mentorship: {
    title: "Mentorship",
    tagline: "Ask your programme administrator for the rotating section password.",
  },
  observation: {
    title: "Classroom Observation",
    tagline: "Observer evidence and forms are confidential and gate-protected.",
  },
  admin: {
    title: "Audit log",
    tagline: "Audit access is logged. Only super-admins hold the section password.",
  },
  tkt: { title: "TKT", tagline: "Section password required." },
  ttt: { title: "TTT", tagline: "Section password required." },
};

export default function GatePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ next?: string }>;
}) {
  const { slug } = use(params);
  const { next } = use(searchParams);
  const [state, formAction, pending] = useActionState<GateState | undefined, FormData>(verifyGate, {});
  const meta = LABELS[slug] ?? { title: slug, tagline: "Section password required." };

  return (
    <main
      style={{
        minHeight: "100dvh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 32,
        background: "var(--paper)",
      }}
    >
      <div className="card card-hi" style={{ width: "100%", maxWidth: 440, padding: 28, background: "var(--card-hi)" }}>
        {/* Header row: saffron lock badge + label/title */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
          <div
            style={{
              width: 36,
              height: 36,
              background: "var(--saffron-soft)",
              color: "var(--saffron)",
              borderRadius: 8,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
            aria-hidden
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 11h14v10H5z" />
              <path d="M8 11V7a4 4 0 018 0v4" />
            </svg>
          </div>
          <div>
            <div className="label">Section gate</div>
            <h2 className="serif" style={{ fontSize: 18, letterSpacing: "-0.01em" }}>{meta.title}</h2>
          </div>
        </div>

        <p style={{ fontSize: 13, color: "var(--ink-3)", marginTop: 8, lineHeight: 1.5 }}>{meta.tagline}</p>

        <form action={formAction} style={{ marginTop: 16 }}>
          <input type="hidden" name="slug" value={slug} />
          <input type="hidden" name="next" value={next ?? "/dashboard"} />
          <div className="form-row">
            <label htmlFor="gate-password">Section password</label>
            <input
              id="gate-password"
              className="text"
              name="password"
              type="password"
              required
              autoFocus
              autoComplete="off"
              style={{ fontFamily: "var(--mono)", letterSpacing: "0.1em" }}
            />
            {state?.error ? (
              <div style={{ fontSize: 11, color: "var(--rust)" }} role="alert">{state.error}</div>
            ) : null}
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "space-between", marginTop: 16 }}>
            <Link href="/dashboard" className="btn">← Back</Link>
            <button type="submit" className="btn btn-primary" disabled={pending}>
              {pending ? "Checking…" : "Unlock section"}
            </button>
          </div>
        </form>

        <div
          style={{
            marginTop: 18,
            paddingTop: 14,
            borderTop: "1px solid var(--line)",
            fontSize: 11,
            color: "var(--ink-3)",
            lineHeight: 1.5,
          }}
        >
          Your access lasts 8 hours after entry. 5 wrong attempts in 15 minutes locks this section for your account.
        </div>
      </div>
    </main>
  );
}
