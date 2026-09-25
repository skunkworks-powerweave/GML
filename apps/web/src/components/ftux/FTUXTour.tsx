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
// and Topbar.tsx tags its help button with `data-help-anchor='topbar-help'`
// (the mobile ? FAB carries the same anchor), so every selector in this file
// resolves on the desktop shell. The anchor used to sit on the notifications
// bell, so "Help is always here" spotlit the inbox link. On a phone there is
// no sidebar: BottomTabs puts the same nav-* anchor on each tab that leads
// where a sidebar item does, so the steps for those spotlight the tab, and a
// step with no tab (a mentor's "Pending video reviews") shows its caption as
// a sheet with no ring. See captionPosition for why the caption used to be
// unusable on a phone.

import { useEffect, useMemo, useRef, useState } from "react";

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
// Exported for tests/behaviour/ui-navigation.test.ts, which checks that the
// copy promises only help affordances that exist.
export const FTUX_TOURS: Record<Role, Step[]> = {
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
        // Rewritten: it promised dotted-underline words and ⓘ icons, and no
        // page renders either. The ? button is what ships.
        "Tap the ? button to look up any term or message the programme team. It sits here on a computer and at the bottom right on a phone. On a keyboard, ? opens it too.",
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
        "Stuck on a word or a step? Tap the ? button — here on a computer, bottom right on your phone — to look it up or to message the programme team.",
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
        "Press ? any time, or use this ? button, to open the help panel: every term explained, plus the helpdesk contacts.",
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

/** .ftux-caption's design width, and the gap kept from every screen edge. */
const CAPTION_WIDTH = 360;
const EDGE = 12;
/** A caption's usual height: the label, a title, three lines, the buttons. */
const CAPTION_HEIGHT = 220;
/** Kept clear under a target-less caption: the phone's bottom tab bar. */
const TAB_BAR = 76;

/**
 * Where the caption goes, for a target at `rect` (null: not on this page)
 * in a `vw` x `vh` viewport. Always wholly on screen.
 *
 * This was `rect ? { top: min(below, vh-220), left: min(max(12, left),
 * vw-380) } : { top: 100, left: 100 }` under a fixed 360px width, which
 * assumed a desktop. A phone renders no sidebar, so most steps had no target
 * and the caption spanned x=100..460 on a 375px screen, with Next entirely
 * off it inside an overlay that cannot scroll: a first sign-in on a phone
 * could only Skip. With a target (the ? FAB), vw-380 went negative below
 * 392px and clipped it on the left instead.
 */
export function captionPosition(
  rect: Rect | null,
  vw: number,
  vh: number,
): { top: number; left: number; width: number; maxHeight: number } {
  const width = Math.min(CAPTION_WIDTH, vw - 2 * EDGE);
  const clampLeft = (x: number) => Math.min(Math.max(EDGE, x), vw - width - EDGE);
  // Nothing to point at: a sheet centred low on the screen, clear of the tabs.
  const sheet = () => {
    const top = Math.max(EDGE, vh - CAPTION_HEIGHT - TAB_BAR);
    return { top, left: clampLeft((vw - width) / 2), width, maxHeight: vh - top - EDGE };
  };
  if (!rect) return sheet();
  const below = rect.top + rect.height + EDGE;
  if (below + CAPTION_HEIGHT <= vh - EDGE) {
    return { top: below, left: clampLeft(rect.left), width, maxHeight: vh - below - EDGE };
  }
  // No room below (the ? FAB, a bottom tab): above the target, not over it.
  const top = rect.top - CAPTION_HEIGHT - EDGE;
  if (top >= EDGE) return { top, left: clampLeft(rect.left), width, maxHeight: CAPTION_HEIGHT };
  return sheet();
}

export function FTUXTour({ role, ftuxSeenAt }: FTUXTourProps) {
  // Memoised on `role`. The `?? []` fallback allocated a fresh array on every
  // render, so the effect below saw a new dependency each time and re-ran
  // continuously for any role without a configured tour.
  const steps = useMemo(() => FTUX_TOURS[role] ?? [], [role]);
  const [dismissed, setDismissed] = useState<boolean>(Boolean(ftuxSeenAt));
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  // Measured with the rect, never read from `window` while rendering: this
  // renders on the server too (the layout mounts it for every first sign-in),
  // where there is no window, and the first client render must match that.
  const [viewport, setViewport] = useState<{ width: number; height: number } | null>(null);
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
      setViewport({ width: window.innerWidth, height: window.innerHeight });
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

  // Caption placement: see captionPosition. overflowY because a long Hindi or
  // Bhoti body can outgrow maxHeight; the buttons stay reachable by scrolling
  // the caption, where they were once unreachable altogether. Hidden until
  // the first measurement (the server render and hydration), rather than
  // drawn somewhere a phone cannot show.
  const captionPos = viewport
    ? { ...captionPosition(rect, viewport.width, viewport.height), overflowY: "auto" as const }
    : { visibility: "hidden" as const };

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

      {/* Caption card — up to 360px wide; Next / Back / Skip controls */}
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
