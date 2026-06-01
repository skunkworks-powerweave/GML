"use client";

// Login page re-skin per spec 034 — 1:1 port of `login.jsx`'s two-pane design
// (brand panel left + form right) minus the prototype's demo-role picker
// (production uses real Auth.js Credentials + Nodemailer magic-link).

import { useActionState, useState } from "react";
import Link from "next/link";
import { loginAction, type LoginState } from "./actions";
import { EmailLinkForm } from "./email-link-form";

export default function LoginPage() {
  const [state, formAction, pending] = useActionState<LoginState | undefined, FormData>(
    loginAction,
    {},
  );
  const [mode, setMode] = useState<"password" | "magic">("password");

  return (
    <div style={{ minHeight: "100dvh", display: "grid", gridTemplateColumns: "1.05fr 1fr" }}>
      {/* Left: brand panel */}
      <div
        className="login-brand"
        style={{
          position: "relative",
          background: "linear-gradient(180deg, oklch(0.32 0.08 268) 0%, oklch(0.22 0.07 268) 100%)",
          color: "var(--paper)",
          padding: 48,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <div style={{ position: "relative", zIndex: 1, display: "flex", alignItems: "center", gap: 12 }}>
          <span
            style={{
              width: 36,
              height: 36,
              borderRadius: 8,
              background: "var(--saffron)",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              fontFamily: "var(--serif)",
              fontSize: 18,
              fontWeight: 700,
              color: "oklch(0.18 0.05 268)",
            }}
            aria-hidden
          >
            GML
          </span>
          <div style={{ fontFamily: "var(--serif)", fontSize: 20, fontWeight: 600 }}>
            Goldenmile RTT LMS
          </div>
        </div>

        <svg
          viewBox="0 0 600 600"
          preserveAspectRatio="xMidYMid slice"
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: 0.5, zIndex: 0 }}
          aria-hidden
        >
          <defs>
            <linearGradient id="login-sky" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="oklch(0.42 0.10 268)" />
              <stop offset="100%" stopColor="oklch(0.22 0.07 268)" />
            </linearGradient>
          </defs>
          <rect width="600" height="600" fill="url(#login-sky)" />
          <circle cx="460" cy="120" r="42" fill="oklch(0.92 0.04 60)" opacity="0.55" />
          <path
            d="M0 420 L80 320 L160 380 L260 240 L360 360 L460 280 L600 350 L600 600 L0 600 Z"
            fill="oklch(0.16 0.04 268)"
            opacity="0.85"
          />
          <path
            d="M0 480 L100 410 L220 460 L340 380 L460 460 L580 410 L600 440 L600 600 L0 600 Z"
            fill="oklch(0.10 0.03 268)"
          />
          {/* Prayer-flag accent atop the tallest peak (from prototype) */}
          <path
            d="M260 240 L240 290 L280 290 Z M260 240 L270 270 L295 280"
            stroke="oklch(0.85 0.02 268)"
            strokeWidth="2"
            fill="oklch(0.85 0.02 268)"
            opacity="0.7"
          />
        </svg>

        <div style={{ position: "relative", zIndex: 1, marginTop: "auto", maxWidth: 460 }}>
          <div
            style={{
              fontFamily: "var(--serif)",
              fontSize: 38,
              lineHeight: 1.15,
              letterSpacing: "-0.02em",
            }}
          >
            A learning system designed for the long road from Leh to Drass.
          </div>
          <p style={{ marginTop: 18, fontSize: 14, lineHeight: 1.55, color: "oklch(0.85 0.03 60)", maxWidth: 420 }}>
            Goldenmile RTT — Recruit, Train &amp; Transform — supports teachers and mentor pairings across Leh and
            Kargil, with WhatsApp-first video review and a paperwork system that respects how schools actually run.
          </p>
          <div
            style={{
              marginTop: 28,
              display: "flex",
              gap: 32,
              fontFamily: "var(--mono)",
              fontSize: 11,
              color: "oklch(0.82 0.02 60)",
            }}
          >
            <Stat n="500+" label="teachers" />
            <Stat n="11" label="zones" />
            <Stat n="3" label="phases" />
            <Stat n="2" label="districts" />
          </div>
        </div>

        <div
          style={{
            position: "relative",
            zIndex: 1,
            marginTop: 28,
            fontSize: 11,
            fontFamily: "var(--mono)",
            color: "oklch(0.75 0.02 60)",
          }}
        >
          Confidential · internal programme use only · audited
        </div>
      </div>

      {/* Right: form */}
      <div
        style={{
          background: "var(--paper)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 48,
          position: "relative",
        }}
      >
        <div style={{ width: "100%", maxWidth: 380 }}>
          <div className="label">Sign in</div>
          <h1 style={{ fontFamily: "var(--serif)", fontSize: 30, marginTop: 4 }}>Welcome back.</h1>
          <p style={{ fontSize: 13, color: "var(--ink-3)", marginTop: 6, marginBottom: 24 }}>
            Use the credentials your programme administrator gave you, or request a sign-in link by email.
          </p>

          <div
            style={{
              display: "flex",
              gap: 12,
              borderBottom: "1px solid var(--line)",
              marginBottom: 16,
              fontSize: 12,
            }}
          >
            {(["password", "magic"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                style={{
                  background: "none",
                  border: "none",
                  padding: "8px 0",
                  borderBottom: mode === m ? "2px solid var(--ink)" : "2px solid transparent",
                  color: mode === m ? "var(--ink)" : "var(--ink-3)",
                  fontWeight: mode === m ? 600 : 500,
                }}
              >
                {m === "password" ? "Password" : "Magic link"}
              </button>
            ))}
          </div>

          {mode === "password" ? (
            <form action={formAction} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ fontSize: 12, color: "var(--ink-2)", fontWeight: 500 }}>Email</span>
                <input
                  name="email"
                  type="email"
                  autoComplete="email"
                  required
                  style={{
                    padding: "9px 11px",
                    border: "1px solid var(--line-2)",
                    borderRadius: "var(--r-2)",
                    background: "var(--card-hi)",
                    fontSize: 14,
                  }}
                />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                  <span style={{ color: "var(--ink-2)", fontWeight: 500 }}>Password</span>
                  <Link href="#" style={{ fontSize: 11 }}>Forgot?</Link>
                </div>
                <input
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  style={{
                    padding: "9px 11px",
                    border: "1px solid var(--line-2)",
                    borderRadius: "var(--r-2)",
                    background: "var(--card-hi)",
                    fontSize: 14,
                  }}
                />
              </label>
              {state?.error ? (
                <p style={{ fontSize: 12, color: "var(--rust)" }} role="alert">{state.error}</p>
              ) : null}
              <button
                type="submit"
                disabled={pending}
                className="btn btn-primary"
                style={{
                  width: "100%",
                  justifyContent: "center",
                  padding: "10px 12px",
                  fontSize: 14,
                  opacity: pending ? 0.6 : 1,
                }}
              >
                {pending ? "Signing in…" : "Sign in"}
              </button>
            </form>
          ) : (
            <EmailLinkForm />
          )}

          <div
            style={{
              marginTop: 28,
              paddingTop: 18,
              borderTop: "1px solid var(--line)",
              fontSize: 11,
              color: "var(--ink-3)",
              display: "flex",
              justifyContent: "space-between",
              fontFamily: "var(--mono)",
            }}
          >
            <span>Sessions audited · 30-day rotation</span>
            <span>v1.0 · build 2026.05</span>
          </div>
        </div>

        {/* Language switcher — absolute top-right per prototype */}
        <div style={{ position: "absolute", top: 18, right: 18, display: "flex", gap: 4 }}>
          <button type="button" className="btn btn-sm btn-ghost" style={{ minWidth: 32, justifyContent: "center" }}>
            EN
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost deva"
            style={{ minWidth: 32, justifyContent: "center" }}
            aria-label="हिन्दी"
          >
            हिन्दी
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            style={{ minWidth: 32, justifyContent: "center" }}
            aria-label="Ladakhi (لد)"
          >
            لد
          </button>
        </div>
      </div>
    </div>
  );
}

function Stat({ n, label }: { n: string; label: string }) {
  return (
    <div>
      <div style={{ fontSize: 22, fontFamily: "var(--serif)", color: "var(--paper)" }}>{n}</div>
      {label}
    </div>
  );
}
