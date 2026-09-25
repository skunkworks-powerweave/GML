"use client";

// The SCORM 1.2 player: window.API for the SCO, and the sandboxed iframe it
// runs in.
//
// ORDER MATTERS. A SCO looks for window.parent.API the moment it loads, and
// one that finds nothing runs untracked (or alerts "LMS not found" and stops).
// So the iframe is rendered -- by the server too -- with NO src: there is
// nothing to load until the frame is attached, and attaching it (the ref
// callback below, which React runs in the commit that inserts the element)
// installs the API first and only then points the frame at the launch file.
//
// COMMITS must survive the page closing, so they are sent with `keepalive`,
// and the session is flushed when the tab is hidden or the page goes away: a
// learner on a phone switches apps far more often than she presses a SCO's
// exit button. Every commit carries the whole state (lib/scorm/runtime.ts), so
// one that fails on a bad connection is repaired by the next; the learner is
// told while her progress is unsaved, and it is re-sent when the browser
// reports it is back online.

import { useCallback, useState } from "react";
import { Scorm12Runtime, type RuntimeInit } from "@/lib/scorm/runtime";
import { SCORM_SANDBOX } from "@/lib/scorm/sandbox";
import type { CommitPayload } from "@/lib/scorm/cmi";

type Commit = CommitPayload & { final: boolean };

export function ScormPlayer({
  packageId,
  src,
  title,
  backHref,
  init,
}: {
  packageId: string;
  /** The launch file on the content route: same origin, so the SCO can reach window.parent.API. */
  src: string;
  title: string;
  backHref: string;
  init: RuntimeInit;
}) {
  const [unsaved, setUnsaved] = useState(false);
  const [finished, setFinished] = useState(false);

  const attach = useCallback(
    (frame: HTMLIFrameElement | null) => {
      if (!frame) return;

      // The newest commit that failed, and the newest that succeeded: an
      // older request answering late must not clear (or set) the warning.
      let seq = 0;
      let lastOk = 0;
      let failed: { seq: number; payload: Commit } | null = null;

      const send = (payload: Commit): boolean => {
        const mine = ++seq;
        const lost = () => {
          if (mine > lastOk && (!failed || mine > failed.seq)) {
            failed = { seq: mine, payload };
            setUnsaved(true);
          }
        };
        try {
          fetch(`/api/scorm/attempts/${packageId}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
            credentials: "same-origin",
            keepalive: true,
          }).then((res) => {
            if (!res.ok) return lost();
            lastOk = Math.max(lastOk, mine);
            if (failed && failed.seq <= mine) {
              failed = null;
              setUnsaved(false);
            }
          }, lost);
        } catch {
          return false;
        }
        if (payload.final) setFinished(true);
        return true;
      };

      const runtime = new Scorm12Runtime(init, send);
      const win = window as unknown as { API?: unknown };
      win.API = runtime.api;
      // Only now: the SCO this starts will find the API.
      frame.src = src;

      const flush = () => {
        runtime.flush();
      };
      const onVisibility = () => {
        if (document.visibilityState === "hidden") runtime.flush();
      };
      const onOnline = () => {
        if (!failed) return;
        // Still running: the current state supersedes whatever was lost.
        if (runtime.running) runtime.flush();
        else send(failed.payload);
      };
      window.addEventListener("pagehide", flush);
      window.addEventListener("online", onOnline);
      document.addEventListener("visibilitychange", onVisibility);
      return () => {
        window.removeEventListener("pagehide", flush);
        window.removeEventListener("online", onOnline);
        document.removeEventListener("visibilitychange", onVisibility);
        runtime.flush();
        if (win.API === runtime.api) delete win.API;
      };
    },
    [packageId, src, init],
  );

  return (
    <div style={{ display: "grid", gap: 10 }}>
      {unsaved ? (
        <div role="status" className="card" style={{ padding: "8px 12px", fontSize: 13, borderColor: "var(--rust)" }}>
          Your progress is not saved yet. It will be sent again when you are back online, so keep this page open until
          then.
        </div>
      ) : null}
      {finished ? (
        <div role="status" className="card" style={{ padding: "8px 12px", fontSize: 13 }}>
          You have finished this session. Your progress is recorded.{" "}
          {/* A full navigation, not a client transition: the module is done
              and the next page should start clean. */}
          <a href={backHref}>Back to the subject</a>
        </div>
      ) : null}
      <iframe
        ref={attach}
        title={title}
        sandbox={SCORM_SANDBOX}
        allow="fullscreen"
        style={{ width: "100%", height: "calc(100dvh - 190px)", minHeight: 420, border: "1px solid var(--line)", borderRadius: 8, background: "#fff" }}
      />
      <noscript>This module needs JavaScript to run and to record your progress.</noscript>
    </div>
  );
}
