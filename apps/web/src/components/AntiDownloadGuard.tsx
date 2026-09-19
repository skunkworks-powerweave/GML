"use client";

// Spec 088 — Anti-download deterrence chrome. Mounted once at the authenticated
// route layout so every protected page benefits without per-route wiring.
//
// This is DETERRENCE, not prevention. A determined adversary with browser
// DevTools, OS-level screen capture (Win+Shift+S, macOS Cmd+Shift+4, Android
// Power+Volume-down), or proxy interception (Charles, mitmproxy) CAN still
// capture content on a general-purpose computing platform. We bias toward
// raising the cost of casual exfiltration:
//   - block Ctrl/Cmd+S (browser save page)
//   - block Ctrl/Cmd+P (browser print dialog)
//   - intercept PrintScreen + flash a "screenshots are logged" toast
//   - one-shot DevTools-open heuristic (weak signal, audited as such)
//
// SM-4 (watermark) and SM-9 (audit trail) remain the load-bearing defences.
// This component layers friction on top. The user is informed of the
// deterrence-not-prevention posture at sign-in and in README-IT.md.

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

type AttemptKind = "save" | "print" | "printscreen";

/** Best-effort, fire-and-forget client audit. Failures are silent by design. */
function emitAudit(action: string, metadata: Record<string, unknown> = {}): void {
  if (typeof navigator === "undefined" || typeof navigator.sendBeacon !== "function") return;
  try {
    const blob = new Blob(
      [
        JSON.stringify({
          action,
          // The page is what makes the row actionable: "someone tried to
          // print" is far less useful than "someone tried to print THIS
          // learner record". The server caps it and rejects anything that is
          // not a same-site absolute path.
          metadata: { ...metadata, path: window.location.pathname },
        }),
      ],
      { type: "application/json" },
    );
    navigator.sendBeacon("/api/audit/client", blob);
  } catch {
    // Silent — the deterrent CSS/UX still functions without server-side audit.
  }
}

export default function AntiDownloadGuard(): React.ReactElement | null {
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;

    function onKeyDown(event: KeyboardEvent): void {
      const mod = event.ctrlKey || event.metaKey;
      const k = event.key;

      let kind: AttemptKind | null = null;
      if (mod && (k === "s" || k === "S")) kind = "save";
      else if (mod && (k === "p" || k === "P")) kind = "print";
      else if (k === "PrintScreen") kind = "printscreen";

      if (!kind) return;

      event.preventDefault();
      event.stopPropagation();

      // Literal action strings (not template-interpolated) so an audit-log
      // operator searching `grep anti_download.attempt.save` lands here.
      switch (kind) {
        case "save":
          emitAudit("anti_download.attempt.save", { key: k });
          break;
        case "print":
          emitAudit("anti_download.attempt.print", { key: k });
          break;
        case "printscreen":
          emitAudit("anti_download.attempt.printscreen", { key: k });
          setToast("Screenshots are logged.");
          window.setTimeout(() => setToast(null), 2000);
          break;
      }
    }

    window.addEventListener("keydown", onKeyDown, { capture: true });

    // DevTools-open heuristic — PC-friendly, weak signal, throttled to one
    // audit per session via sessionStorage. False-positives on browsers with
    // permanent toolbars; operators treat the audit row as a hint, not proof.
    //
    // Spec 156 (Run 14 audit-closure MEDIUM): a window maximize / restore
    // briefly puts outerHeight - innerHeight > 200 px while the OS animates
    // the resize. Pre-fix this fired an audit row every time, polluting the
    // log with false positives. The 1-second debounce below requires the
    // size delta to PERSIST for >1s before we emit; transient resize
    // animations clear the timer without ever firing.
    const DEVTOOLS_KEY = "antiDownloadGuard.devtoolsLogged";
    let pendingDevtoolsTimer: ReturnType<typeof setTimeout> | null = null;
    const interval = window.setInterval(() => {
      const dh = window.outerHeight - window.innerHeight;
      const dw = window.outerWidth - window.innerWidth;
      const triggered = dh > 200 || dw > 200;
      if (triggered) {
        // Only ARM the timer if it isn't already armed. A second poll while
        // the timer is pending must not reset it — that would let a slow
        // resize animation keep cancelling the debounce indefinitely.
        if (pendingDevtoolsTimer == null) {
          pendingDevtoolsTimer = setTimeout(() => {
            pendingDevtoolsTimer = null;
            // Re-check the size delta INSIDE the timer — by the time the
            // 1s has elapsed the user may have closed devtools / finished
            // the resize. Without this re-check we'd fire an audit for a
            // delta that has already gone away.
            const dh2 = window.outerHeight - window.innerHeight;
            const dw2 = window.outerWidth - window.innerWidth;
            if (!(dh2 > 200 || dw2 > 200)) return;
            let already = false;
            try {
              already = window.sessionStorage.getItem(DEVTOOLS_KEY) === "1";
            } catch {
              // sessionStorage can throw in some privacy modes — proceed without throttle.
            }
            if (!already) {
              try {
                window.sessionStorage.setItem(DEVTOOLS_KEY, "1");
              } catch {
                // Storage blocked — log once anyway, but expect repeats.
              }
              emitAudit("anti_download.devtools.detected", {
                outerHeight: window.outerHeight,
                innerHeight: window.innerHeight,
                outerWidth: window.outerWidth,
                innerWidth: window.innerWidth,
                weak_signal: true,
              });
            }
          }, 1000);
        }
      } else if (pendingDevtoolsTimer != null) {
        // The delta cleared before the 1s debounce fired — this was a
        // transient resize animation, not a devtools open. Cancel.
        clearTimeout(pendingDevtoolsTimer);
        pendingDevtoolsTimer = null;
      }
    }, 1500);

    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true } as EventListenerOptions);
      window.clearInterval(interval);
      if (pendingDevtoolsTimer != null) {
        clearTimeout(pendingDevtoolsTimer);
        pendingDevtoolsTimer = null;
      }
    };
  }, []);

  if (!toast) return null;
  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      role="status"
      aria-live="polite"
      style={{
        position: "fixed",
        bottom: 24,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 9999,
        padding: "10px 16px",
        background: "var(--paper)",
        color: "var(--rust)",
        border: "1px solid var(--line)",
        borderRadius: "var(--r-3)",
        boxShadow: "var(--shadow-3)",
        font: "600 13px var(--sans)",
        letterSpacing: "0.01em",
        pointerEvents: "none",
      }}
    >
      {toast}
    </div>,
    document.body,
  );
}
