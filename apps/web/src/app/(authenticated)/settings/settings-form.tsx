"use client";

// Settings form — 4 sections (Display / Privacy / Language / Account) backed by
// the locked `user_prefs` schema. Save-on-change with 400ms debounce; only the
// *delta* (changed fields since initial load) is PUT to `/api/user-prefs`, which
// keeps the audit log readable (the API records a `user_prefs.update` row with a
// `keys` metadata array per spec 024).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SignOutButton } from "@/components/nav/SignOutButton";
import { signOutAction } from "./actions";

export type Density = "dense" | "regular" | "loose";
export type FontScale = "regular" | "large" | "xlarge";
export type UiLanguage = "en" | "hi" | "bo";

export type SettingsFormValues = {
  density: Density;
  fontScale: FontScale;
  highContrast: boolean;
  reducedMotion: boolean;
  showWatermark: boolean;
  uiLanguage: UiLanguage;
};

type SaveState = "idle" | "saving" | "saved" | "error";

type Props = {
  initial: SettingsFormValues;
  email: string;
  roleLabel: string;
  /** chip variant class — e.g. "chip-saffron", "chip-indigo". Empty string falls back to neutral .chip. */
  roleChipKind: string;
};

// Compute the subset of `current` whose values differ from `baseline`. Keeps
// the audit log uncluttered: only edited fields get persisted on each PUT.
function computeDelta(baseline: SettingsFormValues, current: SettingsFormValues): Partial<SettingsFormValues> {
  const delta: Partial<SettingsFormValues> = {};
  (Object.keys(current) as (keyof SettingsFormValues)[]).forEach((k) => {
    if (current[k] !== baseline[k]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (delta as any)[k] = current[k];
    }
  });
  return delta;
}

export function SettingsForm({ initial, email, roleLabel, roleChipKind }: Props) {
  const [values, setValues] = useState<SettingsFormValues>(initial);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const baselineRef = useRef<SettingsFormValues>(initial);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = useRef<AbortController | null>(null);

  const flush = useCallback(async (next: SettingsFormValues) => {
    const delta = computeDelta(baselineRef.current, next);
    if (Object.keys(delta).length === 0) {
      setSaveState("idle");
      return;
    }
    // Cancel any in-flight request — the latest values supersede earlier ones.
    if (inFlightRef.current) inFlightRef.current.abort();
    const ctrl = new AbortController();
    inFlightRef.current = ctrl;
    setSaveState("saving");
    setErrorMsg(null);
    try {
      const res = await fetch("/api/user-prefs", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(delta),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({ error: "save_failed" }))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      baselineRef.current = next;
      setSaveState("saved");
      // Auto-clear the "Saved" pill after 1.6s so the form looks idle again.
      setTimeout(() => {
        setSaveState((s) => (s === "saved" ? "idle" : s));
      }, 1600);
    } catch (err) {
      if ((err as Error).name === "AbortError") return; // superseded — silent
      setSaveState("error");
      setErrorMsg((err as Error).message || "Could not save");
    }
  }, []);

  // Debounced save effect — runs 400ms after the last change.
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    // Skip the no-op on first mount (values === initial).
    const isDirty = Object.keys(computeDelta(baselineRef.current, values)).length > 0;
    if (!isDirty) return;
    timerRef.current = setTimeout(() => {
      void flush(values);
    }, 400);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [values, flush]);

  const set = useCallback(<K extends keyof SettingsFormValues>(key: K, value: SettingsFormValues[K]) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  }, []);

  const saveBadge = useMemo(() => {
    if (saveState === "saving") {
      return (
        <span style={{ fontSize: 11, color: "var(--ink-3)" }} aria-live="polite">
          Saving…
        </span>
      );
    }
    if (saveState === "saved") {
      return (
        <span className="chip chip-lichen" aria-live="polite" role="status">
          Saved
        </span>
      );
    }
    if (saveState === "error") {
      return (
        <span className="chip chip-rust" role="alert">
          {errorMsg ?? "Save failed"}
        </span>
      );
    }
    return null;
  }, [saveState, errorMsg]);

  return (
    <>
      <SectionCard title="Display" badge={saveBadge}>
        <SegmentRow
          label="Density"
          value={values.density}
          options={[
            { v: "dense", label: "Dense" },
            { v: "regular", label: "Regular" },
            { v: "loose", label: "Loose" },
          ]}
          onChange={(v) => set("density", v as Density)}
        />
        <SegmentRow
          label="Text size"
          value={values.fontScale}
          options={[
            { v: "regular", label: "Regular" },
            { v: "large", label: "Large" },
            { v: "xlarge", label: "Extra large" },
          ]}
          onChange={(v) => set("fontScale", v as FontScale)}
        />
        <ToggleRow
          label="High contrast"
          hint="Deepens ink + line tokens; easier in bright light."
          value={values.highContrast}
          onChange={(v) => set("highContrast", v)}
        />
        <ToggleRow
          label="Reduced motion"
          hint="Disables transitions + animated pills."
          value={values.reducedMotion}
          onChange={(v) => set("reducedMotion", v)}
        />
      </SectionCard>

      <SectionCard title="Privacy">
        <ToggleRow
          label="Watermark videos with my name"
          hint="Recommended. Renders at 30% opacity over every rendition; turning this off only affects YOUR playback overlay."
          value={values.showWatermark}
          onChange={(v) => set("showWatermark", v)}
        />
        <div
          style={{
            marginTop: 14,
            padding: 12,
            background: "var(--paper-2)",
            borderRadius: "var(--r-2)",
            fontSize: 11,
            color: "var(--ink-3)",
            lineHeight: 1.5,
          }}
        >
          All session footage is confidential and downloads are disabled at the player level. Your changes here do not
          affect other viewers&apos; overlays.
        </div>
      </SectionCard>

      <SectionCard title="Language">
        <div style={{ fontSize: 12, color: "var(--ink-3)", marginBottom: 10 }}>
          Used for UI labels and notifications. Content (lesson titles, observation notes) is not auto-translated.
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <LangPill active={values.uiLanguage === "en"} onClick={() => set("uiLanguage", "en")}>
            English
          </LangPill>
          <LangPill active={values.uiLanguage === "hi"} onClick={() => set("uiLanguage", "hi")}>
            <span style={{ fontFamily: "var(--deva)" }}>हिन्दी</span>
          </LangPill>
          <LangPill active={values.uiLanguage === "bo"} onClick={() => set("uiLanguage", "bo")}>
            བོད་ཡིག
          </LangPill>
        </div>
      </SectionCard>

      <SectionCard title="Account">
        <KvRow label="Email">
          <span className="mono" style={{ fontSize: 12 }}>{email}</span>
        </KvRow>
        <KvRow label="Role">
          <span
            className={`chip${roleChipKind ? ` ${roleChipKind}` : ""}`}
            style={{ textTransform: "capitalize" }}
          >
            {roleLabel}
          </span>
        </KvRow>
        <KvRow label="Password">
          <a href="/account/security" style={{ color: "var(--indigo)", fontSize: 12, textDecoration: "none" }}>
            Change on security page →
          </a>
        </KvRow>
        <KvRow label="Replay tour">
          <ReplayTourButton />
        </KvRow>
        <KvRow label="Sign out">
          <form action={signOutAction}>
            {/* Same submit path as the Topbar, so the QuickFind-recents wipe
                in SignOutButton runs here too. Previously this surface used a
                bare <a href="/api/auth/signout">, which skipped that cleanup
                and left the previous user's recents on the device. */}
            <SignOutButton
              style={{
                color: "var(--rust)",
                fontSize: 12,
                background: "none",
                border: "none",
                padding: 0,
                cursor: "pointer",
              }}
            >
              End this session →
            </SignOutButton>
          </form>
        </KvRow>
      </SectionCard>
    </>
  );
}

// Spec 123 — "Replay tour" PUTs {ftuxSeenAt: null} into /api/user-prefs and
// then reloads the page so the (authenticated)/layout.tsx server component
// reads the cleared timestamp and re-mounts <FTUXTour>. The reload is the
// simplest way to re-arm the overlay without bubbling client state up out of
// a deep tree; FTUX is a once-a-quarter affordance so the page hit is
// acceptable.
function ReplayTourButton() {
  const [state, setState] = useState<"idle" | "saving" | "error">("idle");
  const replay = async () => {
    setState("saving");
    try {
      const res = await fetch("/api/user-prefs", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ftuxSeenAt: null }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Full reload so the layout's server-side user_prefs read picks up the
      // cleared timestamp and re-mounts the FTUXTour overlay.
      window.location.reload();
    } catch {
      setState("error");
    }
  };
  return (
    <button
      type="button"
      onClick={replay}
      disabled={state === "saving"}
      style={{
        background: "transparent",
        border: "none",
        padding: 0,
        color: state === "error" ? "var(--rust)" : "var(--indigo)",
        fontSize: 12,
        cursor: state === "saving" ? "wait" : "pointer",
        textDecoration: "none",
      }}
    >
      {state === "saving" ? "Re-arming…" : state === "error" ? "Failed — retry" : "Replay tour →"}
    </button>
  );
}

// ---------- internal building blocks ----------

function SectionCard({
  title,
  children,
  badge,
}: {
  title: string;
  children: React.ReactNode;
  badge?: React.ReactNode;
}) {
  return (
    <article className="card card-hi" style={{ overflow: "hidden" }}>
      <header
        style={{
          padding: "12px 16px",
          borderBottom: "1px solid var(--line)",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <h2 className="serif" style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>{title}</h2>
        {badge ? <span style={{ marginLeft: "auto" }}>{badge}</span> : null}
      </header>
      <div style={{ padding: 16 }}>{children}</div>
    </article>
  );
}

function SegmentRow({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { v: string; label: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 12, color: "var(--ink-3)", marginBottom: 6 }}>{label}</div>
      <div
        role="radiogroup"
        aria-label={label}
        style={{
          display: "inline-flex",
          border: "1px solid var(--line)",
          borderRadius: "var(--r-2)",
          overflow: "hidden",
          background: "var(--paper)",
        }}
      >
        {options.map((o, i) => {
          const active = value === o.v;
          return (
            <button
              key={o.v}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onChange(o.v)}
              style={{
                padding: "6px 12px",
                fontSize: 12,
                background: active ? "var(--ink)" : "transparent",
                color: active ? "var(--paper)" : "var(--ink-2)",
                border: "none",
                borderLeft: i === 0 ? "none" : "1px solid var(--line)",
                cursor: "pointer",
                fontFamily: "var(--sans)",
              }}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ToggleRow({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        padding: "10px 0",
        borderTop: "1px solid var(--line)",
        gap: 12,
      }}
    >
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, color: "var(--ink)" }}>{label}</div>
        {hint ? (
          <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2, lineHeight: 1.4 }}>{hint}</div>
        ) : null}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={value}
        aria-label={label}
        onClick={() => onChange(!value)}
        style={{
          width: 36,
          height: 20,
          borderRadius: 99,
          background: value ? "var(--ink)" : "var(--paper-3)",
          position: "relative",
          border: "none",
          padding: 0,
          cursor: "pointer",
          flexShrink: 0,
          transition: "background 0.15s",
        }}
      >
        <span
          style={{
            position: "absolute",
            top: 2,
            left: value ? 18 : 2,
            width: 16,
            height: 16,
            borderRadius: "50%",
            background: "var(--card-hi)",
            transition: "left 0.15s",
          }}
        />
      </button>
    </div>
  );
}

function LangPill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      style={{
        padding: "8px 14px",
        fontSize: 13,
        background: active ? "var(--ink)" : "var(--paper)",
        color: active ? "var(--paper)" : "var(--ink-2)",
        border: `1px solid ${active ? "var(--ink)" : "var(--line)"}`,
        borderRadius: "var(--r-2)",
        cursor: "pointer",
        fontFamily: "var(--sans)",
      }}
    >
      {children}
    </button>
  );
}

function KvRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        padding: "8px 0",
        borderTop: "1px solid var(--line)",
        gap: 12,
      }}
    >
      <div style={{ fontSize: 12, color: "var(--ink-3)", minWidth: 90 }}>{label}</div>
      <div style={{ marginLeft: "auto" }}>{children}</div>
    </div>
  );
}
