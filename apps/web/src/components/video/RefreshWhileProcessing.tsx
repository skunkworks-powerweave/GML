"use client";

// Keeps a page's video statuses current while one of them is still processing.
//
// The pages that list or show a video are server-rendered: they printed the
// status a video had when the page loaded and nothing more. A video that was
// "queued" when the page opened read "queued" until someone reloaded, although
// the worker finished it in under a minute (live QA, 9 Oct 2026). While
// `active` (some video on the page is received, queued or transcoding:
// lib/video/labels.ts isVideoProcessing), this re-renders the page's server
// components every REFRESH_EVERY_MS. router.refresh() keeps client state:
// nothing the user typed or chose on the page is lost.
//
// Gentle on a metered connection: only while the tab is visible, and never for
// longer than STOP_AFTER_MS, so a video stuck in the queue does not refresh the
// page forever. Renders nothing.

import { useEffect } from "react";
import { useRouter } from "next/navigation";

const REFRESH_EVERY_MS = 15_000;
const STOP_AFTER_MS = 20 * 60_000;

export function RefreshWhileProcessing({ active }: { active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const started = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - started > STOP_AFTER_MS) {
        clearInterval(timer);
        return;
      }
      if (document.visibilityState === "visible") router.refresh();
    }, REFRESH_EVERY_MS);
    return () => clearInterval(timer);
  }, [active, router]);
  return null;
}
