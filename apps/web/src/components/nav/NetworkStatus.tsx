"use client";

// The connectivity dot in the sidebar footer.
//
// ── WHY THIS IS NOT JUST A GREEN DOT ─────────────────────────────────────────
//
// It used to be a hardcoded green circle next to the word "Online", rendered on
// the server, commented "cosmetic". It said Online while the laptop was in
// flight mode; it said Online while the uplink was dead. A status indicator
// that cannot report the bad state is worse than no indicator -- it actively
// tells you the problem is somewhere else.
//
// That matters more here than it would elsewhere. This is deployed to schools
// across Ladakh on connections that drop routinely, and the failure it explains
// is a real one: you fill in an observation form, press Save, and nothing
// happens. "Offline" turns that from a broken application into a known
// condition you can wait out.
//
// ── TWO SIGNALS, BECAUSE ONE IS NOT ENOUGH ───────────────────────────────────
//
// `navigator.onLine` is cheap, instant, and only knows whether the machine has
// A network interface up. A school wifi router with a dead uplink -- the single
// most common failure on this deployment -- reports online, because the laptop
// genuinely is connected to something. So it is necessary and not sufficient.
//
// The probe is what makes it truthful: a real request to our own /api/ping,
// which is the cheapest route in the app (no database, no auth). If the machine
// claims to be online and the server cannot be reached, we are offline as far
// as the user is concerned, and that is what we say.
//
// Cost control, because this runs on every authenticated page for everyone:
//   - the probe only runs while the tab is VISIBLE (no background polling),
//   - 60s apart when things are fine,
//   - 15s while offline, because that is when the user is waiting for it to
//     come back and a stale "Offline" is the annoying case,
//   - `cache: "no-store"` so a cached 200 never masks a dead link.

import { useEffect, useRef, useState } from "react";

type Status = "online" | "offline" | "checking";

/** Healthy interval, and the faster one used while we believe we are offline. */
const POLL_OK_MS = 60_000;
const POLL_DOWN_MS = 15_000;
/** Longer than this and the connection is not usable for anything anyway. */
const PROBE_TIMEOUT_MS = 8_000;

export function NetworkStatus({
  labelOnline,
  labelOffline,
  labelChecking,
  hintOnline,
  hintOffline,
  hintChecking,
}: {
  labelOnline: string;
  labelOffline: string;
  labelChecking: string;
  /** Tooltip text per state. Translated by the caller like the labels: these
   *  were English literals for every locale, including Hindi, whose bundle
   *  was otherwise complete. */
  hintOnline: string;
  hintOffline: string;
  hintChecking: string;
}) {
  // Server-rendered as "checking" rather than "online": we genuinely do not
  // know yet, and starting at a confident green is how the old one lied. It
  // resolves on mount, so the indeterminate state is not visible in practice.
  const [status, setStatus] = useState<Status>("checking");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelled = useRef(false);

  useEffect(() => {
    cancelled.current = false;

    async function probe(): Promise<boolean> {
      // No interface up -- no point spending a request to confirm it.
      if (typeof navigator !== "undefined" && navigator.onLine === false) return false;
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);
      try {
        const res = await fetch("/api/ping", { cache: "no-store", signal: ac.signal });
        return res.ok;
      } catch {
        // Abort, DNS failure, refused connection, captive portal -- all of it
        // means the same thing to someone trying to save a form.
        return false;
      } finally {
        clearTimeout(t);
      }
    }

    async function tick() {
      const ok = await probe();
      if (cancelled.current) return;
      setStatus(ok ? "online" : "offline");
      schedule(ok ? POLL_OK_MS : POLL_DOWN_MS);
    }

    function schedule(ms: number) {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        // Do not poll a tab nobody is looking at; the visibilitychange handler
        // re-checks the moment it comes back.
        if (document.visibilityState === "visible") void tick();
        else schedule(ms);
      }, ms);
    }

    // The browser's own events are the fast path: a cable pulled out or flight
    // mode switched on is reflected immediately rather than up to a minute
    // later. We still probe on the way back up, because `online` only means an
    // interface appeared, not that anything is reachable through it.
    const onOffline = () => {
      if (!cancelled.current) setStatus("offline");
    };
    const onOnline = () => void tick();
    const onVisible = () => {
      if (document.visibilityState === "visible") void tick();
    };

    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);
    void tick();

    return () => {
      cancelled.current = true;
      if (timer.current) clearTimeout(timer.current);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const label =
    status === "online" ? labelOnline : status === "offline" ? labelOffline : labelChecking;
  const colour =
    status === "online" ? "var(--lichen)" : status === "offline" ? "var(--rust)" : "var(--ink-4)";

  return (
    <div
      data-testid="network-status"
      data-status={status}
      // Announced rather than silently recolouring: losing the connection is
      // the whole point of the control, and colour alone excludes anyone who
      // cannot distinguish these two.
      role="status"
      aria-live="polite"
      title={status === "offline" ? hintOffline : status === "online" ? hintOnline : hintChecking}
      style={{
        marginTop: "auto",
        padding: "8px 8px 4px",
        fontSize: 11,
        color: status === "offline" ? "var(--rust)" : "var(--ink-3)",
        borderTop: "1px solid var(--line)",
        display: "flex",
        alignItems: "center",
        gap: 6,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 6,
          height: 6,
          borderRadius: 999,
          background: colour,
          display: "inline-block",
          flex: "0 0 auto",
        }}
      />
      {label}
    </div>
  );
}
