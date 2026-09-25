"use client";

// Settings form — 4 sections (Display / Privacy / Language / Account) backed by
// the locked `user_prefs` schema. Save-on-change with 400ms debounce (the
// language is saved on the tap; see pickLanguage); only the *delta* (changed
// fields since initial load) is PUT to `/api/user-prefs`, which keeps the audit
// log readable (the API records a `user_prefs.update` row with a `keys`
// metadata array per spec 024).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { SignOutButton } from "@/components/nav/SignOutButton";
import { signOutAction } from "./actions";
import { ChangePasswordForm } from "./ChangePasswordForm";

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

/** Preferences the layouts render (lang, strings, body classes): a save must re-render them. */
const RENDERED_BY_LAYOUT: ReadonlyArray<keyof SettingsFormValues> = ["uiLanguage", "highContrast", "reducedMotion"];

export function SettingsForm({ initial, email, roleLabel, roleChipKind }: Props) {
  const router = useRouter();
  const [values, setValues] = useState<SettingsFormValues>(initial);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const baselineRef = useRef<SettingsFormValues>(initial);
  // The values most recently handed to flush(). The debounce compares against
  // these rather than the saved baseline, so a save already on its way (the
  // language, sent on the tap) is not sent a second time 400ms later.
  const sentRef = useRef<SettingsFormValues>(initial);
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
    sentRef.current = next;
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
      // The menus, tabs and skip link are rendered by the shared
      // (authenticated) layout, which the App Router never re-renders on a
      // soft navigation. Without this the chrome kept the old language on
      // every page until a hard reload, under a "Saved" badge. refresh()
      // re-renders the server tree in place, root layout (<html lang>)
      // included, and fetches no document. The same for the Display
      // switches, whose body classes that root layout renders.
      if (RENDERED_BY_LAYOUT.some((k) => k in delta)) router.refresh();
      // Auto-clear the "Saved" pill after 1.6s so the form looks idle again.
      setTimeout(() => {
        setSaveState((s) => (s === "saved" ? "idle" : s));
      }, 1600);
    } catch (err) {
      if ((err as Error).name === "AbortError") return; // superseded — silent
      sentRef.current = baselineRef.current;
      setSaveState("error");
      setErrorMsg((err as Error).message || "Could not save");
    }
  }, [router]);

  // The language is saved on the tap, not after the debounce. On a phone this
  // is the only language control, and the next thing a user does is tap a tab
  // to see the result: that unmounted the form inside the 400ms window, the
  // effect cleanup cancelled the timer, and the choice was silently lost.
  const pickLanguage = (code: UiLanguage) => {
    const next = { ...values, uiLanguage: code };
    setValues(next);
    if (timerRef.current) clearTimeout(timerRef.current);
    void flush(next);
  };

  // Debounced save effect — runs 400ms after the last change.
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    // Skip the no-op on first mount (values === initial), and anything
    // already sent.
    const isDirty = Object.keys(computeDelta(sentRef.current, values)).length > 0;
    if (!isDirty) return;
    timerRef.current = setTimeout(() => {
      void flush(values);
    }, 400);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [values, flush]);

  // That cleanup also runs on unmount, so a change made just before tapping a
  // tab was cancelled with its timer and never saved. Send whatever is still
  // unsent on the way out; keepalive lets the request outlive the page.
  const latestRef = useRef(values);
  useEffect(() => {
    latestRef.current = values;
  }, [values]);
  useEffect(
    () => () => {
      const latest = latestRef.current;
      if (Object.keys(computeDelta(sentRef.current, latest)).length === 0) return;
      void fetch("/api/user-prefs", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(computeDelta(baselineRef.current, latest)),
        keepalive: true,
      }).catch(() => undefined);
    },
    [],
  );

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
        {/* ONLY WHAT TAKES EFFECT. Density and Text size were here and saved
            without changing anything: there are no density rules at all, and
            nearly every size in the app is an inline px value a body
            font-size cannot reach (CSS zoom can, but it also multiplies the
            vw/vh sizes the help panel, QuickFind and the upload modal use,
            pushing them off a phone's screen). The columns stay; the controls
            come back when the sizes are rem-based. Until then, say what does
            work. */}
        <div style={{ fontSize: 12, color: "var(--ink-3)", marginBottom: 10, lineHeight: 1.5 }}>
          For larger text, use your browser&apos;s zoom: Ctrl and + on a computer, or pinch on a phone.
        </div>
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
        {/* Was a "Watermark videos with my name" switch that the player never
            read -- it always draws the overlay. Stated rather than offered:
            honouring it would let a viewer remove the viewer-identifying
            overlay (SM-4) just before recording the screen. */}
        <div data-testid="watermark-always-on" style={{ padding: "10px 0" }}>
          <div style={{ fontSize: 13, color: "var(--ink)" }}>Videos are watermarked with your name</div>
          <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2, lineHeight: 1.4 }}>
            Always on, for every viewer. It identifies who was watching if a recording of the screen is shared.
          </div>
        </div>
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
          All session footage is confidential and downloads are disabled at the player level.
        </div>
      </SectionCard>

      <SectionCard title="Language">
        <div style={{ fontSize: 12, color: "var(--ink-3)", marginBottom: 10 }}>
          Used for UI labels and notifications. Content (lesson titles, observation notes) is not auto-translated.
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <LangPill active={values.uiLanguage === "en"} onClick={() => pickLanguage("en")}>
            English
          </LangPill>
          <LangPill active={values.uiLanguage === "hi"} onClick={() => pickLanguage("hi")}>
            <span style={{ fontFamily: "var(--deva)" }} lang="hi">हिन्दी</span>
          </LangPill>
          <LangPill active={values.uiLanguage === "bo"} onClick={() => pickLanguage("bo")}>
            <span className="tib" lang="bo">བོད་ཡིག</span>
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
          {/* Was an <a href="/account/security"> — a route that has never
              existed. With self-service reset off until IT configures SMTP,
              this is the ONLY way a user can change the password an
              administrator chose for them. */}
          <ChangePasswordForm />
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
