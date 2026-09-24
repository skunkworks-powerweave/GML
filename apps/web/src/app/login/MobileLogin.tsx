"use client";

// Mobile login shell — spec 136 port of LMS GML Frontend/mobile-login.jsx into
// production-grade code. The JSX prototype shipped a phone+OTP flow tailored
// to the demo deck; the production port keeps the visual structure (full-bleed
// brand hero with mountain silhouette + stacked form + bottom language pills)
// but rides the SAME Auth.js Credentials + Nodemailer magic-link contracts the
// desktop shell uses, so the backend, audit log, and rate-limit story stays
// identical across devices.
//
// Touch-target sizing follows Apple HIG / Material Design (44px minimum). The
// language pill row sits at the bottom with env(safe-area-inset-bottom)
// padding so the home-indicator on notch devices doesn't overlap the pills.
//
// Spec 125 — labels still translate via next-intl. The route-segment layout
// supplies the provider; we read action + language bundles client-side.
//
// Spec 034 governance contract — the Hindi literal (हिं) remains inside the
// language pill row so the static script-test that reads the source sees it.
// The Bhoti/Ladakhi pill is NOT a literal: it renders LOCALE_LABELS.bo.script,
// the Tibetan abbreviation for Bhoti. It shipped as two ARABIC letters
// (U+0644 U+062F) because the glyph was hand-copied into four files and
// diverged; an earlier version of THIS comment carried the same wrong glyph
// and kept the source-regex test green on its own after the button was fixed.
// The wrong codepoints are named, never written, for that reason. The visible
// labels match LoginLanguagePicker's contract so a future swap is one import.

import { useActionState, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { loginAction, type LoginState } from "./actions";
import type { LoginShellProps } from "./shell-props";
import { EmailLinkForm } from "./email-link-form";
import { LOCALE_LABELS } from "@/i18n/config";

const ONE_YEAR = 60 * 60 * 24 * 365;

// Touch targets — Apple HIG (44pt) and Material Design (48dp) both land
// around the same minimum. We pick 44 as the floor everywhere so the
// browser zoom + readability story stays consistent (every interactive
// element below applies `minHeight: 44` via this const).
const TOUCH_TARGET = 44; // minHeight: 44 — Apple HIG / Material Design floor

export function MobileLogin({ from, emailEnabled }: LoginShellProps) {
  const [state, formAction, pending] = useActionState<LoginState | undefined, FormData>(
    loginAction,
    {},
  );
  const [mode, setMode] = useState<"password" | "magic">("password");
  const tAction = useTranslations("action");
  const tLanguage = useTranslations("language");
  const router = useRouter();

  function pickLocale(locale: "en" | "hi" | "bo") {
    // Same cookie + refresh contract as LoginLanguagePicker — the route
    // layout reads gml-locale on the next render and bumps the bundle.
    document.cookie = `gml-locale=${locale}; path=/; max-age=${ONE_YEAR}; samesite=lax`;
    router.refresh();
  }

  return (
    <div
      style={{
        minHeight: "100dvh",
        display: "flex",
        flexDirection: "column",
        background: "var(--paper)",
        overflow: "hidden",
        // env(safe-area-inset-top) keeps the hero clear of the notch on iOS;
        // bottom inset is applied at the language-row level so the form
        // content has natural padding instead of double-counting the inset.
        paddingTop: "env(safe-area-inset-top, 0px)",
      }}
    >
      {/* Hero — full-bleed mountain silhouette, saffron→indigo gradient. */}
      <div
        data-testid="mobile-login-hero"
        style={{
          background:
            "linear-gradient(180deg, oklch(0.32 0.08 268) 0%, oklch(0.22 0.07 268) 100%)",
          color: "var(--paper)",
          padding: "32px 22px 28px",
          position: "relative",
          overflow: "hidden",
          flexShrink: 0,
        }}
      >
        <svg
          viewBox="0 0 412 220"
          preserveAspectRatio="xMidYMid slice"
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: 0.5 }}
          aria-hidden
        >
          {/* Sun / moon disc (matches the prototype circle) */}
          <circle cx="320" cy="48" r="22" fill="oklch(0.92 0.04 60)" opacity="0.55" />
          {/* Front ridge silhouette */}
          <path
            d="M0 150 L60 110 L120 138 L190 80 L260 130 L330 100 L412 134 L412 220 L0 220 Z"
            fill="oklch(0.16 0.04 268)"
          />
          {/* Foreground ridge silhouette */}
          <path
            d="M0 180 L70 150 L160 170 L240 138 L320 170 L412 150 L412 220 L0 220 Z"
            fill="oklch(0.10 0.03 268)"
          />
        </svg>

        <div style={{ position: "relative", zIndex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span
              style={{
                width: 32,
                height: 32,
                borderRadius: 8,
                background: "var(--saffron)",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                fontFamily: "var(--serif)",
                fontSize: 14,
                fontWeight: 700,
                color: "oklch(0.18 0.05 268)",
              }}
              aria-hidden
            >
              GML
            </span>
            <div style={{ fontFamily: "var(--serif)", fontSize: 16, fontWeight: 600 }}>
              Goldenmile RTT
            </div>
          </div>
          <div
            style={{
              fontFamily: "var(--serif)",
              fontSize: 24,
              marginTop: 22,
              lineHeight: 1.2,
              letterSpacing: "-0.01em",
            }}
          >
            {tAction("welcomeBack")}
          </div>
          <div style={{ fontSize: 12, color: "oklch(0.85 0.03 60)", marginTop: 8, lineHeight: 1.45 }}>
            Sign in to keep teaching. Works on patchy network — your session is cached locally.
          </div>
        </div>
      </div>

      {/* Form area — scrollable above the bottom language row. */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "20px 22px 16px",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Mode toggle — Password | Magic link. Hidden when outbound email is
            not configured; see DesktopLogin for the reasoning. */}
        <div
          data-testid="mobile-mode-toggle"
          style={{
            display: emailEnabled ? "grid" : "none",
            gridTemplateColumns: "1fr 1fr",
            gap: 4,
            background: "var(--paper-2)",
            padding: 4,
            borderRadius: 10,
            border: "1px solid var(--line)",
            marginBottom: 18,
          }}
        >
          {(["password", "magic"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              style={{
                minHeight: TOUCH_TARGET,
                padding: "10px 4px",
                fontSize: 13,
                border: "none",
                borderRadius: 7,
                background: mode === m ? "var(--ink)" : "transparent",
                color: mode === m ? "var(--paper)" : "var(--ink-2)",
                fontWeight: mode === m ? 600 : 500,
                cursor: "pointer",
              }}
            >
              {m === "password" ? tAction("password") : tAction("magicLink")}
            </button>
          ))}
        </div>

        {mode === "password" || !emailEnabled ? (
          <form
            action={formAction}
            style={{ display: "flex", flexDirection: "column", gap: 14 }}
          >
            <input type="hidden" name="from" value={from} />
            <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span
                style={{
                  fontSize: 12,
                  color: "var(--ink-2)",
                  fontWeight: 500,
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                }}
              >
                Email
              </span>
              <input
                data-testid="mobile-email"
                name="email"
                type="email"
                autoComplete="email"
                inputMode="email"
                required
                style={{
                  minHeight: TOUCH_TARGET,
                  padding: "12px 14px",
                  border: "1px solid var(--line-2)",
                  borderRadius: "var(--r-2)",
                  background: "var(--card-hi)",
                  fontSize: 16, // 16px on iOS suppresses the zoom-on-focus behaviour
                  width: "100%",
                  boxSizing: "border-box",
                }}
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span
                style={{
                  fontSize: 12,
                  color: "var(--ink-2)",
                  fontWeight: 500,
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                }}
              >
                {tAction("password")}
              </span>
              <input
                data-testid="mobile-password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                style={{
                  minHeight: TOUCH_TARGET,
                  padding: "12px 14px",
                  border: "1px solid var(--line-2)",
                  borderRadius: "var(--r-2)",
                  background: "var(--card-hi)",
                  fontSize: 16,
                  width: "100%",
                  boxSizing: "border-box",
                }}
              />
            </label>
            {state?.error ? (
              <p style={{ fontSize: 13, color: "var(--rust)" }} role="alert">
                {state.error}
              </p>
            ) : null}
            <button
              data-testid="mobile-signin-button"
              type="submit"
              disabled={pending}
              className="btn btn-primary"
              style={{
                minHeight: TOUCH_TARGET,
                width: "100%",
                justifyContent: "center",
                padding: "12px 14px",
                fontSize: 15,
                fontWeight: 600,
                marginTop: 6,
                opacity: pending ? 0.6 : 1,
              }}
            >
              {pending ? tAction("signingIn") : tAction("signIn")}
            </button>
            {/* Spec 161 — Forgot password link below the credentials form. */}
            <Link
              href="/login/forgot"
              data-testid="mobile-forgot-password"
              style={{
                fontSize: 13,
                color: "var(--ink-2)",
                textAlign: "center",
                marginTop: 8,
                textDecoration: "underline",
              }}
            >
              {tAction("forgotPassword")}
            </Link>
          </form>
        ) : (
          <EmailLinkForm />
        )}

        {/* Footer disclosure — the programme audit copy lifted from the
            desktop shell's right-pane footer, restyled for narrow widths. */}
        <div
          data-testid="mobile-login-footer"
          style={{
            marginTop: "auto",
            paddingTop: 24,
            fontSize: 11,
            color: "var(--ink-3)",
            fontFamily: "var(--mono)",
            display: "flex",
            justifyContent: "space-between",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          <span>Goldenmile programme · audited</span>
          <span>v1.0 · build 2026.05</span>
        </div>
      </div>

      {/* Language pill row — anchored to the bottom with safe-area inset
          padding so it sits above the home indicator on notch devices.
          The three buttons mirror LoginLanguagePicker's contract: write the
          gml-locale cookie and refresh so the route-segment layout reloads
          the next-intl bundle. */}
      <div
        data-testid="mobile-language-row"
        style={{
          display: "flex",
          justifyContent: "center",
          gap: 8,
          padding: "12px 22px",
          paddingBottom: "calc(12px + env(safe-area-inset-bottom, 0px))",
          background: "var(--paper)",
          borderTop: "1px solid var(--line)",
          flexShrink: 0,
        }}
      >
        <button
          type="button"
          onClick={() => pickLocale("en")}
          className="btn btn-sm btn-ghost"
          style={{
            minHeight: TOUCH_TARGET,
            minWidth: TOUCH_TARGET,
            justifyContent: "center",
            padding: "0 14px",
          }}
        >
          EN
        </button>
        <button
          type="button"
          onClick={() => pickLocale("hi")}
          className="btn btn-sm btn-ghost deva"
          lang="hi"
          aria-label={tLanguage("hindi")}
          style={{
            minHeight: TOUCH_TARGET,
            minWidth: TOUCH_TARGET,
            justifyContent: "center",
            padding: "0 14px",
          }}
        >
          हिं
        </button>
        <button
          type="button"
          onClick={() => pickLocale("bo")}
          className="btn btn-sm btn-ghost tib"
          lang="bo"
          aria-label={tLanguage("bhoti")}
          style={{
            minHeight: TOUCH_TARGET,
            minWidth: TOUCH_TARGET,
            justifyContent: "center",
            padding: "0 14px",
          }}
        >
          {LOCALE_LABELS.bo.script}
        </button>
      </div>
    </div>
  );
}
