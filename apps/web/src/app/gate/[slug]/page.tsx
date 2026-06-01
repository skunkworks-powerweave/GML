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
        padding: 24,
        background: "var(--paper)",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 440,
          background: "var(--card-hi)",
          border: "1px solid var(--line)",
          borderRadius: "var(--r-3)",
          padding: 32,
          boxShadow: "var(--shadow-2)",
        }}
      >
        {/* Lock badge */}
        <div
          style={{
            width: 44,
            height: 44,
            borderRadius: "var(--r-2)",
            background: "var(--saffron-soft)",
            color: "var(--saffron)",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            marginBottom: 18,
          }}
          aria-hidden
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 11h14v10H5z" />
            <path d="M8 11V7a4 4 0 018 0v4" />
          </svg>
        </div>

        <div
          style={{
            fontSize: 10,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            color: "var(--ink-3)",
          }}
        >
          Section gate
        </div>
        <h1 style={{ fontFamily: "var(--serif)", fontSize: 26, marginTop: 4 }}>{meta.title}</h1>
        <p style={{ fontSize: 13, color: "var(--ink-3)", marginTop: 8, lineHeight: 1.5 }}>{meta.tagline}</p>

        <form action={formAction} style={{ marginTop: 22, display: "flex", flexDirection: "column", gap: 14 }}>
          <input type="hidden" name="slug" value={slug} />
          <input type="hidden" name="next" value={next ?? "/dashboard"} />
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 12, color: "var(--ink-2)", fontWeight: 500 }}>Section password</span>
            <input
              name="password"
              type="password"
              required
              autoFocus
              autoComplete="off"
              style={{
                padding: "10px 12px",
                border: "1px solid var(--line-2)",
                borderRadius: "var(--r-2)",
                background: "var(--paper)",
                fontSize: 14,
                fontFamily: "var(--mono)",
                letterSpacing: "0.1em",
              }}
            />
          </label>
          {state?.error ? (
            <p style={{ fontSize: 12, color: "var(--rust)" }} role="alert">{state.error}</p>
          ) : null}
          <button
            type="submit"
            disabled={pending}
            style={{
              padding: "10px 12px",
              background: "var(--ink)",
              color: "var(--paper)",
              border: "1px solid var(--ink)",
              borderRadius: "var(--r-2)",
              fontSize: 14,
              fontWeight: 500,
              opacity: pending ? 0.6 : 1,
            }}
          >
            {pending ? "Checking…" : "Continue"}
          </button>
        </form>

        <div
          style={{
            marginTop: 20,
            paddingTop: 16,
            borderTop: "1px solid var(--line)",
            fontSize: 11,
            color: "var(--ink-3)",
            lineHeight: 1.5,
          }}
        >
          Your access lasts 8 hours after entry. 5 wrong attempts in 15 minutes locks this section for your account.
          <br />
          <Link href="/dashboard" style={{ color: "var(--indigo)", textDecoration: "underline" }}>
            ← back to dashboard
          </Link>
        </div>
      </div>
    </main>
  );
}
