"use client";

// Spec 123 — FTUX (first-time user experience) coach-marks.
//
// 1:1 port of LMS GML Frontend/help.jsx::FTUXTour (lines 489-573) + the
// FTUX_TOURS role map (lines 463-485). The prototype keyed completion in
// localStorage; the live app keys it server-side via user_prefs.ftux_seen_at
// (already on packages/db/src/schema/prefs.ts, so no migration is needed
// for this spec) — that survives across devices and sign-outs and remains a
// single source of truth alongside the rest of the Tweaks-Panel prefs.
//
// Lifecycle:
//   1. (authenticated)/layout.tsx fetches user_prefs.ftuxSeenAt server-side
//      and passes it (possibly null) + the user's role into this component.
//   2. If ftuxSeenAt is null we mount; otherwise we render nothing.
//   3. The Settings page exposes a "Replay tour" link that PUTs {ftuxSeenAt:
//      null}, then full-reloads — that re-arms this component on next paint.
//   4. Skip / Got it both PUT {ftuxSeenAt: new Date().toISOString()} and
//      then hide the overlay locally so the user doesn't need a refresh.
//
// Selectors used by each step's `target` field come from the prototype's
// FTUX_TOURS map verbatim (e.g. `[data-help-anchor='nav-mentorship']`).
// Sidebar.tsx emits `data-help-anchor={`nav-${item.id}`}` for every nav row,
// and Topbar.tsx tags its bell button with `data-help-anchor='topbar-help'`,
// so every selector in this file is guaranteed to resolve on the desktop
// shell. On mobile, the BottomTabs use a different id space — those selectors
// will simply not match, the ring will not paint, and the caption sticks to
// its default {top:100,left:100} position (matching the prototype's fallback
// at help.jsx line 524). We accept this on mobile — the FTUX is a desktop
// pedagogical layer; mobile users see the tour caption but no spotlight.

import { useEffect, useRef, useState } from "react";

type Role = "super_admin" | "programme_admin" | "mentor" | "observer" | "teacher";

type Step = {
  target: string;
  title: string;
  body: string;
};

// FTUX_TOURS map — verbatim from help.jsx::FTUX_TOURS. Five steps per persona
// (selecting the *right* persona is more important than padding to six — the
// prototype settled on a 4–5 length to keep the overlay finishable in under
// 90 seconds). super_admin maps onto programme_admin, observer onto mentor.
const FTUX_TOURS: Record<Role, Step[]> = {
  mentor: [
    {
      target: "[data-help-anchor='nav-mentorship']",
      title: "Your mentees live here",
      body:
        "Up to five teachers you guide. Tap to see how each one is progressing through their four quarterly check-ins.",
    },
    {
      target: "[data-help-anchor='nav-observation']",
      title: "Observation cycles",
      body:
        "Every time you watch a lesson — live or by video — it's a cycle. Five steps: pre-form, observe, video, post-form, sign-off.",
    },
    {
      target: "[data-help-anchor='nav-videos']",
      title: "Pending video reviews",
      body:
        "Teachers upload their lessons. Aim to give written feedback within 48 hours.",
    },
    {
      target: "[data-help-anchor='nav-repo']",
      title: "The repository",
      body:
        "Everything about every school, class, subject, lesson and reading material. Searchable. Browse it like a library.",
    },
    {
      target: "[data-help-anchor='topbar-help']",
      title: "Help is always here",
      body:
        "Hover the dotted-underline words anywhere. Tap the ⓘ icons. Or press ? on your keyboard to open this panel.",
    },
  ],
  teacher: [
    {
      target: "[data-help-anchor='nav-rtt']",
      title: "Your current phase",
      body:
        "You're in Phase 2 — Application. Modules, lessons, readings and your cohort sessions all live here.",
    },
    {
      target: "[data-help-anchor='nav-observation']",
      title: "Your observations",
      body:
        "Each cycle starts with a small Pre-form, then your lesson is watched (or you upload a video), then your mentor writes feedback.",
    },
    {
      target: "[data-help-anchor='nav-uploads']",
      title: "Send a lesson video",
      body:
        "Forward it via WhatsApp (easiest on slow networks) or upload here. Resumes if your connection drops.",
    },
    {
      target: "[data-help-anchor='topbar-help']",
      title: "Help is always here",
      body:
        "Hover any underlined word for a short explanation. Tap ⓘ icons for more. Press ? on your keyboard any time.",
    },
  ],
  programme_admin: [
    {
      target: "[data-help-anchor='nav-repo']",
      title: "Repository = your records",
      body:
        "Schools, classes, subjects, teachers, sessions, reading material. Everything cross-linked. Start here for any look-up.",
    },
    {
      target: "[data-help-anchor='nav-tbl-teachers']",
      title: "Operational tables",
      body:
        "Add or update teachers, schools and pairings. Every change is logged.",
    },
    {
      target: "[data-help-anchor='nav-audit']",
      title: "Audit log",
      body:
        "Every action — logins, uploads, gate attempts — is recorded here. Read-only, kept for seven years.",
    },
    {
      target: "[data-help-anchor='topbar-help']",
      title: "Help is always here",
      body:
        "Press ? any time to open the help panel. Or hover any dotted-underline word for a quick explanation.",
    },
  ],
  // help.jsx::FTUX_TOURS.super_admin = FTUX_TOURS.programme_admin
  super_admin: [],
  // help.jsx::FTUX_TOURS.observer = FTUX_TOURS.mentor
  observer: [],
};
// Mirror the prototype's role aliasing (see help.jsx lines 484-485).
FTUX_TOURS.super_admin = FTUX_TOURS.programme_admin;
FTUX_TOURS.observer = FTUX_TOURS.mentor;

type FTUXTourProps = {
  role: Role;
  /** ISO timestamp string when the user finished or skipped the tour. Null
   * means the FTUX has never been seen and the overlay should mount. */
  ftuxSeenAt: string | null;
};

type Rect = { left: number; top: number; width: number; height: number };

export function FTUXTour({ role, ftuxSeenAt }: FTUXTourProps) {
  const steps = FTUX_TOURS[role] ?? [];
  const [dismissed, setDismissed] = useState<boolean>(Boolean(ftuxSeenAt));
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  // Guard the PUT — we only want a single fire-and-forget save per
  // skip/finish. Otherwise rapid double-clicks would emit two audit rows.
  const savedRef = useRef(false);

  // Recompute the spotlight rect whenever the step changes, and on scroll +
  // resize. Pure 1:1 port of help.jsx lines 494-510, but typed.
  useEffect(() => {
    if (dismissed) return;
    const step = steps[i];
    if (!step) return;
    const place = () => {
      const el = document.querySelector(step.target);
      if (!el) {
        setRect(null);
        return;
      }
      const r = (el as Element).getBoundingClientRect();
      setRect({ left: r.left, top: r.top, width: r.width, height: r.height });
    };
    place();
    window.addEventListener("resize", place);
    // capture-phase scroll so nested scrollers also retarget the ring
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [i, steps, dismissed]);

  // Persist completion to user_prefs.ftux_seen_at. Best-effort: if the PUT
  // fails (offline, 5xx) we still hide locally so the user is never stuck on
  // the overlay. The next login will re-arm — acceptable.
  const finish = async () => {
    if (savedRef.current) return;
    savedRef.current = true;
    setDismissed(true);
    try {
      await fetch("/api/user-prefs", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ftuxSeenAt: new Date().toISOString() }),
      });
    } catch {
      // swallow — local dismissal is enough for this session
    }
  };

  if (dismissed) return null;
  if (!steps.length) return null;
  const step = steps[i];
  if (!step) return null;
  const lastStep = i === steps.length - 1;

  // Caption placement — same clamping rules as help.jsx lines 521-524.
  // Falls back to {top:100,left:100} when the target selector misses.
  const captionPos = rect
    ? {
        top: Math.min(rect.top + rect.height + 12, window.innerHeight - 220),
        left: Math.min(Math.max(12, rect.left), window.innerWidth - 380),
      }
    : { top: 100, left: 100 };

  return (
    <div className="ftux-root" role="dialog" aria-label="Product tour" aria-modal="true">
      {/* Backdrop with rect cutout — keeps the spotlit element brightly lit
          while dimming the rest of the page. */}
      <svg className="ftux-backdrop" width="100%" height="100%" aria-hidden="true">
        <defs>
          <mask id="ftux-cut">
            <rect width="100%" height="100%" fill="white" />
            {rect && (
              <rect
                x={rect.left - 6}
                y={rect.top - 6}
                width={rect.width + 12}
                height={rect.height + 12}
                rx={8}
                fill="black"
              />
            )}
          </mask>
        </defs>
        <rect width="100%" height="100%" fill="rgba(28,24,22,0.62)" mask="url(#ftux-cut)" />
      </svg>

      {/* Pulsing ring around the target — fires the @keyframes ftux-pulse */}
      {rect && (
        <div
          className="ftux-ring"
          style={{
            left: rect.left - 6,
            top: rect.top - 6,
            width: rect.width + 12,
            height: rect.height + 12,
          }}
          aria-hidden="true"
        />
      )}

      {/* Caption card — 360px wide; Next / Back / Skip controls */}
      <div className="ftux-caption" style={captionPos}>
        <div className="label" style={{ paddingLeft: 0, paddingTop: 0 }}>
          Tour · step {i + 1} of {steps.length}
        </div>
        <h3
          style={{
            fontFamily: "var(--serif)",
            fontSize: 18,
            margin: "2px 0 6px",
            letterSpacing: "-0.01em",
          }}
        >
          {step.title}
        </h3>
        <p style={{ fontSize: 13.5, lineHeight: 1.55, color: "var(--ink-2)" }}>{step.body}</p>
        <div className="ftux-dots" aria-hidden="true">
          {steps.map((_, n) => (
            <span key={n} className={`ftux-dot ${n === i ? "on" : ""}`} />
          ))}
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <button type="button" className="btn btn-sm" onClick={finish}>
            Skip tour
          </button>
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            {i > 0 && (
              <button type="button" className="btn btn-sm" onClick={() => setI((n) => n - 1)}>
                ← Back
              </button>
            )}
            {lastStep ? (
              <button type="button" className="btn btn-primary btn-sm" onClick={finish}>
                Got it
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => setI((n) => n + 1)}
              >
                Next →
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
